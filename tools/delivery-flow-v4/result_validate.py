#!/usr/bin/env python3
"""Validate retained Linux job results and their owner-event draft."""

import argparse
import hashlib
import json
import re
import stat
import sys
import zipfile
from datetime import datetime
from pathlib import Path, PurePosixPath


def load_schema(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _kind(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return "unknown"


def _validate_schema(value, schema, path="$", errors=None):
    errors = [] if errors is None else errors
    allowed = schema.get("type")
    if allowed is not None:
        allowed = allowed if isinstance(allowed, list) else [allowed]
        if _kind(value) not in allowed and not (_kind(value) == "integer" and "number" in allowed):
            errors.append(f"{path}: expected type {allowed}, got {_kind(value)}")
            return errors
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: must equal {schema['const']!r}")
    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"{path}: value is not in the allowed set")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{path}: string is too short")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"{path}: does not match required pattern")
        if schema.get("format") == "date-time":
            try:
                if not value.endswith("Z"):
                    raise ValueError("timestamp must end in Z")
                datetime.fromisoformat(value[:-1] + "+00:00")
            except ValueError:
                errors.append(f"{path}: invalid UTC date-time")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value < schema.get("minimum", value):
        errors.append(f"{path}: number is below minimum")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{path}: array is too short")
        item_schema = schema.get("items")
        if item_schema:
            for index, item in enumerate(value):
                _validate_schema(item, item_schema, f"{path}[{index}]", errors)
    if isinstance(value, dict):
        if len(value) < schema.get("minProperties", 0):
            errors.append(f"{path}: object has too few properties")
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{path}: missing required property {key!r}")
        key_schema = schema.get("propertyNames")
        if key_schema:
            for key in value:
                _validate_schema(key, key_schema, f"{path} property name", errors)
        properties = schema.get("properties", {})
        for key, child in value.items():
            if key in properties:
                _validate_schema(child, properties[key], f"{path}.{key}", errors)
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}: unexpected property {key!r}")
            elif isinstance(schema.get("additionalProperties"), dict):
                _validate_schema(child, schema["additionalProperties"], f"{path}.{key}", errors)
    return errors


def _canonical_hash(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _retained_file(root, value):
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError("artifact path must be a nonempty relative POSIX path")
    relative = PurePosixPath(value)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError("artifact path must not escape the run root")
    base = Path(root).resolve(strict=True)
    path = base.joinpath(*relative.parts)
    if path.is_symlink() or not path.resolve(strict=True).is_relative_to(base) or not path.is_file():
        raise ValueError("artifact must be a regular file inside the run root")
    return path


def _is_lock_path(path):
    name = PurePosixPath(path).name.lower()
    return name in {
        "package-lock.json", "npm-shrinkwrap.json", "runtime-package-lock.json",
        "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "cargo.lock",
        "poetry.lock", "pipfile.lock", "pdm.lock", "uv.lock",
    } or name.endswith(("-lock.json", ".lock"))


def _source_file_map(source_manifest):
    if not isinstance(source_manifest, dict) or not isinstance(source_manifest.get("files"), list):
        raise ValueError("source manifest must contain a files array")
    entries = {}
    for item in source_manifest["files"]:
        if not isinstance(item, dict):
            raise ValueError("source manifest file entries must be objects")
        path, digest = item.get("path"), item.get("sha256")
        if (not isinstance(path, str) or not path or "\\" in path or PurePosixPath(path).is_absolute()
                or any(part in ("", ".", "..") for part in path.split("/"))):
            raise ValueError(f"unsafe source manifest path: {path!r}")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest) or path in entries:
            raise ValueError(f"invalid or duplicate source manifest pin: {path!r}")
        entries[path] = digest
    if not entries:
        raise ValueError("source manifest files array must not be empty")
    return entries


