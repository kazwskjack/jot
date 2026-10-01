# Developing Jot

Jot is a lightweight AI bot with a practical application layer: conversations, visible progress, action review and file delivery. The small interface depends on a less visible set of engineering decisions about task identity, execution evidence and recovery.

This account summarizes development lessons in new prose. It intentionally omits deployment details, private infrastructure, credentials, original user messages and identifiable task records. Earlier integration experiments inform the design; they are not test results for this repository's current release.

## What this repository contains

| Area | Included here | Boundary |
| --- | --- | --- |
| Portable Agent | A configurable model adapter, bounded tool loop, worker queue, SQLite state and local tools | A single-user local runtime; it needs a compatible model for real tasks |
| Web interface | Conversation selection, Markdown, stream drafts, task details, theme switching, approvals, uploads and downloads | Uses the portable API; visual samples are explicitly synthetic |
| Extended gateway | Project/conversation ownership, durable runs, event projection, document-job modules and optional display/speech interfaces | Needs separately configured authentication, workers and external services |
| Session adapter | DSH Session integration and optional speech-service connection | The external Session host and its tools are not installed by this package |
| Browser decision research | Documented boundaries for action/target advice, fallback and verified receipts | The active OpenJev/Laya webpage decision service is not bundled |
| pi-inspired runtime ideas | A design discussion of a small loop and clear event/tool boundaries | No pi dependency or executable pi adapter is included |

The portable runtime and extended integrations have separate contracts. A module being present in the source tree does not prove that its external dependencies are available or that an operator has enabled it. See [Agent behavior](agent/README.md), [Integrations](INTEGRATIONS.md) and [Deployment](DEPLOYMENT.md).

## 1. A conversation is not a running process

Early integration work exposed a weakness in treating a one-shot process as the conversation: collect terminal output, wait for exit, then extract an answer. That can produce a reply, but it makes incremental tool progress, reconnects and multi-turn context difficult to represent reliably. An in-process event emitter also cannot notify a different service process by itself.

The engineering choice was to separate three identities:

- A conversation organizes the user's history.
- A run describes one accepted task and its eventual outcome.
- A runtime binding identifies the external engine's context and stays behind the server boundary.

A long-lived planning session may handle many runs. Reusing that session's identifier as a unique execution identifier can therefore collide on the second turn. Stable conversation context and fresh per-run execution identity solve different problems; they should not share a uniqueness constraint accidentally.

The portable release uses its own persisted conversations and runs. The extended Session adapter applies the same distinction when communicating with an external controller. The lesson is to define identity and lifetime before integrating a second engine.

## 2. A disconnected stream is not a cancelled task

Streaming work uncovered two separate failure modes. A normal request-close event was mistaken for an aborted client, stopping a follow stream too early. Another path attempted to write an error response after headers had already been sent. Neither incident was evidence that the underlying Agent had completed its task.

The resulting design treats transport and execution as separate lifecycles:

1. Persist an accepted run before executing it.
2. Persist ordered progress events independently of any particular browser connection.
3. Restore a snapshot, then follow or replay events with deduplication.
4. Classify cancellation from an explicit cancellation command and observed task settlement.
5. Handle a failed streaming response without sending a second HTTP response.

The portable server polls durable events and sends heartbeats. Its interface reconnects and reconstructs the latest run's draft and activity. Restart recovery marks unfinished local runs interrupted instead of automatically resubmitting them. Restoring display state is not the same as safely restarting an external effect.

**Acceptance method:** disconnect a synthetic stream, reconnect, and compare persisted messages and events; verify cancellation separately. A database row alone does not prove that a refreshed interface can display the answer.

## 3. Intermediate model text is not the final answer

An Agent can emit text, request a tool, consume the result and emit another message. Rendering every segment as a completed answer makes one question appear to receive several answers. It also allows an exploratory statement to look like a verified result.

The portable loop commits one final assistant message when the model returns a nonempty answer without further tool calls. The interface labels streaming text as a draft, clears it at tool and subsequent reasoning boundaries, and deduplicates committed messages. Generated artifacts are associated with the originating run and displayed after that run's final answer, rather than whichever answer happens to be last.

