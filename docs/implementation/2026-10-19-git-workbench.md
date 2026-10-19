# Project Git inspection

The extended Gateway and workbench now provide an owned project repository view:
select a configured project, inspect branch/HEAD and changed files, open staged
or working patches, and refresh when the underlying files change. The standalone
runtime is a separate product path. Commit, discard and remote actions remain
open in the [full Git plan](../superpowers/plans/2026-10-19-git-workbench.md).

## Configuration and API

`GENERAL_AGENT_GIT_REPOSITORIES` defaults to `[]`. The operator supplies an array
of `{owner_id, project_id, root}` bindings, using an existing owned project and
an absolute repository path. Linked worktrees additionally require explicit
`git_directory` and `common_directory` mappings. One common metadata directory
cannot be bound twice. `GENERAL_AGENT_GIT_EXECUTABLE` optionally pins an absolute
Git executable outside the inspected repository. These values stay server-side;
the browser cannot select roots, executables or arbitrary Git commands.

The authenticated GET `/v1/projects/{projectId}/git` returns a snapshot. GET
`/v1/projects/{projectId}/git/diff` accepts only `snapshot_id`, a literal selected
`path`, and `stage=working|staged`. Ownership is checked before filesystem reads
and after awaited work. Both responses are private/no-store, read-only and
explicitly not execution authorization. Capabilities list only currently owned
configured project IDs. Remotes expose names, transport category and hostname,
never credential bodies or full URLs.

## Repository reads

The reader pins physical root, Git/common-directory and executable identities.
Metadata symlinks, changed witnesses, unsafe paths and nonempty alternates fail
closed. Index, HEAD, metadata and worktree file witnesses bind each diff to its
snapshot, including content edits that leave porcelain status unchanged.

`--no-ext-diff` and `--no-textconv` alone were insufficient: ordinary status and
diff can still attempt configured clean filters. Each inspection therefore uses
a disposable metadata copy with the original index/refs/object directory and
only allowlisted nonexecutable configuration. Source includes, hooks, filters,
credential helpers and arbitrary executables are not activated. Temporary copies
are cleaned up and source index bytes remain unchanged. No network operation is
provided. This is not an execution repository or a second authority store.

Reads bound subprocess output, duration, metadata traversal, changed entries and
patch size. Cancellation kills the owned child. Protected paths are omitted;
binary bodies are not rendered. Unborn/detached, conflicts, renames, deletions and
untracked changes remain explicit. Global Git configuration is deliberately not
inherited, so user-global filter semantics are not promised.

## Verification

- Full Gateway: 1,936 passed, seven existing conditional skips, zero failures
  (1,943 total). This includes fourteen actual-local-Git inspection cases, six
  ownership/API cases and synchronized contract regressions.
- Root: 67 passed. Full workbench/chat UI: 249 passed. The new actual mobile
  React/BFF/Gateway case uses a temporary repository at 390 by 844, opens real
  patches, rejects stale selection, and verifies no page-level horizontal overflow.
- Windows Gateway and Vite builds passed. The Gateway build ran after the
  complete Gateway suite terminated to avoid changing shared template fixtures
  mid-run; the independent frontend build completed separately.
- Chat prompt composition/tool boundaries: four portable and seven production
  adapter tests passed after the separate all-subject evidence-first prompt edit.

Fixtures cover hostile filters/configuration, directory replacement, linked
worktrees, cancellation, private paths, credential redaction, special filenames,
output/remote limits and unchanged source index. Windows symlink coverage uses
an actual directory junction; unsupported file-symlink creation was not counted
as a passing test or used to weaken operating-system settings.

These are local Git and scripted-provider workflow results. They do not prove
remote push authentication, production deployment, full Git parity, or completion
of the broader 26-capability plan.

Public preflight passed six scanner regressions and scanned 1,077 source files.
The reachable-history and staged-index review covered 184 commits and 2,819
distinct blobs. Its five findings are the exact previously reviewed neutral
Office template binary objects; none is a new finding from this increment.
This is a bounded heuristic review with separate binary provenance review,
not a claim that arbitrary secrets can be proved absent by pattern matching.
