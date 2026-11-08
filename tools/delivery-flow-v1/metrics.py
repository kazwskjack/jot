#!/usr/bin/env python3
"""Read-only workflow metrics; formal AC status is outside this tool."""

import argparse
import hashlib
import json
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


EVENT_TYPES = (
    "ready", "received", "integrated", "test", "rework", "accepted",
    "product_work_started", "blocked", "resumed", "next_primary",
)
SOURCE_CLASSES = ("inherited_wip", "new_development")
TIMING_BASES = ("actor_reported", "process_observed", "native_observed")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
GIT_ID_RE = re.compile(r"^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$")
UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
TRIAL_SECONDS = 7200
ACTIVE_EVENT_TYPES = frozenset(("received", "integrated", "test", "rework"))
READY_EVENT_TYPES = frozenset(("ready",))
R3_EVENT_TYPES = frozenset(("product_work_started", "blocked", "resumed", "next_primary"))
PROJECT_ROOT = Path(__file__).resolve().parents[2]
R_TRIAL_STATE_PATH = PROJECT_ROOT / "docs" / "diagnostics" / "delivery-flow-v1-20261024" / "trial-start-snapshot.json"
# R must freeze this snapshot and supply its SHA-256 before a reviewed source
# update can enable validation of any running/completed product-trial record.
R_TRIAL_STATE_SHA256 = "fd01a50d5f9bb534ac92c131603952edd2e239474be8947d34011b998eff4d96"
R2_TRIAL_IDS = frozenset(("delivery-flow-v1-120m", "jot-parallel-r2-20261024"))
R3_TRIAL_ID = "jot-parallel-r3-20261025"
R3_ACTOR_PACKET_ID_PREFIX = "actor-task:"
R3_REPOSITORY_ROOT = Path("E:/codex/yunticket")
R3_PROFILE_PATH = R3_REPOSITORY_ROOT / "docs" / "diagnostics" / "delivery-flow-v3-20261025" / "runtime-profile.json"
R3_PROFILE_SHA256 = "af095aac34ce65a2d40b224a6ab500c8a9810a00b8c48b9f570bd7912eb130b1"
R3_START_PIN_SHA256 = "70cedd7c48a45c995326723726a7f85826fe7063dacef09536688547040b9b99"
R3_ASSIGNMENTS_SHA256 = "4e2d0e7aec2c9b5ff5d6618645b698ceedb1675c16f0f50b027a64982c77b74c"
R3_POLICY_SHA256 = "358c3c46ed57bae212609dc05b6efce5cb3448bf0303e00d97b8ba142be68f2c"


