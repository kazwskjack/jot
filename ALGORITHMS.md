# Scheduling, state and execution mechanisms

Jot keeps task coordination separate from model output and tool execution. The mechanisms below describe the code in this repository. They do not imply that an external browser pool, decision-model server or Agent runtime is bundled here.

There are two execution paths:

- **Portable runtime:** `src/` is a single-process, local Agent service with a Chat Completions compatible model connection, text artifacts and optional isolated browser actions.
- **Gateway integration:** `packages/gateway/` provides product state, ownership checks, worker coordination and adapters for an externally supplied Agent Session service. Its worker command requires that service and the configured adapters.

## Implementation map

| Mechanism | Portable runtime | Gateway integration |
| --- | --- | --- |
| Worker scheduling | In-memory FIFO queue; default one worker, maximum five | Database-backed claim order and bounded worker slots |
| Conversation coordination | One unfinished request per conversation | Claim excludes conversations with another active run |
| Request deduplication | Conversation + request ID + input comparison | Owner + operation + idempotency key + request hash; message IDs also deduplicate |
| Tool call deduplication | Completed or failed result cached by call ID within one run | Adapter request IDs and product projection cursors; no universal local tool side-effect cache |
| State durability | SQLite, WAL and atomic request admission | SQLite, WAL, transactions and an event/outbox ledger |
| Approval | Unique approval ID, pending request and operation details | Interaction ID, owner, expected version, expiry and action digest |
| Event recovery | Numeric event cursor and persisted snapshot | Per-conversation cursor, explicit expired/future cursor errors and durable operation revisions |
| Worker fencing | Not implemented; one process owns execution | Lease owner, generation and expiry checks before writes |
| Recovery decisions | Model receives safe tool errors; no automatic transport retry | Failure-classification policy function is included; automatic application is not wired in the included worker |
| Execution budget | Bounded model/tool loop and operation timeouts | Bounded batch continuation and optional runner timeout; external runtime budgets remain external |

## 1. Queue scheduling and conversation isolation

The portable Agent accepts a task into a FIFO queue. A task starts only while the number of active tasks is below the configured worker count. Completion releases the slot and starts the next queued task. An approval wait occupies its task's slot; enabling more workers can let other conversations continue while approval is pending.

`JOT_WORKERS` defaults to one and is capped at five. This controls concurrent **Agent runs**, not browser pages within a run. Increasing it does not create a five-by-five browser pool.

Request admission also checks the conversation's unfinished runs inside an immediate transaction. A conversation with a queued, running or approval-waiting request rejects another new request as busy. A retry using the original request ID is handled by deduplication before that busy check.

The gateway runs bounded polling slots. Its coordinator claims queued work in creation order, prioritizing queued rows before reclaiming expired active leases. A queued run cannot be claimed while another run in its conversation is starting, running, waiting or cancelling. This is ordered database scheduling, rather than a guarantee of strict global FIFO completion across processes.

**Source:** [`src/agent.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/agent.mjs), [`src/store.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/store.mjs), [`worker-pool.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/worker-pool.ts), [`coordinator.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/coordinator.ts).

## 2. Idempotent admission and tool-call deduplication

Portable request identity is `(conversation_id, request_id)`. Repeating that identity with the same input returns the recorded run. Reusing it with different input returns a conflict. The database unique constraint and transaction prevent a repeated request from inserting a second user message.

Within an active portable run, a tool call ID is bound to the function name and serialized arguments. A repeated ID returns its recorded result without repeating the tool operation. Failed and uncertain outcomes are recorded too: a click whose result was not confirmed is not retried merely because the same call ID arrives again. Reusing an ID with different arguments returns an error.

This result cache is in memory for that run. It does not promise exactly-once execution across crashes or suppress intentional new calls with different IDs. On restart, unfinished portable runs become interrupted and are not automatically replayed.

The gateway also hashes request material for its HTTP idempotency ledger. The scope includes the owner and operation. A completed duplicate returns its recorded response; changed input conflicts, and an unfinished duplicate reports that it is still in progress. Separate message identities prevent duplicate conversation messages. These admission guarantees do not establish exactly-once behavior for a remote website or delivery provider.

**Source:** [`src/store.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/store.mjs), [`src/agent.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/agent.mjs), [`gateway server`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/server.ts), [`run repository`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/runs/repository.ts).

## 3. WAL and transaction boundaries

Both paths enable SQLite WAL mode and foreign keys. Portable admission commits the run, its user message and admission event together using `BEGIN IMMEDIATE`. A failure rolls back the admission.

