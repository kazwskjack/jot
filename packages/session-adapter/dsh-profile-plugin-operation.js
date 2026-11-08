import {createHash} from 'node:crypto';

const supportedOperations = new Set([
  'plugin.bundle.install',
  'plugin.bundle.enable',
  'plugin.bundle.remove',
  'plugin.bundle.cancel',
]);

function fail(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : {cause});
  error.code = code;
  return error;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIdentity(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw fail('plugin_operation_payload_invalid');
    seen.add(value);
    const result = `[${value.map(item => canonicalJson(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (record(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    if (seen.has(value)) throw fail('plugin_operation_payload_invalid');
    seen.add(value);
    const keys = Object.keys(value).sort();
    const result = `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return result;
  }
  throw fail('plugin_operation_payload_invalid');
}

export function dshProfilePluginActionSha256(payload) {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

function operationContext(input) {
  if (!record(input) || !validIdentity(input.ownerId) || !validIdentity(input.profileId)
    || typeof input.operationId !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(input.operationId)
    || !supportedOperations.has(input.operation)
    || typeof input.authorizationRef !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(input.authorizationRef)
    || !record(input.payload)) {
    throw fail('plugin_operation_request_invalid');
  }
  const actionSha256 = dshProfilePluginActionSha256(input.payload);
  return Object.freeze({
    ownerId: input.ownerId,
    profileId: input.profileId,
    operation: input.operation,
    operationId: input.operationId,
    actionSha256,
  });
}

function receiptExecutor(value) {
  if (!record(value) || typeof value.claim !== 'function'
    || typeof value.settle !== 'function' || typeof value.markUnknown !== 'function') {
    throw fail('plugin_operation_receipt_unavailable');
  }
  return value;
}

async function markUnknown(executor, context) {
  try {
    await executor.markUnknown(context);
  } catch {
    // A lost receipt connection is itself an unknown outcome; never retry dispatch here.
  }
}

/**
 * Bind the lifecycle adapter's Host policy revalidation to a Gateway receipt
 * client. Gateway claim atomically transitions the original reserved request
 * to dispatched; the exact Host grant is then revalidated immediately before
 * this function invokes the SDK callback. A refusal seals the claimed receipt
 * as unknown and never dispatches. The receipt port never receives the opaque
 * authorization reference.
 *
 * Shared port contract:
 * - claim({ownerId, profileId, operation, operationId, actionSha256}) ->
 *   {dispatch:true, state:'dispatched'} | {dispatch:false, state:'settled', response}
 *   | {dispatch:false, state:'dispatched'|'unknown'}
 * - authorizeReference({ownerId, profileId, operation, operationId,
 *   actionSha256, authorizationRef}) -> {ok:true} | {ok:false}; called after
 *   the claim and immediately before the one SDK dispatch
 * - settle({...context, result}) -> {state:'settled', response}
 * - markUnknown(context) -> {state:'unknown'}
 *
 * `claim` must bind the operation id and digest to the existing reservation;
 * settled responses are replayed verbatim, and dispatched/unknown states never
 * grant another SDK dispatch. Implement these methods over the existing
 * ga_idempotency authority rather than a second receipt store.
 */
export function createDshProfilePluginOperationCaller({authorizeReference, gatewayReceiptExecutor, recoverDispatched} = {}) {
  if (typeof authorizeReference !== 'function') throw fail('plugin_operation_authority_unavailable');
  const executor = receiptExecutor(gatewayReceiptExecutor);
  if (recoverDispatched !== undefined && typeof recoverDispatched !== 'function') throw fail('plugin_operation_recovery_unavailable');

  return async function executeAuthorizedOperation(input, dispatch) {
    if (typeof dispatch !== 'function') throw fail('plugin_operation_dispatch_unavailable');
    const context = operationContext(input);
    let claim;
    try {
      claim = await executor.claim(context);
    } catch (cause) {
      await markUnknown(executor, context);
      throw fail('plugin_operation_unknown', cause);
    }
    if (!record(claim)) {
      await markUnknown(executor, context);
      throw fail('plugin_operation_unknown');
    }
    if (claim.dispatch === false && claim.state === 'settled' && Object.hasOwn(claim, 'response')) {
      return claim.response;
    }
    if (claim.dispatch === false && claim.state === 'dispatched') {
      let recovered;
      try {
        recovered = await recoverDispatched?.(context);
      } catch {
        await markUnknown(executor, context);
        throw fail('plugin_operation_unknown');
      }
      if (record(recovered) && recovered.state === 'settled' && Object.hasOwn(recovered, 'response')) {
        try {
          const settled = await executor.settle(Object.freeze({...context, result: recovered.response}));
          if (record(settled) && settled.state === 'settled' && Object.hasOwn(settled, 'response')) return settled.response;
        } catch {
          await markUnknown(executor, context);
          throw fail('plugin_operation_unknown');
        }
      }
      await markUnknown(executor, context);
      throw fail('plugin_operation_unknown');
    }
    if (claim.dispatch !== true || claim.state !== 'dispatched') {
      throw fail('plugin_operation_unknown');
    }

    let authorized;
    try {
      authorized = await authorizeReference(Object.freeze({
        ownerId: context.ownerId,
        profileId: context.profileId,
        operation: context.operation,
        operationId: context.operationId,
        actionSha256: context.actionSha256,
        authorizationRef: input.authorizationRef,
      }));
    } catch (cause) {
      await markUnknown(executor, context);
      throw fail('plugin_operation_not_authorized', cause);
    }
    if (!record(authorized) || authorized.ok !== true) {
      await markUnknown(executor, context);
      throw fail('plugin_operation_not_authorized');
    }

    let result;
    try {
      result = await dispatch();
    } catch (cause) {
      await markUnknown(executor, context);
      throw fail('plugin_operation_unknown', cause);
    }

    let settled;
    try {
      settled = await executor.settle(Object.freeze({...context, result}));
    } catch (cause) {
      await markUnknown(executor, context);
      throw fail('plugin_operation_unknown', cause);
    }
    if (record(settled) && settled.state === 'settled' && Object.hasOwn(settled, 'response')) {
      return settled.response;
    }
    await markUnknown(executor, context);
    throw fail('plugin_operation_unknown');
  };
}