def _required_string(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("%s must be a non-empty string" % field)
    return value


def _unique_object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key: %s" % key)
        result[key] = value
    return result


def _reject_json_constant(value):
    raise ValueError("non-standard JSON constant: %s" % value)


def _strict_json_loads(value):
    return json.loads(value, object_pairs_hook=_unique_object_pairs, parse_constant=_reject_json_constant)


def _utc_time(value, field="occurred_at"):
    if not isinstance(value, str) or not UTC_RE.fullmatch(value):
        raise ValueError("%s must be UTC RFC3339 ending in Z" % field)
    stamp = value[:-1]
    try:
        parsed = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S.%f" if "." in stamp else "%Y-%m-%dT%H:%M:%S")
    except ValueError as exc:
        raise ValueError("%s must be a valid UTC RFC3339 timestamp" % field) from exc
    return parsed.replace(tzinfo=timezone.utc)


def _resolve_file(root, value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("%s path must be a non-empty string" % label)
    supplied = Path(value)
    candidate = supplied if supplied.is_absolute() else root / supplied
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except FileNotFoundError as exc:
        raise ValueError("%s file is missing: %s" % (label, value)) from exc
    except (OSError, ValueError) as exc:
        raise ValueError("%s path escapes evidence root or is unreadable: %s" % (label, value)) from exc
    if not resolved.is_file():
        raise ValueError("%s path is not a file: %s" % (label, value))
    return resolved


def _verify_file_hash(path, expected, label):
    if not isinstance(expected, str) or not SHA256_RE.fullmatch(expected):
        raise ValueError("%s must be a SHA-256 hex digest" % label)
    data = path.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected.lower():
        raise ValueError("%s SHA-256 does not match referenced file" % label)
    return data, actual


def _validate_test_evidence(evidence, evidence_root):
    if not isinstance(evidence, dict) or evidence.get("kind") != "test_result":
        raise ValueError("test event requires result evidence")
    result = evidence.get("result")
    if not isinstance(result, str) or result not in ("passed", "failed"):
        raise ValueError("test result evidence requires result passed or failed")
    _required_string(evidence.get("job_id"), "job_id")
    exit_code = evidence.get("exit_code")
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        raise ValueError("test result evidence requires an integer exit_code")
    if (result == "passed") != (exit_code == 0):
        raise ValueError("test result must agree with exit_code")
    path = _resolve_file(evidence_root, evidence.get("path"), "test evidence")
    _verify_file_hash(path, evidence.get("sha256"), "test evidence")


def _validate_event(event, evidence_root):
    if not isinstance(event, dict):
        raise ValueError("each event must be a JSON object")
    if type(event.get("schema_version")) is not int or event["schema_version"] != 1:
        raise ValueError("schema_version must be 1")
    _required_string(event.get("event_id"), "event_id")
    event_type = _required_string(event.get("event_type"), "event_type")
    if event_type not in EVENT_TYPES:
        raise ValueError("event_type must be one of %s" % ", ".join(EVENT_TYPES))
    occurred = _utc_time(event.get("occurred_at"))
    _required_string(event.get("owner"), "owner")
    _required_string(event.get("packet_id"), "packet_id")
    source_class = event.get("source_class")
    if source_class not in SOURCE_CLASSES:
        raise ValueError("source_class must be one of %s" % ", ".join(SOURCE_CLASSES))
    if "trial_id" in event or event_type in R3_EVENT_TYPES:
        _required_string(event.get("trial_id"), "trial_id")
    if event_type in R3_EVENT_TYPES and event.get("trial_id") != R3_TRIAL_ID:
        raise ValueError("%s event requires the fixed R3 trial ID" % event_type)
    if event.get("trial_id") == R3_TRIAL_ID:
        if type(event.get("task_owner")) is not int or event["task_owner"] < 1:
            raise ValueError("R3 event requires a positive integer task_owner")
        _required_string(event.get("task_id"), "task_id")
    _validate_timing_provenance(event)
    if event.get("trial_id") == R3_TRIAL_ID:
        if _is_r3_actor_reported(event):
            expected_packet_id = "%s%d:%s" % (
                R3_ACTOR_PACKET_ID_PREFIX, event["task_owner"], event["task_id"],
            )
            if event["packet_id"] != expected_packet_id:
                raise ValueError("R3 actor-reported packet_id must use its reserved task grouping key")
        elif event["packet_id"].startswith(R3_ACTOR_PACKET_ID_PREFIX):
            raise ValueError("R3 source packet_id cannot use the reserved actor-task prefix")

    for field in ("candidate_commit", "candidate_tree"):
        if field in event and not GIT_ID_RE.fullmatch(_required_string(event[field], field)):
            raise ValueError("%s must be a full commit/tree hex ID" % field)
    if "manifest_path" in event or "manifest_sha256" in event:
        if "manifest_path" not in event or "manifest_sha256" not in event:
            raise ValueError("manifest_path and manifest_sha256 must be provided together")
        _required_string(event["manifest_path"], "manifest_path")
        if not isinstance(event["manifest_sha256"], str) or not SHA256_RE.fullmatch(event["manifest_sha256"]):
            raise ValueError("manifest_sha256 must be a SHA-256 hex digest")
    if "evidence_path" in event or "evidence_sha256" in event:
        if "evidence_path" not in event or "evidence_sha256" not in event:
            raise ValueError("evidence_path and evidence_sha256 must be provided together")
        path = _resolve_file(evidence_root, event["evidence_path"], "event evidence")
        _verify_file_hash(path, event["evidence_sha256"], "event evidence")
    for field in ("ac_ids", "dependencies"):
        if field in event and (
            not isinstance(event[field], list)
            or any(not isinstance(item, str) or not item.strip() for item in event[field])
        ):
            raise ValueError("%s must be an array of non-empty strings" % field)
    if "ac_ids" in event and len(set(event["ac_ids"])) != len(event["ac_ids"]):
        raise ValueError("ac_ids must not contain duplicates")
    for field in ("next_owner", "claim_id", "queue_action"):
        if field in event:
            _required_string(event[field], field)
    if event_type == "next_primary" and "next_owner" not in event:
        raise ValueError("next_primary event requires next_owner")
    if "ready_at" in event:
        _utc_time(event["ready_at"], "ready_at")
    if event_type == "test":
        _validate_test_evidence(event.get("evidence"), evidence_root)
    # accepted is a workflow event only; formal AC status is outside this tool.
    return event, occurred


def _validate_timing_provenance(event):
    event_type = event["event_type"]
    trial_id = event.get("trial_id")
    provenance = event.get("timestamp_provenance")
    if provenance is None:
        if trial_id == R3_TRIAL_ID or event_type in ("product_work_started", "blocked", "resumed", "next_primary"):
            raise ValueError("%s event requires timestamp_provenance" % event_type)
        return
    fields = ("basis", "process_observed_at", "actor_reported_at", "native_observed_at")
    _schema_object(provenance, "timestamp_provenance", fields, fields)
    basis = provenance["basis"]
    if basis not in TIMING_BASES:
        raise ValueError("timestamp_provenance.basis must be one of %s" % ", ".join(TIMING_BASES))
    time_fields = {
        "process_observed": "process_observed_at",
        "actor_reported": "actor_reported_at",
        "native_observed": "native_observed_at",
    }
    for field in time_fields.values():
        value = provenance[field]
        if value is not None:
            _utc_time(value, "timestamp_provenance.%s" % field)
    basis_field = time_fields[basis]
    if provenance[basis_field] is None:
        raise ValueError("timestamp_provenance.%s is required for basis %s" % (basis_field, basis))
    if provenance[basis_field] != event["occurred_at"]:
        raise ValueError("occurred_at must match timestamp_provenance.%s" % basis_field)


def read_event_files(event_files, evidence_root):
    root = Path(evidence_root).resolve(strict=True)
    unique = {}
    duplicates = 0
    for file_name in event_files:
        path = Path(file_name)
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError) as exc:
            raise ValueError("cannot read event file %s: %s" % (path, exc)) from exc
        for line_number, line in enumerate(lines, 1):
            if not line.strip():
                continue
            try:
                event, occurred = _validate_event(_strict_json_loads(line), root)
            except (json.JSONDecodeError, ValueError) as exc:
                raise ValueError("%s:%s: %s" % (path, line_number, exc)) from exc
            event_id = event["event_id"]
            canonical = json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if event_id in unique:
                if unique[event_id][2] != canonical:
                    raise ValueError("conflicting duplicate event_id: %s" % event_id)
                duplicates += 1
                continue
            unique[event_id] = (event, occurred, canonical)

    packet_source = {}
    for event, _occurred, _canonical in unique.values():
        packet_id = event["packet_id"]
        source = event["source_class"]
        if packet_id in packet_source and packet_source[packet_id] != source:
            raise ValueError("source_class changed for packet: %s" % packet_id)
        packet_source[packet_id] = source
    ordered = sorted(((row[0], row[1]) for row in unique.values()), key=lambda row: (row[1], row[0]["event_id"]))
    return ordered, duplicates


def _timeline_item(event):
    item = {key: event[key] for key in ("event_id", "event_type", "occurred_at", "owner")}
    for key in (
        "trial_id", "task_owner", "task_id", "timestamp_provenance", "candidate_commit", "candidate_tree", "manifest_path", "manifest_sha256",
        "dependencies", "next_owner", "ready_at", "claim_id", "queue_action",
        "evidence_path", "evidence_sha256",
    ):
        if key in event:
            item[key] = event[key]
    if "ac_ids" in event:
        item["ac_ids"] = event["ac_ids"]
    evidence = event.get("evidence")
    if isinstance(evidence, dict):
        item["evidence"] = {
            key: evidence[key]
            for key in ("kind", "path", "sha256", "result", "job_id", "exit_code")
            if key in evidence
        }
    return item


def _paired_interval_summary(events, start_types, end_types):
    intervals = []
    unknown_count = 0
    pending = None
    for event, occurred in events:
        if event["event_type"] in start_types:
            if pending is not None:
                unknown_count += 1
            pending = (event, occurred)
        elif event["event_type"] in end_types:
            if pending is None:
                unknown_count += 1
                continue
            start_event, started = pending
            pending = None
            seconds = (occurred - started).total_seconds()
            if seconds <= 0:
                unknown_count += 1
                continue
            intervals.append({
                "start_event_id": start_event["event_id"],
                "end_event_id": event["event_id"],
                "started_at": start_event["occurred_at"],
                "ended_at": event["occurred_at"],
                "seconds": int(seconds) if seconds.is_integer() else seconds,
            })
    if pending is not None:
        unknown_count += 1
    complete_seconds = sum(item["seconds"] for item in intervals) if intervals else None
    total_seconds = complete_seconds if intervals and unknown_count == 0 else None
    return {
        "seconds": total_seconds,
        "complete_seconds": complete_seconds,
        "complete_interval_count": len(intervals),
        "unknown_interval_count": unknown_count,
        "intervals": intervals,
    }


def _timing_intervals(rows):
    result = {}
    for basis in TIMING_BASES:
        time_field = basis + "_at"
        sourced = []
        for event, _occurred in rows:
            provenance = event.get("timestamp_provenance")
            if isinstance(provenance, dict) and provenance.get("basis") == basis:
                sourced.append((event, _utc_time(provenance[time_field], "timestamp_provenance.%s" % time_field)))
        sourced.sort(key=lambda row: (row[1], row[0]["event_id"]))
        result[basis] = {
            "work": _paired_interval_summary(
                sourced,
                frozenset(("product_work_started", "resumed")),
                frozenset(("blocked", "ready")),
            ),
            "blocked_wait": _paired_interval_summary(
                sourced, frozenset(("blocked",)), frozenset(("resumed",)),
            ),
            "ready_to_next_primary": _paired_interval_summary(
                sourced, frozenset(("ready",)), frozenset(("next_primary",)),
            ),
            "ready_to_received": _paired_interval_summary(
                sourced, frozenset(("ready",)), frozenset(("received",)),
            ),
        }
    return result


def _actor_task_timing(rows):
    sourced = [
        (event, _utc_time(event["timestamp_provenance"]["actor_reported_at"], "timestamp_provenance.actor_reported_at"))
        for event, _occurred in rows
    ]
    sourced.sort(key=lambda row: (row[1], row[0]["event_id"]))
    return {
        "work": _paired_interval_summary(
            sourced,
            frozenset(("product_work_started", "resumed")),
            frozenset(("blocked", "ready")),
        ),
        "blocked_wait": _paired_interval_summary(
            sourced, frozenset(("blocked",)), frozenset(("resumed",)),
        ),
        "ready_to_next_primary": _paired_interval_summary(
            sourced, frozenset(("ready",)), frozenset(("next_primary",)),
        ),
    }


def summarize_event_files(event_files, evidence_root):
    root = Path(evidence_root).resolve(strict=True)
    events, duplicates = read_event_files(event_files, root)
    r3_events = [event for event, _occurred in events if event.get("trial_id") == R3_TRIAL_ID]
    if r3_events:
        authority = load_r3_start_authority()
        trial_start = _utc_time(authority["started_at"], "R3 snapshot trial.started_at")
        trial_end = _utc_time(authority["ends_at"], "R3 snapshot trial.ends_at")
        for event, occurred in events:
            if event.get("trial_id") != R3_TRIAL_ID:
                continue
            if not trial_start <= occurred <= trial_end:
                raise ValueError("R3 metrics event is outside the pinned R3 trial window")
            _validate_r3_event_work_order(event, authority, "R3 metrics event")
    all_counts = Counter()
    by_source = {source: {"packet_count": 0, "event_counts": {kind: 0 for kind in EVENT_TYPES}} for source in SOURCE_CLASSES}
    packets = defaultdict(list)
    actor_tasks = defaultdict(list)
    for event, occurred in events:
        event_type = event["event_type"]
        source = event["source_class"]
        all_counts[event_type] += 1
        by_source[source]["event_counts"][event_type] += 1
        if _is_r3_actor_reported(event):
            actor_key = (event["task_owner"], event["task_id"], event["owner"], source)
            actor_tasks[actor_key].append((event, occurred))
        else:
            packets[event["packet_id"]].append((event, occurred))

    packet_summaries = []
    for packet_id in sorted(packets):
        rows = packets[packet_id]
        source = rows[0][0]["source_class"]
        by_source[source]["packet_count"] += 1
        first = {}
        rework_times = []
        for event, occurred in rows:
            event_type = event["event_type"]
            if event_type == "rework":
                rework_times.append(event["occurred_at"])
            else:
                first.setdefault(event_type, (event, occurred))
        milestones = {kind: first[kind][0]["occurred_at"] for kind in EVENT_TYPES if kind in first}
        elapsed = {}
        for earlier, later, name in (
            ("ready", "received", "ready_to_received"),
            ("received", "integrated", "received_to_integrated"),
            ("integrated", "test", "integrated_to_test"),
            ("test", "accepted", "test_to_accepted"),
        ):
            if earlier in first and later in first:
                seconds = (first[later][1] - first[earlier][1]).total_seconds()
                if seconds < 0:
                    raise ValueError("milestone time order is invalid for packet %s" % packet_id)
                elapsed[name] = int(seconds) if seconds.is_integer() else seconds
        packet_summaries.append({
            "packet_id": packet_id,
            "source_class": source,
            "event_counts": {kind: sum(event["event_type"] == kind for event, _ in rows) for kind in EVENT_TYPES},
            "milestones": milestones,
            "rework_times": rework_times,
            "elapsed_seconds": elapsed,
            "timing_intervals": _timing_intervals(rows),
            "timeline": [_timeline_item(event) for event, _ in rows],
        })
    task_timing_summaries = [
        {
            "task_owner": task_owner,
            "task_id": task_id,
            "owner": owner,
            "source_class": source_class,
            "timestamp_basis": "actor_reported",
            "timing_intervals": _actor_task_timing(rows),
        }
        for (task_owner, task_id, owner, source_class), rows in sorted(actor_tasks.items())
    ]
    result = {
        "schema_version": 1,
        "event_count": len(events),
        "duplicate_events_ignored": duplicates,
        "event_counts": {kind: all_counts[kind] for kind in EVENT_TYPES},
        "by_source_class": by_source,
        "packets": packet_summaries,
    }
    if r3_events:
        result["task_timing_summaries"] = task_timing_summaries
    return result


def _schema_object(value, label, required, allowed):
    if not isinstance(value, dict):
        raise ValueError("%s must be a JSON object" % label)
    missing = set(required) - set(value)
    if missing:
        raise ValueError("%s missing required fields: %s" % (label, ", ".join(sorted(missing))))
    extra = set(value) - set(allowed)
    if extra:
        raise ValueError("%s has unexpected fields: %s" % (label, ", ".join(sorted(extra))))
    return value


def _schema_text(value, field):
    if not isinstance(value, str) or len(value) < 1:
        raise ValueError("%s must be a non-empty string" % field)
    return value


def _validate_snapshot_schema(snapshot, label):
    fields = ("captured_at", "candidate_commit", "candidate_tree", "ready_packet_ids", "active_packet_ids", "event_streams")
    _schema_object(snapshot, label, fields, fields)
    _utc_time(snapshot["captured_at"], "%s.captured_at" % label)
    for field in ("candidate_commit", "candidate_tree"):
        value = _schema_text(snapshot[field], "%s.%s" % (label, field))
        if not GIT_ID_RE.fullmatch(value):
            raise ValueError("%s.%s must be a full commit/tree hex ID" % (label, field))
    for field in ("ready_packet_ids", "active_packet_ids"):
        values = snapshot[field]
        if not isinstance(values, list) or any(not isinstance(item, str) or len(item) < 1 for item in values):
            raise ValueError("%s.%s must be an array of non-empty strings" % (label, field))
        if len(set(values)) != len(values):
            raise ValueError("%s.%s must not contain duplicates" % (label, field))
    if not set(snapshot["ready_packet_ids"]).isdisjoint(snapshot["active_packet_ids"]):
        raise ValueError("%s ready and active packet sets must be disjoint" % label)
    streams = snapshot["event_streams"]
    if not isinstance(streams, list) or not streams:
        raise ValueError("%s.event_streams must contain at least one stream" % label)
    stream_fields = ("owner", "path", "sha256")
    for index, stream in enumerate(streams):
        stream_label = "%s.event_streams[%d]" % (label, index)
        _schema_object(stream, stream_label, stream_fields, stream_fields)
        _schema_text(stream["owner"], "%s.owner" % stream_label)
        _schema_text(stream["path"], "%s.path" % stream_label)
        if not isinstance(stream["sha256"], str) or not SHA256_RE.fullmatch(stream["sha256"]):
            raise ValueError("%s.sha256 must be a SHA-256 hex digest" % stream_label)


def _validate_trial_schema(trial):
    fields = (
        "schema_version", "trial_id", "state", "prepared_at", "duration_seconds",
        "historical_baseline", "optimization_baseline", "started_at", "ended_at",
        "start_snapshot", "end_snapshot",
    )
    _schema_object(trial, "trial", fields, fields)
    if type(trial["schema_version"]) is not int or trial["schema_version"] != 1:
        raise ValueError("trial schema_version must be 1")
    _schema_text(trial["trial_id"], "trial_id")
    state = trial["state"]
    if state not in ("prepared_not_started", "running", "completed"):
        raise ValueError("trial state must be prepared_not_started, running, or completed")
    _utc_time(trial["prepared_at"], "prepared_at")
    if type(trial["duration_seconds"]) is not int or trial["duration_seconds"] != TRIAL_SECONDS:
        raise ValueError("trial duration_seconds must be exactly 7200")

    baseline_fields = ("cycle_time_hours", "integrated_batches", "source", "source_class_scope")
    baseline = _schema_object(trial["historical_baseline"], "historical_baseline", baseline_fields, baseline_fields)
    cycle_time = baseline["cycle_time_hours"]
    if type(cycle_time) not in (int, float) or cycle_time != 3.951902:
        raise ValueError("historical_baseline.cycle_time_hours must be 3.951902")
    if type(baseline["integrated_batches"]) is not int or baseline["integrated_batches"] != 8:
        raise ValueError("historical_baseline.integrated_batches must be 8")
    source_fields = ("path", "sha256")
    source = _schema_object(baseline["source"], "historical_baseline.source", source_fields, source_fields)
    _schema_text(source["path"], "historical_baseline.source.path")
    if not isinstance(source["sha256"], str) or not SHA256_RE.fullmatch(source["sha256"]):
        raise ValueError("historical_baseline.source.sha256 must be a SHA-256 hex digest")
    if baseline["source_class_scope"] != "inherited_wip_included_unseparated":
        raise ValueError("historical_baseline.source_class_scope is invalid")

    if trial["optimization_baseline"] is not None:
        _validate_snapshot_schema(trial["optimization_baseline"], "optimization_baseline")
    for field in ("started_at", "ended_at"):
        value = trial[field]
        if value is not None:
            _utc_time(value, field)
    for field in ("start_snapshot", "end_snapshot"):
        if trial[field] is not None:
            _validate_snapshot_schema(trial[field], field)

    if state == "prepared_not_started":
        if any(trial[field] is not None for field in ("started_at", "ended_at", "start_snapshot", "end_snapshot")):
            raise ValueError("prepared trial must not have start/end times or snapshots")
    elif state == "running":
        if trial["started_at"] is None or trial["ended_at"] is not None:
            raise ValueError("running trial requires only a start time")
        if trial["start_snapshot"] is None or trial["end_snapshot"] is not None:
            raise ValueError("running trial requires only a start snapshot")
        if trial["start_snapshot"]["captured_at"] != trial["started_at"]:
            raise ValueError("start snapshot must match started_at")
    else:
        if trial["started_at"] is None or trial["ended_at"] is None:
            raise ValueError("completed trial requires start and end times")
        if trial["start_snapshot"] is None or trial["end_snapshot"] is None:
            raise ValueError("completed trial requires start and end snapshots")
        started = _utc_time(trial["started_at"], "started_at")
        ended = _utc_time(trial["ended_at"], "ended_at")
        if (ended - started).total_seconds() != TRIAL_SECONDS:
            raise ValueError("completed trial must be exactly 7200 seconds")
        if trial["start_snapshot"]["captured_at"] != trial["started_at"]:
            raise ValueError("start snapshot must match started_at")
        if trial["end_snapshot"]["captured_at"] != trial["ended_at"]:
            raise ValueError("end snapshot must match ended_at")
    return state


def _validate_snapshot_evidence(snapshot, evidence_root, label, expected_trial_id=None, r3_authority=None):
    root = Path(evidence_root).resolve(strict=True)
    stream_files = []
    captured = _utc_time(snapshot["captured_at"], "%s.captured_at" % label)
    for index, stream in enumerate(snapshot["event_streams"]):
        stream_label = "%s event stream %d" % (label, index)
        path = _resolve_file(root, stream["path"], stream_label)
        _verify_file_hash(path, stream["sha256"], stream_label)
        rows, _ = read_event_files([path], root)
        for event, occurred in rows:
            if event["owner"] != stream["owner"]:
                raise ValueError("%s owner does not match event owner" % stream_label)
            if expected_trial_id is not None and event.get("trial_id") != expected_trial_id:
                raise ValueError("%s event trial_id does not match the fixed trial record" % stream_label)
            if r3_authority is not None:
                _validate_r3_event_work_order(event, r3_authority, stream_label)
            if occurred > captured:
                raise ValueError("%s contains an event after snapshot captured_at" % stream_label)
        stream_files.append(path)
    # Merge once across all owners so conflicting IDs fail and duplicate records
    # cannot distort the last-event state used to reconstruct the packet sets.
    events, _ = read_event_files(stream_files, root)
    latest = {}
    for event, occurred in events:
        if _is_r3_actor_reported(event):
            continue
        packet_id = event["packet_id"]
        previous = latest.get(packet_id)
        if previous is not None and occurred == previous[0]:
            raise ValueError("%s has ambiguous same-time events for packet %s" % (label, packet_id))
        if previous is None or occurred > previous[0]:
            latest[packet_id] = (occurred, event)

    actual_ready = {
        packet_id for packet_id, (_occurred, event) in latest.items()
        if event["event_type"] in READY_EVENT_TYPES
    }
    actual_active = {
        packet_id for packet_id, (_occurred, event) in latest.items()
        if event["event_type"] in ACTIVE_EVENT_TYPES
    }
    declared_ready = set(snapshot["ready_packet_ids"])
    declared_active = set(snapshot["active_packet_ids"])
    if declared_ready != actual_ready or declared_active != actual_active:
        raise ValueError("%s packet sets do not match event stream state" % label)

    for packet_id in declared_ready | declared_active:
        event = latest[packet_id][1]
        if (
            event.get("candidate_commit") != snapshot["candidate_commit"]
            or event.get("candidate_tree") != snapshot["candidate_tree"]
        ):
            raise ValueError("%s packet %s lacks current candidate-bound event evidence" % (label, packet_id))


def _validate_r3_event_work_order(event, authority, label):
    task_owner = event["task_owner"]
    work_order = authority["work_orders_by_worker"].get(task_owner)
    if work_order is None:
        raise ValueError("%s R3 event task_owner has no pinned work order" % label)
    expected_source_class = work_order["source_class_by_task"].get(event["task_id"])
    if expected_source_class is None:
        raise ValueError("%s R3 event task_id is not in task_owner's pinned work order" % label)
    if event["source_class"] != expected_source_class:
        raise ValueError("%s R3 event source_class does not match the pinned work order" % label)
    if event["event_type"] == "next_primary":
        allowed_owners = {str(number) for number in authority["workers_by_number"]}
        if event.get("next_owner") not in allowed_owners:
            raise ValueError("%s next_owner does not match a pinned R3 worker" % label)


def _is_r3_actor_reported(event):
    provenance = event.get("timestamp_provenance")
    return (
        event.get("trial_id") == R3_TRIAL_ID
        and isinstance(provenance, dict)
        and provenance.get("basis") == "actor_reported"
    )


def _validate_trial_start_state(trial, evidence_root):
    if not isinstance(R_TRIAL_STATE_SHA256, str) or not SHA256_RE.fullmatch(R_TRIAL_STATE_SHA256):
        raise ValueError("running or completed trial requires a source-pinned R trial_start phase-state SHA-256")
    root = Path(evidence_root).resolve(strict=True)
    try:
        path = Path(R_TRIAL_STATE_PATH).resolve(strict=True)
        path.relative_to(root)
    except FileNotFoundError as exc:
        raise ValueError("R trial_start pinned phase-state file is missing: %s" % R_TRIAL_STATE_PATH) from exc
    except (OSError, ValueError) as exc:
        raise ValueError("R trial_start phase-state path is outside evidence root or unreadable") from exc
    data, actual = _verify_file_hash(path, R_TRIAL_STATE_SHA256, "source-pinned R trial_start phase-state")
    try:
        state = _strict_json_loads(data.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError("R trial_start phase-state is not strict JSON: %s" % exc) from exc
    phase_trial = state.get("trial") if isinstance(state, dict) else None
    if not isinstance(phase_trial, dict):
        raise ValueError("R trial_start phase-state is missing trial object")
    if state.get("real_product_trial_started") is not True:
        raise ValueError("R phase-state does not authorize a real product trial start")
    authorized_start = phase_trial.get("started_at")
    authorized_end = phase_trial.get("ends_at")
    started = _utc_time(authorized_start, "phase-state.trial.started_at")
    ended = _utc_time(authorized_end, "phase-state.trial.ends_at")
    if (ended - started).total_seconds() != TRIAL_SECONDS:
        raise ValueError("phase-state trial window must be exactly 7200 seconds")
    if trial["started_at"] != authorized_start:
        raise ValueError("trial started_at does not match R phase-state trial.started_at")
    if trial["state"] == "completed" and trial["ended_at"] != authorized_end:
        raise ValueError("trial ended_at does not match R phase-state trial.ends_at")
    return {"path": str(path), "sha256": actual}


def load_r3_start_authority():
    root = Path(R3_REPOSITORY_ROOT).resolve(strict=True)
    profile_path = Path(R3_PROFILE_PATH).resolve(strict=True)
    try:
        profile_path.relative_to(root)
    except ValueError as exc:
        raise ValueError("fixed R3 runtime profile path is outside the repository root") from exc
    profile_data = profile_path.read_bytes()
    profile_sha = hashlib.sha256(profile_data).hexdigest()
    if profile_sha != R3_PROFILE_SHA256:
        raise ValueError("fixed R3 runtime profile SHA-256 does not match")
    try:
        profile = _strict_json_loads(profile_data.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError("fixed R3 runtime profile is not strict JSON: %s" % exc) from exc
    if not isinstance(profile, dict) or profile.get("schema") != "jot.r3.runtime-profile.v1":
        raise ValueError("fixed R3 runtime profile schema is invalid")
    if profile.get("profile_id") != R3_TRIAL_ID:
        raise ValueError("fixed R3 runtime profile ID is invalid")
    if profile.get("repository") != root.as_posix():
        raise ValueError("fixed R3 runtime profile repository is invalid")

    tool_root = root / "docs" / "diagnostics" / "delivery-flow-v3-20261025"
    references = (
        ("assignments", "workers.json", R3_ASSIGNMENTS_SHA256),
        ("policy", "dispatch-policy.json", R3_POLICY_SHA256),
    )
    verified_references = {}
    for name, filename, expected_sha in references:
        reference = profile.get(name)
        expected_path = (tool_root / filename).resolve(strict=True)
        try:
            expected_path.relative_to(root)
        except ValueError as exc:
            raise ValueError("fixed R3 profile %s path escapes the repository root" % name) from exc
        if not isinstance(reference, dict) or reference.get("sha256") != expected_sha:
            raise ValueError("fixed R3 profile %s pin is invalid" % name)
        referenced_path = Path(reference.get("path", "")).resolve(strict=True)
        if referenced_path != expected_path:
            raise ValueError("fixed R3 profile %s path is invalid" % name)
        reference_data, _ = _verify_file_hash(expected_path, expected_sha, "fixed R3 %s" % name)
        try:
            verified_references[name] = _strict_json_loads(reference_data.decode("utf-8-sig"))
        except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise ValueError("fixed R3 %s file is not strict JSON: %s" % (name, exc)) from exc

    assignments = verified_references["assignments"]
    workers = assignments.get("workers") if isinstance(assignments, dict) else None
    if not isinstance(workers, list):
        raise ValueError("fixed R3 assignments must contain a workers array")
    workers_by_number = {}
    for worker in workers:
        if not isinstance(worker, dict) or type(worker.get("number")) is not int:
            raise ValueError("fixed R3 assignment has an invalid worker number")
        number = worker["number"]
        if number in workers_by_number:
            raise ValueError("fixed R3 assignments contain a duplicate worker number")
        private_workspace = worker.get("private_workspace")
        if not isinstance(private_workspace, str) or not private_workspace.strip():
            raise ValueError("fixed R3 assignment has no private_workspace")
        try:
            workspace_path = Path(private_workspace).resolve(strict=True)
        except (OSError, ValueError) as exc:
            raise ValueError("fixed R3 worker private_workspace is missing or unreadable") from exc
        try:
            workspace_path.relative_to(root)
        except ValueError as exc:
            raise ValueError("fixed R3 worker private_workspace escapes the repository root") from exc
        workers_by_number[number] = {**worker, "private_workspace": str(workspace_path)}

    fixed_snapshot_path = (tool_root / "trial-start-snapshot.json").resolve(strict=False)
    fixed_pin_path = (tool_root / "trial-start-pin.json").resolve(strict=False)
    if profile.get("trial_start_snapshot") != fixed_snapshot_path.as_posix():
        raise ValueError("fixed R3 profile trial-start snapshot path is invalid")
    if profile.get("trial_start_pin") != fixed_pin_path.as_posix():
        raise ValueError("fixed R3 profile trial-start pin path is invalid")
    try:
        snapshot_path = fixed_snapshot_path.resolve(strict=True)
        pin_path = fixed_pin_path.resolve(strict=True)
    except FileNotFoundError as exc:
        raise ValueError("fixed R3 trial-start pin or snapshot is missing") from exc
    try:
        snapshot_path.relative_to(root)
        pin_path.relative_to(root)
    except ValueError as exc:
        raise ValueError("fixed R3 trial-start evidence path escapes the repository root") from exc

    try:
        pin_data = pin_path.read_bytes()
    except FileNotFoundError as exc:
        raise ValueError("fixed R3 trial-start pin is missing") from exc
    except OSError as exc:
        raise ValueError("fixed R3 trial-start pin is not readable: %s" % exc) from exc
    pin_sha = hashlib.sha256(pin_data).hexdigest()
    if pin_sha != R3_START_PIN_SHA256:
        raise ValueError("fixed R3 trial-start pin SHA-256 does not match")
    try:
        pin = _strict_json_loads(pin_data.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError("fixed R3 trial-start pin is not strict JSON: %s" % exc) from exc
    pin_fields = ("schema", "trial_id", "snapshot_path", "snapshot_sha256", "immutable")
    _schema_object(pin, "R3 trial-start pin", pin_fields, pin_fields)
    if pin["schema"] != "jot.r3.trial-start-pin.v1" or pin["trial_id"] != R3_TRIAL_ID:
        raise ValueError("R3 trial-start pin schema or trial ID is invalid")
    if pin["snapshot_path"] != profile["trial_start_snapshot"]:
        raise ValueError("R3 trial-start pin does not name the profile-pinned snapshot")
    if pin["immutable"] is not True:
        raise ValueError("R3 trial-start pin is not marked immutable")
    snapshot_sha = pin["snapshot_sha256"]
    if not isinstance(snapshot_sha, str) or not SHA256_RE.fullmatch(snapshot_sha):
        raise ValueError("R3 trial-start pin requires a snapshot SHA-256")
    snapshot_data, snapshot_sha = _verify_file_hash(snapshot_path, snapshot_sha, "R3 pinned trial-start snapshot")
    try:
        snapshot = _strict_json_loads(snapshot_data.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
        raise ValueError("R3 pinned trial-start snapshot is not strict JSON: %s" % exc) from exc
    if not isinstance(snapshot, dict) or snapshot.get("schema") != "jot.r3.trial-start-snapshot.v1":
        raise ValueError("R3 pinned trial-start snapshot schema is invalid")
    if snapshot.get("trial_id") != R3_TRIAL_ID:
        raise ValueError("R3 pinned trial-start snapshot trial ID is invalid")
    phase_trial = snapshot.get("trial")
    if not isinstance(phase_trial, dict):
        raise ValueError("R3 pinned trial-start snapshot is missing trial object")
    if phase_trial.get("started") is not True or phase_trial.get("real_product_trial_started") is not True:
        raise ValueError("R3 pinned trial-start snapshot does not authorize a real product trial")
    started_at = phase_trial.get("started_at")
    ends_at = phase_trial.get("ends_at")
    started = _utc_time(started_at, "R3 snapshot trial.started_at")
    ended = _utc_time(ends_at, "R3 snapshot trial.ends_at")
    if (ended - started).total_seconds() != TRIAL_SECONDS:
        raise ValueError("R3 snapshot trial window must be exactly 7200 seconds")

    work_orders = snapshot.get("work_orders")
    if not isinstance(work_orders, list):
        raise ValueError("R3 pinned trial-start snapshot must contain work_orders")
    assignments_path = Path(profile["assignments"]["path"]).resolve(strict=True)
    work_order_root = assignments_path.parent
    work_orders_by_worker = {}
    for entry in work_orders:
        required = ("worker", "work_order_path", "work_order_sha256", "primary_id", "backup_id", "source_class_by_task")
        _schema_object(entry, "R3 snapshot work order", required, required)
        number = entry["worker"]
        if type(number) is not int or number not in workers_by_number:
            raise ValueError("R3 snapshot work order names an unknown worker")
        if number in work_orders_by_worker:
            raise ValueError("R3 snapshot contains duplicate worker work orders")
        expected_path = (work_order_root / ("worker-%02d" % number) / "work-order.json").resolve(strict=True)
        try:
            expected_path.relative_to(root)
        except ValueError as exc:
            raise ValueError("R3 work-order path escapes the repository root") from exc
        if entry["work_order_path"] != expected_path.as_posix():
            raise ValueError("R3 snapshot work-order path is not the fixed worker work-order path")
        work_order_data, work_order_sha = _verify_file_hash(
            expected_path, entry["work_order_sha256"], "R3 pinned worker work order"
        )
        try:
            work_order = _strict_json_loads(work_order_data.decode("utf-8-sig"))
        except (UnicodeError, json.JSONDecodeError, ValueError) as exc:
            raise ValueError("R3 pinned worker work order is not strict JSON: %s" % exc) from exc
        if not isinstance(work_order, dict) or work_order.get("worker") != number:
            raise ValueError("R3 pinned worker work order has the wrong worker number")
        try:
            order_workspace = Path(work_order.get("private_workspace", "")).resolve(strict=True)
        except (OSError, ValueError) as exc:
            raise ValueError("R3 pinned work-order private_workspace is missing or unreadable") from exc
        if order_workspace != Path(workers_by_number[number]["private_workspace"]):
            raise ValueError("R3 pinned work-order private_workspace does not match assignments")
        primary = work_order.get("primary")
        backup = work_order.get("backup")
        if not isinstance(primary, dict) or not isinstance(backup, dict):
            raise ValueError("R3 pinned worker work order requires primary and backup tasks")
        primary_id, backup_id = primary.get("id"), backup.get("id")
        source_classes = work_order.get("source_class_by_task")
        if not isinstance(primary_id, str) or not primary_id.strip() or not isinstance(backup_id, str) or not backup_id.strip():
            raise ValueError("R3 pinned worker work order has invalid primary or backup task ID")
        if not isinstance(source_classes, dict) or set(source_classes) != {primary_id, backup_id}:
            raise ValueError("R3 pinned worker work order source_class_by_task must match primary and backup IDs")
        if any(value not in SOURCE_CLASSES for value in source_classes.values()):
            raise ValueError("R3 pinned worker work order has an invalid source class")
        if entry["primary_id"] != primary_id or entry["backup_id"] != backup_id:
            raise ValueError("R3 snapshot primary/backup IDs do not match the pinned work order")
        if entry["source_class_by_task"] != source_classes:
            raise ValueError("R3 snapshot source_class_by_task does not match the pinned work order")
        work_orders_by_worker[number] = {
            "worker": workers_by_number[number],
            "path": str(expected_path),
            "sha256": work_order_sha,
            "primary_id": primary_id,
            "backup_id": backup_id,
            "source_class_by_task": source_classes,
        }
    return {
        "trial_id": R3_TRIAL_ID,
        "profile_path": str(profile_path),
        "profile_sha256": profile_sha,
        "pin_path": str(pin_path),
        "pin_sha256": pin_sha,
        "snapshot_path": str(snapshot_path),
        "snapshot_sha256": snapshot_sha,
        "started_at": started_at,
        "ends_at": ends_at,
        "workers_by_number": workers_by_number,
        "work_orders_by_worker": work_orders_by_worker,
    }


def _validate_r3_trial_start_state(trial):
    if trial["trial_id"] != R3_TRIAL_ID:
        raise ValueError("trial ID does not match the fixed R3 runtime profile")
    authority = load_r3_start_authority()
    if trial["started_at"] != authority["started_at"]:
        raise ValueError("trial started_at does not match the pinned R3 snapshot")
    if trial["state"] == "completed" and trial["ended_at"] != authority["ends_at"]:
        raise ValueError("trial ended_at does not match the pinned R3 snapshot")
    return authority


def validate_trial_record(trial, evidence_root=None):
    state = _validate_trial_schema(trial)
    if state == "prepared_not_started":
        if trial["optimization_baseline"] is not None:
            if evidence_root is None:
                raise ValueError("evidence root is required for optimization_baseline event streams")
            expected_trial_id = R3_TRIAL_ID if trial["trial_id"] == R3_TRIAL_ID else None
            _validate_snapshot_evidence(
                trial["optimization_baseline"], evidence_root, "optimization_baseline", expected_trial_id
            )
        return {"state": state, "elapsed_seconds": None}

    if evidence_root is None:
        raise ValueError("evidence root is required for trial snapshots")
    r3_authority = None
    if trial["trial_id"] == R3_TRIAL_ID:
        r3_authority = _validate_r3_trial_start_state(trial)
    elif trial["trial_id"] not in R2_TRIAL_IDS:
        raise ValueError("no fixed R2 or R3 profile authorizes this trial ID")
    snapshots = [("start_snapshot", trial["start_snapshot"])]
    if trial["optimization_baseline"] is not None:
        baseline = trial["optimization_baseline"]
        start = trial["start_snapshot"]
        if baseline["candidate_commit"] != start["candidate_commit"] or baseline["candidate_tree"] != start["candidate_tree"]:
            raise ValueError("optimization_baseline candidate identity must match start_snapshot")
        if _utc_time(baseline["captured_at"], "optimization_baseline.captured_at") > _utc_time(trial["started_at"], "started_at"):
            raise ValueError("optimization_baseline cannot be after trial started_at")
        snapshots.insert(0, ("optimization_baseline", baseline))
    if state == "completed":
        snapshots.append(("end_snapshot", trial["end_snapshot"]))
    expected_trial_id = R3_TRIAL_ID if trial["trial_id"] == R3_TRIAL_ID else None
    for label, snapshot in snapshots:
        _validate_snapshot_evidence(snapshot, evidence_root, label, expected_trial_id, r3_authority)

    if trial["trial_id"] in R2_TRIAL_IDS:
        authorization = _validate_trial_start_state(trial, evidence_root)
    else:
        authorization = r3_authority
    if state == "running":
        return {"state": state, "elapsed_seconds": None, "trial_start_evidence": authorization}
    return {"state": state, "elapsed_seconds": TRIAL_SECONDS, "trial_start_evidence": authorization}

def main(argv=None):
    parser = argparse.ArgumentParser(description="Read-only workflow event metrics")
    parser.add_argument("--events", nargs="+", required=True, help="owner event JSONL files to merge")
    parser.add_argument("--evidence-root", type=Path, default=Path(__file__).resolve().parents[2],
                        help="directory containing event and evidence files")
    parser.add_argument("--trial-record", type=Path)
    parser.add_argument("--output", type=Path, help="write the derived snapshot here instead of stdout")
    args = parser.parse_args(argv)
    try:
        result = summarize_event_files(args.events, args.evidence_root)
        if args.trial_record:
            trial_path = _resolve_file(args.evidence_root.resolve(strict=True), str(args.trial_record), "trial record")
            trial = _strict_json_loads(trial_path.read_text(encoding="utf-8"))
            result["trial_validation"] = validate_trial_record(
                trial, args.evidence_root
            )
        result["generated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
        if args.output:
            root = args.evidence_root.resolve(strict=True)
            target = args.output.resolve()
            try:
                target.relative_to(root)
            except ValueError as exc:
                raise ValueError("output path must stay under evidence-root") from exc
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(output, encoding="utf-8")
        else:
            sys.stdout.write(output)
        return 0
    except (OSError, ValueError) as exc:
        print("metrics: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
