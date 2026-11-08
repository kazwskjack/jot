import contextlib
import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parent))
import tool_entrypoint
import workspace_guard


SCRATCH = Path("E:/codex/yunticket/.test-tmp/jot-permissive-20261021/worker-15/.test-tmp")
TOOL_DIRECTORY = Path(__file__).resolve().parent


def make_release(root):
    entrypoint = TOOL_DIRECTORY / "tool_entrypoint.py"
    (root / "tool_entrypoint.py").write_bytes(entrypoint.read_bytes())
    receipt_path = root / "review.json"
    receipt_path.write_bytes(b"R4 source review receipt\n")
    tools = []
    for tool_id, filename in tool_entrypoint.R4_TOOL_SOURCE_FILES.items():
        if tool_id == "preflight":
            source = (
                b"if __name__ == '__main__':\n"
                b"    import source_binding\n"
                b"    assert source_binding.PREFLIGHT_WAS_PRELOADED\n"
                b"else:\n"
                b"    PREFLIGHT_WAS_PRELOADED = True\n"
            )
        else:
            source = f"# {tool_id}\n".encode()
        (root / filename).write_bytes(source)
        tools.append({"id": tool_id, "path": filename, "sha256": hashlib.sha256(source).hexdigest()})

    support = []
    for source_id, filename in tool_entrypoint.R4_SUPPORT_SOURCE_FILES.items():
        if source_id == "source_binding":
            source = b"import preflight\nPREFLIGHT_WAS_PRELOADED = preflight.PREFLIGHT_WAS_PRELOADED\n"
        else:
            source = f"# {source_id}\n".encode()
        (root / filename).write_bytes(source)
        support.append({"id": source_id, "path": filename, "sha256": hashlib.sha256(source).hexdigest()})

    return {
        "schema": tool_entrypoint.R4_TOOL_RELEASE_SCHEMA,
        "profile_id": workspace_guard.R4_PROFILE_ID,
        "entrypoint": {
            "path": "tool_entrypoint.py",
            "sha256": hashlib.sha256((root / "tool_entrypoint.py").read_bytes()).hexdigest(),
        },
        "tools": tools,
        "support": support,
        "released_by": "R",
        "released_at": "2026-10-25T05:20:00Z",
        "shared_commit": "a" * 40,
        "shared_tree": "b" * 40,
        "review_receipts": [{
            "path": str(receipt_path),
            "sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
        }],
    }


