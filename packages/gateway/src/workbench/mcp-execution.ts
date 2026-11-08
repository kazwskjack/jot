import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { TaskExecutionEvidence } from '../persistent-tasks/execution-evidence.ts';
import { withImmediateTransaction } from '../db/database.ts';
import type { McpRegistryService } from './mcp-registry.ts';

type Input = Record<string, unknown>;
type Row = Record<string, string | number | null>;
export type McpRunIdentity = { owner_id: string; agent_id: string; run_id: string; session_ref: string };
type McpCallInput = { connection_id: string; generation: number; tool_id: string; call_id: string; arguments: Input };
type Settled = { state: 'settled'; operation_id: string; result: unknown; execution_receipt: { kind: string; reference: string; hash?: string } };
type Unknown = { state: 'unknown'; operation_id: string; error: 'mcp_operation_unknown' };
export type McpUnknownOperationProjection = { operation_id: string; state: 'unknown'; updated_at: string };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const CALL_ID = IDENTIFIER;
const MAX_ARGUMENT_BYTES = 131072;
const MAX_RESULT_BYTES = 524288;
const now = () => new Date().toISOString();

function object(value: unknown, code = 'invalid_mcp_call'): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Input;
}
function exact(value: Input, keys: string[], code: string): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(code);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Input;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('invalid_mcp_call');
  return serialized;
}
function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function identity(value: unknown): McpRunIdentity {
  const input = object(value, 'workbench_identity_forbidden');
  if (typeof input.owner_id !== 'string' || !IDENTIFIER.test(input.owner_id)
    || typeof input.agent_id !== 'string' || !IDENTIFIER.test(input.agent_id)
    || typeof input.run_id !== 'string' || !IDENTIFIER.test(input.run_id)
    || typeof input.session_ref !== 'string' || !IDENTIFIER.test(input.session_ref)) throw new Error('workbench_identity_forbidden');
  return { owner_id: input.owner_id, agent_id: input.agent_id, run_id: input.run_id, session_ref: input.session_ref };
}
function callInput(value: unknown): McpCallInput {
  const input = object(value); exact(input, ['connection_id', 'generation', 'tool_id', 'call_id', 'arguments'], 'invalid_mcp_call');
  if (typeof input.connection_id !== 'string' || !IDENTIFIER.test(input.connection_id)
    || !Number.isSafeInteger(input.generation) || Number(input.generation) < 1
    || typeof input.tool_id !== 'string' || !/^mcp_[a-f0-9]{32}$/.test(input.tool_id)
    || typeof input.call_id !== 'string' || !CALL_ID.test(input.call_id)) throw new Error('invalid_mcp_call');
  const args = object(input.arguments);
  const encoded = canonical(args);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ARGUMENT_BYTES) throw new Error('invalid_mcp_call');
  return { connection_id: input.connection_id, generation: Number(input.generation), tool_id: input.tool_id, call_id: input.call_id, arguments: args };
}
function unknown(row: Row): Unknown {
  return { state: 'unknown', operation_id: String(row.operation_id), error: 'mcp_operation_unknown' };
}

/** Durable at-most-once boundary around calls dispatched by the DSH MCP provider. */
export class McpExecutionJournal {
  private readonly db: DatabaseSync;
  private readonly registry: McpRegistryService;
  private readonly evidence: TaskExecutionEvidence;

