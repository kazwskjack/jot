"""R5-only verifier for native command receipts and worker interval rows."""

import hashlib
import json
import re
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path, PureWindowsPath

from authority import TRIAL_SECONDS, load_r5_trial_authority


R5_PROFILE_ID = "jot-parallel-r5-20261025"
UTC_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$")
REQUIRED_RECEIPT_FIELDS = {
    "schema", "captured_at_utc", "profile_id", "seat", "assigned_thread_id", "task_id",
    "work_order_owner", "cwd", "turn_id", "item_id", "receipt_id", "started_at", "completed_at",
    "exit_code", "duration_ms", "command_sha256", "command_semantics", "stdout_path", "stdout_sha256",
    "stream_path", "line_number", "line_sha256", "row_start_utc", "row_end_utc", "row_task_id",
}
REQUIRED_NATIVE_ITEM_FIELDS = {"thread_id", "turn_id", "id", "cwd", "command", "exitCode", "durationMs"}


def _unknown(reason):
    return {
        "native_observed": False,
        "reason": reason,
        "command_kind": "unknown",
        "effective_work_class": "unknown",
        "machine_seconds": None,
        "receipt_seconds": None,
        "person_hours": None,
    }


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _normalise_command(command):
    return command.replace("\\\\", "\\").replace('\\"', '"').replace("'\"'", "'")


def _node_test_paths(command):
    normalised = _normalise_command(command)
    matches = list(re.finditer(r"(?:&\s*)node(?:\.exe)?\s+--test\b(.*?)(?=\s+2>&1\b)", normalised, re.I | re.S))
    if len(matches) != 1:
        return None
    match = matches[0]
    raw = match.group(1).strip()
    tokens = re.findall(r"'([^']*)'|\"([^\"]*)\"|(\S+)", raw)
    paths = [next(value for value in token if value) for token in tokens]
    return paths or None


def _execution_test_paths(paths, cwd, execution_workspace):
    root = Path(execution_workspace).resolve(strict=True)
    current = Path(cwd).resolve(strict=True)
    resolved = []
    for value in paths:
        path = Path(value)
        if path.is_absolute() or PureWindowsPath(value).is_absolute():
            return None
        target = (current / path).resolve()
        try:
            relative = target.relative_to(root)
        except ValueError:
            return None
        if not relative.parts:
            return None
        resolved.append(relative.as_posix())
    return resolved


def _utc_seconds(value):
    match = UTC_RE.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ValueError("timestamp must be UTC with at most seven fractional digits")
    whole = datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    fraction = Decimal("0." + match.group(2)) if match.group(2) else Decimal(0)
    return Decimal(str(int(whole.timestamp()))) + fraction


def _seconds_between(start, end):
    return _utc_seconds(end) - _utc_seconds(start)


def _private_path(workspace, relative):
    if not isinstance(relative, str) or not relative.strip():
        raise ValueError("path is missing")
    if (
        Path(relative).is_absolute()
        or PureWindowsPath(relative).is_absolute()
        or ".." in Path(relative).parts
        or ".." in PureWindowsPath(relative).parts
    ):
        raise ValueError("path is not a private relative path")
    root = Path(workspace).resolve(strict=True)
    result = (root / relative).resolve(strict=True)
    try:
        result.relative_to(root)
    except ValueError as exc:
        raise ValueError("path escapes the assigned private workspace") from exc
    return result


def _task_binding(work_order, task_id):
    tasks = work_order.get("tasks")
    task = tasks.get(task_id) if isinstance(tasks, dict) else None
    if not isinstance(task, dict) or not isinstance(task.get("test_paths"), list):
        return None
    allowed = task["test_paths"]
    if not allowed or any(not isinstance(path, str) or not path for path in allowed):
        return None
    return set(allowed)


