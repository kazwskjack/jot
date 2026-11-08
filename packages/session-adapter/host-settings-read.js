import {HOST_POLICY_NAMESPACE} from './host-policy-constants.js';

const UNAVAILABLE = 'unavailable';

function copyJson(value, secretPaths = [], path = []) {
  if (secretPaths.some(secretPath => secretPath.length === path.length
    && secretPath.every((part, index) => part === path[index]))) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item, index) => copyJson(item, secretPaths, [...path, index]) ?? null);
  }
  if (typeof value !== 'object') return null;

  const result = {};
  for (const key of Object.keys(value)) {
    const nextPath = [...path, key];
    if (secretPaths.some(secretPath => secretPath.length === nextPath.length
      && secretPath.every((part, index) => part === nextPath[index]))) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) continue;
    result[key] = copyJson(descriptor.value, secretPaths, nextPath);
  }
  return result;
}

function projectSecrets(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(secret => {
    if (!secret || typeof secret !== 'object' || !Array.isArray(secret.path)) return [];
    const path = secret.path.filter(part => typeof part === 'string' || Number.isInteger(part));
    if (path.length !== secret.path.length || typeof secret.set !== 'boolean') return [];
    return [{path: [...path], set: secret.set}];
  });
}

function unknownNamespace(namespace) {
  return {
    namespace,
    state: 'unknown',
    auto_generate: null,
    revision: null,
    schema: null,
    value: null,
    applies: 'unknown',
    secrets: []
  };
}

function projectNamespace(namespace, descriptor) {
  if (!descriptor || typeof descriptor !== 'object') return unknownNamespace(namespace);

  const secrets = projectSecrets(descriptor.secrets);
  const secretPaths = secrets.map(secret => secret.path);
  const schemaPresent = Object.hasOwn(descriptor, 'schema');
  const valuePresent = Object.hasOwn(descriptor, 'value');
  const revisionPresent = Object.hasOwn(descriptor, 'revision') && descriptor.revision != null;
  const autoGeneratePresent = typeof descriptor.autoGenerate === 'boolean';
  const applies = typeof descriptor.applies === 'string' ? descriptor.applies : 'unknown';
  const appliesPresent = applies !== 'unknown';
  const state = schemaPresent && valuePresent && revisionPresent && autoGeneratePresent && appliesPresent
    ? 'ready'
    : 'partial';

  return {
    namespace,
    state,
    auto_generate: autoGeneratePresent ? descriptor.autoGenerate : null,
    revision: revisionPresent ? copyJson(descriptor.revision) : null,
    schema: schemaPresent ? copyJson(descriptor.schema) : null,
    value: valuePresent ? copyJson(descriptor.value, secretPaths) : null,
    applies,
    secrets
  };
}

function asOf(now) {
  try {
    const value = typeof now === 'function' ? now() : new Date();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

/**
 * Build a read-only DTO projector over DSH's SettingsController.
 * Only describe() is invoked; writes and provider APIs are intentionally absent.
 */
export function createHostSettingsReadAdapter({settingsController, namespaces = [], now} = {}) {
  const allowedNamespaces = [...new Set(
    (Array.isArray(namespaces) ? namespaces : [])
      .filter(namespace => typeof namespace === 'string' && namespace.length > 0 && namespace !== HOST_POLICY_NAMESPACE)
  )];

  return async function readHostSettings() {
    const timestamp = asOf(now);
    if (!settingsController || typeof settingsController.describe !== 'function') {
      return unavailableDto(timestamp, allowedNamespaces);
    }

    let described;
    try {
      described = await settingsController.describe({redactSecrets: true});
    } catch {
      return unavailableDto(timestamp, allowedNamespaces);
    }
    if (!described || typeof described !== 'object' || !Array.isArray(described.namespaces)) {
      return unavailableDto(timestamp, allowedNamespaces);
    }

    const byNamespace = new Map();
    for (const descriptor of described.namespaces) {
      if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.ns !== 'string') continue;
      if (!byNamespace.has(descriptor.ns)) byNamespace.set(descriptor.ns, descriptor);
    }
    const projected = allowedNamespaces.map(namespace => {
      const descriptor = byNamespace.get(namespace);
      return descriptor ? projectNamespace(namespace, descriptor) : unknownNamespace(namespace);
    });
    const state = projected.length === 0 || projected.every(item => item.state === 'unknown')
      ? 'unknown'
      : projected.every(item => item.state === 'ready') ? 'ready' : 'partial';

    return {
      protocol: 1,
      source: 'dsh-settings-controller',
      as_of: timestamp,
      state,
      writable: typeof described.writable === 'boolean' ? described.writable : null,
      has_document: typeof described.hasDocument === 'boolean' ? described.hasDocument : null,
      namespaces: projected
    };
  };
}

function unavailableDto(timestamp, namespaces) {
  return {
    protocol: 1,
    source: 'dsh-settings-controller',
    as_of: timestamp,
    state: UNAVAILABLE,
    writable: null,
    has_document: null,
    namespaces: namespaces.map(unknownNamespace)
  };
}
