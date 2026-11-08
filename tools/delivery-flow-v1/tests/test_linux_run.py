import argparse
import hashlib
import io
import inspect
import json
import os
import signal
import shutil
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import Mock, patch

from linux_run import (
    _node_meets,
    _safe_environment,
    classify_result,
    ensure_disjoint_inputs,
    main,
    parse_node_test_summary,
    run,
    validate_command_tests,
    verify_and_extract_source,
)


ROOT = Path(__file__).resolve().parents[1]


def make_m14_approval(root):
    fixture = ROOT / "fixtures" / "m14-18b"
    source = fixture / "tracked-source-18b.zip"
    manifest_path = fixture / "source-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    test_path = manifest["test_entry"]
    tests = {test_path: next(item["sha256"] for item in manifest["files"] if item["path"] == test_path)}
    locks = {item["path"]: item["sha256"] for item in manifest["files"] if item["path"].endswith("lock.json")}
    context_path = "tools/delivery-flow-v1/fixtures/m14-18b/source-manifest.json"
    context_sha = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    command = ["node", "--test", test_path]
    descriptor = {
        "schema_version": 1,
        "source_archive_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "source_manifest_sha256": context_sha,
        "packet_context": {"manifest_path": context_path, "manifest_sha256": context_sha},
        "git_delta_manifest": {"status": "not_applicable"},
        "candidate_commit": manifest["commit"],
        "candidate_tree": manifest["tree"],
        "tests": tests,
        "locks": locks,
        "argv": command,
        "execution_environment": {
            "execution_root_kind": "remote",
            "profile": "reviewed-credentialless-isolated-linux-ci",
        },
    }
    path = root / "approved-execution.json"
    path.write_text(json.dumps(descriptor, sort_keys=True) + "\n", encoding="utf-8")
    return fixture, path, descriptor, tests, locks, context_path, context_sha


def make_m14_runner_args(root):
    fixture, approval_path, descriptor, tests, locks, context_path, context_sha = make_m14_approval(root)
    manifest_path = fixture / "source-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    node = root / "node"
    node.write_bytes(b"test node executable")
    args = argparse.Namespace(
        source=fixture / "tracked-source-18b.zip", manifest=manifest_path,
        manifest_path=context_path, manifest_sha256=context_sha,
        candidate_commit=manifest["commit"], candidate_tree=manifest["tree"],
        workdir=root / "work", outdir=root / "out", authorized_root=root,
        execution_root_kind="remote", job_id="m14-test", repo="local/fixture",
        owner="15", packet_id="m14-slice-18b", source_class="inherited_wip",
        scope="M14 source slice", layer=1,
        test_pin=[f"{path}={digest}" for path, digest in tests.items()],
        lock_pin=[f"{path}={digest}" for path, digest in locks.items()],
        dependency=[], ac_id=[], next_owner=None, ready_at=None,
        timeout=5, expected_node=None, approved_execution=approval_path,
        approved_execution_sha256=hashlib.sha256(approval_path.read_bytes()).hexdigest(),
    )
    return args, node, next(iter(tests))


