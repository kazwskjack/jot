import {createHash, randomBytes} from 'node:crypto';

export const HOST_CREDENTIALS_PATH = '/api/jot-host-credentials';
const REF = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const headers = {'cache-control':'no-store', 'referrer-policy':'no-referrer', 'x-content-type-options':'nosniff'};
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const escapeJson = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const held = (status, reason) => Response.json({status:'held', reason_code:reason}, {status, headers});

export function validateHostCredentialRefs(refs) {
  if (!Array.isArray(refs) || refs.length > 64 || refs.some(ref => typeof ref !== 'string' || !REF.test(ref))
    || new Set(refs).size !== refs.length) throw TypeError('host_credential_refs_invalid');
  return Object.freeze([...refs]);
}

function page(config, scriptNonce) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<title>Host 凭据引用</title><main><h1>Host 凭据引用</h1>
<p>选定引用后可轮换或撤销存储值。新的调用通过原生凭据服务解析引用。</p>
<p>环境变量中仍有同名值时，删除存储值后会继续显示已配置。</p>
<label>引用 <select id="reference"></select></label><p id="state" role="status"></p>
<label>新凭据 <input id="secret" type="password" autocomplete="new-password" maxlength="16384"></label>
<button id="rotate" type="button">轮换此引用</button><button id="revoke" type="button">撤销存储值</button>
<p><a href="${HOST_CREDENTIALS_PATH}">重新读取状态</a></p></main>
<script id="page-data" type="application/json">${escapeJson(config)}</script><script nonce="${scriptNonce}">
(() => {
  const config = JSON.parse(document.getElementById('page-data').textContent);
  const select = document.getElementById('reference'), secret = document.getElementById('secret');
  const status = document.getElementById('state'), rotate = document.getElementById('rotate'), revoke = document.getElementById('revoke');
  for (const row of config.references) {
    const option = document.createElement('option'); option.value = row.handle; option.textContent = row.handle;
    select.append(option);
  }
  function show() {
    const row = config.references.find(row => row.handle === select.value);
    status.textContent = !row ? '状态待确认' : row.configured ? '已配置' : '未配置';
    rotate.disabled = revoke.disabled = !row || !row.writable;
  }
  select.addEventListener('change', () => { secret.value = ''; show(); }); show();
  async function change(operation) {
    if (!config.nonce || (operation === 'rotate' && !secret.value)) return;
    const body = {nonce:config.nonce, handle:select.value, operation, ...(operation === 'rotate' ? {value:secret.value} : {})};
    config.nonce = ''; secret.value = ''; rotate.disabled = revoke.disabled = select.disabled = true;
    status.textContent = '正在处理，请保留此页面…';
    try {
      const response = await fetch('${HOST_CREDENTIALS_PATH}', {method:'POST', credentials:'same-origin',
        headers:{'content-type':'application/json'}, body:JSON.stringify(body)});
      delete body.value;
      const result = await response.json();
      status.textContent = result.status === 'rotated' ? '引用已轮换，旧 MCP 连接已关闭。' :
        result.status === 'revoked' ? '引用已撤销，旧 MCP 连接已关闭。' :
        result.reason_code === 'credential_fallback_still_configured' ? '存储值已移除，环境变量或其他原生来源仍配置了此引用。' :
        result.status === 'unknown' ? '操作结果待确认。请重新读取状态，保留原操作结果。' : '操作未完成，请重新读取状态。';
    } catch { status.textContent = '连接中断，操作结果待确认。请重新读取状态。'; }
    finally { delete body.value; secret.value = ''; }
  }
  rotate.addEventListener('click', () => change('rotate'));
  revoke.addEventListener('click', () => change('revoke'));
})();</script></html>`;
}

/** Native owner-only credential UI. Secret values stay on the original Remote write path. */
export function createHostCredentialsOwnerRoute({connection, typertGateway, dshOrigin, references, readIdentity, beforeChange, now=Date.now}={}) {
  const allowed = validateHostCredentialRefs(references);
  if (typeof connection?.admit !== 'function' || typeof typertGateway?.invoke !== 'function'
    || typeof readIdentity !== 'function' || typeof beforeChange !== 'function'
    || new URL(dshOrigin).origin !== dshOrigin) throw TypeError('host_credentials_route_invalid');
  const nonces = new Map(), active = new Set();
  const identityKey = () => { const value=readIdentity(); return JSON.stringify([value.ownerId, value.profileId]); };
  async function describe(peer) {
    const rows = await typertGateway.invoke({namespace:'credentials', method:'describe', args:{refs:allowed}, peer});
    if (!object(rows)) throw Error('host_credentials_source_unavailable');
    return allowed.map(handle => {
      const row = rows[handle];
      if (!object(row) || typeof row.configured !== 'boolean' || typeof row.writable !== 'boolean') throw Error('host_credentials_source_unavailable');
      return {handle, configured:row.configured, writable:row.writable};
    });
  }
  return {path:HOST_CREDENTIALS_PATH, methods:['GET','POST'], requestBody:'buffered', async fetch(request) {
    const url = new URL(request.url), origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
    if (url.origin !== dshOrigin || url.pathname !== HOST_CREDENTIALS_PATH || url.search || request.headers.has('x-user-id')
      || site === 'cross-site' || origin !== null && origin !== dshOrigin
      || request.method === 'POST' && (origin !== dshOrigin || site !== 'same-origin')) return held(403,'host_credentials_owner_required');
    const admissionHeaders = Object.fromEntries(request.headers.entries());
    admissionHeaders.host ??= url.host;
    let peer, identity;
    try {
      const admitted = connection.admit({method:request.method, url:url.pathname, headers:admissionHeaders});
      if (admitted?.ok !== true || admitted.peer?.principal?.kind !== 'owner') return held(403,'host_credentials_owner_required');
      peer = admitted.peer; identity = identityKey();
    } catch { return held(403,'host_credentials_owner_required'); }
    const instant = now();
    if (!Number.isSafeInteger(instant) || instant < 0) return held(503,'host_credentials_unavailable');
    for (const [key, value] of nonces) if (value.expires <= instant) nonces.delete(key);
    if (request.method === 'GET') {
      if (nonces.size >= 32) return held(503,'host_credentials_capacity');
      let rows;
      try { rows = await describe(peer); if (identityKey() !== identity) return held(409,'host_credentials_scope_changed'); }
      catch { return held(503,'host_credentials_unavailable'); }
      if (nonces.size >= 32) return held(503,'host_credentials_capacity');
      const nonce = randomBytes(32).toString('base64url'), scriptNonce = randomBytes(32).toString('base64url');
      nonces.set(digest(nonce), {identity, expires:instant+300000});
      return new Response(page({nonce, references:rows}, scriptNonce), {headers:{...headers, 'content-type':'text/html; charset=utf-8',
        'content-security-policy':`default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`}});
    }
    if (request.method !== 'POST') return held(405,'method_not_allowed');
    if ((request.headers.get('content-type')??'').split(';')[0].trim() !== 'application/json') return held(415,'content_type_invalid');
    let body;
    try {
      const reader=request.body?.getReader(); if (!reader) return held(400,'body_invalid');
      const chunks=[]; let size=0;
      for (;;) { const part=await reader.read(); if (part.done) break; size+=part.value.byteLength;
        if (size>70000) { await reader.cancel(); return held(413,'body_too_large'); } chunks.push(Buffer.from(part.value)); }
      body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return held(400,'body_invalid'); }
    if (!object(body) || !NONCE.test(body.nonce??'') || !allowed.includes(body.handle)
      || !['rotate','revoke'].includes(body.operation)
      || Object.keys(body).sort().join(',') !== (body.operation==='rotate'?'handle,nonce,operation,value':'handle,nonce,operation')
      || body.operation==='rotate' && (typeof body.value!=='string' || body.value.length<1 || body.value.length>16384)) return held(422,'host_credentials_input_invalid');
    const key=digest(body.nonce), grant=nonces.get(key); nonces.delete(key);
    if (!grant || grant.identity!==identity || grant.expires<=now()) return held(409,'host_credentials_scope_changed');
    if (active.has(body.handle)) return held(409,'host_credentials_busy');
    active.add(body.handle);
    let dispatched=false;
    try {
      await beforeChange();
      if (identityKey()!==identity) return held(409,'host_credentials_scope_changed');
      dispatched=true;
      await typertGateway.invoke({namespace:'credentials', method:body.operation==='rotate'?'set':'unset',
        args:body.operation==='rotate'?{ref:body.handle,value:body.value}:{ref:body.handle}, peer});
      delete body.value;
      await beforeChange();
      const row=(await describe(peer)).find(row=>row.handle===body.handle);
      if (identityKey()!==identity) throw Error('host_credentials_scope_changed');
      if (body.operation==='rotate' && !row.configured) throw Error('host_credentials_change_unconfirmed');
      if (body.operation==='revoke' && row.configured) return held(409,'credential_fallback_still_configured');
      return Response.json({status:body.operation==='rotate'?'rotated':'revoked', ...row}, {headers});
    } catch { return Response.json({status:dispatched?'unknown':'held',reason_code:'host_credentials_change_unconfirmed'}, {status:503,headers}); }
    finally { delete body.value; active.delete(body.handle); }
  }};
}
