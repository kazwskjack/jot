import { createNativeHandoffAdmission } from './native-handoff-admission.js';
import { createNativeHandoffReturn, createNativeHandoffRecovery } from './native-handoff-return.js';
import { createNativeHandoffInboxGate } from './native-handoff-inbox.js';

function validRoute(route) {
  return route && typeof route === 'object' && !Array.isArray(route)
    && Object.keys(route).every((key) => key === 'provider' || key === 'model')
    && typeof route.provider === 'string' && route.provider.trim().length > 0
    && typeof route.model === 'string' && route.model.trim().length > 0;
}

/** Compose the trusted native handoff lifecycle around one official Inbox Gate. */
export function createNativeHandoffLifecycle({
  ctx,
  bridge,
  registry,
  persistence,
  projections,
  sessions,
  policyVersion,
  maxHops,
  validateLog,
  route,
  reconcileOperations,
}) {
  if (typeof ctx?.effect !== 'function'
    || typeof bridge?.request !== 'function' || typeof bridge?.bindingFor !== 'function'
    || typeof registry?.get !== 'function'
    || typeof persistence?.flush !== 'function' || typeof persistence?.open !== 'function'
    || typeof projections?.stateOf !== 'function' || typeof projections?.snapshot !== 'function'
    || typeof sessions?.get !== 'function'
    || !Number.isSafeInteger(policyVersion) || policyVersion < 1
    || !Number.isSafeInteger(maxHops) || maxHops < 1 || maxHops > 20
    || typeof validateLog !== 'function' || !validRoute(route)) {
    throw new Error('native_handoff_config_invalid');
  }
  if (reconcileOperations !== undefined && typeof reconcileOperations !== 'function') {
    throw new Error('native_handoff_config_invalid');
  }

  const inboxGate = createNativeHandoffInboxGate({ ctx, bridge, registry, persistence });
  try {
    const shared = { bridge, registry, persistence, projections, policyVersion, route, reconcileOperations, inboxGate };
    return Object.freeze({
      handoffAdmission: createNativeHandoffAdmission({ ...shared, maxHops }),
      handoffReturn: createNativeHandoffReturn(shared),
      handoffRecovery: createNativeHandoffRecovery({ ...shared, sessions, validateLog }),
      inboxGate,
    });
  } catch (error) {
    void inboxGate.dispose().catch(() => {});
    throw error;
  }
}
