import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import {validateChannelAttachmentProtocolV2} from './attachment-protocol-migration-v2.ts';

type Row = Record<string, any>;

const THREADS_SQL = `CREATE TABLE ga_channel_threads (
  channel TEXT NOT NULL, principal TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(channel,principal,provider_thread_id)
)`;
const EVENTS_SQL = `CREATE TABLE ga_channel_message_events (
  channel TEXT NOT NULL, principal TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
  run_id TEXT NOT NULL, attachments_json TEXT NOT NULL, event_sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(channel,principal,provider_thread_id,provider_message_id)
)`;
const EVENT_PIN_INDEX_SQL = `CREATE UNIQUE INDEX idx_ga_channel_event_binding_pin
  ON ga_channel_message_events(channel,principal,provider_thread_id,provider_message_id,channel_binding_id,binding_version)`;
const CONTEXTS_SQL = `CREATE TABLE ga_channel_reply_contexts (
  channel TEXT NOT NULL CHECK(channel='weixin'),
  principal TEXT NOT NULL,
  provider_thread_id TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  channel_binding_id TEXT NOT NULL,
  binding_version INTEGER NOT NULL CHECK(binding_version > 0),
  state TEXT NOT NULL CHECK(state IN ('available','missing','expiry_unknown','expired','revoked')),
  context_ciphertext TEXT,
  context_key_id TEXT,
  context_fingerprint TEXT,
  context_fingerprint_key_id TEXT,
  expires_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY(channel,principal,provider_thread_id,provider_message_id),
  FOREIGN KEY(channel,principal,provider_thread_id,provider_message_id,channel_binding_id,binding_version)
    REFERENCES ga_channel_message_events(channel,principal,provider_thread_id,provider_message_id,channel_binding_id,binding_version) ON DELETE CASCADE,
  FOREIGN KEY(channel_binding_id) REFERENCES ga_owner_channel_bindings(channel_binding_id) ON DELETE RESTRICT,
  CHECK (
    (state IN ('available','expiry_unknown') AND context_ciphertext IS NOT NULL
      AND context_key_id IS NOT NULL AND context_fingerprint IS NOT NULL
      AND context_fingerprint_key_id IS NOT NULL
      AND ((state='available' AND expires_at IS NOT NULL) OR
           (state='expiry_unknown' AND expires_at IS NULL)) AND revoked_at IS NULL)
    OR (state='missing' AND context_ciphertext IS NULL AND context_key_id IS NULL
      AND context_fingerprint IS NULL AND context_fingerprint_key_id IS NULL
      AND expires_at IS NULL AND revoked_at IS NULL)
    OR (state='expired' AND context_ciphertext IS NULL AND context_key_id IS NULL
      AND context_fingerprint IS NULL AND context_fingerprint_key_id IS NULL
      AND expires_at IS NOT NULL AND revoked_at IS NULL)
    OR (state='revoked' AND context_ciphertext IS NULL AND context_key_id IS NULL
      AND context_fingerprint IS NULL AND context_fingerprint_key_id IS NULL
      AND revoked_at IS NOT NULL)
  )
)`;
const CONTEXT_EXPIRY_INDEX_SQL = `CREATE INDEX idx_ga_channel_reply_context_expiry
  ON ga_channel_reply_contexts(channel,state,expires_at)`;