  constructor(db: DatabaseSync, registry: McpRegistryService, evidence: TaskExecutionEvidence) {
    this.db = db; this.registry = registry; this.evidence = evidence;
    db.exec(`CREATE TABLE IF NOT EXISTS wb_mcp_operations (
      operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,agent_id TEXT NOT NULL,run_id TEXT NOT NULL,session_ref TEXT NOT NULL,
      connection_id TEXT NOT NULL,generation INTEGER NOT NULL,tool_id TEXT NOT NULL,public_name TEXT NOT NULL,call_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,state TEXT NOT NULL,result_hash TEXT,response_json TEXT,receipt_json TEXT,last_error_code TEXT,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(run_id,call_id));
      CREATE INDEX IF NOT EXISTS wb_mcp_operations_owner ON wb_mcp_operations(owner_id,agent_id,created_at);
      CREATE INDEX IF NOT EXISTS wb_mcp_operations_status ON wb_mcp_operations(owner_id,agent_id,state,updated_at DESC,operation_id);`);
    // A journal restart cannot prove whether an in-flight provider call completed.
    withImmediateTransaction(this.db, () => {
      this.db.prepare("UPDATE wb_mcp_operations SET state='unknown',last_error_code='mcp_operation_unknown',updated_at=? WHERE state='dispatched'")
        .run(now());
    });
  }

  private assertIdentity(row: Row, value: McpRunIdentity): void {
    if (row.owner_id !== value.owner_id || row.agent_id !== value.agent_id || row.run_id !== value.run_id || row.session_ref !== value.session_ref) {
      throw new Error('workbench_identity_forbidden');
    }
  }

  begin(identityValue: unknown, callValue: unknown): Record<string, unknown> {
    const run = identity(identityValue), call = callInput(callValue);
    const requestHash = sha256(canonical({ connection_id: call.connection_id, generation: call.generation,
      tool_id: call.tool_id, arguments: call.arguments }));
    return withImmediateTransaction(this.db, () => {
      const prior = this.db.prepare('SELECT * FROM wb_mcp_operations WHERE run_id=? AND call_id=?')
        .get(run.run_id, call.call_id) as Row | undefined;
      if (prior) {
        this.assertIdentity(prior, run);
        if (prior.request_hash !== requestHash) throw new Error('idempotency_conflict');
        if (prior.state === 'settled') return { dispatch: false, ...this.settled(prior) };
        if (prior.state === 'dispatched') {
          this.db.prepare("UPDATE wb_mcp_operations SET state='unknown',last_error_code='mcp_operation_unknown',updated_at=? WHERE operation_id=? AND state='dispatched'")
            .run(now(), String(prior.operation_id));
          return { dispatch: false, ...unknown({ ...prior, state: 'unknown' }) };
        }
        return { dispatch: false, ...unknown(prior) };
      }
      const tool = this.registry.authorizeTool(run.owner_id, run.agent_id, call.connection_id, call.generation, call.tool_id);
      const operationId = `mcp-op-${randomUUID()}`, time = now();
      this.db.prepare(`INSERT INTO wb_mcp_operations
        (operation_id,owner_id,agent_id,run_id,session_ref,connection_id,generation,tool_id,public_name,call_id,
         request_hash,state,result_hash,response_json,receipt_json,last_error_code,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'dispatched',NULL,NULL,NULL,NULL,?,?)`)
        .run(operationId, run.owner_id, run.agent_id, run.run_id, run.session_ref, call.connection_id,
          call.generation, call.tool_id, tool.public_name, call.call_id, requestHash, time, time);
      return { dispatch: true, state: 'dispatched', operation_id: operationId, connection_id: call.connection_id,
        generation: call.generation, tool_id: call.tool_id, public_name: tool.public_name, input_schema: tool.input_schema };
    });
  }

  private settled(row: Row): Settled {
    if (typeof row.response_json !== 'string' || typeof row.receipt_json !== 'string') throw new Error('mcp_operation_receipt_corrupt');
    return { state: 'settled', operation_id: String(row.operation_id), result: JSON.parse(row.response_json),
      execution_receipt: JSON.parse(row.receipt_json) as Settled['execution_receipt'] };
  }

  private operation(identityValue: unknown, operationId: unknown): { run: McpRunIdentity; row: Row } {
    const run = identity(identityValue);
    if (typeof operationId !== 'string' || !/^mcp-op-[0-9a-f-]{36}$/.test(operationId)) throw new Error('mcp_operation_not_found');
    const row = this.db.prepare('SELECT * FROM wb_mcp_operations WHERE operation_id=?').get(operationId) as Row | undefined;
    if (!row) throw new Error('mcp_operation_not_found');
    this.assertIdentity(row, run);
    return { run, row };
  }

