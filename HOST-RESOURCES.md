# Host resource observations

Trusted gateway auxiliary-model calls now retain a resource observation beside
the original model-budget attempt. Emotion and independent reply-verification
calls use this path; any trusted web-decision adapter using the same entry point
also inherits its existing root budget. This does not connect an external
Universe provider automatically. The separate Python web-decision path still
needs its trusted run identity and accounting integration before it can be
claimed as covered.

Inspect one owned run without invoking a provider or modifying its database:

```powershell
node dist/src/workbench/resource-report-main.js PRIVATE_DATABASE OWNER RUN_ID
```

Run from `packages/gateway` after building. Node 24 can also run the source `.ts`
entry. The command opens the database read-only, checks the run's budget binding
and conversation owner and returns at most the latest 50 observations. `has_more`
indicates that older records exist. It outputs no message, task objective,
provider response, native Session ID, credential, machine name or database path.
Treat operational reports as private runtime data, not publishable fixtures.

Each completed observation contains:

| Field | Meaning |
| --- | --- |
| `wall_ms` | Monotonic elapsed time around the actual auxiliary invocation |
| `cpu_user_us`, `cpu_system_us` | Gateway process CPU-time changes over that interval, in microseconds |
| `rss_start_bytes`, `rss_end_bytes` | Process RSS snapshots at the interval boundaries, not a peak or allocation total |
| `gpu` | `null`: this observer cannot measure GPU consumption |
| `remote_inference` | `null`: resource consumption inside a remote or separate inference service is unavailable |

The attribution is always `shared_process_interval`. Concurrent requests,
database work and other activities in the gateway can contribute to the process
CPU/RSS samples. Do not add overlapping CPU intervals and call the result a
task's exclusive CPU cost; do not sum RSS snapshots, infer remote GPU use or
convert those values into model token billing. Likewise, the sum of invocation
durations is not a parallel task's end-to-end elapsed time.

Provider token usage and configured-rate/per-dispatch accounting remain separate
in the original model-budget ledger. Resource observations cannot authorize a
call, raise a budget, refund a dispatched attempt or declare a task successful.
Provider errors still record failed intervals while incomplete model usage stays
unknown and held. Cancellation or revoked authority cannot erase incurred usage.

Observation identity and completed facts are immutable. A failed observation
write leaves a durable `pending` record with no measurement; it is not zero usage.
Valid provider usage still settles normally, and observation failure never repeats
a provider request. Process termination may also leave a pending record; the
missing historical CPU/RSS interval cannot be reconstructed or guessed later.

Local tests exercise real process CPU/RSS samples, owner isolation, immutable
facts, provider failure, observation storage failure and the read-only command.
They use synthetic providers and do not prove real remote inference, GPU
accounting, complete main-DSH-stream instrumentation or production acceptance.
Observation rows are retained with their accounting attempts and included in the
database backup; an expiry cleanup policy requires the same ownership, evidence
and verified-backup review as the other task records.
