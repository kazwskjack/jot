# Original publication storage: explicit offline maintenance

This command packages the existing original workspace coordinator upgrade and
publication intent/execution/journal installers. It adds no HTTP migration,
background scheduler, lease repair, planner, user identity or execution grant.
It must run as a trusted local administrator after every service using the
physical database has stopped. A command-line acknowledgement is an operator
attestation; the program cannot observe idle external pools stopping. Every
success receipt therefore retains `offline_pool_drain_observed: false` and
`execution_authorized: false`.

## Operation

1. Stop Gateway, task/file workers, native Hosts and any maintenance process that
   can reopen the database. Drain original in-flight work using its existing
   lifecycle; this command refuses even expired recorded leases and unresolved
   workspace, budget or producer facts. It never deletes them to make progress.
2. Create and independently verify an offline backup using the existing
   [host backup procedure](../../HOST-BACKUP.md). Retain its trusted digest and
   original private roots outside the public repository.
3. Build the Gateway locally. From its package directory, run:

   ```text
   node dist/src/maintenance/publication-maintenance-main.js inspect ABSOLUTE_DATABASE
   ```

   Only an existing canonical single-link WAL database is accepted. Inspection
   uses a read-only connection and never creates missing storage. The receipt
   reports the original database identity hash, coordinator schema and publication
   storage state; it includes no path, user row or credential.
4. Review the result, then explicitly apply to that same physical database:

   ```text
   node dist/src/maintenance/publication-maintenance-main.js apply ABSOLUTE_DATABASE EXPECTED_DATABASE_SHA --confirm-offline
   ```

   The command checks the original identity and quiescence before upgrade and
   again under the original immediate installer transaction. Original table
   replacement retains its own SQLite migration transaction and FK checks.
   Storage bootstrap reuses the original installers. Existing publication tables,
   indexes and triggers must exactly match their original definitions; missing
   pieces can resume, while incompatible or extra objects refuse.
5. Reinspect before restarting services. An already current database remains
   unchanged. If installation fails after the coordinator's separately committed
   upgrade, do not claim that upgrade rolled back. Inspect the original database
   and resume only compatible original partial storage, after resolving the real
   blocker. Never replace receipts, suppress integrity checks or clear leases.
6. Configure authenticated original native IPC separately, then perform deployment
   acceptance before enabling user writes. Maintenance success does not prove
   that the installed model, original native profile or production pool is ready.

Source execution uses the equivalent `src/maintenance/publication-maintenance-main.ts`
entry on the supported Node version. Unknown flags, missing confirmation and
extra arguments refuse. Errors are bounded codes; supplied arguments and stack
traces are not echoed by this CLI.

## Local evidence

The seven maintenance cases and fourteen original upgrade cases passed together
(21/21, no skips). They cover absent/read-only inspection, exact identity and
offline acknowledgement, current-schema live-lease refusal, partial storage,
unexpected immutable triggers, hard-linked/non-WAL inputs and the actual
administrator child process preserving finalized source proofs, versions, bytes
and task records. The original suite also retains real process-loss rollback,
FK/trigger retention and pending-admission exclusion.

Gateway typecheck/build passed. A separate compiled-CLI smoke test bootstrapped
and reinspected a synthetic physical WAL database, preserved its project row and
repeated as already current without exposing paths. The five candidate files
were then integrated only after their original main-file hashes matched and the
preceding Apply/UI increment was published. The integrated focused suite passed 21/21. The frozen whole Gateway suite passed
2,231 of 2,238 cases with seven conditional skips and zero failures/cancellations,
with the SDK enabled and source hashes unchanged. Root67, Gateway typecheck/build,
frontend build and all six disclosure-verifier tests passed. The compiled CLI
was also exercised from the integrated build, preserving the project and
repeating as already current. Source candidates scanned clean; exact staged
and Git-history review remains a distinct publication gate.

The three initial restricted-account root failures came from denied loopback
connections (`EACCES`); the same unchanged code passed67 in the authorized local
context. Filesystem tests also require permission for their synthetic hard
links. No product/test guard was weakened. No production database or deployed
service has been changed.