The gateway's transaction helper commits state changes or rolls them back. Its event store requires an active transaction when appending an event. Admission writes the message, run, events and an outbox row together. That reduces the risk of accepting a task without a corresponding durable progress record.

WAL allows readers to coexist with a writer. It does not turn SQLite into a distributed database or eliminate its single-writer limitation. The portable runtime also does not wrap every later state mutation and event append in a shared transaction.

**Source:** [`src/store.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/store.mjs), [`database.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/db/database.ts), [`event-store.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/events/event-store.ts), [`repository.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/runs/repository.ts).

## 4. Approval is bound to an operation

The portable runtime generates a new approval ID for each pending operation. Approval responses must include that ID and target the pending run. A late response from an earlier operation cannot approve a later one. Cancellation removes the pending approval; expiration denies it.

Browser approval includes the requested URL, action, unique target selector and complete fill text when applicable. File-write approval records the filename, byte count, SHA-256 and a bounded preview. Tool arguments are copied before requesting approval, so approval does not depend on mutable caller input.

The gateway verifies interaction ownership, pending status, expected version and expiration. Approval decisions must also match the recorded action digest. Resolving an interaction records a command for the associated run. Dispatching every possible external approval command is an adapter integration concern; the included Session dispatcher specifically handles cancel and steer commands.

Neither approval mechanism authorizes unrelated future actions. An approval ID is also not a replacement for authentication.

**Source:** [`src/agent.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/agent.mjs), [`src/tools.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/tools.mjs), [`src/server.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/server.mjs), [`interaction service`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/interactions/service.ts), [`Session dispatcher`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/command-dispatcher.ts).

## 5. Cursor-based progress and settled answers

Portable events carry a monotonically increasing database sequence. A viewer requests events after its last cursor and can recover messages, runs, approvals and artifacts from the persisted snapshot. SSE polling sends bounded batches and disconnects a client with excessive buffered output. Service shutdown terminates open streams.

The gateway allocates event sequences per conversation. Replay rejects cursors in the future or older than retained history, allowing a caller to request a fresh snapshot instead of silently assuming that nothing happened. Native web-operation snapshots are checked against the session binding and revision cursor before being projected into product activities.

The Session runner chooses a live or durable assistant stream source rather than publishing both as duplicated output. It accumulates settled assistant content and checks the official turn-completion event. Final answers and artifact links are product publication steps, distinct from intermediate tool progress.

These mechanisms provide replayable state. They do not guarantee that every upstream external service retains events indefinitely.

**Source:** [`src/store.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/store.mjs), [`src/server.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/server.mjs), [`event-store.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/events/event-store.ts), [`coordinator.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/coordinator.ts), [`official-session-runner.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/official-session-runner.ts).

## 6. Failure classification and bounded recovery

The portable provider decodes streamed UTF-8 incrementally and assembles fragmented tool arguments. It rejects incomplete streams, truncated output, filtered output and incomplete tool calls. A failed provider request cannot commit a successful final assistant message. Dependency exceptions are reduced to safe reason codes before persistence.

Browser click and fill operations require the current page URL to match the approved operation. They do not navigate back to an old URL to repeat a submission. An uncertain click is reported as uncertain. The Agent instruction requires inspection and user clarification before repetition; it is not proof that a remote server rolled back the action.

The gateway includes a classification function that can return continue, wait, switch tool, ask user or stop. It compares failure class, reason and call fingerprint; a history containing three matching failures causes a stop decision. Temporary waits must fit an attempt budget and a remaining-time bound. External actions require user intervention.

This function currently has no caller in the included worker. Its decision rules are available for integration, not a claim that automatic retries or tool switching are enabled. Other included polling loops and adapters have their own behavior and should not be described as governed by that policy.

**Source:** [`src/provider.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/provider.mjs), [`src/agent.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/agent.mjs), [`src/tools.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/tools.mjs), [`decision-policy.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/decision-policy.ts).

## 7. Hashes, versions and artifact evidence

Portable file writes create a new artifact instead of overwriting an original. Each generated artifact is associated with its conversation and run. The approval digest identifies the proposed content; it is not a cryptographic signature or a guarantee of semantic correctness. Reads and downloads resolve the file path and reject paths outside the artifact root.

The gateway includes version-and-hash checks for file jobs. A job's base version and base SHA-256 must match the stored artifact version. Request hashes detect conflicting idempotency-key reuse. Registered templates verify their file hash before use, and the archive service checks uploaded bytes before treating a backup as verified.

