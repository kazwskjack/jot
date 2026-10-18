# Portable Chat and Work execution

Status: integration design; native model policy and original-run Session binding prerequisites are implemented, but the complete mode capability is not. This preserves the already requested product behavior while adapting it to the public runtime's current authority contracts.

## Product behavior

New conversations created by a Chat-capable UI start in Chat. A single visible mode label toggles between Chat and Work without replacing the conversation interface. Chat hides model/effort controls and uses the operator-configured fast model with thinking disabled. Work retains its supported model controls, native planning, tools, permissions, steering and Goal behavior. Existing stored conversations migrate as Work; older clients without a mode field retain their existing contract. Missing Chat runtime support must be exposed as unavailable rather than silently running Work with a Chat label.

Chat supplies a direct, useful answer from its knowledge and the available evidence. It may use the official Search/Fetch facilities when freshness or uncertainty requires them. At most one parallel search group and one parallel fetch group are allowed per native turn, with no automatic second attempt of the same failed URL. These limits must survive cancellation, cold recovery and process restart; user steering must not reset them inside the same turn. It must not invent search results, claim a file was generated, or promise a download without an actual producing run and artifact.

Chat performs no foreground context compression. When needed, compaction may run after the committed answer, remains absent from the Chat activity display and yields to new input. Actual model usage, including background attempts, remains accounted. Work retains visible official compaction events. A fixed prompt/tool prefix avoids timestamps, random identifiers and dynamic history before shared instructions; actual provider cache usage, not a local hash, proves a cache hit. No periodic model traffic is required for this feature.

## Design baseline and implemented prerequisites

The source findings below were the starting baseline. Native model selection
and the catalog have since been connected through the [model policy increment](../../implementation/2026-10-18-native-model-policy.md).
The [original-run Session binding increment](../../implementation/2026-10-18-original-run-session-binding.md)
also replaces ordinary execution/recovery consumers of the mutable pointer.
Separate mode mappings and the remaining Work-only readers are still open;
these prerequisites do not establish fast Chat support.

- `web/jot/RoleConversation.tsx` updates ordinary model metadata through the existing versioned conversation PATCH. Role selectors remain read-only.
- `packages/gateway/src/conversations/repository.ts` persists that metadata. Its queued-run exclusion was incomplete; the new pending-model regression demonstrates the gap and the accompanying fix includes queued execution and transactional validation.
- `packages/gateway/src/server.ts` currently returns `models: []` in capabilities. A model menu component is not evidence of a live model catalog or an actual inference route; both need host-backed integration.
- `packages/gateway/src/harness/worker.ts` constructs `DshRunInput`; this interface currently carries execution identity and attachments, but no conversation mode/model policy.
- `packages/gateway/src/harness/session-controller-client.ts` creates native Sessions and sends original admitted inputs. Its existing protocol cannot be assumed to carry a Chat policy.
- `packages/session-adapter/budget-model-selection.js` selects a trusted host-configured workbench route. It does not prove that an ordinary UI model choice reaches native inference.
- `packages/session-adapter/ordinary-claimed-composer.js` restores the exact original unpublished Session factory, pending inputs, replay profile and attachments. Replacing this adapter with an older application implementation would lose these invariants.
- `packages/dsh-host/standard-preset.mjs` derives the Work declaration from the installed official preset. Chat needs its own reviewed declaration and actual capability checks; changing the Work child list is not a shortcut.

## Execution boundary

Gateway remains the authority for owner, conversation, accepted input, run, execution lease, version and immutable delivery. DSH remains the planner and executes native Sessions. A mode or model name supplied by a page or tool output never grants an execution capability.

At acceptance, freeze a versioned run policy containing mode, conversation version, provider/model identity, effort/thinking policy, preset revision and context policy revision. The server chooses Chat's route from its trusted configuration. A model selection must resolve through the official SDK and match the approved identity; unknown or incompatible settings fail before native input acceptance. Never substitute a fallback route without an explicit operator policy and actual attempt accounting.

The official SDK treats its model catalog as advisory, not an execution whitelist. Publish detached nonsecret provider/model/reasoning metadata through authenticated capabilities, while preserving exact provider resolution for an operator-permitted model absent from the catalog. Pass cancellation to asynchronous resolution. Use the model's actual supported reasoning identifiers rather than translating every provider to an assumed low/high pair.

Changes to conversation mode/model are refused while any run is queued, starting, running, waiting for the user/approval or cancelling, or while its relevant native control outcome is unknown. Version validation, pending-run checks and the metadata write occur in one synchronous database transaction. Renaming or pinning remains possible when allowed by the existing metadata rules.

Track native Session identity per mode and bind every admitted run to its exact native Session and frozen policy. Do not rewrite the existing conversation binding and then use it to recover an older run. Original input, steering, history observation, final publication, Goal controls and cancellation must resolve the original run binding. Existing native Goals remain attached to Work; a switch cannot wake, transfer, complete or erase one. An active or unconfirmed Goal blocks a conflicting switch until its original pause/stop outcome is reconciled.

## Lightweight context

Chat starts from a fresh mode-specific Session with a bounded, ordered text seed: initially no more than 12 recent user/assistant messages and 14,000 characters total, with 4,000/2,400 characters per user/assistant message. These are context selection bounds, not a token billing cap or loss of stored history. Exclude raw reasoning, repeated tool bodies, full Work transcripts and inline image bytes. Keep source message IDs, ordering, truncation markers and context revision so recovery can prove the exact seed. Full original history remains accessible through the existing owned history flow.

Attachments keep their owned version, producing run and download authority. Image interpretation remains on demand and requires an actually supported visual path; screenshot metadata is not an image the model has seen. Never silently discard an attachment or describe its contents without evidence. Archive a recognized image as its result plus source/version linkage, preserving original bytes under the normal retention policy.

## Recovery and verification

Persist turn allowance consumption before effects; use original operation/request identities to observe uncertain Search/Fetch outcomes rather than replaying them. Model callbacks and final answers keep the existing immutable attempt and message rules. Retry the same accepted policy, Session and context seed after interruption. Expired authority or a changed replay profile refuses execution. Background compaction may not consume a foreground lease or publish another answer.

Actual installed-SDK tests must observe selected provider/model/thinking options, permitted tools, native Session identity, no duplicate prompts, and the original committed answer across steering and cold recovery. Local scripted providers can prove protocol behavior; physical devices, external search quality and live latency require separately configured provider acceptance. No universal latency claim follows from fixture timing.

The standalone `src/` server and the extended Gateway are distinct. Both need explicit implementation and tests before the public feature matrix claims universal Chat support.
