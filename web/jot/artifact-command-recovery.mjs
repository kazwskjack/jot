const exact = (value, keys) => !!value && typeof value === 'object' && !Array.isArray(value)
 && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const invalid = () => { throw Error('文件原请求的权威回执尚未确认'); };
async function digest(value) {
 const text = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Reading a disposition grants no permission to dispatch the original operation.
export async function artifactCommandDisposition(store, command, artifactId, send, current, close = false) {
 store.validate(command);
 const kind = command.path === `/artifacts/${encodeURIComponent(artifactId)}/archive` ? 'archive' : 'restore';
 if (command.path !== `/artifacts/${encodeURIComponent(artifactId)}/${kind}`) invalid();
 const [bodyDigest, commandDigest] = await Promise.all([
  digest(command.body),
  digest({artifact_id: artifactId, command_key: command.key, command_path: command.path, ...command.body}),
 ]);
 if (!current()) invalid();
 const endpoint = `/artifacts/${encodeURIComponent(artifactId)}/commands/${encodeURIComponent(command.key)}`;
 const descriptor = {path: command.path, body: command.body};
 const query = new URLSearchParams({path: command.path, body: JSON.stringify(command.body)});
 const result = close ? await send(`${endpoint}/close`, 'POST', descriptor, command.key) : await send(`${endpoint}?${query}`);
 const common = ['protocol', 'artifact_id', 'kind', 'command_key', 'request_sha256', 'command_sha256', 'execution_authorized', 'restore_authorized'];
 const variants = {unobserved: [], recorded_pending: [], settled: ['result'], terminal_rejected: ['no_effect', 'reason'], unresolved: ['reason']};
 if (!current() || !result || !Object.hasOwn(variants, result.state)
  || !exact(result, [...common, 'state', ...variants[result.state]]) || result.protocol !== 1
  || result.artifact_id !== artifactId || result.kind !== kind || result.command_key !== command.key
  || result.request_sha256 !== bodyDigest || result.command_sha256 !== commandDigest
  || result.execution_authorized !== false || result.restore_authorized !== false) invalid();
 if (result.state === 'terminal_rejected' && (result.no_effect !== true || result.reason !== 'artifact_command_closed')) invalid();
 if (result.state === 'settled' && (!result.result || result.result.accepted !== true || result.result.artifact_id !== artifactId)) invalid();
 if (result.state === 'unresolved' && !['legacy_pending', 'unsupported_receipt'].includes(result.reason)) invalid();
 if (close && ['unobserved', 'recorded_pending'].includes(result.state)) invalid();
 return result;
}
