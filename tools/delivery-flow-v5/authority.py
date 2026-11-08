"""Fixed-role authority reader for pinned historical and current trial rounds."""

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from workspace_guard import _load_current_trial_authority


R5_PROFILE_ID = "jot-parallel-r5-20261025"
ROOT = Path("E:/codex/yunticket").resolve()
DOCS = ROOT / "docs" / "diagnostics" / "delivery-flow-v5-20261025"
PROFILE_PIN_PATH = DOCS / "decision-profile-pin.json"
PROFILE_PIN_SHA256 = "f6ed1691942c8681418347f3cbcc84d0b19b0ad979467dedfb92d5ba5a00040d"
PROFILE_PATH = DOCS / "decision-scope-profile.json"
PROFILE_SHA256 = "c7bdf3ecd3dee2e9fae1aac18af5a839e4d8cc533efa0f201ffb0984ea7e9675"
ASSIGNMENTS_PATH = DOCS / "decision-workers-scope.json"
ASSIGNMENTS_SHA256 = "b0424dadf0244ec392529a1bda23bbba3a85939dc92e163203f3360a947ae961"
POLICY_PATH = DOCS / "decision-path-policy.json"
POLICY_SHA256 = "e5a75ec12799cc1de200df217642d2e4829de3cf603fd53cb188310f9da178eb"
AUTHORIZATION_PATH = DOCS / "decision-cross-thread-authorization-granted.json"
AUTHORIZATION_SHA256 = "6f9868855bd01570e55d07da1a74c0c0124df895e16e11a7b206979a6a828194"
TRIAL_SECONDS = 7200


def _strict_json(data, label):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("%s contains a duplicate JSON key" % label)
            result[key] = value
        return result

    try:
        return json.loads(data.decode("utf-8-sig"), object_pairs_hook=unique)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("%s is not strict JSON: %s" % (label, exc)) from exc


def _read_pinned(path, expected_sha256, label):
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise ValueError("%s is missing or unreadable" % label) from exc
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected_sha256:
        raise ValueError("%s SHA-256 does not match its fixed R5 pin" % label)
    return data


def _within(root, path, label, must_exist=False):
    resolved_root = Path(root).resolve(strict=True)
    resolved = Path(path).resolve(strict=must_exist)
    try:
        resolved.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError("%s escapes the fixed R5 repository" % label) from exc
    return resolved


def _utc_datetime(value, label):
    if not isinstance(value, str):
        raise ValueError("%s must be an RFC 3339 UTC timestamp" % label)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("%s must be an RFC 3339 UTC timestamp" % label) from exc
    if parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValueError("%s must be UTC" % label)
    return parsed


