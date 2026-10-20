# Original native Git local transport

Continue the existing Git index implementation through the original owning
native Host. DSH remains the planner. Review, admission, ownership, project
reservations, Worker leases and effects stay in the existing database and
executor. No request may provide a native context, workspace root, membership,
SQL, model configuration or an alternate executor.

The first executable integration is a local authenticated pipe/socket between
the original Gateway and native processes sharing one configured physical
database and checkout. A transport response is not an approval. The native
process revalidates original database authority inside `performReserved`, holds
actual native maintenance and retains unknown results instead of replaying.
Remote hosts with separate filesystems do not satisfy this composition.

1. Add bounded local transport with exact ID-only messages, authentication,
   redacted errors, cancellation and drain. Never expose a TCP listener.
2. Retain and recheck the original database file identity at dispatch and inside
   the original synchronous native guard. Missing/replaced files fail closed.
3. Mount that transport beside the original Host/factory/admission references;
   use the existing executor, not another native runtime. Defaults remain off.
4. Commit actual separate-process acceptance against the original review and
   admission, real Git stage/unstage and original cancellation in the shared DB.
   Include connection loss/shutdown and rejected messages. Synthetic providers
   may prove runtime custody, never external model quality.
5. Only after source/publication and lifecycle closure, connect the original
   HTTP/BFF operation manifest and mobile controls. Broader commits, remote Git,
   destructive operations and checkpoint restore need their own original
   intents and acceptance; this transport does not enable them.

Run appropriate adapter/real-SDK/Gateway tests, builds and disclosure review
before publishing. Distinguish transport acceptance from product activation.
