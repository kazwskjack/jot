import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';

export const PLUGIN_PROFILE_RECEIPT_PROTOCOL = 'plugin-profile-atomic-v1';

const OPERATIONS = new Set([
  'plugin.bundle.install',
  'plugin.bundle.enable',
  'plugin.bundle.remove',
  'plugin.bundle.cancel',
]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const OPERATION_ID = /^[\x21-\x7e]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATES = new Set(['reserved', 'dispatched', 'settled', 'unknown']);

type ReceiptState = 'reserved' | 'dispatched' | 'settled' | 'unknown';
type RouteOperation = {
  ownerId: string;
  routeOperation: string;
  operation: string;
  operationId: string;
  actionSha256: string;
};
type ReceiptContext = Omit<RouteOperation, 'routeOperation'> & { profileId: string };
type Row = Record<string, string | number | null>;
type ReceiptValue = { state: ReceiptState; response?: unknown; responseStatus?: number };

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

function inputObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('plugin_profile_receipt_request_invalid');
  return value as Record<string, unknown>;
}

function exactKeys(input: Record<string, unknown>, expected: string[]): void {
  const keys = Object.keys(input).sort(), wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail('plugin_profile_receipt_request_invalid');
  }
}

function addColumn(db: DatabaseSync, column: string, definition: string): void {
  const columns = db.prepare('PRAGMA table_info(ga_idempotency)').all() as Array<{ name: string }>;
  if (!columns.some(value => value.name === column)) db.exec(`ALTER TABLE ga_idempotency ADD COLUMN ${column} ${definition}`);
}

