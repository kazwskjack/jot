import copy
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path("E:/codex/yunticket")
PLAN_SOURCE = REPO_ROOT / "docs/superpowers/plans/pilotdeck-ledger-v2-20261021/parallel-permissive-20/plan.json"
MANIFEST_SOURCE = REPO_ROOT / "docs/diagnostics/ponytail-install-20261024/upstream-manifest.json"
SKILLS_SOURCE = REPO_ROOT / ".agents/skills"
LICENSE_SOURCE = REPO_ROOT / "docs/diagnostics/ponytail-install-20261024/LICENSE-MIT"
TEST_TEMP_PARENT = REPO_ROOT / ".test-tmp"
SCRIPT = Path(__file__).resolve().parents[1] / "coverage.py"
ROLE_5_THREAD = "01a167c6-3863-7b61-97b5-86aee066ee78"
SKILL_NAMES = (
    "ponytail",
    "ponytail-audit",
    "ponytail-debt",
    "ponytail-gain",
    "ponytail-help",
    "ponytail-review",
)


def make_junction(link: Path, target: Path) -> bool:
    if os.name != "nt":
        try:
            os.symlink(target, link, target_is_directory=True)
            return True
        except OSError:
            return False
    command = (
        "$ErrorActionPreference = 'Stop'\n"
        "New-Item -ItemType Junction -Path $env:PONYTAIL_LINK_PATH "
        "-Target $env:PONYTAIL_LINK_TARGET | Out-Null"
    )
    environment = {
        "SystemRoot": os.environ.get("SystemRoot", ""),
        "PATH": os.environ.get("PATH", ""),
        "TEMP": os.environ.get("TEMP", ""),
        "TMP": os.environ.get("TMP", ""),
        "PONYTAIL_LINK_PATH": str(link),
        "PONYTAIL_LINK_TARGET": str(target),
    }
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
        env=environment,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def is_reparse_point(path: Path) -> bool:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & 0x400)


class CoverageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ponytail-coverage-", dir=TEST_TEMP_PARENT)
        self.base = Path(self.temp.name)
        self.allowed_root = self.base / "allowed"
        self.allowed_root.mkdir()
        self.source_root = self.allowed_root / "project"
        self.source_root.mkdir()
        shutil.copytree(SKILLS_SOURCE, self.source_root / ".agents/skills")
        manifest_path = self.source_root / "docs/diagnostics/ponytail-install-20261024/upstream-manifest.json"
        manifest_path.parent.mkdir(parents=True)
        shutil.copy2(MANIFEST_SOURCE, manifest_path)
        license_path = manifest_path.with_name("LICENSE-MIT")
        shutil.copy2(LICENSE_SOURCE, license_path)

        plan = copy.deepcopy(json.loads(PLAN_SOURCE.read_text(encoding="utf-8")))
        self.workspaces = {}
        for worker in plan["workers"]:
            workspace = self.allowed_root / "workers" / f"worker-{worker['number']:02d}"
            workspace.mkdir(parents=True)
            (workspace / "AGENTS.md").write_text(
                f"# Existing role {worker['number']} instructions\n", encoding="utf-8"
            )
            subprocess.run(["git", "-C", str(workspace), "init", "-q"], check=True)
            worker["workspace"] = workspace.as_posix()
            self.workspaces[worker["number"]] = workspace
        plan["integration_workspace"] = (self.allowed_root / "integration").as_posix()
        self.plan_path = self.source_root / "plan.json"
        self.plan_path.write_text(json.dumps(plan), encoding="utf-8")
        self.manifest_path = manifest_path

        self.alias_workspaces = {}
        for role in (12, 13, 18):
            workspace = self.allowed_root / "aliases" / f"role-{role:02d}"
            workspace.mkdir(parents=True)
            (workspace / "AGENTS.md").write_text(
                f"# Existing alias role {role} instructions\n", encoding="utf-8"
            )
            subprocess.run(["git", "-C", str(workspace), "init", "-q"], check=True)
            self.alias_workspaces[role] = workspace
        self.alias_map_path = self.source_root / "reported-private-worktrees.json"
        self.write_alias_map()

        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self._remove_links)

    def _remove_links(self):
        for workspace in self.workspaces.values():
            skills_root = workspace / ".agents/skills"
            if is_reparse_point(skills_root) and skills_root.is_dir():
                os.rmdir(skills_root)
            elif skills_root.is_dir():
                for name in SKILL_NAMES:
                    skill_dir = skills_root / name
                    if is_reparse_point(skill_dir) and skill_dir.is_dir():
                        os.rmdir(skill_dir)
        escape = self.allowed_root / "workers/worker-01-escape"
        if is_reparse_point(escape) and escape.is_dir():
            os.rmdir(escape)

    def run_coverage(self, *extra_args):
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--source-root",
                str(self.source_root),
                "--plan",
                str(self.plan_path),
                "--manifest",
                str(self.manifest_path),
                "--allowed-root",
                str(self.allowed_root),
                *extra_args,
            ],
            cwd=self.source_root,
            capture_output=True,
            text=True,
        )

    def report(self, result):
        self.assertTrue(result.stdout.strip(), result.stderr)
        return json.loads(result.stdout)

    def write_alias_map(self, aliases=None):
        rows = [
            {
                "role": role,
                "workspace": workspace.as_posix(),
                "evidence": f"reported private worktree for role {role}",
            }
            for role, workspace in sorted(self.alias_workspaces.items())
        ] if aliases is None else aliases
        self.alias_map_path.write_text(
            json.dumps(
                {
                    "schema_version": "ponytail-reported-private-worktrees/v1",
                    "aliases": rows,
                }
            ),
            encoding="utf-8",
        )

    def test_default_dry_run_is_read_only_and_uses_all_20_plan_entries(self):
        before = {
            number: (workspace / "AGENTS.md").read_bytes()
            for number, workspace in self.workspaces.items()
        }
        result = self.run_coverage()
        self.assertEqual(0, result.returncode, result.stderr)
        report = self.report(result)

        self.assertEqual("dry-run", report["mode"])
        self.assertEqual(20, report["summary"]["worktrees"])
        role_5 = next(item for item in report["worktrees"] if item["role"] == 5)
        self.assertEqual(ROLE_5_THREAD, role_5["thread_id"])
        self.assertFalse(report["summary"]["activated"])
        for number, workspace in self.workspaces.items():
            self.assertFalse((workspace / ".agents").exists())
            self.assertEqual(before[number], (workspace / "AGENTS.md").read_bytes())

    def test_apply_adds_discoverable_skills_and_appends_guidance_without_claiming_activation(self):
        result = self.run_coverage("--apply")
        self.assertEqual(0, result.returncode, result.stderr)
        report = self.report(result)

        for number, workspace in self.workspaces.items():
            self.assertTrue((workspace / ".agents/skills").is_dir(), number)
            for name in SKILL_NAMES:
                self.assertTrue((workspace / ".agents/skills" / name / "SKILL.md").is_file(), (number, name))
            agents = (workspace / "AGENTS.md").read_text(encoding="utf-8")
            self.assertTrue(agents.startswith(f"# Existing role {number} instructions\n"))
            self.assertEqual(1, agents.count("BEGIN ponytail-full-2026-10-24"))

        self.assertEqual(0, report["summary"]["activated"])
        self.assertTrue(all(not item["activation"]["confirmed"] for item in report["worktrees"]))

    def test_identical_local_skill_is_reused_without_rewriting_it(self):
        source = self.source_root / ".agents/skills/ponytail"
        local = self.workspaces[1] / ".agents/skills/ponytail"
        shutil.copytree(source, local)
        skill_file = local / "SKILL.md"
        before_bytes = skill_file.read_bytes()
        before_mtime = skill_file.stat().st_mtime_ns

        result = self.run_coverage("--apply")
        self.assertEqual(0, result.returncode, result.stderr)
        report = self.report(result)
        row = next(item for item in report["worktrees"] if item["role"] == 1)

        self.assertEqual(before_bytes, skill_file.read_bytes())
        self.assertEqual(before_mtime, skill_file.stat().st_mtime_ns)
        self.assertEqual("reused-identical", row["skills"]["ponytail"])

    def test_conflicting_local_skill_is_preserved_and_not_counted_as_discoverable(self):
        conflict = self.workspaces[1] / ".agents/skills/ponytail/SKILL.md"
        conflict.parent.mkdir(parents=True)
        conflict.write_text("locally owned skill\n", encoding="utf-8")

        result = self.run_coverage("--apply")
        self.assertEqual(1, result.returncode, result.stderr)
        report = self.report(result)
        row = next(item for item in report["worktrees"] if item["role"] == 1)

        self.assertEqual("locally owned skill\n", conflict.read_text(encoding="utf-8"))
        self.assertFalse(row["skill_discoverable"])
        self.assertFalse(row["guidance_merged"])
        self.assertTrue((self.workspaces[2] / ".agents/skills/ponytail/SKILL.md").is_file())

    def test_manifest_mismatch_blocks_all_writes(self):
        source_skill = self.source_root / ".agents/skills/ponytail/SKILL.md"
        source_skill.write_text("changed after the pinned manifest\n", encoding="utf-8")

        result = self.run_coverage("--apply")
        self.assertEqual(1, result.returncode, result.stderr)
        report = self.report(result)

        self.assertEqual("invalid", report["source"]["status"])
        self.assertTrue(all(not (workspace / ".agents").exists() for workspace in self.workspaces.values()))
        self.assertTrue(
            all(
                (workspace / "AGENTS.md").read_text(encoding="utf-8").startswith("# Existing role")
                for workspace in self.workspaces.values()
            )
        )

    def test_unmanifested_skill_file_blocks_all_writes(self):
        extra = self.source_root / ".agents/skills/ponytail/hooks/install.py"
        extra.parent.mkdir(parents=True)
        extra.write_text("print('unmanifested')\n", encoding="utf-8")

        result = self.run_coverage("--apply")
        self.assertEqual(1, result.returncode, result.stderr)
        report = self.report(result)

        self.assertEqual("invalid", report["source"]["status"])
        self.assertIn("unmanifested file", report["source"]["reason"].lower())
        self.assertTrue(all(not (workspace / ".agents").exists() for workspace in self.workspaces.values()))

    def test_workspace_outside_allowed_root_is_blocked_before_writing(self):
        outside = self.base / "outside-worktree"
        outside.mkdir()
        plan = json.loads(self.plan_path.read_text(encoding="utf-8"))
        plan["workers"][0]["workspace"] = outside.as_posix()
        self.plan_path.write_text(json.dumps(plan), encoding="utf-8")

        result = self.run_coverage()
        self.assertEqual(1, result.returncode, result.stderr)
        report = self.report(result)
        row = next(item for item in report["worktrees"] if item["role"] == 1)

        self.assertEqual("blocked", row["status"])
        self.assertIn("allowed root", row["reason"].lower())
        self.assertFalse((outside / ".agents").exists())

    def test_allowed_root_cannot_be_widened_above_e_codex(self):
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--source-root",
                str(self.source_root),
                "--plan",
                str(self.plan_path),
                "--manifest",
                str(self.manifest_path),
                "--allowed-root",
                "E:/",
                "--apply",
            ],
            cwd=self.source_root,
            capture_output=True,
            text=True,
        )

        self.assertEqual(1, result.returncode)
        self.assertIn("allowed root cannot extend beyond E:/codex", result.stdout)
        self.assertTrue(all(not (workspace / ".agents").exists() for workspace in self.workspaces.values()))

    def test_workspace_junction_escape_is_blocked_without_touching_target(self):
        outside = self.base / "outside-target"
        outside.mkdir()
        sentinel = outside / "AGENTS.md"
        sentinel.write_text("outside stays unchanged\n", encoding="utf-8")
        escape = self.allowed_root / "workers/worker-01-escape"
        if not make_junction(escape, outside):
            self.skipTest("native directory-link creation is unavailable")
        plan = json.loads(self.plan_path.read_text(encoding="utf-8"))
        plan["workers"][0]["workspace"] = escape.as_posix()
        self.plan_path.write_text(json.dumps(plan), encoding="utf-8")

        result = self.run_coverage("--apply")
        self.assertEqual(1, result.returncode, result.stderr)
        report = self.report(result)
        row = next(item for item in report["worktrees"] if item["role"] == 1)

        self.assertEqual("blocked", row["status"])
        self.assertEqual("outside stays unchanged\n", sentinel.read_text(encoding="utf-8"))
        self.assertFalse((outside / ".agents").exists())

    def test_checked_in_plan_uses_the_new_role_5_thread_and_actual_workspace(self):
        plan = json.loads(PLAN_SOURCE.read_text(encoding="utf-8"))
        role_5 = next(item for item in plan["workers"] if item["number"] == 5)

        self.assertEqual(ROLE_5_THREAD, role_5["thread_id"])
        self.assertEqual(
            "E:/codex/yunticket/.test-tmp/jot-permissive-20261023/worker-05",
            role_5["workspace"].replace("\\", "/"),
        )

    def test_alias_roots_are_separate_from_20_plan_workers_and_dry_run_is_read_only(self):
        before = {
            role: (workspace / "AGENTS.md").read_bytes()
            for role, workspace in self.alias_workspaces.items()
        }
        result = self.run_coverage("--alias-map", str(self.alias_map_path))
        self.assertEqual(0, result.returncode, result.stderr)
        report = self.report(result)

        self.assertEqual(20, report["summary"]["worktrees"])
        self.assertEqual(3, report["summary"]["additional_private_roots"])
        self.assertEqual(3, len(report["additional_private_roots"]))
        self.assertEqual({12, 13, 18}, {row["role"] for row in report["additional_private_roots"]})
        self.assertTrue(all(row["status"] == "planned" for row in report["additional_private_roots"]))
        for role, workspace in self.alias_workspaces.items():
            self.assertFalse((workspace / ".agents").exists())
            self.assertEqual(before[role], (workspace / "AGENTS.md").read_bytes())

    def test_alias_conflict_blocks_dry_run_before_any_copy_or_guidance_write(self):
        workspace = self.alias_workspaces[13]
        conflict = workspace / ".agents/skills/ponytail/SKILL.md"
        conflict.parent.mkdir(parents=True)
        conflict.write_text("locally owned alias skill\n", encoding="utf-8")
        before_agents = (workspace / "AGENTS.md").read_bytes()

        result = self.run_coverage("--alias-map", str(self.alias_map_path))
        self.assertEqual(1, result.returncode, result.stderr)
        report = self.report(result)
        row = next(item for item in report["additional_private_roots"] if item["role"] == 13)

        self.assertEqual("blocked", row["status"])
        self.assertEqual("conflict", row["skills"]["ponytail"])
        self.assertEqual("locally owned alias skill\n", conflict.read_text(encoding="utf-8"))
        self.assertEqual(before_agents, (workspace / "AGENTS.md").read_bytes())
        self.assertFalse((workspace / ".agents/skills/ponytail-audit").exists())

    def test_apply_aliases_reuses_safe_install_logic_without_counting_23_executors(self):
        index_path = self.allowed_root / "index.json"
        result = self.run_coverage(
            "--alias-map",
            str(self.alias_map_path),
            "--apply",
            "--index-out",
            str(index_path),
        )
        self.assertEqual(0, result.returncode, result.stderr)
        report = self.report(result)
        index = json.loads(index_path.read_text(encoding="utf-8"))

        self.assertEqual(20, report["summary"]["worktrees"])
        self.assertEqual(20, report["summary"]["filesystem_ready"])
        self.assertEqual(3, report["summary"]["additional_private_roots"])
        self.assertEqual(3, report["summary"]["additional_roots_ready"])
        self.assertEqual(20, len(index["roles"]))
        self.assertEqual(3, len(index["additional_private_roots"]))
        for role, workspace in self.alias_workspaces.items():
            for name in SKILL_NAMES:
                self.assertTrue((workspace / ".agents/skills" / name / "SKILL.md").is_file(), (role, name))
                self.assertTrue((workspace / ".agents/skills" / name / "LICENSE-MIT").is_file(), (role, name))
            agents = (workspace / "AGENTS.md").read_text(encoding="utf-8")
            self.assertTrue(agents.startswith(f"# Existing alias role {role} instructions\n"))
            self.assertEqual(1, agents.count("BEGIN ponytail-full-2026-10-24"))

    def test_alias_outside_allowed_root_is_blocked_without_touching_that_root(self):
        outside = self.base / "outside-alias"
        outside.mkdir()
        (outside / "AGENTS.md").write_text("# Outside alias\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(outside), "init", "-q"], check=True)
        aliases = [
            {
                "role": 13,
                "workspace": outside.as_posix(),
                "evidence": "malformed outside fixture",
            }
        ]
        self.write_alias_map(aliases)

        result = self.run_coverage("--alias-map", str(self.alias_map_path), "--apply")
        self.assertEqual(1, result.returncode, result.stderr)
        report = self.report(result)
        row = report["additional_private_roots"][0]

        self.assertEqual("blocked", row["status"])
        self.assertIn("allowed root", row["reason"].lower())
        self.assertEqual("# Outside alias\n", (outside / "AGENTS.md").read_text(encoding="utf-8"))
        self.assertFalse((outside / ".agents").exists())


if __name__ == "__main__":
    unittest.main()
