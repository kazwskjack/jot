import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';
import {readSource} from './plugin-profile-evidence.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value);
};

/** Observe the selected owner's installed package without loading its code. */
export async function readTaskmasterInstallation({ownerId, readIdentity, signal}) {
  signal.throwIfAborted();
  const binding = readIdentity();
  if (binding.ownerId !== ownerId) throw Error('taskmaster_profile_forbidden');
  const check = () => {
    signal.throwIfAborted();
    const current = readIdentity();
    if (current.ownerId !== ownerId || current.profileId !== binding.profileId
      || current.profileDirectory !== binding.profileDirectory) throw Error('taskmaster_profile_changed');
  };
  const result = (status, fields) => {
    check();
    return {protocol: 1, owner_id: ownerId, profile_id: binding.profileId, scope: 'owner_profile',
      status, version: null, license: null, manifest_sha256: null, cli_entry_sha256: null,
      reason_code: status === 'missing' ? 'package_not_installed' : null, ...fields,
      observed_at: new Date().toISOString(), execution_authorized: false};
  };
  const selected = join(binding.profileDirectory, 'node_modules', 'task-master-ai');
  let directory;
  try {
    directory = await realpath(selected);
  } catch (error) {
    if (error.code === 'ENOENT') return result('missing');
    throw error;
  }
  if (!inside(binding.profileDirectory, directory)) throw Error('taskmaster_package_unconfirmed');
  const bytes = await readSource(directory, 'package.json', 65536);
  if (!bytes) throw Error('taskmaster_package_unconfirmed');
  const manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  const entry = manifest?.bin?.['task-master'];
  if (manifest?.name !== 'task-master-ai' || typeof manifest.version !== 'string'
    || !/^[0-9][A-Za-z0-9.+-]{0,127}$/.test(manifest.version)
    || typeof entry !== 'string' || !entry || entry.length > 1024 || isAbsolute(entry)
    || entry.includes('\0')) throw Error('taskmaster_package_unconfirmed');
  const cli = await readSource(directory, entry, 1048576);
  if (!cli || cli.length === 0) throw Error('taskmaster_package_unconfirmed');
  const current = await readSource(directory, 'package.json', 65536);
  if (!current || hash(current) !== hash(bytes) || await realpath(selected) !== directory) {
    throw Error('taskmaster_package_changed');
  }
  return result('available', {version: manifest.version,
    license: typeof manifest.license === 'string' && manifest.license.length <= 128 ? manifest.license : null,
    manifest_sha256: hash(bytes), cli_entry_sha256: hash(cli)});
}