/** Add nullable M17.03 metadata to the existing receipt table. */
export function installPluginProfileReceiptProtocol(db: DatabaseSync): void {
  withImmediateTransaction(db, () => {
    addColumn(db, 'receipt_protocol', 'TEXT');
    addColumn(db, 'operation_state', "TEXT CHECK(operation_state IS NULL OR operation_state IN ('reserved','dispatched','settled','unknown'))");
    addColumn(db, 'operation_code', 'TEXT');
    addColumn(db, 'operation_action_sha256', 'TEXT');
    addColumn(db, 'operation_profile_id', 'TEXT');
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ga_idempotency_plugin_profile
      ON ga_idempotency(owner_id,idempotency_key,receipt_protocol,operation_code,operation_action_sha256)`);
  });
}

function routeOperation(value: unknown): string {
  if (typeof value !== 'string' || !/^(GET|POST|PATCH|DELETE) \/v1\/plugin-profile\/[^?\s]{1,384}$/.test(value)) {
    fail('plugin_profile_receipt_request_invalid');
  }
  return value;
}

function operationContext(value: unknown): ReceiptContext {
  const input = inputObject(value);
  exactKeys(input, ['ownerId', 'profileId', 'operation', 'operationId', 'actionSha256']);
  if (typeof input.ownerId !== 'string' || !ID.test(input.ownerId)
    || typeof input.profileId !== 'string' || !ID.test(input.profileId)
    || typeof input.operation !== 'string' || !OPERATIONS.has(input.operation)
    || typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)
    || typeof input.actionSha256 !== 'string' || !HASH.test(input.actionSha256)) {
    fail('plugin_profile_receipt_request_invalid');
  }
  return {
    ownerId: input.ownerId,
    profileId: input.profileId,
    operation: input.operation,
    operationId: input.operationId,
    actionSha256: input.actionSha256,
  };
}

function routeInput(value: unknown): RouteOperation {
  const input = inputObject(value);
  exactKeys(input, ['ownerId', 'routeOperation', 'operation', 'operationId', 'actionSha256']);
  if (typeof input.ownerId !== 'string' || !ID.test(input.ownerId)
    || typeof input.operation !== 'string' || !OPERATIONS.has(input.operation)
    || typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)
    || typeof input.actionSha256 !== 'string' || !HASH.test(input.actionSha256)) {
    fail('plugin_profile_receipt_request_invalid');
  }
  return {
    ownerId: input.ownerId,
    routeOperation: routeOperation(input.routeOperation),
    operation: input.operation,
    operationId: input.operationId,
    actionSha256: input.actionSha256,
  };
}

const MAX_RESPONSE_BYTES = 64 * 1024;

function responseJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_RESPONSE_BYTES) fail('plugin_profile_receipt_response_invalid');
    return json;
  } catch {
    fail('plugin_profile_receipt_response_invalid');
  }
}

function readResponse(row: Row): unknown {
  if (typeof row.response_json !== 'string') fail('plugin_profile_receipt_corrupt');
  try { return JSON.parse(row.response_json); } catch { fail('plugin_profile_receipt_corrupt'); }
}

function rowState(row: Row): ReceiptState {
  if (typeof row.operation_state !== 'string' || !STATES.has(row.operation_state)) fail('plugin_profile_receipt_corrupt');
  return row.operation_state as ReceiptState;
}

function unexpired(row: Row, now: number): boolean {
  if (typeof row.expires_at !== 'string') return false;
  const expiresAt = Date.parse(row.expires_at);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

function contextRow(db: DatabaseSync, context: ReceiptContext): Row {
  const rows = db.prepare(`SELECT * FROM ga_idempotency
    WHERE owner_id=? AND idempotency_key=? AND receipt_protocol=? AND operation_code=? AND operation_action_sha256=?`)
    .all(context.ownerId, context.operationId, PLUGIN_PROFILE_RECEIPT_PROTOCOL, context.operation, context.actionSha256) as Row[];
  if (rows.length !== 1) fail('plugin_profile_receipt_not_found');
  const row = rows[0];
  if (!row) fail('plugin_profile_receipt_not_found');
  const state = rowState(row);
  if (state !== 'reserved' && row.operation_profile_id !== context.profileId) fail('plugin_profile_receipt_scope_mismatch');
  return row;
}

function stateValue(row: Row): ReceiptValue {
  const state = rowState(row);
  if (state === 'settled') {
    const responseStatus = Number(row.response_status);
    if (!Number.isSafeInteger(responseStatus) || responseStatus < 200 || responseStatus > 599) fail('plugin_profile_receipt_corrupt');
    return { state, response: readResponse(row), responseStatus };
  }
  return { state };
}

function markUnknownInTransaction(db: DatabaseSync, context: ReceiptContext, allowExpiredReservation = false): ReceiptValue {
  const row = contextRow(db, context), state = rowState(row);
  if (state === 'settled') return stateValue(row);
  if (state === 'unknown') return { state };
  if (state === 'reserved' && !allowExpiredReservation) fail('plugin_profile_receipt_not_dispatched');
  const serialized = JSON.stringify({ error: { code: 'PLUGIN_OPERATION_UNKNOWN' } });
  const changed = db.prepare(`UPDATE ga_idempotency SET operation_state='unknown',operation_profile_id=COALESCE(operation_profile_id,?),
    response_status=409,response_json=? WHERE owner_id=? AND idempotency_key=? AND receipt_protocol=?
      AND operation_code=? AND operation_action_sha256=? AND operation_state IN ('reserved','dispatched')`)
    .run(context.profileId, serialized, context.ownerId, context.operationId, PLUGIN_PROFILE_RECEIPT_PROTOCOL,
      context.operation, context.actionSha256).changes;
  if (changed !== 1) fail('plugin_profile_receipt_state_conflict');
  return { state: 'unknown' };
}

export function createPluginProfileReceiptExecutor(db: DatabaseSync, { now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof now !== 'function') fail('plugin_profile_receipt_database_unavailable');
  installPluginProfileReceiptProtocol(db);

  return Object.freeze({
    bindReservation(value: unknown): ReceiptValue {
      const input = routeInput(value);
      return withImmediateTransaction(db, () => {
        const row = db.prepare(`SELECT * FROM ga_idempotency
          WHERE owner_id=? AND operation=? AND idempotency_key=?`)
          .get(input.ownerId, input.routeOperation, input.operationId) as Row | undefined;
        if (!row) fail('plugin_profile_receipt_not_found');
        if (row.receipt_protocol !== null && row.receipt_protocol !== PLUGIN_PROFILE_RECEIPT_PROTOCOL) {
          fail('plugin_profile_receipt_protocol_conflict');
        }
        if (row.response_status !== null) {
          if (row.operation_code !== input.operation || row.operation_action_sha256 !== input.actionSha256) {
            fail('plugin_profile_receipt_state_conflict');
          }
          if (row.operation_state === 'unknown') return {state: 'unknown'};
          if (row.operation_state !== 'settled') fail('plugin_profile_receipt_state_conflict');
          return stateValue(row);
        }
        if (row.operation_state === 'unknown') return {state: 'unknown'};
        if (row.operation_state === 'dispatched') {
          if (row.operation_code !== input.operation || row.operation_action_sha256 !== input.actionSha256) {
            fail('plugin_profile_receipt_state_conflict');
          }
          return {state: 'dispatched'};
        }
        if (row.operation_state === null) {
          if (row.operation_code !== null && row.operation_code !== input.operation
            || row.operation_action_sha256 !== null && row.operation_action_sha256 !== input.actionSha256) {
            fail('plugin_profile_receipt_state_conflict');
          }
          db.prepare(`UPDATE ga_idempotency SET receipt_protocol=?,operation_state='reserved',operation_code=?,
            operation_action_sha256=? WHERE owner_id=? AND operation=? AND idempotency_key=?
            AND response_status IS NULL AND operation_state IS NULL AND (receipt_protocol IS NULL OR receipt_protocol=?)`)
            .run(PLUGIN_PROFILE_RECEIPT_PROTOCOL, input.operation, input.actionSha256,
              input.ownerId, input.routeOperation, input.operationId, PLUGIN_PROFILE_RECEIPT_PROTOCOL);
        } else if (row.operation_state !== 'reserved' || row.operation_code !== input.operation
          || row.operation_action_sha256 !== input.actionSha256) {
          fail('plugin_profile_receipt_state_conflict');
        }
        const current = db.prepare(`SELECT * FROM ga_idempotency WHERE owner_id=? AND operation=? AND idempotency_key=?`)
          .get(input.ownerId, input.routeOperation, input.operationId) as Row | undefined;
        if (!current || current.operation_state !== 'reserved' || current.operation_code !== input.operation
          || current.operation_action_sha256 !== input.actionSha256) fail('plugin_profile_receipt_state_conflict');
        return { state: 'reserved' };
      });
    },

    lookupReservation(value: unknown): ReceiptValue {
      const input = routeInput(value);
      const row = db.prepare(`SELECT * FROM ga_idempotency
        WHERE owner_id=? AND operation=? AND idempotency_key=? AND receipt_protocol=?
          AND operation_code=? AND operation_action_sha256=?`)
        .get(input.ownerId, input.routeOperation, input.operationId, PLUGIN_PROFILE_RECEIPT_PROTOCOL,
          input.operation, input.actionSha256) as Row | undefined;
      if (!row) fail('plugin_profile_receipt_not_found');
      return stateValue(row);
    },

    /** Close a reservation after the Gateway-to-Host response is lost. */
    markUnknownReservation(value: unknown): ReceiptValue {
      const input = routeInput(value);
      return withImmediateTransaction(db, () => {
        const row = db.prepare(`SELECT * FROM ga_idempotency
          WHERE owner_id=? AND operation=? AND idempotency_key=? AND receipt_protocol=?
            AND operation_code=? AND operation_action_sha256=?`)
          .get(input.ownerId, input.routeOperation, input.operationId, PLUGIN_PROFILE_RECEIPT_PROTOCOL,
            input.operation, input.actionSha256) as Row | undefined;
        if (!row) fail('plugin_profile_receipt_not_found');
        const state = rowState(row);
        if (state === 'settled') return stateValue(row);
        if (state === 'unknown') return {state};
        const serialized = JSON.stringify({error: {code: 'PLUGIN_OPERATION_UNKNOWN'}});
        const changed = db.prepare(`UPDATE ga_idempotency SET operation_state='unknown',response_status=409,response_json=?
          WHERE owner_id=? AND operation=? AND idempotency_key=? AND receipt_protocol=?
            AND operation_code=? AND operation_action_sha256=? AND operation_state IN ('reserved','dispatched')`)
          .run(serialized, input.ownerId, input.routeOperation, input.operationId, PLUGIN_PROFILE_RECEIPT_PROTOCOL,
            input.operation, input.actionSha256).changes;
        if (changed !== 1) fail('plugin_profile_receipt_state_conflict');
        return {state: 'unknown'};
      });
    },

    claim(value: unknown): { dispatch: boolean; state: ReceiptState; response?: unknown; responseStatus?: number } {
      const context = operationContext(value);
      return withImmediateTransaction(db, () => {
        const row = contextRow(db, context);
        const state = rowState(row);
        if (state === 'settled') return { dispatch: false, ...stateValue(row) };
        if (state === 'unknown' || state === 'dispatched') return { dispatch: false, state };
        if (!unexpired(row, now())) {
          markUnknownInTransaction(db, context, true);
          return { dispatch: false, state: 'unknown' };
        }
        const changed = db.prepare(`UPDATE ga_idempotency SET operation_state='dispatched',operation_profile_id=?
          WHERE owner_id=? AND idempotency_key=? AND receipt_protocol=? AND operation_code=?
            AND operation_action_sha256=? AND operation_state='reserved' AND operation_profile_id IS NULL
            AND response_status IS NULL`)
          .run(context.profileId, context.ownerId, context.operationId, PLUGIN_PROFILE_RECEIPT_PROTOCOL,
            context.operation, context.actionSha256).changes;
        if (changed !== 1) fail('plugin_profile_receipt_state_conflict');
        return { dispatch: true, state: 'dispatched' };
      });
    },

    settle(value: unknown, response: unknown): ReceiptValue {
      const context = operationContext(value), serialized = responseJson(response);
      return withImmediateTransaction(db, () => {
        const row = contextRow(db, context), state = rowState(row);
        if (state === 'settled') return stateValue(row);
        if (state === 'unknown') fail('plugin_profile_receipt_unknown');
        if (state !== 'dispatched') fail('plugin_profile_receipt_not_dispatched');
        const changed = db.prepare(`UPDATE ga_idempotency SET operation_state='settled',response_status=200,response_json=?
          WHERE owner_id=? AND idempotency_key=? AND receipt_protocol=? AND operation_code=?
            AND operation_action_sha256=? AND operation_profile_id=? AND operation_state='dispatched' AND response_status IS NULL`)
          .run(serialized, context.ownerId, context.operationId, PLUGIN_PROFILE_RECEIPT_PROTOCOL,
            context.operation, context.actionSha256, context.profileId).changes;
        if (changed !== 1) fail('plugin_profile_receipt_state_conflict');
        return { state: 'settled', response: JSON.parse(serialized), responseStatus: 200 };
      });
    },

    markUnknown(value: unknown): ReceiptValue {
      const context = operationContext(value);
      return withImmediateTransaction(db, () => markUnknownInTransaction(db, context));
    },

    lookup(value: unknown): ReceiptValue {
      const context = operationContext(value);
      return stateValue(contextRow(db, context));
    },
  });
}
