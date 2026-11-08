#!/usr/bin/env python3
"""Check a proposed write target before the caller performs any write."""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path


REPOSITORY = Path("E:/codex/yunticket")
ASSIGNMENTS = REPOSITORY / "docs/diagnostics/delivery-flow-v2-20261024/workers.json"
POLICY = REPOSITORY / "docs/diagnostics/delivery-flow-v2-20261024/dispatch-policy.json"
FORMAL_LEDGER = REPOSITORY / "docs/superpowers/plans/pilotdeck-ledger-v2-20261021/ledger.json"
ASSIGNMENTS_SHA256 = "32e31d77864671827d1026f584dc5124782f1a8795aef4f35f70d7267f092381"
POLICY_SHA256 = "98cde14d1262f591bda0a6a183f4a9a2b7316fb92e1afd0db95440fb0643081b"
R3_PROFILE = REPOSITORY / "docs/diagnostics/delivery-flow-v3-20261025/runtime-profile.json"
R3_PROFILE_SHA256 = "af095aac34ce65a2d40b224a6ab500c8a9810a00b8c48b9f570bd7912eb130b1"
R3_PROFILE_ID = "jot-parallel-r3-20261025"
R3_THREAD_ID = "01a075f2-dcb3-7f23-b198-814d92d70fe2"
R3_ASSIGNMENTS = REPOSITORY / "docs/diagnostics/delivery-flow-v3-20261025/workers.json"
R3_ASSIGNMENTS_SHA256 = "4e2d0e7aec2c9b5ff5d6618645b698ceedb1675c16f0f50b027a64982c77b74c"
R3_POLICY = REPOSITORY / "docs/diagnostics/delivery-flow-v3-20261025/dispatch-policy.json"
R3_POLICY_SHA256 = "358c3c46ed57bae212609dc05b6efce5cb3448bf0303e00d97b8ba142be68f2c"
R3_TOOL_RELEASE = REPOSITORY / "docs/diagnostics/delivery-flow-v3-20261025/tools-release.json"
R4_PROFILE = REPOSITORY / "docs/diagnostics/delivery-flow-v4-20261025/decision-scope-profile.json"
R4_PROFILE_SHA256 = "45b54330f139c577f8040332448e9d8eb6a05d0cf0f68c11dc1c0cbfbd0a74f3"
R4_PROFILE_ID = "jot-parallel-r4-20261025"
R4_THREAD_ID = "01a075f2-dcb3-7f23-b198-814d92d70fe2"
R4_ASSIGNMENTS = REPOSITORY / "docs/diagnostics/delivery-flow-v4-20261025/decision-workers-scope.json"
R4_ASSIGNMENTS_SHA256 = "370d667f759d97b6508a2d230730e509180ca819e96f0043681aee8a1f87f539"
R4_POLICY = REPOSITORY / "docs/diagnostics/delivery-flow-v4-20261025/decision-path-policy.json"
R4_POLICY_SHA256 = "41c724470f2f9036569dc72cac2721bdb7a1f67c0d658aeeecf8b27a91cfc5ea"
R4_TOOL_RELEASE = REPOSITORY / "docs/diagnostics/delivery-flow-v4-20261025/decision-tools-release.json"
R4_STANDING_SOURCE_POLICY = REPOSITORY / "docs/diagnostics/delivery-flow-v4-20261025/decision-standing-source-policy.json"
R4_TRIAL_START_SNAPSHOT = REPOSITORY / "docs/diagnostics/delivery-flow-v4-20261025/trial-start-snapshot.json"
R4_TRIAL_START_PIN = REPOSITORY / "docs/diagnostics/delivery-flow-v4-20261025/trial-start-pin.json"
R5_PROFILE_PIN = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/decision-profile-pin.json"
R5_PROFILE_PIN_SHA256 = "f6ed1691942c8681418347f3cbcc84d0b19b0ad979467dedfb92d5ba5a00040d"
R5_PROFILE = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/decision-scope-profile.json"
R5_PROFILE_SHA256 = "c7bdf3ecd3dee2e9fae1aac18af5a839e4d8cc533efa0f201ffb0984ea7e9675"
R5_PROFILE_ID = "jot-parallel-r5-20261025"
R5_THREAD_ID = "01a075f2-dcb3-7f23-b198-814d92d70fe2"
R5_ASSIGNMENTS = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/decision-workers-scope.json"
R5_ASSIGNMENTS_SHA256 = "b0424dadf0244ec392529a1bda23bbba3a85939dc92e163203f3360a947ae961"
R5_POLICY = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/decision-path-policy.json"
R5_POLICY_SHA256 = "e5a75ec12799cc1de200df217642d2e4829de3cf603fd53cb188310f9da178eb"
R5_TOOL_RELEASE = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/decision-tools-release.json"
R5_STANDING_SOURCE_POLICY = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/decision-standing-source-policy.json"
R5_STANDING_SOURCE_POLICY_PIN = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/decision-standing-policy-pin.json"
R5_TRIAL_START_SNAPSHOT = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/trial-start-snapshot.json"
R5_TRIAL_START_PIN = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/trial-start-pin.json"
R5_CURRENT_TRIAL_METADATA = REPOSITORY / "docs/diagnostics/delivery-flow-v5-20261025/decision-current-trial.json"
R5_CURRENT_TRIAL_METADATA_SCHEMA = "jot.r5.current-trial-metadata.v1"
R5_TRIAL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")
R5_TRIAL_SECONDS = 7200
ALL_FILES_ROOT = Path("E:/codex")
REPARSE_POINT = 0x400