class R4EntrypointTests(unittest.TestCase):
    def test_default_profile_is_r4(self):
        release = {"schema": "synthetic"}
        sources = {"preflight": (Path("preflight.py"), b"# preflight")}
        with patch.object(tool_entrypoint, "load_release", return_value=release) as load:
            with patch.object(tool_entrypoint, "_approved_sources", return_value=sources):
                with patch.object(tool_entrypoint, "_run_sources", return_value=0):
                    self.assertEqual(tool_entrypoint.main(["preflight", "--help"]), 0)
        load.assert_called_once_with("r4")

    def test_r3_profile_is_rejected_before_release_lookup(self):
        stderr = io.StringIO()
        with patch.object(tool_entrypoint, "load_release") as load:
            with contextlib.redirect_stderr(stderr):
                code = tool_entrypoint.main(["--profile", "r3", "preflight", "--help"])
        load.assert_not_called()
        self.assertEqual(code, 1)
        result = json.loads(stderr.getvalue())
        self.assertEqual(result["reason"], "tool_profile_not_approved")

    def test_helper_defaults_use_the_r4_release_and_policy(self):
        release_path = SCRATCH / "default-r4-release.json"
        guard = type("Guard", (), {
            "load_r4_config": staticmethod(lambda: ({"tool_release": release_path}, None))
        })()
        with patch.object(tool_entrypoint, "_load_workspace_guard", return_value=guard):
            with patch.object(tool_entrypoint, "_read_release", return_value={"profile_id": "r4"}):
                self.assertEqual(tool_entrypoint.load_release(), {"profile_id": "r4"})

        config, reason = workspace_guard.load_r4_config()
        self.assertIsNone(reason)
        args = tool_entrypoint._tool_arguments(
            "preflight", ["missing.json", "--root", "E:/codex"]
        )
        self.assertEqual(args[args.index("--scope-policy") + 1], str(config["standing_source_policy"]))
        self.assertEqual(
            args[args.index("--scope-policy-sha") + 1], config["standing_source_policy_sha256"]
        )

    def test_private_closure_bytes_match_freeze_lf_postimages(self):
        filenames = (
            "tool_entrypoint.py", "workspace_guard.py", "preflight.py", "queue.py",
            "local_freeze.py", "source_binding.py", "linux_run.py", "result_validate.py",
            "README.md", "test_tool_entrypoint.py", "test_standing_scope.py",
            "test_legacy_preflight_entrypoint.py", "linux-job-result.schema.json",
        )
        for filename in filenames:
            with self.subTest(filename=filename):
                self.assertNotIn(b"\r", (TOOL_DIRECTORY / filename).read_bytes())
        self.assertEqual(
            hashlib.sha256((TOOL_DIRECTORY / "workspace_guard.py").read_bytes()).hexdigest(),
            tool_entrypoint.WORKSPACE_GUARD_SHA256,
        )

    def test_source_binding_is_hash_pinned_and_preloaded_for_each_importer(self):
        self.assertEqual(
            tool_entrypoint.R4_SUPPORT_SOURCE_FILES.get("source_binding"), "source_binding.py"
        )
        self.assertNotIn("source_binding", tool_entrypoint.SUPPORT_SOURCE_FILES)
        self.assertEqual(
            set(tool_entrypoint.R4_TOOL_SOURCE_FILES), {"preflight", "queue", "freeze", "guard"}
        )
        self.assertNotIn("metrics", tool_entrypoint.R4_TOOL_SOURCE_FILES)
        self.assertNotIn("work_event", tool_entrypoint.R4_TOOL_SOURCE_FILES)
        for tool_id in ("preflight", "queue", "freeze"):
            order = tool_entrypoint.R4_TOOL_IMPORT_ORDER[tool_id]
            self.assertLess(order.index("preflight"), order.index("source_binding"))
            self.assertIn("source_binding", order)

        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            release = make_release(root)
            sources = tool_entrypoint._approved_sources(
                release, "preflight", tool_directory=root, profile="r4"
            )
            missing = object()
            previous_preflight = sys.modules.pop("preflight", missing)
            previous_binding = sys.modules.pop("source_binding", missing)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(tool_entrypoint._run_sources("preflight", sources, [], profile="r4"), 0)
                (root / "source_binding.py").write_bytes(b"# changed after release pin\n")
                with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                    tool_entrypoint._approved_sources(
                        release, "preflight", tool_directory=root, profile="r4"
                    )
                self.assertEqual(error.exception.reason, "support_source_hash_mismatch")
            finally:
                for name, previous in (("preflight", previous_preflight), ("source_binding", previous_binding)):
                    if previous is missing:
                        sys.modules.pop(name, None)
                    else:
                        sys.modules[name] = previous

    def test_r4_release_requires_owner_and_verified_receipt_metadata(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            release = make_release(root)
            release["released_by"] = "worker-13"
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint._approved_sources(
                    release, "preflight", tool_directory=root, profile="r4"
                )
            self.assertEqual(error.exception.reason, "tool_release_invalid")

            release = make_release(root)
            Path(release["review_receipts"][0]["path"]).write_bytes(b"changed receipt\n")
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint._approved_sources(
                    release, "preflight", tool_directory=root, profile="r4"
                )
            self.assertEqual(error.exception.reason, "review_receipt_mismatch")

    def test_r4_standing_policy_pin_is_fixed_and_detects_changed_policy_bytes(self):
        config, reason = workspace_guard.load_r4_config()
        self.assertIsNone(reason)
        self.assertEqual(
            config["standing_source_policy_pin"]["policy"]["sha256"],
            config["standing_source_policy_sha256"],
        )
        self.assertEqual(config["standing_source_policy_document"]["event_scope"], "preparation")

        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            profile_path = root / "decision-scope-profile.json"
            policy_path = root / "decision-standing-source-policy.json"
            pin_path = root / "decision-standing-policy-pin.json"
            profile_bytes = b"R-owned test profile bytes\n"
            profile_path.write_bytes(profile_bytes)
            profile_sha = hashlib.sha256(profile_bytes).hexdigest()
            profile = {"standing_source_policy": policy_path.as_posix()}
            policy_bytes = json.dumps({
                "schema_version": 1,
                "mode": "standing_scope",
                "writer": 13,
                "trial_id": workspace_guard.R4_PROFILE_ID,
                "event_scope": "preparation",
                "guard_profile_sha256": profile_sha,
            }).encode()
            policy_path.write_bytes(policy_bytes)
            pin_path.write_text(json.dumps({
                "schema": "jot.r4-standing-policy-pin.v1",
                "issued_by": "R",
                "profile_id": workspace_guard.R4_PROFILE_ID,
                "scope_profile": {"path": profile_path.as_posix(), "sha256": profile_sha},
                "policy": {
                    "path": policy_path.as_posix(),
                    "sha256": hashlib.sha256(policy_bytes).hexdigest(),
                },
                "event_scope": "preparation",
                "product_START_authorized": False,
            }), encoding="utf-8")
            with patch.object(workspace_guard, "R4_PROFILE", profile_path):
                with patch.object(workspace_guard, "R4_PROFILE_SHA256", profile_sha):
                    with patch.object(workspace_guard, "R4_STANDING_SOURCE_POLICY", policy_path):
                        binding, error = workspace_guard._load_r4_standing_policy(profile)
                        self.assertIsNone(error)
                        self.assertEqual(binding["sha256"], hashlib.sha256(policy_bytes).hexdigest())
                        policy_path.write_bytes(policy_bytes + b"tampered")
                        binding, error = workspace_guard._load_r4_standing_policy(profile)
            self.assertIsNone(binding)
            self.assertEqual(error, "standing_source_policy_changed")

    def test_r4_product_policy_requires_hash_pinned_start_snapshot(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            profile_path = root / "decision-scope-profile.json"
            policy_path = root / "decision-standing-source-policy.json"
            policy_pin_path = root / "decision-standing-policy-pin.json"
            snapshot_path = root / "trial-start-snapshot.json"
            trial_pin_path = root / "trial-start-pin.json"
            profile_document = json.loads(workspace_guard.R4_PROFILE.read_text(encoding="utf-8"))
            profile_document.update({
                "standing_source_policy": policy_path.as_posix(),
                "trial_start_snapshot": snapshot_path.as_posix(),
                "trial_start_pin": trial_pin_path.as_posix(),
            })
            profile_bytes = json.dumps(profile_document).encode()
            profile_path.write_bytes(profile_bytes)
            profile_sha = hashlib.sha256(profile_bytes).hexdigest()
            profile = json.loads(profile_bytes)
            started_at = "2026-10-25T06:00:00Z"
            ends_at = "2026-10-25T08:00:00Z"
            policy_bytes = json.dumps({
                "schema_version": 1,
                "mode": "standing_scope",
                "writer": 13,
                "trial_id": workspace_guard.R4_PROFILE_ID,
                "event_scope": "product",
                "guard_profile_sha256": profile_sha,
                "valid_from": started_at,
                "expires_at": ends_at,
            }).encode()
            policy_path.write_bytes(policy_bytes)
            policy_sha = hashlib.sha256(policy_bytes).hexdigest()
            policy_pin_path.write_text(json.dumps({
                "schema": "jot.r4-standing-policy-pin.v1",
                "issued_by": "R",
                "profile_id": workspace_guard.R4_PROFILE_ID,
                "scope_profile": {"path": profile_path.as_posix(), "sha256": profile_sha},
                "policy": {"path": policy_path.as_posix(), "sha256": policy_sha},
                "event_scope": "product",
                "product_START_authorized": True,
            }), encoding="utf-8")
            snapshot_bytes = json.dumps({
                "schema": "jot.r4.trial-start-snapshot.v1",
                "trial_id": workspace_guard.R4_PROFILE_ID,
                "trial": {
                    "started": True,
                    "real_product_trial_started": True,
                    "started_at": started_at,
                    "ends_at": ends_at,
                },
                "scope_profile": {"path": profile_path.as_posix(), "sha256": profile_sha},
                "standing_source_policy": {"path": policy_path.as_posix(), "sha256": policy_sha},
            }).encode()
            snapshot_path.write_bytes(snapshot_bytes)
            trial_pin = {
                "schema": "jot.r4.trial-start-pin.v1",
                "trial_id": workspace_guard.R4_PROFILE_ID,
                "snapshot_path": snapshot_path.as_posix(),
                "snapshot_sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
                "immutable": True,
            }

            with patch.object(workspace_guard, "R4_PROFILE", profile_path):
                with patch.object(workspace_guard, "R4_PROFILE_SHA256", profile_sha):
                    with patch.object(workspace_guard, "R4_STANDING_SOURCE_POLICY", policy_path):
                        with patch.object(workspace_guard, "R4_TRIAL_START_SNAPSHOT", snapshot_path):
                            with patch.object(workspace_guard, "R4_TRIAL_START_PIN", trial_pin_path):
                                binding, error = workspace_guard._load_r4_standing_policy(profile)
                                self.assertIsNone(binding)
                                self.assertTrue(error)
                                with patch.object(
                                    tool_entrypoint, "_load_workspace_guard", return_value=workspace_guard
                                ):
                                    with self.assertRaises(tool_entrypoint.ToolReleaseError):
                                        tool_entrypoint._tool_arguments(
                                            "preflight", ["packet.json", "--root", "E:/codex"]
                                        )

                                trial_pin_path.write_text(json.dumps(trial_pin), encoding="utf-8")
                                binding, error = workspace_guard._load_r4_standing_policy(profile)
                                self.assertIsNone(error)
                                self.assertEqual(binding["document"]["event_scope"], "product")
                                config, error = workspace_guard.load_r4_config()
                                self.assertIsNone(error)
                                with patch.object(
                                    tool_entrypoint, "_load_workspace_guard", return_value=workspace_guard
                                ):
                                    args = tool_entrypoint._tool_arguments(
                                        "preflight", ["packet.json", "--root", "E:/codex"]
                                    )
                                self.assertEqual(
                                    args[args.index("--scope-policy") + 1], str(policy_path.resolve())
                                )

                                trial_pin["snapshot_sha256"] = "0" * 64
                                trial_pin_path.write_text(json.dumps(trial_pin), encoding="utf-8")
                                binding, error = workspace_guard._load_r4_standing_policy(profile)
                                self.assertIsNone(binding)
                                self.assertTrue(error)
                                config, error = workspace_guard.load_r4_config()
                                self.assertIsNone(config)
                                self.assertTrue(error)
                                with patch.object(
                                    tool_entrypoint, "_load_workspace_guard", return_value=workspace_guard
                                ):
                                    with self.assertRaises(tool_entrypoint.ToolReleaseError):
                                        tool_entrypoint._tool_arguments(
                                            "preflight", ["packet.json", "--root", "E:/codex"]
                                        )

    def test_r4_entrypoint_binds_policy_arguments_to_the_r_pin(self):
        config, reason = workspace_guard.load_r4_config()
        self.assertIsNone(reason)
        fixed_path = str(config["standing_source_policy"])
        fixed_sha = config["standing_source_policy_sha256"]

        preflight = tool_entrypoint._tool_arguments(
            "preflight", ["missing.json", "--root", "E:/codex"], profile="r4"
        )
        self.assertEqual(preflight[preflight.index("--scope-policy") + 1], fixed_path)
        self.assertEqual(preflight[preflight.index("--scope-policy-sha") + 1], fixed_sha)

        queue = tool_entrypoint._tool_arguments(
            "queue", [fixed_path, "--root", "E:/codex", "--events", "E:/codex/events.jsonl", "--action", "status"],
            profile="r4",
        )
        self.assertEqual(queue[0], fixed_path)
        self.assertEqual(queue[queue.index("--approval-sha") + 1], fixed_sha)

        freeze = tool_entrypoint._tool_arguments(
            "freeze", ["--repo", "E:/codex/repo", "--root", "E:/codex"], profile="r4"
        )
        self.assertEqual(freeze[freeze.index("--scope-policy") + 1], fixed_path)
        self.assertEqual(freeze[freeze.index("--scope-policy-sha") + 1], fixed_sha)

        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            root = Path(temp)
            self_policy = root / "self-selected-policy.json"
            self_policy.write_text("{}", encoding="utf-8")
            self_sha = hashlib.sha256(self_policy.read_bytes()).hexdigest()
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint._tool_arguments(
                    "queue", [str(self_policy), "--approval-sha", self_sha], profile="r4"
                )
            self.assertEqual(error.exception.reason, "standing_policy_override_forbidden")
            with self.assertRaises(tool_entrypoint.ToolReleaseError) as error:
                tool_entrypoint._tool_arguments(
                    "preflight", [
                        "missing.json", "--scope-policy", fixed_path,
                        "--scope-policy-sha", "f" * 64,
                    ], profile="r4"
                )
            self.assertEqual(error.exception.reason, "standing_policy_override_forbidden")

            stderr = io.StringIO()
            with patch.object(tool_entrypoint, "load_release") as load:
                with contextlib.redirect_stderr(stderr):
                    code = tool_entrypoint.main([
                        "--profile", "r4", "queue", str(self_policy), "--approval-sha", self_sha,
                        "--root", str(root), "--events", str(root / "events.jsonl"), "--action", "status",
                    ])
            load.assert_not_called()
            self.assertEqual(code, 1)
            result = json.loads(stderr.getvalue())
            self.assertEqual(result["reason"], "standing_policy_override_forbidden")

    def test_r4_entrypoint_selects_fixed_profile_and_release_path(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            release_path = Path(temp) / "release.json"
            release_path.write_text('{"profile_id":"r4-test"}', encoding="utf-8")
            guard = type("Guard", (), {
                "load_r4_config": staticmethod(lambda: ({"tool_release": release_path}, None))
            })()
            with patch.object(tool_entrypoint, "_load_workspace_guard", return_value=guard):
                self.assertEqual(tool_entrypoint.load_release(profile="r4"), {"profile_id": "r4-test"})

        self.assertEqual(
            tool_entrypoint._tool_arguments("guard", ["--worker", "15"], profile="r4"),
            ["--profile", "r4", "--worker", "15"],
        )
        release = {"schema": "synthetic"}
        sources = {"preflight": (Path("preflight.py"), b"# preflight")}
        with patch.object(tool_entrypoint, "load_release", return_value=release) as load:
            with patch.object(tool_entrypoint, "_approved_sources", return_value=sources) as approved:
                with patch.object(tool_entrypoint, "_run_sources", return_value=0) as run:
                    self.assertEqual(
                        tool_entrypoint.main(["--profile", "r4", "preflight", "--help"]), 0
                    )
        load.assert_called_once_with("r4")
        self.assertEqual(approved.call_args.kwargs["profile"], "r4")
        self.assertEqual(run.call_args.kwargs["profile"], "r4")

    def test_r4_main_pins_real_candidate_sources_and_loads_source_binding(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as temp:
            receipt_path = Path(temp) / "review.json"
            receipt_path.write_bytes(b"synthetic R4 tool-source review receipt\n")

            def entries(files):
                result = []
                for source_id, filename in files.items():
                    digest = hashlib.sha256((TOOL_DIRECTORY / filename).read_bytes()).hexdigest()
                    result.append({"id": source_id, "path": filename, "sha256": digest})
                return result

            release = {
                "schema": tool_entrypoint.R4_TOOL_RELEASE_SCHEMA,
                "profile_id": workspace_guard.R4_PROFILE_ID,
                "released_by": "R",
                "released_at": "2026-10-25T05:20:00Z",
                "shared_commit": "a" * 40,
                "shared_tree": "b" * 40,
                "entrypoint": {
                    "path": "tool_entrypoint.py",
                    "sha256": hashlib.sha256((TOOL_DIRECTORY / "tool_entrypoint.py").read_bytes()).hexdigest(),
                },
                "tools": entries(tool_entrypoint.R4_TOOL_SOURCE_FILES),
                "support": entries(tool_entrypoint.R4_SUPPORT_SOURCE_FILES),
                "review_receipts": [{
                    "path": str(receipt_path),
                    "sha256": hashlib.sha256(receipt_path.read_bytes()).hexdigest(),
                }],
            }
            self.assertEqual(
                tool_entrypoint._load_workspace_guard().R4_PROFILE_SHA256,
                workspace_guard.R4_PROFILE_SHA256,
            )
            with patch.object(tool_entrypoint, "load_release", return_value=release) as load:
                with contextlib.redirect_stdout(io.StringIO()):
                    code = tool_entrypoint.main(["--profile", "r4", "preflight", "--help"])
            load.assert_called_once_with("r4")
            self.assertEqual(code, 0)

            target = "E:/codex/yunticket/.test-tmp/jot-permissive-20261021/worker-15/private/entrypoint-guard-probe"
            output = io.StringIO()
            with patch.object(tool_entrypoint, "load_release", return_value=release) as load:
                with contextlib.redirect_stdout(output):
                    code = tool_entrypoint.main([
                        "--profile", "r4", "guard", "--worker", "15", "--target", target
                    ])
            load.assert_called_once_with("r4")
            self.assertEqual(code, 0)
            result = json.loads(output.getvalue())
            self.assertTrue(result["allowed"], result)
            self.assertFalse(result["permission_issued"])

    def test_r4_guard_loads_pinned_profile_and_checks_nested_private_scope(self):
        self.assertEqual(
            workspace_guard.R4_PROFILE_SHA256,
            "45b54330f139c577f8040332448e9d8eb6a05d0cf0f68c11dc1c0cbfbd0a74f3",
        )
        config, reason = workspace_guard.load_r4_config()
        self.assertIsNone(reason)
        self.assertEqual(config["profile"]["profile_id"], "jot-parallel-r4-20261025")
        self.assertEqual(len(config["assignments"]["workers"]), 20)

        worker15 = next(w for w in config["assignments"]["workers"] if w["number"] == 15)
        private_root = Path(worker15["private_workspace"])
        allowed = workspace_guard.check_r4(15, str(private_root / "private" / "guard-probe.txt"))
        self.assertTrue(allowed["allowed"], allowed)
        self.assertEqual(allowed["reason"], "private_workspace")
        self.assertFalse(allowed["permission_issued"])

        outside = workspace_guard.check_r4(15, "E:/codex/yunticket/.test-tmp/not-worker-owned/probe.txt")
        self.assertFalse(outside["allowed"])
        self.assertEqual(outside["reason"], "target_outside_allowed_roots")
        traversal = workspace_guard.check_r4(15, "../escape.txt")
        self.assertFalse(traversal["allowed"])
        self.assertEqual(traversal["reason"], "parent_traversal")

    def test_r4_guard_cli_uses_fixed_profile_and_rejects_assignment_override(self):
        target = "E:/codex/yunticket/.test-tmp/jot-permissive-20261021/worker-15/private/guard-probe.txt"
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = workspace_guard.main(["--profile", "r4", "--worker", "15", "--target", target])
        self.assertEqual(code, 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result["allowed"])
        self.assertFalse(result["permission_issued"])

        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = workspace_guard.main([
                "--profile", "r4", "--assignments", "E:/outside.json",
                "--worker", "15", "--target", target,
            ])
        self.assertEqual(code, 1)
        rejected = json.loads(output.getvalue())
        self.assertEqual(rejected["reason"], "r4_assignment_override_forbidden")

    def test_r4_guard_rejects_a_changed_profile_pin(self):
        with patch.object(workspace_guard, "R4_PROFILE_SHA256", "0" * 64):
            config, reason = workspace_guard.load_r4_config()
        self.assertIsNone(config)
        self.assertEqual(reason, "profile_changed")

    def test_r3_guard_still_uses_its_original_pinned_private_scope(self):
        self.assertEqual(
            workspace_guard.R3_PROFILE_SHA256,
            "af095aac34ce65a2d40b224a6ab500c8a9810a00b8c48b9f570bd7912eb130b1",
        )
        config, reason = workspace_guard.load_r3_config()
        self.assertIsNone(reason)
        self.assertEqual(config["profile"]["profile_id"], workspace_guard.R3_PROFILE_ID)
        target = "E:/codex/yunticket/.test-tmp/jot-permissive-20261021/worker-15/private/r3-guard-probe.txt"
        result = workspace_guard.check_r3(15, target)
        self.assertTrue(result["allowed"], result)
        self.assertFalse(result["permission_issued"])


if __name__ == "__main__":
    unittest.main()