def _verify_source_archive(archive_path, entries):
    with zipfile.ZipFile(archive_path) as archive:
        members = {}
        for item in archive.infolist():
            if item.is_dir():
                continue
            path, mode = item.filename, item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if (not path or "\\" in path or PurePosixPath(path).is_absolute()
                    or any(part in ("", ".", "..") for part in path.split("/"))):
                raise ValueError(f"unsafe source archive path: {path!r}")
            if stat.S_ISLNK(mode) or kind not in (0, stat.S_IFREG):
                raise ValueError(f"source archive contains a non-regular file: {path!r}")
            if path in members:
                raise ValueError(f"duplicate source archive path: {path!r}")
            members[path] = item
        if set(members) != set(entries):
            raise ValueError("source archive file set does not match retained source manifest")
        for path, expected in entries.items():
            digest = hashlib.sha256()
            with archive.open(members[path]) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != expected:
                raise ValueError(f"source archive file hash does not match manifest: {path}")


def validate_job_result(result, schema, run_root):
    errors = _validate_schema(result, schema)
    if errors:
        return errors
    root = Path(run_root)
    try:
        artifacts = result["artifacts"]
        archive = _retained_file(root, artifacts["source_archive"])
        if _file_hash(archive) != result["source"]["package_sha256"]:
            errors.append("source.package_sha256 does not match retained source archive")
        log = _retained_file(root, artifacts["raw_log"])
        if _file_hash(log) != artifacts["raw_log_sha256"]:
            errors.append("artifacts.raw_log_sha256 does not match retained log")
        result_file = _retained_file(root, artifacts["result_manifest"])
        if json.loads(result_file.read_text(encoding="utf-8")) != result:
            errors.append("artifacts.result_manifest does not contain this result")
        context = result["event_context"]
        manifest = _retained_file(root, artifacts["source_manifest"])
        if _file_hash(manifest) != artifacts["source_manifest_sha256"]:
            errors.append("artifacts.source_manifest_sha256 does not match retained source archive manifest")
        source_manifest = json.loads(manifest.read_text(encoding="utf-8"))
        if source_manifest.get("commit") != result["source"]["commit"] or source_manifest.get("tree") != result["source"]["tree"]:
            errors.append("source commit/tree do not match the retained source manifest")
        if source_manifest.get("archive_sha256") != result["source"]["package_sha256"]:
            errors.append("source archive hash does not match the retained source manifest")
        entries = _source_file_map(source_manifest)
        _verify_source_archive(archive, entries)
        descriptor_file = _retained_file(root, artifacts["execution_descriptor"])
        if _file_hash(descriptor_file) != artifacts["execution_descriptor_sha256"]:
            errors.append("execution descriptor SHA-256 does not match its retained file")
        descriptor = json.loads(descriptor_file.read_text(encoding="utf-8"))
        descriptor_fields = {
            "schema_version", "source_archive_sha256", "source_manifest_sha256",
            "packet_context", "git_delta_manifest", "candidate_commit", "candidate_tree",
            "tests", "locks", "argv", "execution_environment",
        }
        if not isinstance(descriptor, dict) or set(descriptor) != descriptor_fields or descriptor.get("schema_version") != 1:
            errors.append("retained execution descriptor has an unsupported shape")
        else:
            if descriptor["source_archive_sha256"] != result["source"]["package_sha256"]:
                errors.append("execution descriptor archive pin does not match the result")
            if descriptor["source_manifest_sha256"] != artifacts["source_manifest_sha256"]:
                errors.append("execution descriptor source manifest pin does not match the result")
            if descriptor["packet_context"] != {
                "manifest_path": context["manifest_path"],
                "manifest_sha256": context["manifest_sha256"],
            }:
                errors.append("execution descriptor packet context does not match the result")
            delta = descriptor["git_delta_manifest"]
            if delta != {"status": "not_applicable"} and not (
                isinstance(delta, dict) and set(delta) == {"status", "path", "sha256"}
                and delta.get("status") == "pinned"
                and delta["path"] == context["manifest_path"]
                and delta["sha256"] == context["manifest_sha256"]
            ):
                errors.append("execution descriptor Git-delta identity is invalid")
            if descriptor["candidate_commit"] != result["source"]["commit"] or descriptor["candidate_tree"] != result["source"]["tree"]:
                errors.append("execution descriptor candidate identity does not match the result")
            if descriptor["tests"] != result["tests"] or descriptor["locks"] != result["source"]["lock_sha256"]:
                errors.append("execution descriptor test/lock pins do not match the result")
            argv = descriptor["argv"]
            command = result["command"]
            if (not isinstance(argv, list) or len(argv) < 3 or any(not isinstance(item, str) for item in argv)
                    or len(command) < 3 or Path(argv[0]).name != Path(command[0]).name
                    or argv[1:] != command[1:]):
                errors.append("execution descriptor argv does not match the result")
            execution_environment = descriptor["execution_environment"]
            if (not isinstance(execution_environment, dict)
                    or set(execution_environment) != {"execution_root_kind", "profile"}
                    or execution_environment.get("execution_root_kind") != result["environment"]["execution_root_kind"]
                    or not isinstance(execution_environment.get("profile"), str)
                    or not execution_environment["profile"].strip()):
                errors.append("execution descriptor environment does not match the result")
        if result["tests"] != {path: entries.get(path) for path in result["tests"]}:
            errors.append("tests pins do not match the retained source manifest")
        if _canonical_hash(result["tests"]) != result["tests_sha256"]:
            errors.append("tests_sha256 does not match the canonical tests map")
        locks = {path: digest for path, digest in entries.items() if _is_lock_path(path)}
        if result["source"]["lock_sha256"] != locks:
            errors.append("source lock hashes do not match the retained source manifest")
        if context["candidate_commit"] != result["source"]["commit"] or context["candidate_tree"] != result["source"]["tree"]:
            errors.append("event candidate identity does not match the source identity")
        environment = result["environment"]
        command = result["command"]
        process_group_cleaned = result["cleanup"]["process_group_cleaned"]
        if result["exit_code"] is None:
            if process_group_cleaned is not None:
                errors.append("results without a child exit code must mark process-group cleanup not applicable")
        elif process_group_cleaned is not True:
            errors.append("child execution results require confirmed process-group cleanup")
        if (len(command) < 3 or Path(command[0]).name != "node" or command[1] != "--test"
                or set(command[2:]) != set(result["tests"]) or len(command[2:]) != len(set(command[2:]))):
            errors.append("command must be node --test with exactly the pinned test-file set")
        if environment["node_executable"] and command[0] != environment["node_executable"]:
            errors.append("command executable does not match the recorded Node executable")
        if result["status"] in ("PASS", "FAIL") and (
            not environment["node_executable"] or not environment["node_sha256"] or environment["node"] == "unavailable"
        ):
            errors.append("completed Node tests require the resolved executable path, version, and SHA-256")
        if result["status"] in ("PASS", "FAIL") and environment["execution_root_kind"] != "remote":
            errors.append("completed tests require the approved remote environment")
        if result["status"] in ("PASS", "FAIL") and not artifacts["event_draft"]:
            errors.append("completed tests require an event draft path")
        if result["status"] not in ("PASS", "FAIL") and artifacts["event_draft"] is not None:
            errors.append("BLOCKED/CANCELLED jobs must not claim a test event draft")
        if result["status"] == "PASS":
            counts = result["counts"]
            if (result["exit_code"] != 0 or counts["unparsed"] or not counts["tests"]
                    or counts["passed"] != counts["tests"] or counts["failed"]
                    or counts["skipped"] or counts["cancelled"]):
                errors.append("PASS requires exit 0 and a parsed nonempty all-pass summary with no skips/cancellations")
            if result["failure_classification"] != "NONE":
                errors.append("PASS requires failure_classification NONE")
        elif result["status"] == "FAIL":
            if result["exit_code"] in (None, 0):
                errors.append("FAIL requires a nonzero command exit code")
            if result["failure_classification"] != "SOFTWARE_DEVELOPMENT_INCOMPLETE":
                errors.append("FAIL requires software-development failure classification")
        elif result["status"] == "BLOCKED" and result["failure_classification"] != "INFRA_BLOCKED":
            errors.append("BLOCKED requires infrastructure-blocked classification")
        elif result["status"] == "CANCELLED" and result["failure_classification"] != "NOT_APPLICABLE":
            errors.append("CANCELLED requires NOT_APPLICABLE classification")
    except (KeyError, OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile, RuntimeError) as exc:
        errors.append(f"retained evidence is invalid: {exc}")
    return errors


