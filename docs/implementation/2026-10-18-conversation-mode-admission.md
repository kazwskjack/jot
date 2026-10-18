# Conversation mode admission and native identity

This increment implements the extended Gateway's Chat/Work acceptance boundary.
It does not enable a live Chat preset, ship the mode switch UI, change the
standalone server's protocol, or deploy an application.

## Accepted policy and independent Sessions

Existing conversations migrate to Work. The migration copies only an existing
owned Work binding into `ga_conversation_mode_sessions`; it never creates a
native Session, imports history or recreates a Goal. Each mode has an immutable
mapping. Changing a deployment's Session prefix cannot redirect an existing
Work mapping. A missing saved Work alias after native execution requires
recovery, rather than silently creating a replacement.

An ordinary accepted run freezes its mode, conversation revision, preset/context
revision and original model-policy digest in `execution_policy_json`, along with
its original native lineage. Chat uses the trusted Host's fixed model and
`thinking: disabled` policy; browser-supplied policy fields are rejected. Work
keeps its saved model/effort preference and configured original preset. A later
conversation switch cannot redirect execution, recovery, history or final
publication of an earlier run.

Native child preparation keeps its original reservation, role, workspace and
budget contracts, without borrowing ordinary-mode policy. Hidden archived Work
mailbox conversations retain their existing internal execution path; fresh
ordinary API input to an archived conversation is refused. No mode field grants
tool permission, native execution authority or a new budget.

## Switching and receipts

Creation and PATCH accept an explicit `mode`. Older clients omitting it retain
Work. A mode change is owner-scoped and versioned. Queued/running/waiting or
cancelling work, unresolved controls, role/task scopes and ambiguous legacy
native identity block switching before allocating a new mode mapping.

The service reads native idle state for each saved mode Session and the original
Work Goal outside SQL. A busy/unknown native result or active/armed Goal blocks
the change. Confirmed absence is accepted only for an unused Session. Reads have
a bounded deadline even if the transport ignores cancellation; a late idle
reply cannot initiate another Goal read. The exact source snapshot is rechecked
inside the existing immediate transaction before the CAS write.

Create, mode PATCH and ordinary input commit their domain mutation and immutable
HTTP receipt together. A lost HTTP response replays the original receipt without
consulting a newly unavailable Host or creating another run. A separate original
client-message retry also returns its accepted run before resolving current mode.

Chat may read or pause/stop its preserved Work Goal. It cannot advertise or admit
Work Goal resume. Returning to Work requires the same native preflight, including
when the operator has disabled **new** Chat admission.

## Activation and boundaries

`GENERAL_AGENT_CHAT_ENABLED` defaults to `false`. API and Worker must agree on
configuration. The API additionally requires an authenticated exact Host policy
from `/v1/conversation-modes/readiness`. The real Host endpoint and mounted Chat
preset are **not implemented in this increment**; switching a flag does not make
them available. Unready or malformed policy refuses new Chat acceptance.

The Worker requires an explicitly mode-capable original Runner. A mismatched or
old Runner refuses Chat instead of falling back to Work. The new bearer-only
`ordinary-execution-policy` internal read checks the exact original run, native
Session and live execution lease, and returns the frozen policy and digest. It
is read-only and is not an execution grant.

`conversation_modes` capabilities distinguish Work support from Chat readiness.
The UI does not yet consume this metadata to choose its default. Fixed native
Chat tools, bounded context, per-turn Search/Fetch allowance, post-answer
compaction, provider cache evidence and the standalone profile remain tasks 4/5
in the [implementation plan](../superpowers/plans/2026-10-18-portable-chat-work.md).

## Evidence

Sixteen focused tests cover migration/reopen, immutable bindings/policy,
owned/versioned switching, native unknown/active/busy/deadline cases, lost
receipts, exact original retries, Chat model controls, Worker mismatch refusal,
read-only bearer/lease authority and disabling new Chat without trapping Work.

Seven installed SDK cases exercise actual Controller/AgentLoop model selection,
original Worker/Runner final publication, warm/steering behavior and forced Host
exit recovery using local scripted model providers. The new mode-switch case
uses real native idle/Goal reads, preserves the original Work Session and answer,
and returns to that same Session with no additional inference. Its **Chat
readiness is scripted**; it neither mounts a Chat Agent nor proves live Chat
inference, search quality or external-provider latency.

The first complete integration run exposed compatibility regressions involving
native child preparation, archived Work mailboxes, missing saved Work aliases and
the original response-schema error code. Those original regression assertions
were retained; the implementation was corrected before the final verification.
Windows restricted execution also refused loopback connections and temporary
directory links. Verification uses the authorized local user context for those
existing tests; no production credentials or services are involved.

Final verification:

- Gateway: 1,767 total, 1,760 passed, seven skipped, zero failed. Windows
  Gateway build and a separate final type check passed.
- Installed SDK protocol cases: seven passed, zero skipped. These use local
  scripted providers, with the Chat readiness limitation described above.
- Original official Host/real Gateway/Worker: ordinary input and saved role
  both passed, each with one local scripted model request and one final reply.
  An initial concurrent ordinary Host startup exceeded the unchanged 30-second
  readiness deadline, before a Worker or model request existed and without a
  captured Host error. The isolated two-case rerun passed without modifying
  source or timeouts; this does not establish a universal startup latency bound.
- Portable root: 50 passed; Windows Vite build passed.
- Public source: scanner tests passed and 932 files reviewed successfully after
  temporary test resources were cleaned up. No scanner rule was weakened.
- Staged source and reachable history: no new identity/credential finding.
  Seven previously reviewed findings remain: two generic example-path document
  objects and five neutral Office template objects. All were already reachable
  in the preceding uploaded branch; none is a new runtime export.

This is backend mode admission evidence, not complete Chat/Work or live provider
acceptance. The full capability ledger remains active.
