#!/usr/bin/env python3
"""Verify and install the pinned Ponytail skills in the plan-mapped worktrees."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


UPSTREAM = "https://github.com/DietrichGebert/ponytail"
PINNED_REF = "09c434ab73ca43761c5d8b0c5d341926c2fba710"
PINNED_VERSION = "5.3.2"
ROLE_5_THREAD = "01a167c6-3863-7b61-97b5-86aee066ee78"
EXPECTED_SKILLS = {
    "ponytail",
    "ponytail-audit",
    "ponytail-debt",
    "ponytail-gain",
    "ponytail-help",
    "ponytail-review",
}
PLAN_RELATIVE = Path(
    "docs/superpowers/plans/pilotdeck-ledger-v2-20261021/parallel-permissive-20/plan.json"
)
MANIFEST_RELATIVE = Path("docs/diagnostics/ponytail-install-20261024/upstream-manifest.json")
LICENSE_NAME = "LICENSE-MIT"
PINNED_SKILL_FILES = {"SKILL.md", LICENSE_NAME}
START_MARKER = "<!-- BEGIN ponytail-full-2026-10-24 -->"
GUIDANCE = """<!-- BEGIN ponytail-full-2026-10-24 -->
## Ponytail (full)

- Use Ponytail full as the default for project code changes. Before editing code, read .agents/skills/ponytail/SKILL.md.
- Trace the real callers, tests, configuration, and exports; reuse existing implementations, the standard library, and installed dependencies; make the smallest complete change.
- Preserve each worktree's existing role, shared-path writer assignments, permissions, validation, security, error handling, and acceptance authority. This guidance grants no additional permissions.
<!-- END ponytail-full-2026-10-24 -->
"""


class CoverageError(Exception):
    pass


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_blob_sha1(data: bytes) -> str:
    header = f"blob {len(data)}\0".encode("ascii")
    return hashlib.sha1(header + data).hexdigest()


def _absolute(value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute():
        raise CoverageError(f"path must be absolute: {path}")
    return path


def _within(path: str | Path, root: str | Path) -> bool:
    candidate = os.path.normcase(os.path.abspath(os.fspath(path)))
    base = os.path.normcase(os.path.abspath(os.fspath(root)))
    try:
        return os.path.commonpath((candidate, base)) == base
    except ValueError:
        return False


def _allowed_root(value: str | Path) -> Path:
    root = Path(value).resolve(strict=True)
    ceiling = Path("E:/codex").resolve(strict=True)
    if not _within(root, ceiling):
        raise CoverageError("allowed root cannot extend beyond E:/codex")
    return root


def _resolve_inside(
    path: str | Path,
    allowed_root: Path,
    *,
    strict: bool = False,
    scoped_roots: tuple[Path, ...] = (),
) -> Path:
    candidate = _absolute(path)
    try:
        resolved = candidate.resolve(strict=strict)
    except (OSError, RuntimeError) as error:
        raise CoverageError(f"cannot resolve path {candidate}: {error}") from error
    if not _within(resolved, allowed_root):
        raise CoverageError(f"path escapes allowed root {allowed_root}: {candidate}")
    if scoped_roots and not any(_within(resolved, root) for root in scoped_roots):
        raise CoverageError(f"path escapes its worktree or pinned source: {candidate}")
    return resolved


def _lexists(path: Path) -> bool:
    return os.path.lexists(os.fspath(path))


def find_source_root(start: str | Path) -> Path:
    for candidate in (Path(start).resolve(), *Path(start).resolve().parents):
        if (
            (candidate / ".agents/skills/ponytail/SKILL.md").is_file()
            and (candidate / MANIFEST_RELATIVE).is_file()
        ):
            return candidate
    raise CoverageError("could not find the pinned project skill source above this script")


def _source_files(source_root: Path, manifest_path: Path, allowed_root: Path) -> tuple[dict, dict]:
    manifest_path = _resolve_inside(
        manifest_path, allowed_root, strict=True, scoped_roots=(source_root,)
    )
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if (
        manifest.get("upstream") != UPSTREAM
        or manifest.get("ref") != PINNED_REF
        or manifest.get("version") != PINNED_VERSION
        or manifest.get("default_mode") != "full"
    ):
        raise CoverageError("upstream, commit, version, or default mode differs from the pinned manifest")

    license_path = _resolve_inside(
        manifest_path.parent / LICENSE_NAME, allowed_root, strict=True, scoped_roots=(source_root,)
    )
    license_bytes = license_path.read_bytes()
    if b"MIT License" not in license_bytes:
        raise CoverageError("the pinned MIT license file is missing or malformed")

    skills: dict[str, list[tuple[Path, bytes, str]]] = {}
    for entry in manifest.get("files", []):
        target = PurePosixPath(entry["target"])
        parts = target.parts
        if len(parts) != 4 or parts[:2] != (".agents", "skills") or parts[3] != "SKILL.md":
            raise CoverageError(f"unexpected skill target in manifest: {entry.get('target')}")
        name = parts[2]
        if name in skills:
            raise CoverageError(f"duplicate skill in manifest: {name}")
        skill_dir = _resolve_inside(
            source_root / ".agents" / "skills" / name,
            allowed_root,
            strict=True,
            scoped_roots=(source_root,),
        )
        if not skill_dir.is_dir():
            raise CoverageError(f"skill source is not a directory: {name}")

        files: list[tuple[Path, bytes, str]] = []
        found_skill_md = False
        for source_file in sorted(skill_dir.rglob("*")):
            resolved_file = _resolve_inside(
                source_file,
                allowed_root,
                strict=True,
                scoped_roots=(source_root,),
            )
            if resolved_file.is_dir() or not resolved_file.is_file():
                continue
            relative = source_file.relative_to(skill_dir)
            if relative.as_posix() not in PINNED_SKILL_FILES:
                raise CoverageError(
                    f"unmanifested file in pinned skill source: {name}/{relative.as_posix()}"
                )
            data = resolved_file.read_bytes()
            files.append((relative, data, sha256(data)))
            if relative.as_posix() == "SKILL.md":
                found_skill_md = True
                if (
                    len(data) != entry.get("size")
                    or git_blob_sha1(data) != entry.get("git_blob_sha1")
                ):
                    raise CoverageError(f"skill file does not match the pinned manifest: {name}/SKILL.md")
            if relative.as_posix() == LICENSE_NAME and data != license_bytes:
                raise CoverageError(f"skill license differs from the pinned MIT license: {name}")
        if not found_skill_md:
            raise CoverageError(f"skill source is missing SKILL.md: {name}")
        if not any(path.as_posix() == LICENSE_NAME for path, _, _ in files):
            raise CoverageError(f"skill source is missing its MIT license: {name}")
        skills[name] = files

    if set(skills) != EXPECTED_SKILLS:
        raise CoverageError("manifest must contain exactly the six pinned Ponytail skills")
    source = {
        "status": "valid",
        "upstream": UPSTREAM,
        "commit": PINNED_REF,
        "version": PINNED_VERSION,
        "default_mode": "full",
        "manifest_path": str(manifest_path),
        "manifest_sha256": sha256(manifest_bytes),
        "license_path": str(license_path),
        "license_sha256": sha256(license_bytes),
    }
    return source, skills


def _load_plan(plan_path: Path, source_root: Path, allowed_root: Path) -> tuple[dict, str]:
    resolved_path = _resolve_inside(
        plan_path, allowed_root, strict=True, scoped_roots=(source_root,)
    )
    data = resolved_path.read_bytes()
    plan = json.loads(data)
    workers = plan.get("workers")
    if not isinstance(workers, list) or len(workers) != 20:
        raise CoverageError("the fixed plan must map exactly 20 workers")
    roles = [worker.get("number") for worker in workers]
    thread_ids = [worker.get("thread_id") for worker in workers]
    if set(roles) != set(range(1, 21)) or len(set(thread_ids)) != 20:
        raise CoverageError("the fixed plan must map roles 1–20 to unique threads")
    role_5 = next(worker for worker in workers if worker["number"] == 5)
    if role_5.get("thread_id") != ROLE_5_THREAD:
        raise CoverageError("role 5 does not use the fixed 10/23 thread mapping")
    return plan, sha256(data)


def _worktree_info(worker: dict, allowed_root: Path) -> dict:
    number = worker["number"]
    raw_workspace = worker.get("workspace", "")
    row = {
        "role": number,
        "thread_id": worker.get("thread_id"),
        "workspace": str(raw_workspace),
        "native_cwd": None,
        "git_root": None,
        "status": "blocked",
        "reason": None,
        "skills": {},
        "skill_discoverable": False,
        "guidance_action": "blocked",
        "guidance_merged": False,
        "activation": {
            "confirmed": False,
            "read_receipt": "pending",
            "reported_cwd": None,
        },
    }
    try:
        workspace = _resolve_inside(raw_workspace, allowed_root, strict=True)
        if not workspace.is_dir():
            raise CoverageError("mapped worktree is not a directory")
        previous = os.getcwd()
        try:
            os.chdir(workspace)
            row["native_cwd"] = os.path.realpath(os.getcwd())
        finally:
            os.chdir(previous)

        git_root = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=row["native_cwd"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        resolved_git_root = _resolve_inside(git_root, allowed_root, strict=True)
        row["git_root"] = str(resolved_git_root)
        if os.path.normcase(str(resolved_git_root)) != os.path.normcase(row["native_cwd"]):
            raise CoverageError("mapped path is not the Git worktree root")

        row["status"] = "planned"
        return row
    except (CoverageError, OSError, subprocess.SubprocessError) as error:
        row["reason"] = str(error)
        return row


def _blocked_additional_root(role, workspace, evidence, reason: str) -> dict:
    return {
        "role": role,
        "thread_id": None,
        "workspace": str(workspace),
        "native_cwd": None,
        "git_root": None,
        "status": "blocked",
        "reason": reason,
        "evidence": evidence,
        "skills": {},
        "skill_discoverable": False,
        "guidance_action": "blocked",
        "guidance_merged": False,
        "activation": {
            "confirmed": False,
            "read_receipt": "pending",
            "reported_cwd": None,
        },
    }


def _load_additional_roots(
    alias_map_path: Path | None,
    source_root: Path,
    allowed_root: Path,
    plan_rows: list[dict],
) -> tuple[dict, list[dict]]:
    if alias_map_path is None:
        return {"status": "not-provided", "path": None, "sha256": None}, []

    try:
        resolved_map = _resolve_inside(
            alias_map_path, allowed_root, strict=True, scoped_roots=(source_root,)
        )
        data = resolved_map.read_bytes()
        payload = json.loads(data)
        if payload.get("schema_version") != "ponytail-reported-private-worktrees/v1":
            raise CoverageError("reported private worktree map has an unsupported schema")
        aliases = payload.get("aliases")
        if not isinstance(aliases, list):
            raise CoverageError("reported private worktree map must contain an aliases list")
    except (CoverageError, OSError, ValueError, AttributeError, TypeError, json.JSONDecodeError) as error:
        return {"status": "invalid", "path": str(alias_map_path), "sha256": None, "reason": str(error)}, []

    plan_paths = set()
    for row in plan_rows:
        for value in (row.get("workspace"), row.get("native_cwd"), row.get("git_root")):
            if value:
                plan_paths.add(os.path.normcase(os.path.abspath(value)))

    rows = []
    seen_roles = set()
    seen_paths = set()
    for alias in aliases:
        if not isinstance(alias, dict):
            rows.append(_blocked_additional_root(None, alias, None, "alias entry must be an object"))
            continue
        role = alias.get("role")
        raw_workspace = alias.get("workspace")
        evidence = alias.get("evidence")
        reason = None
        if isinstance(role, bool) or not isinstance(role, int) or role not in range(1, 21):
            reason = "alias role must be an integer from 1 through 20"
        elif role in seen_roles:
            reason = f"duplicate alias role: {role}"
        else:
            seen_roles.add(role)
        if not isinstance(evidence, str) or not evidence.strip():
            reason = reason or "alias evidence must be a non-empty string"
        if not isinstance(raw_workspace, str) or not Path(raw_workspace).is_absolute():
            reason = reason or "alias workspace must be an absolute path"

        resolved_workspace = None
        if reason is None:
            try:
                resolved_workspace = _resolve_inside(raw_workspace, allowed_root, strict=True)
                normalized_workspace = os.path.normcase(os.path.abspath(resolved_workspace))
                if normalized_workspace in plan_paths:
                    reason = "alias workspace duplicates a mapped plan worktree"
                elif normalized_workspace in seen_paths:
                    reason = "duplicate alias workspace"
                else:
                    seen_paths.add(normalized_workspace)
            except (CoverageError, OSError) as error:
                reason = str(error)

        if reason is not None:
            rows.append(_blocked_additional_root(role, raw_workspace, evidence, reason))
            continue

        row = _worktree_info({"number": role, "workspace": str(resolved_workspace)}, allowed_root)
        row["evidence"] = evidence.strip()
        rows.append(row)

    return {
        "status": "valid",
        "path": str(resolved_map),
        "sha256": sha256(data),
        "count": len(aliases),
    }, rows


def _target_path(
    path: Path,
    workspace: Path,
    source_root: Path,
    allowed_root: Path,
    *,
    strict: bool = False,
) -> Path:
    return _resolve_inside(
        path,
        allowed_root,
        strict=strict,
        scoped_roots=(workspace, source_root),
    )


def _skill_state(
    workspace: Path,
    name: str,
    files: list[tuple[Path, bytes, str]],
    source_root: Path,
    allowed_root: Path,
    *,
    apply: bool,
    link_state: dict,
) -> str:
    destination = workspace / ".agents" / "skills" / name
    try:
        resolved_destination = _target_path(
            destination, workspace, source_root, allowed_root, strict=_lexists(destination)
        )
        if _lexists(destination) and not resolved_destination.is_dir():
            return "conflict"
        missing = []
        for relative, expected_bytes, expected_hash in files:
            target = destination / relative
            if not _lexists(target):
                missing.append((relative, expected_bytes, expected_hash))
                continue
            resolved_target = _target_path(
                target, workspace, source_root, allowed_root, strict=True
            )
            if not resolved_target.is_file() or sha256(resolved_target.read_bytes()) != expected_hash:
                return "conflict"
        if not missing:
            return "reused-identical"
        if not apply:
            return "would-copy"

        if not _lexists(destination):
            _ensure_directory(destination.parent, workspace, source_root, allowed_root)
            if link_state["available"] is not False:
                linked, reason = _create_directory_link(destination, source_root / ".agents/skills" / name)
                if linked:
                    link_state["available"] = True
                    if all(
                        sha256((destination / relative).read_bytes()) == expected_hash
                        for relative, _, expected_hash in files
                    ):
                        return "linked-identical"
                    os.rmdir(destination)
                else:
                    if link_state["available"] is None:
                        link_state["available"] = False
                        link_state["reason"] = reason
            _ensure_directory(destination, workspace, source_root, allowed_root)

        copied = False
        for relative, expected_bytes, expected_hash in missing:
            target = destination / relative
            _ensure_directory(target.parent, workspace, source_root, allowed_root)
            _target_path(target, workspace, source_root, allowed_root)
            try:
                with target.open("xb") as output:
                    output.write(expected_bytes)
                copied = True
            except FileExistsError:
                resolved_target = _target_path(
                    target, workspace, source_root, allowed_root, strict=True
                )
                if not resolved_target.is_file() or sha256(resolved_target.read_bytes()) != expected_hash:
                    return "conflict"
        return "copied" if copied else "reused-identical"
    except (CoverageError, OSError, RuntimeError):
        return "conflict"


def _create_directory_link(link: Path, target: Path) -> tuple[bool, str | None]:
    if os.name == "nt":
        command = (
            "$ErrorActionPreference = 'Stop'\n"
            "$link = $env:PONYTAIL_LINK_PATH\n"
            "$target = $env:PONYTAIL_LINK_TARGET\n"
            "New-Item -ItemType Junction -Path $link -Target $target | Out-Null\n"
            "if (-not (Test-Path -LiteralPath $link -PathType Container)) { exit 1 }\n"
            "exit 0"
        )
        environment = {
            "SystemRoot": os.environ.get("SystemRoot", ""),
            "PATH": os.environ.get("PATH", ""),
            "TEMP": os.environ.get("TEMP", ""),
            "TMP": os.environ.get("TMP", ""),
            "PONYTAIL_LINK_PATH": str(link),
            "PONYTAIL_LINK_TARGET": str(target),
        }
        try:
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                env=environment,
                capture_output=True,
                text=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError) as error:
            return False, str(error)
        if result.returncode == 0 and link.is_dir():
            return True, None
        return False, (result.stderr or result.stdout or "Windows directory link creation failed").strip()
    try:
        os.symlink(target, link, target_is_directory=True)
        return True, None
    except OSError as error:
        return False, str(error)


def _ensure_directory(path: Path, workspace: Path, source_root: Path, allowed_root: Path) -> None:
    _target_path(path, workspace, source_root, allowed_root)
    if _lexists(path):
        resolved = _target_path(path, workspace, source_root, allowed_root, strict=True)
        if not resolved.is_dir():
            raise CoverageError(f"expected a directory: {path}")
        return
    _ensure_directory(path.parent, workspace, source_root, allowed_root)
    _target_path(path, workspace, source_root, allowed_root)
    path.mkdir()


def _guidance_action(workspace: Path, source_root: Path, allowed_root: Path) -> str:
    path = workspace / "AGENTS.md"
    if not _lexists(path):
        return "would-create"
    try:
        resolved = _resolve_inside(path, allowed_root, strict=True, scoped_roots=(workspace,))
    except CoverageError:
        return "conflict"
    if not resolved.is_file():
        return "conflict"
    existing = resolved.read_bytes()
    normalized = existing.replace(b"\r\n", b"\n")
    block = GUIDANCE.encode("utf-8")
    if START_MARKER.encode("ascii") in existing:
        return "already-present" if block in normalized else "conflict"
    if b"## Ponytail" in existing:
        return "conflict"
    return "would-append"


def _merge_guidance(workspace: Path, source_root: Path, allowed_root: Path) -> str:
    action = _guidance_action(workspace, source_root, allowed_root)
    if action == "already-present" or action == "conflict":
        return action
    path = workspace / "AGENTS.md"
    try:
        _resolve_inside(path, allowed_root, scoped_roots=(workspace,))
        if action == "would-create":
            with path.open("xb") as output:
                output.write(GUIDANCE.encode("utf-8"))
            return "created"
        existing = path.read_bytes()
        normalized = existing.replace(b"\r\n", b"\n")
        if START_MARKER.encode("ascii") in existing:
            return "already-present" if GUIDANCE.encode("utf-8") in normalized else "conflict"
        separator = b"" if not existing else (b"" if existing.endswith((b"\n", b"\r")) else os.linesep.encode()) + os.linesep.encode()
        with path.open("ab") as output:
            output.write(separator)
            output.write(GUIDANCE.replace("\n", os.linesep).encode("utf-8"))
        return "appended"
    except (CoverageError, OSError):
        return "conflict"


def _refresh_summary(report: dict) -> None:
    rows = report["worktrees"]
    additional_rows = report.get("additional_private_roots", [])
    report["summary"] = {
        "worktrees": len(rows),
        "filesystem_ready": sum(
            row["skill_discoverable"] and row["guidance_merged"] for row in rows
        ),
        "skills_discoverable": sum(row["skill_discoverable"] for row in rows),
        "guidance_merged": sum(row["guidance_merged"] for row in rows),
        "activated": sum(row["activation"]["confirmed"] for row in rows),
        "blocked": sum(row["status"] == "blocked" for row in rows),
        "partial": sum(row["status"] == "partial" for row in rows),
        "additional_private_roots": len(additional_rows),
        "additional_roots_ready": sum(row["status"] == "ready" for row in additional_rows),
        "additional_roots_blocked": sum(row["status"] == "blocked" for row in additional_rows),
        "additional_roots_partial": sum(row["status"] == "partial" for row in additional_rows),
    }


def build_coverage_report(
    source_root: str | Path,
    plan_path: str | Path,
    manifest_path: str | Path,
    allowed_root: str | Path,
    alias_map_path: str | Path | None = None,
) -> tuple[dict, dict[str, list[tuple[Path, bytes, str]]]]:
    allowed = _allowed_root(allowed_root)
    try:
        source_dir = _resolve_inside(source_root, allowed, strict=True)
        if not source_dir.is_dir():
            raise CoverageError("source root is not a directory")
        plan, plan_hash = _load_plan(Path(plan_path), source_dir, allowed)
    except (CoverageError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        return (
            {
                "schema_version": "ponytail-worktree-coverage/v1",
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                "mode": "dry-run",
                "plan": {"path": str(plan_path), "sha256": None, "mapping_count": 0},
                "source": {"status": "invalid", "reason": str(error)},
                "integration": {
                    "path": None,
                    "owner": 13,
                    "touched": False,
                    "reason": "shared integration rules are reserved to role 13",
                },
                "worktrees": [],
                "additional_private_roots": [],
                "alias_map": {"status": "not-loaded", "path": str(alias_map_path) if alias_map_path else None},
                "summary": {
                    "worktrees": 0,
                    "filesystem_ready": 0,
                    "skills_discoverable": 0,
                    "guidance_merged": 0,
                    "activated": 0,
                    "blocked": 0,
                    "partial": 0,
                    "additional_private_roots": 0,
                    "additional_roots_ready": 0,
                    "additional_roots_blocked": 0,
                    "additional_roots_partial": 0,
                },
            },
            {},
        )

    try:
        source, skills = _source_files(source_dir, Path(manifest_path), allowed)
    except (CoverageError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        source = {"status": "invalid", "reason": str(error)}
        skills = {}

    plan_path_resolved = Path(plan_path)
    rows = [_worktree_info(worker, allowed) for worker in sorted(plan.get("workers", []), key=lambda item: item["number"])]
    alias_map, additional_rows = _load_additional_roots(
        Path(alias_map_path) if alias_map_path is not None else None,
        Path(source_root).resolve(),
        allowed,
        rows,
    )
    report = {
        "schema_version": "ponytail-worktree-coverage/v1",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "mode": "dry-run",
        "plan": {
            "path": str(plan_path_resolved),
            "sha256": plan_hash,
            "mapping_count": len(rows),
        },
        "source": source,
        "alias_map": alias_map,
        "integration": {
            "path": plan.get("integration_workspace"),
            "owner": 13,
            "touched": False,
            "reason": "shared integration rules are reserved to role 13",
        },
        "worktrees": rows,
        "additional_private_roots": additional_rows,
        "summary": {},
    }
    if source.get("status") == "valid":
        for row in rows + additional_rows:
            if row["status"] == "planned":
                workspace = Path(row["native_cwd"])
                row["skills"] = {
                    name: _skill_state(
                        workspace,
                        name,
                        skills[name],
                        Path(source_root).resolve(),
                        allowed,
                        apply=False,
                        link_state={"available": None, "reason": None},
                    )
                    for name in sorted(skills)
                }
                row["skill_discoverable"] = all(
                    status == "reused-identical" for status in row["skills"].values()
                )
                row["guidance_action"] = _guidance_action(
                    workspace, Path(source_root).resolve(), allowed
                )
                row["guidance_merged"] = row["guidance_action"] == "already-present"
                has_conflict = (
                    any(status == "conflict" for status in row["skills"].values())
                    or row["guidance_action"] == "conflict"
                )
                row["status"] = "blocked" if has_conflict else "planned"
                if has_conflict:
                    row["reason"] = "a local skill or AGENTS.md conflict was detected during preflight"
    else:
        for row in rows + additional_rows:
            if row["status"] == "planned":
                row["status"] = "blocked"
                row["reason"] = "pinned skill source is invalid"
    _refresh_summary(report)
    return report, skills


def apply_coverage(report: dict, skills: dict[str, list[tuple[Path, bytes, str]]], source_root: Path, allowed_root: Path) -> None:
    if report["source"].get("status") != "valid":
        return
    link_state = {"available": None, "reason": None}
    for row in report["worktrees"] + report.get("additional_private_roots", []):
        if row["status"] != "planned":
            continue
        workspace = Path(row["native_cwd"])
        row["skills"] = {
            name: _skill_state(
                workspace,
                name,
                skills[name],
                source_root,
                allowed_root,
                apply=True,
                link_state=link_state,
            )
            for name in sorted(skills)
        }
        row["skill_discoverable"] = all(
            state in {"reused-identical", "copied", "linked-identical"}
            for state in row["skills"].values()
        )
        row["guidance_action"] = (
            _merge_guidance(workspace, source_root, allowed_root)
            if row["skill_discoverable"]
            else "blocked-skill-conflict"
        )
        row["guidance_merged"] = row["guidance_action"] in {"already-present", "appended", "created"}
        row["link_mode"] = "directory-link" if link_state["available"] else "copy"
        if link_state["reason"] and not link_state["available"]:
            row["link_failure_reason"] = link_state["reason"]
        row["status"] = (
            "ready" if row["skill_discoverable"] and row["guidance_merged"] else "partial"
        )
    report["mode"] = "apply"
    _refresh_summary(report)


def build_machine_index(report: dict) -> dict:
    return {
        "schema_version": "ponytail-worktree-index/v1",
        "generated_at_utc": report["generated_at_utc"],
        "plan_sha256": report["plan"]["sha256"],
        "source_manifest_sha256": report["source"].get("manifest_sha256"),
        "counts": report["summary"],
        "integration": report["integration"],
        "roles": [
            {
                "role": row["role"],
                "thread_id": row["thread_id"],
                "workspace": row["workspace"],
                "native_cwd": row["native_cwd"],
                "git_root": row["git_root"],
                "status": row["status"],
                "skill_discoverable": row["skill_discoverable"],
                "guidance_merged": row["guidance_merged"],
                "read_receipt": row["activation"]["read_receipt"],
                "reported_cwd": row["activation"]["reported_cwd"],
                "activation_confirmed": row["activation"]["confirmed"],
            }
            for row in report["worktrees"]
        ],
        "additional_private_roots": [
            {
                "role": row["role"],
                "evidence": row.get("evidence"),
                "workspace": row["workspace"],
                "native_cwd": row["native_cwd"],
                "git_root": row["git_root"],
                "status": row["status"],
                "skill_discoverable": row["skill_discoverable"],
                "guidance_merged": row["guidance_merged"],
            }
            for row in report.get("additional_private_roots", [])
        ],
    }


def _validate_output(path: str | Path | None, allowed_root: Path) -> Path | None:
    if path is None:
        return None
    output = _resolve_inside(path, allowed_root)
    if _lexists(output):
        raise CoverageError(f"refusing to overwrite existing output: {output}")
    return output


def _write_new_json(path: Path | None, payload: dict, allowed_root: Path) -> None:
    if path is None:
        return
    resolved = _resolve_inside(path, allowed_root)
    parent = resolved.parent
    parent.mkdir(parents=True, exist_ok=True)
    _resolve_inside(parent, allowed_root, strict=True)
    with resolved.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(payload, output, indent=2, sort_keys=True)
        output.write("\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--alias-map", type=Path, help="reported private Git worktrees to cover separately")
    parser.add_argument("--allowed-root", type=Path, default=Path("E:/codex"))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="report planned changes (the default)")
    mode.add_argument("--apply", action="store_true", help="apply safe missing-file changes")
    parser.add_argument("--report-out", type=Path, help="write a detailed JSON report without overwriting")
    parser.add_argument("--index-out", type=Path, help="write a compact JSON index without overwriting")
    args = parser.parse_args(argv)

    try:
        allowed_root = _allowed_root(args.allowed_root)
        source_root = args.source_root.resolve(strict=True) if args.source_root else find_source_root(Path(__file__).resolve())
        plan_path = args.plan or source_root / PLAN_RELATIVE
        manifest_path = args.manifest or source_root / MANIFEST_RELATIVE
        report_out = _validate_output(args.report_out, allowed_root)
        index_out = _validate_output(args.index_out, allowed_root)
        if report_out is not None and index_out is not None:
            if os.path.normcase(str(report_out)) == os.path.normcase(str(index_out)):
                raise CoverageError("report and index outputs must be different files")
        report, skills = build_coverage_report(
            source_root, plan_path, manifest_path, allowed_root, args.alias_map
        )
        if args.apply and report["source"].get("status") == "valid":
            apply_coverage(report, skills, source_root.resolve(), allowed_root)
        index = build_machine_index(report)
        _write_new_json(report_out, report, allowed_root)
        _write_new_json(index_out, index, allowed_root)
        print(json.dumps(report, indent=2, sort_keys=True))
        bad = (
            report["source"].get("status") != "valid"
            or report.get("alias_map", {}).get("status") == "invalid"
            or any(
                row["status"] in {"blocked", "partial"}
                for row in report["worktrees"] + report.get("additional_private_roots", [])
            )
        )
        return 1 if bad else 0
    except (CoverageError, OSError, ValueError, json.JSONDecodeError) as error:
        print(json.dumps({"schema_version": "ponytail-worktree-coverage/v1", "error": str(error)}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