const CURSORS_SQL = `CREATE TABLE ga_channel_poll_cursors (
  channel TEXT NOT NULL CHECK(channel='weixin'),
  provider_account_id TEXT NOT NULL,
  cursor_ciphertext TEXT NOT NULL,
  cursor_key_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(channel,provider_account_id)
)`;
const FILE_TRIGGER_SQL = `CREATE TRIGGER ga_channel_file_claim_protocol_v1
BEFORE UPDATE OF status ON ga_channel_deliveries
WHEN OLD.artifact_ref IS NOT NULL
 AND OLD.status IN ('pending','historical_pending') AND NEW.status='sending'
BEGIN
  SELECT CASE WHEN NEW.generation <> OLD.generation + 1
                OR NEW.file_claim_protocol_generation <> NEW.generation
    THEN RAISE(ABORT,'channel_file_claim_protocol_required') END;
  SELECT CASE WHEN OLD.payload_json IS NULL OR json_valid(OLD.payload_json) <> 1
    THEN RAISE(ABORT,'channel_delivery_artifact_pin_required') END;
  SELECT CASE WHEN json_extract(OLD.payload_json,'$.kind') IS NOT 'artifact'
                OR json_extract(OLD.payload_json,'$.schema_version') IS NOT 1
    THEN RAISE(ABORT,'channel_delivery_artifact_pin_required') END;
END`;
const WEIXIN_TRIGGER_SQL = `CREATE TRIGGER ga_channel_weixin_claim_protocol_v1
BEFORE UPDATE OF status ON ga_channel_deliveries
WHEN OLD.destination='weixin' AND OLD.artifact_ref IS NULL
 AND OLD.status IN ('pending','historical_pending') AND NEW.status='sending'
BEGIN
  SELECT CASE WHEN NEW.generation <> OLD.generation + 1
                OR NEW.weixin_claim_protocol_generation <> NEW.generation
    THEN RAISE(ABORT,'channel_weixin_claim_protocol_required') END;
END`;

function fail(code: string): never { throw new Error(code); }

type SqlToken = { kind: 'identifier' | 'string' | 'number' | 'symbol'; value: string };

function asciiLower(value: string): string { return value.replace(/[A-Z]/g, char => char.toLowerCase()); }

function tokenizeSql(value: unknown): SqlToken[] {
  const sql = String(value ?? ''), tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const char = sql[i]!;
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i += 1;
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
      continue;
    }
    if (char === "'") {
      i += 1;
      let literal = '';
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { literal += "'"; i += 2; continue; }
          i += 1;
          break;
        }
        literal += sql[i]!;
        i += 1;
      }
      tokens.push({ kind: 'string', value: literal });
      continue;
    }
    if (char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char;
      i += 1;
      let identifier = '';
      while (i < sql.length) {
        if (sql[i] === close) {
          if (close !== ']' && sql[i + 1] === close) { identifier += close; i += 2; continue; }
          i += 1;
          break;
        }
        identifier += sql[i]!;
        i += 1;
      }
      tokens.push({ kind: 'identifier', value: asciiLower(identifier) });
      continue;
    }
    if (/[A-Za-z_\u0080-\uFFFF]/.test(char)) {
      let word = char;
      i += 1;
      while (i < sql.length && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[i]!)) { word += sql[i]!; i += 1; }
      tokens.push({ kind: 'identifier', value: asciiLower(word) });
      continue;
    }
    if (/[0-9]/.test(char)) {
      const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(i))![0];
      tokens.push({ kind: 'number', value: number });
      i += number.length;
      continue;
    }
    const operator = ['->>', '->', '>=', '<=', '<>', '!=', '==', '||'].find(candidate => sql.startsWith(candidate, i));
    if (operator) { tokens.push({ kind: 'symbol', value: operator }); i += operator.length; continue; }
    tokens.push({ kind: 'symbol', value: char });
    i += 1;
  }
  while (tokens.at(-1)?.kind === 'symbol' && tokens.at(-1)?.value === ';') tokens.pop();
  return tokens;
}

function comparableSqlTokens(value: unknown): string[] {
  const tokens = tokenizeSql(value);
  for (let i = 1; i < Math.min(tokens.length - 2, 8); i += 1) {
    if (tokens[i]!.kind === 'identifier' && tokens[i]!.value === 'if'
      && tokens[i + 1]!.kind === 'identifier' && tokens[i + 1]!.value === 'not'
      && tokens[i + 2]!.kind === 'identifier' && tokens[i + 2]!.value === 'exists'
      && tokens[i - 1]!.kind === 'identifier' && ['table', 'index', 'trigger', 'view'].includes(tokens[i - 1]!.value)) {
      tokens.splice(i, 3);
      break;
    }
  }
  return tokens.map(token => `${token.kind}:${JSON.stringify(token.value)}`);
}

function normalizeSql(value: unknown): string {
  return JSON.stringify(comparableSqlTokens(value));
}

