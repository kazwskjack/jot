/** Placement and lineage used when resolving one exact persisted native Session. */
export function sessionHeaderIdentity(header) {
  return JSON.stringify([header?.id,header?.cwd,header?.agentPreset,header?.createdAt,
    header?.parentSession,header?.origin,header?.delegationDepth,header?.isSeeded]);
}
