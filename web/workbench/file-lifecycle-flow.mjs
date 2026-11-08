const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validSource = source => !!source && typeof source === 'object' && typeof source.path === 'string' && !!source.path &&
  Number.isSafeInteger(source.version) && source.version > 0 && sha256(source.sha256) && Number.isSafeInteger(source.size) &&
  source.size >= 0 && typeof source.updated_at === 'string';
const validTarget = target => !!target && typeof target === 'object' && typeof target.path === 'string' && !!target.path &&
  Number.isSafeInteger(target.version) && target.version > 0 && sha256(target.sha256) && Number.isSafeInteger(target.size) && target.size >= 0;

export function lifecycleReceiptMatchesCommand(command, receipt) {
  if (!command || !receipt || typeof receipt !== 'object' || receipt.protocol !== 1 || receipt.action !== command.action ||
    receipt.command_key !== command.command_key || receipt.project_id !== command.project_id || receipt.workspace_id !== command.workspace_id ||
    receipt.preview_sha256 !== command.preview_sha256 || typeof receipt.applied_at !== 'string' || !validSource(receipt.source) ||
    receipt.source.path !== command.path || receipt.source.version !== command.expected_version || receipt.source.sha256 !== command.source_sha256 ||
    !Array.isArray(receipt.source_refs)) return false;
  if (command.action === 'rename') return validTarget(receipt.target) && receipt.target.path === command.target_path &&
    receipt.target.version === command.target_version && receipt.target.sha256 === command.source_sha256 && receipt.target.size === receipt.source.size &&
    Array.isArray(receipt.target_refs);
  return command.action === 'delete' && receipt.target === undefined && receipt.target_refs === undefined;
}

/** Read the immutable command status after an uncertain write. This helper never submits a mutation. */
export async function reconcileFileLifecycleCommand(command, readStatus) {
  try {
    const status = await readStatus(command);
    if (status?.state === 'not_applied') return { state: 'not_applied' };
    if (status?.state === 'applied' && lifecycleReceiptMatchesCommand(command, status.receipt)) {
      return { state: 'applied', receipt: status.receipt, reconciled: true };
    }
    return { state: 'unknown', error: new Error('file_lifecycle_status_invalid') };
  } catch (error) {
    return { state: 'unknown', error };
  }
}

/** Submit once, then use only the read-only status endpoint if the response is lost or invalid. */
export async function submitFileLifecycleCommand(command, { apply, status }) {
  try {
    const receipt = await apply(command);
    if (!lifecycleReceiptMatchesCommand(command, receipt)) throw new Error('file_lifecycle_receipt_invalid');
    return { state: 'applied', receipt, reconciled: false };
  } catch (applyError) {
    const result = await reconcileFileLifecycleCommand(command, status);
    if (result.state === 'applied') return result;
    if (result.state === 'not_applied') return { state: 'not_applied', applyError };
    return { state: 'unknown', applyError, statusError: result.error };
  }
}

const pendingCommandSchema = 'jot.workbench.pending-file-lifecycle.v1';
const pendingCommandStorageKey = scope => `workbench:file-lifecycle:${encodeURIComponent(scope.owner_scope)}:${encodeURIComponent(scope.workspace_id)}:${encodeURIComponent(scope.project_id)}`;
const validScope = scope => !!scope && typeof scope.owner_scope === 'string' && !!scope.owner_scope &&
  typeof scope.workspace_id === 'string' && !!scope.workspace_id && typeof scope.project_id === 'string' && !!scope.project_id;
const sameKeys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('\0') === Object.keys(expected).sort().join('\0') &&
  Object.keys(expected).every(key => value[key] === expected[key]);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

function validPendingCommand(command, scope) {
  if (!validScope(scope) || !command || typeof command !== 'object' || Array.isArray(command) ||
    !['rename', 'delete'].includes(command.action) || command.workspace_id !== scope.workspace_id || command.project_id !== scope.project_id ||
    typeof command.path !== 'string' || !command.path || !sha256(command.source_sha256) ||
    !Number.isSafeInteger(command.expected_version) || command.expected_version < 1 || !sha256(command.preview_sha256) ||
    typeof command.command_key !== 'string' || !command.command_key) return false;
  const commandKeys = ['action', 'workspace_id', 'project_id', 'path', 'source_sha256', 'expected_version', 'preview_sha256', 'command_key', 'body'];
  if (command.action === 'rename') commandKeys.push('target_path', 'target_version');
  if (!exactKeys(command, commandKeys)) return false;
  const expected = { project_id: command.project_id, path: command.path, expected_version: command.expected_version, preview_sha256: command.preview_sha256 };
  if (command.action === 'rename') {
    if (typeof command.target_path !== 'string' || !command.target_path || !Number.isSafeInteger(command.target_version) || command.target_version < 1) return false;
    expected.target_path = command.target_path;
  } else if (command.target_path !== undefined || command.target_version !== undefined) return false;
  return sameKeys(command.body, expected);
}

function readPendingRecord(storage, scope) {
  if (!storage || typeof storage.getItem !== 'function' || !validScope(scope)) return null;
  try {
    const raw = storage.getItem(pendingCommandStorageKey(scope));
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (!exactKeys(record, ['schema', 'owner_scope', 'workspace_id', 'project_id', 'command']) ||
      record.schema !== pendingCommandSchema || record.owner_scope !== scope.owner_scope ||
      record.workspace_id !== scope.workspace_id || record.project_id !== scope.project_id || !validPendingCommand(record.command, scope)) return null;
    return record.command;
  } catch { return null; }
}

export function readPendingFileLifecycleCommand(storage, scope) {
  return readPendingRecord(storage, scope);
}

export function readPendingFileLifecycleDialog(storage, scope) {
  const command = readPendingRecord(storage, scope);
  if (!command) return null;
  return {
    action: command.action,
    file: { path: command.path, version: command.expected_version, sha256: command.source_sha256 },
    resumeCommand: command,
  };
}

export function persistPendingFileLifecycleCommand(storage, scope, command) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || !validPendingCommand(command, scope)) return false;
  const key = pendingCommandStorageKey(scope);
  try {
    const existing = storage.getItem(key);
    if (existing) {
      const record = JSON.parse(existing);
      if (!exactKeys(record, ['schema', 'owner_scope', 'workspace_id', 'project_id', 'command']) ||
        record.schema !== pendingCommandSchema || record.owner_scope !== scope.owner_scope || record.workspace_id !== scope.workspace_id ||
        record.project_id !== scope.project_id || !validPendingCommand(record.command, scope) || record.command.command_key !== command.command_key ||
        JSON.stringify(record.command.body) !== JSON.stringify(command.body)) return false;
    }
    storage.setItem(key, JSON.stringify({
      schema: pendingCommandSchema,
      owner_scope: scope.owner_scope,
      workspace_id: scope.workspace_id,
      project_id: scope.project_id,
      command,
    }));
    return true;
  } catch { return false; }
}

export function clearPendingFileLifecycleCommand(storage, scope, commandKey) {
  const command = readPendingRecord(storage, scope);
  if (!command || command.command_key !== commandKey || typeof storage?.removeItem !== 'function') return false;
  try { storage.removeItem(pendingCommandStorageKey(scope)); return true; } catch { return false; }
}