Hash equality verifies byte identity. It does not verify the factual correctness of generated prose or a document's visual quality. Rendering and file-engine execution require their configured supporting adapters.

**Source:** [`src/tools.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/tools.mjs), [`src/store.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/store.mjs), [`file jobs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/file-engine/jobs.ts), [`templates`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/file-engine/templates.ts), [`archive service`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/artifacts/archive-service.ts).

## 8. Cancellation and lease fencing

Portable cancellation removes queued tasks before execution or aborts the active task's model/tool signal. An aborted run does not publish a successful final answer. Cancellation is cooperative: a remote side effect that already occurred may need reconciliation. Restart marks unfinished runs interrupted rather than replaying browser actions.

Gateway workers claim a lease with an owner, generation and expiration. Publication and progress writes check all three. A reclaimed run receives a new generation, preventing an earlier worker from committing stale results through the coordinator.

Cancel commands take priority over steer commands in the included dispatcher. An active cancellation enters a cancelling state, and the dispatcher waits for the Session adapter's settled cancellation receipt before marking it cancelled. Workers check cancellation before final publication. Steering can add input to a ready active Session; after a terminal run, it can become a new queued request.

Fencing protects product state writes. It cannot undo an external action or guarantee that every external adapter applies the same generation checks.

**Source:** [`src/agent.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/agent.mjs), [`src/store.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/store.mjs), [`run commands`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/runs/commands.ts), [`coordinator.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/coordinator.ts), [`worker.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/worker.ts), [`command-dispatcher.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/command-dispatcher.ts).

## 9. Model and operation budgets

The portable Agent defaults to twelve model/tool rounds and caps the configured round count at fifty. Provider calls have a two-minute timeout. Page and search requests have operation timeouts, and approval waits expire after at most five minutes. Model output and tool-argument lengths are bounded. A worker limit bounds simultaneous calls across conversations.

These are execution guards, not a monetary budget. The portable runtime does not currently count model tokens, enforce a spending limit or compact long conversation history. Multiple rounds and approval waits can make a complete run substantially longer than one provider timeout.

The gateway Session runner bounds automatic continuation of an already-started batch, with a default of eight continuations and a maximum of sixteen. A continuation polls the existing batch rather than starting it again. The runner accepts an optional total timeout, but the included worker entry point does not set one. Model-token, context and cost policies belong to the external Agent runtime unless additional integration is supplied.

**Source:** [`src/agent.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/agent.mjs), [`src/provider.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/provider.mjs), [`src/tools.mjs`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/src/tools.mjs), [`official-session-runner.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/official-session-runner.ts), [`worker entry point`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/main.ts).

## Optional decision and multi-Agent integrations

The gateway's `EmotionAdvisor` supports an optional OpenJev-first display suggestion with a configured Laya fallback. It validates the allowed expression IDs, uses short timeouts, bounds concurrent suggestions and caches them briefly. This is presentation advice only; it does not select browser targets or bypass approvals.

The gateway recognizes subagent activity in progress projections. The repository does not contain a complete multi-Agent delegation engine or a pi-agent fork. An external Agent Session may supply those capabilities, but they need explicit adapter contracts and independent verification before being advertised as bundled functionality.

Likewise, a shared browser pool with numbered slots, per-origin throttling, tab leasing, priority scheduling or cross-Agent evidence sharing is an extension design. The included batch service records external batch progress and ownership; it is not the browser-pool executor. Configuring five Agent workers is not evidence that twenty-five pages execute concurrently.

Suggested extensions should preserve the same boundaries: one planner owns the task goal, executors return verifiable results, advisory decision models cannot override permissions, and state publication rejects stale ownership or generation.

**Source:** [`emotion-advisor.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/emotion-advisor.ts), [`session-event-projector.ts`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/harness/session-event-projector.ts), [`batch projection service`](https://github.com/kazwskjack/jot/blob/feat/standalone-agent/packages/gateway/src/crawl-batch/service.ts).

## Verification scope

Portable regression tests cover admission isolation, idempotency, worker limits, cancellation, approval identity, streamed UTF-8, incomplete output, tool-call replay, artifact access and SSE shutdown. Browser boundary tests use a controlled injected browser implementation; they are not a real-site acceptance report. Gateway tests exercise its included contracts and repositories separately.

A deployment should additionally verify its configured model provider, optional browser installation and any external Session, file, archive, delivery or decision adapters. Passing a local unit test does not establish those external services' availability, performance or safety.
