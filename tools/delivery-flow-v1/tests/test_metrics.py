import hashlib
import io
import json
import sys
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import metrics
from metrics import (
    main,
    summarize_event_files,
    validate_trial_record,
)


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.tool_root = Path(__file__).resolve().parents[1]
        self.scratch = self.tool_root / "test-tmp"
        self.scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=self.scratch)
        self.root = Path(self.temp.name)
        self.events_dir = self.root / "events"
        self.events_dir.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def write_evidence(self, relative_path, content):
        path = self.root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        data = content if isinstance(content, bytes) else content.encode("utf-8")
        path.write_bytes(data)
        return {"path": relative_path, "sha256": hashlib.sha256(data).hexdigest()}

    def event(self, event_id, event_type, at, **extra):
        return {
            "schema_version": 1,
            "event_id": event_id,
            "event_type": event_type,
            "occurred_at": at,
            "owner": "20",
            "packet_id": "p-1",
            "source_class": "new_development",
            **extra,
        }

    def write_events(self, name, events):
        path = self.events_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        return path

    def summarize(self, *paths):
        return summarize_event_files(paths, self.root)


    def test_sorts_out_of_order_events_and_calculates_stage_durations(self):
        log_ref = self.write_evidence("results/test.log", "PASS\n")
        events = [
            self.event("e-accepted", "accepted", "2026-10-24T00:30:00Z", ac_ids=["M01.AC01"]),
            self.event("e-test", "test", "2026-10-24T00:20:00Z",
                       evidence={"kind": "test_result", **log_ref, "result": "passed", "job_id": "linux-1", "exit_code": 0}),
            self.event("e-integrated", "integrated", "2026-10-24T00:15:00Z"),
            self.event("e-received", "received", "2026-10-24T00:10:00Z"),
            self.event("e-ready", "ready", "2026-10-24T00:00:00Z", ready_at="2026-10-24T00:00:00Z"),
        ]
        result = self.summarize(self.write_events("owner-20.jsonl", events))

        self.assertEqual(result["event_count"], 5)
        packet = result["packets"][0]
        self.assertEqual(packet["milestones"]["ready"], "2026-10-24T00:00:00Z")
        self.assertEqual(packet["elapsed_seconds"]["ready_to_received"], 600)
        self.assertEqual(packet["elapsed_seconds"]["received_to_integrated"], 300)
        self.assertEqual([item["event_type"] for item in packet["timeline"]], ["ready", "received", "integrated", "test", "accepted"])
        self.assertEqual(packet["timeline"][3]["evidence"]["job_id"], "linux-1")

    def test_identical_event_ids_are_deduplicated_across_owner_files(self):
        event = self.event("e-ready", "ready", "2026-10-24T00:00:00Z")
        first = self.write_events("owner-20.jsonl", [event])
        second = self.write_events("merged-copy.jsonl", [event])
        result = self.summarize(first, second)
        self.assertEqual(result["event_count"], 1)
        self.assertEqual(result["duplicate_events_ignored"], 1)

    def test_conflicting_duplicate_event_id_fails_closed(self):
        first = self.write_events("owner-20.jsonl", [self.event("same", "ready", "2026-10-24T00:00:00Z")])
        second = self.write_events("merged-copy.jsonl", [self.event("same", "received", "2026-10-24T00:01:00Z")])
        with self.assertRaisesRegex(ValueError, "conflicting duplicate event_id"):
            self.summarize(first, second)

    def test_bad_or_non_utc_timestamps_are_rejected(self):
        path = self.write_events("owner-20.jsonl", [self.event("bad-time", "ready", "2026-10-24T00:00:00+08:00")])
        with self.assertRaisesRegex(ValueError, "occurred_at must be UTC RFC3339 ending in Z"):
            self.summarize(path)

    def test_duplicate_json_keys_are_rejected(self):
        path = self.events_dir / "bad.jsonl"
        path.write_text(
            '{"schema_version":1,"event_id":"x","event_id":"y","event_type":"ready",'
            '"occurred_at":"2026-10-24T00:00:00Z","owner":"20","packet_id":"p-1",'
            '"source_class":"new_development"}\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate JSON object key: event_id"):
            self.summarize(path)

    def test_source_class_cannot_change_for_a_packet(self):
        first = self.event("e-ready", "ready", "2026-10-24T00:00:00Z")
        second = self.event("e-received", "received", "2026-10-24T00:01:00Z", source_class="inherited_wip")
        path = self.write_events("owner-20.jsonl", [first, second])
        with self.assertRaisesRegex(ValueError, "source_class changed for packet"):
            self.summarize(path)

    def test_inherited_wip_and_new_work_are_counted_separately(self):
        inherited = self.event("e-old", "ready", "2026-10-24T00:00:00Z", packet_id="old", source_class="inherited_wip")
        new = self.event("e-new", "ready", "2026-10-24T00:01:00Z", packet_id="new")
        result = self.summarize(self.write_events("owner-20.jsonl", [inherited, new]))
        self.assertEqual(result["by_source_class"]["inherited_wip"]["packet_count"], 1)
        self.assertEqual(result["by_source_class"]["new_development"]["packet_count"], 1)

    def test_test_event_requires_hashed_result_evidence(self):
        path = self.write_events("owner-20.jsonl", [self.event("e-test", "test", "2026-10-24T00:05:00Z")])
        with self.assertRaisesRegex(ValueError, "test event requires result evidence"):
            self.summarize(path)

    def test_test_result_arrays_and_objects_fail_with_value_error(self):
        log_ref = self.write_evidence("results/test.log", "PASS\n")
        for invalid in ([], {}):
            with self.subTest(result_type=type(invalid).__name__):
                event = self.event("e-test", "test", "2026-10-24T00:05:00Z",
                                   evidence={"kind": "test_result", **log_ref, "result": invalid, "job_id": "job-1", "exit_code": 0})
                with self.assertRaisesRegex(ValueError, "result passed or failed"):
                    self.summarize(self.write_events("owner-20.jsonl", [event]))

    def test_passed_result_with_nonzero_exit_code_is_rejected(self):
        evidence = self.write_evidence("results/test.log", "FAILED\n")
        event = self.event("e-test", "test", "2026-10-24T00:05:00Z",
                           evidence={"kind": "test_result", **evidence, "result": "passed", "job_id": "job-3", "exit_code": 1})
        with self.assertRaisesRegex(ValueError, "must agree with exit_code"):
            self.summarize(self.write_events("owner-20.jsonl", [event]))

    def test_accepted_event_is_workflow_only_and_emits_no_formal_ac_fields(self):
        event = self.event("e-accepted", "accepted", "2026-10-24T00:30:00Z", ac_ids=["M01.AC01"])
        result = self.summarize(self.write_events("owner-20.jsonl", [event]))
        self.assertEqual(result["event_counts"]["accepted"], 1)
        self.assertNotIn("formal_ac_delta", result)
        self.assertNotIn("task_timing_summaries", result)
        self.assertNotIn("D", result)
        self.assertNotIn("E", result)


    def test_cli_emits_workflow_json_without_formal_ac_fields(self):
        path = self.write_events("owner-20.jsonl", [self.event("e-ready", "ready", "2026-10-24T00:00:00Z")])
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = main(["--events", str(path), "--evidence-root", str(self.root)])
        result = json.loads(stdout.getvalue())
        self.assertEqual(code, 0)
        self.assertNotIn("formal_ac_delta", result)
        self.assertTrue(result["generated_at"].endswith("Z"))

    def test_trial_template_is_prepared_without_start_or_end_snapshots(self):
        trial = json.loads((self.tool_root / "trial-preparation.json").read_text(encoding="utf-8"))
        result = validate_trial_record(trial)
        self.assertEqual(result["state"], "prepared_not_started")
        self.assertEqual(trial["duration_seconds"], 7200)
        self.assertIsNone(trial["started_at"])
        self.assertIsNone(trial["ended_at"])
        self.assertIsNone(trial["start_snapshot"])
        self.assertIsNone(trial["end_snapshot"])

    def _snapshot(self, captured_at, event_path, ready, active, commit="a" * 40, tree="b" * 40):
        data = event_path.read_bytes()
        return {
            "captured_at": captured_at,
            "candidate_commit": commit,
            "candidate_tree": tree,
            "ready_packet_ids": list(ready),
            "active_packet_ids": list(active),
            "event_streams": [{
                "owner": "20",
                "path": event_path.relative_to(self.root).as_posix(),
                "sha256": hashlib.sha256(data).hexdigest(),
            }],
        }

    def completed_trial(self, elapsed_seconds):
        trial = json.loads((self.tool_root / "trial-preparation.json").read_text(encoding="utf-8"))
        started = datetime(2026, 10, 24, 0, 0, 0, tzinfo=timezone.utc)
        ended = started + timedelta(seconds=elapsed_seconds)
        fmt = lambda value: value.strftime("%Y-%m-%dT%H:%M:%SZ")
        started_at, ended_at = fmt(started), fmt(ended)
        commit, tree = "a" * 40, "b" * 40
        first = self.event("trial-ready", "ready", started_at, ready_at=started_at,
                           candidate_commit=commit, candidate_tree=tree)
        second = self.event("trial-received", "received", fmt(started + timedelta(seconds=1)),
                            candidate_commit=commit, candidate_tree=tree)
        third = self.event("trial-integrated", "integrated", fmt(started + timedelta(seconds=2)),
                           candidate_commit=commit, candidate_tree=tree)
        start_path = self.write_events("trial/start-events.jsonl", [first])
        end_path = self.write_events("trial/end-events.jsonl", [first, second, third])
        start_snapshot = self._snapshot(started_at, start_path, ["p-1"], [])
        end_snapshot = self._snapshot(ended_at, end_path, [], ["p-1"])
        trial.update({
            "state": "completed",
            "started_at": started_at,
            "ended_at": ended_at,
            "optimization_baseline": json.loads(json.dumps(start_snapshot)),
            "start_snapshot": start_snapshot,
            "end_snapshot": end_snapshot,
        })
        return trial

    def phase_state_evidence(self, trial, real_started=True, started_at=None, ends_at=None):
        state = {
            "trial": {
                "started_at": started_at if started_at is not None else (trial["started_at"] if real_started else None),
                "ends_at": ends_at if ends_at is not None else (trial["ended_at"] if real_started else None),
            },
            "real_product_trial_started": real_started,
        }
        ref = self.write_evidence("trial/phase-state.json", json.dumps(state))
        return self.root / ref["path"], ref["sha256"]

    def validate_with_phase_state(self, trial, real_started=True, started_at=None, ends_at=None, expected_sha=None):
        path, sha256 = self.phase_state_evidence(trial, real_started, started_at, ends_at)
        with patch.object(metrics, "R_TRIAL_STATE_PATH", path), patch.object(
            metrics, "R_TRIAL_STATE_SHA256", expected_sha or sha256
        ):
            return validate_trial_record(trial, self.root)

    def r3_profile_fixture(
        self, started_at="2026-10-24T00:00:00Z", ends_at="2026-10-24T02:00:00Z",
        started=True, snapshot_trial_id="jot-parallel-r3-20261025",
    ):
        repo = Path(tempfile.mkdtemp(prefix="r3-repository-", dir=self.root))
        profile_dir = repo / "docs" / "diagnostics" / "delivery-flow-v3-20261025"
        profile_dir.mkdir(parents=True)
        workers_path = profile_dir / "workers.json"
        policy_path = profile_dir / "dispatch-policy.json"
        snapshot_path = profile_dir / "trial-start-snapshot.json"
        pin_path = profile_dir / "trial-start-pin.json"
        worker_root = repo / "worker-20"
        worker_root.mkdir(parents=True)
        work_order_dir = profile_dir / "worker-20"
        work_order_dir.mkdir()
        work_order_path = work_order_dir / "work-order.json"
        work_order = {
            "schema": "jot.r3.work-order.v1",
            "worker": 20,
            "private_workspace": worker_root.as_posix(),
            "primary": {"id": "M20.TEST"},
            "backup": {"id": "M20.BACKUP"},
            "source_class_by_task": {"M20.TEST": "new_development", "M20.BACKUP": "inherited_wip"},
        }
        work_order_bytes = json.dumps(work_order, separators=(",", ":")).encode("utf-8")
        work_order_path.write_bytes(work_order_bytes)
        workers_bytes = json.dumps({
            "schema": "workers.v1",
            "workers": [{
                "number": 20,
                "private_workspace": worker_root.as_posix(),
                "primary_task_ids": ["M20.OLD"],
                "role": "developer",
            }],
        }, separators=(",", ":")).encode("utf-8")
        policy_bytes = b'{"schema":"policy.v1"}'
        workers_path.write_bytes(workers_bytes)
        policy_path.write_bytes(policy_bytes)
        snapshot = {
            "schema": "jot.r3.trial-start-snapshot.v1",
            "trial_id": snapshot_trial_id,
            "trial": {
                "started": started,
                "real_product_trial_started": started,
                "started_at": started_at,
                "ends_at": ends_at,
            },
            "work_orders": [{
                "worker": 20,
                "work_order_path": work_order_path.as_posix(),
                "work_order_sha256": hashlib.sha256(work_order_bytes).hexdigest(),
                "primary_id": "M20.TEST",
                "backup_id": "M20.BACKUP",
                "source_class_by_task": work_order["source_class_by_task"],
            }],
        }
        snapshot_bytes = json.dumps(snapshot, separators=(",", ":")).encode("utf-8")
        snapshot_path.write_bytes(snapshot_bytes)
        profile = {
            "schema": "jot.r3.runtime-profile.v1",
            "profile_id": "jot-parallel-r3-20261025",
            "repository": repo.as_posix(),
            "assignments": {
                "path": workers_path.as_posix(),
                "sha256": hashlib.sha256(workers_bytes).hexdigest(),
            },
            "policy": {
                "path": policy_path.as_posix(),
                "sha256": hashlib.sha256(policy_bytes).hexdigest(),
            },
            "trial_start_snapshot": snapshot_path.as_posix(),
            "trial_start_pin": pin_path.as_posix(),
        }
        profile_path = profile_dir / "runtime-profile.json"
        profile_bytes = json.dumps(profile, separators=(",", ":")).encode("utf-8")
        profile_path.write_bytes(profile_bytes)
        pin = {
            "schema": "jot.r3.trial-start-pin.v1",
            "trial_id": "jot-parallel-r3-20261025",
            "snapshot_path": snapshot_path.as_posix(),
            "snapshot_sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
            "immutable": True,
        }
        pin_bytes = json.dumps(pin, separators=(",", ":")).encode("utf-8")
        pin_path.write_bytes(pin_bytes)
        return {
            "repo": repo,
            "profile_path": profile_path,
            "profile_sha256": hashlib.sha256(profile_bytes).hexdigest(),
            "workers_sha256": hashlib.sha256(workers_bytes).hexdigest(),
            "policy_sha256": hashlib.sha256(policy_bytes).hexdigest(),
            "snapshot_sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
            "pin_sha256": hashlib.sha256(pin_bytes).hexdigest(),
            "work_order_path": work_order_path,
            "work_order_sha256": hashlib.sha256(work_order_bytes).hexdigest(),
            "worker_root": worker_root,
        }

    def validate_with_r3_profile(
        self, trial, fixture, task_id="M20.TEST", source_class="new_development", owner="20",
        task_owner=20, packet_id="source-pkg-M20.TEST-r1",
    ):
        snapshots = [trial["start_snapshot"], trial["end_snapshot"]]
        if trial["optimization_baseline"] is not None:
            snapshots.append(trial["optimization_baseline"])
        seen_paths = set()
        for snapshot in snapshots:
            if snapshot is None:
                continue
            for stream in snapshot["event_streams"]:
                event_path = self.root / stream["path"]
                if event_path not in seen_paths:
                    events = [json.loads(line) for line in event_path.read_text(encoding="utf-8").splitlines() if line.strip()]
                    for event in events:
                        event["trial_id"] = "jot-parallel-r3-20261025"
                        event["packet_id"] = packet_id
                        event["task_owner"] = task_owner
                        event["task_id"] = task_id
                        event["source_class"] = source_class
                        event["owner"] = owner
                        event["timestamp_provenance"] = {
                            "basis": "process_observed",
                            "process_observed_at": event["occurred_at"],
                            "actor_reported_at": None,
                            "native_observed_at": None,
                        }
                    event_path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
                    seen_paths.add(event_path)
                stream["sha256"] = hashlib.sha256(event_path.read_bytes()).hexdigest()
                stream["owner"] = owner
                snapshot["ready_packet_ids"] = [packet_id] if snapshot["ready_packet_ids"] else []
                snapshot["active_packet_ids"] = [packet_id] if snapshot["active_packet_ids"] else []
        with ExitStack() as stack:
            stack.enter_context(patch.object(metrics, "R3_REPOSITORY_ROOT", fixture["repo"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_PATH", fixture["profile_path"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_SHA256", fixture["profile_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_START_PIN_SHA256", fixture["pin_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_ASSIGNMENTS_SHA256", fixture["workers_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_POLICY_SHA256", fixture["policy_sha256"], create=True))
            return validate_trial_record(trial, self.root)

    def summarize_with_r3_profile(self, fixture, *paths):
        with ExitStack() as stack:
            stack.enter_context(patch.object(metrics, "R3_REPOSITORY_ROOT", fixture["repo"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_PATH", fixture["profile_path"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_SHA256", fixture["profile_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_START_PIN_SHA256", fixture["pin_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_ASSIGNMENTS_SHA256", fixture["workers_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_POLICY_SHA256", fixture["policy_sha256"], create=True))
            return summarize_event_files(paths, self.root)

    def run_trial_cli(self, trial, include_phase_state=True, phase_state_sha=None):
        trial_path = self.root / "trial.json"
        trial_path.write_text(json.dumps(trial), encoding="utf-8")
        event_path = self.root / trial["end_snapshot"]["event_streams"][0]["path"]
        phase_path, phase_sha = self.phase_state_evidence(trial)
        args = ["--events", str(event_path), "--evidence-root", str(self.root), "--trial-record", str(trial_path)]
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            if include_phase_state:
                with patch.object(metrics, "R_TRIAL_STATE_PATH", phase_path), patch.object(
                    metrics, "R_TRIAL_STATE_SHA256", phase_state_sha or phase_sha
                ):
                    code = main(args)
            else:
                code = main(args)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_completed_trial_rejects_timestamp_only_snapshots(self):
        trial = self.completed_trial(7200)
        trial["start_snapshot"] = {"captured_at": trial["started_at"]}
        trial["end_snapshot"] = {"captured_at": trial["ended_at"]}
        with self.assertRaisesRegex(ValueError, "snapshot"):
            validate_trial_record(trial)

    def test_completed_trial_rejects_unknown_schema_properties(self):
        trial = self.completed_trial(7200)
        trial["unreviewed"] = True
        with self.assertRaisesRegex(ValueError, "unexpected"):
            validate_trial_record(trial)

    def test_completed_trial_requires_r_trial_start_evidence(self):
        with self.assertRaisesRegex(ValueError, "trial_start"):
            validate_trial_record(self.completed_trial(7200), evidence_root=self.root)

    def test_running_trial_requires_r_trial_start_evidence(self):
        trial = self.completed_trial(7200)
        trial.update({"state": "running", "ended_at": None, "end_snapshot": None})
        with self.assertRaisesRegex(ValueError, "trial_start"):
            validate_trial_record(trial, evidence_root=self.root)

    def test_completed_trial_rejects_unstarted_phase_state(self):
        trial = self.completed_trial(7200)
        with self.assertRaisesRegex(ValueError, "does not authorize"):
            self.validate_with_phase_state(trial, real_started=False)

    def test_completed_trial_rejects_wrong_phase_state_hash(self):
        trial = self.completed_trial(7200)
        with self.assertRaisesRegex(ValueError, "SHA-256 does not match"):
            self.validate_with_phase_state(trial, expected_sha="0" * 64)

    def test_completed_trial_requires_phase_state_window_match(self):
        trial = self.completed_trial(7200)
        wrong_start = "2026-10-24T00:00:01Z"
        wrong_end = "2026-10-24T02:00:01Z"
        with self.assertRaisesRegex(ValueError, "does not match R phase-state"):
            self.validate_with_phase_state(trial, started_at=wrong_start, ends_at=wrong_end)

    def test_completed_trial_rejects_snapshot_event_hash_mismatch(self):
        trial = self.completed_trial(7200)
        trial["start_snapshot"]["event_streams"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "SHA-256 does not match"):
            self.validate_with_phase_state(trial)

    def test_completed_trial_rejects_snapshot_candidate_mismatch(self):
        trial = self.completed_trial(7200)
        trial["start_snapshot"]["candidate_commit"] = "c" * 40
        with self.assertRaisesRegex(ValueError, "candidate identity"):
            self.validate_with_phase_state(trial)

    def test_completed_trial_rejects_packet_set_without_matching_event(self):
        trial = self.completed_trial(7200)
        trial["start_snapshot"]["ready_packet_ids"] = ["missing-packet"]
        with self.assertRaisesRegex(ValueError, "packet sets do not match event stream state"):
            self.validate_with_phase_state(trial)

    def test_completed_trial_rejects_misclassified_packet_set(self):
        trial = self.completed_trial(7200)
        trial["start_snapshot"]["ready_packet_ids"] = []
        trial["start_snapshot"]["active_packet_ids"] = ["p-1"]
        with self.assertRaisesRegex(ValueError, "packet sets do not match event stream state"):
            self.validate_with_phase_state(trial)

    def test_completed_trial_rejects_incomplete_packet_set(self):
        trial = self.completed_trial(7200)
        trial["start_snapshot"]["ready_packet_ids"] = []
        with self.assertRaisesRegex(ValueError, "packet sets do not match event stream state"):
            self.validate_with_phase_state(trial)

    def test_completed_trial_rejects_stale_packet_state_after_received_event(self):
        trial = self.completed_trial(7200)
        commit, tree = trial["start_snapshot"]["candidate_commit"], trial["start_snapshot"]["candidate_tree"]
        ready = self.event("older-ready", "ready", "2026-10-23T23:59:59Z",
                           candidate_commit=commit, candidate_tree=tree)
        received = self.event("received-at-start", "received", trial["started_at"],
                              candidate_commit=commit, candidate_tree=tree)
        event_path = self.write_events("trial/start-events.jsonl", [ready, received])
        event_sha = hashlib.sha256(event_path.read_bytes()).hexdigest()
        trial["start_snapshot"]["event_streams"][0]["sha256"] = event_sha
        trial["optimization_baseline"]["event_streams"][0]["sha256"] = event_sha
        with self.assertRaisesRegex(ValueError, "packet sets do not match event stream state"):
            self.validate_with_phase_state(trial)

    def test_completed_trial_rejects_same_time_packet_events(self):
        trial = self.completed_trial(7200)
        commit, tree = trial["start_snapshot"]["candidate_commit"], trial["start_snapshot"]["candidate_tree"]
        received = self.event("a-received", "received", trial["started_at"],
                              candidate_commit=commit, candidate_tree=tree)
        ready = self.event("z-ready", "ready", trial["started_at"], ready_at=trial["started_at"],
                           candidate_commit=commit, candidate_tree=tree)
        event_path = self.write_events("trial/start-events.jsonl", [received, ready])
        event_sha = hashlib.sha256(event_path.read_bytes()).hexdigest()
        trial["start_snapshot"]["event_streams"][0]["sha256"] = event_sha
        trial["optimization_baseline"]["event_streams"][0]["sha256"] = event_sha
        with self.assertRaisesRegex(ValueError, "ambiguous same-time events"):
            self.validate_with_phase_state(trial)

    def test_completed_trial_rejects_packet_event_with_different_candidate_identity(self):
        trial = self.completed_trial(7200)
        event = self.event("trial-ready", "ready", trial["started_at"], ready_at=trial["started_at"],
                           candidate_commit="c" * 40, candidate_tree="d" * 40)
        event_path = self.write_events("trial/start-events.jsonl", [event])
        event_sha = hashlib.sha256(event_path.read_bytes()).hexdigest()
        trial["start_snapshot"]["event_streams"][0]["sha256"] = event_sha
        trial["optimization_baseline"]["event_streams"][0]["sha256"] = event_sha
        with self.assertRaisesRegex(ValueError, "lacks current candidate-bound event evidence"):
            self.validate_with_phase_state(trial)

    def test_completed_trial_rejects_events_after_snapshot_boundary(self):
        trial = self.completed_trial(7200)
        event_path = self.root / trial["start_snapshot"]["event_streams"][0]["path"]
        future = self.event("future-ready", "ready", "2026-10-24T00:00:01Z",
                            ready_at="2026-10-24T00:00:01Z", candidate_commit="a" * 40,
                            candidate_tree="b" * 40)
        written = self.write_events("trial/start-events.jsonl", [future])
        sha256 = hashlib.sha256(written.read_bytes()).hexdigest()
        trial["start_snapshot"]["event_streams"][0]["sha256"] = sha256
        trial["optimization_baseline"]["event_streams"][0]["sha256"] = sha256
        with self.assertRaisesRegex(ValueError, "after snapshot captured_at"):
            self.validate_with_phase_state(trial)

    def test_cli_requires_phase_state_evidence_to_report_completed(self):
        code, stdout, stderr = self.run_trial_cli(self.completed_trial(7200), include_phase_state=False)
        self.assertEqual(code, 2)
        self.assertEqual(stdout, "")
        self.assertIn("trial_start", stderr)

    def test_cli_reports_completed_only_with_hashed_r_phase_state(self):
        code, stdout, stderr = self.run_trial_cli(self.completed_trial(7200))
        self.assertEqual(code, 0, stderr)
        result = json.loads(stdout)
        trial_validation = result["trial_validation"]
        self.assertEqual(trial_validation["state"], "completed")
        self.assertEqual(trial_validation["elapsed_seconds"], 7200)
        self.assertEqual(trial_validation["trial_start_evidence"]["sha256"], hashlib.sha256(
            Path(trial_validation["trial_start_evidence"]["path"]).read_bytes()).hexdigest())
        self.assertNotIn("formal_ac_delta", result)
        self.assertNotIn("D", result)
        self.assertNotIn("E", result)

    def test_cli_rejects_caller_selected_phase_state_and_hash(self):
        trial = self.completed_trial(7200)
        trial_path = self.root / "trial.json"
        trial_path.write_text(json.dumps(trial), encoding="utf-8")
        event_path = self.root / trial["end_snapshot"]["event_streams"][0]["path"]
        phase_path, phase_sha = self.phase_state_evidence(trial)
        args = ["--events", str(event_path), "--evidence-root", str(self.root),
                "--trial-record", str(trial_path), "--trial-start-state", str(phase_path),
                "--trial-start-state-sha256", phase_sha]
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                main(args)
        self.assertEqual(raised.exception.code, 2)

    def test_completed_trial_requires_exactly_7200_seconds(self):
        trial = self.completed_trial(7200)
        result = self.validate_with_phase_state(trial)
        self.assertEqual(result["elapsed_seconds"], 7200)
        self.assertEqual(result["trial_start_evidence"]["sha256"], self.phase_state_evidence(trial)[1])
        for elapsed in (7199, 7201):
            with self.subTest(elapsed=elapsed):
                with self.assertRaisesRegex(ValueError, "must be exactly 7200 seconds"):
                    validate_trial_record(self.completed_trial(elapsed), evidence_root=self.root)

    def test_trial_snapshot_times_must_match_window_boundaries(self):
        trial = self.completed_trial(7200)
        trial["end_snapshot"]["captured_at"] = "2026-10-24T02:00:01Z"
        with self.assertRaisesRegex(ValueError, "end snapshot must match ended_at"):
            validate_trial_record(trial)

    def test_work_intervals_keep_process_and_actor_reported_time_separate(self):
        def timed(event_id, event_type, at, packet_id, basis, next_owner=None):
            extra = {"packet_id": packet_id}
            if next_owner is not None:
                extra["next_owner"] = next_owner
            event = self.event(event_id, event_type, at, **extra)
            event["trial_id"] = "jot-parallel-r3-20261025"
            event["task_owner"] = 20
            event["task_id"] = "M20.TEST"
            event["source_class"] = "new_development"
            if basis == "actor_reported":
                event["packet_id"] = "actor-task:20:M20.TEST"
            event["timestamp_provenance"] = {
                "basis": basis,
                "process_observed_at": at if basis == "process_observed" else None,
                "actor_reported_at": at if basis == "actor_reported" else None,
                "native_observed_at": at if basis == "native_observed" else None,
            }
            return event

        events = [
            timed("p-start", "product_work_started", "2026-10-24T00:00:00Z", "process", "process_observed"),
            timed("p-block", "blocked", "2026-10-24T00:10:00Z", "process", "process_observed"),
            timed("p-resume", "resumed", "2026-10-24T00:20:00Z", "process", "process_observed"),
            timed("p-ready", "ready", "2026-10-24T00:30:00Z", "process", "process_observed"),
            timed("p-next", "next_primary", "2026-10-24T00:35:00Z", "process", "process_observed", "20"),
            timed("a-start", "product_work_started", "2026-10-24T01:00:00Z", "actor", "actor_reported"),
            timed("a-ready", "ready", "2026-10-24T01:30:00Z", "actor", "actor_reported"),
            timed("a-next", "next_primary", "2026-10-24T01:35:00Z", "actor", "actor_reported", "20"),
            timed("n-start", "product_work_started", "2026-10-24T01:40:00Z", "native", "native_observed"),
            timed("n-ready", "ready", "2026-10-24T01:45:00Z", "native", "native_observed"),
            timed("u-start", "product_work_started", "2026-10-24T01:50:00Z", "incomplete", "actor_reported"),
        ]
        events[-1]["owner"] = "21"
        try:
            fixture = self.r3_profile_fixture()
            result = self.summarize_with_r3_profile(fixture, self.write_events("owner-20.jsonl", events))
        except ValueError as exc:
            self.fail("R3 product timing events should be accepted: %s" % exc)

        packets = {packet["packet_id"]: packet for packet in result["packets"]}
        observed = packets["process"]["timing_intervals"]["process_observed"]
        self.assertEqual(observed["work"]["seconds"], 1200)
        self.assertEqual(observed["blocked_wait"]["seconds"], 600)
        self.assertEqual(observed["ready_to_next_primary"]["seconds"], 300)
        self.assertNotIn("actor-task:20:M20.TEST", packets)
        self.assertEqual(result["by_source_class"]["new_development"]["packet_count"], 2)
        actor_timings = {
            (item["task_id"], item["owner"]): item["timing_intervals"]
            for item in result["task_timing_summaries"]
        }
        reported = actor_timings[("M20.TEST", "20")]
        self.assertEqual(reported["work"]["seconds"], 1800)
        self.assertIsNone(reported["blocked_wait"]["seconds"])
        self.assertEqual(reported["ready_to_next_primary"]["seconds"], 300)
        native = packets["native"]["timing_intervals"]["native_observed"]
        self.assertEqual(native["work"]["seconds"], 300)
        incomplete = actor_timings[("M20.TEST", "21")]["work"]
        self.assertIsNone(incomplete["seconds"])
        self.assertEqual(incomplete["unknown_interval_count"], 1)

    def test_r3_events_require_fixed_trial_id_and_matching_timing_provenance(self):
        no_provenance = self.event(
            "r3-ready", "ready", "2026-10-25T00:00:00Z", trial_id="jot-parallel-r3-20261025",
            task_owner=20, task_id="M20.TEST",
        )
        path = self.write_events("r3-no-provenance.jsonl", [no_provenance])
        with self.assertRaisesRegex(ValueError, "requires timestamp_provenance"):
            self.summarize(path)
        wrong_trial_id = self.event("wrong-start", "product_work_started", "2026-10-25T00:00:00Z",
                                    trial_id="unapproved-trial")
        with self.assertRaisesRegex(ValueError, "requires the fixed R3 trial ID"):
            self.summarize(self.write_events("wrong-r3-id.jsonl", [wrong_trial_id]))
        mismatch = self.event("bad-time-source", "ready", "2026-10-25T00:00:00Z",
                              trial_id="jot-parallel-r3-20261025", task_owner=20, task_id="M20.TEST",
                              timestamp_provenance={
                                  "basis": "actor_reported",
                                  "process_observed_at": None,
                                  "actor_reported_at": "2026-10-25T00:00:01Z",
                                  "native_observed_at": None,
                              })
        with self.assertRaisesRegex(ValueError, "must match timestamp_provenance.actor_reported_at"):
            self.summarize(self.write_events("bad-r3-time-source.jsonl", [mismatch]))

    def test_event_schema_declares_provenance_and_r3_transition_requirements(self):
        schema = json.loads((self.tool_root / "event.schema.json").read_text(encoding="utf-8"))
        event_types = schema["properties"]["event_type"]["enum"]
        self.assertIn("product_work_started", event_types)
        self.assertIn("next_primary", event_types)
        provenance = schema["definitions"]["timestampProvenance"]
        self.assertEqual(provenance["properties"]["basis"]["enum"], [
            "actor_reported", "process_observed", "native_observed",
        ])
        self.assertFalse(provenance["additionalProperties"])
        required_transitions = [
            rule["then"]["required"]
            for rule in schema["allOf"]
            if isinstance(rule.get("then"), dict) and "required" in rule["then"]
        ]
        self.assertIn(["trial_id", "task_owner", "task_id", "timestamp_provenance"], required_transitions)
        self.assertIn(["next_owner"], required_transitions)

    def test_running_r3_trial_uses_the_fixed_profile_and_immutable_snapshot_pin(self):
        trial = self.completed_trial(7200)
        trial["trial_id"] = "jot-parallel-r3-20261025"
        fixture = self.r3_profile_fixture()
        with self.assertRaisesRegex(ValueError, "event trial_id does not match"):
            metrics._validate_snapshot_evidence(
                trial["start_snapshot"], self.root, "start_snapshot", "jot-parallel-r3-20261025"
            )
        try:
            result = self.validate_with_r3_profile(trial, fixture)
        except ValueError as exc:
            self.fail("valid R3 pinned start evidence should authorize the record: %s" % exc)

        evidence = result["trial_start_evidence"]
        self.assertEqual(result["state"], "completed")
        self.assertEqual(evidence["trial_id"], "jot-parallel-r3-20261025")
        self.assertEqual(evidence["snapshot_sha256"], fixture["snapshot_sha256"])
        self.assertNotIn("formal_ac_delta", result)

    def test_existing_r2_trial_id_remains_authorized_by_legacy_snapshot_pin(self):
        trial = self.completed_trial(7200)
        trial["trial_id"] = "jot-parallel-r2-20261024"
        result = self.validate_with_phase_state(trial)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["trial_start_evidence"]["sha256"], self.phase_state_evidence(trial)[1])

    def test_r3_rejects_a_changed_runtime_profile_pin(self):
        trial = self.completed_trial(7200)
        trial["trial_id"] = "jot-parallel-r3-20261025"
        fixture = self.r3_profile_fixture()
        fixture["profile_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "runtime profile SHA-256 does not match"):
            self.validate_with_r3_profile(trial, fixture)

    def test_r3_rejects_a_missing_start_pin(self):
        trial = self.completed_trial(7200)
        trial["trial_id"] = "jot-parallel-r3-20261025"
        fixture = self.r3_profile_fixture()
        fixture["repo"].joinpath("docs", "diagnostics", "delivery-flow-v3-20261025", "trial-start-pin.json").unlink()
        with self.assertRaisesRegex(ValueError, "pin or snapshot is missing"):
            self.validate_with_r3_profile(trial, fixture)

    def test_r3_rejects_snapshot_bytes_that_do_not_match_the_immutable_pin(self):
        trial = self.completed_trial(7200)
        trial["trial_id"] = "jot-parallel-r3-20261025"
        fixture = self.r3_profile_fixture()
        snapshot_path = fixture["repo"] / "docs" / "diagnostics" / "delivery-flow-v3-20261025" / "trial-start-snapshot.json"
        snapshot_path.write_text(snapshot_path.read_text(encoding="utf-8") + " ", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "SHA-256 does not match"):
            self.validate_with_r3_profile(trial, fixture)

    def test_r3_rejects_prepared_or_wrong_length_start_snapshots(self):
        trial = self.completed_trial(7200)
        trial["trial_id"] = "jot-parallel-r3-20261025"
        prepared = self.r3_profile_fixture(started=False)
        with self.assertRaisesRegex(ValueError, "does not authorize a real product trial"):
            self.validate_with_r3_profile(trial, prepared)
        wrong_duration = self.r3_profile_fixture(ends_at="2026-10-24T02:00:01Z")
        with self.assertRaisesRegex(ValueError, "exactly 7200 seconds"):
            self.validate_with_r3_profile(trial, wrong_duration)
        wrong_trial = self.r3_profile_fixture(snapshot_trial_id="not-r3")
        with self.assertRaisesRegex(ValueError, "snapshot trial ID is invalid"):
            self.validate_with_r3_profile(trial, wrong_trial)

    def test_r3_rejects_a_pin_that_is_not_immutable(self):
        trial = self.completed_trial(7200)
        trial["trial_id"] = "jot-parallel-r3-20261025"
        fixture = self.r3_profile_fixture()
        pin_path = fixture["repo"] / "docs" / "diagnostics" / "delivery-flow-v3-20261025" / "trial-start-pin.json"
        pin = json.loads(pin_path.read_text(encoding="utf-8"))
        pin["immutable"] = False
        pin_path.write_text(json.dumps(pin, separators=(",", ":")), encoding="utf-8")
        fixture["pin_sha256"] = hashlib.sha256(pin_path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "not marked immutable"):
            self.validate_with_r3_profile(trial, fixture)

    def test_r3_rejects_work_order_snapshot_classification_mismatch(self):
        trial = self.completed_trial(7200)
        trial["trial_id"] = "jot-parallel-r3-20261025"
        fixture = self.r3_profile_fixture()
        snapshot_path = fixture["repo"] / "docs" / "diagnostics" / "delivery-flow-v3-20261025" / "trial-start-snapshot.json"
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        snapshot["work_orders"][0]["source_class_by_task"]["M20.TEST"] = "inherited_wip"
        snapshot_bytes = json.dumps(snapshot, separators=(",", ":")).encode("utf-8")
        snapshot_path.write_bytes(snapshot_bytes)
        pin_path = fixture["repo"] / "docs" / "diagnostics" / "delivery-flow-v3-20261025" / "trial-start-pin.json"
        pin = json.loads(pin_path.read_text(encoding="utf-8"))
        pin["snapshot_sha256"] = hashlib.sha256(snapshot_bytes).hexdigest()
        pin_path.write_text(json.dumps(pin, separators=(",", ":")), encoding="utf-8")
        fixture["pin_sha256"] = hashlib.sha256(pin_path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "source_class_by_task does not match"):
            self.validate_with_r3_profile(trial, fixture)

    def test_r3_record_rejects_unmapped_event_tasks_and_wrong_source_class(self):
        trial = self.completed_trial(7200)
        trial["trial_id"] = "jot-parallel-r3-20261025"
        cases = (
            ("M99.UNMAPPED", "new_development", "task_id is not in task_owner's pinned work order"),
            ("M20.TEST", "inherited_wip", "source_class does not match the pinned work order"),
        )
        for task_id, source_class, expected in cases:
            with self.subTest(task_id=task_id, source_class=source_class):
                fixture = self.r3_profile_fixture()
                with self.assertRaisesRegex(ValueError, expected):
                    self.validate_with_r3_profile(trial, fixture, task_id, source_class)
        fixture = self.r3_profile_fixture()
        with self.assertRaisesRegex(ValueError, "task_owner has no pinned work order"):
            self.validate_with_r3_profile(trial, fixture, task_owner=21)
        observer_fixture = self.r3_profile_fixture()
        self.validate_with_r3_profile(trial, observer_fixture, owner="13")

    def test_r3_actor_ready_cannot_create_a_queue_snapshot_packet(self):
        fixture = self.r3_profile_fixture()
        actor_ready = self.event(
            "actor-ready", "ready", "2026-10-24T00:00:00Z",
            owner="20", packet_id="actor-task:20:M20.TEST", source_class="new_development",
            trial_id="jot-parallel-r3-20261025", task_owner=20, task_id="M20.TEST",
            timestamp_provenance={
                "basis": "actor_reported",
                "process_observed_at": None,
                "actor_reported_at": "2026-10-24T00:00:00Z",
                "native_observed_at": None,
            },
        )
        path = self.write_events("trial/actor-ready.jsonl", [actor_ready])
        snapshot = self._snapshot("2026-10-24T00:00:00Z", path, [], [])
        with ExitStack() as stack:
            stack.enter_context(patch.object(metrics, "R3_REPOSITORY_ROOT", fixture["repo"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_PATH", fixture["profile_path"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_SHA256", fixture["profile_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_START_PIN_SHA256", fixture["pin_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_ASSIGNMENTS_SHA256", fixture["workers_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_POLICY_SHA256", fixture["policy_sha256"], create=True))
            authority = metrics.load_r3_start_authority()
            metrics._validate_snapshot_evidence(
                snapshot, self.root, "start_snapshot", "jot-parallel-r3-20261025", authority,
            )
            snapshot["ready_packet_ids"] = ["actor-task:20:M20.TEST"]
            with self.assertRaisesRegex(ValueError, "packet sets do not match event stream state"):
                metrics._validate_snapshot_evidence(
                    snapshot, self.root, "start_snapshot", "jot-parallel-r3-20261025", authority,
                )

    def test_r3_reserves_actor_task_packet_prefix(self):
        actor_with_source_packet = self.event(
            "actor-bad-key", "ready", "2026-10-24T00:00:00Z",
            packet_id="source-pkg-M20.TEST-r1", trial_id="jot-parallel-r3-20261025",
            task_owner=20, task_id="M20.TEST",
            timestamp_provenance={
                "basis": "actor_reported", "process_observed_at": None,
                "actor_reported_at": "2026-10-24T00:00:00Z", "native_observed_at": None,
            },
        )
        with self.assertRaisesRegex(ValueError, "reserved task grouping key"):
            self.summarize(self.write_events("bad-actor-key.jsonl", [actor_with_source_packet]))
        source_with_actor_key = self.event(
            "source-bad-key", "received", "2026-10-24T00:00:00Z",
            packet_id="actor-task:20:M20.TEST", trial_id="jot-parallel-r3-20261025",
            task_owner=20, task_id="M20.TEST",
            timestamp_provenance={
                "basis": "process_observed", "process_observed_at": "2026-10-24T00:00:00Z",
                "actor_reported_at": None, "native_observed_at": None,
            },
        )
        with self.assertRaisesRegex(ValueError, "reserved actor-task prefix"):
            self.summarize(self.write_events("bad-source-key.jsonl", [source_with_actor_key]))

    def test_work_event_appends_actor_report_with_class_from_pinned_work_order(self):
        try:
            import work_event
        except ImportError as exc:
            self.fail("R3 work event recorder should be available: %s" % exc)
        fixture = self.r3_profile_fixture("2026-10-25T00:00:00Z", "2026-10-25T02:00:00Z")
        args = ["--task-id", "M20.TEST", "--state", "start"]
        stdout = io.StringIO()
        event_path = fixture["worker_root"] / "private" / "reports" / "r3" / "owner-20.jsonl"
        event_path.parent.mkdir(parents=True)
        received = self.event("process-received", "received", "2026-10-25T00:59:59Z",
                              packet_id="source-pkg-M20.TEST-r1", trial_id="jot-parallel-r3-20261025",
                              task_owner=20, task_id="M20.TEST",
                              timestamp_provenance={
                                  "basis": "process_observed",
                                  "process_observed_at": "2026-10-25T00:59:59Z",
                                  "actor_reported_at": None,
                                  "native_observed_at": None,
                              })
        event_path.write_text(json.dumps(received) + "\n", encoding="utf-8")
        with ExitStack() as stack:
            stack.enter_context(patch.object(metrics, "R3_REPOSITORY_ROOT", fixture["repo"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_PATH", fixture["profile_path"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_SHA256", fixture["profile_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_START_PIN_SHA256", fixture["pin_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_ASSIGNMENTS_SHA256", fixture["workers_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_POLICY_SHA256", fixture["policy_sha256"], create=True))
            stack.enter_context(patch.object(work_event.Path, "cwd", return_value=fixture["worker_root"]))
            stack.enter_context(patch.object(work_event, "utc_now", return_value="2026-10-25T01:00:00Z"))
            with redirect_stdout(stdout):
                code = work_event.main(args)
        self.assertEqual(code, 0)
        event = json.loads(stdout.getvalue())
        self.assertEqual(event["event_type"], "product_work_started")
        self.assertEqual(event["trial_id"], "jot-parallel-r3-20261025")
        self.assertEqual(event["owner"], "20")
        self.assertEqual(event["packet_id"], "actor-task:20:M20.TEST")
        self.assertEqual(event["task_owner"], 20)
        self.assertEqual(event["task_id"], "M20.TEST")
        self.assertEqual(event["source_class"], "new_development")
        self.assertEqual(event["timestamp_provenance"], {
            "basis": "actor_reported",
            "process_observed_at": None,
            "actor_reported_at": "2026-10-25T01:00:00Z",
            "native_observed_at": None,
        })
        self.assertEqual(str(uuid.UUID(event["event_id"])), event["event_id"])
        output = fixture["worker_root"] / "private" / "reports" / "r3" / "owner-20.jsonl"
        self.assertTrue(output.is_file())
        recorded = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(recorded[0]["event_type"], "received")
        self.assertEqual(recorded[0]["packet_id"], "source-pkg-M20.TEST-r1")
        self.assertEqual(recorded[1], event)

    def test_work_event_rejects_prepared_state_and_caller_selected_basis_or_output(self):
        try:
            import work_event
        except ImportError as exc:
            self.fail("R3 work event recorder should be available: %s" % exc)
        fixture = self.r3_profile_fixture("2026-10-25T00:00:00Z", "2026-10-25T02:00:00Z", started=False)
        args = ["--task-id", "M20.TEST", "--state", "start"]
        stderr = io.StringIO()
        with ExitStack() as stack:
            stack.enter_context(patch.object(metrics, "R3_REPOSITORY_ROOT", fixture["repo"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_PATH", fixture["profile_path"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_SHA256", fixture["profile_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_START_PIN_SHA256", fixture["pin_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_ASSIGNMENTS_SHA256", fixture["workers_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_POLICY_SHA256", fixture["policy_sha256"], create=True))
            stack.enter_context(patch.object(work_event.Path, "cwd", return_value=fixture["worker_root"]))
            with redirect_stderr(stderr):
                self.assertEqual(work_event.main(args), 2)
        output = fixture["worker_root"] / "private" / "reports" / "r3" / "owner-20.jsonl"
        self.assertFalse(output.exists())
        for extra in (("--basis", "native_observed"), ("--output", str(self.root / "outside.jsonl"))):
            with redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    work_event.main(args + list(extra))
            self.assertEqual(raised.exception.code, 2)

    def test_work_event_rejects_unmapped_task_and_invalid_transition_without_appending(self):
        try:
            import work_event
        except ImportError as exc:
            self.fail("R3 work event recorder should be available: %s" % exc)
        fixture = self.r3_profile_fixture("2026-10-25T00:00:00Z", "2026-10-25T02:00:00Z")
        with ExitStack() as stack:
            stack.enter_context(patch.object(metrics, "R3_REPOSITORY_ROOT", fixture["repo"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_PATH", fixture["profile_path"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_SHA256", fixture["profile_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_START_PIN_SHA256", fixture["pin_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_ASSIGNMENTS_SHA256", fixture["workers_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_POLICY_SHA256", fixture["policy_sha256"], create=True))
            stack.enter_context(patch.object(work_event.Path, "cwd", return_value=fixture["worker_root"]))
            stack.enter_context(patch.object(work_event, "utc_now", return_value="2026-10-25T01:00:00Z"))
            with redirect_stderr(io.StringIO()):
                self.assertEqual(work_event.main(["--task-id", "M99.UNKNOWN", "--state", "start"]), 2)
                self.assertEqual(work_event.main(["--task-id", "M20.TEST", "--state", "blocked"]), 2)
                self.assertEqual(work_event.main(["--task-id", "M20.TEST", "--state", "next_primary"]), 2)
                other_cwd = self.root / "not-a-pinned-worker"
                other_cwd.mkdir()
                with patch.object(work_event.Path, "cwd", return_value=other_cwd):
                    self.assertEqual(work_event.main(["--task-id", "M20.TEST", "--state", "start"]), 2)
        output = fixture["worker_root"] / "private" / "reports" / "r3" / "owner-20.jsonl"
        self.assertFalse(output.exists())

    def test_work_event_rejects_report_symlink_escape_before_creating_outside_path(self):
        try:
            import work_event
        except ImportError as exc:
            self.fail("R3 work event recorder should be available: %s" % exc)
        fixture = self.r3_profile_fixture("2026-10-25T00:00:00Z", "2026-10-25T02:00:00Z")
        outside = self.root / "outside-report-target"
        outside.mkdir()
        report_root = fixture["worker_root"] / "private" / "reports" / "r3"
        escaped_root = outside / "reports" / "r3"
        original_resolve = work_event.Path.resolve

        def resolve_with_escape(self, strict=False):
            if self == report_root:
                return escaped_root
            return original_resolve(self, strict=strict)

        with ExitStack() as stack:
            stack.enter_context(patch.object(metrics, "R3_REPOSITORY_ROOT", fixture["repo"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_PATH", fixture["profile_path"], create=True))
            stack.enter_context(patch.object(metrics, "R3_PROFILE_SHA256", fixture["profile_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_START_PIN_SHA256", fixture["pin_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_ASSIGNMENTS_SHA256", fixture["workers_sha256"], create=True))
            stack.enter_context(patch.object(metrics, "R3_POLICY_SHA256", fixture["policy_sha256"], create=True))
            stack.enter_context(patch.object(work_event.Path, "cwd", return_value=fixture["worker_root"]))
            stack.enter_context(patch.object(work_event.Path, "resolve", resolve_with_escape))
            stack.enter_context(patch.object(work_event, "utc_now", return_value="2026-10-25T01:00:00Z"))
            with redirect_stderr(io.StringIO()):
                self.assertEqual(work_event.main(["--task-id", "M20.TEST", "--state", "start"]), 2)
        self.assertFalse((outside / "reports").exists())

if __name__ == "__main__":
    unittest.main()
