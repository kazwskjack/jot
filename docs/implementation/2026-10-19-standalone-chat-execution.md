# Standalone Chat execution

The portable `/api` server now executes an explicitly configured Chat route
through its own Agent. It does not dispatch to the extended Gateway or claim
the native SDK's Search/Fetch or Session behavior. Work execution, operation
approval, file delivery and browser permissions retain their original path.

## Operator configuration

Configure the root environment privately:

| Setting | Meaning |
| --- | --- |
| `JOT_CHAT_ENABLED` | `false` by default; exact `true` opts in |
| `JOT_CHAT_THINKING_DISABLED_SUPPORTED` | Operator confirmation that this provider supports the request below; exact `true` required |
| `JOT_CHAT_MODEL_URL` | Separate Chat Completions base URL |
| `JOT_CHAT_MODEL` | Fixed fast model for Chat |
| `JOT_CHAT_MODEL_KEY` | Optional private credential, never returned in capabilities or stored policy |

The provider must support streamed tool calls, `thinking:{type:"disabled"}` and
`stream_options:{include_usage:true}`. These options are sent on actual Chat
requests; no `reasoning_effort` option or Work fallback is added. Invalid enabled
configuration fails at startup. Demo mode remains synthetic and Chat-unavailable.
Capabilities reflect configured support, not a connectivity probe or a promise
that every compatible-looking provider implements these options correctly.

An explicit Chat creation or switch is accepted only with that route. New
mode-aware clients can follow the advertised default; legacy creation without
mode still creates Work. No background polling sends model requests. The root
React mode controls remain a separate integration step; the already published
extended React controls use their own API and are not silently reused here.

## Fixed policy and context

Acceptance stores the nonsecret model/thinking/prompt/context policy and a route
digest, together with an ordered immutable text seed. The route digest excludes
the key, allowing credential rotation without changing model identity. A changed
model/endpoint policy refuses the accepted run before inference. The model never
selects its own route from browser parameters.

The seed selects at most 12 recent user/assistant messages, 14,000 characters in
total, with per-message limits of 4,000 user and 2,400 assistant characters.
Source IDs, source hashes, ordering and truncation markers remain in the private
record; original messages are unchanged. Tool/reasoning rows and full Work history
are not copied. A bounded owned artifact manifest permits the existing text-only
`file_read` capability. This route does not interpret images.

The first system instruction is stable and contains no timestamp, request ID or
dynamic history. Model-visible tool results additionally share a 24,000-character
selection budget with at most 4,000 characters per result, explicit truncation
where space permits, and empty content once exhausted. Original bounded tool
receipts remain stored independently. These are context selection bounds, not a
token billing limit or deletion of conversation history. There is no foreground
compression or background summary model in this standalone executor.
Intermediate assistant/tool-call envelopes additionally share a 32,000-character
context bound. Oversized model output fails before tool dispatch or another
inference request; it cannot silently feed a huge generated argument back into
the model. Final answer text retains the original output handling.

## Read-only tools and uncertain outcomes

Only configured `search`, allowlisted `read_page` and owned text `file_read`
schemas are offered. A model returning browser actions or writes receives a
denial; it cannot call Work tools or the approval mechanism through Chat.

Each accepted run owns one search group and one page-read group. Groups contain
at most 64 calls. Their immutable manifest and per-call reservations commit in
SQLite before any request begins. Independent calls in a group run concurrently
and are drained before the next model step. Repeated URLs differing only by
fragment do not repeat a read. A repeated exact call returns its recorded result;
a reused ID with different arguments/tool is refused. A new group after allowance
consumption is refused. Reserved calls with no result remain unknown, including
after disk reopen; they never become new dispatch permission.

Consumed Web schemas are removed from later requests. Stored results feed a
direct summary; failed or uncertain read outcomes do not replenish allowances.
Original cancellation aborts and drains owned work and cannot publish a completed
answer from partial streamed text. Server startup retains the original behavior
of interrupting unfinished runs, rather than automatically replaying provider or
tool effects. Exact accepted-input retries recover the original run even after
Chat is disabled, with no additional model request.

Each model request reserves a per-run step before dispatch. Its completion,
failure/cancellation and valid returned usage counters are retained. Missing or
invalid usage is `null`, not zero. Cache counters are passed through only when
actually reported. These records are not provider billing reconciliation or
proof of monetary settlement; no cost or cache-hit rate is invented.

## Executed verification and open gates

Ten focused tests cover configuration/key separation, frozen ordered context,
concurrent read-only groups and denied writes, duplicate/reused call IDs, persistent
unknown reservations, model-visible tool text bounds with separate receipts,
cancelled partial output, changed-route refusal, oversized intermediate context,
unknown usage and actual local HTTP streaming.
The local streaming endpoint receives two Chat requests with the configured
model, thinking disabled and identical first system prefixes; two answers commit
and no Work provider call occurs. A disk reopen with Chat disabled recovers the
original accepted input without a third request. Usage/cache numbers in that
test are explicitly scripted transport fixtures, not a live cache benchmark.

The complete root suite passes 64 tests with no skips and the Windows local build
passes. Extended Gateway/Host runtime code is unchanged. Standalone React/API/model
browser acceptance, external-provider compatibility and latency/cache measurement,
and the complete parent capability ledger remain open. This increment does not
activate a production deployment or complete universal Chat/Work support.
