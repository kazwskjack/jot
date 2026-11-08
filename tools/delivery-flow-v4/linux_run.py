#!/usr/bin/env python3
"""Run one pinned source test on Linux and retain a job-scoped receipt."""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from result_validate import _canonical_hash, _is_lock_path, load_schema, validate_job_result, validate_test_event


MAX_ARCHIVE_BYTES = 1_000_000_000
MAX_ARCHIVE_FILES = 10_000


def is_linux_runtime(system=None):
    return (system or sys.platform) == "linux"


def parse_node_test_summary(text):
    names = {"tests": "tests", "pass": "passed", "fail": "failed", "cancelled": "cancelled", "skipped": "skipped"}
    found = {}
    for line in text.splitlines():
        match = re.match(r"^\s*(?:ℹ\s*|#\s*)?(tests|pass|fail|cancelled|skipped)\s+(\d+)\s*$", line)
        if match:
            key, value = names[match.group(1)], int(match.group(2))
            if key in found and found[key] != value:
                return None
            found[key] = value
    if set(found) != set(names.values()):
        return None
    if sum(found[key] for key in ("passed", "failed", "cancelled", "skipped")) != found["tests"]:
        return None
    return found


def classify_result(exit_code, summary, timed_out=False, cancelled=False):
    if timed_out or cancelled:
        return "CANCELLED", "NOT_APPLICABLE"
    if exit_code is None:
        return "BLOCKED", "INFRA_BLOCKED"
    if exit_code != 0:
        return "FAIL", "SOFTWARE_DEVELOPMENT_INCOMPLETE"
    if summary is None or not summary["tests"]:
        return "BLOCKED", "INFRA_BLOCKED"
    if summary["cancelled"]:
        return "CANCELLED", "NOT_APPLICABLE"
    if summary["failed"] or summary["skipped"] or summary["passed"] != summary["tests"]:
        return "BLOCKED", "INFRA_BLOCKED"
    return "PASS", "NONE"


def _sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _valid_relpath(value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("source paths must be relative POSIX paths")
    path = PurePosixPath(value)
    if path.is_absolute() or ":" in path.parts[0] or any(part in ("", ".", "..") for part in value.split("/")):
        raise ValueError(f"unsafe source path: {value!r}")
    return path


def _manifest_files(manifest):
    if not isinstance(manifest, dict):
        raise ValueError("source manifest must be a JSON object")
    entries = {}
    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise ValueError("source manifest must contain a nonempty files list")
    for entry in files:
        if not isinstance(entry, dict):
            raise ValueError("each source manifest file entry must be an object")
        path = entry.get("path")
        _valid_relpath(path)
        digest = entry.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError(f"invalid SHA-256 for {path!r}")
        if path in entries:
            raise ValueError(f"duplicate source manifest path: {path}")
        entries[path] = digest
    if not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("commit", ""))):
        raise ValueError("source manifest commit must be a 40-character lowercase Git hash")
    if not re.fullmatch(r"[0-9a-f]{40}", str(manifest.get("tree", ""))):
        raise ValueError("source manifest tree must be a 40-character lowercase Git hash")
    if not re.fullmatch(r"[0-9a-f]{64}", str(manifest.get("archive_sha256", ""))):
        raise ValueError("source manifest archive_sha256 must be a SHA-256")
    return entries


