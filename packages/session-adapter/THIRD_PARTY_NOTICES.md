# Session Adapter licensing notices

Original Jot code is covered by the repository Apache-2.0 LICENSE.

`hooks-config.js`, `hooks-protocol.js` and `hooks-runtime.js` contain portions
adapted from PilotDeck revision `783499ffdb2d501bf590b2e035acd027a882df10`.
The upstream project declares GNU Affero General Public License v3.0.
Its complete license is retained in `runtime-patches/PILOTDECK-AGPL-3.0.txt`.
The source paths are `src/extension/hooks/protocol/`,
`src/extension/hooks/config/` and `src/extension/hooks/execution/`.
Jot adaptations add original Host executor boundaries, bounded protocol data,
identity preservation, output-event matching and owned cancellation/teardown.

DSH-derived compatibility code retains its upstream notices and the MIT license
in `runtime-patches/DSH-MIT-LICENSE.txt`.

`../dsh-host/plan-mode-recovery.mjs` integrates the scoped native plan controller
from `@deepseek-ai/dsh-plan-mode` version `0.2.1-rc.2`. Its compatibility seam
is pinned by `runtime-patches/dsh-plan-mode-0.2.1-rc.2-sha256.json`.
The retained MIT notice applies to the native controller compatibility work.

`native-model-dispatch-guard.js` integrates the original `@deepseek-ai/dsh-llm`
version `0.2.1-rc.2` dispatch lifecycle through an instance compatibility seam.
Its installed source is pinned by `runtime-patches/dsh-llm-0.2.1-rc.2-dispatch-sha256.json`.
The retained MIT notice applies to this native runtime compatibility work.

`compaction-images.js` adapts the media omission approach from PilotDeck
revision `783499ffdb2d501bf590b2e035acd027a882df10`,
`src/context/compaction/stripMultimedia.ts`, to native DSH user/tool messages.
The upstream AGPL-3.0 notice and retained complete license above apply.
Jot retains native message identities and image occurrence references while
leaving original attachments, text and durable Session events intact.

`chat-compaction-engine.js` and `../dsh-host/work-compaction.mjs` consume that
shared transformation through the original native summarization hook.


`dsh-native-search-source-patch.js` (under `packages/session-adapter/` in the repository)
integrates the separately installed MIT-licensed `@deepseek-ai/dsh-tool-fs-search`
0.2.1-rc.2 formatted-result producer. Its reviewed runtime, declarations, locale
and package files are pinned in `runtime-patches/dsh-tool-fs-search-0.2.1-rc.2-sha256.json`
relative to the adapter. The existing retained DSH MIT notice applies. The original
spill backend and opaque locators retain their native meaning. Jot captures a
private bounded producer snapshot and requires the original successful linked
Session result before returning a page. Native grep line-preview limits remain
part of that source scope.


`native-workspace-file-reader.js` integrates the separately installed MIT-licensed
`@deepseek-ai/dsh-api-workspace-files` 0.2.1-rc.2 through its original Typert
Gateway and an explicitly owned Remote Peer. Reads use the original Session
lookup and composed filesystem policy. Canonical path, opaque native version,
reported size and Session/profile identity constrain each bounded byte range.
Actual chunk SHA is separate from native freshness metadata. The retained DSH
MIT notice applies to this integration.


Typed native search members additionally retain the actual native run working
directory and structured paths after the original policy accepts the result.
The optional pinned compatibility delta preserves the original renderer and
spill behavior. Bounded member pages require the final original successful
Session result, its complete rendered-content digest and original result total.
Paths remain data and confer no filesystem authority. Consecutive duplicate
paths are coalesced, with no promise of globally unique files. The retained DSH
MIT notice applies to this integration.


Public typed native search member pages reuse original owned activity/run/Session
bindings and immutable child call/result receipts. Their digests include the
original activity snapshot, native events, typed member source and actual run
directory. Member-selected byte ranges resolve on the Host from that exact typed
member and recheck source provenance around the original owner file reader.
Opaque native file versions and canonical paths remain independent freshness
pins. Whole opened-file retention and public file opening are subsequent work.
The retained DSH MIT notice applies.
