# Independent reply assessment

The optional judge evaluates an existing bounded-reply draft against its saved
sources and user-defined direction. DSH keeps planning and final-answer authority.
The judge cannot choose recipients, invoke tools, open another session or send.
Host dispatch remains off by default, and its public execution capability remains
disabled pending full deployment acceptance.

## Host configuration

`GENERAL_AGENT_TASK_REPLY_JUDGE_FILE` points to a private JSON configuration file.
Blank means disabled and does not read configuration or credentials. Use
[`config-examples/reply-judge.json`](config-examples/reply-judge.json) as a shape
example; its endpoint and model are placeholders. Keep the real file and key
outside the checkout and use restricted operating-system access.

The configured provider/model pair must match a token-metered route in the
existing model-budget policy. Preserve root scope bindings, balances and pricing
revisions. Call-quota-only emotion routes are insufficient. Configure actual
context capacity, output limits and input/output/cache rates for your provider;
example values are not verified model limits. `api_key_file` accepts an absolute
Windows or Unix path to a regular UTF-8 file, limited to 4096 bytes. A final newline
is permitted; spaces and control characters inside the key are rejected.

The endpoint must end in `/v1`, use HTTPS (HTTP is allowed only on loopback), and
contain no URL credentials, query or fragment. Requests use Chat Completions with
JSON output and no tools. Redirects are refused. `timeout_ms` is 1000–120000.
An optional `response_model_ids` list permits explicit provider model aliases;
otherwise the returned model must exactly match the configured model.

## Input and accounting requirements

`max_input_bytes` bounds the complete serialized request, including the draft,
directions, all source results and response schema. Oversized requests fail before
claiming or charging a model attempt. No evidence is sliced to fit. This byte
ceiling does **not** prove tokenizer or chat-framing compatibility: calibrate the
provider's real context limit before deployment. Each saved source is limited to
256 KiB and the occurrence to 1 MiB; missing, unsupported, oversized or explicitly
truncated source results cannot authorize a reply.

Responses are bounded to 256 KiB, with at most 64 KiB of assessment JSON. A single
assistant choice must finish with `stop`, without refusal or tool calls. Invalid
content is blocked while valid reported usage remains charged. The current
normalizer defaults to requiring explicit prompt, completion and total counts, and explicit
`prompt_tokens_details.cached_tokens` **and** `cache_write_tokens`. Reasoning
tokens, when provided, are included in completion tokens rather than added again.
Cache counts are subtracted from prompt tokens before recording uncached input.
Missing or inconsistent counts retain an unknown hold. The official
[Chat Completions definition](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
makes cache-write reporting optional; absence does not establish zero writes.

The host may explicitly configure `cache_write_policy: "input-rate-equivalent"`
when the selected route has exactly equal input and cache-write rates. An omitted
write count then remains inside the input accounting bucket. Its separate write
bucket is zero because it is folded into input, not because the provider reported
zero writes. This preserves the same token total and charge for every possible
write count under those equal rates. Reported writes are still split normally.
Unequal rates reject this configuration before secret access. Missing cached-read
counts, invalid/null write counts and inconsistent totals remain unknown.
The default `cache_write_policy: "explicit"` preserves strict reporting.
Neither mode establishes actual provider prices or production readiness.

## Runtime and recovery

The existing authenticated `tasks.reply_draft` tool first commits its immutable
draft receipt. Only then does it await the configured host assessment outside the
database transaction, under the original worker lease and root budget. It returns
`reply_check` alongside the draft. Review mode continues to use human approval and
does not invoke the judge. This adds no MCP tool or second planner.

One durable attempt is claimed per draft. After the provider responds, the host
captures the bounded assessment and its normalized usage in an immutable response
journal before settlement. Finalization consumes that same captured value. A
settled assessment replays without another provider call. Pending or unknown
attempts are not automatically retried after restart. A saved response can repair
settlement or final-check storage failure; a lost response or missing usage cannot
be invented. Revocation keeps incurred usage but cannot save an eligible result.

Host-only `eligibility` reads one database snapshot and rechecks authority, exact
draft/input/source digests, assessment coverage and the original settled budget
receipt. Removed evidence, revoked authority or damaged records cannot reuse an
old approval. This check is now used by the existing send gate and provider-worker
authorization. The host dispatcher scans eligible autonomous assessments alongside
committed human approvals behind `GENERAL_AGENT_TASK_REPLY_EXECUTION=1`; no second
provider queue is introduced. Quiet hours and owner/target attempt limits still
apply. Conversation replies are projected once as completed assistant messages
without a planner run; external replies use the existing outbox and are checked
again before provider access. Merely reading reply history never dispatches.

History distinguishes waiting dispatch, actual projection/delivery, rejected
content and a retained pending/unknown assessment. Explicit host recovery from a
captured response is available below. A response lost before journaling, missing
provider usage, real provider quality and full deployment acceptance still need
separate evidence. A queued message is not a delivery receipt. Keep the host flag
off until those checks pass.

## Inspect and reconcile an existing attempt

Run from the gateway package with access to the existing private SQLite database:

```text
node src/persistent-tasks/reply-reconcile-main.ts inspect DATABASE OWNER DRAFT_ID
node src/persistent-tasks/reply-reconcile-main.ts recover DATABASE OWNER DRAFT_ID
```

Node 24 can run these TypeScript sources directly. The compiled equivalents are
under `dist/persistent-tasks/`. Use an existing regular database file; symlink
targets are rejected. `inspect` opens SQLite read-only and reports only whether a
response was saved and the check/accounting state. It neither settles nor sends.
`recover` is an explicit privileged host action, with no HTTP/MCP approval API.
It reads the original owned response, validates its digests and attempt binding,
settles the original frozen route/rates, and checks current permissions and exact
sources before restoring the check. It does not accept new model output, usage,
recipients or pricing arguments and makes no network requests.

Accounting commits separately from final authority checks, so a later guard or
source failure cannot erase confirmed incurred usage. Recovery inside another
database transaction is refused. Replay does not charge again. Missing responses
stay unavailable and incomplete usage retains the unknown hold. No provider call
is retried. CLI output omits the draft text, sources, assessment and credential
content. A restored eligible fact may be picked up by an **already explicitly
enabled** host dispatcher; recovery itself does not dispatch. Retain these private
journals under the product's storage policy, never in a published repository.

Local tests cover isolated HTTP transport, authenticated tool/lease wiring,
budgeted fixtures, durable replay and corruption/revocation. They do not establish
real model accuracy, recipient delivery or production readiness.
