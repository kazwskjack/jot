# Internal channel attachment intake v2

This candidate extends the original Gateway upload, channel-event and initial
input paths. It creates no additional artifact/receipt store or native runtime.
It is disabled by default and is independent of skill recovery (M16).

## Configuration and trust

`GENERAL_AGENT_CHANNEL_ATTACHMENTS_ENABLED=true` requires
`GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED=true`, the existing internal
channel service token, and the existing Session adapter client. No new secret is
introduced. Only trusted provider adapters may use this internal service bearer;
a principal supplied by an unauthenticated browser is not provider proof.

The existing native history readiness protocol must confirm protocol 1,
`ready:true`, and `execution_authorized:false`. Missing client capabilities are
a configuration error. A native outage leaves mutation endpoints at 503 while
original SQL receipt lookup stays available. Turning off new ingress retains
read-only lookup when the database already contains the v2 protocol marker;
mutation routes are absent. A pristine disabled deployment adds no v2 route.

These routes use the original mandatory service bearer. Their private
registration marker exempts only the registered internal operations from web
CSRF/generic idempotency middleware. Existing web and v1 rules are unchanged.

## Actual internal HTTP contract

All responses use `Cache-Control: no-store`. The prefix is
`/internal/v2/channel/attachment-batches`.

| Method and suffix | Request | Result |
|---|---|---|
| POST prefix | Original provider declaration below | 201 original durable stage |
| POST `/lookup` | Same exact declaration | 200 original receipt, observed stage, or unproven/not_observed |
| PUT `/:stageKey/parts/:index` | Octet stream; `x-channel-manifest-sha256` | 200 `part_staged`; no admission |
| POST `/:stageKey/admit` | `{protocol:2,manifest_sha256}` | 202 original admitted receipt |
| POST `/:stageKey/receipt` | `{protocol:2,manifest_sha256}` | 200 SQL-only receipt/stage lookup |

Provider declaration:

```ts
{
  protocol: 2,
  event: {channel, principal, thread_id, message_id},
  text,
  attachments: [{index, provider_file_id, file_name, media_type, size_bytes, sha256}]
}
```

No owner, binding, conversation, path, URL, base64 content or authority flag is
accepted here. The Gateway derives scope from its original verified binding.
The returned complete manifest binds owner, binding ID/version, reserved
conversation, event tuple, text, ordered provider file identities and exact
original artifact/version/hash/size/name/media/kind. Parts are version 1, unique,
1–10 in order, at most 100 MiB each and 200 MiB in aggregate.

`request_sha256` excludes the reserved conversation/artifact allocation while
binding original scope and provider declarations. `manifest_sha256` binds the
entire immutable allocated source. For this protocol `event_sha256` equals that
manifest hash. Stage/upload IDs remain stable across an exact retry and restart.

Upload stage states `staging`, `staged`, `finalized`, and `expired` describe only
the original upload batch. **`finalized` is not an admission receipt.** Only the
original event/message/run proof produces `state:admitted` and its original
`{accepted:true,message_id,run_id,conversation_id}` receipt.

Finite errors include 401 authorization, 403 scope, 409 changed source or stage
conflict, 410 expiry, 422 malformed/changed content, and 503 unavailable native or
backend state. Filesystem paths and raw provider failures are not returned.

## Unknown results and ownership of the consumer

After a lost reservation acknowledgement, query `/lookup` with the saved exact
declaration. After a lost admission acknowledgement, query the same original
receipt; do not download/upload/admit again merely because the HTTP result was
unknown. Unknown/unproven/not_observed and observed-stage lookup carry
`automatic_replay:false`. They are not proof of rejection or permission to send.

The provider adapter must persist its event/declaration and returned stage/hash
identity, authenticate the original provider principal, and handle this state
machine. It must never strip attachments and fall back to a v1 text send. These
provider adapters are a separate consumer integration responsibility.

## Original persistence, migration and retention

The original `ga_uploads` table holds the durable reservation. Internal batch
rows may have a NULL conversation until admission; public `initUpload` still
requires an existing owned conversation. Source fields have a unique stage/part
index and immutable-update trigger. All parts must be present before a single
original transaction creates the conversation, completes every artifact, writes
message/run/outbox/event and re-proves the receipt. No accepted message is
rewritten. Original stable rename mapping recovers files moved before rollback.

Expired bytes are fenced and cleaned under original upload ownership. Source
rows remain immutable tombstones so an expired event cannot receive a new
identity. The existing worker maintenance loop runs a bounded cleanup once per
minute when enabled; startup also performs a bounded pass. Live writers and
registered/admitted objects are preserved; blocked files back off for one minute.
No additional executor or recursive workspace deletion is introduced.

Enabling v2 adds `content_protocol` to the original channel-event table and a
protocol-generation witness to the original worker lease. Old authority
validators reject the added event field. Database triggers also prevent an
already-running old reader from inserting/reclaiming a v2 lease without the
matching generation. The actual worker selects support from its recovery and
verified-byte consumer capabilities; unsupported readers skip v2 runs.

`downgradeUnusedChannelAttachmentProtocolV2` is an explicit operator action for
an unused, quiescent protocol only. It refuses retained v2 event or stage data;
it never deletes provenance to make an older binary start. Used deployments
must retain a v2-capable reader or restore an independently verified offline
backup. Unversioned experimental v2 rows are not silently relabeled.

## Initial native consumption

The original worker proves accepted event/message/run and current scope, then
uses the original anonymous pinned byte snapshot. The Official runner uses
`stageVerifiedFile`, not a path reopen or current_version. It checks the original
scope/lease before staging and prompt. All file receipts precede the one prompt;
unknown staging acknowledgements are not retried. Recovery uses original native
input recovery and never resends pinned files. UI refs retain the accepted pins.

Tests use original SQLite/services with synthetic bytes and injected Session
HTTP. They do not establish provider account operation, SDK model understanding,
or production cold recovery. Shared integration and provider consumer closure
remain separately reviewable requirements.