def _sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read_pinned_json(path, expected_sha256):
    source = Path(path).read_bytes()
    if hashlib.sha256(source).hexdigest() != expected_sha256:
        return None, "pin_mismatch"
    try:
        data = json.loads(source.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None, "invalid_json"
    return data, None


def _strict_json_bytes(source, label):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("%s contains a duplicate JSON key" % label)
            result[key] = value
        return result

    try:
        return json.loads(source.decode("utf-8-sig"), object_pairs_hook=unique)
    except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("%s is not strict JSON" % label) from exc


def _read_current_trial_json(path, expected_sha256=None, label="current-trial JSON"):
    source = Path(path).read_bytes()
    if expected_sha256 is not None and hashlib.sha256(source).hexdigest() != expected_sha256:
        raise ValueError("%s hash does not match its R pin" % label)
    return _strict_json_bytes(source, label)


def _require_current_trial_sha256(value, label):
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("%s SHA-256 must be exactly 64 lowercase hexadecimal characters" % label)
    return value


def _resolve_current_trial_path(root, path, label):
    if _has_reparse_component(path):
        raise ValueError("%s contains a reparse point" % label)
    resolved_root = Path(root).resolve(strict=True)
    resolved = Path(path).resolve(strict=True)
    if not _within(resolved, resolved_root):
        raise ValueError("%s escapes its R-published root" % label)
    return resolved


def _utc_datetime(value, label):
    if not isinstance(value, str):
        raise ValueError("%s must be an RFC 3339 UTC timestamp" % label)
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("%s must be an RFC 3339 UTC timestamp" % label) from exc
    if parsed.utcoffset() != dt.timezone.utc.utcoffset(parsed):
        raise ValueError("%s must be UTC" % label)
    return parsed


def _load_current_trial_authority(profile_authority, repository_root=REPOSITORY, docs_root=None):
    """Load R's fixed current pointer and the unique pin, snapshot, policy and work orders."""
    docs_root = R5_PROFILE.parent if docs_root is None else docs_root
    root = Path(repository_root).resolve(strict=True)
    docs = _resolve_current_trial_path(root, docs_root, "R5 diagnostics directory")
    metadata_path = docs / R5_CURRENT_TRIAL_METADATA.name
    if _has_reparse_component(metadata_path):
        raise ValueError("current-trial metadata cannot be a reparse point")
    if not metadata_path.exists():
        return None
    metadata_path = _resolve_current_trial_path(docs, metadata_path, "current-trial metadata")
    metadata = _read_current_trial_json(metadata_path, label="current-trial metadata")
    required_metadata = {
        "schema", "issued_by", "profile_id", "trial_id", "trial_start_pin"
    }
    trial_id = metadata.get("trial_id") if isinstance(metadata, dict) else None
    if (
        not isinstance(metadata, dict)
        or set(metadata) != required_metadata
        or metadata.get("schema") != R5_CURRENT_TRIAL_METADATA_SCHEMA
        or metadata.get("issued_by") != "R"
        or metadata.get("profile_id") != R5_PROFILE_ID
        or not isinstance(trial_id, str)
        or not R5_TRIAL_ID_RE.fullmatch(trial_id)
        or trial_id == R5_PROFILE_ID
    ):
        raise ValueError("current-trial metadata identity is invalid")

    pin_path = docs / ("trial-start-pin-%s.json" % trial_id)
    metadata_pin_path = _resolve_current_trial_path(
        docs, metadata.get("trial_start_pin", ""), "current-trial pin"
    )
    if metadata_pin_path != pin_path.resolve(strict=True):
        raise ValueError("current-trial metadata does not name its unique round pin")
    pin = _read_current_trial_json(metadata_pin_path, label="current-trial pin")
    required_pin = {
        "schema", "issued_by", "profile_id", "trial_id", "snapshot_path", "snapshot_sha256", "immutable"
    }
    snapshot_path = docs / ("trial-start-snapshot-%s.json" % trial_id)
    if (
        not isinstance(pin, dict)
        or set(pin) != required_pin
        or pin.get("schema") != "jot.r5.current-trial-pin.v1"
        or pin.get("issued_by") != "R"
        or pin.get("profile_id") != R5_PROFILE_ID
        or pin.get("trial_id") != trial_id
        or Path(pin.get("snapshot_path", "")).resolve(strict=False) != snapshot_path.resolve(strict=False)
        or pin.get("immutable") is not True
    ):
        raise ValueError("current-trial pin identity is invalid")
    snapshot_path = _resolve_current_trial_path(docs, snapshot_path, "current-trial snapshot")
    snapshot_data = snapshot_path.read_bytes()
    if hashlib.sha256(snapshot_data).hexdigest() != pin.get("snapshot_sha256"):
        raise ValueError("current-trial snapshot hash does not match its R pin")
    snapshot = _strict_json_bytes(snapshot_data, "current-trial snapshot")
    if not isinstance(snapshot, dict):
        raise ValueError("current-trial snapshot is not an object")
    trial = snapshot.get("trial")
    profile_sha256 = profile_authority.get("profile_sha256")
    if (
        snapshot.get("schema") != "jot.r5.trial-start-snapshot.v1"
        or snapshot.get("profile_id") != R5_PROFILE_ID
        or snapshot.get("trial_id") != trial_id
        or snapshot.get("scope_profile")
        != {"path": R5_PROFILE.resolve(strict=False).as_posix(), "sha256": profile_sha256}
        or not isinstance(trial, dict)
        or trial.get("started") is not True
        or trial.get("real_product_trial_started") is not True
        or trial.get("new_product_dispatch_allowed") is not True
        or trial.get("duration_seconds") != R5_TRIAL_SECONDS
    ):
        raise ValueError("current-trial snapshot is not bound to the fixed role profile and live START")
    started = _utc_datetime(trial.get("started_at"), "current trial start")
    ends = _utc_datetime(trial.get("ends_at"), "current trial end")
    if (ends - started).total_seconds() != R5_TRIAL_SECONDS:
        raise ValueError("current trial must be exactly 7,200 seconds")

    policy_ref = snapshot.get("standing_source_policy")
    policy_path = docs / ("decision-standing-source-policy-%s.json" % trial_id)
    if (
        not isinstance(policy_ref, dict)
        or set(policy_ref) != {"path", "sha256"}
        or Path(policy_ref.get("path", "")).resolve(strict=False) != policy_path.resolve(strict=False)
    ):
        raise ValueError("current-trial snapshot policy path is invalid")
    policy_path = _resolve_current_trial_path(docs, policy_path, "current-trial standing policy")
    policy_sha256 = _require_current_trial_sha256(
        policy_ref.get("sha256"), "current-trial standing policy"
    )
    policy = _read_current_trial_json(
        policy_path, policy_sha256, "current-trial standing policy"
    )
    if not isinstance(policy, dict):
        raise ValueError("current-trial standing policy is not an object")
    role_policy = profile_authority.get("policy")
    if (
        policy.get("schema_version") != 1
        or policy.get("mode") != "standing_scope"
        or policy.get("writer") != 13
        or policy.get("trial_id") != trial_id
        or policy.get("event_scope") != "product"
        or policy.get("guard_profile_sha256") != profile_sha256
        or not isinstance(role_policy, dict)
        or Path(policy.get("target_repo", "")).resolve(strict=False)
        != Path(role_policy.get("shared_integration", "")).resolve(strict=False)
        or _utc_datetime(policy.get("valid_from"), "current policy start") != started
        or _utc_datetime(policy.get("expires_at"), "current policy end") != ends
    ):
        raise ValueError("current-trial standing policy does not match its pinned START")

    task_classes = {}
    policy_tasks = policy.get("task_scopes")
    if not isinstance(policy_tasks, list):
        raise ValueError("current-trial policy has no task scopes")
    for scope in policy_tasks:
        if (
            not isinstance(scope, dict)
            or type(scope.get("task_owner")) is not int
            or not isinstance(scope.get("task_id"), str)
            or scope.get("source_class") not in ("new_development", "inherited_wip")
        ):
            raise ValueError("current-trial policy has an invalid task scope")
        key = (scope["task_owner"], scope["task_id"])
        if key in task_classes:
            raise ValueError("current-trial policy contains a duplicate task scope")
        task_classes[key] = scope["source_class"]

    workers_by_number = profile_authority.get("workers_by_number")
    work_orders = snapshot.get("work_orders")
    selected = snapshot.get("selected_seats")
    if not isinstance(workers_by_number, dict) or not isinstance(work_orders, list):
        raise ValueError("current-trial assignments or work orders are invalid")
    work_orders_by_worker = {}
    bound_task_classes = {}
    for entry in work_orders:
        if not isinstance(entry, dict) or type(entry.get("worker")) is not int:
            raise ValueError("current-trial snapshot has an invalid work-order reference")
        worker_number = entry["worker"]
        worker = workers_by_number.get(worker_number)
        if worker is None or worker_number in work_orders_by_worker:
            raise ValueError("current-trial snapshot has an unknown or duplicate worker")
        if (
            entry.get("trial_id") != trial_id
            or type(entry.get("owner")) is not int
            or Path(entry.get("private_workspace", "")).resolve(strict=False)
            != Path(worker.get("private_workspace", "")).resolve(strict=False)
            or not isinstance(entry.get("primary_id"), str)
            or not isinstance(entry.get("backup_id"), str)
        ):
            raise ValueError("current-trial work-order identity or workspace is invalid")
        private_root = _resolve_current_trial_path(
            root, worker.get("private_workspace", ""), "assigned private workspace"
        )
        work_order_value = entry.get("work_order_path", "")
        if not Path(work_order_value).is_absolute():
            raise ValueError("current work-order path must be absolute")
        path = _resolve_current_trial_path(private_root, work_order_value, "current pinned work order")
        work_order_sha256 = _require_current_trial_sha256(
            entry.get("work_order_sha256"), "current worker work order"
        )
        order = _read_current_trial_json(path, work_order_sha256, "current worker work order")
        if not isinstance(order, dict):
            raise ValueError("current worker work order is not an object")
        if (
            type(order.get("worker")) is not int
            or order.get("worker") != worker_number
            or type(order.get("owner")) is not int
            or order.get("owner") != entry["owner"]
            or order.get("trial_id") != trial_id
            or Path(order.get("private_workspace", "")).resolve(strict=False) != private_root
            or order.get("primary_id") != entry["primary_id"]
            or order.get("backup_id") != entry["backup_id"]
        ):
            raise ValueError("current work order does not match its pinned round, owner, or workspace")
        tasks = order.get("tasks")
        task_ids = {entry["primary_id"], entry["backup_id"]}
        if not isinstance(tasks, dict) or any(task_id not in tasks for task_id in task_ids):
            raise ValueError("current work order does not bind both assigned tasks")
        for task_id in task_ids:
            task = tasks[task_id]
            if (
                not isinstance(task, dict)
                or task.get("source_class") != task_classes.get((entry["owner"], task_id))
                or task.get("source_class") not in ("new_development", "inherited_wip")
            ):
                raise ValueError("current work-order task source class does not match R policy")
            bound_task_classes[(entry["owner"], task_id)] = task["source_class"]
        work_orders_by_worker[worker_number] = order
    if (
        not isinstance(selected, list)
        or any(type(number) is not int or number not in workers_by_number for number in selected)
        or len(selected) != len(set(selected))
        or set(work_orders_by_worker) != set(selected)
        or not work_orders_by_worker
    ):
        raise ValueError("current trial work orders do not cover exactly the selected seats")
    if bound_task_classes != task_classes:
        raise ValueError("current-trial policy tasks do not match the selected work orders")
    return {
        "trial_id": trial_id,
        "metadata": metadata,
        "metadata_path": metadata_path,
        "pin": pin,
        "pin_path": metadata_pin_path,
        "snapshot": snapshot,
        "snapshot_sha256": hashlib.sha256(snapshot_data).hexdigest(),
        "trial": trial,
        "policy": policy,
        "policy_path": policy_path,
        "policy_sha256": policy_ref["sha256"],
        "workers_by_number": workers_by_number,
        "work_orders_by_worker": work_orders_by_worker,
    }


def _within(path, root):
    return path != root and path.is_relative_to(root)


def _within_or_equal(path, root):
    return path == root or _within(path, root)


def _has_parent_part(path):
    return ".." in Path(path).parts


def _has_reparse_component(path):
    path = Path(path)
    cursor = Path(path.anchor)
    for part in path.parts[1:]:
        if part == "..":
            cursor = cursor.parent
            continue
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


def _deny(reason, worker, cwd=None, git_root=None, target=None):
    return {
        "allowed": False,
        "worker": worker,
        "cwd": str(cwd) if cwd else None,
        "git_root": str(git_root) if git_root else None,
        "target": str(target) if target else None,
        "reason": reason,
        "os_sandbox_enforced": False,
        "permission_issued": False,
    }


def check(assignments_arg, worker_number, target_arg):
    try:
        assignments_path = Path(assignments_arg).resolve(strict=True)
        approved_assignments = ASSIGNMENTS.resolve(strict=True)
        if assignments_path != approved_assignments or _sha256(assignments_path) != ASSIGNMENTS_SHA256:
            return _deny("assignments_changed", worker_number)
        policy_path = POLICY.resolve(strict=True)
        if _sha256(policy_path) != POLICY_SHA256:
            return _deny("policy_changed", worker_number)
        data = json.loads(assignments_path.read_text(encoding="utf-8"))
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        if data.get("schema") != "jot.r2-workers.v1":
            return _deny("assignments_changed", worker_number)
        entries = [item for item in data.get("workers", []) if item.get("number") == worker_number]
        if len(entries) != 1:
            return _deny("unknown_worker", worker_number)
        assignment = entries[0]
        private_root_path = Path(assignment["private_workspace"])
        report_dir_path = Path(assignment["report_directory"])
        receipt_dir_path = assignments_path.parent / f"worker-{worker_number:02d}"
        if any(
            _has_reparse_component(path)
            for path in (private_root_path, report_dir_path, receipt_dir_path)
        ):
            return _deny("reparse_point", worker_number)
        private_root = private_root_path.resolve(strict=True)
        report_dir = report_dir_path.resolve(strict=False)
        receipt_dir = receipt_dir_path.resolve(strict=False)
        cwd_path = Path.cwd()
        if _has_reparse_component(cwd_path):
            return _deny("reparse_point", worker_number, cwd=cwd_path)
        cwd = cwd_path.resolve(strict=True)
        shared_root_path = Path(policy["shared_integration"])
        if _has_reparse_component(shared_root_path):
            return _deny("reparse_point", worker_number, cwd=cwd)
        shared_root = shared_root_path.resolve(strict=True)
        shared_cwd = _within_or_equal(cwd, shared_root)
        git = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )
        if git.returncode != 0:
            return _deny("git_root_unavailable", worker_number, cwd=cwd)
        git_root = Path(git.stdout.strip()).resolve(strict=True)
        is_shared_writer = worker_number == policy.get("shared_writer")
        if shared_cwd and not is_shared_writer:
            return _deny("shared_integration_cwd_forbidden", worker_number, cwd=cwd, git_root=git_root)
        if (shared_cwd and (not is_shared_writer or git_root != shared_root)) or (
            not shared_cwd and git_root != private_root
        ):
            return _deny("git_root_mismatch", worker_number, cwd=cwd, git_root=git_root)
        raw_target = Path(target_arg)
        if _has_parent_part(raw_target):
            return _deny("parent_traversal", worker_number, cwd=cwd, git_root=git_root, target=raw_target)
        candidate = raw_target if raw_target.is_absolute() else cwd / raw_target
        if _has_reparse_component(candidate):
            return _deny("reparse_point", worker_number, cwd=cwd, git_root=git_root, target=candidate)
        target = candidate.resolve(strict=False)
        if is_shared_writer and _within(target, shared_root):
            reason = "worker13_shared_integration"
        elif worker_number == policy.get("formal_ledger_writer") and target == FORMAL_LEDGER.resolve(strict=False):
            reason = "worker14_formal_ledger"
        elif _within(target, private_root):
            reason = "private_workspace"
        elif _within(target, report_dir):
            reason = "report_directory"
        elif _within(target, receipt_dir):
            reason = "receipt_directory"
        else:
            return _deny(
                "target_outside_allowed_roots", worker_number, cwd=cwd, git_root=git_root, target=target
            )
        return {
            "allowed": True,
            "worker": worker_number,
            "cwd": str(cwd),
            "git_root": str(git_root),
            "target": str(target),
            "reason": reason,
            "os_sandbox_enforced": False,
            "permission_issued": False,
        }
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return _deny("invalid_or_unavailable_assignment", worker_number)


