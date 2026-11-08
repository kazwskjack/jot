#!/usr/bin/env python3
"""Append one actor-reported event to the current worker's private R3 stream."""

import argparse
import errno
import json
import os
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import metrics


STATE_TYPES = {
    "start": "product_work_started",
    "blocked": "blocked",
    "resumed": "resumed",
    "ready": "ready",
    "next_primary": "next_primary",
}
ACTOR_EVENT_TYPES = frozenset(STATE_TYPES.values())
ALLOWED_NEXT = {
    None: frozenset(("product_work_started",)),
    "received": frozenset(("product_work_started",)),
    "product_work_started": frozenset(("blocked", "ready")),
    "blocked": frozenset(("resumed",)),
    "resumed": frozenset(("blocked", "ready")),
    "ready": frozenset(("next_primary",)),
    "next_primary": frozenset(),
}


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _current_worker(authority):
    cwd = Path.cwd().resolve(strict=True)
    matches = [worker for worker in authority["workers_by_number"].values()
               if Path(worker["private_workspace"]) == cwd]
    if len(matches) != 1:
        raise ValueError("current working directory is not exactly one R3-pinned worker private_workspace")
    worker = matches[0]
    number = worker["number"]
    order = authority["work_orders_by_worker"].get(number)
    if order is None:
        raise ValueError("current worker has no R3-pinned work order in the start snapshot")
    return worker, order


def _event_target(authority):
    worker, order = _current_worker(authority)
    workspace = Path(worker["private_workspace"]).resolve(strict=True)
    report_root = workspace / "private" / "reports" / "r3"
    try:
        report_root.resolve(strict=False).relative_to(workspace)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("private R3 report path escapes the pinned worker workspace") from exc
    report_root.mkdir(parents=True, exist_ok=True)
    try:
        report_root = report_root.resolve(strict=True)
        report_root.relative_to(workspace)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("private R3 report path escapes the pinned worker workspace") from exc
    owner = str(worker["number"])
    event_path = report_root / ("owner-%s.jsonl" % owner)
    try:
        event_path.resolve(strict=False).relative_to(workspace)
    except ValueError as exc:
        raise ValueError("worker event file escapes the pinned worker workspace") from exc
    return worker, order, workspace, event_path


@contextmanager
def _event_stream_lock(event_path, workspace):
    lock_path = event_path.with_name(event_path.name + ".lock")
    try:
        lock_path.resolve(strict=False).relative_to(workspace)
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("worker event lock file escapes the pinned worker workspace") from exc
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_BINARY", 0)
    descriptor = os.open(str(lock_path), flags, 0o600)
    with os.fdopen(descriptor, "r+b") as lock_file:
        lock_file.seek(0, os.SEEK_END)
        if lock_file.tell() == 0:
            lock_file.write(b"\0")
            lock_file.flush()

        if os.name == "nt":
            import msvcrt

            retry_errors = {errno.EACCES, errno.EAGAIN, getattr(errno, "EDEADLK", errno.EACCES)}
            while True:
                lock_file.seek(0)
                try:
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError as exc:
                    if exc.errno not in retry_errors:
                        raise
                    time.sleep(0.05)
            try:
                yield
            finally:
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _read_task_history(path, workspace, trial_id, owner, task_owner, task_id, source_class):
    if not path.exists():
        return []
    history = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        raise ValueError("cannot read the current worker event stream: %s" % exc) from exc
    seen_ids = set()
    for line_number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            event, occurred = metrics._validate_event(metrics._strict_json_loads(line), workspace)
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError("owner event stream line %s is invalid: %s" % (line_number, exc)) from exc
        if event["event_id"] in seen_ids:
            raise ValueError("owner event stream contains a duplicate event_id")
        seen_ids.add(event["event_id"])
        if event["owner"] != owner:
            raise ValueError("owner event stream contains an event owned by a different worker")
        if event.get("task_owner") != task_owner or event.get("task_id") != task_id:
            continue
        if event.get("trial_id") != trial_id or event["source_class"] != source_class:
            raise ValueError("task history does not match the pinned R3 trial and work-order source class")
        history.append((event, occurred))
    return history


