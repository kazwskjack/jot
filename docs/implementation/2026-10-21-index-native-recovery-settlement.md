# Original native index recovery settlement

Private continuation of the original index Apply/recovery plan. DSH remains the
only planner. Reuse the original physical DB, owner, review, operation/control,
producer, Worker, reservation, family and native admission records. This does
not activate public index writes or finish capability15/the all26 ledger.

## Shared original validation

`index-journal.ts` extracts the original execution row, preparation, dispatch,
result, disposition, acceptance and control-receipt validation. The original
execution service delegates to these readers. Original intent views are shared
through `intent-reads.ts`, and producer record validation is extracted from the
existing producer service. These readers have no constructors/installers,
migrations, leases or filesystem effects. They are internal facts, not grants.

Settlement uses these exact readers through `index-settlement.ts`; it does not
substitute weaker JSON/digest checks or instantiate a service while reading.
Original current ownership, UI admission and binding remain required. Legacy
applied settlement retains its original six-field record shape.

## Explicit-control release

After the original cleanup callback and native final source checks/drain return,
the coordinator rechecks original owner/control, sealed family/placements,
physical root witnesses and exact recovery Worker. Its final transaction removes
only that lease, validates the original completed control/result/producer facts,
and writes the original settlement plus reservation release atomically.

Explicit-control settlements use protocol2/kind `git_index_control` inside the
existing settlement table. They bind the original command/control/receipt hashes,
actual result state and cleanup classification. Original producer/finish hashes
are preserved; genuinely absent facts remain null. A replacement lease never
manufactures a finish for an interrupted original producer. Unknown cleanup is
not rollback or a renewed permission to execute.

A stored physical control, an applied outcome or an expired Worker alone cannot
release the hold. Any recorded lease blocks the owning settlement helper until
the owning service releases its exact lease after successful native drain.
Failed final writes leave the reservation held; the same command can reacquire
fresh custody and finish that transaction. After proven settlement, exact replay
reads the validated original receipt without a lease, callback, write or hold.
Foreign/replacement commands cannot borrow the settled receipt.

The existing reservation view validates the new proof against original journal
facts. Rehashing an altered cleanup/result projection cannot turn it into a
valid original settlement. Current ownership is still checked before recovery
or historical UI responses.

## Executed evidence

- Four shared-reader cases first reproduced the missing extracted module, then
  passed in the authorized local user context. The restricted-context hard-link
  EPERM log is preserved separately; no ACL or effect test was weakened.
- Three native settlement cases first failed because successful cleanup still
  retained the reservation and no settlement write occurred.
- The connected source passed 29 tests with installed DSH SDK enabled, zero
  failures/cancellations/skips: journal reads, native cleanup and original control
  recovery, new settlement/replay/write-loss behavior and publication schema
  upgrade compatibility. This includes proving an applied index whose original
  finish write was lost, without recreating that finish or rewriting the index.
- Local Gateway typecheck and build passed after the settlement connection.
- The expanded related regression completed with 71 passes, zero failures,
  cancellations or skips. It includes expired-Worker rejection, rehashed
  receipt/settlement drift, historical roots and old index lifecycle cases.
- Existing separate-process native index/publication and authenticated transport
  clients passed five tests against the fresh local build with SDK enabled and
  no skips. This proves compatibility of the existing transport, not the still
  unconnected new index-control IPC. No production/model calls occurred.

## Remaining before public activation/release

1. Connect explicit index controls to authenticated IPC and prove process exits
   before/after physical cleanup, control receipt and final settlement; response
   loss must not replay effects or invent native drain.
2. Preserve the now-connected offline maintenance and ownership-transfer
   semantics described in [IPC/maintenance evidence](2026-10-21-index-control-ipc-and-maintenance.md).
   A validated original settlement is historical drain evidence; an absent
   original producer finish must remain absent. Current-owner authority is
   still required at original API/effect entry points.
3. Connect original atomic HTTP admission/history/control projections and mobile
   UI. Do not classify physical control completion as final release before its
   original settlement is recorded. Preserve owner/CSRF/cancellation and exact
   command recovery through reload/another device.
4. Integrate only baseline-verified source files, then run full Gateway/root/UI
   checks, local builds, disclosure/history review and exact non-force remote
   verification. Private logs, fixtures' DBs, runtime caches and snapshots stay
   outside publication. Continue all remaining product and Git workflows.
