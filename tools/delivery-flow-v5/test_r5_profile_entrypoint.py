import contextlib
import datetime as dt
import hashlib
import io
import json
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
import tool_entrypoint
import workspace_guard
import authority as r5_authority

SCRATCH = Path("E:/codex/yunticket/.test-tmp/jot-permissive-20261021/worker-15/private/r5-tool-release-pin-tests")


class R5EntrypointTests(unittest.TestCase):
    def make_nested_release_fixture(self, root):
        package = Path(__file__).resolve().parent
        tool_directory = root / "integration" / "tools" / "delivery-flow-v5"
        tool_directory.mkdir(parents=True)
        for filename in tool_entrypoint.R5_REVIEWED_FILES:
            source = package / filename
            destination = tool_directory / filename
            if source.is_file():
                shutil.copyfile(source, destination)
            else:
                destination.write_bytes(b"{}\n" if filename.endswith(".json") else b"# release fixture\n")
        receipt = root / "review-receipt.json"
        receipt.write_text('{"disposition":"ACCEPT"}', encoding="utf-8")
        sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        return tool_directory, {
            "schema": tool_entrypoint.R5_TOOL_RELEASE_SCHEMA,
            "profile_id": tool_entrypoint.R5_PROFILE_ID,
            "released_by": "R",
            "released_at": "2026-10-25T10:00:00Z",
            "stage": "product_capable_shared",
            "source_directory": str(tool_directory),
            "shared_commit": "a" * 40,
            "shared_tree": "b" * 40,
            "entrypoint": {"path":"tool_entrypoint.py", "sha256":sha(tool_directory / "tool_entrypoint.py")},
            "tools": [
                {"id": tool_id, "path": filename, "sha256":sha(tool_directory / filename)}
                for tool_id, filename in tool_entrypoint.R5_TOOL_SOURCE_FILES.items()
            ],
            "support": [
                {"id": source_id, "path": filename, "sha256":sha(tool_directory / filename)}
                for source_id, filename in tool_entrypoint.R5_SUPPORT_SOURCE_FILES.items()
            ],
            "review_receipts": [{"path":str(receipt), "sha256":sha(receipt)}],
            "reviewed_files": [
                {"path":f"tools/delivery-flow-v5/{filename}", "sha256":sha(tool_directory / filename),
                 "bytes":(tool_directory / filename).stat().st_size}
                for filename in sorted(tool_entrypoint.R5_REVIEWED_FILES)
            ],
        }

    def make_current_trial_fixture(self, root, *, order_changes=None, entry_changes=None):
        docs = root / "docs" / "diagnostics" / "delivery-flow-v5-20261025"
        worker_root = root / "worker-03"
        work_order_path = worker_root / "private" / "reports" / "r6" / "R-issued-work-order.json"
        docs.mkdir(parents=True)
        work_order_path.parent.mkdir(parents=True)
        worker_root.mkdir(exist_ok=True)
        trial_id = "jot-parallel-r6-20261025"
        started = dt.datetime.now(dt.timezone.utc).replace(microsecond=0) - dt.timedelta(minutes=1)
        started_at = started.isoformat().replace("+00:00", "Z")
        ends_at = (started + dt.timedelta(seconds=7200)).isoformat().replace("+00:00", "Z")
        worker = {
            "number": 3,
            "thread_id": "thread-worker-03",
            "private_workspace": str(worker_root),
            "report_directory": str(worker_root / "private" / "reports"),
        }
        order = {
            "schema": "jot.r5.work-order.v1",
            "trial_id": trial_id,
            "worker": 3,
            "owner": 3,
            "private_workspace": str(worker_root),
            "primary_id": "M04.03",
            "backup_id": "M04.04",
            "tasks": {
                "M04.03": {"source_class": "inherited_wip"},
                "M04.04": {"source_class": "inherited_wip"},
            },
        }
        if order_changes:
            order_changes(order)
        work_order_path.write_text(json.dumps(order), encoding="utf-8")
        policy_path = docs / ("decision-standing-source-policy-%s.json" % trial_id)
        policy = {
            "schema_version": 1,
            "mode": "standing_scope",
            "writer": 13,
            "trial_id": trial_id,
            "event_scope": "product",
            "guard_profile_sha256": "b" * 64,
            "valid_from": started_at,
            "expires_at": ends_at,
            "target_repo": str(root / "integration"),
            "task_scopes": [
                {"task_owner": 3, "task_id": "M04.03", "source_class": "inherited_wip"},
                {"task_owner": 3, "task_id": "M04.04", "source_class": "inherited_wip"},
            ],
        }
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        entry = {
            "worker": 3,
            "owner": 3,
            "trial_id": trial_id,
            "private_workspace": str(worker_root),
            "work_order_path": str(work_order_path),
            "work_order_sha256": hashlib.sha256(work_order_path.read_bytes()).hexdigest(),
            "primary_id": "M04.03",
            "backup_id": "M04.04",
        }
        if entry_changes:
            entry_changes(entry)
        snapshot_path = docs / ("trial-start-snapshot-%s.json" % trial_id)
        snapshot = {
            "schema": "jot.r5.trial-start-snapshot.v1",
            "profile_id": "jot-parallel-r5-20261025",
            "trial_id": trial_id,
            "trial": {
                "started": True,
                "real_product_trial_started": True,
                "new_product_dispatch_allowed": True,
                "started_at": started_at,
                "ends_at": ends_at,
                "duration_seconds": 7200,
            },
            "scope_profile": {
                "path": (docs / "decision-scope-profile.json").resolve().as_posix(),
                "sha256": "b" * 64,
            },
            "standing_source_policy": {
                "path": str(policy_path),
                "sha256": hashlib.sha256(policy_path.read_bytes()).hexdigest(),
            },
            "selected_seats": [3],
            "work_orders": [entry],
        }
        snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
        pin_path = docs / ("trial-start-pin-%s.json" % trial_id)
        pin = {
            "schema": "jot.r5.current-trial-pin.v1",
            "issued_by": "R",
            "profile_id": "jot-parallel-r5-20261025",
            "trial_id": trial_id,
            "snapshot_path": str(snapshot_path),
            "snapshot_sha256": hashlib.sha256(snapshot_path.read_bytes()).hexdigest(),
            "immutable": True,
        }
        pin_path.write_text(json.dumps(pin), encoding="utf-8")
        metadata_path = docs / "decision-current-trial.json"
        metadata = {
            "schema": "jot.r5.current-trial-metadata.v1",
            "issued_by": "R",
            "profile_id": "jot-parallel-r5-20261025",
            "trial_id": trial_id,
            "trial_start_pin": str(pin_path),
        }
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
        profile_authority = {
            "profile": {"profile_id": "jot-parallel-r5-20261025"},
            "profile_sha256": "b" * 64,
            "workers_by_number": {3: worker},
            "assignments": {"workers": [worker]},
            "policy": {"shared_integration": str(root / "integration")},
        }
        return docs, metadata_path, snapshot_path, pin_path, policy_path, work_order_path, profile_authority

    def test_r5_profile_pin_loads_fixed_scope(self):
        config, error = workspace_guard.load_r5_config()
        self.assertIsNone(error)
        self.assertEqual(config["profile"]["profile_id"], "jot-parallel-r5-20261025")
        self.assertEqual(config["policy"]["shared_writer"], 13)

    def test_r5_trial_authority_loads_the_pinned_historical_start(self):
        try:
            loaded = r5_authority.load_r5_trial_authority()
        except Exception as exc:
            self.fail("pinned R5 START authority should load: %r" % (exc,))
        self.assertEqual(
            loaded["snapshot_sha256"],
            "f215b5f608fcc8738f6c4fa2394731987afce52143b2edc0d627859618e1bc41",
        )
        self.assertEqual(
            set(loaded["work_orders_by_worker"]),
            set(loaded["snapshot"]["selected_seats"]),
        )

    def test_authority_string_root_keeps_escape_rejection(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as root_directory:
            root = Path(root_directory)
            inside = root / "work-order.json"
            inside.write_text("{}", encoding="utf-8")
            resolved = r5_authority._within(
                str(root), str(inside), "R5 pinned work order", must_exist=True
            )
            self.assertEqual(resolved, inside.resolve())

            with tempfile.TemporaryDirectory(dir=SCRATCH) as outside_directory:
                outside = Path(outside_directory) / "work-order.json"
                outside.write_text("{}", encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "escapes the fixed R5 repository"):
                    r5_authority._within(
                        str(root), str(outside), "R5 pinned work order", must_exist=True
                    )

    def test_current_trial_authority_loads_independent_pin_policy_and_work_order(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            fixture = self.make_current_trial_fixture(root)
            docs, _, _, _, _, _, profile_authority = fixture
            with patch.object(workspace_guard, "R5_PROFILE", docs / "decision-scope-profile.json"):
                with patch.object(workspace_guard, "R5_PROFILE_SHA256", "b" * 64):
                    loaded = r5_authority._load_current_trial_authority(
                        profile_authority, root, docs
                    )
        self.assertEqual(loaded["trial_id"], "jot-parallel-r6-20261025")
        started = dt.datetime.fromisoformat(loaded["trial"]["started_at"].replace("Z", "+00:00"))
        ends = dt.datetime.fromisoformat(loaded["trial"]["ends_at"].replace("Z", "+00:00"))
        self.assertEqual(ends - started, dt.timedelta(seconds=7200))
        self.assertEqual(set(loaded["work_orders_by_worker"]), {3})
        self.assertEqual(loaded["work_orders_by_worker"][3]["primary_id"], "M04.03")

    def test_current_trial_requires_well_formed_policy_and_work_order_hashes(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        cases = (
            ("policy hash missing", "policy", "missing"),
            ("policy hash null", "policy", None),
            ("policy hash malformed", "policy", "not-a-sha256"),
            ("work-order hash missing", "work_order", "missing"),
            ("work-order hash null", "work_order", None),
            ("work-order hash malformed", "work_order", "not-a-sha256"),
        )
        for case, target, value in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
                root = Path(directory)
                docs, _, snapshot_path, pin_path, _, _, profile_authority = (
                    self.make_current_trial_fixture(root)
                )
                snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
                reference = (
                    snapshot["standing_source_policy"]
                    if target == "policy"
                    else snapshot["work_orders"][0]
                )
                field = "sha256" if target == "policy" else "work_order_sha256"
                if value == "missing":
                    reference.pop(field)
                else:
                    reference[field] = value
                snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
                pin = json.loads(pin_path.read_text(encoding="utf-8"))
                pin["snapshot_sha256"] = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
                pin_path.write_text(json.dumps(pin), encoding="utf-8")
                with patch.object(workspace_guard, "R5_PROFILE", docs / "decision-scope-profile.json"):
                    with patch.object(workspace_guard, "R5_PROFILE_SHA256", "b" * 64):
                        with self.assertRaises(ValueError):
                            r5_authority._load_current_trial_authority(
                                profile_authority, root, docs
                            )

    def test_current_trial_policy_is_used_by_the_existing_product_command_gate(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            fixture = self.make_current_trial_fixture(root)
            docs, _, _, _, policy_path, _, profile_authority = fixture
            with patch.object(workspace_guard, "R5_PROFILE", docs / "decision-scope-profile.json"):
                with patch.object(workspace_guard, "R5_PROFILE_SHA256", "b" * 64):
                    current = workspace_guard._load_current_trial_authority(
                        profile_authority, root, docs
                    )
            with patch.object(workspace_guard, "_load_current_trial_authority", return_value=current):
                config, error = workspace_guard.load_r5_config()
            self.assertIsNone(error)
            profile = config["profile"]
            self.assertIs(profile["current_trial_authority"], current)
            guard = types.SimpleNamespace(
                load_r5_config=lambda: (config, None),
                _load_r5_standing_policy=workspace_guard._load_r5_standing_policy,
            )
            with patch.object(tool_entrypoint, "_load_workspace_guard", return_value=guard):
                with patch.object(workspace_guard, "_load_current_trial_authority", return_value=current):
                    with patch.object(workspace_guard, "_load_r5_phase_state", return_value=({}, None)):
                        args = tool_entrypoint._tool_arguments("preflight", [], profile="r5")
        self.assertIn(str(policy_path), args)
        self.assertIn(current["policy_sha256"], args)

    def test_expired_r5_does_not_authorize_a_new_product_command(self):
        config, error = workspace_guard.load_r5_config()
        self.assertIsNone(error)
        self.assertEqual(config["current_trial_authority"], None)
        guard = types.SimpleNamespace(
            load_r5_config=lambda: (config, None),
            _load_r5_standing_policy=workspace_guard._load_r5_standing_policy,
        )
        with patch.object(tool_entrypoint, "_load_workspace_guard", return_value=guard):
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as caught:
                tool_entrypoint._tool_arguments("preflight", [], profile="r5")
        self.assertEqual(caught.exception.reason, "standing_source_policy_unavailable")

    def test_receipt_authority_keeps_r5_history_and_selects_current_round_by_time(self):
        profile_authority = {
            "profile": {"profile_id": "jot-parallel-r5-20261025"},
            "profile_sha256": "b" * 64,
            "assignments": {},
            "policy": {},
            "authorization": {},
        }
        historical = {
            "trial": {
                "started_at": "2026-10-25T12:51:40.658Z",
                "ends_at": "2026-10-25T14:51:40.658Z",
            }
        }
        current = {
            "trial_id": "jot-parallel-r6-20261025",
            "trial": {
                "started_at": "2026-10-25T16:00:00Z",
                "ends_at": "2026-10-25T18:00:00Z",
            },
        }
        with patch.object(r5_authority, "load_r5_profile_authority", return_value=profile_authority):
            with patch.object(r5_authority, "_load_start_authority", return_value=historical):
                with patch.object(r5_authority, "_load_current_trial_authority", return_value=current) as load_current:
                    loaded = r5_authority.load_r5_trial_authority("2026-10-25T16:30:00Z")
                    self.assertEqual(loaded["trial_id"], current["trial_id"])
                    load_current.assert_called_once()
                with patch.object(r5_authority, "_load_current_trial_authority") as load_current:
                    loaded = r5_authority.load_r5_trial_authority("2026-10-25T14:00:00Z")
                    self.assertIs(loaded["trial"], historical["trial"])
                    load_current.assert_not_called()

    def test_current_trial_authority_rejects_stale_pin_and_cross_round_bindings(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        for case, order_changes, entry_changes, pin_change in (
            ("stale snapshot pin", None, None, "snapshot"),
            ("changed pin hash", None, None, "hash"),
            ("non-R pin issuer", None, None, "issuer"),
            ("cross-round order", lambda order: order.update(trial_id="jot-parallel-r5-20261025"), None, None),
            ("cross-round task id", lambda order: order.update(primary_id="M05.01"), None, None),
            ("cross-round owner", lambda order: order.update(owner=4), None, None),
            ("cross-workspace", lambda order: order.update(private_workspace="E:/codex/yunticket"), None, None),
            ("cross-round source class", lambda order: order["tasks"]["M04.03"].update(source_class="new_development"), None, None),
            ("outside workspace", None, lambda entry: entry.update(work_order_path="outside.json"), None),
        ):
            with self.subTest(case=case), tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
                root = Path(directory)
                fixture = self.make_current_trial_fixture(
                    root, order_changes=order_changes, entry_changes=entry_changes
                )
                docs, _, snapshot_path, _, _, _, profile_authority = fixture
                if case == "outside workspace":
                    (root / "outside.json").write_text("{}", encoding="utf-8")
                    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
                    snapshot["work_orders"][0]["work_order_path"] = str(root / "outside.json")
                    snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
                    pin_path = docs / "trial-start-pin-jot-parallel-r6-20261025.json"
                    pin = json.loads(pin_path.read_text(encoding="utf-8"))
                    pin["snapshot_sha256"] = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
                    pin_path.write_text(json.dumps(pin), encoding="utf-8")
                pin_path = docs / "trial-start-pin-jot-parallel-r6-20261025.json"
                if pin_change == "snapshot":
                    snapshot_path.write_bytes(snapshot_path.read_bytes() + b" ")
                elif pin_change:
                    pin = json.loads(pin_path.read_text(encoding="utf-8"))
                    if pin_change == "hash":
                        pin["snapshot_sha256"] = "0" * 64
                    else:
                        pin["issued_by"] = "worker-15"
                    pin_path.write_text(json.dumps(pin), encoding="utf-8")
                with patch.object(workspace_guard, "R5_PROFILE", docs / "decision-scope-profile.json"):
                    with patch.object(workspace_guard, "R5_PROFILE_SHA256", "b" * 64):
                        with self.assertRaises(ValueError):
                            r5_authority._load_current_trial_authority(profile_authority, root, docs)

    def test_current_trial_rejects_policy_tasks_without_selected_work_orders(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            fixture = self.make_current_trial_fixture(root)
            docs, _, snapshot_path, pin_path, policy_path, _, profile_authority = fixture
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy["task_scopes"].append(
                {"task_owner": 3, "task_id": "M99.99", "source_class": "new_development"}
            )
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
            snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
            snapshot["standing_source_policy"]["sha256"] = hashlib.sha256(
                policy_path.read_bytes()
            ).hexdigest()
            snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
            pin = json.loads(pin_path.read_text(encoding="utf-8"))
            pin["snapshot_sha256"] = hashlib.sha256(snapshot_path.read_bytes()).hexdigest()
            pin_path.write_text(json.dumps(pin), encoding="utf-8")
            with patch.object(workspace_guard, "R5_PROFILE", docs / "decision-scope-profile.json"):
                with patch.object(workspace_guard, "R5_PROFILE_SHA256", "b" * 64):
                    with self.assertRaisesRegex(ValueError, "policy tasks do not match"):
                        r5_authority._load_current_trial_authority(profile_authority, root, docs)

    def test_r5_profile_uses_r5_release_and_dispatch(self):
        release = {"schema": "jot.r5-tools-release.v1"}
        sources = {"preflight": (Path("preflight.py"), b"# preflight")}
        with patch.object(tool_entrypoint, "_tool_arguments", return_value=["--help"]) as args:
            with patch.object(tool_entrypoint, "load_release", return_value=release) as load:
                with patch.object(tool_entrypoint, "_approved_sources", return_value=sources) as approve:
                    with patch.object(tool_entrypoint, "_run_sources", return_value=0) as run:
                        self.assertEqual(
                            tool_entrypoint.main(["--profile", "r5", "preflight", "--help"]), 0
                        )
        args.assert_called_once_with("preflight", ["--help"], profile="r5")
        load.assert_called_once_with("r5")
        approve.assert_called_once_with(release, "preflight", profile="r5")
        run.assert_called_once_with("preflight", sources, ["--help"], profile="r5")

    def test_r4_profile_is_rejected_before_release_lookup(self):
        stderr = io.StringIO()
        with patch.object(tool_entrypoint, "load_release") as load:
            with contextlib.redirect_stderr(stderr):
                self.assertEqual(
                    tool_entrypoint.main(["--profile", "r4", "preflight", "--help"]), 1
                )
        load.assert_not_called()
        self.assertIn('"reason": "tool_profile_not_approved"', stderr.getvalue())

    def test_workspace_guard_loader_uses_its_pinned_source_bytes(self):
        guard_path = Path(tool_entrypoint.__file__).resolve().parent / "workspace_guard.py"
        expected_sha = hashlib.sha256(guard_path.read_bytes()).hexdigest()
        self.assertEqual(tool_entrypoint.WORKSPACE_GUARD_SHA256, expected_sha)
        with patch.object(tool_entrypoint, "workspace_guard", None):
            loaded = tool_entrypoint._load_workspace_guard()
        self.assertEqual(Path(loaded.__file__).resolve(), guard_path.resolve())

    def test_r5_release_requires_a_fixed_release_pin(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            release_path = root / "decision-tools-release.json"
            release_path.write_text('{"schema":"jot.r5-tools-release.v1"}', encoding="utf-8")
            pin_path = root / "decision-tools-release-pin.json"
            guard = type("Guard", (), {"load_r5_config": lambda self: ({"tool_release": str(release_path)}, None)})()
            with patch.object(tool_entrypoint, "_load_workspace_guard", return_value=guard):
                with patch.object(tool_entrypoint, "R5_TOOL_RELEASE", release_path, create=True):
                    with patch.object(tool_entrypoint, "R5_TOOL_RELEASE_PIN", pin_path, create=True):
                        with self.assertRaises(tool_entrypoint.ToolReleaseError) as caught:
                            tool_entrypoint.load_release("r5")
        self.assertEqual(caught.exception.reason, "tool_release_pin_unavailable")

    def test_r5_release_manifest_hash_must_match_the_pin(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            release_path = root / "decision-tools-release.json"
            raw = b'{"schema":"jot.r5-tools-release.v1"}'
            release_path.write_bytes(raw)
            pin_path = root / "decision-tools-release-pin.json"
            pin_path.write_text(json.dumps({
                "schema": "jot.r5-tools-release-pin.v1",
                "issued_by": "R",
                "profile_id": "jot-parallel-r5-20261025",
                "release_path": release_path.as_posix(),
                "release_sha256": "0" * 64,
                "immutable": True,
            }), encoding="utf-8")
            guard = type("Guard", (), {"load_r5_config": lambda self: ({"tool_release": str(release_path)}, None)})()
            with patch.object(tool_entrypoint, "_load_workspace_guard", return_value=guard):
                with patch.object(tool_entrypoint, "R5_TOOL_RELEASE", release_path, create=True):
                    with patch.object(tool_entrypoint, "R5_TOOL_RELEASE_PIN", pin_path, create=True):
                        with self.assertRaises(tool_entrypoint.ToolReleaseError) as caught:
                            tool_entrypoint.load_release("r5")
        self.assertEqual(caught.exception.reason, "tool_release_pin_mismatch")

    def test_r5_release_loads_when_fixed_pin_matches_manifest(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            release_path = root / "decision-tools-release.json"
            raw = b'{"schema":"jot.r5-tools-release.v1","profile_id":"jot-parallel-r5-20261025"}'
            release_path.write_bytes(raw)
            pin_path = root / "decision-tools-release-pin.json"
            pin_path.write_text(json.dumps({
                "schema": "jot.r5-tools-release-pin.v1",
                "issued_by": "R",
                "profile_id": "jot-parallel-r5-20261025",
                "release_path": release_path.as_posix(),
                "release_sha256": hashlib.sha256(raw).hexdigest(),
                "immutable": True,
            }), encoding="utf-8")
            guard = type("Guard", (), {"load_r5_config": lambda self: ({"tool_release": str(release_path)}, None)})()
            with patch.object(tool_entrypoint, "_load_workspace_guard", return_value=guard):
                with patch.object(tool_entrypoint, "R5_TOOL_RELEASE", release_path, create=True):
                    with patch.object(tool_entrypoint, "R5_TOOL_RELEASE_PIN", pin_path, create=True):
                        release = tool_entrypoint.load_release("r5")
        self.assertEqual(release["schema"], tool_entrypoint.R5_TOOL_RELEASE_SCHEMA)

    def test_r5_support_loader_imports_verified_dependencies_in_order(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = Path(directory)
            guard_path = root / "workspace_guard.py"
            authority_path = root / "authority.py"
            receipt_path = root / "native_receipt.py"
            guard_source = b"CURRENT_TRIAL_BINDING = 'pinned-current-trial'\n"
            authority_source = (
                b"import workspace_guard\ndef load_r5_trial_authority():\n"
                b"    return workspace_guard.CURRENT_TRIAL_BINDING\n"
            )
            receipt_source = b"from authority import load_r5_trial_authority\nAUTHORITY = load_r5_trial_authority()\n"
            guard_path.write_bytes(guard_source)
            authority_path.write_bytes(authority_source)
            receipt_path.write_bytes(receipt_source)
            sources = {
                "guard": (guard_path, guard_source),
                "authority": (authority_path, authority_source),
                "native_receipt": (receipt_path, receipt_source),
            }
            prior_authority = sys.modules.get("authority")
            module = tool_entrypoint._load_r5_support_modules(sources, "native_receipt")
        self.assertEqual(module.AUTHORITY, "pinned-current-trial")
        self.assertIs(sys.modules.get("authority"), prior_authority)

    def test_load_r5_support_loads_exact_release_sources(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            tool_directory, release = self.make_nested_release_fixture(Path(directory))
            entrypoint_path = tool_directory / "tool_entrypoint.py"
            release_entrypoint = types.ModuleType("r5_release_fixture_entrypoint")
            release_entrypoint.__file__ = str(entrypoint_path)
            release_entrypoint.__package__ = ""
            code = compile(entrypoint_path.read_bytes(), str(entrypoint_path), "exec")
            exec(code, release_entrypoint.__dict__)
            with patch.object(release_entrypoint, "load_release", return_value=release):
                module = release_entrypoint.load_r5_support("native_receipt")
        self.assertEqual(Path(module.__file__).resolve().parent, tool_directory.resolve())
        self.assertTrue(callable(module.verify_native_receipt))
        self.assertEqual(module.load_r5_trial_authority.__module__, "authority")

    def test_r5_review_inventory_loads_from_nested_shared_checkout(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            tool_directory, release = self.make_nested_release_fixture(Path(directory))
            tool_entrypoint._validate_r5_release_metadata(release, tool_directory)

    def test_r5_review_inventory_rejects_changed_file_hash(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            tool_directory, release = self.make_nested_release_fixture(Path(directory))
            release["reviewed_files"][0]["sha256"] = "0" * 64
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as caught:
                tool_entrypoint._validate_r5_release_metadata(release, tool_directory)
        self.assertEqual(caught.exception.reason, "reviewed_file_mismatch")


if __name__ == "__main__":
    unittest.main()