def _wrapper_matches_workspace(command, workspace, actual_cwd=None):
    normalised = _normalise_command(command)
    assignments = list(re.finditer(r"\$w\s*=", normalised, re.I))
    locations = list(re.finditer(r"\bset-location\b", normalised, re.I))
    node = re.search(r"(?:&\s*)node(?:\.exe)?\s+--test\b", normalised, re.I)
    aliases = re.search(r"(?:^|[;&|]\s*|&\s*)(?:sl|cd|chdir|pushd|push-location|popd|pop-location)\b", normalised, re.I)
    if len(assignments) != 1 or len(locations) != 1 or node is None or aliases is not None:
        return False

    statements = [item.strip() for item in normalised[:node.start()].split(";")]
    if statements and not statements[-1]:
        statements.pop()
    if len(statements) != 4:
        return False
    assignment = re.fullmatch(r"\$w\s*=\s*(.*?)\s*", statements[0], re.I | re.S)
    location = re.fullmatch(r"set-location\s+-literalpath\s+(.*?)\s*", statements[1], re.I | re.S)
    reports = re.fullmatch(r"\$reports\s*=\s*Join-Path\s+\$w\s+(['\"])(.*?)\1\s*", statements[2], re.I | re.S)
    log = re.fullmatch(r"\$log\s*=\s*Join-Path\s+\$reports\s+(['\"])(.*?)\1\s*", statements[3], re.I | re.S)
    reverse_location = re.fullmatch(r"set-location\s+-literalpath\s+(.*?)\s*", statements[3], re.I | re.S)
    reverse_reports = re.fullmatch(r"\$reports\s*=\s*Join-Path\s+\$w\s+(['\"])(.*?)\1\s*", statements[1], re.I | re.S)
    reverse_log = re.fullmatch(r"\$log\s*=\s*Join-Path\s+\$reports\s+(['\"])(.*?)\1\s*", statements[2], re.I | re.S)
    if assignment is None:
        return False

    assigned_value = assignment.group(1).strip()
    if assigned_value[:1] in "'\"":
        quote = assigned_value[0]
        assigned_value = assigned_value[1:-1] if assigned_value.endswith(quote) else assigned_value[1:]
    if "'" in assigned_value or '"' in assigned_value:
        return False

    location_match = location or reverse_location
    setup_order_matches = (
        location is not None and reports is not None and log is not None
    ) or (
        reverse_location is not None and reverse_reports is not None and reverse_log is not None
    )
    if location_match is None or not setup_order_matches:
        return False

    assigned_path = Path(assigned_value)
    if not assigned_path.is_absolute() or not assigned_path.exists():
        return False
    assigned_path = assigned_path.resolve(strict=True)
    expected_root = Path(workspace).resolve(strict=True)
    target = location_match.group(1).strip().strip("\"'")
    if target.lower() == "$w":
        location_path = assigned_path
    else:
        location_path = Path(target)
        if not location_path.is_absolute() or not location_path.exists():
            return False
        location_path = location_path.resolve(strict=True)
    expected_cwd = Path(actual_cwd if actual_cwd is not None else workspace).resolve(strict=True)
    return assigned_path == expected_root and location_path == expected_cwd


def _wrapper_output_paths_match(command, stdout_path, stream_path):
    normalised = _normalise_command(command)
    reports_assignment = re.search(r"\$reports\s*=\s*Join-Path\s+\$w\s+(['\"])(.*?)\1\s*;", normalised, re.I)
    log_assignment = re.search(r"\$log\s*=\s*Join-Path\s+\$reports\b([^;]*);", normalised, re.I)
    add_index = normalised.lower().find("add-content")
    append_end = normalised.lower().find("-value", add_index) if add_index >= 0 else -1
    append = normalised[add_index:append_end] if add_index >= 0 and append_end > add_index else ""
    tee = re.search(r"tee-object\s+-filepath\b[^;]*\$log", normalised, re.I)
    digest = re.search(r"get-filehash\s+-literalpath\s+\$log", normalised, re.I)
    expected_report_dir = PureWindowsPath("private/reports/r5")
    if (
        reports_assignment is None
        or PureWindowsPath(reports_assignment.group(2)) != expected_report_dir
        or PureWindowsPath(stdout_path).parent != expected_report_dir
        or PureWindowsPath(stream_path).parent != expected_report_dir
        or log_assignment is None
        or not append
        or tee is None
        or digest is None
    ):
        return False
    return (
        Path(stdout_path).name.lower() in log_assignment.group(1).lower()
        and Path(stream_path).name.lower() in append.lower()
        and "$reports" in append.lower()
        and "join-path" in append.lower()
    )


