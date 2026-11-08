#!/usr/bin/env python3
"""Run one R4-released delivery tool by its fixed ID, never by a caller path."""

import hashlib
import json
import os
import re
import stat
import sys
import types
from datetime import datetime, timezone
from pathlib import Path


TOOL_RELEASE_SCHEMA = "jot.r3-tools-release.v1"
R3_PROFILE_ID = "jot-parallel-r3-20261025"
R4_TOOL_RELEASE_SCHEMA = "jot.r4-tools-release.v1"
R4_PROFILE_ID = "jot-parallel-r4-20261025"
R4_TOOL_SOURCE_FILES = {
    "preflight": "preflight.py",
    "queue": "queue.py",
    "freeze": "local_freeze.py",
    "guard": "workspace_guard.py",
}
REPOSITORY = Path("E:/codex/yunticket")
ALL_FILES_ROOT = Path("E:/codex")
WORKSPACE_GUARD_SHA256 = "bd2b47ac6ed31d0996e83819ee9ed13fb15f7aaa09407628c3a54e4d98270215"
TOOL_SOURCE_FILES = {
    "preflight": "preflight.py",
    "queue": "queue.py",
    "work_event": "work_event.py",
    "metrics": "metrics.py",
    "freeze": "local_freeze.py",
    "guard": "workspace_guard.py",
}
SUPPORT_SOURCE_FILES = {
    "linux_run": "linux_run.py",
    "result_validate": "result_validate.py",
}
TOOL_IMPORT_ORDER = {
    "preflight": (
        "result_validate", "linux_run", "preflight", "workspace_guard", "local_freeze"
    ),
    "queue": (
        "result_validate", "linux_run", "preflight", "workspace_guard", "local_freeze"
    ),
    "freeze": ("result_validate", "linux_run", "preflight", "workspace_guard"),
    "work_event": ("metrics",),
    "metrics": (),
    "guard": (),
}
R4_SUPPORT_SOURCE_FILES = {**SUPPORT_SOURCE_FILES, "source_binding": "source_binding.py"}
R4_TOOL_IMPORT_ORDER = {
    "preflight": (
        "result_validate", "linux_run", "preflight", "source_binding", "workspace_guard", "local_freeze"
    ),
    "queue": (
        "result_validate", "linux_run", "preflight", "source_binding", "workspace_guard", "local_freeze"
    ),
    "freeze": ("result_validate", "linux_run", "preflight", "source_binding", "workspace_guard"),
    "guard": (),
}
SOURCE_ID_BY_MODULE_NAME = {
    "local_freeze": "freeze",
    "workspace_guard": "guard",
    "source_binding": "source_binding",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
GIT_OBJECT_RE = re.compile(r"^[0-9a-f]{40}$")
REPARSE_POINT = 0x400
workspace_guard = None


class ToolReleaseError(ValueError):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _has_reparse_component(path):
    path = Path(path)
    cursor = Path(path.anchor)
    for part in path.parts[1:]:
        if part in ("", "."):
            continue
        cursor = cursor / part
        try:
            info = os.lstat(cursor)
        except FileNotFoundError:
            continue
        except OSError:
            return True
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT:
            return True
    return False


def _load_workspace_guard():
    global workspace_guard
    if workspace_guard is not None:
        return workspace_guard
    path = Path(__file__).resolve().parent / "workspace_guard.py"
    if _has_reparse_component(path):
        raise ToolReleaseError("reparse_point")
    try:
        resolved = path.resolve(strict=True)
        source = resolved.read_bytes()
    except OSError as error:
        raise ToolReleaseError("workspace_guard_unavailable") from error
    if resolved.parent != path.parent or _sha256(source) != WORKSPACE_GUARD_SHA256:
        raise ToolReleaseError("workspace_guard_hash_mismatch")
    module = types.ModuleType("workspace_guard")
    module.__file__ = str(resolved)
    module.__package__ = ""
    exec(compile(source, str(resolved), "exec"), module.__dict__)
    workspace_guard = module
    return module


def _is_reparse(path):
    return _has_reparse_component(path)


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _read_release(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise ToolReleaseError("tool_release_unavailable") from error


def load_release(profile="r4"):
    workspace_guard = _load_workspace_guard()
    if profile == "r3":
        config, reason = workspace_guard.load_r3_config()
    elif profile == "r4":
        config, reason = workspace_guard.load_r4_config()
    else:
        raise ToolReleaseError("tool_profile_not_approved")
    if reason:
        raise ToolReleaseError(reason)
    pinned_path = Path(config["tool_release"])
    if _is_reparse(pinned_path):
        raise ToolReleaseError("reparse_point")
    return _read_release(pinned_path)


def _validate_r4_release_metadata(release):
    released_at = release.get("released_at")
    if (
        release.get("released_by") != "R"
        or not isinstance(released_at, str)
        or not released_at.endswith("Z")
        or any(not isinstance(release.get(key), str) or not GIT_OBJECT_RE.fullmatch(release[key])
               for key in ("shared_commit", "shared_tree"))
        or not isinstance(release.get("review_receipts"), list)
        or not release["review_receipts"]
    ):
        raise ToolReleaseError("tool_release_invalid")
    try:
        timestamp = datetime.fromisoformat(released_at[:-1] + "+00:00")
        if timestamp.tzinfo != timezone.utc:
            raise ToolReleaseError("tool_release_invalid")
    except (ValueError, TypeError) as error:
        raise ToolReleaseError("tool_release_invalid") from error

    all_files_root = ALL_FILES_ROOT.resolve(strict=True)
    for receipt in release["review_receipts"]:
        if not isinstance(receipt, dict):
            raise ToolReleaseError("tool_release_invalid")
        raw_path = receipt.get("path")
        digest = receipt.get("sha256")
        if not isinstance(raw_path, str) or not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            raise ToolReleaseError("tool_release_invalid")
        path = Path(raw_path)
        if not path.is_absolute() or ".." in path.parts:
            raise ToolReleaseError("tool_release_invalid")
        if _is_reparse(path):
            raise ToolReleaseError("reparse_point")
        try:
            resolved = path.resolve(strict=True)
            if not resolved.is_file() or not resolved.is_relative_to(all_files_root):
                raise ToolReleaseError("tool_release_invalid")
            if _sha256(resolved.read_bytes()) != digest:
                raise ToolReleaseError("review_receipt_mismatch")
        except OSError as error:
            raise ToolReleaseError("review_receipt_mismatch") from error


def _entries(release, key, expected_files):
    entries = release.get(key)
    if not isinstance(entries, list):
        raise ToolReleaseError("tool_release_invalid")
    indexed = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ToolReleaseError("tool_release_invalid")
        tool_id = entry.get("id")
        if not isinstance(tool_id, str):
            raise ToolReleaseError("tool_release_invalid")
        expected_path = expected_files.get(tool_id)
        if expected_path is None:
            raise ToolReleaseError("unapproved_release_entry")
        if tool_id in indexed:
            raise ToolReleaseError("duplicate_release_entry")
        if entry.get("path") != expected_path:
            raise ToolReleaseError("tool_path_not_approved")
        digest = entry.get("sha256")
        if not isinstance(digest, str) or not SHA256_RE.fullmatch(digest):
            raise ToolReleaseError("tool_release_invalid")
        indexed[tool_id] = (expected_path, digest)
    return indexed


def _read_pinned_source(tool_directory, filename, digest, reason):
    tool_directory = Path(tool_directory).resolve(strict=True)
    path = tool_directory / filename
    if _is_reparse(path):
        raise ToolReleaseError("reparse_point")
    try:
        resolved = path.resolve(strict=True)
        if resolved.parent != tool_directory or not resolved.is_file():
            raise ToolReleaseError("tool_path_not_approved")
        source = resolved.read_bytes()
    except OSError as error:
        raise ToolReleaseError("tool_source_unavailable") from error
    if _sha256(source) != digest:
        raise ToolReleaseError(reason)
    return resolved, source


def _approved_sources(release, tool_id, tool_directory=None, *, profile="r4"):
    if profile == "r3":
        release_schema, profile_id = TOOL_RELEASE_SCHEMA, R3_PROFILE_ID
        tool_files = TOOL_SOURCE_FILES
        support_files = SUPPORT_SOURCE_FILES
    elif profile == "r4":
        release_schema, profile_id = R4_TOOL_RELEASE_SCHEMA, R4_PROFILE_ID
        tool_files = R4_TOOL_SOURCE_FILES
        support_files = R4_SUPPORT_SOURCE_FILES
    else:
        raise ToolReleaseError("tool_profile_not_approved")
    if not isinstance(tool_id, str) or tool_id not in tool_files:
        raise ToolReleaseError("unknown_tool")
    if not isinstance(release, dict) or (
        release.get("schema") != release_schema or release.get("profile_id") != profile_id
    ):
        raise ToolReleaseError("tool_release_invalid")
    if profile == "r4":
        _validate_r4_release_metadata(release)
    tool_directory = Path(tool_directory or Path(__file__).resolve().parent).resolve(strict=True)
    entrypoint_entries = release.get("entrypoint")
    if not isinstance(entrypoint_entries, dict) or entrypoint_entries.get("path") != "tool_entrypoint.py":
        raise ToolReleaseError("entrypoint_not_approved")
    entrypoint_hash = entrypoint_entries.get("sha256")
    if not isinstance(entrypoint_hash, str) or not SHA256_RE.fullmatch(entrypoint_hash):
        raise ToolReleaseError("tool_release_invalid")
    entrypoint_path = (tool_directory / "tool_entrypoint.py").resolve(strict=True)
    if entrypoint_path.parent != tool_directory or entrypoint_path.name != "tool_entrypoint.py":
        raise ToolReleaseError("entrypoint_not_approved")
    _read_pinned_source(tool_directory, "tool_entrypoint.py", entrypoint_hash, "entrypoint_hash_mismatch")
    tools = _entries(release, "tools", tool_files)
    support = _entries(release, "support", support_files)
    if set(tools) != set(tool_files) or set(support) != set(support_files):
        raise ToolReleaseError("tool_release_incomplete")
    if tool_id not in tools:
        raise ToolReleaseError("tool_not_released")

    sources = {}
    for source_id, (filename, digest) in tools.items():
        sources[source_id] = _read_pinned_source(tool_directory, filename, digest, "tool_source_hash_mismatch")
    for source_id, (filename, digest) in support.items():
        sources[source_id] = _read_pinned_source(
            tool_directory, filename, digest, "support_source_hash_mismatch"
        )
    return sources


def select_tool(release, tool_id, tool_directory=None, *, profile="r4"):
    """Resolve and hash-check a named released tool plus the code it imports."""
    sources = _approved_sources(release, tool_id, tool_directory, profile=profile)
    return sources[tool_id]


def _run_sources(tool_id, sources, argv, *, profile="r4"):
    saved_argv = sys.argv
    saved_path = sys.path[:]
    missing = object()
    main_module = SOURCE_ID_BY_MODULE_NAME.get(tool_id, tool_id)
    if profile == "r3":
        import_order = TOOL_IMPORT_ORDER
    elif profile == "r4":
        import_order = R4_TOOL_IMPORT_ORDER
    else:
        raise ToolReleaseError("tool_profile_not_approved")
    module_names = (*import_order[tool_id], main_module)
    saved_modules = {name: sys.modules.get(name, missing) for name in module_names}
    tool_directory = Path(sources[tool_id][0]).parent.resolve()
    cwd = Path.cwd().resolve()
    repository = REPOSITORY.resolve(strict=True)
    blocked = (tool_directory, cwd, repository)
    safe_path = []
    for entry in saved_path:
        if not entry:
            continue
        try:
            resolved = Path(entry).resolve()
        except (OSError, RuntimeError):
            continue
        if any(resolved == root or resolved.is_relative_to(root) for root in blocked):
            continue
        safe_path.append(entry)
    sys.path[:] = safe_path
    try:
        for module_name in import_order[tool_id]:
            source_id = SOURCE_ID_BY_MODULE_NAME.get(module_name, module_name)
            path, source = sources[source_id]
            module = types.ModuleType(module_name)
            module.__file__ = str(path)
            module.__package__ = ""
            sys.modules[module_name] = module
            exec(compile(source, str(path), "exec"), module.__dict__)
        path, source = sources[tool_id]
        sys.argv = [str(path), *argv]
        globals_dict = {"__name__": "__main__", "__file__": str(path), "__package__": None}
        try:
            exec(compile(source, str(path), "exec"), globals_dict)
        except SystemExit as error:
            if error.code is None:
                return 0
            return error.code if isinstance(error.code, int) else 1
        return 0
    finally:
        sys.argv = saved_argv
        sys.path[:] = saved_path
        for name, module in saved_modules.items():
            if module is missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def _same_path(left, right):
    try:
        return Path(left).resolve(strict=True) == Path(right).resolve(strict=True)
    except (OSError, RuntimeError):
        return False


def _bind_policy_option(argv, option, expected, *, path=False):
    protected_options = ("--scope-policy", "--scope-policy-sha", "--approval-sha")
    result = []
    found = False
    index = 0
    while index < len(argv):
        argument = argv[index]
        name = argument.partition("=")[0]
        if name.startswith("--") and name not in protected_options and any(
            protected.startswith(name) for protected in protected_options
        ):
            raise ToolReleaseError("standing_policy_option_abbreviation_forbidden")
        if argument == option:
            if found or index + 1 >= len(argv):
                raise ToolReleaseError("standing_policy_option_invalid")
            value = argv[index + 1]
            index += 2
        elif argument.startswith(option + "="):
            if found:
                raise ToolReleaseError("standing_policy_option_invalid")
            value = argument.partition("=")[2]
            index += 1
        else:
            result.append(argument)
            index += 1
            continue
        matches = _same_path(value, expected) if path else value == expected
        if not matches:
            raise ToolReleaseError("standing_policy_override_forbidden")
        result.extend((option, str(Path(expected).resolve(strict=True)) if path else expected))
        found = True
    if not found:
        result.extend((option, str(Path(expected).resolve(strict=True)) if path else expected))
    return result


def _tool_arguments(tool_id, argv, *, profile="r4"):
    if tool_id == "work_event":
        for arg in argv:
            option = arg.partition("=")[0].replace("_", "-").lower()
            if option == "--source-class":
                raise ToolReleaseError("work_event_source_class_override_forbidden")
    if tool_id == "guard":
        for arg in argv:
            if arg == "--":
                break
            option = arg.partition("=")[0]
            if option.startswith("--") and any(
                protected.startswith(option) for protected in ("--profile", "--assignments")
            ):
                raise ToolReleaseError("guard_profile_override_forbidden")
        if profile not in ("r3", "r4"):
            raise ToolReleaseError("tool_profile_not_approved")
        return ["--profile", profile, *argv]

    if profile != "r4" or tool_id not in ("preflight", "queue", "freeze") or "--help" in argv:
        return list(argv)
    guard = _load_workspace_guard()
    config, reason = guard.load_r4_config()
    if reason or not config:
        raise ToolReleaseError("standing_source_policy_unavailable")
    policy = config["standing_source_policy_document"]
    if policy.get("event_scope") == "product":
        if config.get("product_start_authorized") is not True:
            raise ToolReleaseError("product_start_not_authorized")
    elif policy.get("event_scope") != "preparation":
        raise ToolReleaseError("product_start_not_authorized")
    fixed_path = config["standing_source_policy"]
    fixed_sha256 = config["standing_source_policy_sha256"]
    if tool_id == "queue":
        if not argv or not _same_path(argv[0], fixed_path):
            raise ToolReleaseError("standing_policy_override_forbidden")
        return [
            str(Path(fixed_path).resolve(strict=True)),
            *_bind_policy_option(argv[1:], "--approval-sha", fixed_sha256),
        ]
    argv = _bind_policy_option(argv, "--scope-policy", fixed_path, path=True)
    return _bind_policy_option(argv, "--scope-policy-sha", fixed_sha256)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    profile = "r4"
    if argv and argv[0] == "--profile":
        if len(argv) < 2:
            print(json.dumps({"allowed": False, "reason": "tool_profile_required"}, sort_keys=True), file=sys.stderr)
            return 2
        profile, argv = argv[1], argv[2:]
    elif argv and argv[0].startswith("--profile="):
        profile, argv = argv[0].partition("=")[2], argv[1:]
    if profile != "r4":
        print(
            json.dumps({"allowed": False, "reason": "tool_profile_not_approved"}, sort_keys=True),
            file=sys.stderr,
        )
        return 1
    if not argv:
        print(json.dumps({"allowed": False, "reason": "tool_id_required"}, sort_keys=True), file=sys.stderr)
        return 2
    tool_id, tool_args = argv[0], argv[1:]
    try:
        tool_args = _tool_arguments(tool_id, tool_args, profile=profile)
        release = load_release(profile)
        sources = _approved_sources(release, tool_id, profile=profile)
    except ToolReleaseError as error:
        print(
            json.dumps(
                {
                    "allowed": False,
                    "tool": tool_id,
                    "reason": error.reason,
                    "os_sandbox_enforced": False,
                    "permission_issued": False,
                },
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    return _run_sources(tool_id, sources, tool_args, profile=profile)


if __name__ == "__main__":
    sys.exit(main())
