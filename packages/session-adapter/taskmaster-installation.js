import {createHash} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import {basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {readSource} from './plugin-profile-evidence.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;
const inside = (root, path) => {
  const value = relative(root, path);
  return value !== '..' && !value.startsWith('..' + sep) && !isAbsolute(value);
};

function packageForEntry(entry) {
  const pattern = process.platform === 'win32'
    ? /^(.*[\\/]node_modules[\\/]task-master-ai)[\\/]/is
    : /^(.*\/node_modules\/task-master-ai)\//s;
  return pattern.exec(entry)?.[1] ?? null;
}

/** Resolve installed CLI links and literal Node package-manager shims as data. */
async function taskmasterPathSource(signal) {
  const pathValue = process.env.PATH ?? '';
  const checkEnvironment = () => {
    signal.throwIfAborted();
    if ((process.env.PATH ?? '') !== pathValue) throw Error('taskmaster_path_changed');
  };
  const directories = [...new Set(pathValue.split(delimiter).map(path => path.replace(/^"|"$/g, ''))
    .filter(isAbsolute).map(path => resolve(path)))];
  if (directories.length > 256) throw Error('taskmaster_path_unconfirmed');
  const names = process.platform === 'win32'
    ? ['task-master.com', 'task-master.exe', 'task-master.bat', 'task-master.cmd', 'task-master.ps1', 'task-master']
    : ['task-master'];
  for (const directory of directories) {
    for (const name of names) {
      checkEnvironment();
      const candidate = join(directory, name);
      let executable;
      try { executable = await realpath(candidate); }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
      const info = await lstat(executable);
      if (!info.isFile() || process.platform !== 'win32' && !(info.mode & 0o111)) continue;
      const commandDirectory = await realpath(directory);
      let entry = executable, packageDirectory = packageForEntry(entry), wrapperHash = null;
      const wrapperRoot = dirname(executable), wrapperName = basename(executable);
      if (!packageDirectory) {
        const bytes = await readSource(wrapperRoot, wrapperName, 65536);
        if (!bytes) throw Error('taskmaster_path_unconfirmed');
        wrapperHash = hash(bytes);
        const wrapper = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        const references = wrapper.matchAll(/(?:\$basedir|%dp0%|%~dp0)[\\/]([^"\r\n$%]+)"/gi);
        for (const match of references) {
          const parts = match[1].split(/[\\/]/);
          if (!parts.some(part => pathKey(part) === 'task-master-ai')) continue;
          try { entry = await realpath(resolve(commandDirectory, ...parts)); }
          catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
          packageDirectory = packageForEntry(entry);
          if (packageDirectory) break;
        }
      }
      if (!packageDirectory) throw Error('taskmaster_path_unconfirmed');
      return {packageDirectory, entry, checkEnvironment, async assertCurrent() {
        checkEnvironment();
        if (pathKey(await realpath(directory)) !== pathKey(commandDirectory)) throw Error('taskmaster_path_changed');
        if (pathKey(await realpath(candidate)) !== pathKey(executable)) throw Error('taskmaster_path_changed');
        if (wrapperHash !== null) {
          const current = await readSource(wrapperRoot, wrapperName, 65536);
          if (!current || hash(current) !== wrapperHash) throw Error('taskmaster_path_changed');
        }
        checkEnvironment();
      }};
    }
  }
  return {packageDirectory: null, checkEnvironment};
}

/** Observe the selected owner's installed package without loading its code. */
async function selectTaskmasterInstallation({ownerId, readIdentity, signal}) {
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
  async function observePackage(selected, scope, expectedEntry) {
    check();
    let directory;
    try { directory = await realpath(selected); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (scope === 'owner_profile' && !inside(binding.profileDirectory, directory)) throw Error('taskmaster_package_unconfirmed');
    const bytes = await readSource(directory, 'package.json', 65536);
    if (!bytes) throw Error('taskmaster_package_unconfirmed');
    const manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    const entry = manifest?.bin?.['task-master'];
    if (manifest?.name !== 'task-master-ai' || typeof manifest.version !== 'string'
      || !/^[0-9][A-Za-z0-9.+-]{0,127}$/.test(manifest.version)
      || typeof entry !== 'string' || !entry || entry.length > 1024 || isAbsolute(entry)
      || entry.includes('\0')) throw Error('taskmaster_package_unconfirmed');
    const entryPath = resolve(directory, entry);
    if (!inside(directory, entryPath)) throw Error('taskmaster_package_unconfirmed');
    const actualEntry = await realpath(entryPath);
    if (!inside(directory, actualEntry) || expectedEntry && pathKey(actualEntry) !== pathKey(expectedEntry)) {
      throw Error('taskmaster_cli_entry_unconfirmed');
    }
    const cli = await readSource(directory, entry, 1048576);
    if (!cli || cli.length === 0) throw Error('taskmaster_package_unconfirmed');
    const current = await readSource(directory, 'package.json', 65536);
    if (!current || hash(current) !== hash(bytes) || await realpath(selected) !== directory) {
      throw Error('taskmaster_package_changed');
    }
    return {entry: actualEntry, cwd: binding.profileDirectory, observation: result('available', {scope, version: manifest.version,
      license: typeof manifest.license === 'string' && manifest.license.length <= 128 ? manifest.license : null,
      manifest_sha256: hash(bytes), cli_entry_sha256: hash(cli)}), async assertCurrent() {
      check();
      const currentManifest = await readSource(directory, 'package.json', 65536), currentEntry = await readSource(directory, entry, 1048576);
      if (!currentManifest || !currentEntry || hash(currentManifest) !== hash(bytes) || hash(currentEntry) !== hash(cli)
        || await realpath(selected) !== directory || await realpath(entryPath) !== actualEntry) throw Error('taskmaster_package_changed');
      check();
    }};
  }
  const profile = await observePackage(join(binding.profileDirectory, 'node_modules', 'task-master-ai'), 'owner_profile');
  if (profile) return profile;
  const pathSource = await taskmasterPathSource(signal);
  if (!pathSource.packageDirectory) {
    pathSource.checkEnvironment();
    return {observation: result('missing', {scope: 'profile_and_path'})};
  }
  await pathSource.assertCurrent();
  const observation = await observePackage(pathSource.packageDirectory, 'host_path', pathSource.entry);
  if (!observation) throw Error('taskmaster_path_changed');
  await pathSource.assertCurrent();
  pathSource.checkEnvironment();
  check();
  return {...observation, async assertCurrent() {await pathSource.assertCurrent(); await observation.assertCurrent(); await pathSource.assertCurrent(); check();}};
}

export async function readTaskmasterInstallation(options) {return (await selectTaskmasterInstallation(options)).observation;}

function runVersion(selected, signal) {
  signal.throwIfAborted();
  const env = {};
  for (const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, [selected.entry, '--version'], {
      cwd: selected.cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'],
    });
    const chunks = [];
    let size = 0, failure = null, cleanup = Promise.resolve();
    const stop = reason => {
      if (failure) return;
      failure = reason;
      if (process.platform === 'win32' && child.pid) {
        cleanup = new Promise(done => {
          const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          execFile(executable, ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, timeout: 5000, maxBuffer: 65536}, error => {
            if (error) {failure = 'cleanup_unconfirmed'; child.kill('SIGKILL');}
            done();
          });
        });
      } else {
        try {if (child.pid) process.kill(-child.pid, 'SIGKILL');}
        catch {child.kill('SIGKILL');}
      }
    };
    const aborted = () => stop('cancelled');
    signal.addEventListener('abort', aborted, {once: true});
    const timer = setTimeout(() => stop('timeout'), 15000);
    timer.unref();
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 65536) {stop('output_limit'); return;}
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {size += chunk.length; if (size > 65536) stop('output_limit');});
    child.once('error', () => {failure ??= 'spawn_failed';});
    child.once('close', async code => {
      clearTimeout(timer);signal.removeEventListener('abort', aborted);await cleanup;
      if (process.platform !== 'win32' && child.pid) {
        try {process.kill(-child.pid, 'SIGKILL');}
        catch (error) {if (error.code !== 'ESRCH') failure = 'cleanup_unconfirmed';}
      }
      const bytes = Buffer.concat(chunks), stdout_sha256 = hash(bytes);
      let version = null;
      try {
        const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        const versions = [...new Set([...text.matchAll(/^\s*(?:(?:task-master(?:-ai)?|Task Master(?: AI)?)\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/gim)].map(match => match[1]))];
        if (versions.length === 1 && versions[0].length <= 128) version = versions[0];
      } catch {}
      const reason_code = failure ?? (code !== 0 ? 'cli_failed' : version === null ? 'version_output_unconfirmed' : null);
      resolveResult({status: reason_code === null ? 'observed' : 'failed', runtime_version: reason_code === null ? version : null,
        stdout_sha256, exit_code: Number.isSafeInteger(code) && code >= 0 ? code : null, reason_code});
    });
    if (signal.aborted) aborted();
  });
}

