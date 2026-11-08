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
