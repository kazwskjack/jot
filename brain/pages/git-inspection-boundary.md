---
id: git-inspection-boundary
title: Git views use owned read-only repository snapshots
category: decision
status: active
created: "2026-10-19T17:04:32"
updated: "2026-10-20T13:31:16"
---

<!-- compiled_truth -->
Git workbench reads are bound by operator configuration to an existing owner and project. Browser input may choose an owned project and a file from a reviewed snapshot, never a root, executable or arbitrary command. Recheck project ownership and physical repository identity after awaited reads. A snapshot or diff grants no execution, commit, discard, push or native Goal authority.

Read Git through a disposable controlled metadata copy containing the exact original HEAD, index and refs and a fixed verified object directory. Copy only allowlisted nonexecutable repository configuration. Do not activate source include files, hooks, clean/process filters, fsmonitor, external diff/textconv, lazy fetch or interactive credentials. Disabling external diff alone did not prevent clean-filter handling. The copy is private temporary read machinery, not a replacement repository, mutation target, planner or receipt store; source metadata and working-file witnesses must still match before results are published.

Keep bounded output/cancellation and credential-free remote projections. Future local and remote mutations must target the original trusted repository under separate reviewed intents and immutable recovery receipts. Read-only acceptance does not complete the full Git capability or the PilotDeck ledger.
Git 执行的配置占用范围与程序／stat 见证分离：原始记录固定 operator 配置的 common-directory 绑定，程序升级或项目别名不能使未决执行变成空闲槽位。旧记录缺少可靠绑定时保留升级阻塞，不猜测归属，也不改写旧证据。物理根、原审批、当前 owner 和原 Worker 租约仍分别核验，DSH 仍是唯一规划者。

未知效果只能通过原归属用户的明确确认处置。控制请求固定 request ID、原状态摘要和未知结果确认；原回执不可变，不能将物理清理视为回滚或新的执行权限。已证实的效果返回原 applied 回执，其余明确区分 not_dispatched 与 abandoned_unknown；同一请求不得重跑。正常退出、恢复和处置的归属文件清理均与原租约事务一起核验；旧版本执行进程需先停止／排空，才能开放升级后的写入入口。

原始 Git 受理与物理执行分开：受理和不可变回执同事务提交，不在 SQL 回调中启动异步写入或获取执行租约。历史受理与当前结果分别查询；历史受理不恢复取消的审批，查询不得重跑或自动恢复未知效果。UI 只能找回有原始受理记录的执行，不能接管内部或 native 请求。写入口须等原工作区协调与 producer 生命周期接通后开放，Git 独占租约不能代替 Agent／共享写入／检查点恢复互斥。


## Timeline

- time: 2026-10-19T17:04:32
  kind: decision
  summary: "Created this page: Git views use owned read-only repository snapshots"
  source: docs/superpowers/plans/2026-10-19-git-workbench.md
  affects: [git-inspection-boundary]

- time: 2026-10-19T17:05:12
  kind: decision
  summary: Bind Git inspection to original project ownership and isolated nonexecuting metadata reads
  source: docs/superpowers/plans/2026-10-19-git-workbench.md
  affects: [git-inspection-boundary]

- time: 2026-10-19T21:23:49
  kind: decision
  summary: "固定 Git 占用与未知处置边界，保持原规划、归属和租约校验"
  source: docs/implementation/2026-10-19-git-execution-disposition.md
  affects: [git-inspection-boundary]

- time: 2026-10-19T22:01:51
  kind: decision
  summary: Separate original Git admission and historical reads from physical dispatch and workspace coordination
  source: docs/implementation/2026-10-19-git-original-admission-history.md
  affects: [git-inspection-boundary]

- time: 2026-10-20T07:53:02
  kind: decision
  summary: "Original Git producer custody commits with its exact Worker lease before effects; known preparation failure and interrupted starts never grant an automatic retry, while existing accepted history and explicit disposition remain separate."
  source: docs/implementation/2026-10-20-git-producer-lifecycle.md
  affects: [git-inspection-boundary]

- time: 2026-10-20T09:47:17
  kind: evidence
  summary: "Installed native driver evidence: idle status is not workspace exclusivity. Hold every original resident Session with runMaintenance through the physical callback, preserve queued input, and propagate all native cancellation signals. The family primitive still requires the owning project reservation, complete membership and shared/checkpoint admission fences; it does not enable Git writes."
  source: docs/implementation/2026-10-20-native-workspace-barrier.md
  affects: [git-inspection-boundary]

- time: 2026-10-20T09:59:39
  kind: decision
  summary: "Original project reservations fence the existing Worker claim and shared-file CAS transactions; active or unbound legacy producers and expired leases cannot prove a workspace free. A reservation grants no Git/native execution, never expires automatically, and only an original admitted execution with no producer/effect facts may use pre-dispatch release. Complete native membership, original publication/root validation and checkpoint restore remain prerequisites for write activation."
  source: docs/implementation/2026-10-20-project-workspace-reservations.md
  affects: [git-inspection-boundary]

- time: 2026-10-20T11:19:40
  kind: decision
  summary: "Original reserved workspace membership includes historical Work/Chat/child references. Cold Sessions require original persistence write ownership; absent logs require the reviewed optional Jot protocol-2 factory fence and typed absence, never fake empty logs. Host-local factory custody does not prove cross-host exclusion, root/publication association or original producer drain, so Git write activation remains unavailable."
  source: docs/implementation/2026-10-20-workspace-family-cold-storage.md
  affects: [git-inspection-boundary]

- time: 2026-10-20T11:30:44
  kind: decision
  summary: "Original Git workspace family crosses the existing authenticated loopback bridge only as verified no-store inventory. Browser identity and supplied member/root lists cannot authorize it; original admission, current approval and ownership remain required. Inventory success does not create a namespace hold, dispatch grant or substitute asynchronous cached authority for the original synchronous execution guard."
  source: docs/implementation/2026-10-20-workspace-family-cold-storage.md
  affects: [git-inspection-boundary]

- time: 2026-10-20T12:07:21
  kind: decision
  summary: "Unsettled workspace custody follows the original project resource across ownership transfer; revocation never releases a producer or grants a new owner its execution. Unbound legacy scopes retain original-owner protection. Module-owned fence SQL upgrades atomically, failed installation rolls back, and unchanged definitions must not churn schema revisions used by immutable source witnesses."
  source: docs/implementation/2026-10-20-workspace-family-cold-storage.md
  affects: [git-inspection-boundary]

- time: 2026-10-20T13:05:58
  kind: evidence
  summary: "Native resume can append seed markers before setup; restart admission must run before original storage opening. Immutable original family seals survive owner or approval changes. Fresh authenticated observations deny unsafe create/resume but grant no Git effect rights; original synchronous authority, native custody, source association and producer settlement remain mandatory."
  affects: [git-inspection-boundary]

- time: 2026-10-20T13:31:16
  kind: evidence
  summary: "A native family seal identifies Sessions, not their filesystem placement. Maintained source contexts now expose exact resident/cold header cwd and digest only during original live custody; copies and expired contexts are refused. Working-directory changes invalidate resident maintenance. A native cwd, configured Git root and logical blob publication remain separate identities and require the original coordinator to establish their actual association before effects."
  affects: [git-inspection-boundary]
