# Session preparation timing

`OfficialSessionRunner` emits metadata-only `jot_preparation_timing` records to
stderr, or to an optional trusted `onPreparationTiming` diagnostic callback.
This measures the original execution path; it does not add another model call,
probe, planner, retry, admission or execution permission.

| Phase | Measured work |
|---|---|
| `session_confirm` | Original Session create/confirm call for a new input. |
| `opening_snapshot` | Original follow iterator's first validated snapshot. |
| `attachments` | Existing attachment reads, encoding, staging and prompt assembly. |
| `prompt_submit` | Original queued prompt submission. |
| `input_recovery` | Existing original-input recovery call, without create/prompt/upload. |
| `goal_resume` | Existing native Goal resume call after attaching its observer. |
| `preparation_total` | Execute entry through completed preparation, or its failure. |

Only phases actually reached are emitted. Recovery uses its own branch phases;
it does not pretend to create another Session or resubmit the original message.
Total completes before `onReady` and answer observation, and emits once. A later
answer failure cannot relabel successful preparation. RPC success means that
call returned; subsequent receipt validation can still fail the total. Thus a
diagnostic success is never proof of final answer delivery or goal completion.

Records contain a SHA-256 run reference, accepted policy mode or `unknown`, phase,
UTC start, monotonic offset/duration in milliseconds, and succeeded/failed/
cancelled outcome. Optional facts are bounded snapshot record count, boolean
`snapshot_has_more` and attachment count. Message text, snapshot contents,
Session IDs, raw run IDs, paths, credentials and dependency error strings are
excluded. Logger failures are swallowed and original task exceptions preserved.
The host's existing log rotation/retention policy still applies; this change
does not create another persistent log database or claim zero disk growth.

This is preparation timing, not a provider first-token or generation benchmark.
Queue time before Runner entry and model work after prompt acceptance need their
own actual event timestamps. Historical uninstrumented requests cannot be
retrospectively split into these phases.

The focused Runner/Goal/mode/recovery matrix passed 71 tests without skips before
the explicit Goal phase assertion was added. That assertion is included in the
subsequent full Gateway regression. Typecheck and Windows local Gateway build
passed. The complete Gateway regression passed 1,822 tests with seven explicitly gated
skips and no failures. Root regression passed 67 tests without skips. Public
audits are recorded separately before explicit publication.
Fixtures do not establish an external provider latency, production request
measurement, monetary settlement or completion of the full capability ledger.
