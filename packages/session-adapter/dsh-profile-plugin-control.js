import {createDshProfilePluginLifecycle} from './dsh-profile-plugin-lifecycle.js';
import {createDshProfilePluginOperationCaller, dshProfilePluginActionSha256} from './dsh-profile-plugin-operation.js';

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_ID = /^[\x21-\x7e]{8,128}$/;
const GRANT_REF = /^[\x21-\x7e]{8,512}$/;
const IMPACT_SCOPE = 'all_agent_sessions';
const RESPONSE_LIMIT = 64 * 1024;
const OPERATION_PATHS = new Set([
  '/v1/plugin-profile/bundles/list',
  '/v1/plugin-profile/bundles/install',
  '/v1/plugin-profile/bundles/enable',
  '/v1/plugin-profile/bundles/remove',
]);

function fail(code, cause) {
  throw Object.assign(new Error(code, cause === undefined ? undefined : {cause}), {code});
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value, keys) {
  return object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function receiptClient(value) {
  if (!object(value) || !['claim', 'settle', 'markUnknown'].every(name => typeof value[name] === 'function')) {
    fail('plugin_operation_receipt_unavailable');
  }
  return value;
}

function operationFor(path) {
  if (path.endsWith('/install')) return 'plugin.bundle.install';
  if (path.endsWith('/enable')) return 'plugin.bundle.enable';
  if (path.endsWith('/remove')) return 'plugin.bundle.remove';
  return undefined;
}

function safeSpec(value) {
  if (/(?:[?&]|^)(?:token|access_token|password|passwd|secret|api_key)=/i.test(value)) return false;
  if (!value.includes('://')) return true;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function cleanBundleList(value) {
  if (!Array.isArray(value) || value.length > 512) fail('plugin_profile_sdk_result_invalid');
  return {bundles: value.map(row => {
    if (!object(row) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 192) fail('plugin_profile_sdk_result_invalid');
    const result = {name: row.name};
    for (const key of ['installed', 'enabled']) if (row[key] !== undefined) {
      if (typeof row[key] !== 'boolean') fail('plugin_profile_sdk_result_invalid');
      result[key] = row[key];
    }
    if (row.version !== undefined) {
      if (typeof row.version !== 'string' || row.version.length > 128) fail('plugin_profile_sdk_result_invalid');
      result.version = row.version;
    }
    return result;
  })};
}

function cleanOperationResult(value) {
  if (!object(value) || typeof value.application !== 'string' || value.application.length > 64
    || typeof value.changed !== 'boolean') fail('plugin_profile_sdk_result_invalid');
  const result = {application: value.application, changed: value.changed};
  for (const key of ['version', 'restartReason']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'string' || value[key].length > 128) fail('plugin_profile_sdk_result_invalid');
    result[key] = value[key];
  }
  if (value.bundle !== undefined) {
    if (typeof value.bundle !== 'string' || value.bundle.length > 192) fail('plugin_profile_sdk_result_invalid');
    result.bundle = value.bundle;
  }
  if (value.stage !== undefined) {
    if (typeof value.stage !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(value.stage)) fail('plugin_profile_sdk_result_invalid');
    result.stage = value.stage;
  }
  if (value.error !== undefined) {
    const code = typeof value.error === 'string' ? value.error : value.error?.code;
    if (typeof code !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(code)) fail('plugin_profile_sdk_result_invalid');
    result.error = {code};
  }
  if (value.failedAt !== undefined) {
    if (typeof value.failedAt !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(value.failedAt)) fail('plugin_profile_sdk_result_invalid');
    result.failedAt = value.failedAt;
  }
  if (value.packageResult !== undefined) {
    const packageResult = value.packageResult;
    if (!object(packageResult) || !Number.isSafeInteger(packageResult.exitCode)
      || packageResult.kind !== undefined && (typeof packageResult.kind !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(packageResult.kind))
      || packageResult.timedOut !== undefined && typeof packageResult.timedOut !== 'boolean') fail('plugin_profile_sdk_result_invalid');
    result.packageResult = {exitCode: packageResult.exitCode,
      ...(packageResult.kind === undefined ? {} : {kind: packageResult.kind}),
      ...(packageResult.timedOut === undefined ? {} : {timedOut: packageResult.timedOut})};
  }
  return result;
}

function actionFor(operation, input) {
  if (operation === 'plugin.bundle.install') return {spec: input.spec, enabled: input.enabled};
  if (operation === 'plugin.bundle.enable') return {name: input.name, enabled: input.enabled};
  if (operation === 'plugin.bundle.remove') return {name: input.name};
  return undefined;
}

function validateOperationRequest(path, input, ownerId) {
  const operation = operationFor(path);
  if (path === '/v1/plugin-profile/bundles/list') {
    if (!exact(input, ['owner_id']) || input.owner_id !== ownerId) fail('plugin_profile_scope_mismatch');
    return {operation: 'list'};
  }
  if (!operation || !exact(input, operation === 'plugin.bundle.install'
    ? ['owner_id', 'operation_id', 'spec', 'enabled']
    : operation === 'plugin.bundle.enable'
      ? ['owner_id', 'operation_id', 'name', 'enabled']
      : ['owner_id', 'operation_id', 'name']) || input.owner_id !== ownerId
    || typeof input.operation_id !== 'string' || !OPERATION_ID.test(input.operation_id)) {
    fail('plugin_profile_request_invalid');
  }
  if (operation === 'plugin.bundle.install' && (typeof input.spec !== 'string' || !input.spec.trim() || input.spec.length > 512 || !safeSpec(input.spec)
    || typeof input.enabled !== 'boolean')) fail('plugin_profile_request_invalid');
  if (operation === 'plugin.bundle.enable' && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 192
    || typeof input.enabled !== 'boolean')) fail('plugin_profile_request_invalid');
  if (operation === 'plugin.bundle.remove' && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 192)) {
    fail('plugin_profile_request_invalid');
  }
  return {operation, operationId: input.operation_id, action: actionFor(operation, input)};
}

