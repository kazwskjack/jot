const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const identifier = value => typeof value === 'string' && ID.test(value);
const SHA = /^[a-f0-9]{64}$/;
const invalid = () => { throw Error('检查点原请求存储尚未确认'); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
 && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const relativePath = value => typeof value === 'string' && !!value && value.length <= 4096
 && !value.startsWith('/') && !/[\\:\x00-\x1f\x7f]/.test(value)
 && value.split('/').every(part => !!part && part !== '.' && part !== '..');
const revision = value => Number.isSafeInteger(value) && value >= 0;
const noAuthority = value => value?.execution_authorized === false && value.restore_authorized === false;

// Same-tab refresh hints retain the original command, never a restore approval.
export class CheckpointCommandStore {
 constructor(storage, scope, workspace, project) {
  if (!SHA.test(scope) || !identifier(workspace) || !identifier(project)) invalid();
  this.storage = storage;
  this.workspace = workspace;
  this.project = project;
  this.prefix = `/workspaces/${encodeURIComponent(workspace)}/checkpoints`;
  this.name = `jot-checkpoint-command:v1:${scope}:${encodeURIComponent(workspace)}:${encodeURIComponent(project)}`;
 }
 validate(command) {
  if (!exact(command, ['path', 'method', 'body', 'key']) || command.method !== 'POST'
   || typeof command.key !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(command.key)) invalid();
  const body = command.body;
  if (command.path === this.prefix) {
   if (!exact(body, ['project_id', 'paths']) || body.project_id !== this.project
    || !Array.isArray(body.paths) || !body.paths.length || body.paths.length > 50000
    || body.paths.some(path => !relativePath(path))) invalid();
   return {kind: 'create'};
  }
  const match = /^\/workspaces\/[^/]+\/checkpoints\/([^/]+)\/restore-review$/.exec(command.path);
  let checkpoint;
  try { checkpoint = match && decodeURIComponent(match[1]); } catch { invalid(); }
  if (!checkpoint || !identifier(checkpoint)
   || command.path !== `${this.prefix}/${encodeURIComponent(checkpoint)}/restore-review`
   || !exact(body, ['project_id', 'path']) || body.project_id !== this.project || !relativePath(body.path)) invalid();
  return {kind: 'review', checkpoint};
 }
 read() {
  const raw = this.storage.getItem(this.name);
  if (raw === null) return null;
  const command = JSON.parse(raw);
  this.validate(command);
  return {command};
 }
 saveCommand(command, expected) {
  if (command === null) { this.complete(expected); return; }
  this.validate(command);
  const prior = this.read()?.command;
  if (prior && JSON.stringify(prior) !== JSON.stringify(command)) invalid();
  this.storage.setItem(this.name, JSON.stringify(command));
 }
 complete(expected) {
  const prior = this.read()?.command;
  if (!expected || prior && JSON.stringify(prior) !== JSON.stringify(expected)) invalid();
  if (prior) this.storage.removeItem(this.name);
 }
}

export function checkpointCommandTransport(store, send, current) {
 return async (path, method, body, key) => {
  if (!store || !current()) invalid();
  const command = {path, method, body, key};
  const descriptor = store.validate(command);
  if (JSON.stringify(store.read()?.command) !== JSON.stringify(command)) invalid();
  let value;
  try { value = await send(path, method, body, key); }
  catch (error) {
   // A recorded intent can survive a rejected or lost reply. Preserve its key.
   throw new Error(error instanceof Error ? error.message : '检查点原请求结果待确认', {cause: error});
  }
  if (!current() || !noAuthority(value) || value.project_id !== store.project || value.workspace_id !== store.workspace) invalid();
  if (descriptor.kind === 'create') {
   const receipt = value.receipt;
   const paths = [...body.paths].sort();
   if (!identifier(value.checkpoint_id) || !['ready', 'pruned'].includes(value.state)
    || !revision(value.source_revision) || !SHA.test(value.manifest_sha256)
    || JSON.stringify(value.paths) !== JSON.stringify(paths)
    || value.manifest?.protocol !== 2 || value.manifest.provider !== 'snapshot-copy'
    || JSON.stringify(value.manifest.paths) !== JSON.stringify(paths) || !Array.isArray(value.manifest.entries)
    || !noAuthority(receipt) || receipt.protocol !== 1 || receipt.status !== 'ready'
    || receipt.checkpoint_id !== value.checkpoint_id || receipt.project_id !== store.project
    || receipt.workspace_id !== store.workspace || receipt.source_revision !== value.source_revision
    || receipt.manifest_sha256 !== value.manifest_sha256 || !identifier(receipt.snapshot_id)
    || typeof receipt.created_at !== 'string' || !Number.isFinite(Date.parse(receipt.created_at))) invalid();
  } else {
   const state = item => item?.path === body.path && (item.kind === 'absent'
    || item.kind === 'file' && Number.isSafeInteger(item.version) && item.version > 0
     && SHA.test(item.sha256) && revision(item.size) && item.executable === false);
   if (value.checkpoint_id !== descriptor.checkpoint || value.path !== body.path
    || !identifier(value.review_id) || !SHA.test(value.review_sha256) || !revision(value.expected_revision)
    || !state(value.before) || !state(value.target)
    || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) invalid();
  }
  return {kind: descriptor.kind, value};
 };
}
