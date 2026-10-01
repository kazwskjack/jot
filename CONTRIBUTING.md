# Contributing

Use small changes with a clear behavior and reproducible check. Read [AGENTS.md](AGENTS.md), [agent/README.md](agent/README.md) and the module being changed.

Run local tests and the browser build. Extended gateway changes also run contract, persistence and security tests. Keep integrations opt-in and preserve cancellation, ownership and approval.

| Change | Checks from the repository root |
| --- | --- |
| Portable runtime or web interface | `npm test` and `npm run build` |
| Extended gateway | `npm ci --prefix packages/gateway`, then `npm run gate --prefix packages/gateway` and `npm run build --prefix packages/gateway` |
| Session voice adapter | `node --test packages/session-adapter/voice.test.mjs` |
| External model/browser/provider integration | Above checks plus a separately recorded real integration scenario |

Gateway builds require Python on PATH to generate the neutral template. Keep generated `dist/`, local data and dependency directories out of commits. Provide a synthetic reproduction, expected/actual outcome and check results with a pull request. Do not call a fixture or mocked provider result a live integration test.

Do not commit credentials, databases, logs, browser profiles, real conversations or private endpoints. Use generated fixtures. Preserve dependency licenses and state limitations accurately.