**Acceptance method:** use a deterministic provider that emits preliminary text, a tool call and a final response. Check that only the final response is persisted as the answer and that files attach to the correct run. Test two conversations with delayed requests so one conversation's response cannot overwrite the other.

## 4. Approval has to describe one exact operation

A generic “approve this task” switch is too broad for browser clicks and file creation. Approval also becomes ambiguous if an old client response can accidentally approve a later operation in the same run.

The local runtime generates a distinct approval identifier, includes bounded operation details and requires that identifier in the response. The interface displays the operation, disables repeated submissions while waiting and sends the specific identifier back. Decline, expiry and cancellation remain explicit outcomes.

File creation preserves the source and creates a new artifact. The approval includes the proposed name and bounded content preview. Browser actions require a deliberate origin allowlist and an unambiguous target; a page's content cannot grant permission to perform an action.

**Acceptance method:** reject an expired or replayed approval, approve only the current request, cancel during the wait and verify that no later tool action runs. A confidence score from a model is advice, not user approval.

## 5. One click can be successful even when a later wrapper reports failure

Browser integration work revealed a duplicate-execution defect: the first click changed the page, but a second attempt targeted a now-disabled control and returned an error. Looking only at the final error suggested that the button had never worked. Reading the page in a new, unrelated browser context could not establish what happened in the original one.

The important evidence was the original context's action count and resulting page state. The execution path was corrected to perform the chosen action once and retain the actual receipt. The local runtime also validates tool-call identities and avoids blindly replaying ambiguous operations. It does not promise exactly-once external effects across crashes or network failures.

**Acceptance method:** use a controlled page with an observable action counter and a unique result marker. Verify one action and the expected result in the same browser context. If an operation times out after being sent, inspect the existing state before considering a retry.

## 6. URL changes do not capture every page change

Another controlled page changed an ordinary detail section while keeping its URL, title and coarse layout unchanged. A fingerprint based on only an early slice of text missed the change. This caused a real effect to be classified as no effect.

The research implementation incorporated a bounded visible-content digest into the resulting state fingerprint. That preserved useful change evidence without copying page text into diagnostics. The broader lesson is to verify the business result: a changed URL, a returned click call or a stable title is not sufficient on its own.

This richer external evidence system is not implemented by the portable browser tool. That tool provides a smaller operation boundary and page result. Integrations that need stronger verification must supply their own current-page evidence and explicit success conditions.

## 7. Runtime contracts can fail after a task succeeds

An integration once persisted valid browser activity but could not return it in a later snapshot. The event projection had gained fields that the strict response contract did not yet allow. The user's task and the display-restoration failure occurred at different stages.

The solution was a coordinated contract update: name the new fields precisely, constrain enums and array sizes, and update the producer, projection, types and snapshot validation together. Allowing arbitrary unknown fields would have hidden the mismatch instead of fixing it.

The extended gateway includes strict contracts and corresponding tests. The portable API is smaller and has its own schemas; the two APIs should not be treated as interchangeable.

**Acceptance method:** persist a representative activity, restore it through the real snapshot route and confirm that the consumer accepts it. Also verify that unrelated unknown fields remain rejected. Test recovery, not just the initial message submission.

## 8. Batching needs ownership, bounds and an honest completion signal

Batch research explored how to let a planner ask for several reads without expanding the top-level tool surface indiscriminately. The proposed approach kept the planner responsible for the objective and final answer, with a separate operation store recording individual work items.

Several requirements emerged:

- Preserve input order even when duplicate requests share execution.
- Return a compact status/result-reference envelope instead of multiplying full page bodies by the batch size.
- Fetch saved content only when needed, with bounded bytes and explicit truncation metadata.
- Bind operations and result reads to the verified owner; return a uniform not-found response for inaccessible work.
- Record cancellation, stop admitting new work and preserve truthful receipts for work already in flight.
- Use the browser's observed final address and actual page content, rather than treating the requested address or an error page as valid evidence.

Capacity tests, adapter tests and end-to-end task tests answer different questions. Having available browser slots does not establish that the default Agent can invoke the batch interface, recover its results or safely accept arbitrary targets.

The portable release limits simultaneous Agent runs and serializes work within a conversation. It does not bundle the research browser pool or claim batch browser capacity. The extended gateway includes batch contracts/projections that still require an external execution service. [Integrations](INTEGRATIONS.md) describes those boundaries.

