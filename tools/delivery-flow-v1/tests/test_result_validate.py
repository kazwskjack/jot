import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

from result_validate import load_schema, main as validate_main, validate_job_result, validate_test_event


ROOT = Path(__file__).resolve().parents[1]
SCHEMA = load_schema(ROOT / "linux-job-result.schema.json")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def map_digest(value):
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


class ResultValidateTests(unittest.TestCase):
    def setUp(self):
        (ROOT / ".test-tmp").mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT / ".test-tmp")
        self.root = Path(self.temp.name)
        self.log = self.root / "run.log"
        self.log.write_text("ℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\n", encoding="utf-8")
        self.archive = self.root / "source.zip"
        test_path = "packages/gateway/test/always-on/snapshot-provider.test.mjs"
        test_bytes = b"test fixture\n"
        lock_bytes = b"lock fixture\n"
        with zipfile.ZipFile(self.archive, "w") as archive:
            archive.writestr(test_path, test_bytes)
            archive.writestr("package-lock.json", lock_bytes)
        self.test_hash = hashlib.sha256(test_bytes).hexdigest()
        self.lock_hash = hashlib.sha256(lock_bytes).hexdigest()
        self.manifest = self.root / "source-manifest.json"
        self.manifest.write_text(json.dumps({
            "commit": "18b20e4ae18b5580ad0f3089683522f1a7400ad7",
            "tree": "f3f4728cb614fcd8a3644eefac04228e31ec068a",
            "archive_sha256": digest(self.archive),
            "files": [
                {"path": test_path, "sha256": self.test_hash},
                {"path": "package-lock.json", "sha256": self.lock_hash},
            ],
        }) + "\n", encoding="utf-8")
        self.packet_manifest = self.root / "owner-packet-manifest.json"
        self.packet_manifest.write_text(json.dumps({
            "base_commit": "d045550e6647f7b2f8b2afa3471609729e5cd9b9",
            "expected_tree": "f3f4728cb614fcd8a3644eefac04228e31ec068a",
            "patch_sha256": "e" * 64,
            "files": [{"path": test_path, "status": "modified"}],
        }) + "\n", encoding="utf-8")
        self.execution_descriptor = {
            "schema_version": 1,
            "source_archive_sha256": digest(self.archive),
            "source_manifest_sha256": digest(self.manifest),
            "packet_context": {
                "manifest_path": "owner-packet/manifest.json",
                "manifest_sha256": digest(self.packet_manifest),
            },
            "git_delta_manifest": {
                "status": "pinned", "path": "owner-packet/manifest.json",
                "sha256": digest(self.packet_manifest),
            },
            "candidate_commit": "18b20e4ae18b5580ad0f3089683522f1a7400ad7",
            "candidate_tree": "f3f4728cb614fcd8a3644eefac04228e31ec068a",
            "tests": {test_path: self.test_hash},
            "locks": {"package-lock.json": self.lock_hash},
            "argv": ["node", "--test", test_path],
            "execution_environment": {
                "execution_root_kind": "remote", "profile": "reviewed-credentialless-isolated-linux-ci",
            },
        }
        self.execution_descriptor_path = self.root / "approved-execution.json"
        self.execution_descriptor_path.write_text(json.dumps(self.execution_descriptor) + "\n", encoding="utf-8")
        self.result_path = self.root / "result.json"
        self.result = {
            "schema_version": 1,
            "job_id": "m14-snapshot-18b-linux",
            "repo": "local/fixture",
            "layer": 1,
            "scope": "M14 snapshot-provider source slice",
            "status": "PASS",
            "failure_classification": "NONE",
            "source": {
                "commit": "18b20e4ae18b5580ad0f3089683522f1a7400ad7",
                "tree": "f3f4728cb614fcd8a3644eefac04228e31ec068a",
                "package_sha256": digest(self.archive),
                "lock_sha256": {"package-lock.json": self.lock_hash},
            },
            "environment": {
                "os": "linux",
                "distro": "Ubuntu 24.04",
                "kernel": "6.8.0",
                "arch": "x64",
                "node": "v24.13.0",
                "node_executable": "/usr/bin/node",
                "node_sha256": "d" * 64,
                "npm": "10.9.2",
                "python": "3.12.3",
                "git": "2.43.0",
                "execution_root": "/tmp/job-123",
                "execution_root_kind": "remote",
            },
            "event_context": {
                "owner": "15",
                "packet_id": "m14-slice-18b",
                "source_class": "inherited_wip",
                "candidate_commit": "18b20e4ae18b5580ad0f3089683522f1a7400ad7",
                "candidate_tree": "f3f4728cb614fcd8a3644eefac04228e31ec068a",
                "manifest_path": "owner-packet/manifest.json",
                "manifest_sha256": digest(self.packet_manifest),
                "dependencies": [],
                "ac_ids": ["M14.03"],
                "next_owner": None,
                "ready_at": None,
            },
            "tests": {test_path: self.test_hash},
            "tests_sha256": map_digest({test_path: self.test_hash}),
            "command": ["/usr/bin/node", "--test", "packages/gateway/test/always-on/snapshot-provider.test.mjs"],
            "started_at_utc": "2026-10-24T10:00:00Z",
            "finished_at_utc": "2026-10-24T10:00:01Z",
            "exit_code": 0,
            "counts": {"tests": 1, "passed": 1, "failed": 0, "skipped": 0, "cancelled": 0, "unparsed": False},
            "artifacts": {
                "run_root": str(self.root),
                "source_archive": "source.zip",
                "source_manifest": "source-manifest.json",
                "source_manifest_sha256": digest(self.manifest),
                "execution_descriptor": "approved-execution.json",
                "execution_descriptor_sha256": digest(self.execution_descriptor_path),
                "raw_log": "run.log",
                "raw_log_sha256": digest(self.log),
                "result_manifest": "result.json",
                "event_draft": "test-event.jsonl",
                "screenshots": [],
                "extra_logs": [],
            },
            "preflight": {
                "authorized_output_root_confirmed": True,
                "source_pins_verified": True,
                "lock_hashes_verified": True,
                "worktree_clean_before": None,
                "worktree_clean_after": None,
                "runtime_integrity_verified": None,
            },
            "cleanup": {
                "status": "COMPLETE", "runner_temp_removed": True,
                "process_group_cleaned": True, "retained_paths": [], "errors": [],
            },
            "windows_status": "DEFERRED_USER",
            "formal_acceptance_credit": "NONE",
        }
        self.result_path.write_text(json.dumps(self.result) + "\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_accepts_valid_linux_result_with_remote_temp_root(self):
        self.result_path.write_text(json.dumps(self.result) + "\n", encoding="utf-8")
        self.assertEqual(validate_job_result(self.result, SCHEMA, self.root), [])

    def test_packet_manifest_identity_is_independent_of_source_archive_manifest(self):
        self.assertNotEqual(
            self.result["event_context"]["manifest_sha256"],
            self.result["artifacts"]["source_manifest_sha256"],
        )
        self.result_path.write_text(json.dumps(self.result) + "\n", encoding="utf-8")
        self.assertEqual(validate_job_result(self.result, SCHEMA, self.root), [])

    def test_execution_descriptor_hash_and_candidate_identity_are_validated(self):
        self.assertEqual(validate_job_result(self.result, SCHEMA, self.root), [])
        invalid = {**self.result, "artifacts": {
            **self.result["artifacts"], "execution_descriptor_sha256": "0" * 64,
        }}
        errors = validate_job_result(invalid, SCHEMA, self.root)
        self.assertTrue(any("execution descriptor SHA-256" in error for error in errors))
        descriptor = {**self.execution_descriptor, "candidate_commit": "0" * 40}
        self.execution_descriptor_path.write_text(json.dumps(descriptor) + "\n", encoding="utf-8")
        forged = {**self.result, "artifacts": {
            **self.result["artifacts"],
            "execution_descriptor_sha256": digest(self.execution_descriptor_path),
        }}
        errors = validate_job_result(forged, SCHEMA, self.root)
        self.assertTrue(any("candidate identity" in error for error in errors))

    def test_pass_with_skips_or_missing_log_evidence_is_rejected(self):
        invalid = {**self.result, "counts": {**self.result["counts"], "skipped": 1}}
        self.assertTrue(validate_job_result(invalid, SCHEMA, self.root))
        bad_artifact = {**self.result, "artifacts": {**self.result["artifacts"], "raw_log_sha256": "0" * 64}}
        self.assertTrue(validate_job_result(bad_artifact, SCHEMA, self.root))
        wrong_package_hash = {**self.result, "source": {**self.result["source"], "package_sha256": digest(self.manifest)}}
        self.assertTrue(validate_job_result(wrong_package_hash, SCHEMA, self.root))

    def test_manifest_cannot_claim_file_hashes_absent_from_source_archive(self):
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        test_path = next(iter(self.result["tests"]))
        next(item for item in manifest["files"] if item["path"] == test_path)["sha256"] = "f" * 64
        self.manifest.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
        pins = {test_path: "f" * 64}
        result = {
            **self.result,
            "tests": pins,
            "tests_sha256": map_digest(pins),
            "artifacts": {**self.result["artifacts"], "source_manifest_sha256": digest(self.manifest)},
        }
        self.result_path.write_text(json.dumps(result) + "\n", encoding="utf-8")
        self.assertTrue(validate_job_result(result, SCHEMA, self.root))

    def test_blocked_and_cancelled_results_retain_without_test_event_artifact(self):
        for status, classification, exit_code in (
            ("BLOCKED", "INFRA_BLOCKED", None),
            ("CANCELLED", "NOT_APPLICABLE", -15),
        ):
            with self.subTest(status=status):
                result = {
                    **self.result,
                    "status": status,
                    "failure_classification": classification,
                    "exit_code": exit_code,
                    "counts": {"tests": None, "passed": None, "failed": None, "skipped": None, "cancelled": None, "unparsed": True},
                    "artifacts": {**self.result["artifacts"], "event_draft": None},
                    "cleanup": {
                        **self.result["cleanup"],
                        "process_group_cleaned": None if exit_code is None else True,
                    },
                }
                self.result_path.write_text(json.dumps(result) + "\n", encoding="utf-8")
                self.assertEqual(validate_job_result(result, SCHEMA, self.root), [])
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(validate_main([str(self.result_path)]), 0)

    def test_cancelled_started_execution_requires_confirmed_group_cleanup(self):
        result = {
            **self.result,
            "status": "CANCELLED",
            "failure_classification": "NOT_APPLICABLE",
            "exit_code": -15,
            "counts": {"tests": None, "passed": None, "failed": None, "skipped": None, "cancelled": None, "unparsed": True},
            "artifacts": {**self.result["artifacts"], "event_draft": None},
            "cleanup": {**self.result["cleanup"], "process_group_cleaned": False},
        }
        self.result_path.write_text(json.dumps(result) + "\n", encoding="utf-8")
        errors = validate_job_result(result, SCHEMA, self.root)
        self.assertTrue(any("process-group cleanup" in error for error in errors), errors)

    def test_prestart_cancel_and_blocked_results_mark_cleanup_not_applicable(self):
        for status, classification in (
            ("CANCELLED", "NOT_APPLICABLE"),
            ("BLOCKED", "INFRA_BLOCKED"),
        ):
            with self.subTest(status=status):
                result = {
                    **self.result,
                    "status": status,
                    "failure_classification": classification,
                    "exit_code": None,
                    "counts": {"tests": None, "passed": None, "failed": None, "skipped": None, "cancelled": None, "unparsed": True},
                    "artifacts": {**self.result["artifacts"], "event_draft": None},
                    "cleanup": {
                        **self.result["cleanup"],
                        "status": "PRESERVED_FOR_DIAGNOSTICS",
                        "process_group_cleaned": None,
                    },
                }
                self.result_path.write_text(json.dumps(result) + "\n", encoding="utf-8")
                self.assertEqual(validate_job_result(result, SCHEMA, self.root), [])

    def test_windows_is_a_disposition_and_formal_credit_stays_none(self):
        invalid = {**self.result, "windows_status": "PASS"}
        self.assertTrue(validate_job_result(invalid, SCHEMA, self.root))
        invalid = {**self.result, "formal_acceptance_credit": "E"}
        self.assertTrue(validate_job_result(invalid, SCHEMA, self.root))

    def test_test_event_requires_canonical_identity_and_hash_matched_evidence(self):
        self.result_path.write_text(json.dumps(self.result) + "\n", encoding="utf-8")
        event = {
            "schema_version": 1,
            "event_id": "52a4e074-3415-4d84-b142-fb26e51a9c33",
            "event_type": "test",
            "occurred_at": "2026-10-24T10:00:01Z",
            "repo": self.result["repo"],
            "tests_sha256": self.result["tests_sha256"],
            **self.result["event_context"],
            "evidence": {
                "kind": "test_result",
                "path": "result.json",
                "sha256": digest(self.result_path),
                "job_id": self.result["job_id"],
                "exit_code": 0,
                "result": "passed",
            },
        }
        self.assertEqual(validate_test_event(event, self.result, self.root), [])
        event_path = self.root / "test-event.jsonl"
        event_path.write_text(json.dumps(event) + "\n", encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            self.assertEqual(validate_main([str(self.result_path)]), 0)
        event["occurred_at"] = "not-rfc3339"
        self.assertTrue(validate_test_event(event, self.result, self.root))
        event["occurred_at"] = "2026-10-24T10:00:01Z"
        event["evidence"]["result"] = "passed"
        event["evidence"]["exit_code"] = 1
        self.assertTrue(validate_test_event(event, self.result, self.root))
        failed = {**self.result, "status": "FAIL", "failure_classification": "SOFTWARE_DEVELOPMENT_INCOMPLETE", "exit_code": 0}
        self.result_path.write_text(json.dumps(failed) + "\n", encoding="utf-8")
        event["evidence"]["sha256"] = digest(self.result_path)
        event["evidence"]["result"] = "failed"
        event["evidence"]["exit_code"] = 0
        self.assertTrue(validate_test_event(event, failed, self.root))

    def test_accepted_event_cannot_be_emitted_by_linux_runner(self):
        event = {"schema_version": 1, "event_id": "52a4e074-3415-4d84-b142-fb26e51a9c33", "event_type": "accepted"}
        self.assertTrue(validate_test_event(event, self.result, self.root))


if __name__ == "__main__":
    unittest.main()
