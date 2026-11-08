import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {basename, dirname, isAbsolute, resolve, sep} from 'node:path';

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BINDING_FILE = '.jot-owner-binding.json';

function fail(code) { throw Object.assign(new Error(code), {code}); }

function profileIdentity(directory) {
  const canonical = realpathSync(directory);
  const normalized = process.platform === 'win32' ? canonical.replaceAll('/', '\\').toLowerCase() : canonical;
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 48);
  return `dsh-profile-${digest}`;
}

/** Derive a stable Host profile identity from its canonical installed directory. */
export function dshProfileIdForDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('plugin_profile_binding_invalid');
  try { return profileIdentity(resolve(directory)); } catch { fail('plugin_profile_binding_invalid'); }
}

/** Read the owner binding written by Host provisioning from the selected profile. */
export function resolveOwnerBoundDshProfile(installAnchor) {
  if (typeof installAnchor !== 'string' || !isAbsolute(installAnchor)) fail('plugin_profile_binding_missing');
  let anchor, manifest, bindingPath, bindingRealPath, bindingInfo, binding;
  try {
    anchor = realpathSync(installAnchor);
    if (basename(anchor) !== 'package.json') fail('plugin_profile_binding_invalid');
    manifest = JSON.parse(readFileSync(anchor, 'utf8'));
    if (manifest?.name !== 'jot-dsh-host-profile' || manifest?.version !== '0.1.0'
      || manifest?.dependencies?.['@deepseek-ai/dsh'] !== '0.2.1-rc.2') fail('plugin_profile_binding_invalid');
    bindingPath = resolve(dirname(anchor), BINDING_FILE);
    bindingInfo = lstatSync(bindingPath);
    bindingRealPath = realpathSync(bindingPath);
    if (!bindingInfo.isFile() || bindingInfo.isSymbolicLink() || dirname(bindingRealPath) !== dirname(anchor)) fail('plugin_profile_binding_invalid');
    binding = JSON.parse(readFileSync(bindingPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'plugin_profile_binding_invalid') throw error;
    if (error?.code === 'ENOENT') fail('plugin_profile_binding_missing');
    fail('plugin_profile_binding_invalid');
  }
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)
    || Object.keys(binding).sort().join(',') !== 'owner_id,protocol'
    || binding.protocol !== 1 || typeof binding.owner_id !== 'string' || !OWNER_ID.test(binding.owner_id)) {
    fail('plugin_profile_binding_invalid');
  }
  const profileDirectory = dirname(anchor);
  if (dirname(bindingPath) !== profileDirectory || sep === '\\' && dirname(bindingRealPath).toLowerCase() !== profileDirectory.toLowerCase()) {
    fail('plugin_profile_binding_invalid');
  }
  return Object.freeze({ownerId: binding.owner_id, profileId: profileIdentity(profileDirectory), profileDirectory});
}

/** Write a one-owner binding while preparing a new, not-yet-activated profile. */
export function writeOwnerBoundDshProfile(directory, ownerId) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || typeof ownerId !== 'string' || !OWNER_ID.test(ownerId)) {
    fail('plugin_profile_binding_invalid');
  }
  const profileDirectory = realpathSync(resolve(directory));
  const anchor = realpathSync(resolve(profileDirectory, 'package.json'));
  if (dirname(anchor) !== profileDirectory) fail('plugin_profile_binding_invalid');
  writeFileSync(resolve(profileDirectory, BINDING_FILE), `${JSON.stringify({protocol: 1, owner_id: ownerId})}\n`, {flag: 'wx'});
  return Object.freeze({ownerId, profileId: profileIdentity(profileDirectory), profileDirectory});
}

export const DSH_PROFILE_OWNER_BINDING_FILE = BINDING_FILE;

/** Resolve only the Host-selected profile; installAnchor belongs to the DSH runtime package. */
export function resolveOwnerBoundDshProfileContext(profileContext) {
  if (typeof profileContext?.dir !== 'string' || !isAbsolute(profileContext.dir)) fail('plugin_profile_binding_missing');
  return resolveOwnerBoundDshProfile(resolve(profileContext.dir, 'package.json'));
}
