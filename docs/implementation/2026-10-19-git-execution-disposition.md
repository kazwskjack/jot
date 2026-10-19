# Original Git execution exclusion and explicit disposition

This increment continues the [durable execution plan](../superpowers/plans/2026-10-19-git-durable-index-execution.md).
It remains an internal owner-scoped service. No execution/control HTTP route,
MCP tool, UI write control or production setting is enabled by constructing it.
DSH remains the planner; the existing original approval, execution, SQLite
receipts and Worker lease provide the authority and history.

## Exclusion survives a changed snapshot binding

The previous repository digest included program/stat witnesses. A real replaced
directory at the same configured path produced a different digest and let a
fresh execution bypass an unresolved original one. Tests reproduce this with
actual repositories and also after assigning the configured path to a different
owned project; no mocked replacement hash is used.

New execution protocol 3 pins a versioned SHA-256 binding of the operator's
normalized common-directory path. That exclusion scope is independent of the
program/stat encoding, caller body and project alias. Its Worker resource is
`git-index-binding:<digest>`. Physical identities, exact source witnesses and
permissions are still checked separately: the binding is not filesystem access
or permission to execute. New outstanding records exclude another request for
the same project or configured binding. A genuinely unrelated bound project can
continue independently.

Existing records retain their original bytes and legacy lease key. Their new
binding column stays null; the constructor does not guess a current binding for
an old record. An unresolved unbound record conservatively blocks new admission
until its original owner acknowledges its disposition. This is an upgrade gate,
not a claim that all old tasks belong to the currently selected project. Known
original outcomes and explicit committed dispositions release that barrier.
Changing a review, request ID or configured project cannot clear it implicitly.

## Explicit owner acknowledgement

`inspect` returns the original execution view and an opaque digest over its
immutable execution/preparation/dispatch/outcome/disposition facts. It grants no
lease or mutation authority. `abandon` requires the original owner/project,
frozen request ID, exact state digest and literal `acknowledge_unknown: true`.
Roots, executables, binding/lease IDs and arbitrary cleanup paths are not input.

Original control requests, dispositions and control receipts are append-only.
The command first fences the old Worker through its original lease, then reads
the original physical evidence. An active lease refuses takeover; a timer does
not establish that a process died. If publication is proven, its original
applied outcome is recorded and returned without writing the index again. A
failed outcome write cannot be downgraded into abandoned-unknown success.

A modern execution with no original dispatch may become `not_dispatched`.
Unsafe legacy acquisition or a dispatched effect that cannot be proved becomes
`abandoned_unknown`. Neither state means rollback, successful task completion,
unchanged external files, or permission to repeat the original request. Any new
mutation needs a fresh original review. Historical applied response bodies keep
their previous shape and remain distinct from the control request's identity.

Cleanup is reported separately as verified, unverified, not recorded or not
attempted. Only original persisted owned-file proofs are eligible. Changed roots,
unconfigured historical bindings, unproven legacy locks and foreign files stay
untouched. Acknowledging uncertainty does not make them owned. A verified cleanup
return alone does not release admission: an original outcome or explicit
disposition must commit.

## Fenced cleanup and exact recovery

The original executor now retains its lease until ordinary cleanup finishes.
Ordinary cleanup, restarted recovery and explicit disposition execute their
synchronous owned-file removal under the existing database transaction and
current lease fence. A former Worker cannot continue cleaning after takeover.
Source observation may await outside that transaction; final cleanup rechecks
ownership, lease and physical proofs inside it. No asynchronous Git mutation is
wrapped in a caller's root HTTP transaction.

An explicit control can lose its reply or exit after physical cleanup but before
its receipt commits. Its original request stays recoverable; the disposition and
receipt either commit together or remain pending. Retrying the identical control
reconciles its own receipt without another index mutation. `getControl` checks
current ownership and the original request/receipt hashes, including historical
applied responses. Same-ID changed-body requests and stale state digests refuse.
Closed executions cannot append a new dispatch/outcome or regain execution.

Actual child-process fixtures exit before and after control receipt publication.
Other cases exercise failed receipt/outcome writes, database reopening, replaced
leases, owner changes, cancellation, literal acknowledgement, immutable rows,
unproven legacy files, changed roots/project aliases and independent bindings.
All test content is synthetic. Focused and complete regression/build/publication
gates remain separate evidence; these mechanisms do not complete full Git support.

Before enabling a writer across an upgrade, stop/drain earlier executor versions.
The earlier finalizer did not fence its own cleanup; expiry alone must not be used
as proof that such an old process is gone. Public execution admission remains
unmounted in this increment. Original API/schema/BFF/atomic acknowledgement and
mobile controls, commit/destructive/revert/remote operations and power-loss
durability retain their own acceptance requirements.
