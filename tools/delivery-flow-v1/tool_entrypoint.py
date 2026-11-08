#!/usr/bin/env python3
"""Run one R3-released delivery tool by its fixed ID, never by a caller path."""

import hashlib
import json
import os
import re
import stat
import sys
import types
from pathlib import Path


TOOL_RELEASE_SCHEMA = "jot.r3-tools-release.v1"
R3_PROFILE_ID = "jot-parallel-r3-20261025"
REPOSITORY = Path("E:/codex/yunticket")
WORKSPACE_GUARD_SHA256 = "0bfe17268af835b675c9e9a7c9a1b461002a2327160d7bce04b50e0c08936636"
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
    "preflight": ("result_validate", "linux_run", "preflight", "workspace_guard", "local_freeze"),
    "queue": ("result_validate", "linux_run", "preflight", "workspace_guard", "local_freeze"),
    "freeze": ("result_validate", "linux_run", "preflight", "workspace_guard"),
    "work_event": ("metrics",),
    "metrics": (),
    "guard": (),
}
SOURCE_ID_BY_MODULE_NAME = {"local_freeze": "freeze", "workspace_guard": "guard"}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
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


def load_release():
    workspace_guard = _load_workspace_guard()
    config, reason = workspace_guard.load_r3_config()
    if reason:
        raise ToolReleaseError(reason)
    pinned_path = Path(config["tool_release"])
    if _is_reparse(pinned_path):
        raise ToolReleaseError("reparse_point")
    return _read_release(pinned_path)


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


def _approved_sources(release, tool_id, tool_directory=None):
    if not isinstance(tool_id, str) or tool_id not in TOOL_SOURCE_FILES:
        raise ToolReleaseError("unknown_tool")
    if not isinstance(release, dict) or (
        release.get("schema") != TOOL_RELEASE_SCHEMA or release.get("profile_id") != R3_PROFILE_ID
    ):
        raise ToolReleaseError("tool_release_invalid")
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
    tools = _entries(release, "tools", TOOL_SOURCE_FILES)
    support = _entries(release, "support", SUPPORT_SOURCE_FILES)
    if set(tools) != set(TOOL_SOURCE_FILES) or set(support) != set(SUPPORT_SOURCE_FILES):
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


def select_tool(release, tool_id, tool_directory=None):
    """Resolve and hash-check a named released tool plus the code it imports."""
    sources = _approved_sources(release, tool_id, tool_directory)
    return sources[tool_id]


def _run_sources(tool_id, sources, argv):
    saved_argv = sys.argv
    saved_path = sys.path[:]
    missing = object()
    main_module = SOURCE_ID_BY_MODULE_NAME.get(tool_id, tool_id)
    module_names = (*TOOL_IMPORT_ORDER[tool_id], main_module)
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
        for module_name in TOOL_IMPORT_ORDER[tool_id]:
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


def _tool_arguments(tool_id, argv):
    if tool_id == "work_event":
        for arg in argv:
            option = arg.partition("=")[0].replace("_", "-").lower()
            if option == "--source-class":
                raise ToolReleaseError("work_event_source_class_override_forbidden")
    if tool_id != "guard":
        return list(argv)
    for arg in argv:
        if arg == "--":
            break
        option = arg.partition("=")[0]
        if option.startswith("--") and any(
            protected.startswith(option) for protected in ("--profile", "--assignments")
        ):
            raise ToolReleaseError("guard_profile_override_forbidden")
    return ["--profile", "r3", *argv]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(json.dumps({"allowed": False, "reason": "tool_id_required"}, sort_keys=True), file=sys.stderr)
        return 2
    tool_id, tool_args = argv[0], argv[1:]
    try:
        tool_args = _tool_arguments(tool_id, tool_args)
        release = load_release()
        sources = _approved_sources(release, tool_id)
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
    return _run_sources(tool_id, sources, tool_args)


if __name__ == "__main__":
    sys.exit(main())