class LinuxRunTests(unittest.TestCase):
    def test_parses_node_test_summary(self):
        text = """
ℹ tests 7
ℹ pass 6
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
"""
        self.assertEqual(
            parse_node_test_summary(text),
            {"tests": 7, "passed": 6, "failed": 0, "cancelled": 0, "skipped": 1},
        )

    def test_only_a_complete_nonempty_summary_can_pass(self):
        passed = {"tests": 2, "passed": 2, "failed": 0, "cancelled": 0, "skipped": 0}
        self.assertEqual(classify_result(0, passed), ("PASS", "NONE"))
        self.assertEqual(
            classify_result(0, {**passed, "skipped": 1}),
            ("BLOCKED", "INFRA_BLOCKED"),
        )
        self.assertEqual(
            classify_result(0, None),
            ("BLOCKED", "INFRA_BLOCKED"),
        )
        self.assertEqual(
            classify_result(7, passed),
            ("FAIL", "SOFTWARE_DEVELOPMENT_INCOMPLETE"),
        )

    def test_timeout_and_explicit_cancel_never_pass(self):
        passed = {"tests": 1, "passed": 1, "failed": 0, "cancelled": 0, "skipped": 0}
        self.assertEqual(classify_result(None, passed, timed_out=True), ("CANCELLED", "NOT_APPLICABLE"))
        self.assertEqual(classify_result(None, None, cancelled=True), ("CANCELLED", "NOT_APPLICABLE"))

    def test_command_must_name_every_pinned_test_path(self):
        pins = {"packages/gateway/test/always-on/snapshot-provider.test.mjs": "a" * 64}
        self.assertIsNone(validate_command_tests(["node", "--test", *pins], pins))
        invalid = (
            ["npm", "test", *pins],
            ["python", "-c", "print('ℹ tests 1')", *pins],
            ["echo", "ℹ tests 1", *pins],
            ["node", "-e", "console.log('ℹ tests 1')", *pins],
            ["node", "--test", *pins, "extra.test.mjs"],
        )
        for command in invalid:
            with self.subTest(command=command), self.assertRaises(ValueError):
                validate_command_tests(command, pins)

    def test_output_roots_must_be_disjoint_from_immutable_source_package(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            package = root / "package"
            package.mkdir()
            archive = package / "source.zip"
            manifest = package / "manifest.json"
            archive.write_bytes(b"archive")
            manifest.write_text("{}", encoding="utf-8")
            ensure_disjoint_inputs(archive, manifest, root / "runs" / "work", root / "runs" / "out")
            with self.assertRaises(ValueError):
                ensure_disjoint_inputs(archive, manifest, package / "runs" / "work", package / "runs" / "out")

    def test_non_linux_is_rejected_before_child_start(self):
        from linux_run import is_linux_runtime

        self.assertTrue(is_linux_runtime("linux"))
        self.assertFalse(is_linux_runtime("win32"))
        self.assertFalse(is_linux_runtime("darwin"))

    def test_non_linux_entrypoint_never_starts_a_child(self):
        with patch("linux_run.sys.platform", "win32"), patch("linux_run.subprocess.Popen") as spawn:
            with redirect_stderr(io.StringIO()):
                self.assertEqual(main([]), 2)
            spawn.assert_not_called()

    def test_runner_rejects_missing_operator_descriptor_before_extraction_or_child_start(self):
        fixture = ROOT / "fixtures" / "synthetic-node-d060882ad1eb"
        packet = json.loads((fixture / "packet.json").read_text(encoding="utf-8"))
        test, test_pin = next(iter(packet["tests"].items()))
        lock_pins = [f"{path}={digest}" for path, digest in packet["lock_hashes"].items()]
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            root = Path(temp)
            args = argparse.Namespace(
                source=fixture / "source.zip", manifest=fixture / "source-manifest.json",
                manifest_path=packet["manifest_path"], manifest_sha256=packet["manifest_sha256"],
                candidate_commit=packet["candidate_commit"], candidate_tree=packet["tree"],
                workdir=root / "work", outdir=root / "out", authorized_root=root,
                execution_root_kind="remote", job_id="m14-test", repo="local/fixture",
                owner="15", packet_id="m14-slice-18b", source_class="inherited_wip",
                scope="M14 source slice", layer=1, test_pin=[f"{test}={test_pin}"],
                lock_pin=lock_pins, dependency=[], ac_id=[], next_owner=None,
                ready_at=None, timeout=5, expected_node=None,
                approved_execution=None, approved_execution_sha256=None,
            )
            with patch("linux_run.is_linux_runtime", return_value=True), \
                    patch("linux_run.verify_and_extract_source", side_effect=AssertionError("extraction started")) as extract, \
                    patch("linux_run.subprocess.Popen") as spawn:
                with self.assertRaisesRegex(ValueError, "approved execution descriptor"):
                    run(args, ["node", "--test", test])
                bad_descriptor = root / "candidate-self-approval.json"
                bad_descriptor.write_text('{"review":"self-declared"}\n', encoding="utf-8")
                args.approved_execution = bad_descriptor
                args.approved_execution_sha256 = "0" * 64
                with self.assertRaisesRegex(ValueError, "independent pin"):
                    run(args, ["node", "--test", test])
            extract.assert_not_called()
            spawn.assert_not_called()

    def test_fixed_descriptor_binds_m14_inputs_without_inventing_git_delta(self):
        from linux_run import verify_execution_descriptor

        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            fixture, path, descriptor, tests, locks, context_path, context_sha = make_m14_approval(Path(temp))
            source = fixture / "tracked-source-18b.zip"
            manifest_path = fixture / "source-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            command = descriptor["argv"]
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            verified = verify_execution_descriptor(
                path, digest, source, manifest_path, context_path, context_sha,
                manifest["commit"], manifest["tree"], tests, locks, command, "remote",
            )
            self.assertEqual(verified["sha256"], digest)
            self.assertEqual(verified["document"]["git_delta_manifest"], {"status": "not_applicable"})
            mutations = (
                ("source_archive_sha256", "0" * 64, "source archive pin"),
                ("source_manifest_sha256", "0" * 64, "full source manifest pin"),
                ("packet_context", {"manifest_path": context_path, "manifest_sha256": "0" * 64}, "packet manifest context"),
                ("candidate_commit", "0" * 40, "candidate commit"),
                ("candidate_tree", "0" * 40, "candidate tree"),
                ("tests", {**tests, "other.mjs": "0" * 64}, "test pins"),
                ("locks", {"package-lock.json": "0" * 64}, "lock pins"),
                ("argv", ["node", "--test", "different.test.mjs"], "argv"),
                ("git_delta_manifest", {
                    "status": "pinned", "path": "bundle/manifest.json", "sha256": "bfe83fb00c23998bd0d08f8add76e0c3e4a3fd3189eb01581e9c999a417a6661",
                }, "Git-delta identity"),
                ("execution_environment", {"execution_root_kind": "local", "profile": "test"}, "fixed remote Linux environment"),
            )
            for key, value, message in mutations:
                with self.subTest(key=key):
                    changed = {**descriptor, key: value}
                    path.write_text(json.dumps(changed, sort_keys=True) + "\n", encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, message):
                        verify_execution_descriptor(
                            path, hashlib.sha256(path.read_bytes()).hexdigest(), source, manifest_path,
                            context_path, context_sha, manifest["commit"], manifest["tree"],
                            tests, locks, command, "remote",
                        )
            path.write_text(json.dumps(descriptor, sort_keys=True) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "fixed remote Linux environment"):
                verify_execution_descriptor(
                    path, hashlib.sha256(path.read_bytes()).hexdigest(), source, manifest_path,
                    context_path, context_sha, manifest["commit"], manifest["tree"],
                    tests, locks, command, "local",
                )

    def test_prestart_node_blocked_result_does_not_claim_group_cleanup(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            root = Path(temp)
            args, _node, test_path = make_m14_runner_args(root)
            with patch("linux_run.is_linux_runtime", return_value=True), \
                    patch("linux_run._resolve_node_executable", return_value=None), \
                    patch("linux_run._version", return_value="v24.13.0"), \
                    patch("linux_run.subprocess.Popen") as spawn:
                self.assertEqual(run(args, ["node", "--test", test_path]), 1)
            self.assertFalse(any(call.kwargs.get("start_new_session") for call in spawn.call_args_list))
            result = json.loads((root / "out" / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "BLOCKED")
            self.assertIsNone(result["exit_code"])
            self.assertIsNone(result["cleanup"]["process_group_cleaned"])

    def test_normal_exit_invokes_process_group_cleanup_before_writing_receipt(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            root = Path(temp)
            args, node, test_path = make_m14_runner_args(root)
            process = Mock(returncode=0)
            process.wait.return_value = 0
            with patch("linux_run.is_linux_runtime", return_value=True), \
                    patch("linux_run._resolve_node_executable", return_value=node), \
                    patch("linux_run._version", return_value="v24.13.0"), \
                    patch("linux_run._distro_name", return_value="Ubuntu test"), \
                    patch("linux_run.platform.release", return_value="test-kernel"), \
                    patch("linux_run.platform.machine", return_value="x86_64"), \
                    patch("linux_run.platform.python_version", return_value="3.11.2"), \
                    patch("linux_run.subprocess.Popen", return_value=process) as spawn, \
                    patch("linux_run._terminate_group", return_value=True) as terminate:
                self.assertEqual(run(args, ["node", "--test", test_path]), 1)
            spawn.assert_called_once()
            terminate.assert_called_once_with(process)
            result = json.loads((root / "out" / "result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "BLOCKED")
            self.assertEqual(result["artifacts"]["execution_descriptor_sha256"], args.approved_execution_sha256)
            self.assertTrue(result["cleanup"]["process_group_cleaned"])

    def test_sigterm_uses_cancellation_cleanup_and_restores_previous_handler(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            root = Path(temp)
            args, node, test_path = make_m14_runner_args(root)
            previous = signal.getsignal(signal.SIGTERM)

            def prior_handler(_signum, _frame):
                return None

            signal.signal(signal.SIGTERM, prior_handler)
            process = Mock(pid=9876, returncode=None)

            def request_sigterm(timeout=None):
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                process.returncode = 0
                return 0

            process.wait.side_effect = request_sigterm

            def terminate(child):
                child.returncode = -signal.SIGTERM
                return True

            try:
                with patch("linux_run.is_linux_runtime", return_value=True), \
                        patch("linux_run._resolve_node_executable", return_value=node), \
                        patch("linux_run._version", return_value="v24.13.0"), \
                        patch("linux_run._distro_name", return_value="Ubuntu test"), \
                        patch("linux_run.platform.release", return_value="test-kernel"), \
                        patch("linux_run.platform.machine", return_value="x86_64"), \
                        patch("linux_run.platform.python_version", return_value="3.11.2"), \
                        patch("linux_run.subprocess.Popen", return_value=process) as spawn, \
                        patch("linux_run._terminate_group", side_effect=terminate) as terminate_group:
                    self.assertEqual(run(args, ["node", "--test", test_path]), 1)
                self.assertIs(signal.getsignal(signal.SIGTERM), prior_handler)
                spawn.assert_called_once()
                self.assertLessEqual(process.wait.call_args.kwargs["timeout"], 0.1)
                terminate_group.assert_called_once_with(process)
                result = json.loads((root / "out" / "result.json").read_text(encoding="utf-8"))
                self.assertEqual(result["status"], "CANCELLED")
                self.assertEqual(result["exit_code"], -signal.SIGTERM)
                self.assertTrue(result["cleanup"]["process_group_cleaned"])
                self.assertIsNone(result["artifacts"]["event_draft"])
                self.assertFalse((root / "out" / "test-event.jsonl").exists())
            finally:
                signal.signal(signal.SIGTERM, previous)

    def test_sigterm_during_cleanup_entry_does_not_skip_cleanup(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            root = Path(temp)
            args, node, test_path = make_m14_runner_args(root)
            previous = signal.getsignal(signal.SIGTERM)

            def prior_handler(_signum, _frame):
                return None

            signal.signal(signal.SIGTERM, prior_handler)
            process = Mock(pid=9876, returncode=0)
            source, first_line = inspect.getsourcelines(run)
            target_line = next(
                first_line + offset
                for offset, line in enumerate(source)
                if line.strip() == "cleanup_started = True"
            ) if any(line.strip() == "cleanup_started = True" for line in source) else next(
                first_line + offset
                for offset, line in enumerate(source)
                if "group_cleaned = _terminate_group(process)" in line
            )
            injected = []

            def inject_at_cleanup(frame, event, _arg):
                if frame.f_code is run.__code__ and event == "line" and frame.f_lineno == target_line and not injected:
                    if frame.f_locals.get("process") is not None:
                        injected.append(True)
                        signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                return inject_at_cleanup

            def terminate(child):
                signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
                child.returncode = -signal.SIGTERM
                return True

            original_trace = sys.gettrace()
            try:
                with patch("linux_run.is_linux_runtime", return_value=True), \
                        patch("linux_run._resolve_node_executable", return_value=node), \
                        patch("linux_run._version", return_value="v24.13.0"), \
                        patch("linux_run._distro_name", return_value="Ubuntu test"), \
                        patch("linux_run.platform.release", return_value="test-kernel"), \
                        patch("linux_run.platform.machine", return_value="x86_64"), \
                        patch("linux_run.platform.python_version", return_value="3.11.2"), \
                        patch("linux_run.subprocess.Popen", return_value=process) as spawn, \
                        patch("linux_run._terminate_group", side_effect=terminate) as terminate_group:
                    sys.settrace(inject_at_cleanup)
                    try:
                        self.assertEqual(run(args, ["node", "--test", test_path]), 1)
                    finally:
                        sys.settrace(original_trace)
                self.assertEqual(injected, [True])
                self.assertIs(signal.getsignal(signal.SIGTERM), prior_handler)
                spawn.assert_called_once()
                terminate_group.assert_called_once_with(process)
                result = json.loads((root / "out" / "result.json").read_text(encoding="utf-8"))
                self.assertEqual(result["status"], "CANCELLED")
                self.assertEqual(result["exit_code"], -signal.SIGTERM)
                self.assertTrue(result["cleanup"]["process_group_cleaned"])
                self.assertIsNone(result["artifacts"]["event_draft"])
                self.assertFalse((root / "out" / "test-event.jsonl").exists())
            finally:
                sys.settrace(original_trace)
                signal.signal(signal.SIGTERM, previous)

    def test_unconfirmed_cleanup_does_not_freeze_a_result(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            root = Path(temp)
            args, node, test_path = make_m14_runner_args(root)
            process = Mock(returncode=0)
            process.wait.return_value = 0
            with patch("linux_run.is_linux_runtime", return_value=True), \
                    patch("linux_run._resolve_node_executable", return_value=node), \
                    patch("linux_run._version", return_value="v24.13.0"), \
                    patch("linux_run._distro_name", return_value="Ubuntu test"), \
                    patch("linux_run.platform.release", return_value="test-kernel"), \
                    patch("linux_run.platform.machine", return_value="x86_64"), \
                    patch("linux_run.platform.python_version", return_value="3.11.2"), \
                    patch("linux_run.subprocess.Popen", return_value=process), \
                    patch("linux_run._terminate_group", return_value=False):
                with self.assertRaisesRegex(RuntimeError, "process group cleanup could not be confirmed"):
                    run(args, ["node", "--test", test_path])
            self.assertFalse((root / "out" / "result.json").exists())

    def test_process_group_cleanup_waits_for_descendants_after_leader_exit(self):
        from linux_run import _terminate_group

        process = Mock(pid=1234, returncode=0)
        with patch("linux_run.os.killpg", create=True) as killpg, \
                patch("linux_run._group_exists", side_effect=[True, False]):
            self.assertTrue(_terminate_group(process, grace=1))
        killpg.assert_called_once_with(process.pid, __import__("signal").SIGTERM)
        process.wait.assert_called_once_with(timeout=1)

    def test_unconfirmed_process_group_cleanup_returns_failure_after_sigkill(self):
        from linux_run import _terminate_group

        process = Mock(pid=4321, returncode=0)
        with patch("linux_run.os.killpg", create=True) as killpg, \
                patch("linux_run.signal.SIGKILL", -9, create=True), \
                patch("linux_run._group_exists", return_value=True):
            self.assertFalse(_terminate_group(process, grace=0))
        self.assertEqual(killpg.call_args_list, [
            ((process.pid, __import__("signal").SIGTERM),),
            ((process.pid, -9),),
        ])

    def test_manifest_node_minimum_is_enforced(self):
        self.assertTrue(_node_meets({"node": ">=24"}, "v24.13.0"))
        self.assertFalse(_node_meets({"node": ">=24"}, "v22.14.0"))

    def test_child_environment_excludes_unapproved_variables(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            with patch.dict(os.environ, {"PATH": "safe-path", "SECRET_TOKEN": "do-not-pass"}, clear=True):
                environment, temp_root = _safe_environment(Path(temp))
            self.assertEqual(environment["PATH"], "safe-path")
            self.assertNotIn("SECRET_TOKEN", environment)
            shutil.rmtree(temp_root)

    def test_source_archive_is_extracted_only_after_manifest_and_test_pins_match(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive_path = root / "source.zip"
            content = b"fixture\n"
            lock = b"lock\n"
            test_path = "test/example.test.mjs"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(test_path, content)
                archive.writestr("package-lock.json", lock)
            sha = lambda data: hashlib.sha256(data).hexdigest()
            manifest = {
                "commit": "1" * 40,
                "tree": "2" * 40,
                "archive_sha256": sha(archive_path.read_bytes()),
                "files": [
                    {"path": test_path, "sha256": sha(content)},
                    {"path": "package-lock.json", "sha256": sha(lock)},
                ],
            }
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            workdir = root / "work"
            info = verify_and_extract_source(archive_path, manifest_path, workdir, {test_path: sha(content)})
            self.assertEqual((workdir / test_path).read_bytes(), content)
            self.assertEqual(info["lock_sha256"], {"package-lock.json": sha(lock)})

    def test_source_archive_rejects_path_traversal_before_creating_workdir(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive_path = root / "source.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("../escape", b"outside")
            manifest = {
                "commit": "1" * 40,
                "tree": "2" * 40,
                "archive_sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
                "files": [{"path": "../escape", "sha256": hashlib.sha256(b"outside").hexdigest()}],
            }
            manifest_path = root / "manifest.json"
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            workdir = root / "work"
            with self.assertRaises(ValueError):
                verify_and_extract_source(archive_path, manifest_path, workdir, {"../escape": "0" * 64})
            self.assertFalse(workdir.exists())

    def test_retained_m14_fixture_matches_its_manifest(self):
        fixture = ROOT / "fixtures" / "m14-18b"
        manifest_path = fixture / "source-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        test = {manifest["test_entry"]: next(item["sha256"] for item in manifest["files"] if item["path"] == manifest["test_entry"])}
        lock_pins = {item["path"]: item["sha256"] for item in manifest["files"] if item["path"].endswith("lock.json")}
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            info = verify_and_extract_source(
                fixture / "tracked-source-18b.zip", manifest_path, Path(temp) / "work", test,
                expected_source_manifest_sha256=hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                expected_commit=manifest["commit"], expected_tree=manifest["tree"], lock_pins=lock_pins,
            )
        self.assertEqual(info["commit"], "18b20e4ae18b5580ad0f3089683522f1a7400ad7")
        self.assertEqual(len(info["lock_sha256"]), 3)

    def test_same_candidate_packet_and_full_archive_manifests_stay_distinct(self):
        fixture = ROOT / "fixtures" / "synthetic-node-d060882ad1eb"
        packet = json.loads((fixture / "packet.json").read_text(encoding="utf-8"))
        packet_manifest_path = fixture / packet["manifest_path"]
        packet_manifest = json.loads(packet_manifest_path.read_text(encoding="utf-8"))
        source_manifest_path = fixture / "source-manifest.json"
        source_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(hashlib.sha256(packet_manifest_path.read_bytes()).hexdigest(), packet["manifest_sha256"])
        self.assertNotEqual(packet["manifest_sha256"], hashlib.sha256(source_manifest_path.read_bytes()).hexdigest())
        self.assertEqual({entry["path"] for entry in packet_manifest["files"]}, {"tools/delivery-flow-v1/synthetic.txt"})
        self.assertEqual({entry["path"] for entry in source_manifest["files"]}, {"test.mjs", "toolchain.lock", "tools/delivery-flow-v1/synthetic.txt"})
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            info = verify_and_extract_source(
                fixture / "source.zip", source_manifest_path, Path(temp) / "work", packet["tests"],
                expected_commit=packet["candidate_commit"], expected_tree=packet["tree"],
                lock_pins=packet["lock_hashes"],
            )
        self.assertEqual(info["commit"], packet["candidate_commit"])
        self.assertEqual(info["tree"], packet["tree"])
        self.assertEqual(info["archive_sha256"], hashlib.sha256((fixture / "source.zip").read_bytes()).hexdigest())
        self.assertEqual(info["source_manifest_sha256"], hashlib.sha256(source_manifest_path.read_bytes()).hexdigest())
        self.assertEqual(info["lock_sha256"], packet["lock_hashes"])

    def test_archive_manifest_hash_and_lock_pins_are_checked_before_extraction(self):
        fixture = ROOT / "fixtures" / "m14-18b"
        manifest_path = fixture / "source-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        pins = {manifest["test_entry"]: next(item["sha256"] for item in manifest["files"] if item["path"] == manifest["test_entry"])}
        with tempfile.TemporaryDirectory(dir=ROOT) as temp:
            workdir = Path(temp) / "wrong-manifest"
            with self.assertRaises(ValueError):
                verify_and_extract_source(
                    fixture / "tracked-source-18b.zip", manifest_path, workdir, pins,
                    expected_source_manifest_sha256="0" * 64,
                    expected_commit=manifest["commit"], expected_tree=manifest["tree"], lock_pins={},
                )
            self.assertFalse(workdir.exists())
            mismatch = Path(temp) / "wrong-locks"
            with self.assertRaises(ValueError):
                verify_and_extract_source(
                    fixture / "tracked-source-18b.zip", manifest_path, mismatch, pins,
                    expected_source_manifest_sha256=hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                    expected_commit=manifest["commit"], expected_tree=manifest["tree"], lock_pins={},
                )
            self.assertFalse(mismatch.exists())


if __name__ == "__main__":
    unittest.main()
