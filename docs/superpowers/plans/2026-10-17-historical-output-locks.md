# Historical output verification and SQLite write locks

Continuation of the approved large-output performance/retention acceptance.
DSH planning, permissions, original source proofs and publication receipts remain
unchanged. No production enablement is part of this change.

## Measured problem

An isolated real-file probe published and retried receipts for 1, 32 and 200 MiB
outputs, three rounds each, against an independent SQLite writer using the
existing 75 ms busy timeout. The 200 MiB rounds held the publication write lock
119.72–121.26 ms and receipt retry lock 118.11–120.04 ms. Each round produced one
SQLITE_BUSY in the competing writer. The smaller rounds produced none. These
are local Windows/synthetic measurements, not fleet or provider benchmarks.

## Implementation

1. Keep the real-file/competing-process probe opt-in; make zero competing-write
   failures an explicit acceptance assertion. Retain its pre-fix failure evidence.
2. Verify full bounded bytes outside the write transaction. Retain original file
   descriptors as process-local witnesses until commit finishes. At commit, check
   the same open descriptor and safe path against its original device/inode,
   size and nanosecond modification/change times. Reject replacement, unlink,
   junction/symlink, same-size edits or closed witnesses. No serialized metadata
   or caller assertion may substitute for the actual byte verification.
3. Resolve owner/conversation/version/catalog again inside the original immediate
   transaction and compare with the prepared output. Keep both native proofs,
   final product source CAS, original permissions, outbox and receipt atomic.
4. Apply the same preparation to published-receipt retries. If another publisher
   wins, leave the transaction and validate its existing receipt without new
   native calls; do not hash large files while holding that write transaction.
5. Close every descriptor and temporary retention lease on success, refusal,
   abort and races. Never clear native reservations or unknown money.
6. Test bytes changed after preparation, replaced/deleted paths, restored mtime,
   forged/closed witnesses, cancellation, concurrent publication, already-published
   retries, source/catalog drift and real large-file contention. Run Gateway,
   affected installed-SDK, root build/tests and public disclosure review.

This retains the existing local-file integrity boundary, now comparing bigint
nanosecond timestamps rather than floating millisecond values. It is not a
filesystem snapshot, mandatory OS lock or protection against an administrator
who can forge filesystem metadata. File identities/timestamps must be reliable;
network/coarse or unusual filesystems need their own acceptance before rollout.
The verification-to-commit interval remains subject to the same filesystem
assumptions as the existing final stat check; the SQLite lock never locked file
bytes against external writers. Do not claim an external filesystem transaction.

## Implementation and evidence

`historical-output-integrity.ts` now returns a process-local closure over actual
verified descriptors, with bigint identity/time facts. It checks after hashing
and at publication checks, and refuses reuse after close. There is no external
route or option accepting a caller's witness. `ordinary-final-publication.ts`
prepares output bytes outside the transaction, compares the freshly resolved
catalog inside it and checks files again immediately before commit. An existing
receipt is scoped/read-validated before output preparation, then checked again
inside the original transaction. A concurrent winner returns out of the original
transaction before validating its receipt. Cleanup retains existing conservative
retention behavior and closes every owned descriptor.

The explicit performance regression failed before the fix (one busy error in
the 200 MiB control). Final integrity/publication/load focused tests pass 43/43.
They cover actual same-size edits, restored mtime, path replacement/deletion,
pre-existing directory aliases, byte-hash mismatch despite catalog assertions,
closed witnesses, actual descriptor close tracking after later preparation
failure, cancellation, catalog-CAS and post-event file edits, canonical rollback,
original unknown candidate and leased-output cleanup. The default file-symlink
fixture failed with Windows EPERM; changing system privileges was not needed.
The directory substitution probe then observed the OS itself refusing directory
rename while the descriptor remained open. That outcome is explicitly recorded
as OS prevention, while pre-existing junction rejection is an application test.

Full Gateway tests pass 1317 total: 1310 passed, six existing skips and the one
opt-in load test skipped, zero failures (149.06 seconds), plus Windows build.
After that test process loaded the file, the byte-read assertion was expanded to
race two file publishers as well as retry the winning receipt; that final case
was rerun and passes. Production code did not change after the full run. Two
affected actual installed-SDK final/correction integration cases pass (43.05
seconds), using scripted local providers and retaining their original native,
admission and model-call assertions. Root32/32 and Windows root build pass.

The newly exposed `npm --prefix packages/gateway run test:historical-output-load`
was executed end to end: 9 size/round cases plus the parent pass (6.14 seconds),
with no competing busy failures. Final 200 MiB publication locks are 5.59–6.94 ms,
receipt locks 4.00–4.89 ms; publication elapsed 129.49–135.46 ms. The normal 75 ms
busy timeout is unchanged. See the measurement document for ranges and limits.
Do not confuse passing this local probe with all performance/storage acceptance.

Production flags remain off. Multi-file/cold/remote/retention and production
performance, consumer/event rollout and rollback, actual providers/money and
the full upstream capability inventory remain separate unfinished gates.