def verify_and_extract_source(
    archive_path, manifest_path, workdir, test_pins,
    expected_source_manifest_sha256=None, expected_commit=None, expected_tree=None, lock_pins=None,
):
    archive_path, manifest_path, workdir = map(Path, (archive_path, manifest_path, workdir))
    if expected_source_manifest_sha256 and _sha256(manifest_path) != expected_source_manifest_sha256:
        raise ValueError("source archive manifest SHA-256 does not match its pin")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = _manifest_files(manifest)
    if expected_commit and manifest["commit"] != expected_commit:
        raise ValueError("source commit does not match owner packet")
    if expected_tree and manifest["tree"] != expected_tree:
        raise ValueError("source tree does not match owner packet")
    if _sha256(archive_path) != manifest["archive_sha256"]:
        raise ValueError("source archive SHA-256 does not match source manifest")
    if not test_pins or any(entries.get(path) != digest for path, digest in test_pins.items()):
        raise ValueError("test pins must match source manifest file pins")
    if manifest.get("test_entry") and manifest["test_entry"] not in test_pins:
        raise ValueError("manifest test_entry must be included in --test-pin")
    locks = {path: digest for path, digest in entries.items() if _is_lock_path(path)}
    if lock_pins is not None and lock_pins != locks:
        raise ValueError("lock pins do not exactly match source manifest lock files")

    workdir.parent.mkdir(parents=True, exist_ok=True)
    workdir.mkdir(parents=False, exist_ok=False)
    try:
        with zipfile.ZipFile(archive_path) as source:
            files, directories = set(), set()
            total_size = 0
            for item in source.infolist():
                name = item.filename[:-1] if item.is_dir() else item.filename
                rel = _valid_relpath(name)
                mode = item.external_attr >> 16
                file_type = stat.S_IFMT(mode)
                if stat.S_ISLNK(mode) or file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise ValueError(f"archive contains a non-regular file: {item.filename!r}")
                if item.is_dir():
                    directories.add(rel.as_posix())
                else:
                    if rel.as_posix() in files:
                        raise ValueError(f"duplicate archive path: {item.filename!r}")
                    files.add(rel.as_posix())
                    total_size += item.file_size
            if files != set(entries):
                raise ValueError("archive file list does not exactly match source manifest")
            if directories - {parent.as_posix() for name in entries for parent in PurePosixPath(name).parents if parent.as_posix() != "."}:
                raise ValueError("archive contains an unmanifested directory")
            if len(files) > MAX_ARCHIVE_FILES or total_size > MAX_ARCHIVE_BYTES:
                raise ValueError("source archive exceeds safe extraction limits")
            for name in sorted(files):
                output = workdir.joinpath(*PurePosixPath(name).parts)
                output.parent.mkdir(parents=True, exist_ok=True)
                with source.open(name) as source_file, output.open("xb") as target:
                    shutil.copyfileobj(source_file, target)
                if _sha256(output) != entries[name]:
                    raise ValueError(f"extracted file hash mismatch: {name}")
    except Exception:
        shutil.rmtree(workdir, ignore_errors=True)
        raise
    return {
        "commit": manifest["commit"],
        "tree": manifest["tree"],
        "archive_sha256": manifest["archive_sha256"],
        "source_manifest_sha256": _sha256(manifest_path),
        "lock_sha256": locks,
        "manifest": manifest,
        "files": entries,
    }


def _utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _reject_symlinks(path):
    absolute = Path(os.path.abspath(path))
    current = Path(absolute.anchor)
    for part in absolute.parts[1:]:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"symlink path component is not allowed: {current}")
    return absolute


def _fresh_child(root, child):
    root = _reject_symlinks(Path(os.path.abspath(root)))
    if not root.is_dir():
        raise ValueError("authorized-root must be an existing directory")
    child = _reject_symlinks(child)
    if not child.is_relative_to(root) or child == root or child.exists():
        raise ValueError("workdir/outdir must be fresh, disjoint descendants of authorized-root")
    return root, child


def ensure_disjoint_inputs(source_path, manifest_path, *destinations):
    inputs = [_reject_symlinks(path).resolve(strict=True) for path in (source_path, manifest_path)]
    if not all(path.is_file() for path in inputs):
        raise ValueError("source archive and manifest must be regular files")
    package_root = Path(os.path.commonpath([str(path.parent) for path in inputs]))
    for destination in destinations:
        target = _reject_symlinks(destination)
        if target == package_root or target.is_relative_to(package_root) or package_root.is_relative_to(target):
            raise ValueError("workdir/outdir must be disjoint from the immutable source package")
    return None