function hasSqlTokenSequence(value: unknown, snippet: string): boolean {
  const actual = comparableSqlTokens(value), expected = comparableSqlTokens(snippet);
  return expected.length > 0 && actual.some((_token, start) =>
    start + expected.length <= actual.length && expected.every((token, offset) => actual[start + offset] === token));
}

function sqlFor(db: DatabaseSync, type: string, name: string): string | null {
  const row = db.prepare('SELECT sql FROM sqlite_master WHERE type=? AND name=? COLLATE NOCASE').get(type, name) as
    { sql?: string | null } | undefined;
  return row?.sql ?? null;
}

function validateNamedSql(db: DatabaseSync, type: string, name: string, expected: string): void {
  const actual = sqlFor(db, type, name);
  if (actual !== null && normalizeSql(actual) !== normalizeSql(expected)) fail('channel_authority_schema_mismatch');
  if (actual === null) db.exec(expected);
  const installed = sqlFor(db, type, name);
  if (installed === null || normalizeSql(installed) !== normalizeSql(expected)) fail('channel_authority_schema_mismatch');
}

function columns(db: DatabaseSync, table: string): Row[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
}

function columnMap(db: DatabaseSync, table: string): Map<string, Row> {
  return new Map(columns(db, table).map(row => [String(row.name), row]));
}

function validateColumnNames(db: DatabaseSync, table: string, required: string[], optional: string[] = []): void {
  const actual = columns(db, table).map(row => String(row.name));
  const allowed = new Set([...required, ...optional]);
  if (required.some(name => !actual.includes(name)) || actual.some(name => !allowed.has(name))) {
    fail('channel_authority_schema_mismatch');
  }
}

function validateColumns(db: DatabaseSync, table: string, expected: Record<string, { type: string; notnull: number; pk?: number }>,
  allowExtra = false): void {
  const rows = columns(db, table), actual = new Map(rows.map(row => [String(row.name), row]));
  for (const [name, definition] of Object.entries(expected)) {
    const row = actual.get(name);
    if (!row || String(row.type).toUpperCase() !== definition.type || Number(row.notnull) !== definition.notnull
      || (definition.pk !== undefined && Number(row.pk) !== definition.pk)) fail('channel_authority_schema_mismatch');
  }
  if (!allowExtra && rows.some(row => !Object.hasOwn(expected, String(row.name)))) fail('channel_authority_schema_mismatch');
}

function validatePinCheck(db: DatabaseSync, table: string): void {
  const sql = sqlFor(db, 'table', table);
  if (!hasSqlTokenSequence(sql, 'CHECK(binding_version IS NULL OR binding_version > 0)')) {
    fail('channel_authority_schema_mismatch');
  }
}