def load_r3_config():
    """Load only the fixed R-owned profile and the files it pins."""
    try:
        if any(_has_reparse_component(path) for path in (R3_PROFILE, R3_ASSIGNMENTS, R3_POLICY)):
            return None, "reparse_point"
        profile_path = R3_PROFILE.resolve(strict=True)
        profile, profile_error = _read_pinned_json(profile_path, R3_PROFILE_SHA256)
        if profile_error == "pin_mismatch":
            return None, "profile_changed"
        if profile_error or not isinstance(profile, dict):
            return None, "invalid_or_unavailable_assignment"
        if (
            profile.get("schema") != "jot.r3.runtime-profile.v1"
            or profile.get("profile_id") != R3_PROFILE_ID
            or profile.get("repository") != "E:/codex/yunticket"
            or profile.get("R_thread") != R3_THREAD_ID
            or profile.get("assignments")
            != {"path": R3_ASSIGNMENTS.as_posix(), "sha256": R3_ASSIGNMENTS_SHA256}
            or profile.get("policy") != {"path": R3_POLICY.as_posix(), "sha256": R3_POLICY_SHA256}
            or profile.get("tool_release") != R3_TOOL_RELEASE.as_posix()
        ):
            return None, "profile_changed"
        assignments_path = R3_ASSIGNMENTS.resolve(strict=True)
        policy_path = R3_POLICY.resolve(strict=True)
        assignments, assignments_error = _read_pinned_json(assignments_path, R3_ASSIGNMENTS_SHA256)
        if assignments_error == "pin_mismatch":
            return None, "assignments_changed"
        if assignments_error or not isinstance(assignments, dict):
            return None, "invalid_or_unavailable_assignment"
        policy, policy_error = _read_pinned_json(policy_path, R3_POLICY_SHA256)
        if policy_error == "pin_mismatch":
            return None, "policy_changed"
        if policy_error or not isinstance(policy, dict):
            return None, "invalid_or_unavailable_assignment"
        if assignments.get("schema") != "jot.r3-workers.v1":
            return None, "assignments_changed"
        if not isinstance(assignments.get("workers"), list) or any(
            not isinstance(item, dict) for item in assignments["workers"]
        ):
            return None, "assignments_changed"
        if (
            policy.get("schema") != "jot.r3-policy.v1"
            or policy.get("shared_writer") != 13
            or policy.get("formal_ledger_writer") != 14
            or policy.get("custody_owner") != 15
            or policy.get("stats_owner") != 20
            or policy.get("all_files_under") != "E:/codex"
            or policy.get("queue_does_not_execute_or_authorize_runner") is not True
        ):
            return None, "policy_changed"
        return {
            "profile": profile,
            "assignments": assignments,
            "policy": policy,
            "tool_release": R3_TOOL_RELEASE,
        }, None
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None, "invalid_or_unavailable_assignment"


