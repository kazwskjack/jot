# Delivery flow v1 local review composition

This composition combines exact pinned sources from owners 13, 15, 17 and 20. See composition-provenance.json for original paths and raw hashes. linux-README.md and metrics-README.md preserve the owners' original README bytes under distinct names. The shared configuration preparation baseline is 153af9a2a80da1305930b93a6b7dde9b060405eb.

## Preflight and finite queue

Run `python preflight.py PACKET --root ALLOWED_ROOT`. Packet identity includes the Git delta manifest (`manifest_path`, `manifest_sha256`), and separate pinned `{path,sha256}` references `source_archive` and `source_manifest`. The complete archive file set must equal the candidate Git tree; each archived file, pinned test and lock must agree with Git. Forward/reverse delta patches are verified in a temporary index. No packet commands are executed.

For a real Linux result, source.package_sha256 is the ZIP hash, event_context.manifest_path/manifest_sha256 retain the Git delta manifest identity, and artifacts.source_manifest/source_manifest_sha256 identify the separate complete archive manifest. The retained result, raw log and standalone test event are validated using owner 15's schema and validator. An explicit evidence_kind=authoring_host result is accepted only for scope=synthetic with empty ac_ids and no environment claim. This is contract testing, never Linux evidence. Historical fixtures without these archive references are rejected.

Run `python queue.py APPROVED --root ROOT --events OWNER13_EVENTS --action status|claim|record`. Approved entries pin packet path/SHA and dependencies. Default scope is tools/delivery-flow-v1/. An entry may additionally specify exact allowed_paths: unique canonical file paths, no wildcard/directory grant, exactly matching the preflight changed paths. Non-tool paths require a source review ACCEPT; the unreviewed synthetic exception remains tool-only with empty ac_ids. Every successful queue status/claim/record response explicitly has `runner_execution_authorized=false`; a claim never grants runner execution permission. The queue only claims work and validates actual writer receipts; it never executes packet commands or makes Git writes. Product entries are granted by R only after trial_start; these fixtures grant no product authorization.

## Runner execution boundary

`queue.advance` does not call `linux_run.run` or start `Popen`. Its synthetic exception permits local preflight/claim/receipt work only. The Linux runner separately requires an operator-supplied execution descriptor and its independent SHA-256 pin before extraction or child start. The descriptor binds the archive and full-source manifest, packet context, Git-delta identity (or explicit `not_applicable`), candidate commit/tree, test and lock maps, exact `node --test` argv, and named remote environment profile.

The runner accepts only `--execution-root-kind remote`. `--authorized-root` only constrains work/output paths; neither it nor the descriptor is an OS sandbox or proof that the caller-approved environment has no credentials. Callers must use the already-approved isolated, credential-free Linux environment. SIGTERM uses the same process-group cleanup path as KeyboardInterrupt and restores the previous handler afterward. The runner terminates and checks its process group before freezing the log/result; if it cannot confirm cleanup, it exits nonzero without a final result/event. `cleanup.process_group_cleaned` is `null` when no child was started, `true` after an observed empty group, and `false` when cleanup could not be confirmed; validators reject results with an exit code unless it is `true`. Descendants that call `setsid()` can escape this process-group check, and SIGKILL cannot be caught.

## Local checks

From the repository root (PowerShell):

```powershell
$env:PYTHONPATH = (Resolve-Path tools/delivery-flow-v1).Path
python -B -m unittest discover -s tools/delivery-flow-v1 -p 'test_*.py' -v
python -B -m unittest discover -s tools/delivery-flow-v1/tests -p 'test_*.py' -v
```

The first suite covers owner 13's preflight/queue and authoring-host cross-tool simulations. The second covers owners 15/17/20. test_interop.py constructs a simulated Linux-shaped receipt solely to exercise validation; its /usr/bin/node environment is fixture data and is never exported as an execution receipt. Runner authorization tests use temporary fixed descriptors and a mocked child; they do not execute candidate code. Coverage tests use temporary worktrees under E:/codex and the existing pinned project skill installation; they do not install into real mapped worktrees. A platform directory-link test can skip when link creation is unavailable.

## Remaining boundary

The retained d060882ad1eb Node core candidate has local Node, queue and workflow-metrics evidence. Its old bundle/result.json used the wrong package_sha256 meaning and is historical only. packet-contract-v2.json and bundle/authoring-contract-v2.json separately preserve the corrected authoring contract. It has no same-candidate Linux receipt; the M14 slice is a separate source identity. No remote push, deployment, product acceptance or two-hour product trial is performed by this composition. Metrics emit workflow data only; formal acceptance remains with owner 14.


## Local source-only handoff (R3)

