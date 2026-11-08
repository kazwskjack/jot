const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyPattern = /^[\x21-\x7e]{8,128}$/;
const base = '/plugin-profile/bundles';
const fail = code => { throw new Error(code); };
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

export function validatePluginProfileResult(value) {
  if (!exact(value, ['application','changed','stage','bundle','version','restartReason','failedAt','error','packageResult'])
    || !['applied','restart-required','overridden','failed','cancelled'].includes(value.application)
    || typeof value.changed !== 'boolean') fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
  for (const key of ['stage','bundle','version','restartReason','failedAt']) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 192)) fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
  }
  if (value.error !== undefined && (!exact(value.error, ['code']) || typeof value.error.code !== 'string'
    || !/^[A-Za-z0-9._-]{1,96}$/.test(value.error.code))) fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
  if (value.packageResult !== undefined) {
    const result = value.packageResult;
    if (!exact(result, ['exitCode','kind','timedOut']) || !Number.isSafeInteger(result.exitCode)
      || result.kind !== undefined && (typeof result.kind !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(result.kind))
      || result.timedOut !== undefined && typeof result.timedOut !== 'boolean') fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
  }
  return value;
}

export function validatePluginProfilePage(value) {
  if (!exact(value, ['bundles']) || !Array.isArray(value.bundles) || value.bundles.length > 512) fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
  const names = new Set();
  for (const row of value.bundles) {
    if (!exact(row, ['name','installed','enabled','version']) || typeof row.name !== 'string' || !row.name.trim()
      || row.name.length > 192 || names.has(row.name) || row.version !== undefined && (typeof row.version !== 'string' || row.version.length > 128)) fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
    for (const key of ['installed','enabled']) if (row[key] !== undefined && typeof row[key] !== 'boolean') fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
    names.add(row.name);
  }
  return value;
}

function validateCommand(command) {
  if (!exact(command, ['path','method','body','key']) || typeof command.key !== 'string' || !keyPattern.test(command.key)) fail('PLUGIN_PROFILE_COMMAND_INVALID');
  const body = command.body;
  if (command.path === base && command.method === 'POST') {
    if (!exact(body, ['spec','enabled']) || typeof body.spec !== 'string' || !body.spec.trim() || body.spec.length > 512
      || typeof body.enabled !== 'boolean' || /(?:[?&]|^)(?:token|access_token|password|passwd|secret|api_key)=/i.test(body.spec)) fail('PLUGIN_PROFILE_COMMAND_INVALID');
    if (body.spec.includes('://')) {
      let url; try { url = new URL(body.spec); } catch { fail('PLUGIN_PROFILE_COMMAND_INVALID'); }
      if (url.username || url.password || url.search || url.hash) fail('PLUGIN_PROFILE_COMMAND_INVALID');
    }
    return;
  }
  const match = typeof command.path === 'string' && /^\/plugin-profile\/bundles\/([^/]+)(\/enabled)?$/.exec(command.path);
  if (!match) fail('PLUGIN_PROFILE_COMMAND_INVALID');
  let name; try { name = decodeURIComponent(match[1]); } catch { fail('PLUGIN_PROFILE_COMMAND_INVALID'); }
  if (!name.trim() || name.length > 192 || encodeURIComponent(name) !== match[1]) fail('PLUGIN_PROFILE_COMMAND_INVALID');
  if (match[2] && command.method === 'PATCH' && exact(body, ['enabled']) && typeof body.enabled === 'boolean') return;
  if (!match[2] && command.method === 'DELETE' && exact(body, []) ) return;
  fail('PLUGIN_PROFILE_COMMAND_INVALID');
}

/** Original command recovery is same-tab and owner-scoped. Completion uses a key comparison. */
export class PluginProfileCommandStore {
  constructor(storage, ownerScope) {
    if (!/^[a-f0-9]{64}$/.test(ownerScope)) fail('PLUGIN_PROFILE_SCOPE_UNKNOWN');
    this.storage = storage;
    this.key = `jot-plugin-profile/v1/${ownerScope}`;
  }
  read() {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    if (raw.length > 4096) fail('PLUGIN_PROFILE_COMMAND_INVALID');
    const command = JSON.parse(raw); validateCommand(command);
    return {command};
  }
  saveCommand(command, expected) {
    if (command === null) { this.complete(expected); return; }
    validateCommand(command);
    const current = this.read()?.command;
    if (current && JSON.stringify(current) !== JSON.stringify(command)) fail('PLUGIN_PROFILE_COMMAND_PENDING');
    this.storage.setItem(this.key, JSON.stringify(command));
  }
  complete(expected) {
    const current = this.read()?.command;
    if (current && JSON.stringify(current) !== JSON.stringify(expected)) fail('PLUGIN_PROFILE_COMMAND_CHANGED');
    this.storage.removeItem(this.key);
  }
}

const operationFor = command => command.method === 'POST' ? 'plugin.bundle.install'
  : command.method === 'PATCH' ? 'plugin.bundle.enable' : 'plugin.bundle.remove';

export function createPluginProfileClient({request, receipt, isCurrent}) {
  const current = () => { if (!isCurrent()) fail('PLUGIN_PROFILE_SCOPE_CHANGED'); };
  return Object.freeze({
    async read(signal) {
      current();
      const page = await request(base, 'GET', undefined, undefined, signal);
      current(); return validatePluginProfilePage(page);
    },
    async submit(command) {
      current();
      return receipt.submit(async (path, method, body, key) => {
        current(); validateCommand({path,method,body,key});
        try {
          const result = await request(path, method, body, key);
          current(); return validatePluginProfileResult(result);
        } catch (error) {
          current();
          if (error?.status === 409) throw new Error('PLUGIN_OPERATION_PENDING', {cause:error});
          throw error;
        }
      }, command.path, command.method, command.body);
    },
    async recover(signal) {
      current();
      const command = receipt.command;
      if (!command) return null;
      validateCommand(command);
      const value = await request(`/plugin-profile/operations/${encodeURIComponent(command.key)}`, 'GET', undefined, undefined, signal);
      current();
      if (!exact(value, ['route_operation','request_sha256','operation_id','operation','state','response','response_status']) || value.operation_id !== command.key
        || value.operation !== operationFor(command) || !['reserved','dispatched','settled','unknown'].includes(value.state)) fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
      const canonical = JSON.stringify(Object.fromEntries(Object.entries(command.body).sort(([left], [right]) => left.localeCompare(right, 'en'))));
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))), byte => byte.toString(16).padStart(2, '0')).join('');
      current();
      if (value.route_operation !== `${command.method} /v1${command.path}` || value.request_sha256 !== digest) fail('PLUGIN_PROFILE_COMMAND_CHANGED');
      if (value.state === 'settled') {
        if (value.response_status !== 200) fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
        validatePluginProfileResult(value.response);
        receipt.store.complete(command); receipt.command = null;
      } else if (value.response !== undefined || value.response_status !== undefined) fail('PLUGIN_PROFILE_RESPONSE_UNKNOWN');
      return value;
    },
  });
}