def check_r3(worker_number, target_arg):
    config, error = load_r3_config()
    if error:
        return _deny(error, worker_number)
    assignments = config["assignments"]
    policy = config["policy"]
    entries = [item for item in assignments["workers"] if item.get("number") == worker_number]
    if len(entries) != 1:
        return _deny("unknown_worker", worker_number)
    assignment = entries[0]
    try:
        private_root_path = Path(assignment["private_workspace"])
        report_dir_path = Path(assignment["report_directory"])
        shared_root_path = Path(policy["shared_integration"])
        if any(
            _has_reparse_component(path)
            for path in (private_root_path, report_dir_path, shared_root_path, ALL_FILES_ROOT)
        ):
            return _deny("reparse_point", worker_number)
        private_root = private_root_path.resolve(strict=True)
        report_dir = report_dir_path.resolve(strict=False)
        shared_root = shared_root_path.resolve(strict=True)
        all_files_root = ALL_FILES_ROOT.resolve(strict=True)
        cwd_path = Path.cwd()
        if _has_reparse_component(cwd_path):
            return _deny("reparse_point", worker_number, cwd=cwd_path)
        cwd = cwd_path.resolve(strict=True)
        git = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )
        if git.returncode != 0:
            return _deny("git_root_unavailable", worker_number, cwd=cwd)
        git_root_path = Path(git.stdout.strip())
        if _has_reparse_component(git_root_path):
            return _deny("reparse_point", worker_number, cwd=cwd)
        git_root = git_root_path.resolve(strict=True)
        shared_cwd = _within_or_equal(cwd, shared_root)
        is_shared_writer = worker_number == policy["shared_writer"]
        if shared_cwd and not is_shared_writer:
            return _deny("shared_integration_cwd_forbidden", worker_number, cwd=cwd, git_root=git_root)
        if shared_cwd:
            if git_root != shared_root:
                return _deny("git_root_mismatch", worker_number, cwd=cwd, git_root=git_root)
        elif (
            not _within_or_equal(cwd, private_root)
            or not _within_or_equal(git_root, private_root)
            or not _within_or_equal(cwd, git_root)
        ):
            return _deny("git_root_mismatch", worker_number, cwd=cwd, git_root=git_root)
        raw_target = Path(target_arg)
        if _has_parent_part(raw_target):
            return _deny("parent_traversal", worker_number, cwd=cwd, git_root=git_root, target=raw_target)
        candidate = raw_target if raw_target.is_absolute() else cwd / raw_target
        if _has_reparse_component(candidate):
            return _deny("reparse_point", worker_number, cwd=cwd, git_root=git_root, target=candidate)
        target = candidate.resolve(strict=False)
        if not _within(target, all_files_root):
            return _deny("target_outside_allowed_roots", worker_number, cwd=cwd, git_root=git_root, target=target)
        if is_shared_writer and _within(target, shared_root):
            reason = "worker13_shared_integration"
        elif worker_number == policy["formal_ledger_writer"] and target == FORMAL_LEDGER.resolve(strict=False):
            reason = "worker14_formal_ledger"
        elif _within(target, private_root):
            reason = "private_workspace"
        elif _within(target, report_dir):
            reason = "report_directory"
        else:
            return _deny(
                "target_outside_allowed_roots", worker_number, cwd=cwd, git_root=git_root, target=target
            )
        return {
            "allowed": True,
            "worker": worker_number,
            "cwd": str(cwd),
            "git_root": str(git_root),
            "target": str(target),
            "reason": reason,
            "os_sandbox_enforced": False,
            "permission_issued": False,
        }
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return _deny("invalid_or_unavailable_assignment", worker_number)


def _load_r4_standing_policy(profile):
    pin_path = R4_PROFILE.parent / "decision-standing-policy-pin.json"
    if (
        profile.get("standing_source_policy") != R4_STANDING_SOURCE_POLICY.as_posix()
        or _has_reparse_component(pin_path)
        or _has_reparse_component(R4_STANDING_SOURCE_POLICY)
    ):
        return None, "standing_source_policy_pin_invalid"
    try:
        pin_path = pin_path.resolve(strict=True)
        pin = json.loads(pin_path.read_bytes().decode("utf-8"))
    except FileNotFoundError:
        return None, "standing_source_policy_pin_unavailable"
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None, "standing_source_policy_pin_invalid"

    if not isinstance(pin, dict):
        return None, "standing_source_policy_pin_invalid"
    policy_ref = pin.get("policy")
    if (
        pin.get("schema") != "jot.r4-standing-policy-pin.v1"
        or pin.get("issued_by") != "R"
        or pin.get("profile_id") != R4_PROFILE_ID
        or pin.get("scope_profile")
        != {"path": R4_PROFILE.as_posix(), "sha256": R4_PROFILE_SHA256}
        or not isinstance(policy_ref, dict)
        or policy_ref.get("path") != R4_STANDING_SOURCE_POLICY.as_posix()
        or profile.get("standing_source_policy") != policy_ref.get("path")
    ):
        return None, "standing_source_policy_pin_invalid"
    policy_sha256 = policy_ref.get("sha256")
    if (
        not isinstance(policy_sha256, str)
        or len(policy_sha256) != 64
        or any(char not in "0123456789abcdef" for char in policy_sha256)
    ):
        return None, "standing_source_policy_pin_invalid"

    try:
        policy_path = R4_STANDING_SOURCE_POLICY.resolve(strict=True)
        policy, error = _read_pinned_json(policy_path, policy_sha256)
    except OSError:
        return None, "standing_source_policy_unavailable"
    if error == "pin_mismatch":
        return None, "standing_source_policy_changed"
    if error or not isinstance(policy, dict):
        return None, "standing_source_policy_invalid"
    if (
        policy.get("schema_version") != 1
        or policy.get("mode") != "standing_scope"
        or policy.get("writer") != 13
        or policy.get("trial_id") != R4_PROFILE_ID
        or policy.get("guard_profile_sha256") != R4_PROFILE_SHA256
    ):
        return None, "standing_source_policy_start_not_authorized"
    trial_start = None
    if policy.get("event_scope") == "preparation":
        if pin.get("event_scope") != "preparation" or pin.get("product_START_authorized") is not False:
            return None, "standing_source_policy_start_not_authorized"
    elif policy.get("event_scope") == "product":
        if pin.get("event_scope") != "product" or pin.get("product_START_authorized") is not True:
            return None, "standing_source_policy_start_not_authorized"
        trial_start, error = _load_r4_trial_start(profile, policy, policy_sha256)
        if error:
            return None, error
    else:
        return None, "standing_source_policy_start_not_authorized"
    return {
        "path": policy_path,
        "sha256": policy_sha256,
        "pin_path": pin_path,
        "pin": pin,
        "document": policy,
        "trial_start": trial_start,
    }, None


