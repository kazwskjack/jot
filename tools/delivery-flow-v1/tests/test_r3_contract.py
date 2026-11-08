import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from argparse import Namespace
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import metrics
import work_event


TRIAL_ID = "jot-parallel-r3-20261025"
STARTED_AT = "2026-10-26T00:00:00Z"
ENDS_AT = "2026-10-26T02:00:00Z"
TASK_ID = "M20.AC01"


class R3ContractTests(unittest.TestCase):
    def setUp(self):
        scratch = Path(__file__).resolve().parents[1] / "test-tmp"
        scratch.mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=scratch)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / "worker-20"
        self.workspace.mkdir()
        self.diag = self.root / "docs" / "diagnostics" / "delivery-flow-v3-20261025"
        self.diag.mkdir(parents=True)
        self._make_authority_files()

    def tearDown(self):
        self.temp.cleanup()

    def write_json(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")
        path.write_bytes(payload)
        return hashlib.sha256(payload).hexdigest()

    def _make_authority_files(self):
        assignments_path = self.diag / "workers.json"
        policy_path = self.diag / "dispatch-policy.json"
        order_path = self.diag / "worker-20" / "work-order.json"
        snapshot_path = self.diag / "trial-start-snapshot.json"
        pin_path = self.diag / "trial-start-pin.json"
        self.assignments_sha = self.write_json(assignments_path, {
            "workers": [{"number": 20, "private_workspace": str(self.workspace)}],
        })
        self.policy_sha = self.write_json(policy_path, {"schema": "synthetic-policy.v1"})
        order = {
            "worker": 20,
            "private_workspace": str(self.workspace),
            "primary": {"id": TASK_ID},
            "backup": {"id": "M20.AC02"},
            "source_class_by_task": {
                TASK_ID: "new_development",
                "M20.AC02": "inherited_wip",
            },
        }
        order_sha = self.write_json(order_path, order)
        self.order_path = order_path
        self.order_bytes = order_path.read_bytes()
        snapshot = {
            "schema": "jot.r3.trial-start-snapshot.v1",
            "trial_id": TRIAL_ID,
            "trial": {
                "started": True,
                "real_product_trial_started": True,
                "started_at": STARTED_AT,
                "ends_at": ENDS_AT,
            },
            "work_orders": [{
                "worker": 20,
                "work_order_path": order_path.as_posix(),
                "work_order_sha256": order_sha,
                "primary_id": TASK_ID,
                "backup_id": "M20.AC02",
                "source_class_by_task": order["source_class_by_task"],
            }],
        }
        snapshot_sha = self.write_json(snapshot_path, snapshot)
        self.pin_sha = self.write_json(pin_path, {
            "schema": "jot.r3.trial-start-pin.v1",
            "trial_id": TRIAL_ID,
            "snapshot_path": snapshot_path.as_posix(),
            "snapshot_sha256": snapshot_sha,
            "immutable": True,
        })
        self.profile_path = self.diag / "runtime-profile.json"
        self.write_json(self.profile_path, {
            "schema": "jot.r3.runtime-profile.v1",
            "profile_id": TRIAL_ID,
            "repository": self.root.as_posix(),
            "assignments": {"path": assignments_path.as_posix(), "sha256": self.assignments_sha},
            "policy": {"path": policy_path.as_posix(), "sha256": self.policy_sha},
            "trial_start_snapshot": snapshot_path.as_posix(),
            "trial_start_pin": pin_path.as_posix(),
        })
        self.profile_sha = hashlib.sha256(self.profile_path.read_bytes()).hexdigest()
        self.profile_bytes = self.profile_path.read_bytes()
        self.pin_path = pin_path

    @contextmanager
    def pinned_authority(self):
        with patch.multiple(
            metrics,
            R3_REPOSITORY_ROOT=self.root,
            R3_PROFILE_PATH=self.profile_path,
            R3_PROFILE_SHA256=self.profile_sha,
            R3_START_PIN_SHA256=self.pin_sha,
            R3_ASSIGNMENTS_SHA256=self.assignments_sha,
            R3_POLICY_SHA256=self.policy_sha,
        ):
            yield

    def r3_event(self, event_id, event_type, at, basis, packet_id=None, **times):
        provenance = {
            "basis": basis,
            "process_observed_at": times.get("process_observed_at"),
            "actor_reported_at": times.get("actor_reported_at"),
            "native_observed_at": times.get("native_observed_at"),
        }
        selected_field = basis + "_at"
        provenance[selected_field] = at
        event = {
            "schema_version": 1,
            "event_id": event_id,
            "event_type": event_type,
            "occurred_at": at,
            "owner": "20",
            "packet_id": packet_id or "actor-task:20:" + TASK_ID,
            "task_owner": 20,
            "task_id": TASK_ID,
            "source_class": "new_development",
            "trial_id": TRIAL_ID,
            "timestamp_provenance": provenance,
        }
        if event_type == "next_primary":
            event["next_owner"] = times.get("next_owner", "20")
        return event

    def test_profile_and_immutable_start_pin_are_checked_against_fixed_hashes(self):
        with self.pinned_authority():
            authority = metrics.load_r3_start_authority()
            self.assertEqual(authority["trial_id"], TRIAL_ID)
            self.assertEqual(authority["workers_by_number"][20]["private_workspace"], str(self.workspace))
            self.assertEqual(authority["work_orders_by_worker"][20]["primary_id"], TASK_ID)

            self.profile_path.write_bytes(self.profile_bytes + b" ")
            with self.assertRaisesRegex(ValueError, "runtime profile SHA-256 does not match"):
                metrics.load_r3_start_authority()
            self.profile_path.write_bytes(self.profile_bytes)

            self.order_path.write_bytes(self.order_bytes + b" ")
            with self.assertRaisesRegex(ValueError, "pinned worker work order SHA-256 does not match"):
                metrics.load_r3_start_authority()
            self.order_path.write_bytes(self.order_bytes)

            self.pin_path.write_text(self.pin_path.read_text(encoding="utf-8") + " ", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "pin SHA-256 does not match"):
                metrics.load_r3_start_authority()

    def test_r3_timestamp_basis_must_be_present_and_match_occurred_at(self):
        valid = self.r3_event(
            "actor-start", "product_work_started", STARTED_AT, "actor_reported",
        )
        self.assertEqual(metrics._validate_event(valid, self.root)[0], valid)

        mismatch = dict(valid)
        mismatch["timestamp_provenance"] = dict(valid["timestamp_provenance"])
        mismatch["timestamp_provenance"]["actor_reported_at"] = "2026-10-26T00:00:01Z"
        with self.assertRaisesRegex(ValueError, "must match timestamp_provenance.actor_reported_at"):
            metrics._validate_event(mismatch, self.root)

        missing = dict(valid)
        missing["timestamp_provenance"] = dict(valid["timestamp_provenance"])
        missing["timestamp_provenance"]["actor_reported_at"] = None
        with self.assertRaisesRegex(ValueError, "is required for basis actor_reported"):
            metrics._validate_event(missing, self.root)

        absent = dict(valid)
        del absent["timestamp_provenance"]
        with self.assertRaisesRegex(ValueError, "requires timestamp_provenance"):
            metrics._validate_event(absent, self.root)

    def test_event_schema_keeps_provenance_fields_required_and_closed(self):
        schema_path = Path(__file__).resolve().parents[1] / "event.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        provenance = schema["definitions"]["timestampProvenance"]
        expected = {
            "basis", "process_observed_at", "actor_reported_at", "native_observed_at",
        }
        self.assertEqual(set(provenance["required"]), expected)
        self.assertFalse(provenance["additionalProperties"])
        r3_requirement = next(
            rule for rule in schema["allOf"]
            if rule.get("if", {}).get("properties", {}).get("trial_id", {}).get("const") == TRIAL_ID
        )
        self.assertIn("timestamp_provenance", r3_requirement["then"]["required"])

    def test_r3_event_source_class_matches_the_pinned_work_order(self):
        with self.pinned_authority():
            authority = metrics.load_r3_start_authority()
        event = self.r3_event("actor-start", "product_work_started", STARTED_AT, "actor_reported")
        metrics._validate_r3_event_work_order(event, authority, "test event")
        event["source_class"] = "inherited_wip"
        with self.assertRaisesRegex(ValueError, "source_class does not match the pinned work order"):
            metrics._validate_r3_event_work_order(event, authority, "test event")

        next_event = self.r3_event(
            "actor-next", "next_primary", STARTED_AT, "actor_reported", next_owner="20",
        )
        metrics._validate_r3_event_work_order(next_event, authority, "test event")
        next_event["next_owner"] = "worker-20"
        with self.assertRaisesRegex(ValueError, "next_owner does not match a pinned R3 worker"):
            metrics._validate_r3_event_work_order(next_event, authority, "test event")

    def test_running_trial_must_match_the_pinned_start_snapshot(self):
        commit, tree = "a" * 40, "b" * 40
        event = self.r3_event(
            "queue-ready", "ready", STARTED_AT, "process_observed",
            packet_id="source-revision-20",
        )
        event.update({"candidate_commit": commit, "candidate_tree": tree, "ready_at": STARTED_AT})
        event_path = self.root / "events" / "r3.jsonl"
        event_path.parent.mkdir()
        event_path.write_text(json.dumps(event) + "\n", encoding="utf-8")
        snapshot = {
            "captured_at": STARTED_AT,
            "candidate_commit": commit,
            "candidate_tree": tree,
            "ready_packet_ids": ["source-revision-20"],
            "active_packet_ids": [],
            "event_streams": [{
                "owner": "20",
                "path": event_path.relative_to(self.root).as_posix(),
                "sha256": hashlib.sha256(event_path.read_bytes()).hexdigest(),
            }],
        }
        trial = {
            "schema_version": 1,
            "trial_id": TRIAL_ID,
            "state": "running",
            "prepared_at": STARTED_AT,
            "duration_seconds": 7200,
            "historical_baseline": {
                "cycle_time_hours": 3.951902,
                "integrated_batches": 8,
                "source": {"path": "historical-baseline.json", "sha256": "0" * 64},
                "source_class_scope": "inherited_wip_included_unseparated",
            },
            "optimization_baseline": None,
            "started_at": STARTED_AT,
            "ended_at": None,
            "start_snapshot": snapshot,
            "end_snapshot": None,
        }

        with self.pinned_authority():
            result = metrics.validate_trial_record(trial, self.root)
            self.assertEqual(result["state"], "running")
            self.assertEqual(result["trial_start_evidence"]["pin_sha256"], self.pin_sha)

            wrong_window = json.loads(json.dumps(trial))
            wrong_window["started_at"] = "2026-10-26T00:00:01Z"
            wrong_window["start_snapshot"]["captured_at"] = wrong_window["started_at"]
            with self.assertRaisesRegex(ValueError, "does not match the pinned R3 snapshot"):
                metrics.validate_trial_record(wrong_window, self.root)

    def test_actor_task_intervals_are_separate_from_process_queue_packets(self):
        events = [
            self.r3_event("a-start", "product_work_started", STARTED_AT, "actor_reported"),
            self.r3_event("a-block", "blocked", "2026-10-26T00:10:00Z", "actor_reported"),
            self.r3_event("a-resume", "resumed", "2026-10-26T00:20:00Z", "actor_reported"),
            self.r3_event("a-ready", "ready", "2026-10-26T00:30:00Z", "actor_reported"),
            self.r3_event("a-next", "next_primary", "2026-10-26T00:40:00Z", "actor_reported", next_owner="20"),
            self.r3_event(
                "q-ready", "ready", STARTED_AT, "process_observed",
                packet_id="source-revision-1",
            ),
            self.r3_event(
                "q-received", "received", "2026-10-26T00:07:00Z", "process_observed",
                packet_id="source-revision-1",
            ),
        ]
        event_path = self.root / "events.jsonl"
        event_path.write_text("".join(json.dumps(event) + "\n" for event in events), encoding="utf-8")
        authority = {
            "started_at": STARTED_AT,
            "ends_at": ENDS_AT,
            "work_orders_by_worker": {20: {"source_class_by_task": {TASK_ID: "new_development"}}},
        }
        with patch.object(metrics, "load_r3_start_authority", return_value=authority), patch.object(
            metrics, "_validate_r3_event_work_order", return_value=None
        ):
            summary = metrics.summarize_event_files([event_path], self.root)

        self.assertEqual([packet["packet_id"] for packet in summary["packets"]], ["source-revision-1"])
        process_intervals = summary["packets"][0]["timing_intervals"]["process_observed"]
        self.assertEqual(process_intervals["ready_to_received"]["seconds"], 420)
        self.assertEqual(len(summary["task_timing_summaries"]), 1)
        task = summary["task_timing_summaries"][0]
        self.assertEqual(task["timestamp_basis"], "actor_reported")
        self.assertEqual(task["timing_intervals"]["work"]["seconds"], 1200)
        self.assertEqual(task["timing_intervals"]["blocked_wait"]["seconds"], 600)
        self.assertEqual(task["timing_intervals"]["ready_to_next_primary"]["seconds"], 600)

    def test_r3_rollup_rejects_events_outside_the_pinned_trial_window(self):
        with self.pinned_authority():
            for event_id, occurred_at in (
                ("before-window", "2026-10-25T23:59:59Z"),
                ("after-window", "2026-10-26T02:00:01Z"),
            ):
                with self.subTest(occurred_at=occurred_at):
                    event = self.r3_event(
                        event_id, "product_work_started", occurred_at, "actor_reported",
                    )
                    event_path = self.root / (event_id + ".jsonl")
                    event_path.write_text(json.dumps(event) + "\n", encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "outside the pinned R3 trial window"):
                        metrics.summarize_event_files([event_path], self.root)

    def recorder_authority(self):
        return {
            "trial_id": TRIAL_ID,
            "started_at": STARTED_AT,
            "ends_at": ENDS_AT,
            "workers_by_number": {20: {"number": 20, "private_workspace": str(self.workspace)}},
            "work_orders_by_worker": {20: {
                "primary_id": TASK_ID,
                "backup_id": "M20.AC02",
                "source_class_by_task": {TASK_ID: "new_development", "M20.AC02": "inherited_wip"},
            }},
        }

    def test_recorder_rejects_next_primary_destination_outside_pinned_workers(self):
        authority = self.recorder_authority()
        args = Namespace(task_id=TASK_ID, state="next_primary", next_owner="999")
        previous_cwd = Path.cwd()
        try:
            os.chdir(self.workspace)
            with patch.object(metrics, "load_r3_start_authority", return_value=authority), patch.object(
                work_event, "utc_now", return_value=STARTED_AT
            ):
                with self.assertRaisesRegex(ValueError, "next_owner does not match a pinned R3 worker"):
                    work_event.record_event(args)
        finally:
            os.chdir(previous_cwd)

    def test_event_stream_lock_stays_inside_the_pinned_workspace(self):
        foreign_stream = self.root / "owner-20.jsonl"
        with self.assertRaisesRegex(ValueError, "event lock file escapes the pinned worker workspace"):
            with work_event._event_stream_lock(foreign_stream, self.workspace):
                pass

    def test_recorder_serializes_cross_process_task_transitions(self):
        authority = self.recorder_authority()
        previous_cwd = Path.cwd()
        try:
            os.chdir(self.workspace)
            with patch.object(metrics, "load_r3_start_authority", return_value=authority), patch.object(
                work_event, "utc_now", return_value=STARTED_AT
            ):
                work_event.record_event(Namespace(task_id=TASK_ID, state="start", next_owner=None))
        finally:
            os.chdir(previous_cwd)

        authority_path = self.root / "authority.json"
        authority_path.write_text(json.dumps(authority), encoding="utf-8")
        ready_dir = self.root / "ready"
        ready_dir.mkdir()
        read_markers = self.root / "read-markers"
        read_markers.mkdir()
        gate = self.root / "start"
        child = self.root / "record-worker.py"
        child.write_text(
            """import json, os, sys, time
from argparse import Namespace
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import metrics, work_event
authority_path, ready_dir, read_markers, gate = map(Path, sys.argv[2:6])
worker = sys.argv[6]
authority = json.loads(authority_path.read_text(encoding='utf-8'))
authority['workers_by_number'] = {int(key): value for key, value in authority['workers_by_number'].items()}
authority['work_orders_by_worker'] = {int(key): value for key, value in authority['work_orders_by_worker'].items()}
metrics.load_r3_start_authority = lambda: authority
work_event.utc_now = lambda: '2026-10-26T00:10:00Z'
original_read = work_event._read_task_history
def synchronized_read(*args):
    rows = original_read(*args)
    (read_markers / str(os.getpid())).touch()
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if sum(1 for path in read_markers.iterdir() if path.is_file()) >= 2:
            break
        time.sleep(0.01)
    return rows
work_event._read_task_history = synchronized_read
(ready_dir / worker).touch()
while not gate.exists():
    time.sleep(0.01)
try:
    work_event.record_event(Namespace(task_id='M20.AC01', state='blocked', next_owner=None))
    print(json.dumps({'status': 'ok'}))
except Exception as exc:
    print(json.dumps({'status': 'error', 'message': str(exc)}))
""",
            encoding="utf-8",
        )
        module_root = str(Path(work_event.__file__).resolve().parent)
        processes = [
            subprocess.Popen(
                [
                    sys.executable, str(child), module_root, str(authority_path), str(ready_dir),
                    str(read_markers), str(gate), str(index),
                ],
                cwd=self.workspace,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for index in range(2)
        ]
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and sum(1 for path in ready_dir.iterdir() if path.is_file()) < 2:
                time.sleep(0.01)
            self.assertEqual(sum(1 for path in ready_dir.iterdir() if path.is_file()), 2)
            gate.write_text("go", encoding="utf-8")
            outcomes = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, stderr)
                outcomes.append(json.loads(stdout.strip().splitlines()[-1]))
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)

        self.assertEqual(sorted(item["status"] for item in outcomes), ["error", "ok"])
        error = next(item["message"] for item in outcomes if item["status"] == "error")
        self.assertIn("invalid task event transition", error)
        stream = self.workspace / "private" / "reports" / "r3" / "owner-20.jsonl"
        rows = [json.loads(line) for line in stream.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([row["event_type"] for row in rows], ["product_work_started", "blocked"])

    def test_recorder_appends_only_to_current_pinned_worker_stream(self):
        authority = self.recorder_authority()
        args = Namespace(task_id=TASK_ID, state="start", next_owner=None)
        times = iter((STARTED_AT, "2026-10-26T00:10:00Z"))
        previous_cwd = Path.cwd()
        try:
            os.chdir(self.workspace)
            with patch.object(metrics, "load_r3_start_authority", return_value=authority), patch.object(
                work_event, "utc_now", side_effect=lambda: next(times)
            ):
                first = work_event.record_event(args)
                args.state = "blocked"
                second = work_event.record_event(args)
        finally:
            os.chdir(previous_cwd)

        stream = self.workspace / "private" / "reports" / "r3" / "owner-20.jsonl"
        rows = [json.loads(line) for line in stream.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([row["event_type"] for row in rows], ["product_work_started", "blocked"])
        self.assertEqual(first["packet_id"], "actor-task:20:" + TASK_ID)
        self.assertEqual(second["timestamp_provenance"]["basis"], "actor_reported")
        self.assertEqual(rows[0]["timestamp_provenance"]["actor_reported_at"], STARTED_AT)


if __name__ == "__main__":
    unittest.main()
