# Request-scoped web-decision accounting

Optional Python boundary for the gateway's
[web-decision budget protocol](../../WEB-DECISION-BUDGET.md). Requires Python
3.11 or later and only the standard library. It is not a browser engine, model,
planner, or an automatically connected MCP server.

Run the local tests from this directory:

```powershell
python -m unittest test_web_decision_budget test_web_budget_metadata test_web_response_recovery
```

Trusted host code first obtains an opaque grant from the existing owned run.
Create `ticket_client(loopback_origin, grant)` and enter `bind_budget(client)`
for that exact request. `BudgetedPredictor(invoke, provider, model, usage=None)`
wraps the underlying provider invocation. The request must have a stable native
`request_id`; the wrapper hashes and copies the complete JSON request before
reserving. Supported route identities are `openjev` and `laya`; the gateway
must have a matching configured model route.

The client disables environment proxies and redirects and uses only loopback
HTTP. Tickets are transient credentials; never print or include them in model
arguments/results. No owner, run, internal Session, machine identity or API key
is added to the provider payload.

ContextVar bindings isolate concurrent requests. New threads and queued work
must explicitly capture and run the original `copy_context()` before dispatch;
ordinary new threads do not inherit authorization. Do not store a current
grant on a shared provider instance. Missing context denies invocation.

Reserve replay does not resend a provider call. Dispatch acknowledgement loss
also prevents invocation and conservatively records unknown accounting. A
provider exception or incomplete usage leaves the original attempt unresolved.
For token-metered routes, `usage(result)` must return actual supplier usage in
the gateway's format. Configured dispatched-call routes are charged at dispatch
and keep tokens unavailable; the wrapper fabricates no token estimates.

The actual-submission helper automatically journals bounded HTTP/JSON responses
in the original gateway attempt. Low-level `BudgetedPredictor(..., journal=True)`
opts into the same behavior; its default compatibility mode does not journal.
A lost recording acknowledgement reads and verifies the same original bytes
and SHA-256. A repeated, already-dispatched attempt can reuse a recorded result
and settle actual usage without calling the provider again. Missing or corrupt
records stay unresolved, and a failed uncommitted write never becomes success.
Creating a new request ID to repeat the model is not recovery.

HTTP frames preserve body bytes and status, with only bounded `Retry-After`;
cookies and authentication headers are excluded. Original private response
bodies belong only in the private runtime database and backup. A cached result
never authorizes browser actions or establishes task success. Host cancellation,
cross-machine callback and original-record recovery through the complete native
Session lifecycle still need end-to-end acceptance.

Local tests use synthetic provider functions. A separate development experiment
uses actual gateway HTTP with two concurrent Python clients and isolated root
budgets, also with synthetic providers. Neither proves native MCP metadata
intake, actual provider compatibility, CPU/GPU attribution or production
acceptance. The existing Python provider path is not automatically covered just
because this optional module is present.

`request_budget_scope(context, fixed_callback_origin, required=False)` accepts
the SDK's `request_context.meta` mapping or its `model_dump()` representation.
Only `jot_web_budget: {protocol: 1, grant: ...}` is accepted as a ticket; it cannot
carry an owner, Session, run or callback URL. Missing optional metadata clears
an enclosing request's authority instead of inheriting it.

`budgeted_server_type(FastMCP, callback_origin_getter, required_getter)` wraps
the existing `call_tool` dispatch and preserves the original tool signatures.
Pass host-only configuration getters. This optional integration has been tested
with the official Python MCP SDK 1.12.0 memory transport, including concurrent
requests, actual worker-thread propagation and unchanged input schemas.
That SDK test uses synthetic accounting/providers, not production Universe or
a real model. Other SDK versions still need compatibility acceptance.

Use `invoke_provider_call(provider, model, request_id, payload, invoke, usage)`
at the actual HTTP submission or model-function boundary, after schema,
credentials and egress checks. A denied preflight must not allocate an attempt.
The payload and stable request ID are hashed and copied before dispatch.
`UNIVERSE_WEB_BUDGET_REQUIRED=1` rejects an unscoped submission, including an
unmetered fallback; the default optional legacy path is unchanged.

The extended development runtime now uses this helper at its OpenJev HTTP,
Laya HTTP and local Laya model calls. Its shadow queue captures a separate
context per job, and its local Laya worker explicitly copies the caller context.
Those call-point tests use fake HTTP/model responses and do not establish real
provider acceptance or supplier billing. The current integrations provide no
real token extractor: token-metered routes without actual usage fail with an
unknown held attempt; configure dispatched-call quotas explicitly rather than
inventing tokens. A real local gateway HTTP experiment drops a committed record
acknowledgement, then restores that result for two concurrent Python clients,
including an HTTP body larger than 64 KiB. Each uses one synthetic provider call
and one charge. Cross-machine callback and complete native/real-provider recovery
still require acceptance before production enablement.