Use the approved release's absolute `local_freeze.py` entrypoint. It borrows
preflight path/Git checks and never runs tests, installs, merges, resets WIP,
or grants runner/AC authority. For example (all paths under the approved root):

```powershell
python E:/codex/APPROVED_RELEASE/tools/delivery-flow-v1/local_freeze.py --root E:/codex --repo E:/codex/AUTHOR --base FULL_SOURCE_BASE_COMMIT --target E:/codex/INTEGRATION --output E:/codex/AUTHOR/.test-tmp/frozen-ID --packet-id ID --owner 2 --path packages/example/source.ts --test packages/example/test.mjs --lock package-lock.json
```

`--path`, `--test`, and `--lock` repeat for exact regular files, never trees.
The output must be new. The source base is explicit; current author HEAD/status
and target HEAD/tree are read from Git. Only selected working bytes enter a
temporary index. The original source patch must apply to the actual clean target;
the composed candidate preserves unrelated target changes. No branch or real
index is advanced. Output contains canonical postimages, source raw SHA-256,
Git preimage/postimage IDs, selected test/lock hashes, forward/reverse patches,
manifest, packet and a process-observed ready event. No ZIP is built.

Tests/locks must byte-match the composed target (explicit UTF-8 CRLF/LF mapping
is allowed); hashes are source identity, not proof of passing tests. Snapshot or
patch mutation invalidates preflight. An optional `--wip-baseline FILE
--wip-baseline-sha SHA256` reads a pinned startup `{ "files": { "path": "raw SHA256" } }`
map. Selected files are marked inherited-unchanged or changed-since-baseline;
missing attribution stays `unknown`. All local packets conservatively retain
`source_class=inherited_wip`; this is not automatic new-work or AC credit.

`preflight.py` accepts the explicit `delivery_kind=local_source_only` contract
without remote archive/results. It still verifies the exact Git delta, snapshots,
source/test/lock identities, both patch directions and reviewer identity.
A review is required before a local packet can be claimed by `queue.py` (even
for tools). R supplies the finite approval plan and exact product path allowlist.
Claim checks that the target is still clean at the frozen base; otherwise
refreeze. Queue claim emits `received_at` at the actual accepted claim, not at
chat arrival; source messages received outside the queue remain unknown. Record
verifies the actual clean Git integration and emits `integrated_at` at receipt
observation; it does not backdate to a supplied receipt timestamp or Git date.
`timestamp_basis=process_observed` and `timestamp_provenance={basis:'process_observed',
process_observed_at:occurred_at,actor_reported_at:null}` separate these transitions
from actor reports.
No CLI time override is provided. Source-only readiness does not assert that any
suite, full original AC, or remote environment passed.

Remote/Linux delivery is unchanged: complete source archive/manifest, test and
lock pins, execution descriptor and independent authorization remain mandatory.
A source-only packet cannot be used as a runner execution descriptor.


For R3 product packets, pass both `--task-owner SLOT --task-id ORIGINAL_AC`.
There is no source-class CLI override: the producer reads the fixed reviewed
R3 profile and its actual immutable START pin, snapshot and frozen work-order
hash. Missing START, an arbitrary task, or changed work-order bytes fails closed.
Preparation packets omit these options; no product-start event is invented.
`owner` remains the producing actor (queue: `13`), `task_owner` the integer
responsibility slot, and `packet_id` the unique source revision rather than the
AC/task ID. Preflight rechecks the pinned classification; queue copies the same
verified task context to received/integrated events. The default R2 path remains
unchanged.

R3 rollups pin the immutable START-pin bytes and reject events outside the
pinned trial window. Every R3 event must include `timestamp_provenance`, and its
selected timestamp must equal `occurred_at`; actor-reported task intervals stay
separate from process-observed queue packets. A `next_primary` destination must
be a worker number in the pinned R3 assignments. The recorder serializes each
worker stream's history check and append with an adjacent `.lock` file confined
to that worker's private workspace.


The freeze command requires the released R3 `workspace_guard` helper import.
Its fixed profile binds owner, actual source cwd/private workspace and output;
output must be that author's private/report directory and target must be the
fixed shared integration baseline. Missing R3 guard fails closed. Release owners
must pin/preload `workspace_guard` with `preflight` for `freeze`; no CLI helper
path is accepted. `GIT_OPTIONAL_LOCKS=0` also prevents read-only Git status from
refreshing shared indexes. Local preflight uses a caller-scoped temporary private
object database for patch roundtrips; it never writes target or packet objects.
All provenance includes `native_observed_at:null`. Tool preparation emits
`event_scope=preparation` without a trial/task; actual product events use
`event_scope=product` with the pinned R3 trial/task context.
