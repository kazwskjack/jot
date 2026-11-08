export type RuntimeDependency = 'db' | 'schema' | 'host' | 'native' | 'consumer' | 'policy' | 'storage' | 'driver';
export type RuntimeDependencyStatus = 'ready' | 'disabled' | 'unknown' | 'failed';

export interface RuntimeDependencyObservation {
  component: RuntimeDependency;
  status: RuntimeDependencyStatus;
  required: boolean;
  observed_at?: string;
  reason?: string;
}

export interface RuntimeDependencyResult {
  component: RuntimeDependency;
  status: RuntimeDependencyStatus;
  required: boolean;
  observed_at?: string;
  reason: string | null;
}

export interface RuntimeReadiness {
  schema_version: 1;
  execution_ready: boolean;
  components: RuntimeDependencyResult[];
  errors: string[];
}

const COMPONENTS: RuntimeDependency[] = ['db', 'schema', 'host', 'native', 'consumer', 'policy', 'storage', 'driver'];
const VALID_STATUSES = new Set<RuntimeDependencyStatus>(['ready', 'disabled', 'unknown', 'failed']);
const VALID_REASONS = /^[a-z][a-z0-9_]{0,63}$/;
const ISO_TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/;

/**
 * Combine current, non-mutating dependency observations. Missing, malformed, or
 * conflicting evidence is unknown and cannot produce execution readiness.
 */
export function aggregateRuntimeReadiness(observations: RuntimeDependencyObservation[]): RuntimeReadiness {
  const grouped = new Map<string, unknown[]>();
  const errors = new Set<string>();
  for (const value of Array.isArray(observations) ? observations : []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.add('observation_invalid');
      continue;
    }
    const row = value as unknown as Record<string, unknown>;
    if (typeof row.component !== 'string' || !COMPONENTS.includes(row.component as RuntimeDependency)) {
      errors.add('component_unknown');
      continue;
    }
    const items = grouped.get(row.component) ?? [];
    items.push(row);
    grouped.set(row.component, items);
  }

  const components: RuntimeDependencyResult[] = COMPONENTS.map(component => {
    const rows = grouped.get(component) ?? [];
    if (rows.length === 0) return { component, status: 'unknown', required: true, reason: 'observation_missing' };
    if (rows.length > 1) return { component, status: 'unknown', required: true, reason: 'observation_duplicated' };
    const row = rows[0] as Record<string, unknown>;
    if (!VALID_STATUSES.has(row.status as RuntimeDependencyStatus) || typeof row.required !== 'boolean') {
      return { component, status: 'unknown', required: true, reason: 'observation_invalid' };
    }
    if (row.observed_at !== undefined && (typeof row.observed_at !== 'string' || row.observed_at.length > 64
      || !ISO_TIMESTAMP.test(row.observed_at) || !Number.isFinite(Date.parse(row.observed_at)))) {
      return { component, status: 'unknown', required: true, reason: 'observation_invalid' };
    }
    if (row.reason !== undefined && (typeof row.reason !== 'string' || !VALID_REASONS.test(row.reason))) {
      return { component, status: 'unknown', required: true, reason: 'reason_invalid' };
    }
    return {
      component,
      status: row.status as RuntimeDependencyStatus,
      required: row.required,
      ...(typeof row.observed_at === 'string' ? { observed_at: row.observed_at } : {}),
      reason: typeof row.reason === 'string' ? row.reason : null,
    };
  });
  const executionReady = errors.size === 0 && components.every(component => !component.required || component.status === 'ready');
  return {
    schema_version: 1 as const,
    execution_ready: executionReady,
    components,
    errors: [...errors].sort(),
  };
}