def load_r5_profile_authority():
    """Read only the compiled-in R5 pin/profile/assignment/policy paths."""
    root = ROOT.resolve(strict=True)
    pin_data = _read_pinned(PROFILE_PIN_PATH, PROFILE_PIN_SHA256, "R5 profile pin")
    pin = _strict_json(pin_data, "R5 profile pin")
    profile_path = PROFILE_PATH.resolve(strict=True)
    if pin.get("profile_id") != R5_PROFILE_ID or Path(pin.get("path", "")).resolve(strict=True) != profile_path:
        raise ValueError("R5 profile pin does not name the fixed R5 profile")
    if pin.get("sha256") != PROFILE_SHA256:
        raise ValueError("R5 profile pin contains an unexpected profile hash")
    profile_data = _read_pinned(profile_path, PROFILE_SHA256, "R5 scope profile")
    profile = _strict_json(profile_data, "R5 scope profile")
    if (
        profile.get("schema") != "jot.r5.runtime-profile.v1"
        or profile.get("profile_id") != R5_PROFILE_ID
        or profile.get("repository") != root.as_posix()
        or profile.get("R_thread") != "01a075f2-dcb3-7f23-b198-814d92d70fe2"
    ):
        raise ValueError("R5 scope profile identity or repository is invalid")

    references = (
        ("assignments", ASSIGNMENTS_PATH, ASSIGNMENTS_SHA256),
        ("policy", POLICY_PATH, POLICY_SHA256),
    )
    contents = {}
    for name, fixed_path, expected_hash in references:
        reference = profile.get(name)
        if not isinstance(reference, dict) or reference.get("sha256") != expected_hash:
            raise ValueError("R5 profile %s hash pin is invalid" % name)
        reference_path = Path(reference.get("path", "")).resolve(strict=True)
        if reference_path != fixed_path.resolve(strict=True):
            raise ValueError("R5 profile %s path is not the fixed path" % name)
        data = _read_pinned(reference_path, expected_hash, "R5 %s" % name)
        contents[name] = _strict_json(data, "R5 %s" % name)

    fixed_paths = {
        "trial_start_snapshot": DOCS / "trial-start-snapshot.json",
        "trial_start_pin": DOCS / "trial-start-pin.json",
        "tool_release": DOCS / "decision-tools-release.json",
        "standing_source_policy": DOCS / "decision-standing-source-policy.json",
    }
    for field, fixed_path in fixed_paths.items():
        if Path(profile.get(field, "")).resolve(strict=False) != fixed_path.resolve(strict=False):
            raise ValueError("R5 profile %s path is not the fixed path" % field)

    assignments = contents["assignments"]
    if assignments.get("profile_id") != R5_PROFILE_ID or not isinstance(assignments.get("workers"), list):
        raise ValueError("R5 worker scope has an invalid profile or workers list")
    workers_by_number = {}
    for worker in assignments["workers"]:
        if not isinstance(worker, dict) or type(worker.get("number")) is not int:
            raise ValueError("R5 worker scope contains an invalid worker")
        number = worker["number"]
        if number in workers_by_number or not isinstance(worker.get("thread_id"), str):
            raise ValueError("R5 worker scope has a duplicate number or missing thread ID")
        private_workspace = _within(root, worker.get("private_workspace", ""), "R5 private workspace")
        report_directory = _within(root, worker.get("report_directory", ""), "R5 report directory")
        workers_by_number[number] = {
            **worker,
            "private_workspace": str(private_workspace),
            "report_directory": str(report_directory),
        }

    authorization_data = _read_pinned(AUTHORIZATION_PATH, AUTHORIZATION_SHA256, "R5 human coordination authorization")
    authorization = _strict_json(authorization_data, "R5 human coordination authorization")
    if authorization.get("root_thread") != profile["R_thread"]:
        raise ValueError("R5 coordination authorization is for a different root thread")
    return {
        "profile": profile,
        "profile_sha256": PROFILE_SHA256,
        "workers_by_number": workers_by_number,
        "policy": contents["policy"],
        "assignments": assignments,
        "authorization": authorization,
    }


