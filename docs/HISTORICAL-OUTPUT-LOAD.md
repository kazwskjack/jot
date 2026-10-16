# Historical output load measurement

The optional historical final-answer publisher verifies real output bytes before
its existing atomic publication. Native proofs, owner/version/path checks and
source CAS remain mandatory. A process-local witness retains verified file
descriptors while the transaction rechecks file identity and nanosecond change
and modification times. Descriptors close when that attempt ends. This is not
a serialized attestation, execution lease, filesystem snapshot or provider receipt.

Full byte hashing occurs outside the SQLite write transaction, including an
already-published receipt retry and a publication won by another process. Inside
the transaction, catalog/source/permission checks and final file checks still
precede commit. Changed bytes, substituted paths or stale versions refuse the
operation. The existing 75 ms SQLite busy timeout is unchanged.

## Run the isolated measurement

From the repository root after Gateway dependencies are installed:

```sh
npm --prefix packages/gateway run test:historical-output-load
```

It creates synthetic private temporary databases and real 1, 32 and 200 MiB
files, three rounds each. An independent owned Node process writes to a separate
synthetic table in the same database, with the normal 75 ms infrastructure wait.
The probe exercises initial publication and receipt retry, then corrupts the
file and requires refusal without another native proof. It asserts one final
receipt/message/artifact and retention-lease cleanup; unknown candidate provenance
must remain unknown. It does not contact an external model, notification service
or application database. Normal Gateway tests skip this heavier measurement.

Choose a private scratch directory through `TEMP` and `TMP` before running it.
Each successful case removes its own file/database, including on assertion
failure; interruption of the entire operating system may leave scratch files.
Use at least 250 MiB of free scratch space plus normal dependency/runtime space.
`JOT_HISTORICAL_OUTPUT_LOAD_ROUNDS` optionally selects 1–20 measurement rounds;
it does not change product task or model limits.

The `OUTPUT_LOAD` diagnostic contains byte count, elapsed publication/retry
times, observed write-lock duration, competing successes/busy failures, writer
latency samples and process RSS before/after. It contains no message text, file
paths, credentials or provider traffic. RSS samples are not peak-memory evidence;
small writer samples are not a throughput or percentile capacity guarantee.

## Interpretation and boundaries

Zero competing-write failures is the controlled local acceptance assertion.
Report measured lock/wait times as well; a green result does not promise zero
contention under an arbitrary production workload. Cold cache, fragmented or
remote storage, many simultaneous publishers, unrelated long transactions,
retention/restore, power loss and actual deployment need separate acceptance.

The original local Windows control held write locks around 120 ms for 200 MiB
and failed one competing write in each of three rounds. The earlier smaller
cases had no competing failures. Preserve those negative controls rather than
increasing the database wait or removing byte integrity to make the probe pass.

Reliable local file identity and nanosecond change timestamps are required.
An administrator able to forge filesystem metadata is outside this integrity
boundary. SQLite never locked external filesystem writes. Path/file checks
cannot turn a directory into a mandatory filesystem snapshot. On the measured
Windows host, renaming a parent directory with an open file was refused by the
OS; this is recorded separately from application rejection. Pre-existing directory
junctions are actually rejected by the application. Other filesystems/platforms
need their own replacement and timestamp probes before production enablement.

## Current local measurement

The final Windows CLI run used three rounds at each size, a single artifact per
case, real local files and an independent synthetic writer. Ranges are min/max
within those three rounds, not production percentiles.

| Size | Publication elapsed | Publication write lock | Receipt-retry write lock | Competing busy failures |
| --- | --- | --- | --- | --- |
| 1 MiB | 23.24–39.56 ms | 6.03–8.45 ms | 3.77–4.15 ms | 0 |
| 32 MiB | 37.41–41.50 ms | 6.23–8.17 ms | 4.35–5.79 ms | 0 |
| 200 MiB | 129.49–135.46 ms | 5.59–6.94 ms | 4.00–4.89 ms | 0 |

The 200 MiB receipt retry still spends 123.99–142.01 ms reading/hash-checking bytes,
but does so outside the write lock. The three 200 MiB rounds recorded 57 successful
competing writes. Their post-operation process RSS samples were 82,141,184–84,021,248
bytes; this is a before/after process sample, not a peak-memory or minimum-host claim.
Do not compare elapsed whole-operation times to write-lock times as if they were
the same measurement. This does not complete multi-file, cold-storage, long-running
retention or production acceptance.
