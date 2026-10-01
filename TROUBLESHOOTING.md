# Troubleshooting

Choose the affected entry point first. The portable Agent and extended gateway have separate APIs, stores and environment variables.

| Symptom | Check | Resolution |
| --- | --- | --- |
| Local interface says to build first | `dist/index.html` and working directory | Run `npm ci` and `npm run build` from the root |
| Model is not configured | `JOT_MODEL_URL`, `JOT_MODEL`, launch environment | Copy `.env.example`, provide your own API base URL and model, then restart |
| Model request fails | Streaming Chat Completions and tool support | Test the provider separately; do not replace failures with demo output |
| Local request returns 403 | Host, Origin and request token | Use the loopback URL printed by the server; reload after restart |
| A tool rejects a URL | Exact HTTPS origin, including required assets | Add only deliberate origins to `JOT_WEB_ORIGINS`; redirects remain restricted |
| Browser dependency is missing | Optional dependency and Chromium | Install Playwright/Chromium before setting `JOT_BROWSER=true` |
| Approval returns 409 | Current `approval_id`, task state and deadline | Refresh the snapshot; never resend an old approval against a new action |
| Download returns 410 | Artifact file and its storage root | Restore from a consistent backup; the button cannot recreate a lost file |
| SQLite cannot open a file | Parent directory, permissions and launch directory | Create a writable storage parent; keep database and artifacts together |
| Gateway remains queued | Harness worker, DSH host and installed preset | Start/configure the actual services; a healthy API does not prove execution readiness |
| Gateway owner requests fail | Trusted proxy identity and CSRF wiring | Strip client identity headers and inject verified identity at the authenticated proxy |
| Adapter is unreachable | Loopback URL, matching private token and Cordis registration | Follow the adapter README; `index.js` is a plugin, not a standalone server |
| Gateway template is missing | Python on PATH and gateway build | Run the gateway build, which generates and copies the neutral template |
| Office conversion is unavailable | LibreOffice and the selected Python's `uno` import | Configure a compatible system Python; ordinary pip Python is insufficient |
| Voice is unavailable | Speech controller/provider and both capability flags | Enable only after a real audio test; the interface alone is insufficient |

When reporting a bug, include the entry point, versions, a synthetic reproduction, terminal task state and expected behavior. Redact keys, cookies, private URLs and user content. See [Deployment](DEPLOYMENT.md) for configuration and [Contributing](CONTRIBUTING.md) for checks.