function ensurePins(db: DatabaseSync, table: string): void {
  const initial = columnMap(db, table);
  if (!initial.has('channel_binding_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN channel_binding_id TEXT`);
  const afterId = columnMap(db, table);
  if (!afterId.has('binding_version')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN binding_version INTEGER CHECK(binding_version IS NULL OR binding_version > 0)`);
  } else validatePinCheck(db, table);
  const final = columnMap(db, table);
  if (!final.has('channel_binding_id') || !final.has('binding_version')
    || String(final.get('channel_binding_id')!.type).toUpperCase() !== 'TEXT'
    || String(final.get('binding_version')!.type).toUpperCase() !== 'INTEGER'
    || Number(final.get('channel_binding_id')!.notnull) !== 0 || Number(final.get('binding_version')!.notnull) !== 0) {
    fail('channel_authority_schema_mismatch');
  }
  validatePinCheck(db, table);
}

function ensureDeliveryProtocolColumn(db: DatabaseSync, name: string): void {
  const before = columnMap(db, 'ga_channel_deliveries');
  if (!before.has(name)) {
    db.exec(`ALTER TABLE ga_channel_deliveries ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0 CHECK(${name} >= 0)`);
  }
  const after = columnMap(db, 'ga_channel_deliveries').get(name);
  const sql = sqlFor(db, 'table', 'ga_channel_deliveries');
  if (!after || String(after.type).toUpperCase() !== 'INTEGER' || Number(after.notnull) !== 1
    || after.dflt_value !== '0' || !hasSqlTokenSequence(sql, `CHECK(${name} >= 0)`)) {
    fail('channel_authority_schema_mismatch');
  }
}

function validateBindingAuthorityParent(db: DatabaseSync): void {
  if (!sqlFor(db, 'table', 'ga_owner_channel_bindings')) fail('channel_authority_binding_table_missing');
  validateColumns(db, 'ga_owner_channel_bindings', {
    channel_binding_id: { type: 'TEXT', notnull: 0, pk: 1 },
    owner_id: { type: 'TEXT', notnull: 1 }, channel: { type: 'TEXT', notnull: 1 },
    principal: { type: 'TEXT', notnull: 1 }, status: { type: 'TEXT', notnull: 1 },
    version: { type: 'INTEGER', notnull: 1 }, verified_at: { type: 'INTEGER', notnull: 1 },
    revoked_at: { type: 'INTEGER', notnull: 0 }, created_at: { type: 'INTEGER', notnull: 1 },
  });
  const principalIndex = sqlFor(db, 'index', 'ga_owner_channel_principal');
  const identityTrigger = sqlFor(db, 'trigger', 'ga_owner_channel_binding_identity');
  if (!principalIndex || normalizeSql(principalIndex) !== normalizeSql(
    `CREATE UNIQUE INDEX ga_owner_channel_principal ON ga_owner_channel_bindings(channel,principal) WHERE status='verified'`)
    || !identityTrigger || normalizeSql(identityTrigger) !== normalizeSql(
      `CREATE TRIGGER ga_owner_channel_binding_identity BEFORE UPDATE OF channel_binding_id,owner_id,channel,principal
       ON ga_owner_channel_bindings BEGIN SELECT RAISE(ABORT,'channel_binding_identity_immutable'); END`)) {
    fail('channel_authority_schema_mismatch');
  }
}

function validateLegacyChannelTables(db: DatabaseSync): void {
  const pinColumns = ['channel_binding_id', 'binding_version'];
  validateColumnNames(db, 'ga_channel_bindings', ['channel', 'principal', 'conversation_id', 'created_at', 'updated_at'], pinColumns);
  validateColumns(db, 'ga_channel_bindings', {
    channel: { type: 'TEXT', notnull: 1, pk: 1 }, principal: { type: 'TEXT', notnull: 1, pk: 2 },
    conversation_id: { type: 'TEXT', notnull: 1 }, created_at: { type: 'TEXT', notnull: 1 }, updated_at: { type: 'TEXT', notnull: 1 },
  }, true);
  const rootForeignKeys = db.prepare('PRAGMA foreign_key_list(ga_channel_bindings)').all() as Row[];
  const rootForeignKey = rootForeignKeys[0];
  if (rootForeignKeys.length !== 1 || !rootForeignKey
    || asciiLower(String(rootForeignKey.table)) !== 'ga_conversations'
    || asciiLower(String(rootForeignKey.from)) !== 'conversation_id'
    || asciiLower(String(rootForeignKey.to)) !== 'id' || rootForeignKey.on_delete !== 'CASCADE'
    || rootForeignKey.on_update !== 'NO ACTION' || rootForeignKey.match !== 'NONE') {
    fail('channel_authority_schema_mismatch');
  }
  validateColumnNames(db, 'ga_channel_threads', ['channel', 'principal', 'provider_thread_id', 'conversation_id', 'created_at', 'updated_at'], pinColumns);
  validateColumns(db, 'ga_channel_threads', {
    channel: { type: 'TEXT', notnull: 1, pk: 1 }, principal: { type: 'TEXT', notnull: 1, pk: 2 },
    provider_thread_id: { type: 'TEXT', notnull: 1, pk: 3 }, conversation_id: { type: 'TEXT', notnull: 1 },
    created_at: { type: 'TEXT', notnull: 1 }, updated_at: { type: 'TEXT', notnull: 1 },
  }, true);
  validateColumnNames(db, 'ga_channel_message_events', ['channel', 'principal', 'provider_thread_id', 'provider_message_id',
    'conversation_id', 'message_id', 'run_id', 'attachments_json', 'event_sha256', 'created_at'], [...pinColumns,'content_protocol']);
  validateColumns(db, 'ga_channel_message_events', {
    channel: { type: 'TEXT', notnull: 1, pk: 1 }, principal: { type: 'TEXT', notnull: 1, pk: 2 },
    provider_thread_id: { type: 'TEXT', notnull: 1, pk: 3 }, provider_message_id: { type: 'TEXT', notnull: 1, pk: 4 },
    conversation_id: { type: 'TEXT', notnull: 1 }, message_id: { type: 'TEXT', notnull: 1 },
    run_id: { type: 'TEXT', notnull: 1 }, attachments_json: { type: 'TEXT', notnull: 1 },
    event_sha256: { type: 'TEXT', notnull: 1 }, created_at: { type: 'TEXT', notnull: 1 },
  }, true);
  validateChannelAttachmentProtocolV2(db);
  validateColumnNames(db, 'ga_channel_deliveries', ['effect_id', 'run_id', 'message_id', 'destination', 'recipient',
    'artifact_ref', 'payload_json', 'status', 'generation', 'lease_owner', 'lease_expires_at', 'provider_receipt_json',
    'last_reason_code', 'created_at', 'updated_at'], ['file_claim_protocol_generation', 'weixin_claim_protocol_generation']);
  validateColumns(db, 'ga_channel_deliveries', {
    effect_id: { type: 'TEXT', notnull: 0, pk: 1 }, run_id: { type: 'TEXT', notnull: 0 },
    message_id: { type: 'TEXT', notnull: 1 }, destination: { type: 'TEXT', notnull: 1 },
    recipient: { type: 'TEXT', notnull: 1 }, artifact_ref: { type: 'TEXT', notnull: 0 },
    payload_json: { type: 'TEXT', notnull: 0 }, status: { type: 'TEXT', notnull: 1 },
    generation: { type: 'INTEGER', notnull: 1 },
    lease_owner: { type: 'TEXT', notnull: 0 }, lease_expires_at: { type: 'INTEGER', notnull: 0 },
    provider_receipt_json: { type: 'TEXT', notnull: 0 }, last_reason_code: { type: 'TEXT', notnull: 0 },
    created_at: { type: 'TEXT', notnull: 1 }, updated_at: { type: 'TEXT', notnull: 1 },
  }, true);
}

/** Install the shared M19 authority schema after the owner-binding parent exists.
 * Callers own process ordering and must run this on the same product DB handle. */
export function installChannelAuthorityMigration(db: DatabaseSync): void {
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
  if (Number(foreignKeys?.foreign_keys) !== 1) fail('channel_authority_foreign_keys_required');
  withImmediateTransaction(db, () => {
    validateBindingAuthorityParent(db);
    if (!sqlFor(db, 'table', 'ga_channel_bindings')) fail('channel_authority_schema_mismatch');
    if (!sqlFor(db, 'table', 'ga_channel_threads')) db.exec(THREADS_SQL);
    if (!sqlFor(db, 'table', 'ga_channel_message_events')) db.exec(EVENTS_SQL);
    validateLegacyChannelTables(db);

    ensurePins(db, 'ga_channel_bindings');
    ensurePins(db, 'ga_channel_threads');
    ensurePins(db, 'ga_channel_message_events');
    ensureDeliveryProtocolColumn(db, 'file_claim_protocol_generation');
    ensureDeliveryProtocolColumn(db, 'weixin_claim_protocol_generation');

    validateNamedSql(db, 'index', 'idx_ga_channel_event_binding_pin', EVENT_PIN_INDEX_SQL);
    validateNamedSql(db, 'table', 'ga_channel_reply_contexts', CONTEXTS_SQL);
    validateNamedSql(db, 'index', 'idx_ga_channel_reply_context_expiry', CONTEXT_EXPIRY_INDEX_SQL);
    validateNamedSql(db, 'table', 'ga_channel_poll_cursors', CURSORS_SQL);
    validateNamedSql(db, 'trigger', 'ga_channel_file_claim_protocol_v1', FILE_TRIGGER_SQL);
    validateNamedSql(db, 'trigger', 'ga_channel_weixin_claim_protocol_v1', WEIXIN_TRIGGER_SQL);

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) fail('channel_authority_foreign_key_check_failed');
  });
}
