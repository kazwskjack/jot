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

## Follow-up verification: 2026-10-14

The operation-outcome handoff barrier passed 16 focused gateway tests, including older-schema migration, stale observations, unknown item outcomes and exact execution authority. The portable runtime passed 31 tests; workbench UI helpers passed 105 tests. The full extended gateway suite completed with 963 passed, 0 failed and 6 skipped tests (969 total). Both the web build and extended gateway build completed locally. Skipped checks are not counted as passes.

The public worktree review scanned 509 source and documentation files. Reachable-history review covered 42 existing commits and 703 objects with no text or private-identity findings; five binary objects matched previously reviewed neutral template hashes. The final index and commit receive a separate publication review. These checks do not establish live provider reconciliation or production handoff readiness.

The first portable test run under a restricted Windows account encountered denied loopback connections and test-directory access. Running the unchanged suite in the normal user context passed. The focused gateway checks also used isolated fixtures in that context. No production accounts, browser profiles or user conversations were used.

A follow-up regression reproduced a missing accepted count being treated as complete. The fix was verified against six incomplete-manifest cases and newer complete observations. The final gateway rerun again completed with 963 passed, 0 failed and 6 skipped; gateway build and the 509-file public source review passed. Internal candidate tests and typechecking were verified separately. Production handoff remains disabled.

The authenticated handoff management transport was tested through real gateway HTTP requests and isolated SQLite state. Two new scenarios cover exact root/Session/lease identity, atomic transfer rollback, immutable retries, same-role alternate Session denial, return to the lead and stopping without releasing in-flight spend. A separate regression reproduced an unresolved-usage error returning 500; it now returns the fixed conflict code `HANDOFF_USAGE_UNRESOLVED` with status 409. The final full gateway suite passed 965 tests with 0 failures and 6 skips (971 total). Both local builds, the 31-test portable suite, and the internal candidate's two HTTP scenarios and typecheck passed. Native-host orchestration and live provider-effect reconciliation are still not established by these checks.

The subsequent member-admission change passed 182 adapter tests and three actual installed-SDK scenarios (handoff, existing formal delegation and task cancellation), with no skips. The portable 31-test suite and web build also passed. The handoff probe uses the actual native Team and AgentLoop, an authenticated isolated gateway and scripted providers; it is not production or external-effect acceptance. Gateway source was unchanged in this follow-up; the preceding full gateway result is recorded separately rather than counted as a new run.

The background-operation closure prerequisite passed 187 public adapter tests and 219 internal adapter tests, with no failures or skips. Regression tests first reproduced premature closure without an observer and an ignored malformed setup option. They now reject missing or mismatched proofs, running operations, incomplete/duplicate manifests and Session changes during observation. Three existing actual-SDK scenarios passed again using local scripted providers; the portable 31-test suite and local web build passed. Operation proofs in the new closure tests are fixtures, not live remote-service evidence. Gateway source was unchanged in this follow-up. Production Handoff and external-effect acceptance remain pending.

The configured leaf-transport follow-up passed 194 public adapter tests and 225 internal adapter tests (zero failures/skips). It includes a real loopback HTTP member-closure scenario and an actual packed-module import. The latter initially failed because the new runtime module was missing from the package manifest; adding the module resolved that failure in both packages. The actual-SDK three-scenario regression, portable 31 tests and local web build also passed. The new HTTP server uses synthetic operation snapshots; it does not prove live provider or production acceptance.
