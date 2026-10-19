# Internal Git index effects

The Git workbench now has a local stage/unstage effect kernel. It is an internal
prerequisite of [reviewed local mutations](../superpowers/plans/2026-10-19-git-workbench.md),
not an execution route, an autonomous tool or a production activation. Existing
review API/UI responses continue to report `execution_authorized:false`.

## What changes

`GitIndexEffects` extends the existing physically bound repository inspector.
Preparation uses a private controlled metadata copy to calculate exact index
bytes and canonical Git blobs. It does not stage into a replacement repository
and treat that as the original effect: application publishes the calculated
index into the original configured repository.

The selected working bytes, original index and HEAD, applicable attribute files,
physical repository/metadata/object directories and non-object metadata must
remain unchanged. Temporary index flattening supports split indexes without
rewriting the source index during preparation. Built-in line-ending handling is
preserved. Custom clean/process filters are refused rather than executed.

Application acquires exclusive original index, HEAD, packed-ref and current
branch locks. Native competing Git commands cannot overwrite these locks. The
kernel verifies exact owned lock identities and index-lock bytes before atomic
index replacement. Cleanup removes only locks and new empty parent directories
whose physical identities still belong to this application.

The trusted caller must recheck the original owner, approved review/version and
request authority, including inside the final synchronous database transaction.
A dispatch proof binds the source witness, candidate index and owned index-lock
identity. Canonical object writes are content-addressed and verified before
index publication; they can leave unreachable blobs if the final fence fails.
An unchanged index therefore does not prove that no object write was attempted.

The opaque in-memory plan cannot be cloned into authority. Once object dispatch
or index publication occurs, the plan cannot be replayed. An observation of the
target bytes alone is insufficient: the original owned lock identity must have
become the index, relevant refs must still match and referenced blobs must be
verified. Lost acknowledgement after actual index replacement is observable
without repeating the mutation. Observation never grants permission.

## Verification and boundaries

Actual temporary Git repositories exercise selected stage/unstage, unborn HEAD,
UTF-8 filenames, custom filter rejection, CRLF normalization, source changes,
approval revocation, foreign/competing locks, tampered owned locks, matching
bytes written by an outsider, changed attributes and lost acknowledgement.
Additional cases cover final-transaction revocation, deletion of a nested
working directory, exact binary bytes and competing native ref updates.
All fixture contents are synthetic. These tests do not contact remote providers.

The subsequent [internal durable execution increment](2026-10-19-git-durable-index-execution.md)
adds original request/dispatch/outcome rows, the existing Worker lease fence and
a strict cross-process observer. Real child exits now exercise before/after
publication, original outcome recovery and proven lock cleanup. HTTP/UI execution
admission and power-loss durability remain unverified. A database rollback does
not undo a Git index replacement, and an unknown outcome must never be replayed.

Rename unstaging is explicitly refused when the original and destination paths
are not both within the approved selection. Supporting that requires an exact
two-path review contract; it must not silently alter an unreviewed source path.
Commit, discard, untracked deletion, independently reviewed revert and remote
operations remain separate uncompleted parts of the full Git capability.

Before mounting any execution route, finish partial lock-acquisition recovery,
not-published/abandon disposition, the original HTTP command contract and
user-visible unknown-outcome handling. Original review protocol 2 now freezes
canonical transformation dependencies, including ignored/missing attributes;
preparation-time fences alone did not prove what an earlier approval covered.
Do not substitute a new planner, a general shell command or a successful review
acknowledgement for execution authority.
