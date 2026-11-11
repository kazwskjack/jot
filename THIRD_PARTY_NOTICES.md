# Dependency notices

Jot's original source and documentation use the repository Apache-2.0 license.
This changes the current Jot licensing declaration; previously published MIT
snapshots retain their original terms. Their notice is preserved at
`licenses/JOT-LEGACY-MIT.txt`. Third-party software retains its own license and
authorship, including the attributed MIT DSH replay code and compatibility
patches. No complete third-party Agent runtime distribution, model weights or
private browser profiles are vendored here.

`BRAIN.md`, its CLI-generated project scaffolding and the marked Agent guidance
originate from [mindmuxai/brain.md](https://github.com/mindmuxai/brain.md),
version 0.3.0, Apache-2.0. Project-specific page bodies have been adapted for
Jot. The upstream license is retained at
`licenses/BRAIN-MD-APACHE-2.0.txt`; the local CLI is a pinned development
dependency. These files are not represented as an original Jot protocol.

The separately evaluated `haitang1/dsh-memory` 0.5.0 extraction plugin is MIT
software. It is not vendored or automatically installed by this release.
Its local initialization tests do not imply production activation; see
`MEMORY-AUTOMATION.md` for the integration boundary.

The optional `packages/session-adapter/dsh-pre-setup-patch.js` contains small
matching anchors and a compatibility delta for the separately installed
`@deepseek-ai/dsh-agent-loop` 0.2.0-rc.2 MIT distribution. Its upstream notice is
retained in `packages/session-adapter/runtime-patches/DSH-MIT-LICENSE.txt`.
The preparation tool copies that separately installed package, including its
license, into a new operator-selected directory. This delta is maintained by
Jot; it is not an API shipped or endorsed by the upstream project.

Direct installed package manifests report:

| Dependency | License |
| --- | --- |
| Fastify, React, React DOM | MIT |
| react-markdown, remark-gfm | MIT |
| Vite, @vitejs/plugin-react | MIT |
| @fastify/multipart, AJV, ajv-formats | MIT |
| TypeScript | Apache-2.0 |
| Playwright | Apache-2.0 |

The lockfiles identify transitive dependencies. Their package distributions contain their respective license files; retain those notices when redistributing dependencies. Optional DSH/Cordis, speech, office, model and decision services are installed separately and remain subject to their own terms. Browser binaries, Python and LibreOffice also have separate distribution licenses.

Original explanations of a technology choice do not claim authorship of that technology. A named adapter is not a bundled model or an endorsement by its upstream maintainer.

## Twemoji v17.0.3 and parser

Jot bundles the unmodified Twemoji v17.0.3 SVG artwork from `web/public/twemoji/svg/` (4,009 files), from the official [v17.0.3 release](https://github.com/jdecked/twemoji/releases/tag/v17.0.3). The graphics are licensed under CC BY 4.0; the complete license and attribution are in `web/public/twemoji/LICENSE-GRAPHICS` and `web/public/twemoji/NOTICE.md`. The repository MIT notice is retained at `web/public/twemoji/LICENSE`.

The Unicode matcher is adapted from the official `@twemoji/parser` 17.0.2 package, pinned by Twemoji API 17.0.3. The CommonJS parser was converted to ESM and its asset URL defaults to local SVG files; no npm dependency or runtime CDN access was added. The complete MIT license is at `web/jot/vendor/LICENSE.twemoji-parser.md`.

## PilotDeck Hook integration

`packages/session-adapter/hooks-config.js`, `hooks-protocol.js` and
`hooks-runtime.js` contain adapted portions of PilotDeck revision
`783499ffdb2d501bf590b2e035acd027a882df10`. The upstream project declares GNU
Affero General Public License v3.0. The complete upstream license is retained
at `packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt`.
The corresponding Adapter package notice identifies the source directories and
Jot adaptations. These files retain the separately applicable upstream terms.

## PilotDeck project-internal Git ignore rule

`initializationInternalIgnore` in
`packages/gateway/src/git/initialization-records.ts` adapts the internal-ignore
rule from `src/pilot/paths.ts` at PilotDeck revision
`783499ffdb2d501bf590b2e035acd027a882df10`. Those adapted portions retain
upstream GNU Affero General Public License v3.0 terms. The complete upstream
license is retained at
`packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt`.
Jot preserves the original byte prefix and caps the resulting file at 1 MiB.

## PilotDeck assistant reply selection

`web/jot/AssistantReplyQuote.tsx` adapts selection capture and quote context
behavior from `ui/src/components/chat-v2/AssistantReplyQuoteAction.tsx` and
`ui/src/types/assistantReplyReference.ts` at PilotDeck revision
`783499ffdb2d501bf590b2e035acd027a882df10`. Adapted portions retain upstream
GNU Affero General Public License v3.0 terms. The complete upstream license
is retained at `packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt`.
Jot binds snapshots to its original conversation/message identities and text
submission receipts, with local quote preview and removal.

## PilotDeck conversation history search

`web/jot/ConversationHistorySearch.tsx` adapts search navigation and IME event
handling from `ui/src/components/chat-v2/ChatHistorySearchBar.tsx` and
`ui/src/components/chat-v2/useChatHistorySearch.ts` at PilotDeck revision
`783499ffdb2d501bf590b2e035acd027a882df10`. Adapted portions retain upstream
GNU Affero General Public License v3.0 terms. The complete upstream license
is retained at `packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt`.
Jot binds history loading to its original authorized message pagination and
uses non-mutating browser range highlights with visible message/snippet fallback.

## PilotDeck activity timeline presentation

`web/jot/ActivityTimeline.tsx` adapts phase grouping and expandable nested tool
history behavior from `ui/src/components/chat-v2/AgentTimeline.tsx` and
`ui/src/components/chat/tools/components/SubagentContainer.tsx` at PilotDeck
revision `783499ffdb2d501bf590b2e035acd027a882df10`. Adapted portions retain
upstream GNU Affero General Public License v3.0 terms. The complete upstream
license is retained at `packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt`.
Jot uses its original public activity/run identities and typed detail fields,
with missing/cyclic-parent handling and bounded step pages.

## PDF.js

The original fixed-file PDF viewer uses Mozilla PDF.js through the pinned
`pdfjs-dist` 6.1.200 package. PDF.js is Apache-2.0 licensed. Its upstream
license is preserved at `licenses/PDFJS-APACHE-2.0.txt`. The worker, CMaps,
standard fonts and WebAssembly assets are distributed with their package
notices. Optional native canvas packages retain their own package licenses.

## PilotDeck PDF outline and search

`web/jot/vendor/pilotdeck-pdf-outline.ts` and
`web/jot/vendor/pilotdeck-pdf-search.ts` adapt
`ui/src/components/code-editor/utils/pdfOutline.ts` and `pdfSearch.ts` from
PilotDeck revision `783499ffdb2d501bf590b2e035acd027a882df10`.
These files retain the upstream GNU Affero General Public License v3.0 terms.
The complete license is retained at
`packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt`.

`web/jot/vendor/pilotdeck-pdf-thumbnail.tsx` also adapts `PdfThumbnail` from
`ui/src/components/code-editor/view/subcomponents/PdfDocumentPreview.tsx` at
that same PilotDeck revision and retains the same GNU AGPL v3 terms. Jot adds
windowed thumbnail navigation, intrinsic rotation and resource cleanup.

## PilotDeck PDF text references

`web/jot/vendor/pilotdeck-content-reference.ts` extracts and adapts the used
text/region-reference schema and creation helpers from `ui/src/types/contentReference.ts`
at PilotDeck revision `783499ffdb2d501bf590b2e035acd027a882df10`.
The adapted portions retain GNU AGPL v3 terms under the complete license at
`packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt`.
`web/jot/PdfFileTextReferenceAction.tsx` and `FileTextReferences.tsx` reuse the
selection/review lifecycle of Jot's already-attributed `AssistantReplyQuote.tsx`
and retain its applicable terms.

`web/jot/PdfFileRegionReference.tsx` adapts rectangle selection and crop mapping
from `ui/src/components/code-editor/view/subcomponents/RegionSelectionOverlay.tsx`
at the same PilotDeck revision and retains GNU AGPL v3 terms. Jot crops its
completed PDF canvas directly and connects the PNG to its existing reviewed
upload/attachment lifecycle.


## Native DSH terminal metadata integration

`packages/session-adapter/index.js` reads the existing `terminalController.list`
API from `@deepseek-ai/dsh-api-terminal-controller` version `0.2.1-rc.2`.
The native package retains its MIT license. The complete DSH MIT notice is
retained at `packages/session-adapter/runtime-patches/DSH-MIT-LICENSE.txt`.
Jot's terminal inventory projection, owned conversation route and metadata
panel integrate this API through its published Session-owned metadata contract.
The PilotDeck shell hook and mobile shortcuts at pinned revision
`783499ffdb2d501bf590b2e035acd027a882df10` inform the remaining interactive scope.

The same native terminal integration also uses `environment`, `shells`, `create`
and `close` through published `0.2.1-rc.2` APIs. Host-instance binding and Jot's
original Gateway idempotency receipts preserve explicit user command identity.

Terminal receipt recovery observes the exact original native operation result.
It retains bounded Host metadata snapshots and reuses Jot's original Gateway
idempotency reservation, without invoking another native terminal operation.

Ending a terminal-command wait persists an original Jot metadata receipt and
prevents later dispatch of that exact original request. Native already-issued
operations retain their own lifecycle and completion observations.

The native PTY attachment transport uses the installed `0.2.1-rc.2` public
`connection.createPeer`, `typertGateway.stream`, `TerminalController.retain`
and original `terminal/attach` APIs. The Peer is created by trusted Host code
only after its original bound owner and exact resident Session are verified.
Native input ownership, screen recovery, provider acknowledgements and process
lifetime remain with DSH. The retained DSH MIT license above applies.

## Browser terminal distributions and upstream interaction design

`web/public/terminal-preview/` retains xterm.js 5.5.0, addon-fit 0.11.0,
addon-web-links 0.11.0 and addon-webgl 0.19.0 from the existing upstream-installed
distributions. Each package's full MIT license is included alongside its assets.
`SOURCES.json` records the exact versions, source paths and SHA-256 digests.

`web/jot/NativeTerminalView.tsx` adapts the terminal rendering, selection,
clipboard, fit, link and mobile-key interactions from PilotDeck's
`ui/src/components/shell/hooks/useShellTerminal.ts`,
`ui/src/components/shell/constants/constants.ts` and
`ui/src/components/shell/view/subcomponents/TerminalShortcutsPanel.tsx` at
revision `783499ffdb2d501bf590b2e035acd027a882df10`.
These adapted portions retain GNU AGPL v3 terms under the complete license at
`packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt`.
Jot binds the browser view to its native Session stream and authoritative screen.


Explicit terminal Session loading also uses the installed DSH
`SessionController.inspect` and `resolveAgent` APIs, retaining their MIT terms
and original exact-identity, persisted-preset, writer and subagent ownership
semantics. Caller cancellation releases Jot's waiting request. Native shared
resolution remains owned by the original Host service lifecycle.


`web/jot/terminal-screen-hints.ts` and the prompt/link controls in
`NativeTerminalView.tsx` adapt PilotDeck's `Shell.tsx` prompt scanning,
`ShellMinimalView.tsx` link controls, `ui/server/index.js` URL normalization
and wrapping detection, and `ui/src/utils/clipboard.ts` text-copy fallback
at revision `783499ffdb2d501bf590b2e035acd027a882df10`.
The adapted portions retain GNU AGPL v3 terms under the retained complete
PilotDeck license above. Jot reads its real interpreted xterm buffer and
binds any chosen prompt input to the exact current native attachment.


Native glob/grep activity rendering selects the published `SearchMeta`
from installed `@deepseek-ai/dsh-tool-fs-search` 0.2.1-rc.2 and the original
Agent tool-result event. Its MIT terms remain at the retained DSH MIT license.
Jot's existing activity expansion/search uses only paths, line numbers, match
text and native total/truncation fields. This connects the pinned PilotDeck
`FileListContent.tsx` / Grep/Glob presentation scope to Jot's owned event chain.
The retained PilotDeck AGPL license and prior tool-renderer attribution apply.


Native search result pages reuse the retained public activity projection under
Jot's original owned conversation read transaction and immutable history cursor.
The source hash binds that canonical public projection and original step identity.
A shared portable text formatter keeps activity display, result pagination and
historical search aligned. It adds no native filesystem invocation or provider
execution path. Existing native MIT and PilotDeck file-list notices apply.


Native child public-result observation revision 3 carries the selected native
SearchMeta or an explicit null alongside the original artifact receipts.
It retains original full-event, transport and chunk hashes and the original
immutable observation receipts. Capability negotiation leaves revision 2 as the
legacy default. Additional projected metadata is appended to Jot's public event
history under the original source identity and existing DSH MIT integration.


`dsh-native-search-source-patch.js` (under `packages/session-adapter/` in the repository)
integrates the separately installed MIT-licensed `@deepseek-ai/dsh-tool-fs-search`
0.2.1-rc.2 formatted-result producer. Its reviewed runtime, declarations, locale
and package files are pinned in `runtime-patches/dsh-tool-fs-search-0.2.1-rc.2-sha256.json`
relative to the adapter. The existing retained DSH MIT notice applies. The original
spill backend and opaque locators retain their native meaning. Jot captures a
private bounded producer snapshot and requires the original successful linked
Session result before returning a page. Native grep line-preview limits remain
part of that source scope.


Producer-retained native search sources are read through original owned Jot
activity/native Session bindings. Child reads additionally match original native
call/result observation receipts and member/parent bindings. Public source pages
retain original event/content digests and native grep line-preview scope. The
existing result viewer, original actor/BFF controls and original SDK MIT integration
remain the basis for this source route.


Native retained-source search reuses the original owned history boundary and
source proof above. It scans bounded retained chunks once, verifies the complete
source digest, and reopens first-hit text under the same historical activity
snapshot. Original native grep line-preview scope is preserved in coverage.


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

The native member list extends the existing Jot result viewer and the reviewed
PilotDeck FileListContent integration. The retained PilotDeck AGPL notice and
pinned source provenance apply to that UI integration.

Native search member downloads use the original owned activity/member proof and
separately installed DSH owner file API. Complete opened-time bytes are sealed
into the existing private unlinked Jot spool and streamed with a complete content
digest and an activity/member/native-freshness binding digest. Original native
file policy and opaque version semantics remain authoritative. The existing DSH
MIT notice and PilotDeck file-list integration notice apply. This request-scoped
spool is disposed after download and does not provide persistent reopen.

Native member previews verify the existing complete opened-byte download,
original activity/member digests and UTF8 display-path digest. They reuse Jot's
complete byte verifier, image format helper, PDF page renderer, and PilotDeck-
derived PDF outline/search modules. Existing retained DSH MIT and PilotDeck
AGPL notices apply. Preview and its local download use the same opened bytes.

Native member Office visual previews reuse Jot's separately originated, pinned
DOCX/XLSX/PPTX frames and their existing boot/init/ready/work/close protocols.
Only a copy of the verified32MiB-bounded opened source is transferred to the
validated frame origin. The original same-open byte source remains available
for download and raw inspection. Existing retained viewer-library and PilotDeck
notices continue to apply. Native versions remain opaque in their source proof.

Native Office structured previews reuse the original Jot document.inspect input
staging, FileEngineAdapter, normalized bounded document model and structured
Word/spreadsheet/slide renderers. Original typed native member and full opened
source proofs authorize the private byte copy. Existing DSH MIT, viewer and
PilotDeck AGPL notices apply. Structured views consume normalized bounded document data. Native reference
integration is tracked separately.

Native Office PDF previews share the original configured LibreOffice export
engine and checked output reader, plus the private retained-PDF store. Their
bindings include original native member/activity/opened-source provenance.
The existing native MIT, viewer, engine and PilotDeck notices apply. The native
PDF viewer verifies complete output bytes and decoded page count. Native
reference receipt integration is tracked separately.

Native opened-source and derived Office-PDF attestations follow the existing
Gateway HMAC proof pattern with distinct native signature domains. Proofs bind
the original owner, activity/history/member identity and complete opened source,
with PDF output SHA/size/pages added for derived proofs. Original native and
PilotDeck integration notices apply. Native selection/reference snapshot
integration is tracked in the execution worklist.

Native member reference snapshots reuse the retained PilotDeck selection schemas through Jot’s strict content-reference codec. Native source revision and server receipts remain separate from numeric workspace versions; original attribution and AGPL terms above apply.

Native member PDF and retained Office-PDF text/region quote actions reuse Jot’s attributed PilotDeck selection and PNG upload recovery flows. Source-pinned reopening uses the native member read path, with opened-source and derived-PDF receipts retained through drafts and message snapshots.

Native structured Office DOCX/PPTX text and XLSX saved-cell/range references reuse the attributed OfficeContent and OfficeTextReferenceAction flows with signed native opened-source provenance, original matrix/text confirmation and source-specific focus.

Signed native Office openings also reuse the original isolated Word visual text, XLSX native cell-view2 and DOCX/PPTX/XLSX region PNG reference controllers. The viewer receives one private copy of the same verified native bytes; original window/origin/token, commit/focus, bounded matrix/PNG and upload recovery checks apply.

Signed native PDF and retained Office-PDF openings reuse the original complete Jot/PilotDeck PDF controller, including virtual continuous pages, thumbnails, outline/search, fullscreen, source references and owner-scoped bounded view-state retention. Native state identities bind original member/opened-source and optional derived PDF metadata.

Office viewer state adaptation uses the existing Word/PPTX/Univer position and zoom APIs and fixed-origin session protocol. The parent keeps32 bounded owner/source-specific states; quote focus takes priority over saved regular view state. Original third-party assets, upstream hashes and AGPL attribution remain in the individual SOURCES.json records.

Structured Office views reuse the attributed original OfficeContent text/table/sheet controls with bounded owner/source-specific position retention. Saved positions include document/table/slide pages or worksheet range pages and horizontal scrolling; existing source checks, quote focus and selection recovery remain on their original paths.

Native opened-file retention follows the existing private Office-PDF storage/publication pattern. Originally verified member bytes are preserved under the shared512MiB/128-entry budget and re-opened only through original owned activity/history authority with full size/SHA verification into an unlinked request spool. No native workspace version is fabricated and no execution authority is introduced.
Native staging reservations, including crash leftovers, remain charged to that same private retention quota; no automatic eviction or deletion of another writer’s stage is introduced. Original converted-PDF retention has priority over best-effort retention of a newly captured print source.

Owned retained-opening discovery and its original-version preview/download panel extend the existing attributed native search-member UI. Inventory validates original actor/activity/source contexts without loading a live SDK or original file; exact-open viewing retains the original full-byte and quote-proof lifecycle. Member and retained-opening panels are mutually exclusive.
New retained source records include a canonical source-metadata SHA-256 to detect metadata corruption during inventory/reopening. Existing private v1 records retain their original owner-bound read compatibility; a new digest is never retroactively asserted for an older record.

Retained native openings now additionally capture the original immutable gateway activity event sequence inside the checked private metadata. Reopening resolves that exact owned event and preserves the original source digest/history/signature context, so later detail-only projection updates need not erase retained source provenance. Legacy records remain compatible without asserting a reconstructed event sequence.

Unsigned native PDFs and Office-derived PDFs now reuse the same attributed complete PDF controller as signed openings, including continuous pages, thumbnails, search/outline, fullscreen and bounded owner/source view-state restoration. Viewing identity and quote identity remain separate: native quotes require original source receipts, and Office-derived quotes additionally require the derived PDF receipt. The duplicated simplified native PDF controller has been removed.

Unsigned native DOCX/XLSX/PPTX openings now reuse the attributed complete isolated Office controllers and their original owner/source-bounded view-state protocol. The duplicate generic Office attempt has been removed. Viewing uses the same size/SHA-verified private copy and isolated frame lifecycle; Word text, spreadsheet cell and Office region reference actions require a separate original source receipt, while original origin/window/token and quote commit checks remain.