  settle(identityValue: unknown, operationId: unknown, resultValue: unknown): Settled {
    const { run, row } = this.operation(identityValue, operationId);
    const serialized = JSON.stringify(resultValue);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) throw new Error('mcp_result_too_large');
    const resultHash = sha256(serialized);
    return withImmediateTransaction(this.db, () => {
      const current = this.db.prepare('SELECT * FROM wb_mcp_operations WHERE operation_id=?').get(String(row.operation_id)) as Row;
      this.assertIdentity(current, run);
      if (current.state === 'settled') {
        if (current.result_hash !== resultHash) throw new Error('mcp_result_conflict');
        return this.settled(current);
      }
      if (!['dispatched', 'unknown'].includes(String(current.state))) throw new Error('mcp_operation_state_conflict');
      const receipt = this.evidence.record(run.run_id, String(current.call_id), String(current.public_name), resultValue);
      const receiptJson = JSON.stringify(receipt), time = now();
      this.db.prepare(`UPDATE wb_mcp_operations SET state='settled',result_hash=?,response_json=?,receipt_json=?,last_error_code=NULL,updated_at=?
        WHERE operation_id=? AND state IN ('dispatched','unknown')`)
        .run(resultHash, serialized, receiptJson, time, String(current.operation_id));
      return { state: 'settled', operation_id: String(current.operation_id), result: resultValue, execution_receipt: receipt };
    });
  }

  markUnknown(identityValue: unknown, operationId: unknown, reason: unknown): Unknown {
    const { run, row } = this.operation(identityValue, operationId), reasonCode = typeof reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : 'mcp_operation_unknown';
    return withImmediateTransaction(this.db, () => {
      const current = this.db.prepare('SELECT * FROM wb_mcp_operations WHERE operation_id=?').get(String(row.operation_id)) as Row;
      this.assertIdentity(current, run);
      if (current.state === 'settled') throw new Error('mcp_operation_state_conflict');
      if (current.state !== 'unknown') this.db.prepare("UPDATE wb_mcp_operations SET state='unknown',last_error_code=?,updated_at=? WHERE operation_id=?")
        .run(reasonCode, now(), String(current.operation_id));
      return unknown({ ...current, state: 'unknown' });
    });
  }

  recover(identityValue: unknown, callIdValue: unknown): Settled | Unknown | null {
    const run = identity(identityValue);
    if (typeof callIdValue !== 'string' || !CALL_ID.test(callIdValue)) throw new Error('invalid_mcp_call');
    return withImmediateTransaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM wb_mcp_operations WHERE run_id=? AND call_id=?').get(run.run_id, callIdValue) as Row | undefined;
      if (!row) return null;
      this.assertIdentity(row, run);
      if (row.state === 'settled') return this.settled(row);
      if (row.state === 'dispatched') {
        this.db.prepare("UPDATE wb_mcp_operations SET state='unknown',last_error_code='mcp_operation_unknown',updated_at=? WHERE operation_id=? AND state='dispatched'")
          .run(now(), String(row.operation_id));
      }
      return unknown(row);
    });
  }
}

/** Read only the small owner-and-agent scoped status projection for unresolved calls. */
export function listUnknownMcpOperations(db: DatabaseSync, ownerId: string, agentId: string): McpUnknownOperationProjection[] {
  const rows = db.prepare(`SELECT operation_id,updated_at FROM wb_mcp_operations
    WHERE owner_id=? AND agent_id=? AND state='unknown'
    ORDER BY updated_at DESC,operation_id DESC LIMIT 50`).all(ownerId, agentId) as Array<{ operation_id: string; updated_at: string }>;
  return rows.map(row => ({ operation_id: row.operation_id, state: 'unknown', updated_at: row.updated_at }));
}