def _load_start_authority(profile, repository_root):
    root = Path(repository_root).resolve(strict=True)
    pin_path = _within(root, profile.get("trial_start_pin", ""), "R5 trial-start pin", must_exist=False)
    snapshot_path = _within(root, profile.get("trial_start_snapshot", ""), "R5 trial-start snapshot", must_exist=False)
    if not pin_path.is_file() or not snapshot_path.is_file():
        raise ValueError("R5 trial-start pin or snapshot is missing")
    pin = _strict_json(pin_path.read_bytes(), "R5 trial-start pin")
    required_pin_fields = {"schema", "trial_id", "snapshot_path", "snapshot_sha256", "immutable"}
    if set(pin) != required_pin_fields:
        raise ValueError("R5 trial-start pin fields are invalid")
    if (
        pin["schema"] != "jot.r5.trial-start-pin.v1"
        or pin["trial_id"] != R5_PROFILE_ID
        or Path(pin["snapshot_path"]).resolve(strict=False) != snapshot_path
        or pin["immutable"] is not True
    ):
        raise ValueError("R5 trial-start pin identity is invalid")
    snapshot_data = snapshot_path.read_bytes()
    snapshot_sha = hashlib.sha256(snapshot_data).hexdigest()
    if pin["snapshot_sha256"] != snapshot_sha:
        raise ValueError("R5 start snapshot bytes do not match the immutable pin")
    snapshot = _strict_json(snapshot_data, "R5 trial-start snapshot")
    trial = snapshot.get("trial")
    if (
        snapshot.get("schema") != "jot.r5.trial-start-snapshot.v1"
        or snapshot.get("profile_id") != R5_PROFILE_ID
        or snapshot.get("trial_id") != R5_PROFILE_ID
        or not isinstance(trial, dict)
        or trial.get("started") is not True
        or trial.get("real_product_trial_started") is not True
    ):
        raise ValueError("R5 start snapshot does not attest the unique real product START")
    start = datetime.fromisoformat(trial["started_at"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(trial["ends_at"].replace("Z", "+00:00"))
    if start.utcoffset() != timezone.utc.utcoffset(start) or end.utcoffset() != timezone.utc.utcoffset(end):
        raise ValueError("R5 START timestamps must be UTC")
    if (end - start).total_seconds() != TRIAL_SECONDS:
        raise ValueError("R5 trial window must be exactly 7200 seconds")

    assignments_data = _read_pinned(ASSIGNMENTS_PATH, ASSIGNMENTS_SHA256, "R5 assignments")
    assignments = _strict_json(assignments_data, "R5 assignments")
    workers_by_number = {worker["number"]: worker for worker in assignments["workers"]}
    work_orders = snapshot.get("work_orders")
    if not isinstance(work_orders, list):
        raise ValueError("R5 start snapshot must contain pinned work orders")
    work_orders_by_worker = {}
    for entry in work_orders:
        if not isinstance(entry, dict) or type(entry.get("worker")) is not int:
            raise ValueError("R5 start snapshot has an invalid work-order reference")
        worker_number = entry["worker"]
        if worker_number not in workers_by_number or worker_number in work_orders_by_worker:
            raise ValueError("R5 start snapshot has an unknown or duplicate work-order worker")
        worker = workers_by_number[worker_number]
        path = _within(worker["private_workspace"], entry.get("work_order_path", ""), "R5 pinned work order", True)
        data = _read_pinned(path, entry.get("work_order_sha256", ""), "R5 worker work order")
        order = _strict_json(data, "R5 worker work order")
        if order.get("worker") != worker_number:
            raise ValueError("R5 work order identity does not match its pinned snapshot entry")
        if "owner" in entry and order.get("owner") != entry["owner"]:
            raise ValueError("R5 work-order owner does not match its pinned snapshot entry")
        if order.get("primary_id") != entry.get("primary_id") or order.get("backup_id") != entry.get("backup_id"):
            raise ValueError("R5 work-order task IDs do not match their pinned snapshot entry")
        tasks = order.get("tasks")
        if not isinstance(tasks, dict) or any(task_id not in tasks for task_id in (order["primary_id"], order["backup_id"])):
            raise ValueError("R5 work order does not bind both current primary and backup tasks")
        work_orders_by_worker[worker_number] = order
    selected = snapshot.get("selected_seats")
    if selected is not None and (
        not isinstance(selected, list)
        or any(type(number) is not int or number not in workers_by_number for number in selected)
        or set(work_orders_by_worker) != set(selected)
    ):
        raise ValueError("R5 start snapshot work orders do not cover exactly the selected product seats")
    if not work_orders_by_worker:
        raise ValueError("R5 start snapshot has no product work orders")
    return {
        "profile": profile,
        "trial": trial,
        "snapshot": snapshot,
        "workers_by_number": workers_by_number,
        "work_orders_by_worker": work_orders_by_worker,
        "snapshot_sha256": snapshot_sha,
    }


def _matches_trial_timestamp(trial, timestamp):
    started = _utc_datetime(trial.get("started_at"), "trial start")
    ends = _utc_datetime(trial.get("ends_at"), "trial end")
    observed = _utc_datetime(timestamp, "receipt row start")
    return started <= observed < ends


def load_r5_trial_authority(receipt_at=None):
    profile_authority = load_r5_profile_authority()
    historical = _load_start_authority(profile_authority["profile"], ROOT)
    if receipt_at is not None and _matches_trial_timestamp(historical["trial"], receipt_at):
        selected = historical
    else:
        current = _load_current_trial_authority(profile_authority, ROOT, DOCS)
        if current is None:
            if receipt_at is not None:
                raise ValueError("receipt timestamp is outside the pinned R5 trial")
            selected = historical
        elif receipt_at is None or _matches_trial_timestamp(current["trial"], receipt_at):
            selected = current
        else:
            raise ValueError("receipt timestamp is outside the pinned current trial")
    return {
        **profile_authority,
        **selected,
        "profile": profile_authority["profile"],
        "profile_sha256": profile_authority["profile_sha256"],
        "assignments": profile_authority["assignments"],
        "authorization": profile_authority["authorization"],
    }
