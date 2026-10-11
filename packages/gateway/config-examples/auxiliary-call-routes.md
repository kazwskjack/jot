# Auxiliary call quotas

`auxiliary-call-routes.json` is a configuration example, not an enabled production policy. It contains no credentials, host addresses, or user data.

Add these routes to the existing model budget policy's `routes` list. Keep its `admission_route` pointed at the primary token-metered model. Preserve existing scopes, balances, and policy revision rules; do not replace the database or clear earlier usage. These routes cannot be used for primary model or compaction admissions.

The measured unit is a committed dispatch attempt. Each attempt consumes one `model_calls` allowance from every bound scope. Provider errors also consume that allowance. A fallback is a separate attempt. Cached results and coalesced requests do not dispatch again. The frozen `billing.nano_usd` value is a configured host charge per attempt, not a provider invoice. Set it according to an explicit deployment policy. Zero in this example means no configured monetary charge; it does not assert that local compute or upstream inference costs nothing.

Token usage is not measured for these routes. Settled receipts contain `actual.tokens: null` and `metering: dispatched_call`. Token counters represent token-metered routes only. The `context_window` and `max_output_tokens` fields are retained for route-schema compatibility; these example values are not verified provider capacity limits. Existing HTTP input and response byte limits still apply.

The emotion adapter recognizes the explicit route pairs `openjev/openjev` and `laya/emotion`. Credentials and the Laya endpoint stay in server environment configuration. They must never be written into this file, browser code, or a repository. The HTTP route resolves the actual owner/run budget and requires a current worker lease. An idle role interaction with no active run falls back to the local mascot instead of creating a task solely to charge a model call.

If a process exits after dispatch commits, maintenance settles that original attempt from the durable dispatch record. It does not contact the provider, repeat the request, or forgive its quota. Token-metered routes still require trustworthy provider usage and retain unknown holds when that usage is missing.

Before enabling this on a target host, verify policy loading, a real provider result, the original task/root binding, call caps, fallback accounting, cancellation, and crash recovery. Local fixture tests do not prove production readiness. Page-operation decision adapters and CPU/GPU resource metering are separate integration work.