## 9. Storage growth starts with admission, not deletion

Storage investigations found that background requests could create unnecessary anonymous identities, frequent activity updates amplified database writes and routine maintenance logs accumulated even when no work happened. Deleting old files alone would not stop that growth.

The engineering response began with the source of writes: separate machine requests from browser identity admission, throttle last-seen updates without extending absolute expiry, and suppress empty maintenance summaries while retaining failures. Measurements distinguish database contents, write-ahead logs, logical file size and allocated disk size. Parent and child directories cannot be added as independent usage.

Maintenance also needs explicit protections. Expired records can be deleted in small transactions with a time budget; deleting rows may make pages reusable without immediately shrinking the database file. Event history cannot be discarded safely while snapshots still depend on it. Generated files cannot be removed solely because they are old if a live task, download or recovery process still references them.

Archive experiments reinforced this point: a provider's hash metadata differed from the original even though sizes matched. Verification required downloading the remote object and comparing actual bytes before releasing the local copy. A corrected download destination also mattered for recovery.

These are maintenance lessons, not a claim that the portable release includes automatic retention or remote archive tooling. Operators must configure their own backup/retention policy and test restoration of the database and artifact files together.

## 10. Fast decision advice must preserve the planning boundary

Browser decision experiments explored selecting an operation and its target in one request, with a second provider as fallback. This can reduce separate decision calls, but it introduces compatibility, permission and evidence requirements.

The planner continued to own the objective and final answer. Advisors proposed only eligible short-range actions; the execution boundary still checked the page, target and permissions. Each provider received a separate request projection so local-only fallback rules could not mutate the cloud provider's request. Failure, abstention or exhausted budget returned control to the planner.

Low-confidence proposals originally disappeared behind a rejection. Exposing a bounded diagnostic containing provider, action, selection score, eligibility threshold and rejection reason made the refusal useful to the planner without authorizing the action. Those model-reported scores are not calibrated success probabilities. Passing the diagnostic through to the final planner is a distinct acceptance check from completing the requested page operation.

The current repository documents this integration and includes optional display-advice interfaces. It does not ship the active webpage decision service or its model weights. Display expression advice is separate from webpage execution: a visual suggestion never grants tool permission.

## 11. Validate the path that users actually take

Stability work used synthetic pages with unique markers, explicit action budgets and observable effects. It deliberately separated fixture correctness, adapter correctness, component execution and a complete conversation-to-browser-to-answer path. A fixture working in an independent browser did not prove that the Agent chain could operate it.

A genuine failure was preserved even after local fixes passed. Further phases stopped at the failed acceptance gate instead of continuing to benchmark a broken path. Later verification also uncovered a stale runtime copy: editing a source file was insufficient when the running profile loaded a separately packaged copy. Build manifests, artifact hashes and runtime checks made that difference visible.

The same discipline applies to this release:

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Deterministic unit/route tests | Local contracts, lifecycle and policy behavior | Real model quality or external-site correctness |
| A production build | The interface can be bundled | Successful browser interaction or mobile rendering |
| A synthetic interface preview | Intended layout and interaction affordances | Real research, model inference or tool completion |
| Controlled browser action plus observed receipt | That specific operation and result | General reliability across arbitrary pages |
| Complete Agent workflow | That configured path on that scenario | A universal speed or accuracy claim |
| Repeated matched benchmark | Measured latency/success for its stated setup | Results for other models, resource limits or workloads |

Historical regression totals and timings are intentionally not reproduced here as release statistics. Tests may overlap, include inherited fixtures or belong to an earlier environment. Consult the checks that can be rerun in this repository and the [benchmark protocol](BENCHMARKS.md); do not substitute historical counts for a fresh release gate.

## Continuing the work

Start with one model, one conversation and one permitted tool. Verify acceptance, approval, cancellation, reconnect, final-message persistence and file restoration before adding workers or another runtime. When adding an adapter, keep its capability declaration honest and its planner authoritative. Measure decision time, tool time and verification time separately before changing concurrency.

The product can remain lightweight while these boundaries stay explicit. That is the useful outcome of the development work: less accidental coupling, clearer failures and results that can be checked.