def _utc_rfc3339(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        return None
    stamp = value[:-1]
    fmt = "%Y-%m-%dT%H:%M:%S.%f" if "." in stamp else "%Y-%m-%dT%H:%M:%S"
    try:
        return dt.datetime.strptime(stamp, fmt).replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def _load_r4_trial_start(profile, policy, policy_sha256):
    if (
        profile.get("trial_start_snapshot") != R4_TRIAL_START_SNAPSHOT.as_posix()
        or profile.get("trial_start_pin") != R4_TRIAL_START_PIN.as_posix()
        or _has_reparse_component(R4_TRIAL_START_PIN)
        or _has_reparse_component(R4_TRIAL_START_SNAPSHOT)
    ):
        return None, "standing_source_policy_trial_start_pin_invalid"
    try:
        pin_path = R4_TRIAL_START_PIN.resolve(strict=True)
        snapshot_path = R4_TRIAL_START_SNAPSHOT.resolve(strict=True)
        start_pin = json.loads(pin_path.read_bytes().decode("utf-8"))
    except FileNotFoundError:
        return None, "standing_source_policy_trial_start_pin_unavailable"
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None, "standing_source_policy_trial_start_pin_invalid"
    fields = {"schema", "trial_id", "snapshot_path", "snapshot_sha256", "immutable"}
    if (
        not isinstance(start_pin, dict)
        or set(start_pin) != fields
        or start_pin.get("schema") != "jot.r4.trial-start-pin.v1"
        or start_pin.get("trial_id") != R4_PROFILE_ID
        or start_pin.get("snapshot_path") != profile.get("trial_start_snapshot")
        or start_pin.get("immutable") is not True
    ):
        return None, "standing_source_policy_trial_start_pin_invalid"
    snapshot_sha256 = start_pin.get("snapshot_sha256")
    if (
        not isinstance(snapshot_sha256, str)
        or len(snapshot_sha256) != 64
        or any(char not in "0123456789abcdef" for char in snapshot_sha256)
    ):
        return None, "standing_source_policy_trial_start_pin_invalid"
    try:
        snapshot, error = _read_pinned_json(snapshot_path, snapshot_sha256)
    except OSError:
        return None, "standing_source_policy_trial_start_snapshot_unavailable"
    if error == "pin_mismatch":
        return None, "standing_source_policy_trial_start_snapshot_changed"
    if error or not isinstance(snapshot, dict):
        return None, "standing_source_policy_trial_start_snapshot_invalid"
    if (
        snapshot.get("schema") != "jot.r4.trial-start-snapshot.v1"
        or snapshot.get("trial_id") != R4_PROFILE_ID
        or snapshot.get("scope_profile")
        != {"path": R4_PROFILE.as_posix(), "sha256": R4_PROFILE_SHA256}
        or snapshot.get("standing_source_policy")
        != {"path": R4_STANDING_SOURCE_POLICY.as_posix(), "sha256": policy_sha256}
    ):
        return None, "standing_source_policy_trial_start_snapshot_invalid"
    trial = snapshot.get("trial")
    if (
        not isinstance(trial, dict)
        or trial.get("started") is not True
        or trial.get("real_product_trial_started") is not True
    ):
        return None, "standing_source_policy_trial_start_not_authorized"
    started = _utc_rfc3339(trial.get("started_at"))
    ends = _utc_rfc3339(trial.get("ends_at"))
    policy_start = _utc_rfc3339(policy.get("valid_from"))
    policy_ends = _utc_rfc3339(policy.get("expires_at"))
    if (
        started is None
        or ends is None
        or policy_start != started
        or policy_ends != ends
        or (ends - started).total_seconds() != 7200
    ):
        return None, "standing_source_policy_trial_window_invalid"
    return {"snapshot": snapshot, "started_at": started, "ends_at": ends}, None


def load_r4_config():
    """Load R4's fixed role/path profile without absorbing task-policy authority."""
    try:
        sources = (R4_PROFILE, R4_ASSIGNMENTS, R4_POLICY)
        if any(_has_reparse_component(path) for path in sources):
            return None, "reparse_point"
        profile_path = R4_PROFILE.resolve(strict=True)
        profile, error = _read_pinned_json(profile_path, R4_PROFILE_SHA256)
        if error == "pin_mismatch":
            return None, "profile_changed"
        if error or not isinstance(profile, dict):
            return None, "invalid_or_unavailable_assignment"
        if (
            profile.get("schema") != "jot.r4.runtime-profile.v1"
            or profile.get("profile_id") != R4_PROFILE_ID
            or profile.get("repository") != REPOSITORY.as_posix()
            or profile.get("R_thread") != R4_THREAD_ID
            or profile.get("assignments")
            != {"path": R4_ASSIGNMENTS.as_posix(), "sha256": R4_ASSIGNMENTS_SHA256}
            or profile.get("policy") != {"path": R4_POLICY.as_posix(), "sha256": R4_POLICY_SHA256}
            or profile.get("tool_release") != R4_TOOL_RELEASE.as_posix()
            or profile.get("standing_source_policy") != R4_STANDING_SOURCE_POLICY.as_posix()
            or profile.get("trial_start_snapshot") != R4_TRIAL_START_SNAPSHOT.as_posix()
            or profile.get("trial_start_pin") != R4_TRIAL_START_PIN.as_posix()
        ):
            return None, "profile_changed"

        standing_policy, error = _load_r4_standing_policy(profile)
        if error:
            return None, error

        assignments_path = R4_ASSIGNMENTS.resolve(strict=True)
        assignments, error = _read_pinned_json(assignments_path, R4_ASSIGNMENTS_SHA256)
        if error == "pin_mismatch":
            return None, "assignments_changed"
        if error or not isinstance(assignments, dict):
            return None, "invalid_or_unavailable_assignment"

        policy_path = R4_POLICY.resolve(strict=True)
        policy, error = _read_pinned_json(policy_path, R4_POLICY_SHA256)
        if error == "pin_mismatch":
            return None, "policy_changed"
        if error or not isinstance(policy, dict):
            return None, "invalid_or_unavailable_assignment"

        workers = assignments.get("workers")
        if (
            assignments.get("schema") != "jot.r4-workers.v1"
            or assignments.get("profile_id") != R4_PROFILE_ID
            or not isinstance(workers, list)
            or len(workers) != 20
            or any(not isinstance(item, dict) for item in workers)
            or {item.get("number") for item in workers} != set(range(1, 21))
        ):
            return None, "assignments_changed"
        all_files_root = ALL_FILES_ROOT.resolve(strict=True)
        for item in workers:
            private = Path(item.get("private_workspace", ""))
            report = Path(item.get("report_directory", ""))
            expected_role = "support" if item["number"] in (13, 14, 15, 20) else "developer"
            if (
                item.get("role") != expected_role
                or item.get("allow_nested_private_git_root") is not True
                or not private.is_absolute()
                or not report.is_absolute()
                or _has_parent_part(private)
                or _has_parent_part(report)
                or not _within_or_equal(private.resolve(strict=False), all_files_root)
                or not _within_or_equal(report.resolve(strict=False), all_files_root)
            ):
                return None, "assignments_changed"

        shared = Path(policy.get("shared_integration", ""))
        if (
            policy.get("schema") != "jot.r4-policy.v1"
            or policy.get("shared_writer") != 13
            or policy.get("formal_ledger_writer") != 14
            or policy.get("custody_owner") != 15
            or policy.get("stats_owner") != 20
            or policy.get("all_files_under") != ALL_FILES_ROOT.as_posix()
            or policy.get("queue_does_not_execute_or_authorize_runner") is not True
            or policy.get("guard_is_not_OS_sandbox_or_permission_issuer") is not True
            or policy.get("no_credentials_or_production") is not True
            or policy.get("no_push_or_deploy") is not True
            or policy.get("no_real_provider_messages") is not True
            or not shared.is_absolute()
            or _has_parent_part(shared)
            or not _within_or_equal(shared.resolve(strict=False), all_files_root)
        ):
            return None, "policy_changed"
        return {
            "profile": profile,
            "assignments": assignments,
            "policy": policy,
            "tool_release": R4_TOOL_RELEASE,
            "standing_source_policy": standing_policy["path"],
            "standing_source_policy_sha256": standing_policy["sha256"],
            "standing_source_policy_pin_path": standing_policy["pin_path"],
            "standing_source_policy_pin": standing_policy["pin"],
            "standing_source_policy_document": standing_policy["document"],
            "product_start_authorized": standing_policy["trial_start"] is not None,
            "trial_start_snapshot": R4_TRIAL_START_SNAPSHOT,
            "trial_start_pin": R4_TRIAL_START_PIN,
        }, None
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None, "invalid_or_unavailable_assignment"


def _load_r5_phase_state(trial, *, product):
    path = R5_PROFILE.parent / "phase-state.json"
    if _has_reparse_component(path):
        return None, "phase_state_invalid"
    try:
        state = json.loads(path.read_bytes().decode("utf-8"))
    except FileNotFoundError:
        return None, "phase_state_unavailable"
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None, "phase_state_invalid"
    declared = state.get("trial") if isinstance(state, dict) else None
    if not isinstance(declared, dict) or state.get("schema") != "jot.r5.phase.v1":
        return None, "phase_state_invalid"
    if product:
        phase_start = _utc_rfc3339(declared.get("started_at"))
        phase_ends = _utc_rfc3339(declared.get("ends_at"))
        if (
            declared.get("started") is not True
            or declared.get("new_product_dispatch_allowed") is not True
            or phase_start != trial["started_at"]
            or phase_ends != trial["ends_at"]
            or declared.get("duration_seconds") != 7200
        ):
            return None, "phase_state_start_mismatch"
    elif (
        state.get("phase") != "rectification_preparation"
        or declared.get("started") is not False
        or declared.get("started_at") is not None
        or declared.get("ends_at") is not None
        or declared.get("new_product_dispatch_allowed") is not False
    ):
        return None, "phase_state_not_preparation"
    return state, None


def _load_r5_trial_start(profile, policy, policy_sha256):
    if (
        profile.get("trial_start_snapshot") != R5_TRIAL_START_SNAPSHOT.as_posix()
        or profile.get("trial_start_pin") != R5_TRIAL_START_PIN.as_posix()
        or _has_reparse_component(R5_TRIAL_START_PIN)
        or _has_reparse_component(R5_TRIAL_START_SNAPSHOT)
    ):
        return None, "standing_source_policy_trial_start_pin_invalid"
    try:
        pin_path = R5_TRIAL_START_PIN.resolve(strict=True)
        snapshot_path = R5_TRIAL_START_SNAPSHOT.resolve(strict=True)
        start_pin = json.loads(pin_path.read_bytes().decode("utf-8"))
    except FileNotFoundError:
        return None, "standing_source_policy_trial_start_pin_unavailable"
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None, "standing_source_policy_trial_start_pin_invalid"
    fields = {"schema", "trial_id", "snapshot_path", "snapshot_sha256", "immutable"}
    if (
        not isinstance(start_pin, dict)
        or set(start_pin) != fields
        or start_pin.get("schema") != "jot.r5.trial-start-pin.v1"
        or start_pin.get("trial_id") != R5_PROFILE_ID
        or start_pin.get("snapshot_path") != profile.get("trial_start_snapshot")
        or start_pin.get("immutable") is not True
    ):
        return None, "standing_source_policy_trial_start_pin_invalid"
    snapshot_sha256 = start_pin.get("snapshot_sha256")
    if (
        not isinstance(snapshot_sha256, str)
        or len(snapshot_sha256) != 64
        or any(char not in "0123456789abcdef" for char in snapshot_sha256)
    ):
        return None, "standing_source_policy_trial_start_pin_invalid"
    try:
        snapshot, error = _read_pinned_json(snapshot_path, snapshot_sha256)
    except OSError:
        return None, "standing_source_policy_trial_start_snapshot_unavailable"
    if error == "pin_mismatch":
        return None, "standing_source_policy_trial_start_snapshot_changed"
    if error or not isinstance(snapshot, dict):
        return None, "standing_source_policy_trial_start_snapshot_invalid"
    if (
        snapshot.get("schema") != "jot.r5.trial-start-snapshot.v1"
        or snapshot.get("trial_id") != R5_PROFILE_ID
        or snapshot.get("scope_profile")
        != {"path": R5_PROFILE.as_posix(), "sha256": R5_PROFILE_SHA256}
        or snapshot.get("standing_source_policy")
        != {"path": R5_STANDING_SOURCE_POLICY.as_posix(), "sha256": policy_sha256}
    ):
        return None, "standing_source_policy_trial_start_snapshot_invalid"
    trial_data = snapshot.get("trial")
    if (
        not isinstance(trial_data, dict)
        or trial_data.get("started") is not True
        or trial_data.get("real_product_trial_started") is not True
        or trial_data.get("duration_seconds") != 7200
    ):
        return None, "standing_source_policy_start_not_authorized"
    started = _utc_rfc3339(trial_data.get("started_at"))
    ends = _utc_rfc3339(trial_data.get("ends_at"))
    policy_start = _utc_rfc3339(policy.get("valid_from"))
    policy_ends = _utc_rfc3339(policy.get("expires_at"))
    if (
        started is None
        or ends is None
        or policy_start != started
        or policy_ends != ends
        or (ends - started).total_seconds() != 7200
    ):
        return None, "standing_source_policy_trial_window_invalid"
    now = dt.datetime.now(dt.timezone.utc)
    if not started <= now < ends:
        return None, "standing_source_policy_trial_window_expired"
    _, phase_error = _load_r5_phase_state({"started_at": started, "ends_at": ends}, product=True)
    if phase_error:
        return None, phase_error
    return {"snapshot": snapshot, "started_at": started, "ends_at": ends}, None


def _load_r5_standing_policy(profile):
    current = profile.get("current_trial_authority")
    if current is not None:
        if profile.get("profile_id") != R5_PROFILE_ID:
            return None, "current_trial_authority_invalid"
        current_config, config_error = load_r5_config()
        if config_error or not current_config:
            return None, "current_trial_authority_invalid"
        current = current_config.get("current_trial_authority")
        if current is None:
            return None, "current_trial_authority_unavailable"
        trial = current["trial"]
        started = _utc_rfc3339(trial.get("started_at"))
        ends = _utc_rfc3339(trial.get("ends_at"))
        if started is None or ends is None:
            return None, "current_trial_authority_invalid"
        _, phase_error = _load_r5_phase_state(
            {"started_at": started, "ends_at": ends}, product=True
        )
        if phase_error:
            return None, phase_error
        now = dt.datetime.now(dt.timezone.utc)
        if not started <= now < ends:
            return None, "standing_source_policy_trial_window_expired"
        return {
            "path": current["policy_path"],
            "sha256": current["policy_sha256"],
            "pin_path": current["pin_path"],
            "pin": current["pin"],
            "document": current["policy"],
            "trial_start": {
                "snapshot": current["snapshot"],
                "started_at": started,
                "ends_at": ends,
            },
        }, None

    pin_path = R5_STANDING_SOURCE_POLICY_PIN
    if (
        profile.get("standing_source_policy") != R5_STANDING_SOURCE_POLICY.as_posix()
        or _has_reparse_component(pin_path)
        or _has_reparse_component(R5_STANDING_SOURCE_POLICY)
    ):
        return None, "standing_source_policy_pin_invalid"
    try:
        pin_path = pin_path.resolve(strict=True)
        pin = json.loads(pin_path.read_bytes().decode("utf-8"))
    except FileNotFoundError:
        return None, "standing_source_policy_pin_unavailable"
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return None, "standing_source_policy_pin_invalid"
    policy_ref = pin.get("policy") if isinstance(pin, dict) else None
    if (
        not isinstance(policy_ref, dict)
        or pin.get("schema") != "jot.r5-standing-policy-pin.v1"
        or pin.get("issued_by") != "R"
        or pin.get("profile_id") != R5_PROFILE_ID
        or pin.get("scope_profile")
        != {"path": R5_PROFILE.as_posix(), "sha256": R5_PROFILE_SHA256}
        or policy_ref.get("path") != R5_STANDING_SOURCE_POLICY.as_posix()
        or profile.get("standing_source_policy") != policy_ref.get("path")
        or pin.get("event_scope") not in ("preparation", "product")
        or type(pin.get("product_START_authorized")) is not bool
    ):
        return None, "standing_source_policy_pin_invalid"
    policy_sha256 = policy_ref.get("sha256")
    if (
        not isinstance(policy_sha256, str)
        or len(policy_sha256) != 64
        or any(char not in "0123456789abcdef" for char in policy_sha256)
    ):
        return None, "standing_source_policy_pin_invalid"
    try:
        policy_path = R5_STANDING_SOURCE_POLICY.resolve(strict=True)
        policy, error = _read_pinned_json(policy_path, policy_sha256)
    except OSError:
        return None, "standing_source_policy_unavailable"
    if error == "pin_mismatch":
        return None, "standing_source_policy_changed"
    if error or not isinstance(policy, dict):
        return None, "standing_source_policy_invalid"
    if (
        policy.get("schema_version") != 1
        or policy.get("mode") != "standing_scope"
        or policy.get("writer") != 13
        or policy.get("trial_id") != R5_PROFILE_ID
        or policy.get("guard_profile_sha256") != R5_PROFILE_SHA256
        or policy.get("event_scope") != pin.get("event_scope")
    ):
        return None, "standing_source_policy_start_not_authorized"
    try:
        scope, error = _read_pinned_json(R5_POLICY.resolve(strict=True), R5_POLICY_SHA256)
    except OSError:
        return None, "policy_unavailable"
    if error or not isinstance(scope, dict) or policy.get("target_repo") != scope.get("shared_integration"):
        return None, "standing_source_policy_target_mismatch"
    trial_start = None
    if policy.get("event_scope") == "preparation":
        if pin.get("product_START_authorized") is not False:
            return None, "standing_source_policy_start_not_authorized"
        _, error = _load_r5_phase_state(None, product=False)
        if error:
            return None, error
    elif policy.get("event_scope") == "product":
        if pin.get("product_START_authorized") is not True:
            return None, "standing_source_policy_start_not_authorized"
        trial_start, error = _load_r5_trial_start(profile, policy, policy_sha256)
        if error:
            return None, error
    else:
        return None, "standing_source_policy_start_not_authorized"
    return {
        "path": policy_path,
        "sha256": policy_sha256,
        "pin_path": pin_path,
        "pin": pin,
        "document": policy,
        "trial_start": trial_start,
    }, None


def load_r5_config():
    """Load only the fixed R5 profile and role/path files; START is a separate gate."""
    try:
        sources = (R5_PROFILE_PIN, R5_PROFILE, R5_ASSIGNMENTS, R5_POLICY)
        if any(_has_reparse_component(path) for path in sources):
            return None, "reparse_point"
        profile_pin, error = _read_pinned_json(R5_PROFILE_PIN.resolve(strict=True), R5_PROFILE_PIN_SHA256)
        if error == "pin_mismatch":
            return None, "profile_pin_changed"
        if error or not isinstance(profile_pin, dict):
            return None, "profile_pin_invalid"
        profile_path = R5_PROFILE.resolve(strict=True)
        profile, error = _read_pinned_json(profile_path, R5_PROFILE_SHA256)
        if error == "pin_mismatch":
            return None, "profile_changed"
        if error or not isinstance(profile, dict):
            return None, "invalid_or_unavailable_assignment"
        if (
            Path(profile_pin.get("path", "")).resolve(strict=True) != profile_path
            or profile_pin.get("sha256") != R5_PROFILE_SHA256
            or profile_pin.get("profile_id") != R5_PROFILE_ID
            or profile.get("schema") != "jot.r5.runtime-profile.v1"
            or profile.get("profile_id") != R5_PROFILE_ID
            or profile.get("repository") != REPOSITORY.as_posix()
            or profile.get("R_thread") != R5_THREAD_ID
            or profile.get("assignments")
            != {"path": R5_ASSIGNMENTS.as_posix(), "sha256": R5_ASSIGNMENTS_SHA256}
            or profile.get("policy") != {"path": R5_POLICY.as_posix(), "sha256": R5_POLICY_SHA256}
            or profile.get("tool_release") != R5_TOOL_RELEASE.as_posix()
            or profile.get("standing_source_policy") != R5_STANDING_SOURCE_POLICY.as_posix()
            or profile.get("trial_start_snapshot") != R5_TRIAL_START_SNAPSHOT.as_posix()
            or profile.get("trial_start_pin") != R5_TRIAL_START_PIN.as_posix()
        ):
            return None, "profile_changed"
        assignments, error = _read_pinned_json(R5_ASSIGNMENTS.resolve(strict=True), R5_ASSIGNMENTS_SHA256)
        if error == "pin_mismatch":
            return None, "assignments_changed"
        if error or not isinstance(assignments, dict):
            return None, "invalid_or_unavailable_assignment"
        policy, error = _read_pinned_json(R5_POLICY.resolve(strict=True), R5_POLICY_SHA256)
        if error == "pin_mismatch":
            return None, "policy_changed"
        if error or not isinstance(policy, dict):
            return None, "invalid_or_unavailable_assignment"
        workers = assignments.get("workers")
        if (
            assignments.get("schema") != "jot.r5.workers.v1"
            or assignments.get("profile_id") != R5_PROFILE_ID
            or not isinstance(workers, list)
            or len(workers) != 20
            or any(not isinstance(item, dict) for item in workers)
            or {item.get("number") for item in workers} != set(range(1, 21))
        ):
            return None, "assignments_changed"
        all_files_root = ALL_FILES_ROOT.resolve(strict=True)
        for item in workers:
            private = Path(item.get("private_workspace", ""))
            report = Path(item.get("report_directory", ""))
            expected_role = "support" if item["number"] in (13, 14, 15, 20) else "developer"
            if (
                item.get("role") != expected_role
                or item.get("host_id") != "local"
                or not isinstance(item.get("thread_id"), str)
                or not item["thread_id"]
                or item.get("allow_nested_private_git_root") is not True
                or not private.is_absolute()
                or not report.is_absolute()
                or _has_parent_part(private)
                or _has_parent_part(report)
                or not _within_or_equal(private.resolve(strict=False), all_files_root)
                or not _within_or_equal(report.resolve(strict=False), all_files_root)
            ):
                return None, "assignments_changed"
        shared = Path(policy.get("shared_integration", ""))
        if (
            policy.get("schema") != "jot.r5-policy.v1"
            or policy.get("human_authorization", {}).get("R_thread") != R5_THREAD_ID
            or policy.get("shared_writer") != 13
            or policy.get("formal_ledger_writer") != 14
            or policy.get("custody_owner") != 15
            or policy.get("stats_owner") != 20
            or policy.get("all_files_under") != ALL_FILES_ROOT.as_posix()
            or policy.get("queue_does_not_execute_or_authorize_runner") is not True
            or policy.get("guard_is_not_OS_sandbox_or_permission_issuer") is not True
            or policy.get("no_credentials_or_production") is not True
            or policy.get("no_push_or_deploy") is not True
            or policy.get("no_real_provider_messages") is not True
            or not shared.is_absolute()
            or _has_parent_part(shared)
            or not _within_or_equal(shared.resolve(strict=False), all_files_root)
        ):
            return None, "policy_changed"
        profile_authority = {
            "profile": profile,
            "profile_sha256": R5_PROFILE_SHA256,
            "workers_by_number": {item["number"]: item for item in workers},
            "assignments": assignments,
            "policy": policy,
        }
        try:
            current_trial = _load_current_trial_authority(
                profile_authority, REPOSITORY, R5_PROFILE.parent
            )
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return None, "current_trial_binding_invalid"
        runtime_profile = dict(profile)
        if current_trial is not None:
            runtime_profile["current_trial_authority"] = current_trial
        return {
            "profile": runtime_profile,
            "assignments": assignments,
            "policy": policy,
            "current_trial_authority": current_trial,
            "tool_release": R5_TOOL_RELEASE,
            "standing_source_policy": R5_STANDING_SOURCE_POLICY,
            "trial_start_snapshot": R5_TRIAL_START_SNAPSHOT,
            "trial_start_pin": R5_TRIAL_START_PIN,
        }, None
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None, "invalid_or_unavailable_assignment"


def check_r4(worker_number, target_arg):
    config, error = load_r4_config()
    if error:
        return _deny(error, worker_number)
    workers = [item for item in config["assignments"]["workers"] if item.get("number") == worker_number]
    if len(workers) != 1:
        return _deny("unknown_worker", worker_number)
    assignment = workers[0]
    private_root_path = Path(assignment["private_workspace"])
    report_dir_path = Path(assignment["report_directory"])
    shared_root_path = Path(config["policy"]["shared_integration"])
    roots = (private_root_path, report_dir_path, shared_root_path, ALL_FILES_ROOT)
    if any(_has_reparse_component(path) for path in roots):
        return _deny("reparse_point", worker_number)
    try:
        private_root = private_root_path.resolve(strict=True)
        report_dir = report_dir_path.resolve(strict=False)
        shared_root = shared_root_path.resolve(strict=True)
        all_files_root = ALL_FILES_ROOT.resolve(strict=True)
        cwd_path = Path.cwd()
        if _has_reparse_component(cwd_path):
            return _deny("reparse_point", worker_number, cwd=cwd_path)
        cwd = cwd_path.resolve(strict=True)
        git = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )
        if git.returncode != 0:
            return _deny("git_root_unavailable", worker_number, cwd=cwd)
        git_root_path = Path(git.stdout.strip())
        if _has_reparse_component(git_root_path):
            return _deny("reparse_point", worker_number, cwd=cwd)
        git_root = git_root_path.resolve(strict=True)
        shared_cwd = _within_or_equal(cwd, shared_root)
        is_shared_writer = worker_number == config["policy"]["shared_writer"]
        if shared_cwd and not is_shared_writer:
            return _deny("shared_integration_cwd_forbidden", worker_number, cwd=cwd, git_root=git_root)
        if shared_cwd:
            if git_root != shared_root:
                return _deny("git_root_mismatch", worker_number, cwd=cwd, git_root=git_root)
        elif (
            not _within_or_equal(cwd, private_root)
            or not _within_or_equal(git_root, private_root)
            or not _within_or_equal(cwd, git_root)
            or (assignment.get("allow_nested_private_git_root") is not True and git_root != private_root)
        ):
            return _deny("git_root_mismatch", worker_number, cwd=cwd, git_root=git_root)
        raw_target = Path(target_arg)
        if _has_parent_part(raw_target):
            return _deny("parent_traversal", worker_number, cwd=cwd, git_root=git_root, target=raw_target)
        candidate = raw_target if raw_target.is_absolute() else cwd / raw_target
        if _has_reparse_component(candidate):
            return _deny("reparse_point", worker_number, cwd=cwd, git_root=git_root, target=candidate)
        target = candidate.resolve(strict=False)
        if not _within(target, all_files_root):
            return _deny("target_outside_allowed_roots", worker_number, cwd=cwd, git_root=git_root, target=target)
        if is_shared_writer and _within(target, shared_root):
            reason = "worker13_shared_integration"
        elif worker_number == config["policy"]["formal_ledger_writer"] and target == FORMAL_LEDGER.resolve(strict=False):
            reason = "worker14_formal_ledger"
        elif _within(target, private_root):
            reason = "private_workspace"
        elif _within(target, report_dir):
            reason = "report_directory"
        else:
            return _deny("target_outside_allowed_roots", worker_number, cwd=cwd, git_root=git_root, target=target)
        return {
            "allowed": True,
            "worker": worker_number,
            "cwd": str(cwd),
            "git_root": str(git_root),
            "target": str(target),
            "reason": reason,
            "os_sandbox_enforced": False,
            "permission_issued": False,
        }
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return _deny("invalid_or_unavailable_assignment", worker_number)


