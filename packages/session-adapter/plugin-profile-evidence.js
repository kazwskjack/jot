import {constants} from 'node:fs';
import {mkdir, open, lstat, realpath, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

const FILES = ['package.json','pnpm-lock.yaml','cordis.patch.yml','pnpm-workspace.yaml','compatibility.json'];
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => {throw new Error('plugin_profile_evidence_unavailable');};
const inside = (root, path) => {const value = relative(root, path); return value !== '..' && !value.startsWith('..'+sep) && !isAbsolute(value);};
const snapshotId = context => digest(JSON.stringify([context.ownerId,context.profileId,context.operation,context.operationId,context.actionSha256]));

async function privateDirectory(path) {
  try {await mkdir(path, {mode:0o700});} catch (error) {if (error.code !== 'EEXIST') throw error;}
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) fail();
}

/** Read one bounded, stable regular file under its already resolved directory. */
async function readSource(root, name, limit = MAX_FILE_BYTES) {
  const path = resolve(root, name);
  if (!inside(root, path)) fail();
  let info;
  try {info = await lstat(path, {bigint:true});} catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  if (!info.isFile() || info.isSymbolicLink() || !inside(root, await realpath(path))) fail();
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({bigint:true});
    if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino || before.size > BigInt(limit)) fail();
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat({bigint:true}), current = await lstat(path, {bigint:true});
    if (BigInt(bytesRead) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
      || current.mtimeNs !== before.mtimeNs || current.isSymbolicLink() || !inside(root, await realpath(path))) fail();
    return buffer.subarray(0, bytesRead);
  } finally {await handle.close();}
}

/** Private sampled evidence supplements the native package lock and restore lifecycle. */
export function createPluginProfileEvidence({binding, readIdentity, resolveBundleDirectory, parseYaml}) {
  if (typeof readIdentity !== 'function' || typeof resolveBundleDirectory !== 'function' || typeof parseYaml !== 'function') fail();
  const finishing = new Map();
  const check = () => {
    const current = readIdentity();
    if (current.ownerId !== binding.ownerId || current.profileId !== binding.profileId
      || current.profileDirectory !== binding.profileDirectory) fail();
  };
  const directory = context => {
    check();
    if (context.ownerId !== binding.ownerId || context.profileId !== binding.profileId) fail();
    return join(binding.profileDirectory, '.jot-plugin-snapshots', snapshotId(context));
  };
  async function capture(target, phase) {
    check();
    const folder = join(target, phase);
    await mkdir(folder, {mode:0o700});
    const files = [];
    for (const name of FILES) {
      const bytes = await readSource(binding.profileDirectory, name);
      if (bytes) await writeFile(join(folder, name), bytes, {flag:'wx',mode:0o600});
      files.push({name,present:bytes !== null,sha256:bytes === null ? null : digest(bytes)});
    }
    check();
    return {captured_at:new Date().toISOString(),files};
  }
  async function packageEvidence(target, name) {
    if (typeof name !== 'string' || name.length > 192 || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return null;
    const root = await realpath(resolveBundleDirectory(name));
    const bytes = await readSource(root, 'package.json', 1024 * 1024);
    if (!bytes) return null;
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.name !== name || typeof manifest.version !== 'string' || manifest.version.length > 128) fail();
    await writeFile(join(target, 'bundle-package.json'), bytes, {flag:'wx',mode:0o600});
    const declared = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type;
    const license = typeof declared === 'string' && declared.length <= 256 ? declared : null;
    const named = license?.match(/^SEE LICEN[CS]E IN (.+)$/i)?.[1];
    const candidates = [...new Set([...(named ? [named] : []),'LICENSE','LICENSE.md','LICENSE.txt','LICENCE','COPYING'])];
    let licenseHash = null;
    for (const candidate of candidates) {
      const content = await readSource(root, candidate, 1024 * 1024);
      if (content === null) continue;
      await writeFile(join(target, 'bundle-license'), content, {flag:'wx',mode:0o600});
      licenseHash = digest(content); break;
    }
    const lockBytes = await readSource(binding.profileDirectory, 'pnpm-lock.yaml');
    let integrity = null;
    if (lockBytes) {
      const lock = parseYaml(lockBytes.toString('utf8'));
      const value = lock?.packages?.[`${name}@${manifest.version}`]?.resolution?.integrity;
      if (typeof value === 'string' && value.length <= 2048 && /^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(value)) integrity = value;
    }
    check();
    return {name,version:manifest.version,manifest_sha256:digest(bytes),license,license_file_sha256:licenseHash,integrity};
  }
  async function finish(context, result) {
    const target = directory(context), id = snapshotId(context);
    const beforeBytes = await readSource(target, 'before.json', 64 * 1024);
    if (!beforeBytes) return null;
    await privateDirectory(join(binding.profileDirectory, '.jot-plugin-snapshots'));
    await privateDirectory(target);
    if (JSON.parse(beforeBytes.toString('utf8')).snapshot_id !== id) fail();
    const existing = await readSource(target, 'after.json', 64 * 1024);
    if (existing) return JSON.parse(existing.toString('utf8')).evidence;
    let after = null, bundle = null;
    try {
      after = await capture(target, 'after');
      bundle = await packageEvidence(target, result.bundle);
    } catch { /* Evidence remains incomplete without changing the known native operation result. */ }
    const evidence = {protocol:1,snapshot_id:id,consistency:'sampled',before:'captured',after:after ? 'captured' : 'unavailable',bundle};
    check();
    await writeFile(join(target, 'after.json'), JSON.stringify({evidence,snapshot:after})+'\n', {flag:'wx',mode:0o600});
    return evidence;
  }
  return Object.freeze({
    async begin(context) {
      const target = directory(context);
      await privateDirectory(join(binding.profileDirectory, '.jot-plugin-snapshots'));
      await mkdir(target, {mode:0o700});
      await privateDirectory(target);
      const snapshot = await capture(target, 'before');
      await writeFile(join(target, 'before.json'), JSON.stringify({snapshot_id:snapshotId(context),snapshot})+'\n', {flag:'wx',mode:0o600});
    },
    async finish(context, result) {
      const id = snapshotId(context);
      let pending = finishing.get(id);
      if (!pending) {
        pending = finish(context, result); finishing.set(id, pending);
        pending.finally(() => {if (finishing.get(id) === pending) finishing.delete(id);}).catch(() => {});
      }
      return pending;
    },
  });
}
