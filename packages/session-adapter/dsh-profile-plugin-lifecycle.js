const requestIdPattern = /^[\x21-\x7e]{8,128}$/;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIdentity(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requireRequestId(value) {
  if (typeof value !== 'string' || !requestIdPattern.test(value)) throw new Error('plugin_operation_id_invalid');
  return value;
}

function requireAuthorizationRef(value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(value)) throw new Error('plugin_authorization_ref_invalid');
  return value;
}

function requireBundleName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('plugin_bundle_name_invalid');
  return value;
}

/** Bind the official DSH PluginManager to one owner-owned profile. Mutations
 * require the original caller's trusted authority callback, which validates
 * the opaque grant reference and owns durable receipt/replay policy before it
 * invokes dispatch. This adapter creates no operation ids or receipt store.
 * DSH requestId correlates active wait/cancel calls; it does not deduplicate
 * installBundle dispatches. */
export function createDshProfilePluginLifecycle({ownerId, profileId, pluginManager, executeAuthorizedOperation} = {}) {
  if (!validIdentity(ownerId) || !validIdentity(profileId)) throw new Error('plugin_profile_binding_invalid');
  const methods = ['listBundles', 'installBundle', 'setBundleEnabled', 'removeBundle', 'waitForInstall', 'cancelInstall'];
  if (!record(pluginManager) || methods.some(name => typeof pluginManager[name] !== 'function')) {
    throw new Error('plugin_manager_unavailable');
  }

  const assertScope = input => {
    if (!record(input)) throw new Error('plugin_profile_request_invalid');
    if (input.ownerId !== ownerId || input.profileId !== profileId) throw new Error('plugin_profile_scope_mismatch');
    return input;
  };

  const runAuthorized = (input, operation, payload, dispatch) => {
    assertScope(input);
    const operationId = requireRequestId(input.operationId);
    const authorizationRef = requireAuthorizationRef(input.authorizationRef);
    if (typeof executeAuthorizedOperation !== 'function') throw new Error('plugin_operation_authority_unavailable');
    let dispatched = false;
    const dispatchOnce = () => {
      if (dispatched) throw new Error('plugin_operation_duplicate_dispatch');
      dispatched = true;
      return dispatch(operationId);
    };
    return executeAuthorizedOperation(Object.freeze({
      ownerId, profileId, operation, operationId, authorizationRef, payload: Object.freeze(payload),
    }), dispatchOnce);
  };

  return Object.freeze({
    async listBundles(input) {
      assertScope(input);
      return pluginManager.listBundles();
    },
    async installBundle(input) {
      if (!record(input)) throw new Error('plugin_profile_request_invalid');
      if (typeof input.spec !== 'string' || !input.spec.trim()) throw new Error('plugin_install_spec_invalid');
      if (typeof input.enabled !== 'boolean') throw new Error('plugin_bundle_enabled_required');
      const spec = input.spec, enabled = input.enabled;
      return runAuthorized(input, 'plugin.bundle.install', {spec, enabled}, operationId =>
        pluginManager.installBundle(spec, {requestId: operationId, enabled, saveExact: true}));
    },
    async setBundleEnabled(input) {
      if (!record(input)) throw new Error('plugin_profile_request_invalid');
      const name = requireBundleName(input.name);
      if (typeof input.enabled !== 'boolean') throw new Error('plugin_bundle_enabled_required');
      const enabled = input.enabled;
      return runAuthorized(input, 'plugin.bundle.enable', {name, enabled}, () => pluginManager.setBundleEnabled(name, enabled));
    },
    async removeBundle(input) {
      if (!record(input)) throw new Error('plugin_profile_request_invalid');
      const name = requireBundleName(input.name);
      return runAuthorized(input, 'plugin.bundle.remove', {name}, () => pluginManager.removeBundle(name));
    },
    async waitForInstall(input) {
      assertScope(input);
      const result = await pluginManager.waitForInstall(requireRequestId(input.requestId));
      return result == null ? {status: 'unknown'} : {status: 'settled', result};
    },
    async cancelInstall(input) {
      if (!record(input)) throw new Error('plugin_profile_request_invalid');
      const targetRequestId = requireRequestId(input.requestId);
      return runAuthorized(input, 'plugin.bundle.cancel', {targetRequestId}, () => pluginManager.cancelInstall(targetRequestId));
    },
  });
}
