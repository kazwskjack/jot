# Development notes

Changes follow these implementation boundaries:

1. Keep model access, tool execution, task state and presentation separate.
2. Recover through durable events; do not recreate side effects during replay.
3. Preserve one active task per conversation and bound shared concurrency.
4. Preserve original uploads and bind generated files to their producing task.
5. Require explicit approvals before browser actions and local file creation.
6. Keep display advice separate from execution permissions.
7. Validate network contracts before business handlers.
8. Test cancellation, restart, ownership and duplicate requests before publishing.

Integrations remain optional until their full setup and verification path is available. An API contract or demonstration is not evidence of a working external service.