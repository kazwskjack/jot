# Memory reasoning provider

This is an optional provider for the existing DSH `jot_workspace` tool call
`memory.list` with a non-empty `q`. The Gateway first builds the caller's
authorized candidate set, then asks the configured compatible endpoint to
select candidate IDs. The Gateway validates those IDs and commits the selected
memory versions, retrieval trace, model-budget settlement, and execution
receipt through its existing path.

Copy `memory-reasoning.json` to a private host file and set
`GENERAL_AGENT_MEMORY_REASONING_FILE` in the Gateway process environment. Keep
the API key in the separate file named by `api_key_file`; neither file belongs
in the repository. The endpoint must use HTTPS, or loopback HTTP for a local
gateway. Blank `GENERAL_AGENT_MEMORY_REASONING_FILE` disables provider
reasoning. When configured, provider/configuration errors fail the read closed;
the Gateway does not silently substitute local keyword results.

The endpoint must return one assistant choice with a JSON object containing
`selected_ids`, and report prompt, completion, total, cached-read, and cache-
write usage. The sample's `explicit` policy requires both cache usage buckets.
If the provider omits cache-write counts, `input-rate-equivalent` is accepted
only when the route's cache-write and input rates match; otherwise usage cannot
settle and the budget attempt remains held for reconciliation.

The configured `provider` and `model` must identify a route in the existing
`GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE`. Add a route like this to that policy's
`routes` array, using the deployment's actual model ID, context limits, revision,
and reviewed integer nano-USD-per-token rates:

```json
{
  "provider": "compatible",
  "model": "memory-reasoner",
  "revision": "memory-reasoning-rates-v1",
  "context_window": 4096,
  "max_output_tokens": 1024,
  "rates": { "input": 0, "output": 0, "cache_read": 0, "cache_write": 0 }
}
```

Replace the zero rates with the host's reviewed rates; they are accounting
configuration, not a provider invoice. Do not add `billing`: memory reasoning
requires a token-metered route. `max_input_bytes` must be no greater than
`context_window - max_output_tokens`. Keep the policy's current
`admission_route`, revision history, and limits. Every budget scope bound to a
run needs enough remaining quota for the route's reserved context window,
worst-case configured cost, and one model call. For the values above, that is
4096 tokens, 4096 times the largest configured token rate in nano-USD, and one
call per bound scope.

This path only runs for an active run with the Gateway's model-budget ledger.
The host must deploy the matching Gateway and DSH SessionAdapter versions so
the DSH tool caller receives the selected memories and Gateway receipt. Local
fixture tests establish the code path and accounting contract; they do not
verify the endpoint, credentials, provider output quality, or production
acceptance.
