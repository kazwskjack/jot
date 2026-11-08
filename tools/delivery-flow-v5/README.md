# R5 delivery tools

This directory is the isolated R5 namespace. Its entrypoint accepts only the R5
profile. It reads the fixed profile pin and hashes the R5 scope profile,
assignments, and path policy before it reads the release manifest named by that
profile. It never falls back to the R4 or v1 entrypoint.

R publishes `docs/diagnostics/delivery-flow-v5-20261025/decision-tools-release.json`
and its sibling `decision-tools-release-pin.json` only after exact source review
and integration. The pin fixes the manifest's profile, path, and SHA-256. The
release pins its shared commit/tree, entrypoint, every tool and imported support
file, reviewed file inventory, and review receipts. A missing or mismatched pin
or release rejects tool execution.

R5 support libraries are included in the same release inventory. A caller can
load the native receipt verifier through `load_r5_support("native_receipt")`;
the loader verifies the full release, then loads `authority.py` before
`native_receipt.py` from the same pinned directory. This does not add a metrics
command to the CLI.

For `freeze`, `preflight`, and `queue`, the entrypoint binds the standing source
policy path and hash from the fixed R5 policy pin. Preparation scope remains
separate from product START. Product scope requires the independent immutable
R5 trial start pin and snapshot to agree with the live phase state for exactly
7,200 seconds.

`local_freeze` records finite source, test, and lock identities. Exact source
review binds task ownership, reviewer 14, file preimages/postimages, patch bytes,
and tests. Queue projects a reviewed patch in a private index at the clean shared
target base; it does not write the shared checkout or execute candidate code.
The guard checks declared paths and roles but is not an OS sandbox or permission
issuer. No source packet or tool release grants runner, provider, production, or
formal acceptance authority.