def check_r5(worker_number, target_arg):
    config, error = load_r5_config()
    if error:
        return _deny(error, worker_number)
    workers = [item for item in config["assignments"]["workers"] if item.get("number") == worker_number]
    if len(workers) != 1:
        return _deny("unknown_worker", worker_number)
    assignment = workers[0]
    private_root_path = Path(assignment["private_workspace"])
    report_dir_path = Path(assignment["report_directory"])
    shared_root_path = Path(config["policy"]["shared_integration"])
    roots = (private_root_path, report_dir_path, shared_root_path, ALL_FILES_ROOT)
    if any(_has_reparse_component(path) for path in roots):
        return _deny("reparse_point", worker_number)
    try:
        private_root = private_root_path.resolve(strict=True)
        report_dir = report_dir_path.resolve(strict=False)
        shared_root = shared_root_path.resolve(strict=True)
        all_files_root = ALL_FILES_ROOT.resolve(strict=True)
        cwd_path = Path.cwd()
        if _has_reparse_component(cwd_path):
            return _deny("reparse_point", worker_number, cwd=cwd_path)
        cwd = cwd_path.resolve(strict=True)
        git = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            text=True,
            capture_output=True,
            check=False,
        )
        if git.returncode != 0:
            return _deny("git_root_unavailable", worker_number, cwd=cwd)
        git_root_path = Path(git.stdout.strip())
        if _has_reparse_component(git_root_path):
            return _deny("reparse_point", worker_number, cwd=cwd)
        git_root = git_root_path.resolve(strict=True)
        shared_cwd = _within_or_equal(cwd, shared_root)
        is_shared_writer = worker_number == config["policy"]["shared_writer"]
        if shared_cwd and not is_shared_writer:
            return _deny("shared_integration_cwd_forbidden", worker_number, cwd=cwd, git_root=git_root)
        if shared_cwd:
            if git_root != shared_root:
                return _deny("git_root_mismatch", worker_number, cwd=cwd, git_root=git_root)
        elif (
            not _within_or_equal(cwd, private_root)
            or not _within_or_equal(git_root, private_root)
            or not _within_or_equal(cwd, git_root)
            or (assignment.get("allow_nested_private_git_root") is not True and git_root != private_root)
        ):
            return _deny("git_root_mismatch", worker_number, cwd=cwd, git_root=git_root)
        raw_target = Path(target_arg)
        if _has_parent_part(raw_target):
            return _deny("parent_traversal", worker_number, cwd=cwd, git_root=git_root, target=raw_target)
        candidate = raw_target if raw_target.is_absolute() else cwd / raw_target
        if _has_reparse_component(candidate):
            return _deny("reparse_point", worker_number, cwd=cwd, git_root=git_root, target=candidate)
        target = candidate.resolve(strict=False)
        if not _within(target, all_files_root):
            return _deny("target_outside_allowed_roots", worker_number, cwd=cwd, git_root=git_root, target=target)
        if is_shared_writer and _within(target, shared_root):
            reason = "worker13_shared_integration"
        elif worker_number == config["policy"]["formal_ledger_writer"] and target == FORMAL_LEDGER.resolve(strict=False):
            reason = "worker14_formal_ledger"
        elif _within(target, private_root):
            reason = "private_workspace"
        elif _within(target, report_dir):
            reason = "report_directory"
        else:
            return _deny("target_outside_allowed_roots", worker_number, cwd=cwd, git_root=git_root, target=target)
        return {
            "allowed": True,
            "worker": worker_number,
            "cwd": str(cwd),
            "git_root": str(git_root),
            "target": str(target),
            "reason": reason,
            "os_sandbox_enforced": False,
            "permission_issued": False,
        }
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return _deny("invalid_or_unavailable_assignment", worker_number)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("r5",), default="r5")
    parser.add_argument("--assignments")
    parser.add_argument("--worker", required=True, type=int)
    parser.add_argument("--target", required=True)
    args = parser.parse_args(argv)
    result = (
        _deny("r5_assignment_override_forbidden", args.worker)
        if args.assignments is not None
        else check_r5(args.worker, args.target)
    )
    print(json.dumps(result, sort_keys=True))
    return 0 if result["allowed"] else 1


if __name__ == "__main__":
    sys.exit(main())
