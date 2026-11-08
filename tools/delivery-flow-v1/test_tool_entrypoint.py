import hashlib
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
import tool_entrypoint


ENTRYPOINT = Path(tool_entrypoint.__file__).resolve()
SCRATCH = Path("E:/codex/yunticket/.test-tmp/jot-permissive-20261021/worker-15/.test-tmp")


def manifest_for(root, tool_id, content):
    tools = []
    for source_id, filename in tool_entrypoint.TOOL_SOURCE_FILES.items():
        source = content if source_id == tool_id else f"# {source_id}\n".encode()
        (root / filename).write_bytes(source)
        tools.append(
            {"id": source_id, "path": filename, "sha256": hashlib.sha256(source).hexdigest()}
        )
    support = []
    for source_id, filename in tool_entrypoint.SUPPORT_SOURCE_FILES.items():
        source = f"# {source_id}\n".encode()
        (root / filename).write_bytes(source)
        support.append(
            {"id": source_id, "path": filename, "sha256": hashlib.sha256(source).hexdigest()}
        )
    return {
        "schema": tool_entrypoint.TOOL_RELEASE_SCHEMA,
        "profile_id": tool_entrypoint.R3_PROFILE_ID,
        "entrypoint": {
            "path": "tool_entrypoint.py",
            "sha256": hashlib.sha256(ENTRYPOINT.read_bytes()).hexdigest(),
        },
        "tools": tools,
        "support": support,
    }


def copy_entrypoint(root):
    path = root / "tool_entrypoint.py"
    path.write_bytes(ENTRYPOINT.read_bytes())
    return path


class ToolEntrypointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        SCRATCH.mkdir(exist_ok=True)

    def test_selects_a_known_tool_only_when_its_pinned_source_matches(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            source = b"# reviewed work event tool\n"
            copy_entrypoint(root)
            release = manifest_for(root, "work_event", source)
            selected, verified_source = tool_entrypoint.select_tool(
                release,
                "work_event",
                tool_directory=root,
            )
            self.assertEqual(selected, (root / "work_event.py").resolve())
            self.assertEqual(verified_source, source)

    def test_rejects_an_unknown_tool_id(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            copy_entrypoint(root)
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint.select_tool(
                    manifest_for(root, "work_event", b"# work event\n"),
                    "shell",
                    tool_directory=root,
                )
            self.assertEqual(error.exception.reason, "unknown_tool")

    def test_rejects_a_noncanonical_source_path(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            copy_entrypoint(root)
            release = manifest_for(root, "preflight", b"# preflight\n")
            next(item for item in release["tools"] if item["id"] == "preflight")["path"] = "other.py"
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint.select_tool(
                    release,
                    "preflight",
                    tool_directory=root,
                )
            self.assertEqual(error.exception.reason, "tool_path_not_approved")

    def test_rejects_a_changed_tool_source_hash(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            copy_entrypoint(root)
            release = manifest_for(root, "metrics", b"# approved metrics\n")
            (root / "metrics.py").write_bytes(b"# altered metrics\n")
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint.select_tool(
                    release,
                    "metrics",
                    tool_directory=root,
                )
            self.assertEqual(error.exception.reason, "tool_source_hash_mismatch")

    def test_release_pins_queue_imports_and_support_modules(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            copy_entrypoint(root)
            release = manifest_for(root, "queue", b"# queue\n")
            sources = tool_entrypoint._approved_sources(release, "queue", tool_directory=root)
            self.assertEqual(
                set(sources),
                set(tool_entrypoint.TOOL_SOURCE_FILES) | set(tool_entrypoint.SUPPORT_SOURCE_FILES),
            )
            (root / "linux_run.py").write_bytes(b"# changed helper\n")
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint.select_tool(release, "queue", tool_directory=root)
            self.assertEqual(error.exception.reason, "support_source_hash_mismatch")

    def test_freeze_and_guard_are_fixed_tools_with_pinned_sources(self):
        for tool_id, filename in (("freeze", "local_freeze.py"), ("guard", "workspace_guard.py")):
            with self.subTest(tool_id=tool_id), tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
                root = Path(temp)
                copy_entrypoint(root)
                source = f"# {tool_id}\n".encode()
                release = manifest_for(root, tool_id, source)
                selected, verified = tool_entrypoint.select_tool(release, tool_id, tool_directory=root)
                self.assertEqual(selected.name, filename)
                self.assertEqual(verified, source)
        self.assertIn("preflight", tool_entrypoint.TOOL_IMPORT_ORDER["freeze"])
        self.assertIn("local_freeze", tool_entrypoint.TOOL_IMPORT_ORDER["preflight"])
        self.assertIn("local_freeze", tool_entrypoint.TOOL_IMPORT_ORDER["queue"])

    def test_guard_entrypoint_always_selects_fixed_r3_profile(self):
        self.assertEqual(
            tool_entrypoint._tool_arguments("guard", ["--worker", "15", "--target", "probe.txt"]),
            ["--profile", "r3", "--worker", "15", "--target", "probe.txt"],
        )
        for args in (("--profile", "r2"), ("--profile=r2",), ("--assignments", "candidate.json")):
            with self.subTest(args=args), self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint._tool_arguments("guard", list(args))
            self.assertEqual(error.exception.reason, "guard_profile_override_forbidden")

    def test_guard_entrypoint_rejects_argparse_abbreviations_for_pinned_options(self):
        for option in ("--profile", "--assignments"):
            for length in range(3, len(option)):
                abbreviation = option[:length]
                for argument in (abbreviation, abbreviation + "=override"):
                    with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                        tool_entrypoint._tool_arguments("guard", [argument, "r2"])
                    self.assertEqual(error.exception.reason, "guard_profile_override_forbidden")

        with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
            tool_entrypoint._tool_arguments(
                "guard", ["--prof", "r2", "--assign", "candidate.json"]
            )
        self.assertEqual(error.exception.reason, "guard_profile_override_forbidden")

    def test_work_event_rejects_source_class_override_and_forwards_r3_task_identity(self):
        arguments = ["--owner", "13", "--task-owner", "15", "--task-id", "M09.05"]
        self.assertEqual(tool_entrypoint._tool_arguments("work_event", arguments), arguments)
        for source_class in (
            ["--source-class", "inherited_wip"],
            ["--source_class", "new_development"],
            ["--source-class=inherited_wip"],
        ):
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint._tool_arguments("work_event", source_class)
            self.assertEqual(error.exception.reason, "work_event_source_class_override_forbidden")

    def test_work_event_help_imports_pinned_metrics_and_restores_caller_module_state(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            work_event = (
                b"import argparse\nimport metrics\n"
                b"assert metrics.IMPORT_CLOSURE_SENTINEL\n"
                b"parser = argparse.ArgumentParser()\n"
                b"parser.add_argument('--task-id', required=True)\n"
                b"parser.add_argument('--state', required=True)\n"
                b"parser.parse_args()\n"
            )
            metrics_source = b"IMPORT_CLOSURE_SENTINEL = True\n"
            copy_entrypoint(root)
            release = manifest_for(root, "work_event", work_event)
            (root / "metrics.py").write_bytes(metrics_source)
            next(item for item in release["tools"] if item["id"] == "metrics")["sha256"] = hashlib.sha256(
                metrics_source
            ).hexdigest()
            sources = tool_entrypoint._approved_sources(release, "work_event", tool_directory=root)

            missing = object()
            previous_metrics = sys.modules.pop("metrics", missing)
            try:
                with redirect_stdout(io.StringIO()):
                    result = tool_entrypoint._run_sources("work_event", sources, ["--help"])
                self.assertEqual(result, 0)
                current_metrics = sys.modules.get("metrics", missing)
                self.assertIs(current_metrics, previous_metrics)
            finally:
                if previous_metrics is missing:
                    sys.modules.pop("metrics", None)
                else:
                    sys.modules["metrics"] = previous_metrics

    def test_freeze_callers_preload_guard_and_restore_caller_module_state(self):
        guard_source = b"IMPORT_CLOSURE_SENTINEL = True\n"
        local_freeze_source = (
            b"def authorize_freeze():\n"
            b"    import workspace_guard\n"
            b"    assert workspace_guard.IMPORT_CLOSURE_SENTINEL\n"
        )
        for tool_id in ("freeze", "preflight", "queue"):
            with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
                root = Path(temp)
                if tool_id == "freeze":
                    main_source = (
                        local_freeze_source
                        + b"import argparse\n"
                        + b"authorize_freeze()\n"
                        + b"argparse.ArgumentParser().parse_args()\n"
                    )
                else:
                    main_source = (
                        b"def main():\n"
                        b"    import argparse\n"
                        b"    import local_freeze\n"
                        b"    local_freeze.authorize_freeze()\n"
                        b"    argparse.ArgumentParser().parse_args()\n"
                        b"if __name__ == '__main__':\n"
                        b"    main()\n"
                    )
                copy_entrypoint(root)
                release = manifest_for(root, tool_id, main_source)
                if tool_id != "freeze":
                    (root / "local_freeze.py").write_bytes(local_freeze_source)
                    next(item for item in release["tools"] if item["id"] == "freeze")["sha256"] = (
                        hashlib.sha256(local_freeze_source).hexdigest()
                    )
                (root / "workspace_guard.py").write_bytes(guard_source)
                next(item for item in release["tools"] if item["id"] == "guard")["sha256"] = (
                    hashlib.sha256(guard_source).hexdigest()
                )
                sources = tool_entrypoint._approved_sources(release, tool_id, tool_directory=root)

                missing = object()
                previous_guard = sys.modules.pop("workspace_guard", missing)
                previous_freeze = sys.modules.pop("local_freeze", missing)
                try:
                    with redirect_stdout(io.StringIO()):
                        result = tool_entrypoint._run_sources(tool_id, sources, ["--help"])
                    self.assertEqual(result, 0)
                    self.assertIs(sys.modules.get("workspace_guard", missing), previous_guard)
                    self.assertIs(sys.modules.get("local_freeze", missing), previous_freeze)
                finally:
                    if previous_guard is missing:
                        sys.modules.pop("workspace_guard", None)
                    else:
                        sys.modules["workspace_guard"] = previous_guard
                    if previous_freeze is missing:
                        sys.modules.pop("local_freeze", None)
                    else:
                        sys.modules["local_freeze"] = previous_freeze

    def test_unlisted_helper_in_caller_cwd_cannot_shadow_a_tool_import(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            copy_entrypoint(root)
            release = manifest_for(root, "queue", b"import unlisted_helper\n")
            shadow = root / "caller-cwd"
            shadow.mkdir()
            (shadow / "unlisted_helper.py").write_text("raise RuntimeError('shadow executed')\n")
            sources = tool_entrypoint._approved_sources(release, "queue", tool_directory=root)
            old_cwd = Path.cwd()
            sys.path.insert(0, str(shadow))
            os.chdir(shadow)
            try:
                with self.assertRaises(ModuleNotFoundError) as error:
                    tool_entrypoint._run_sources("queue", sources, [])
                self.assertEqual(error.exception.name, "unlisted_helper")
            finally:
                os.chdir(old_cwd)
                sys.path.remove(str(shadow))

    def test_missing_r_owned_release_fails_closed(self):
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint._read_release(Path(temp) / "not-published.json")
            self.assertEqual(error.exception.reason, "tool_release_unavailable")

    def test_entrypoint_rejects_an_unpinned_guard_helper(self):
        loaded = tool_entrypoint.workspace_guard
        tool_entrypoint.workspace_guard = None
        try:
            with patch.object(tool_entrypoint, "WORKSPACE_GUARD_SHA256", "0" * 64):
                with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                    tool_entrypoint._load_workspace_guard()
            self.assertEqual(error.exception.reason, "workspace_guard_hash_mismatch")
        finally:
            tool_entrypoint.workspace_guard = loaded


if __name__ == "__main__":
    unittest.main()