def validate_test_event(event, result, run_root, schema=None):
    schema = schema or load_schema(Path(__file__).with_name("test-event.schema.json"))
    errors = _validate_schema(event, schema)
    if errors:
        return errors
    if event.get("event_type") != "test":
        return ["only test events may be emitted"]
    if result.get("status") not in ("PASS", "FAIL"):
        errors.append("only completed test outcomes may produce an owner test event")
    context = result.get("event_context", {})
    for key in ("owner", "packet_id", "source_class", "candidate_commit", "candidate_tree", "manifest_path", "manifest_sha256", "dependencies", "ac_ids"):
        if event.get(key) != context.get(key):
            errors.append(f"event {key} does not match the job result")
    for key in ("repo", "tests_sha256"):
        if event.get(key) != result.get(key):
            errors.append(f"event {key} does not match the job result")
    evidence = event.get("evidence", {})
    expected = "passed" if result.get("status") == "PASS" else "failed"
    if evidence.get("kind") != "test_result" or evidence.get("job_id") != result.get("job_id"):
        errors.append("event evidence must identify this test result")
    if evidence.get("result") != expected or evidence.get("exit_code") != result.get("exit_code"):
        errors.append("event evidence result/exit_code does not match the job result")
    if (evidence.get("result") == "passed" and evidence.get("exit_code") != 0) or (
        evidence.get("result") == "failed" and evidence.get("exit_code") in (None, 0)
    ):
        errors.append("passed evidence requires exit_code 0; failed evidence requires a nonzero exit_code")
    try:
        result_path = _retained_file(run_root, evidence["path"])
        if _file_hash(result_path) != evidence.get("sha256"):
            errors.append("event evidence SHA-256 does not match its result file")
        if json.loads(result_path.read_text(encoding="utf-8")) != result:
            errors.append("event evidence file does not contain the supplied job result")
        if evidence["path"] != result["artifacts"]["result_manifest"]:
            errors.append("event evidence path must point to the job result manifest")
    except (KeyError, OSError, ValueError, json.JSONDecodeError) as exc:
        errors.append(f"event evidence is invalid: {exc}")
    return errors


def _read_single_event(path):
    lines = [line for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(lines) != 1:
        raise ValueError("event draft must contain exactly one nonempty JSON line")
    return json.loads(lines[0])


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result", type=Path)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--schema", type=Path, default=Path(__file__).with_name("linux-job-result.schema.json"))
    parser.add_argument("--event-schema", type=Path, default=Path(__file__).with_name("test-event.schema.json"))
    parser.add_argument("--event", type=Path)
    args = parser.parse_args(argv)
    try:
        result = json.loads(args.result.read_text(encoding="utf-8"))
        root = args.root or args.result.parent
        errors = validate_job_result(result, load_schema(args.schema), root)
        event_path = args.event
        if event_path is None and isinstance(result, dict):
            event_rel = result.get("artifacts", {}).get("event_draft")
            if event_rel:
                event_path = _retained_file(root, event_rel)
        if event_path:
            errors.extend(validate_test_event(_read_single_event(event_path), result, root, load_schema(args.event_schema)))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        errors = [str(exc)]
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("result and supplied event are valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
