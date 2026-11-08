# Linux runner: finite approved execution

The runner only accepts `node --test <pinned paths>`. Before extracting the ZIP or starting `Popen`, it requires an operator-supplied `--approved-execution FILE` and `--approved-execution-sha256 SHA256`; the SHA must be fixed in the separately reviewed caller invocation. The descriptor binds:

- source ZIP SHA-256 and full-source-manifest SHA-256;
- owner packet manifest path/SHA context;
- Git-delta identity, or exactly `{"status":"not_applicable"}`;
- candidate commit/tree, exact test and lock maps, and exact `node --test` argv;
- `execution_environment.execution_root_kind: "remote"` and a nonempty profile label.

The descriptor has no reviewer/self-approval field. A packet flag, queue synthetic exception, or descriptor copied from the candidate archive cannot authorize execution. M14 has no Git-delta identity; keep that field `not_applicable` and never reuse d060's manifest identity.

Only `--execution-root-kind remote` is accepted. The caller must use the already-approved isolated, credential-free Linux environment. The descriptor records the caller's fixed code/environment selection; it does not prove that the environment is isolated or has no credentials. `--authorized-root` only constrains work/output paths and is not an OS sandbox. External SIGTERM follows the same cancellation cleanup path as KeyboardInterrupt; the runner restores the prior SIGTERM handler after group cleanup. The runner terminates the process group after normal exit, timeout, or cancellation, then sends SIGKILL if needed. If it cannot observe the group exit, it exits nonzero without freezing a result or event. SIGKILL cannot be caught, and a descendant that calls `setsid()` can escape this process-group check.

An invocation supplies the descriptor independently of the source archive:

```bash
python3 "$PROJECT/tools/delivery-flow-v1/linux_run.py" \
  --source "$SOURCE_ZIP" --manifest "$SOURCE_MANIFEST" \
  --manifest-path "$PACKET_MANIFEST_PATH" --manifest-sha256 "$PACKET_MANIFEST_SHA256" \
  --candidate-commit "$CANDIDATE_COMMIT" --candidate-tree "$CANDIDATE_TREE" \
  --workdir "$RUN_ROOT/work" --outdir "$RUN_ROOT/out" \
  --authorized-root "$RUN_ROOT" --execution-root-kind remote \
  --approved-execution "$APPROVED_EXECUTION" \
  --approved-execution-sha256 "$APPROVED_EXECUTION_SHA256" \
  --job "$JOB_ID" --repo "$REPO" --owner "$OWNER" --packet-id "$PACKET_ID" \
  --source-class "$SOURCE_CLASS" --scope "$SCOPE" \
  --test-pin "$TEST_PATH=$TEST_SHA256" --lock-pin "$LOCK_PATH=$LOCK_SHA256" \
  -- node --test "$TEST_PATH"
```

The receipt retains the descriptor and pin with the source ZIP, full-source manifest, log, result, and (for completed tests only) event draft. `cleanup.process_group_cleaned` is `true` after a child process group was observed empty, `false` only as an unconfirmed value that consumer validation rejects, and `null` when no child process group was started. An exit code requires `true`; a prestart BLOCKED/CANCELLED record uses `null`, not a success claim. PASS also requires all tests passing, matching pins, and a valid receipt. A blocked or cancelled job emits no test event. Linux tests never create formal D/E or product acceptance.

## Existing candidate lanes

The d060882ad1eb synthetic Node package remains available for local preflight, queue, and contract tests. Historical local Node core execution, queue integration, and workflow-metrics evidence for d060 remain on record; they are not a current runner receipt. Its queue exception grants no runner execution; it has no operator-pinned descriptor or same-candidate Linux result. The separate M14 snapshot-provider slice is commit `18b20e4ae18b5580ad0f3089683522f1a7400ad7`, tree `f3f4728cb614fcd8a3644eefac04228e31ec068a`, with no Git delta. Its prior CI artifact is a historical 24/24 result from the old runner contract; it does not exercise this descriptor or process-group change, and the current validator does not accept the old result schema.

## Authoring-host tests

These Python tests validate pins and process cleanup with a mocked child. They do not execute candidate code or establish Linux execution/acceptance.

```powershell
python.exe -m unittest discover -s tools/delivery-flow-v1/tests -v
```
