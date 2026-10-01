# Jot

**A lightweight AI bot for conversations, web tasks and file work.**

[中文](README.zh-CN.md) · [Technology](TECH_STACK.md) · [Deployment](DEPLOYMENT.md) · [Agent](agent/README.md) · [Integrations](INTEGRATIONS.md)

Jot puts a small interface around useful Agent work: ask a question, follow the steps, review an action and receive a file. Dark by default, with a light theme available.

## Included

- A runnable local Agent with a configurable model endpoint and a bounded tool loop.
- Separate conversations, SQLite persistence and replayable progress events.
- Live text updates, task cancellation and explicit action approval.
- Allowlisted web reading, optional JSON search and isolated browser actions.
- Text, Markdown, JSON and CSV uploads and new downloadable files without overwriting uploads.
- A demo mode with clearly labelled synthetic responses.
- An extended TypeScript gateway and Session adapter for projects, ownership, batch progress, document jobs, event recovery and optional voice services.

The local runtime runs without the extended services. Extended integrations require their own configured runtime, models and tool endpoints. Bundled interfaces do not imply that external services are installed.

## Start

Requires **Node.js 24+**. The extended document worker also uses Python 3.12+.

```sh
git clone --branch feat/standalone-agent https://github.com/kazwskjack/jot.git
cd jot
npm ci
npm run build
npm run demo
```

Open `http://127.0.0.1:3030`. Demo mode does not contact a model or external website.

For real tasks, copy `.env.example` to `.env`, configure `JOT_MODEL_URL`, `JOT_MODEL` and a provider key if required, then run `npm start`. The endpoint must support streaming Chat Completions and function tools. Explicitly allow HTTPS origins before reading pages. Optional browser support requires `npx playwright install chromium` and `JOT_BROWSER=true`.

The first code release is maintained on `feat/standalone-agent`; switch to that branch if the default branch contains documentation only.

## Structure

| Path | Responsibility |
|---|---|
| `web/` | React interface, themes, progress, approvals and downloads |
| `src/` | Self-contained local runtime, model adapter and tools |
| `packages/gateway/` | Extended API, durable tasks, replay and document jobs |
| `packages/session-adapter/` | Session and optional speech integration |
| `agent/README.md` | Agent behavior and integration boundaries |
| `TECH_STACK.md` | Engineering choices, strengths and trade-offs |
| `DEPLOYMENT.md` | Configuration, resource sizing and recovery |
| `INTEGRATIONS.md` | DSH extensions, proposed Agent adapters and decision services |
| `TROUBLESHOOTING.md` | Entry-specific failures and diagnostic steps |
| `FEATURE_MATRIX.md` | What is included, external, scaffolded or proposed |
| `DEVELOPMENT.md` | Engineering history and lessons from implementation |
| `ALGORITHMS.md` | Scheduling, transactions, replay, approvals and execution guards |

## Check

```sh
npm test
npm run build
```

For extended module checks, follow [DEPLOYMENT.md](DEPLOYMENT.md). Performance depends on the model, external pages and enabled workers. Resource sizes are starting recommendations, not measured capacity guarantees.

## License

Original code and prose are MIT licensed. Dependencies retain their own licenses. The technical explanation is written for Jot and does not imply ownership of dependency implementations.