def _prepare_event(args, authority, target=None):
    now_text = utc_now()
    now = metrics._utc_time(now_text, "actor-reported event time")
    started = metrics._utc_time(authority["started_at"], "R3 snapshot trial.started_at")
    ended = metrics._utc_time(authority["ends_at"], "R3 snapshot trial.ends_at")
    if not started <= now <= ended:
        raise ValueError("actor-reported event time is outside the pinned R3 trial window")

    worker, order, workspace, event_path = target or _event_target(authority)
    task_id = args.task_id
    source_class = order["source_class_by_task"].get(task_id)
    if task_id not in (order["primary_id"], order["backup_id"]) or source_class not in metrics.SOURCE_CLASSES:
        raise ValueError("task ID is not mapped by the current worker's pinned work order")
    event_type = STATE_TYPES[args.state]
    if event_type == "next_primary":
        if not args.next_owner:
            raise ValueError("next_primary state requires --next-owner")
        if args.next_owner not in {str(number) for number in authority["workers_by_number"]}:
            raise ValueError("next_owner does not match a pinned R3 worker")
    elif args.next_owner is not None:
        raise ValueError("--next-owner is only valid with next_primary")

    owner = str(worker["number"])
    task_owner = worker["number"]
    history = _read_task_history(
        event_path, workspace, authority["trial_id"], owner, task_owner, task_id, source_class
    )
    actor_history = [event for event, _occurred in history if event["event_type"] in ACTOR_EVENT_TYPES]
    previous_event = actor_history[-1] if actor_history else None
    if previous_event is None and any(event["event_type"] == "received" for event, _occurred in history):
        previous_event = {"event_type": "received"}
    previous_type = previous_event["event_type"] if previous_event else None
    if event_type not in ALLOWED_NEXT.get(previous_type, frozenset()):
        raise ValueError("invalid task event transition from %s to %s" % (previous_type, event_type))
    if history and now < history[-1][1]:
        raise ValueError("actor-reported time cannot move backwards within a task event stream")

    event = {
        "schema_version": 1,
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "occurred_at": now_text,
        "owner": owner,
        "packet_id": "%s%d:%s" % (metrics.R3_ACTOR_PACKET_ID_PREFIX, task_owner, task_id),
        "task_owner": task_owner,
        "task_id": task_id,
        "source_class": source_class,
        "trial_id": authority["trial_id"],
        "timestamp_provenance": {
            "basis": "actor_reported",
            "process_observed_at": None,
            "actor_reported_at": now_text,
            "native_observed_at": None,
        },
    }
    if event_type == "next_primary":
        event["next_owner"] = args.next_owner
    metrics._validate_r3_event_work_order(event, authority, "actor-reported event")
    metrics._validate_event(event, workspace)
    return event_path, workspace, event


def record_event(args):
    authority = metrics.load_r3_start_authority()
    target = _event_target(authority)
    _worker, _order, workspace, event_path = target
    with _event_stream_lock(event_path, workspace):
        event_path, _workspace, event = _prepare_event(args, authority, target)
        encoded = json.dumps(event, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        try:
            with event_path.open("a", encoding="utf-8", newline="\n") as stream:
                stream.write(encoded + "\n")
        except OSError as exc:
            raise ValueError("cannot append to the current worker's private event stream: %s" % exc) from exc
    return event


def main(argv=None):
    parser = argparse.ArgumentParser(description="Append one actor-reported event for the current R3 worker")
    parser.add_argument("--task-id", required=True, help="original primary or backup task ID from the pinned work order")
    parser.add_argument("--state", required=True, choices=tuple(STATE_TYPES), help="reported workflow transition")
    parser.add_argument("--next-owner", help="required destination worker for next_primary")
    args = parser.parse_args(argv)
    try:
        event = record_event(args)
    except (OSError, ValueError) as exc:
        print("work-event: %s" % exc, file=sys.stderr)
        return 2
    print(json.dumps(event, ensure_ascii=False, sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
