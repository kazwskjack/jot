# Dependency notices

Jot's original source and documentation use the repository MIT license. Third-party software retains its own license and authorship. No complete third-party Agent runtime distribution, model weights or private browser profiles are vendored here.

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
