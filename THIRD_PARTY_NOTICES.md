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
