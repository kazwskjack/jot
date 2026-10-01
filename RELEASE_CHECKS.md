# Code preview verification

These checks apply to the first standalone code preview. Historical engineering results are described separately and are not reused as this release's test counts.

| Check | Result | What it establishes |
| --- | --- | --- |
| Portable test suite | 21 passed, 0 failed | Model streaming, lifecycle, approvals, worker bounds, idempotency, artifacts and local API/SSE boundaries |
| Portable Vite build | Passed | Web source compiles into static assets |
| Gateway selected contract/store/security suite | 38 passed, 0 failed | Included routes, contracts, owner isolation, transactions, event cursors and retention inventory |
| Gateway typecheck and build | Passed | Included TypeScript and generated neutral template build |
| Session voice protocol suite | 6 passed, 0 failed | Mocked authentication, capability, transcription and cancellation contract |
| Public source/document review | Completed | Private deployment material omitted; dependencies and unfinished integrations distinguished |
| Real UI click verification | Not executed | Browser tooling blocked opening the new localhost preview; build is not a substitute for UI acceptance |
| Real model/browser/office/speech/provider acceptance | Not run for this code preview | Requires operator-configured external services and separate validation |

The document build used Python 3.12.14. Node may report its built-in SQLite API as experimental. Neither that notice nor a successful health response establishes external runtime readiness.

See [Feature status](FEATURE_MATRIX.md) for incomplete host dispatch paths and [Deployment](DEPLOYMENT.md) for post-installation acceptance. Do not infer production parity, browser-pool capacity or performance superiority from these results.
