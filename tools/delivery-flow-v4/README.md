# R4 delivery tools

This versioned directory serves R4 only. The original `tools/delivery-flow-v1/`
entrypoint, source bytes and R3 release/profile/pins remain in place for R3.
Use the R-published `tool_entrypoint.py --profile r4` release; an unavailable
release must reject execution. A policy or descriptor grants no runner or OS permission.

The entrypoint consumes the current policy path/hash from R's fixed
`decision-standing-policy-pin.json`. Historical preparation-policy hashes and
caller-selected policy hashes do not establish current authority. Policy validity
is preparation validity, never a product trial start/end.

`local_freeze` freezes finite changed source, test and lock identities. Source
review v2 binds the original task, reviewer14 identity/report root, exact file
pre/post blobs and postimage hashes, patch bytes and test/lock pins. An unrelated
target HEAD does not change this source acceptance. No test result or original AC
credit is inferred from a source-only packet.

Queue claim projects the reviewed patch into a private index/object store at the
actual clean target HEAD. Only object IDs and hunk offsets may differ; changed
source/context/mode bytes, overlap or pinned test/lock drift require incremental
review. The source READY remains unchanged. The application hash prevents replay
through relabelled packets/trials or failed/unknown outcomes in the same ledger.

Record retains original source candidate/tree/manifest identity and verifies the
actual integration parent, tree and delta against the claim's `target_base`,
`target_tree` and `target_delta_sha256`. Queue does not write the integration
checkout or execute tests; writer13 installs only separately authorized exact bytes.

The preserved-R3 non-help regression calls the actual original v1 entrypoint and
its real existing R3 release. It does not pair new R4 files with an old synthetic
manifest or claim that such a fixture proves historical production compatibility.
Product START, formal AC, provider actions and runner execution remain outside
tools-only preparation.
