# Explicit original native publication dispatch and recovery

The [completed-source/acceptance/status API](2026-10-20-publication-source-and-execution-api.md)
now has an explicit native IO boundary. It uses the existing authenticated local
transport and the original `WorkPublicationExecutions` in the original Host.
DSH Session/Goal planning, owner/project checks, original source/target review,
workspace family, checkpoint maintenance, Worker fencing and per-file journal
remain authoritative. There is no second producer, planner or queue.

## Commands and receipts

- `POST /v1/projects/{projectId}/work-publication-executions/{executionId}/dispatch`
  accepts only an empty JSON object. The Gateway constructs owner/project/
  execution IDs and `operation_kind: work_publication` itself. Unknown, running
  or otherwise started effects cannot be dispatched again through this route.
- `POST .../settle` accepts the original request ID, `confirm_recorded` or
  `abandon_unknown`, exact expected journal digest and explicit
  `acknowledge_unknown: true`. These commands cannot delete or replay files.
- `GET .../settlements/{requestId}` reads the immutable original command receipt,
  independently of current reservation status. Its `recorded_at` is the original
  journal command-record time, not an assertion that native settlement finished.
- `GET .../settlement` reads that same original recorded command without needing
  its request ID. This lets another owned device inspect an interrupted command;
  it does not create a replacement command or finish settlement on read.

The native acknowledgement is not used as result authority. After dispatch the
Gateway reads the original validated database status; a peer claiming success
without an original applied record gets `WORK_PUBLICATION_DISPATCH_UNCONFIRMED`.
After settlement it additionally reads the original command receipt, matches
the command's ID/action/digest and checks the independently derived final status.
Receipt reads do not invoke the Host, acquire custody, clear leases or write SQL.

Admission still uses the original synchronous atomic HTTP/business transaction.
Dispatch and settlement do not hold SQL transactions across IPC. Their HTTP
requests use the existing non-replaying pending-request boundary: an uncertain
pending request cannot be automatically dispatched on retry. Owner and CSRF are
checked before cached acknowledgements. Lost responses require original receipt
and status reads; explicit owner recovery retains the original journal CAS and
fresh native custody. Cancellation propagates through existing IPC signals.

## Operator configuration and deployment layout

Both `GENERAL_AGENT_NATIVE_GIT_SOCKET` and
`GENERAL_AGENT_NATIVE_GIT_TOKEN_FILE` must be supplied together, or both omitted.
The file must use an absolute operator-controlled path and contain the same
application-only token privately configured in the original Host. No actual
token, personal path or production identity belongs in a public configuration.
Incomplete configuration fails startup. The client keeps settings in a closure;
serialization exposes neither the token nor the endpoint.

The adapter's existing `nativeGit` configuration contains `databasePath`,
`repositories`, `socket` and `tokenEnv`, and requires
`nativeWorkspaceAdmission: true`. `tokenEnv` names a private `JOT_*` environment
variable; it does not contain the value. Configure both processes against the
same existing physical database and exact owner/project/repository bindings.
The Host verifies database identity against the Gateway before serving effects.
The current Host configuration supports its explicit simple root bindings;
broader linked-worktree/provider/deployment parity remains a separate gate.

Linux uses the existing owner-only socket directory check. Windows uses the
existing `jot-git-*` named-pipe rule. Neither accepts a TCP URL. Original transport
authentication, bounded messages, cancellation, drain and no automatic retries
are reused without duplicating their implementation.

Keep the shipped sibling layout:

```text
packages/
  gateway/src/git/native-transport-client.ts
  gateway/dist/src/git/native-transport-client.js
  session-adapter/native-git-transport.js
```

The source client selects the exact source-layout sibling. The compiled client
selects the exact compiled-layout sibling. It does not probe alternate folders,
accept a browser/environment module path or fall back to a shadow module.

Publication storage installation remains explicit maintenance, never an HTTP
side effect or constructor action. Stop and drain the original Gateway, workers
and native Host, retain a consistent original database backup, and use the
existing `upgradeWorkspacePublicationCoordination`,
`installWorkPublicationIntents` and `installWorkPublicationExecutions` sequence
before enabling the client. The original schema/lease/unknown-outcome checks must
not be bypassed. The [packaged offline maintenance entry](2026-10-21-publication-offline-maintenance.md)
now wraps that original sequence; its publication and real deployment acceptance
remain separate. This increment has not provisioned any live account,
secret, service or production database.

## Executed acceptance and remaining work

Source and compiled clients both reached the original authenticated IPC server.
They retained exact IDs/commands, rejected injected settings, stopped on
cancellation and exposed no credentials through serialization. A separate
compiled-layout shadow-module regression first failed, then passed after fixing
the selection to one exact sibling. The adapter's nine transport cases passed,
including disposal, wrong authentication and malformed endpoints.

Two installed-SDK cases passed with zero model calls. The actual Gateway sent a
public dispatch to a separate original Host and verified real file bytes. Review
revocation prevented subsequent writes. Exiting that process after applying
bytes produced an uncertain response and `applied_pending_settlement`; another
dispatch was refused without adding journal records. An explicit owner command
under fresh native custody completed the original settlement without rewriting
the file inode. HTTP replay and GET recovery returned original receipts. The
other case verified a read-only original abandonment receipt without any Host
on the reading service.

The peer-claim protection test verifies a claimed success cannot manufacture
original effects or bypass pending HTTP uncertainty. Its initial failure was a
synthetic fixture name collision between a URL base and original file contents;
it now compares before/after file bytes directly and passed on recheck.

The integrated focused gate then completed with 78/78 passed, no skips or
cancellations, including the installed SDK native custody, per-file producer,
process-loss and original acceptance tests. The source/compiled client and
latest-receipt route checks ran in that same gate. All captured product files
remained unchanged. Root tests passed 67/67 and frontend tests 257/257; Gateway
typecheck/build, frontend build and six disclosure-verifier tests passed.
The source-tree scanner reported zero findings across 1,207 files. These are
local synthetic gates, not a replacement for the remaining complete changed-tree,
browser/provider/platform and production acceptance.

Browser/BFF/mobile review, Apply and recovery now have local executed evidence in
[the mobile implementation record](2026-10-21-publication-mobile-apply.md).
Exact changed-tree regression and disclosure review remain separate. The earlier
frozen 2,220 Gateway gate does not certify these later changes. Full26 capabilities,
portable Chat/Work, broader producers/platforms/providers and real deployment
remain open. No production Apply or model execution has been enabled here.