/** One bounded probe per adapter. Keep ownership until the process closes. */
export function createTaskmasterRuntimeVersionReader({readIdentity}) {
  const lifetime = new AbortController();
  let active = null, closed = false;
  async function observe(ownerId, expected, signal) {
    const current = AbortSignal.any([signal, lifetime.signal]);
    const selected = await selectTaskmasterInstallation({ownerId, readIdentity, signal: current});
    const installation = selected.observation;
    if (installation.status !== 'available' || installation.profile_id !== expected.profile_id
      || installation.manifest_sha256 !== expected.manifest_sha256 || installation.cli_entry_sha256 !== expected.cli_entry_sha256) throw Error('taskmaster_package_changed');
    await selected.assertCurrent();current.throwIfAborted();
    const runtime = await runVersion(selected, current);
    await selected.assertCurrent();
    return {protocol: 1, owner_id: ownerId, profile_id: installation.profile_id, manifest_sha256: installation.manifest_sha256,
      cli_entry_sha256: installation.cli_entry_sha256, declared_version: installation.version, ...runtime,
      observed_at: new Date().toISOString(), execution_authorized: false};
  }
  return Object.freeze({read(ownerId, expected, signal) {
    if (closed) return Promise.reject(Error('taskmaster_runtime_closed'));
    if (active) return Promise.reject(Error('taskmaster_runtime_busy'));
    const pending = observe(ownerId, expected, signal);active = pending;
    pending.then(() => {if (active === pending) active = null;}, () => {if (active === pending) active = null;});
    return pending;
  }, async close() {closed = true;lifetime.abort(Error('taskmaster_runtime_closed'));await active?.catch(() => {});}});
}

