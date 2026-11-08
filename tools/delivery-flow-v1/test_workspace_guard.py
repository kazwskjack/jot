import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


REPOSITORY = Path("E:/codex/yunticket")
ASSIGNMENTS = REPOSITORY / "docs/diagnostics/delivery-flow-v2-20261024/workers.json"
R3_ASSIGNMENTS = REPOSITORY / "docs/diagnostics/delivery-flow-v3-20261025/workers.json"
sys.path.insert(0, str(Path(__file__).resolve().parent))
import workspace_guard


def assigned(worker, assignments=ASSIGNMENTS):
    workers = json.loads(assignments.read_text(encoding="utf-8"))["workers"]
    return next(item for item in workers if item["number"] == worker)


ROOT = Path(assigned(15)["private_workspace"])
SHARED = REPOSITORY / ".test-tmp/jot-permissive-20261021/integration"
SCRATCH = ROOT / ".test-tmp"
GUARD = Path(__file__).with_name("workspace_guard.py")


def invoke(worker, cwd, target, assignments=ASSIGNMENTS):
    return subprocess.run(
        [sys.executable, str(GUARD), "--assignments", str(assignments), "--worker", str(worker), "--target", str(target)],
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )


def invoke_r3(worker, cwd, target, assignments=None):
    command = [sys.executable, str(GUARD), "--profile", "r3"]
    if assignments is not None:
        command.extend(("--assignments", str(assignments)))
    command.extend(("--worker", str(worker), "--target", str(target)))
    return subprocess.run(
        command,
        cwd=cwd,
        text=True,
        capture_output=True,
        check=False,
    )


class WorkspaceGuardTests(unittest.TestCase):
    def decision(self, result):
        self.assertTrue(result.stdout, result.stderr)
        return json.loads(result.stdout)

    def test_allows_a_target_in_the_assigned_private_workspace(self):
        result = invoke(15, ROOT, ROOT / "guard-probe.txt")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.decision(result)["reason"], "private_workspace")

    def test_allows_only_its_own_delivery_receipt_directory(self):
        own_receipt = REPOSITORY / "docs/diagnostics/delivery-flow-v2-20261024/worker-15/receipt.json"
        other_receipt = REPOSITORY / "docs/diagnostics/delivery-flow-v2-20261024/worker-14/receipt.json"
        allowed = invoke(15, ROOT, own_receipt)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(self.decision(allowed)["reason"], "receipt_directory")
        denied = invoke(15, ROOT, other_receipt)
        self.assertEqual(denied.returncode, 1)
        self.assertEqual(self.decision(denied)["reason"], "target_outside_allowed_roots")

    def test_allows_only_its_own_assigned_report_directory(self):
        own_report = Path(assigned(15)["report_directory"]) / "receipt.json"
        other_report = Path(assigned(14)["report_directory"]) / "receipt.json"
        allowed = invoke(15, ROOT, own_report)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(self.decision(allowed)["reason"], "report_directory")
        denied = invoke(15, ROOT, other_report)
        self.assertEqual(denied.returncode, 1)
        self.assertEqual(self.decision(denied)["reason"], "target_outside_allowed_roots")

    def test_allows_worker7_from_its_current_private_workspace(self):
        worker7 = assigned(7)
        cwd = Path(worker7["private_workspace"])
        result = invoke(7, cwd, cwd / "guard-probe.txt")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.decision(result)["reason"], "private_workspace")

    def test_rejects_a_wrong_git_root_even_when_target_is_private(self):
        other_worker_root = Path(assigned(7)["private_workspace"])
        result = invoke(15, other_worker_root, ROOT / "guard-probe.txt")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.decision(result)["reason"], "git_root_mismatch")

    def test_rejects_non13_shared_integration_as_cwd_and_target(self):
        as_cwd = invoke(15, SHARED, SHARED / "blocked.txt")
        self.assertEqual(as_cwd.returncode, 1)
        cwd_decision = self.decision(as_cwd)
        self.assertEqual(cwd_decision["reason"], "shared_integration_cwd_forbidden")
        self.assertEqual(Path(cwd_decision["git_root"]), SHARED.resolve())
        as_target = invoke(15, ROOT, SHARED / "blocked.txt")
        self.assertEqual(as_target.returncode, 1)
        self.assertEqual(self.decision(as_target)["reason"], "target_outside_allowed_roots")

    def test_allows_worker13_shared_target_only_from_worker13_private_root(self):
        worker13 = assigned(13)
        cwd = Path(worker13["private_workspace"])
        result = invoke(13, cwd, SHARED / "probe.txt")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.decision(result)["reason"], "worker13_shared_integration")

    def test_allows_worker13_from_the_shared_git_root(self):
        result = invoke(13, SHARED, SHARED / "probe.txt")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.decision(result)["reason"], "worker13_shared_integration")

    def test_worker14_formal_ledger_exception_is_one_named_file(self):
        worker14 = assigned(14)
        cwd = Path(worker14["private_workspace"])
        ledger = REPOSITORY / "docs/superpowers/plans/pilotdeck-ledger-v2-20261021/ledger.json"
        result = invoke(14, cwd, ledger)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.decision(result)["reason"], "worker14_formal_ledger")
        sibling = ledger.with_name("ledger-copy.json")
        rejected = invoke(14, cwd, sibling)
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(self.decision(rejected)["reason"], "target_outside_allowed_roots")
        other_worker = invoke(15, ROOT, ledger)
        self.assertEqual(other_worker.returncode, 1)
        self.assertEqual(self.decision(other_worker)["reason"], "target_outside_allowed_roots")

    def test_rejects_parent_traversal_outside_private_root(self):
        result = invoke(15, ROOT, ROOT / ".." / "outside-worker-15.txt")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.decision(result)["reason"], "parent_traversal")

    def test_rejects_unknown_worker(self):
        result = invoke(999, ROOT, ROOT / "guard-probe.txt")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.decision(result)["reason"], "unknown_worker")

    def test_rejects_a_changed_assignment_file(self):
        SCRATCH.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            copy = Path(temp) / "workers.json"
            data = json.loads(ASSIGNMENTS.read_text(encoding="utf-8"))
            own_assignment = next(item for item in data["workers"] if item["number"] == 15)
            own_assignment["private_workspace"] += "-changed"
            copy.write_text(json.dumps(data), encoding="utf-8")
            result = invoke(15, ROOT, ROOT / "guard-probe.txt", copy)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(self.decision(result)["reason"], "assignments_changed")

    def test_rejects_reparse_escape_when_symlink_creation_is_available(self):
        SCRATCH.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            link = Path(temp) / "outside-link"
            try:
                os.symlink(SHARED, link, target_is_directory=True)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"this Windows account cannot create a symlink: {error}")
            result = invoke(15, ROOT, link / "blocked.txt")
            self.assertEqual(result.returncode, 1)
            self.assertEqual(self.decision(result)["reason"], "reparse_point")


