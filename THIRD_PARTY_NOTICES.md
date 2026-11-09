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