def _verify_native_receipt(record, native_item, assignment, work_order, trial=None):
    """Verify one receipt against already pinned R5 worker and task records."""
    try:
        if not all(isinstance(value, dict) for value in (record, native_item, assignment, work_order)):
            return _unknown("receipt, native item, assignment or work order is not an object")
        if set(record) != REQUIRED_RECEIPT_FIELDS:
            return _unknown("receipt fields do not match the strict R5 schema")
        if not REQUIRED_NATIVE_ITEM_FIELDS.issubset(native_item):
            return _unknown("native command item is missing a required identity or duration field")
        if record.get("schema") != "jot.r5.native-command-receipt.v1":
            return _unknown("receipt record schema is not the R5 schema")
        if record.get("profile_id") != R5_PROFILE_ID:
            return _unknown("receipt record is not bound to the fixed R5 profile")
        try:
            _utc_seconds(record["captured_at_utc"])
        except (TypeError, ValueError):
            return _unknown("receipt capture timestamp is missing or malformed")

        seat = assignment.get("number")
        thread_id = assignment.get("thread_id")
        workspace = assignment.get("private_workspace")
        if type(seat) is not int or not isinstance(thread_id, str) or not isinstance(workspace, str):
            return _unknown("pinned seat assignment is incomplete")
        for field in ("assigned_thread_id", "task_id", "work_order_owner", "cwd", "turn_id", "item_id", "receipt_id", "row_task_id", "stdout_path", "stream_path"):
            value = record[field]
            if not isinstance(value, (str, int)) or isinstance(value, bool) or not str(value).strip():
                return _unknown("receipt identity or evidence field %s is missing" % field)
        for field in ("thread_id", "turn_id", "id", "cwd"):
            if not isinstance(native_item[field], str) or not native_item[field].strip():
                return _unknown("native command item identity field %s is missing" % field)
        try:
            private_root = Path(workspace).resolve(strict=True)
            execution_value = work_order.get("execution_workspace")
            if "execution_workspace" not in work_order:
                execution_root = private_root
            elif not isinstance(execution_value, str) or not execution_value.strip():
                return _unknown("pinned execution workspace is missing or invalid")
            else:
                execution_path = Path(execution_value)
                if not execution_path.is_absolute() and not PureWindowsPath(execution_value).is_absolute():
                    execution_path = private_root / execution_path
                execution_root = execution_path.resolve(strict=True)
                try:
                    execution_root.relative_to(private_root)
                except ValueError:
                    return _unknown("pinned execution workspace is outside the assigned private workspace")
                if execution_root != private_root and assignment.get("allow_nested_private_git_root") is not True:
                    return _unknown("fixed assignment does not allow a nested private Git root")
                if not execution_root.is_dir() or not (execution_root / ".git").exists():
                    return _unknown("pinned execution workspace is not an existing Git root")
            native_cwd_path = Path(native_item["cwd"])
            if not native_cwd_path.is_absolute() or not native_cwd_path.exists():
                return _unknown("native command cwd is not an existing absolute directory")
            actual_cwd = native_cwd_path.resolve(strict=True)
            if not actual_cwd.is_dir():
                return _unknown("native command cwd is not an existing absolute directory")
            try:
                actual_cwd.relative_to(execution_root)
            except ValueError:
                return _unknown("native command cwd does not resolve within the pinned execution workspace")
        except (OSError, TypeError, ValueError):
            return _unknown("pinned execution workspace or native command cwd is invalid")
        if type(record.get("seat")) is not int or record.get("seat") != seat or work_order.get("worker") != seat:
            return _unknown("receipt seat does not match the pinned assignment and work order")
        if record.get("assigned_thread_id") != thread_id or native_item.get("thread_id") != thread_id:
            return _unknown("native receipt thread does not match the assigned worker thread")
        if type(record.get("work_order_owner")) not in (int, str) or work_order.get("owner") != record.get("work_order_owner"):
            return _unknown("receipt owner does not match the pinned work-order owner")
        task_id = record.get("task_id")
        if not isinstance(task_id, str) or task_id not in (work_order.get("primary_id"), work_order.get("backup_id")):
            return _unknown("task ID is not the current primary or backup in the pinned work order")
        allowed_test_paths = _task_binding(work_order, task_id)
        if not allowed_test_paths:
            return _unknown("pinned work order has no test-path binding for this task")

        item_id = native_item.get("id")
        if not item_id or record.get("item_id") != item_id or record.get("receipt_id") != item_id:
            return _unknown("receipt item ID does not match the native command item")
        if record.get("turn_id") != native_item.get("turn_id"):
            return _unknown("receipt turn ID does not match the native command item")
        if record.get("cwd") != native_item.get("cwd"):
            return _unknown("receipt cwd does not match the native command item")
        command = native_item.get("command")
        if not isinstance(command, str) or not command:
            return _unknown("native command text is missing")
        if record.get("command_sha256") != _sha256(command.encode("utf-8")):
            return _unknown("native command hash does not match the command item")
        if (
            type(record.get("exit_code")) is not int
            or type(native_item.get("exitCode")) is not int
            or record.get("exit_code") != native_item.get("exitCode")
            or record.get("exit_code") != 0
        ):
            return _unknown("receipt and native command exit codes do not match a successful command")
        if (
            type(record.get("duration_ms")) is not int
            or record.get("duration_ms") < 0
            or type(native_item.get("durationMs")) is not int
            or native_item.get("durationMs") < 0
            or record.get("duration_ms") != native_item.get("durationMs")
        ):
            return _unknown("native receipt duration does not match the command item")
        for field, item_field in (("started_at", "startedAt"), ("completed_at", "completedAt")):
            if native_item.get(item_field) is not None and record.get(field) != native_item[item_field]:
                return _unknown("receipt %s does not match the native command item" % field)
            if native_item.get(item_field) is None and record.get(field) is not None:
                return _unknown("receipt invents a native %s that was not returned" % field)

        native_test_paths = _node_test_paths(command)
        if native_test_paths is None:
            return _unknown("native command is not a supported node --test invocation")
        execution_test_paths = _execution_test_paths(native_test_paths, actual_cwd, execution_root)
        if execution_test_paths is None:
            return _unknown("native command test paths do not resolve within the pinned execution workspace")
        if not set(execution_test_paths).issubset(allowed_test_paths):
            return _unknown("native test paths are not allowed by the pinned task")
        semantics = record.get("command_semantics")
        if not isinstance(semantics, dict):
            return _unknown("receipt has no semantic command crosswalk")
        expected_semantics = {
            "inner_command": "node --test",
            "test_paths": native_test_paths,
            "stdout_path": record.get("stdout_path"),
            "appends_stream": record.get("stream_path"),
        }
        if semantics != expected_semantics:
            return _unknown("semantic command crosswalk does not match the native command and receipt paths")
        if not _wrapper_matches_workspace(command, workspace, actual_cwd):
            return _unknown("PowerShell wrapper does not execute from the native command cwd")
        if not _wrapper_output_paths_match(command, record["stdout_path"], record["stream_path"]):
            return _unknown("native wrapper does not link the actual output and stream paths")

        stdout_path = _private_path(workspace, record.get("stdout_path"))
        stdout_sha = _sha256(stdout_path.read_bytes())
        if record.get("stdout_sha256") != stdout_sha:
            return _unknown("saved stdout bytes do not match the receipt hash")
        stream_path = _private_path(workspace, record.get("stream_path"))
        lines = stream_path.read_bytes().splitlines()
        line_number = record.get("line_number")
        if type(line_number) is not int or not 1 <= line_number <= len(lines):
            return _unknown("receipt stream line number is invalid")
        line = lines[line_number - 1]
        if record.get("line_sha256") != _sha256(line):
            return _unknown("stream line bytes do not match the receipt hash")
        row = json.loads(line.decode("utf-8"))
        if not isinstance(row, dict):
            return _unknown("cited stream row is not an object")
        if (
            row.get("schema") != "jot.r5.interval.v1"
            or
            str(row.get("seat")) != str(seat)
            or row.get("task_id") != task_id
            or row.get("task_id") != record.get("row_task_id")
            or row.get("start_utc") != record.get("row_start_utc")
            or row.get("end_utc") != record.get("row_end_utc")
            or type(row.get("exit_code")) is not int
            or row.get("exit_code") != record.get("exit_code")
            or row.get("source_kind") != "native_command_execution"
            or row.get("evidence_ref") != record["stdout_path"] + "#" + stdout_sha
        ):
            return _unknown("receipt row fields do not match the cited native execution")
        if not isinstance(record.get("row_start_utc"), str) or not isinstance(record.get("row_end_utc"), str):
            return _unknown("receipt row interval is incomplete")
        interval_seconds = _seconds_between(record["row_start_utc"], record["row_end_utc"])
        if interval_seconds <= 0:
            return _unknown("receipt row interval is not positive")
        if trial is not None:
            if not isinstance(trial, dict):
                return _unknown("fixed R5 trial authority is not an object")
            trial_start = _utc_seconds(trial.get("started_at"))
            trial_end = _utc_seconds(trial.get("ends_at"))
            if trial_end - trial_start != TRIAL_SECONDS:
                return _unknown("fixed R5 trial authority is not the pinned 7,200-second window")
            row_start = _utc_seconds(record["row_start_utc"])
            row_end = _utc_seconds(record["row_end_utc"])
            if row_start < trial_start or row_end > trial_end:
                return _unknown("receipt row interval is outside the fixed R5 trial window")
            if native_item.get("startedAt") is not None and _utc_seconds(native_item["startedAt"]) < trial_start:
                return _unknown("native command starts before the fixed R5 trial window")
            if native_item.get("completedAt") is not None and _utc_seconds(native_item["completedAt"]) > trial_end:
                return _unknown("native command completes after the fixed R5 trial window")
        if native_item.get("startedAt") is not None:
            if _utc_seconds(record["row_start_utc"]) < _utc_seconds(record["started_at"]):
                return _unknown("interval starts before the native command receipt")
        if native_item.get("completedAt") is not None:
            if _utc_seconds(record["row_end_utc"]) > _utc_seconds(record["completed_at"]):
                return _unknown("interval ends after the native command receipt")
        return {
            "native_observed": True,
            "reason": "native command receipt, task binding, test path, output bytes and stream row match",
            "command_kind": "test_execution",
            "effective_work_class": "unknown",
            "execution_wall_seconds": float(interval_seconds),
            "receipt_seconds": record["duration_ms"] / 1000,
            "person_hours": None,
        }
    except (AttributeError, KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
        return _unknown("receipt or evidence is incomplete, malformed, or outside the assigned workspace")


def verify_native_receipt(record, native_item):
    """Resolve assignments and work orders from the pinned trial matching the receipt time."""
    try:
        authority = load_r5_trial_authority(record.get("row_start_utc"))
        seat = record.get("seat")
        assignment = authority["workers_by_number"].get(seat)
        work_order = authority["work_orders_by_worker"].get(seat)
        if assignment is None or work_order is None:
            return _unknown("seat has no assignment and work order in the pinned R5 START snapshot")
        return _verify_native_receipt(record, native_item, assignment, work_order, authority["trial"])
    except (AttributeError, KeyError, OSError, TypeError, ValueError):
        return _unknown("fixed R5 profile or unique START authority is unavailable or invalid")