/** Authenticated HTTPS/loopback receipt client for the existing Gateway row authority. */
export function createGatewayPluginProfileReceiptClient({origin, token, fetchImpl = globalThis.fetch} = {}) {
  let url;
  try { url = new URL(origin); } catch { fail('plugin_profile_receipt_client_config_invalid'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password
    || typeof token !== 'string' || token.length < 16 || typeof fetchImpl !== 'function') {
    fail('plugin_profile_receipt_client_config_invalid');
  }
  const base = url.origin;

  async function post(action, value) {
    const requestBody = JSON.stringify(value);
    if (Buffer.byteLength(requestBody, 'utf8') > RESPONSE_LIMIT) fail('plugin_profile_receipt_request_invalid');
    const response = await fetchImpl(`${base}/internal/v1/workbench/plugin-profile/receipt/${action}`, {
      method: 'POST', redirect: 'error',
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8'},
      body: requestBody, signal: AbortSignal.timeout(15_000),
    });
    const reader = response.body?.getReader();
    if (!reader) fail('plugin_profile_receipt_unconfirmed');
    const chunks = [];
    let size = 0, complete = false;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) { complete = true; break; }
        size += part.value.byteLength;
        if (size > RESPONSE_LIMIT) fail('plugin_profile_receipt_unconfirmed');
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let result;
    try { result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))); } catch { fail('plugin_profile_receipt_unconfirmed'); }
    if (!response.ok || !object(result)) fail('plugin_profile_receipt_unconfirmed');
    return result;
  }

  return Object.freeze({
    async claim(context) {
      const value = await post('claim', context);
      if (!object(value) || typeof value.dispatch !== 'boolean'
        || !['reserved', 'dispatched', 'settled', 'unknown'].includes(value.state)) fail('plugin_profile_receipt_unconfirmed');
      return value;
    },
    async settle(input) {
      if (!object(input) || !Object.hasOwn(input, 'result')) fail('plugin_profile_receipt_unconfirmed');
      const {result, ...context} = input;
      const value = await post('settle', {...context, response: result});
      if (!object(value) || value.state !== 'settled' || !Object.hasOwn(value, 'response')) fail('plugin_profile_receipt_unconfirmed');
      return value;
    },
    async markUnknown(context) {
      const value = await post('unknown', context);
      if (!object(value) || !['unknown', 'settled'].includes(value.state)) fail('plugin_profile_receipt_unconfirmed');
      return value;
    },
  });
}

/**
 * Compose the real Host boundary for one provisioned owner profile. `policyAuthority`
 * must be the existing Host operator authority extended with exact mutation grants;
 * this module deliberately has no grant map or request-supplied profile id.
 */