def verify_execution_descriptor(
    descriptor_path, expected_sha256, source_path, manifest_path,
    packet_manifest_path, packet_manifest_sha256, candidate_commit, candidate_tree,
    test_pins, lock_pins, command, execution_root_kind,
):
    if not isinstance(expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("approved execution descriptor SHA-256 must be 64 lowercase hexadecimal characters")
    descriptor_path = _reject_symlinks(Path(descriptor_path)).resolve(strict=True)
    source_path = _reject_symlinks(Path(source_path)).resolve(strict=True)
    manifest_path = _reject_symlinks(Path(manifest_path)).resolve(strict=True)
    if not descriptor_path.is_file() or descriptor_path in (source_path, manifest_path):
        raise ValueError("approved execution descriptor must be an independent regular file")
    descriptor_bytes = descriptor_path.read_bytes()
    if hashlib.sha256(descriptor_bytes).hexdigest() != expected_sha256:
        raise ValueError("approved execution descriptor SHA-256 does not match its independent pin")
    try:
        descriptor = json.loads(descriptor_bytes.decode("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"approved execution descriptor is unreadable: {exc}") from exc
    fields = {
        "schema_version", "source_archive_sha256", "source_manifest_sha256",
        "packet_context", "git_delta_manifest", "candidate_commit", "candidate_tree",
        "tests", "locks", "argv", "execution_environment",
    }
    if not isinstance(descriptor, dict) or set(descriptor) != fields or descriptor.get("schema_version") != 1:
        raise ValueError("approved execution descriptor has an unsupported shape")
    source_manifest_sha256 = _sha256(manifest_path)
    source_archive_sha256 = _sha256(source_path)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    entries = _manifest_files(manifest)
    locks = {path: digest for path, digest in entries.items() if _is_lock_path(path)}
    if (descriptor["source_archive_sha256"] != source_archive_sha256
            or manifest.get("archive_sha256") != source_archive_sha256):
        raise ValueError("approved execution descriptor source archive pin does not match")
    if descriptor["source_manifest_sha256"] != source_manifest_sha256:
        raise ValueError("approved execution descriptor full source manifest pin does not match")
    if manifest["commit"] != candidate_commit or descriptor["candidate_commit"] != candidate_commit:
        raise ValueError("approved execution descriptor candidate commit does not match")
    if manifest["tree"] != candidate_tree or descriptor["candidate_tree"] != candidate_tree:
        raise ValueError("approved execution descriptor candidate tree does not match")
    if descriptor["tests"] != test_pins or test_pins != {path: entries.get(path) for path in test_pins}:
        raise ValueError("approved execution descriptor test pins do not match")
    if descriptor["locks"] != lock_pins or lock_pins != locks:
        raise ValueError("approved execution descriptor lock pins do not match")
    if descriptor["argv"] != command:
        raise ValueError("approved execution descriptor argv does not match")
    if descriptor["packet_context"] != {
        "manifest_path": packet_manifest_path,
        "manifest_sha256": packet_manifest_sha256,
    }:
        raise ValueError("approved execution descriptor packet manifest context does not match")
    delta = descriptor["git_delta_manifest"]
    if delta == {"status": "not_applicable"}:
        pass
    elif (isinstance(delta, dict) and set(delta) == {"status", "path", "sha256"}
            and delta.get("status") == "pinned"
            and delta["path"] == packet_manifest_path
            and delta["sha256"] == packet_manifest_sha256):
        pass
    else:
        raise ValueError("approved execution descriptor Git-delta identity is invalid")
    environment = descriptor["execution_environment"]
    if (not isinstance(environment, dict) or set(environment) != {"execution_root_kind", "profile"}
            or environment.get("execution_root_kind") != "remote"
            or execution_root_kind != "remote"
            or not isinstance(environment.get("profile"), str)
            or not environment["profile"].strip()):
        raise ValueError("approved execution descriptor must name the fixed remote Linux environment")
    return {"path": descriptor_path, "sha256": expected_sha256, "bytes": descriptor_bytes, "document": descriptor}


def _version(command):
    try:
        completed = subprocess.run(command, check=False, capture_output=True, text=True, timeout=5)
        return (completed.stdout or completed.stderr).strip().splitlines()[0]
    except (OSError, subprocess.TimeoutExpired, IndexError):
        return "unavailable"


def _distro_name():
    try:
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return "unknown Linux"


def _node_meets(manifest, node):
    requirement = str(manifest.get("node", ""))
    minimum = re.search(r">=\s*(\d+)", requirement)
    version = re.match(r"v?(\d+)(?:\.|$)", node)
    return not minimum or (version is not None and int(version.group(1)) >= int(minimum.group(1)))


def _safe_environment(outdir):
    allowed = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL") if key in os.environ}
    temp = outdir / "runner-tmp"
    temp.mkdir()
    allowed.update({"TMPDIR": str(temp), "TMP": str(temp), "TEMP": str(temp), "TZ": "UTC"})
    return allowed, temp


def _group_exists(process_group):
    try:
        os.killpg(process_group, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _wait_group_exit(process_group, timeout):
    deadline = time.monotonic() + timeout
    while _group_exists(process_group):
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)
    return True


def _wait_process_exit(process, timeout):
    try:
        process.wait(timeout=timeout)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def _terminate_group(process, grace=3):
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return _wait_process_exit(process, grace)
    except OSError:
        pass
    # shortcut: descendants that call setsid() escape this process group; add OS-level isolation only when that threat is in scope.
    if not _wait_group_exit(process.pid, grace):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            pass
        cleaned = _wait_group_exit(process.pid, grace)
    else:
        cleaned = True
    return cleaned and _wait_process_exit(process, grace)


def _parse_test_pins(values):
    result = {}
    for value in values:
        path, separator, digest = value.partition("=")
        _valid_relpath(path)
        if not separator or not re.fullmatch(r"[0-9a-f]{64}", digest) or path in result:
            raise ValueError(f"invalid or duplicate --test-pin: {value!r}")
        result[path] = digest
    return result


def validate_command_tests(command, test_pins):
    if len(command) < 3 or Path(command[0]).name != "node" or command[1] != "--test":
        raise ValueError("only the controlled `node --test <pinned test paths...>` command is allowed")
    tests = command[2:]
    if any(test.startswith("-") for test in tests) or len(tests) != len(set(tests)) or set(tests) != set(test_pins):
        raise ValueError("node --test argv paths must exactly match the pinned test-file set")
    return None


def _resolve_node_executable(command):
    resolved = shutil.which(command)
    if not resolved:
        return None
    path = Path(resolved).resolve(strict=True)
    if not path.is_file() or not os.access(path, os.X_OK):
        return None
    return path


def _parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True, help="full-source-archive manifest; distinct from the owner packet manifest")
    parser.add_argument("--manifest-path", required=True, help="original manifest_path value from the owner packet")
    parser.add_argument("--manifest-sha256", required=True, help="owner packet manifest SHA-256, retained as context")
    parser.add_argument("--candidate-commit", required=True)
    parser.add_argument("--candidate-tree", required=True)
    parser.add_argument("--workdir", type=Path, required=True)
    parser.add_argument("--outdir", type=Path, required=True)
    parser.add_argument("--authorized-root", type=Path, required=True)
    parser.add_argument("--execution-root-kind", choices=("local", "remote"), required=True)
    parser.add_argument("--job", dest="job_id", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--owner", required=True)
    parser.add_argument("--packet-id", required=True)
    parser.add_argument("--source-class", choices=("inherited_wip", "new_development"), required=True)
    parser.add_argument("--scope", required=True)
    parser.add_argument("--layer", choices=(1, 2, 3), type=int, default=1)
    parser.add_argument("--test-pin", action="append", default=[])
    parser.add_argument("--lock-pin", action="append", default=[])
    parser.add_argument("--dependency", action="append", default=[])
    parser.add_argument("--ac-id", action="append", default=[])
    parser.add_argument("--next-owner")
    parser.add_argument("--ready-at")
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--expected-node")
    parser.add_argument("--approved-execution", type=Path, required=True)
    parser.add_argument("--approved-execution-sha256", required=True)
    return parser


def run(args, command):
    if not is_linux_runtime():
        raise RuntimeError("linux_run.py only executes commands on Linux")
    if not command or args.timeout <= 0:
        raise ValueError("a nonempty argv command and positive timeout are required")
    for name in ("job_id", "repo", "owner", "packet_id", "scope", "manifest_path"):
        if not getattr(args, name).strip():
            raise ValueError(f"--{name.replace('_', '-')} must not be empty")
    if args.next_owner is not None and not args.next_owner.strip():
        raise ValueError("--next-owner must not be empty")
    if args.ready_at is not None:
        try:
            if not args.ready_at.endswith("Z"):
                raise ValueError("--ready-at must be UTC RFC3339 ending in Z")
            datetime.fromisoformat(args.ready_at[:-1] + "+00:00")
        except ValueError as exc:
            raise ValueError("--ready-at must be UTC RFC3339 ending in Z") from exc
    test_pins = _parse_test_pins(args.test_pin)
    lock_pins = _parse_test_pins(args.lock_pin)
    validate_command_tests(command, test_pins)
    if not re.fullmatch(r"[0-9a-f]{64}", args.manifest_sha256):
        raise ValueError("--manifest-sha256 must be 64 lowercase hexadecimal characters")
    if args.execution_root_kind != "remote":
        raise ValueError("candidate execution requires the explicitly approved remote Linux environment")
    for name in ("candidate_commit", "candidate_tree"):
        if not re.fullmatch(r"[0-9a-f]{40}", getattr(args, name)):
            raise ValueError(f"--{name.replace('_', '-')} must be a 40-character lowercase Git hash")
    root, workdir = _fresh_child(args.authorized_root, args.workdir)
    _, outdir = _fresh_child(root, args.outdir)
    if workdir.is_relative_to(outdir) or outdir.is_relative_to(workdir):
        raise ValueError("workdir and outdir must be disjoint")
    ensure_disjoint_inputs(args.source, args.manifest, workdir, outdir)
    approval = verify_execution_descriptor(
        args.approved_execution, args.approved_execution_sha256,
        args.source, args.manifest, args.manifest_path, args.manifest_sha256,
        args.candidate_commit, args.candidate_tree, test_pins, lock_pins,
        command, args.execution_root_kind,
    )
    outdir.parent.mkdir(parents=True, exist_ok=True)
    outdir.mkdir(exist_ok=False)
    (outdir / "approved-execution.json").write_bytes(approval["bytes"])
    manifest_bytes = args.manifest.read_bytes()
    manifest = json.loads(manifest_bytes)
    out_manifest = outdir / "source-manifest.json"
    out_manifest.write_bytes(manifest_bytes)
    source_copy = outdir / "source.zip"
    shutil.copyfile(args.source, source_copy)
    info = verify_and_extract_source(
        source_copy, out_manifest, workdir, test_pins,
        expected_source_manifest_sha256=approval["document"]["source_manifest_sha256"],
        expected_commit=args.candidate_commit,
        expected_tree=args.candidate_tree,
        lock_pins=lock_pins,
    )

    log_path = outdir / "run.log"
    environment, runner_temp = _safe_environment(outdir)
    node_executable = _resolve_node_executable(command[0])
    node_version = _version([str(node_executable), "--version"]) if node_executable else "unavailable"
    node_sha256 = _sha256(node_executable) if node_executable else None
    blocked_reason = "Node executable is unavailable" if node_executable is None else None
    requirement = str(info["manifest"].get("node", ""))
    if requirement and not _node_meets(info["manifest"], node_version):
        blocked_reason = f"Node {node_version} does not satisfy source requirement {requirement}"
    if args.expected_node and node_version != args.expected_node:
        blocked_reason = f"Node {node_version} does not match expected version {args.expected_node}"

    started_at = _utc_now()
    exit_code, timed_out, cancelled = None, False, False
    group_cleaned = None
    executed_command = [str(node_executable), *command[1:]] if node_executable else command
    with log_path.open("w", encoding="utf-8", newline="\n") as log:
        log.write("$ " + json.dumps(executed_command, ensure_ascii=False) + "\n")
        if blocked_reason:
            log.write(blocked_reason + "\n")
        else:
            process = None
            sigterm_requested = False

            def handle_sigterm(_signum, _frame):
                nonlocal sigterm_requested
                sigterm_requested = True

            previous_sigterm_handler = signal.getsignal(signal.SIGTERM)
            signal.signal(signal.SIGTERM, handle_sigterm)
            try:
                try:
                    if sigterm_requested:
                        cancelled = True
                    else:
                        process = subprocess.Popen(
                            executed_command, cwd=workdir, env=environment, shell=False,
                            stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
                        )
                        if sigterm_requested:
                            cancelled = True
                        else:
                            deadline = time.monotonic() + args.timeout
                            while not sigterm_requested:
                                remaining = deadline - time.monotonic()
                                if remaining <= 0:
                                    timed_out = True
                                    break
                                try:
                                    exit_code = process.wait(timeout=min(remaining, 0.1))
                                    break
                                except subprocess.TimeoutExpired:
                                    continue
                            if sigterm_requested:
                                cancelled = True
                except KeyboardInterrupt:
                    cancelled = True
                except OSError as exc:
                    log.write(f"unable to start command: {exc}\n")
            finally:
                try:
                    if process is not None:
                        group_cleaned = _terminate_group(process)
                        exit_code = process.returncode
                        if group_cleaned:
                            log.write("\nprocess group terminated and empty\n")
                        else:
                            log.write("\nprocess group cleanup could not be confirmed\n")
                finally:
                    signal.signal(signal.SIGTERM, previous_sigterm_handler)
            if sigterm_requested:
                cancelled = True
            if timed_out:
                log.write("runner timeout\n")
            elif cancelled:
                log.write("runner cancelled\n")
    if group_cleaned is False:
        raise RuntimeError("process group cleanup could not be confirmed; receipt was not frozen")
    finished_at = _utc_now()
    text = log_path.read_text(encoding="utf-8", errors="replace")
    summary = None if blocked_reason else parse_node_test_summary(text)
    status, failure = ("BLOCKED", "INFRA_BLOCKED") if blocked_reason else classify_result(exit_code, summary, timed_out, cancelled)
    cleanup_errors = []
    try:
        shutil.rmtree(runner_temp)
        temp_removed = True
    except OSError as exc:
        temp_removed = False
        cleanup_errors.append(str(exc))
    preserve_workdir = status != "PASS"
    if not preserve_workdir:
        try:
            shutil.rmtree(workdir)
        except OSError as exc:
            preserve_workdir = True
            cleanup_errors.append(str(exc))
    if cleanup_errors:
        status, failure = "BLOCKED", "INFRA_BLOCKED"
    source = {
        "commit": info["commit"], "tree": info["tree"],
        "package_sha256": info["archive_sha256"], "lock_sha256": info["lock_sha256"],
    }
    context = {
        "owner": args.owner, "packet_id": args.packet_id, "source_class": args.source_class,
        "candidate_commit": info["commit"], "candidate_tree": info["tree"],
        "manifest_path": args.manifest_path, "manifest_sha256": args.manifest_sha256,
        "dependencies": args.dependency, "ac_ids": args.ac_id,
        "next_owner": args.next_owner, "ready_at": args.ready_at,
    }
    result = {
        "schema_version": 1, "job_id": args.job_id, "repo": args.repo,
        "layer": args.layer, "scope": args.scope, "status": status,
        "failure_classification": failure, "source": source,
        "environment": {
            "os": "linux", "distro": _distro_name(), "kernel": platform.release(),
            "arch": {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine(), "other"),
            "node": node_version, "node_executable": str(node_executable) if node_executable else None,
            "node_sha256": node_sha256, "npm": _version(["npm", "--version"]),
            "python": platform.python_version(), "git": _version(["git", "--version"]),
            "execution_root": str(root), "execution_root_kind": args.execution_root_kind,
        },
        "event_context": context, "tests": test_pins, "tests_sha256": _canonical_hash(test_pins),
        "command": executed_command, "started_at_utc": started_at, "finished_at_utc": finished_at,
        "exit_code": exit_code,
        "counts": ({**summary, "unparsed": False} if summary else {
            "tests": None, "passed": None, "failed": None, "skipped": None,
            "cancelled": None, "unparsed": True,
        }),
        "artifacts": {
            "run_root": str(root), "source_archive": "source.zip",
            "source_manifest": "source-manifest.json",
            "source_manifest_sha256": info["source_manifest_sha256"],
            "execution_descriptor": "approved-execution.json",
            "execution_descriptor_sha256": approval["sha256"],
            "raw_log": "run.log",
            "raw_log_sha256": _sha256(log_path), "result_manifest": "result.json",
            "event_draft": "test-event.jsonl" if status in ("PASS", "FAIL") else None,
            "screenshots": [], "extra_logs": [],
        },
        "preflight": {
            "authorized_output_root_confirmed": True, "source_pins_verified": True,
            "lock_hashes_verified": True, "worktree_clean_before": None,
            "worktree_clean_after": None, "runtime_integrity_verified": None,
        },
        "cleanup": {
            "status": "FAILED" if cleanup_errors else ("PRESERVED_FOR_DIAGNOSTICS" if preserve_workdir else "COMPLETE"),
            "runner_temp_removed": temp_removed, "process_group_cleaned": group_cleaned,
            "retained_paths": ["workdir"] if preserve_workdir else [], "errors": cleanup_errors,
        },
        "windows_status": "DEFERRED_USER", "formal_acceptance_credit": "NONE",
        "notes": ["Job-scoped Linux test evidence only; no product acceptance credit."],
    }
    result_path = outdir / "result.json"
    result_path.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    event = None
    if status in ("PASS", "FAIL"):
        evidence = {
            "kind": "test_result", "path": "result.json", "sha256": _sha256(result_path),
            "job_id": args.job_id, "exit_code": exit_code,
            "result": "passed" if status == "PASS" else "failed",
        }
        event = {
            "schema_version": 1, "event_id": str(uuid.uuid4()), "event_type": "test",
            "occurred_at": finished_at, "owner": args.owner, "packet_id": args.packet_id,
            "source_class": args.source_class, "candidate_commit": info["commit"],
            "candidate_tree": info["tree"], "manifest_path": context["manifest_path"],
            "manifest_sha256": context["manifest_sha256"], "repo": args.repo,
            "tests_sha256": result["tests_sha256"], "dependencies": args.dependency,
            "ac_ids": args.ac_id, "evidence": evidence,
        }
        if args.next_owner is not None:
            event["next_owner"] = args.next_owner
        if args.ready_at is not None:
            event["ready_at"] = args.ready_at
        event_path = outdir / "test-event.jsonl"
        event_path.write_text(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    errors = validate_job_result(result, load_schema(Path(__file__).with_name("linux-job-result.schema.json")), outdir)
    if event is not None:
        errors.extend(validate_test_event(event, result, outdir, load_schema(Path(__file__).with_name("test-event.schema.json"))))
    if errors:
        raise RuntimeError("generated receipt failed validation: " + "; ".join(errors))
    print(result_path)
    return 0 if status == "PASS" else 1


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--help" in argv or "-h" in argv:
        _parser().parse_args(["--help"])
    if not is_linux_runtime():
        print("linux_run.py only executes commands on Linux", file=sys.stderr)
        return 2
    if "--" not in argv:
        _parser().error("put the command argv after --")
    split = argv.index("--")
    args = _parser().parse_args(argv[:split])
    command = argv[split + 1:]
    try:
        return run(args, command)
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
        print(f"linux job blocked: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