class R3WorkspaceGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assignments = json.loads(R3_ASSIGNMENTS.read_text(encoding="utf-8"))
        cls.policy = json.loads(
            (REPOSITORY / "docs/diagnostics/delivery-flow-v3-20261025/dispatch-policy.json").read_text(
                encoding="utf-8"
            )
        )

    def r3_assigned(self, worker):
        return next(item for item in self.assignments["workers"] if item["number"] == worker)

    def decision(self, result):
        self.assertTrue(result.stdout, result.stderr)
        return json.loads(result.stdout)

    def test_r3_allows_the_assigned_private_workspace(self):
        private = Path(self.r3_assigned(15)["private_workspace"])
        result = invoke_r3(15, private, private / "guard-probe.txt")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.decision(result)["reason"], "private_workspace")
        report = Path(self.r3_assigned(15)["report_directory"]) / "guard-probe.txt"
        result = invoke_r3(15, private, report)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.decision(result)["reason"], "report_directory")

    def test_r3_denies_another_workers_report_and_wrong_git_root(self):
        private = Path(self.r3_assigned(15)["private_workspace"])
        other_report = Path(self.r3_assigned(14)["report_directory"]) / "blocked.txt"
        result = invoke_r3(15, private, other_report)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.decision(result)["reason"], "target_outside_allowed_roots")
        result = invoke_r3(15, Path(self.r3_assigned(14)["private_workspace"]), private / "blocked.txt")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.decision(result)["reason"], "git_root_mismatch")

    def test_r3_denies_shared_integration_to_worker15(self):
        shared = Path(self.policy["shared_integration"])
        result = invoke_r3(15, Path(self.r3_assigned(15)["private_workspace"]), shared / "blocked.txt")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.decision(result)["reason"], "target_outside_allowed_roots")

    def test_r3_allows_shared_integration_only_to_worker13(self):
        shared = Path(self.policy["shared_integration"])
        private = Path(self.r3_assigned(13)["private_workspace"])
        result = invoke_r3(13, private, shared / "probe.txt")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.decision(result)["reason"], "worker13_shared_integration")

    def test_r3_rejects_candidate_supplied_assignment_path(self):
        private = Path(self.r3_assigned(15)["private_workspace"])
        result = invoke_r3(15, private, private / "blocked.txt", R3_ASSIGNMENTS)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.decision(result)["reason"], "r3_assignment_override_forbidden")

    def test_r3_worker14_formal_ledger_exception_is_exact(self):
        worker14 = Path(self.r3_assigned(14)["private_workspace"])
        ledger = workspace_guard.FORMAL_LEDGER
        allowed = invoke_r3(14, worker14, ledger)
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        self.assertEqual(self.decision(allowed)["reason"], "worker14_formal_ledger")
        rejected = invoke_r3(14, worker14, ledger.with_name("ledger-copy.json"))
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(self.decision(rejected)["reason"], "target_outside_allowed_roots")

    def test_r3_rejects_a_wrong_profile_pin(self):
        with patch.object(workspace_guard, "R3_PROFILE_SHA256", "0" * 64):
            result = workspace_guard.check_r3(15, ROOT / "guard-probe.txt")
        self.assertFalse(result["allowed"])
        self.assertEqual(result["reason"], "profile_changed")

    def test_r3_pin_helper_rejects_wrong_assignment_and_policy_hashes(self):
        for path in (
            R3_ASSIGNMENTS,
            REPOSITORY / "docs/diagnostics/delivery-flow-v3-20261025/dispatch-policy.json",
        ):
            data, error = workspace_guard._read_pinned_json(path, "0" * 64)
            self.assertIsNone(data)
            self.assertEqual(error, "pin_mismatch")

    def test_r3_rejects_parent_traversal(self):
        private = Path(self.r3_assigned(15)["private_workspace"])
        result = invoke_r3(15, private, private / ".." / "outside.txt")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.decision(result)["reason"], "parent_traversal")

    def test_r3_rejects_reparse_escape_when_symlink_creation_is_available(self):
        SCRATCH.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            link = Path(temp) / "outside-link"
            try:
                os.symlink(Path(self.policy["shared_integration"]), link, target_is_directory=True)
            except (OSError, NotImplementedError) as error:
                self.skipTest(f"this Windows account cannot create a symlink: {error}")
            private = Path(self.r3_assigned(15)["private_workspace"])
            result = invoke_r3(15, private, link / "blocked.txt")
            self.assertEqual(result.returncode, 1)
            self.assertEqual(self.decision(result)["reason"], "reparse_point")


if __name__ == "__main__":
    unittest.main()