export function createDshProfilePluginControl({binding, pluginManager, policyAuthority, gatewayReceiptExecutor} = {}) {
  if (!object(binding) || !OWNER_ID.test(binding.ownerId ?? '') || !OWNER_ID.test(binding.profileId ?? '')
    || typeof binding.profileDirectory !== 'string'
    || !object(policyAuthority) || typeof policyAuthority.issuePluginMutationGrant !== 'function'
    || typeof policyAuthority.authorizePluginMutationGrant !== 'function') fail('plugin_profile_control_unavailable');
  if (!object(pluginManager) || ['listBundles', 'installBundle', 'setBundleEnabled', 'removeBundle', 'waitForInstall', 'cancelInstall']
    .some(name => typeof pluginManager[name] !== 'function')) fail('plugin_manager_unavailable');
  const receipts = receiptClient(gatewayReceiptExecutor);
  const safePluginManager = Object.freeze({
    listBundles: async () => cleanBundleList(await pluginManager.listBundles()).bundles,
    installBundle: async (...args) => cleanOperationResult(await pluginManager.installBundle(...args)),
    setBundleEnabled: async (...args) => cleanOperationResult(await pluginManager.setBundleEnabled(...args)),
    removeBundle: async (...args) => cleanOperationResult(await pluginManager.removeBundle(...args)),
    waitForInstall: async (...args) => {
      const result = await pluginManager.waitForInstall(...args);
      return result == null ? result : cleanOperationResult(result);
    },
    cancelInstall: async (...args) => {
      const result = await pluginManager.cancelInstall(...args);
      if (!object(result) || !['cancelled', 'too-late', 'not-running'].includes(result.status)) fail('plugin_profile_sdk_result_invalid');
      return {status: result.status};
    },
  });

  const authorizeReference = async input => {
    let result;
    try {
      result = await policyAuthority.authorizePluginMutationGrant({
        ownerId: binding.ownerId, profileId: binding.profileId,
        operation: input.operation, operationId: input.operationId,
        actionSha256: input.actionSha256, impactScope: IMPACT_SCOPE,
        authorizationRef: input.authorizationRef,
      });
    } catch { return {ok: false}; }
    return {ok: object(result) && result.ok === true};
  };

  const recoverDispatched = async context => {
    if (context.operation !== 'plugin.bundle.install') return {state: 'unknown'};
    let result;
    try { result = await safePluginManager.waitForInstall(context.operationId); }
    catch { return {state: 'unknown'}; }
    return result == null ? {state: 'unknown'} : {state: 'settled', response: result};
  };

  const executeAuthorizedOperation = createDshProfilePluginOperationCaller({
    authorizeReference, gatewayReceiptExecutor: receipts, recoverDispatched,
  });
  const lifecycle = createDshProfilePluginLifecycle({
    ownerId: binding.ownerId, profileId: binding.profileId, pluginManager: safePluginManager, executeAuthorizedOperation,
  });

  async function issueReference(operation, operationId, action) {
    const actionSha256 = dshProfilePluginActionSha256(action);
    let decision;
    try {
      decision = await policyAuthority.issuePluginMutationGrant({
        ownerId: binding.ownerId, profileId: binding.profileId, operation, operationId,
        actionSha256, impactScope: IMPACT_SCOPE,
      });
    } catch (cause) { fail('plugin_operation_not_authorized', cause); }
    if (!object(decision) || decision.ok !== true || typeof decision.authorizationRef !== 'string'
      || !GRANT_REF.test(decision.authorizationRef)) fail('plugin_operation_not_authorized');
    return decision.authorizationRef;
  }

  return Object.freeze({
    async handle({method, pathname, body, signal} = {}) {
      if (method !== 'POST' || !OPERATION_PATHS.has(pathname)) fail('plugin_profile_request_invalid');
      signal?.throwIfAborted();
      const request = validateOperationRequest(pathname, body, binding.ownerId);
      if (request.operation === 'list') return lifecycle.listBundles({ownerId: binding.ownerId, profileId: binding.profileId});

      const authorizationRef = await issueReference(request.operation, request.operationId, request.action);
      signal?.throwIfAborted();
      const scope = {ownerId: binding.ownerId, profileId: binding.profileId, operationId: request.operationId, authorizationRef};
      if (request.operation === 'plugin.bundle.install') {
        return lifecycle.installBundle({...scope, spec: request.action.spec, enabled: request.action.enabled});
      }
      if (request.operation === 'plugin.bundle.enable') {
        return lifecycle.setBundleEnabled({...scope, name: request.action.name, enabled: request.action.enabled});
      }
      return lifecycle.removeBundle({...scope, name: request.action.name});
    },
  });
}
