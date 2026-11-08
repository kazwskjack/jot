import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import type { WorkbenchService } from './service.ts';

type Input = Record<string, unknown>;
type Row = Record<string, string | number | null>;
export type McpTransport = 'stdio' | 'streamable-http';
export type McpConnectionConfig = {
  server_name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env_refs?: Record<string, string>;
  url?: string;
  header_refs?: Record<string, string>;
};
export type DiscoveredMcpTool = { name: string; description?: string; input_schema: Input };
export type McpToolProjection = {
  tool_id: string; public_name: string; raw_name: string; description: string; source: 'mcp_server'; source_untrusted: true;
  input_schema: Input; approved: boolean;
};
type McpRuntimeToolProjection = Omit<McpToolProjection, 'source' | 'source_untrusted'>;
export type McpConnectionProjection = {
  connection_id: string; server_name: string; transport: McpTransport; version: number;
  enabled: boolean; state: string; active_generation: number; pending_generation: number | null;
  credentials_configured: boolean; last_error_code: string | null; tools: McpToolProjection[];
};
export type McpRuntimeConnection = {
  owner_id: string; agent_id: string; connection_id: string; server_name: string;
  transport: McpTransport; version: number; generation: number; config: McpConnectionConfig;
  tools: McpRuntimeToolProjection[];
};
export type McpReloadRequest = {
  owner_id: string; agent_id: string; connection_id: string; version: number; config_version: number; generation: number; config: McpConnectionConfig;
  assertCurrent: () => void; signal: AbortSignal;
  complete: (discovered: unknown) => McpConnectionProjection;
  fail: (reasonCode: unknown) => McpConnectionProjection;
};
export type McpRemovalRequest = {
  owner_id: string; agent_id: string; connection_id: string; finish: () => void;
};

const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SERVER_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const SECRET_REF = /^secret:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,253}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const UNSAFE_VALUE = /(?:bearer\s+\S+|(?:token|secret|password|api[_-]?key)=\S+)/i;
const MAX_TOOLS_PER_CONNECTION = 100;
const MAX_TOOLS_PER_AGENT = 128;
const MAX_TOOL_SCHEMA_BYTES = 16384;
const now = () => new Date().toISOString();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function object(value: unknown, code = 'invalid_mcp_connection'): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Input;
}
function exact(value: Input, keys: string[], code = 'invalid_mcp_connection'): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error(code);
}
function requiredText(value: unknown, code: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(code);
  return value.trim();
}
function expectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error('invalid_expected_version');
  return Number(value);
}
function recordOfStrings(value: unknown, keyPattern: RegExp, owner: string): Record<string, string> {
  if (value === undefined) return {};
  const row = object(value);
  const entries = Object.entries(row);
  if (entries.length > 64) throw new Error('invalid_mcp_connection');
  const result: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!keyPattern.test(key)) throw new Error('invalid_mcp_connection');
    const prefix = 'secret://' + owner + '/';
    if (typeof raw !== 'string' || !SECRET_REF.test(raw) || !raw.startsWith(prefix) || raw.length === prefix.length) {
      throw new Error('invalid_credential_reference');
    }
    result[key] = raw;
  }
  return result;
}
function validateConfig(value: unknown, owner: string): McpConnectionConfig {
  const input = object(value);
  const server_name = requiredText(input.server_name, 'invalid_mcp_connection', 32);
  if (!SERVER_NAME.test(server_name)) throw new Error('invalid_mcp_connection');
  if (input.transport === 'stdio') {
    exact(input, ['server_name', 'transport', 'command', 'args', 'cwd', 'env_refs']);
    const command = requiredText(input.command, 'invalid_mcp_connection', 1024);
    if (UNSAFE_VALUE.test(command)) throw new Error('invalid_mcp_connection');
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || arg.length > 4096 || UNSAFE_VALUE.test(arg))) {
      throw new Error('invalid_mcp_connection');
    }
    const cwd = input.cwd === undefined ? undefined : requiredText(input.cwd, 'invalid_mcp_connection', 2048);
    if (cwd && UNSAFE_VALUE.test(cwd)) throw new Error('invalid_mcp_connection');
    const env_refs = recordOfStrings(input.env_refs, ENV_NAME, owner);
    return { server_name, transport: 'stdio', command, args: [...args] as string[], ...(cwd ? { cwd } : {}), env_refs };
  }
  if (input.transport === 'streamable-http') {
    exact(input, ['server_name', 'transport', 'url', 'header_refs']);
    const url = requiredText(input.url, 'invalid_mcp_connection', 2048);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('invalid_mcp_connection'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.protocol === 'http:' && !loopback
      || parsed.username || parsed.password || parsed.hash
      || [...parsed.searchParams.keys()].some(key => /token|secret|password|api[_-]?key/i.test(key))) throw new Error('invalid_mcp_connection');
    const header_refs = recordOfStrings(input.header_refs, HEADER_NAME, owner);
    return { server_name, transport: 'streamable-http', url: parsed.toString(), header_refs };
  }
  throw new Error('invalid_mcp_connection');
}
function credentialCount(config: McpConnectionConfig): number {
  return Object.keys(config.transport === 'stdio' ? config.env_refs ?? {} : config.header_refs ?? {}).length;
}
function cleanErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) return 'mcp_reload_failed';
  return value;
}
function publicToolName(serverName: string, rawName: string, connectionId: string): string {
  const segment = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 12) || 'tool';
  return `jot_mcp_${segment(serverName)}_${segment(rawName)}_${digest(`${connectionId}\0${rawName}`).slice(0, 10)}`;
}
function toolId(connectionId: string, rawName: string): string {
  return `mcp_${digest(`${connectionId}\0${rawName}`).slice(0, 32)}`;
}
function validateSchema(value: unknown): Input {
  const schema = object(value, 'invalid_mcp_tool_catalog');
  if (schema.type !== 'object') throw new Error('invalid_mcp_tool_catalog');
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  if (bytes > MAX_TOOL_SCHEMA_BYTES || JSON.stringify(schema).includes('"$ref"')) throw new Error('invalid_mcp_tool_catalog');
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) throw new Error('invalid_mcp_tool_catalog');
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(x => typeof x !== 'string' || x.length > 128))) throw new Error('invalid_mcp_tool_catalog');
  return structuredClone(schema);
}
function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

/** Owner-scoped MCP configuration and trusted runtime discovery projection. */
export class McpRegistryService {
  private readonly db: DatabaseSync;
  private readonly workbench: WorkbenchService;
  private readonly onCapabilityChange: ((owner: string, agentId: string) => void) | undefined;
  private readonly onReloadRequested: ((request: McpReloadRequest) => unknown) | undefined;
  private readonly onRemovalRequested: ((request: McpRemovalRequest) => unknown) | undefined;
  private readonly reloadControllers = new Map<string, { owner: string; agentId: string; connectionId: string; generation: number; controller: AbortController }>();

  constructor(db: DatabaseSync, workbench: WorkbenchService,
    options: {
      onCapabilityChange?: (owner: string, agentId: string) => void;
      onReloadRequested?: (request: McpReloadRequest) => unknown;
      onRemovalRequested?: (request: McpRemovalRequest) => unknown;
    } = {}) {
    this.db = db; this.workbench = workbench;
    this.onCapabilityChange = options.onCapabilityChange ?? ((owner, agentId) => {
      this.db.prepare('UPDATE wb_agents SET capability_epoch=capability_epoch+1,updated_at=? WHERE owner_id=? AND agent_id=?')
        .run(now(), owner, agentId);
    });
    this.onReloadRequested = options.onReloadRequested; this.onRemovalRequested = options.onRemovalRequested;
    db.exec(`
      CREATE TABLE IF NOT EXISTS wb_mcp_connections (
        owner_id TEXT NOT NULL,agent_id TEXT NOT NULL,connection_id TEXT NOT NULL,server_name TEXT NOT NULL,
        transport TEXT NOT NULL,version INTEGER NOT NULL,enabled INTEGER NOT NULL,config_json TEXT NOT NULL,
        pending_config_json TEXT,pending_version INTEGER,pending_generation INTEGER,active_generation INTEGER NOT NULL,
        approved_tool_ids_json TEXT NOT NULL,runtime_state TEXT NOT NULL,last_error_code TEXT,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,agent_id,connection_id));
      CREATE UNIQUE INDEX IF NOT EXISTS wb_mcp_server_name_active
        ON wb_mcp_connections(owner_id,agent_id,server_name) WHERE runtime_state!='removed';
      CREATE INDEX IF NOT EXISTS wb_mcp_connection_owner
        ON wb_mcp_connections(owner_id,agent_id,runtime_state);
      CREATE TABLE IF NOT EXISTS wb_mcp_tool_snapshots (
        owner_id TEXT NOT NULL,agent_id TEXT NOT NULL,connection_id TEXT NOT NULL,generation INTEGER NOT NULL,
        tool_id TEXT NOT NULL,raw_name TEXT NOT NULL,public_name TEXT NOT NULL,description TEXT NOT NULL,
        input_schema_json TEXT NOT NULL,captured_at TEXT NOT NULL,
        PRIMARY KEY(owner_id,agent_id,connection_id,generation,tool_id),
        UNIQUE(owner_id,agent_id,connection_id,generation,raw_name));
      CREATE TRIGGER IF NOT EXISTS wb_mcp_tool_snapshot_no_update BEFORE UPDATE ON wb_mcp_tool_snapshots
        BEGIN SELECT RAISE(ABORT,'mcp_tool_snapshot_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_mcp_tool_snapshot_no_delete BEFORE DELETE ON wb_mcp_tool_snapshots
        WHEN EXISTS(SELECT 1 FROM wb_mcp_connections c WHERE c.owner_id=OLD.owner_id AND c.agent_id=OLD.agent_id
          AND c.connection_id=OLD.connection_id AND c.active_generation=OLD.generation)
        BEGIN SELECT RAISE(ABORT,'mcp_tool_snapshot_immutable'); END;
    `);
    const recovered = withImmediateTransaction(db, () => {
      const stale = db.prepare(`SELECT DISTINCT owner_id,agent_id FROM wb_mcp_connections
        WHERE runtime_state IN ('ready','connecting','reloading')`).all() as Array<{ owner_id: string; agent_id: string }>;
      db.prepare(`UPDATE wb_mcp_connections SET runtime_state='disconnected',pending_config_json=NULL,pending_version=NULL,
        pending_generation=NULL,last_error_code=CASE
          WHEN pending_config_json IS NOT NULL OR pending_generation IS NOT NULL THEN 'mcp_reload_interrupted'
          WHEN runtime_state='ready' THEN 'mcp_runtime_restarted' ELSE last_error_code END,updated_at=?
        WHERE runtime_state IN ('ready','connecting','reloading')`).run(now());
      return stale;
    });
    for (const row of recovered) {
      try { this.onCapabilityChange?.(row.owner_id, row.agent_id); } catch { /* Orphaned/inactive Agents stay fenced. */ }
    }
  }

  private agent(owner: string, agentId: string): void {
    if (!OWNER_ID.test(owner) || !IDENTIFIER.test(agentId)) throw new Error('agent_not_found');
    this.workbench.getAgent(owner, agentId);
  }
  private row(owner: string, agentId: string, connectionId: string): Row {
    const row = this.db.prepare('SELECT * FROM wb_mcp_connections WHERE owner_id=? AND agent_id=? AND connection_id=?')
      .get(owner, agentId, connectionId) as Row | undefined;
    if (!row || row.runtime_state === 'removed') throw new Error('mcp_connection_not_found');
    return row;
  }
  private reloadKey(owner: string, agentId: string, connectionId: string, generation: number): string {
    return JSON.stringify([owner, agentId, connectionId, generation]);
  }
  private retireReload(owner: string, agentId: string, connectionId: string, generation: number, abort: boolean): void {
    const key = this.reloadKey(owner, agentId, connectionId, generation), entry = this.reloadControllers.get(key);
    if (!entry) return;
    this.reloadControllers.delete(key);
    if (abort && !entry.controller.signal.aborted) entry.controller.abort(new Error('mcp_reload_stale'));
  }
  private abortConnectionReloads(owner: string, agentId: string, connectionId: string, exceptGeneration?: number): void {
    for (const entry of this.reloadControllers.values()) {
      if (entry.owner !== owner || entry.agentId !== agentId || entry.connectionId !== connectionId
        || entry.generation === exceptGeneration) continue;
      this.retireReload(owner, agentId, connectionId, entry.generation, true);
    }
  }
  private project(row: Row): McpConnectionProjection {
    const config = JSON.parse(String(row.config_json)) as McpConnectionConfig;
    const generation = Number(row.active_generation);
    const rows = generation === 0 ? [] : this.db.prepare(`SELECT tool_id,raw_name,public_name,description,input_schema_json
      FROM wb_mcp_tool_snapshots WHERE owner_id=? AND agent_id=? AND connection_id=? AND generation=? ORDER BY raw_name`)
      .all(String(row.owner_id), String(row.agent_id), String(row.connection_id), generation) as Row[];
    const approved = new Set(JSON.parse(String(row.approved_tool_ids_json)) as string[]);
    return {
      connection_id: String(row.connection_id), server_name: String(row.server_name), transport: row.transport as McpTransport,
      version: Number(row.version), enabled: Number(row.enabled) === 1, state: String(row.runtime_state), active_generation: generation,
      pending_generation: row.pending_generation === null ? null : Number(row.pending_generation),
      credentials_configured: credentialCount(config) > 0,
      last_error_code: row.last_error_code === null ? null : String(row.last_error_code),
      tools: rows.map(tool => ({ tool_id: String(tool.tool_id), public_name: String(tool.public_name), raw_name: String(tool.raw_name),
        description: String(tool.description), source: 'mcp_server', source_untrusted: true,
        input_schema: JSON.parse(String(tool.input_schema_json)), approved: approved.has(String(tool.tool_id)) })),
    };
  }
  private find(owner: string, agentId: string, connectionId: string): McpConnectionProjection {
    return this.project(this.row(owner, agentId, connectionId));
  }

  list(owner: string, agentId: string): { items: McpConnectionProjection[] } {
    this.agent(owner, agentId);
    const rows = this.db.prepare("SELECT * FROM wb_mcp_connections WHERE owner_id=? AND agent_id=? AND runtime_state!='removed' ORDER BY created_at,connection_id")
      .all(owner, agentId) as Row[];
    return { items: rows.map(row => this.project(row)) };
  }

  /** Authenticated Adapter control-plane view; never includes config or secrets. */
  controlState(value: unknown): { state: 'pending' | 'active' | 'suspended' | 'stale'; owner_id: string; agent_id: string; capability_epoch: number; identity: Record<string, string | number> } {
    const input = object(value, 'mcp_control_invalid_request');
    exact(input, ['owner_id', 'agent_id', 'connection_id', 'version', 'config_version', 'generation', 'config'], 'mcp_control_invalid_request');
    const owner = requiredText(input.owner_id, 'mcp_control_invalid_request', 128);
    const agentId = requiredText(input.agent_id, 'mcp_control_invalid_request', 192);
    const connectionId = requiredText(input.connection_id, 'mcp_control_invalid_request', 192);
    const numbers = ['version', 'config_version', 'generation'] as const;
    if (![owner, agentId, connectionId].every(value => IDENTIFIER.test(value))
      || numbers.some(key => !Number.isSafeInteger(input[key]) || Number(input[key]) < 1)) throw new Error('mcp_control_invalid_request');
    const version = Number(input.version), configVersion = Number(input.config_version), generation = Number(input.generation);
    const config = validateConfig(input.config, owner);
    const identity = { owner_id: owner, agent_id: agentId, connection_id: connectionId,
      version, config_version: configVersion, generation };
    const agent = this.workbench.getAgent(owner, agentId);
    const row = this.db.prepare('SELECT * FROM wb_mcp_connections WHERE owner_id=? AND agent_id=? AND connection_id=?')
      .get(owner, agentId, connectionId) as Row | undefined;
    let state: 'pending' | 'active' | 'suspended' | 'stale' = 'stale';
    if (row && Number(row.enabled) === 1 && row.runtime_state !== 'removed' && agent.status === 'active') {
      const activeConfig = row.config_json ? JSON.parse(String(row.config_json)) : null;
      const pendingConfig = row.pending_config_json ? JSON.parse(String(row.pending_config_json)) : activeConfig;
      const same = (left: unknown) => JSON.stringify(left) === JSON.stringify(config);
      if (['connecting', 'reloading'].includes(String(row.runtime_state))
        && Number(row.version) === version && Number(row.pending_version ?? row.version) === configVersion
        && Number(row.pending_generation) === generation && same(pendingConfig)) state = 'pending';
      else if (row.runtime_state === 'ready' && Number(row.active_generation) === generation
        && Number(row.version) >= configVersion && same(activeConfig)) state = 'active';
      else if (['connecting', 'reloading'].includes(String(row.runtime_state))
        && Number(row.active_generation) === generation && Number(row.pending_generation) > generation
        && Number(row.version) > version && Number(row.version) >= configVersion && same(activeConfig)) state = 'suspended';
    }
    return { state, owner_id: owner, agent_id: agentId, capability_epoch: agent.capability_epoch, identity };
  }

  create(owner: string, agentId: string, value: unknown): McpConnectionProjection {
    this.agent(owner, agentId);
    const config = validateConfig(value, owner), connectionId = `mcp-${randomUUID()}`, time = now();
    try {
      return withImmediateTransaction(this.db, () => {
        const count = this.db.prepare("SELECT count(*) AS count FROM wb_mcp_connections WHERE owner_id=? AND agent_id=? AND runtime_state!='removed'")
          .get(owner, agentId) as { count: number };
        if (Number(count.count) >= 64) throw new Error('mcp_connections_limit');
        this.db.prepare(`INSERT INTO wb_mcp_connections
          (owner_id,agent_id,connection_id,server_name,transport,version,enabled,config_json,pending_config_json,pending_version,
           pending_generation,active_generation,approved_tool_ids_json,runtime_state,last_error_code,created_at,updated_at)
          VALUES(?,?,?,?,?,1,0,?,NULL,NULL,NULL,0,'[]','configured',NULL,?,?)`)
          .run(owner, agentId, connectionId, config.server_name, config.transport, JSON.stringify(config), time, time);
        return this.find(owner, agentId, connectionId);
      });
    } catch (error) {
      if (String(error).includes('UNIQUE')) throw new Error('mcp_server_name_conflict');
      throw error;
    }
  }

  setEnabled(owner: string, agentId: string, connectionId: string, input: unknown): McpConnectionProjection {
    this.agent(owner, agentId); const value = object(input); exact(value, ['expected_version', 'enabled']);
    const expected = expectedVersion(value.expected_version);
    if (typeof value.enabled !== 'boolean') throw new Error('invalid_mcp_connection');
    const result = withImmediateTransaction(this.db, () => {
      const old = this.row(owner, agentId, connectionId);
      if (Number(old.version) !== expected) throw new Error('version_conflict');
      if (old.runtime_state === 'removing') throw new Error('mcp_connection_state_conflict');
      if ((Number(old.enabled) === 1) === value.enabled) return this.project(old);
      if (value.enabled && old.pending_generation !== null) throw new Error('mcp_reload_in_progress');
      const nextState = value.enabled ? (Number(old.active_generation) ? 'disconnected' : 'configured') : 'disconnected';
      this.db.prepare(`UPDATE wb_mcp_connections SET enabled=?,version=version+1,runtime_state=?,
        pending_config_json=CASE WHEN ?=0 THEN NULL ELSE pending_config_json END,
        pending_version=CASE WHEN ?=0 THEN NULL ELSE pending_version END,
        pending_generation=CASE WHEN ?=0 THEN NULL ELSE pending_generation END,
        last_error_code=NULL,updated_at=? WHERE owner_id=? AND agent_id=? AND connection_id=? AND version=?`)
        .run(value.enabled ? 1 : 0, nextState, value.enabled ? 1 : 0, value.enabled ? 1 : 0, value.enabled ? 1 : 0,
          now(), owner, agentId, connectionId, expected);
      this.onCapabilityChange?.(owner, agentId);
      return this.find(owner, agentId, connectionId);
    });
    if (!value.enabled) this.abortConnectionReloads(owner, agentId, connectionId);
    return result;
  }

  stageConfig(owner: string, agentId: string, connectionId: string, input: unknown): McpConnectionProjection {
    this.agent(owner, agentId); const value = object(input); exact(value, ['expected_version', 'config']);
    const expected = expectedVersion(value.expected_version), config = validateConfig(value.config, owner);
    const result = withImmediateTransaction(this.db, () => {
      const old = this.row(owner, agentId, connectionId);
      if (Number(old.version) !== expected) throw new Error('version_conflict');
      if (old.runtime_state === 'removing') throw new Error('mcp_connection_state_conflict');
      if (old.pending_generation !== null) throw new Error('mcp_reload_in_progress');
      if (old.pending_config_json !== null) throw new Error('mcp_reload_in_progress');
      if (config.server_name !== old.server_name) {
        const exists = this.db.prepare("SELECT 1 FROM wb_mcp_connections WHERE owner_id=? AND agent_id=? AND server_name=? AND connection_id<>? AND runtime_state!='removed'")
          .get(owner, agentId, config.server_name, connectionId);
        if (exists) throw new Error('mcp_server_name_conflict');
      }
      this.db.prepare(`UPDATE wb_mcp_connections SET pending_config_json=?,pending_version=?,pending_generation=NULL,
        runtime_state='reloading',last_error_code=NULL,updated_at=? WHERE owner_id=? AND agent_id=? AND connection_id=? AND version=?`)
        .run(JSON.stringify(config), expected + 1, now(), owner, agentId, connectionId, expected);
      this.onCapabilityChange?.(owner, agentId);
      return this.find(owner, agentId, connectionId);
    });
    this.abortConnectionReloads(owner, agentId, connectionId);
    return result;
  }

  prepareReload(owner: string, agentId: string, connectionId: string, expected: unknown): {
    connection_id: string; version: number; config_version: number; generation: number; config: McpConnectionConfig;
  } {
    this.agent(owner, agentId); const version = expectedVersion(expected);
    return withImmediateTransaction(this.db, () => {
      const old = this.row(owner, agentId, connectionId);
      if (Number(old.version) !== version) throw new Error('version_conflict');
      if (Number(old.enabled) !== 1) throw new Error('mcp_connection_disabled');
      if (old.runtime_state === 'removing') throw new Error('mcp_connection_state_conflict');
      if (old.pending_generation !== null) throw new Error('mcp_reload_in_progress');
      const generation = Number(old.active_generation) + 1;
      const config = JSON.parse(String(old.pending_config_json ?? old.config_json)) as McpConnectionConfig;
      this.db.prepare("UPDATE wb_mcp_connections SET pending_generation=?,runtime_state='connecting',last_error_code=NULL,updated_at=? WHERE owner_id=? AND agent_id=? AND connection_id=?")
        .run(generation, now(), owner, agentId, connectionId);
      this.onCapabilityChange?.(owner, agentId);
      return { connection_id: connectionId, version, config_version: Number(old.pending_version ?? old.version), generation, config };
    });
  }

  requestReload(owner: string, agentId: string, connectionId: string, expected: unknown): McpConnectionProjection {
    const prepared = this.prepareReload(owner, agentId, connectionId, expected);
    if (!this.onReloadRequested) {
      this.failReload(owner, agentId, connectionId, prepared.generation, 'mcp_reload_queue_unavailable');
      throw new Error('mcp_reload_unavailable');
    }
    let completed = false;
    const controller = new AbortController();
    const config = deepFreeze(structuredClone(prepared.config));
    const key = this.reloadKey(owner, agentId, connectionId, prepared.generation);
    const entry = { owner, agentId, connectionId, generation: prepared.generation, controller };
    this.reloadControllers.set(key, entry);
    const retire = (abort: boolean) => this.retireReload(owner, agentId, connectionId, prepared.generation, abort);
    const assertCurrent = (): void => {
      if (controller.signal.aborted || this.reloadControllers.get(key) !== entry) throw new Error('mcp_reload_stale');
      const row = this.db.prepare(`SELECT version,enabled,pending_config_json,pending_version,pending_generation,runtime_state,config_json
        FROM wb_mcp_connections WHERE owner_id=? AND agent_id=? AND connection_id=?`)
        .get(owner, agentId, connectionId) as Row | undefined;
      if (!row || Number(row.version) !== prepared.version || Number(row.enabled) !== 1
        || Number(row.pending_generation) !== prepared.generation
        || Number(row.pending_version ?? row.version) !== prepared.config_version
        || !['connecting', 'reloading'].includes(String(row.runtime_state))
        || String(row.pending_config_json ?? row.config_json) !== JSON.stringify(config)) {
        throw new Error('mcp_reload_stale');
      }
    };
    const request: McpReloadRequest = { owner_id: owner, agent_id: agentId, connection_id: connectionId,
      version: prepared.version, config_version: prepared.config_version, generation: prepared.generation, config,
      assertCurrent,
      signal: controller.signal,
      complete: discovered => {
        if (completed) throw new Error('mcp_reload_stale');
        try { assertCurrent(); }
        catch { completed = true; retire(true); throw new Error('mcp_reload_stale'); }
        try {
          const result = this.activateReload(owner, agentId, connectionId, prepared.generation, discovered);
          completed = true;
          // The request's signal now owns the active Host connection. Retain it so
          // disable, removal, or a later published generation can close that connection.
          this.abortConnectionReloads(owner, agentId, connectionId, prepared.generation);
          return result;
        } catch {
          completed = true;
          try {
            const result = this.failReload(owner, agentId, connectionId, prepared.generation, 'mcp_reload_invalid_result');
            retire(true);
            return result;
          } catch { retire(true); throw new Error('mcp_reload_stale'); }
        }
      },
      fail: reasonCode => {
        if (completed) throw new Error('mcp_reload_stale');
        completed = true;
        try { assertCurrent(); return this.failReload(owner, agentId, connectionId, prepared.generation, reasonCode); }
        finally { retire(true); }
      } };
    try {
      const dispatched = this.onReloadRequested(request);
      if (dispatched && typeof (dispatched as { then?: unknown }).then === 'function') {
        void Promise.resolve(dispatched).then(value => {
          if (completed || value === undefined) return;
          if (Array.isArray(value)) request.complete(value);
          else request.fail('mcp_reload_invalid_result');
        }).catch(() => { if (!completed) { try { request.fail('mcp_reload_unavailable'); } catch {} } });
      } else if (!completed && Array.isArray(dispatched)) request.complete(dispatched);
      else if (!completed && dispatched !== undefined) request.fail('mcp_reload_invalid_result');
    } catch {
      if (!completed) request.fail('mcp_reload_queue_unavailable');
      throw new Error('mcp_reload_unavailable');
    }
    return this.find(owner, agentId, connectionId);
  }

  activateReload(owner: string, agentId: string, connectionId: string, generation: number, discovered: unknown): McpConnectionProjection {
    this.agent(owner, agentId);
    if (!Number.isSafeInteger(generation) || generation < 1 || !Array.isArray(discovered) || discovered.length > MAX_TOOLS_PER_CONNECTION) throw new Error('invalid_mcp_tool_catalog');
    const tools = discovered.map(value => {
      const row = object(value, 'invalid_mcp_tool_catalog'); exact(row, ['name', 'description', 'input_schema'], 'invalid_mcp_tool_catalog');
      const name = requiredText(row.name, 'invalid_mcp_tool_catalog', 128);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name)) throw new Error('invalid_mcp_tool_catalog');
      const description = row.description === undefined ? '' : row.description;
      if (typeof description !== 'string' || description.length > 2048) throw new Error('invalid_mcp_tool_catalog');
      const schema = validateSchema(row.input_schema);
      return { name, description, schema, tool_id: toolId(connectionId, name) };
    });
    if (new Set(tools.map(tool => tool.name)).size !== tools.length || new Set(tools.map(tool => tool.tool_id)).size !== tools.length) {
      throw new Error('invalid_mcp_tool_catalog');
    }
    return withImmediateTransaction(this.db, () => {
      const old = this.row(owner, agentId, connectionId);
      if (Number(old.enabled) !== 1 || Number(old.pending_generation) !== generation || !['connecting', 'reloading'].includes(String(old.runtime_state))) {
        throw new Error('mcp_reload_stale');
      }
      const otherToolCount = this.db.prepare(`SELECT count(*) AS count FROM wb_mcp_connections c
        JOIN wb_mcp_tool_snapshots s ON s.owner_id=c.owner_id AND s.agent_id=c.agent_id AND s.connection_id=c.connection_id
          AND s.generation=c.active_generation
        WHERE c.owner_id=? AND c.agent_id=? AND c.connection_id<>? AND c.active_generation>0`)
        .get(owner, agentId, connectionId) as { count: number };
      if (Number(otherToolCount.count) + tools.length > MAX_TOOLS_PER_AGENT) throw new Error('mcp_tool_catalog_limit');
      const config = JSON.parse(String(old.pending_config_json ?? old.config_json)) as McpConnectionConfig;
      const time = now();
      for (const tool of tools) {
        this.db.prepare('INSERT INTO wb_mcp_tool_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(owner, agentId, connectionId, generation, tool.tool_id, tool.name,
            publicToolName(config.server_name, tool.name, connectionId), tool.description, JSON.stringify(tool.schema), time);
      }
      const pendingVersion = old.pending_version === null ? Number(old.version) : Number(old.pending_version);
      this.db.prepare(`UPDATE wb_mcp_connections SET server_name=?,transport=?,version=?,config_json=?,pending_config_json=NULL,
        pending_version=NULL,pending_generation=NULL,active_generation=?,approved_tool_ids_json='[]',runtime_state='ready',
        last_error_code=NULL,updated_at=? WHERE owner_id=? AND agent_id=? AND connection_id=?`)
        .run(config.server_name, config.transport, pendingVersion, JSON.stringify(config), generation, time, owner, agentId, connectionId);
      this.onCapabilityChange?.(owner, agentId);
      return this.find(owner, agentId, connectionId);
    });
  }

  failReload(owner: string, agentId: string, connectionId: string, generation: number, reasonCode: unknown): McpConnectionProjection {
    this.agent(owner, agentId); const errorCode = cleanErrorCode(reasonCode);
    return withImmediateTransaction(this.db, () => {
      const old = this.row(owner, agentId, connectionId);
      if (Number(old.pending_generation) !== generation) throw new Error('mcp_reload_stale');
      const state = Number(old.active_generation) > 0 && errorCode === 'mcp_reload_failed_prior_retained' ? 'ready' : 'error';
      this.db.prepare(`UPDATE wb_mcp_connections SET pending_config_json=NULL,pending_version=NULL,pending_generation=NULL,
        runtime_state=?,last_error_code=?,updated_at=? WHERE owner_id=? AND agent_id=? AND connection_id=?`)
        .run(state, errorCode, now(), owner, agentId, connectionId);
      this.onCapabilityChange?.(owner, agentId);
      return this.find(owner, agentId, connectionId);
    });
  }

  setAllowedTools(owner: string, agentId: string, connectionId: string, input: unknown): McpConnectionProjection {
    this.agent(owner, agentId); const value = object(input); exact(value, ['expected_version', 'tool_ids']);
    const expected = expectedVersion(value.expected_version), ids = value.tool_ids;
    if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^mcp_[a-f0-9]{32}$/.test(id)) || new Set(ids).size !== ids.length) {
      throw new Error('invalid_mcp_tool_grant');
    }
    const updated = withImmediateTransaction(this.db, () => {
      const old = this.row(owner, agentId, connectionId);
      if (Number(old.version) !== expected) throw new Error('version_conflict');
      if (String(old.runtime_state) !== 'ready' || Number(old.enabled) !== 1) throw new Error('mcp_connection_unavailable');
      const known = new Set((this.project(old).tools).map(tool => tool.tool_id));
      if ((ids as string[]).some(id => !known.has(id))) throw new Error('mcp_tool_not_found');
      const prior = new Set(JSON.parse(String(old.approved_tool_ids_json)) as string[]);
      const next = new Set(ids as string[]);
      if ([...prior].every(id => next.has(id)) && [...next].every(id => prior.has(id))) {
        return { projection: this.project(old), changed: false };
      }
      this.db.prepare('UPDATE wb_mcp_connections SET approved_tool_ids_json=?,version=version+1,updated_at=? WHERE owner_id=? AND agent_id=? AND connection_id=? AND version=?')
        .run(JSON.stringify([...next].sort()), now(), owner, agentId, connectionId, expected);
      this.onCapabilityChange?.(owner, agentId);
      return { projection: this.find(owner, agentId, connectionId), changed: true };
    });
    if (updated.changed) this.abortConnectionReloads(owner, agentId, connectionId);
    return updated.projection;
  }

  authorizeTool(owner: string, agentId: string, connectionId: string, generation: number, id: string): McpToolProjection {
    try { this.agent(owner, agentId); } catch { throw new Error('mcp_tool_forbidden'); }
    const row = this.row(owner, agentId, connectionId);
    if (Number(row.enabled) !== 1 || String(row.runtime_state) !== 'ready' || Number(row.active_generation) !== generation) {
      throw new Error('mcp_tool_forbidden');
    }
    const approved = new Set(JSON.parse(String(row.approved_tool_ids_json)) as string[]);
    if (!approved.has(id)) throw new Error('mcp_tool_forbidden');
    const tool = this.project(row).tools.find(value => value.tool_id === id);
    if (!tool) throw new Error('mcp_tool_unavailable');
    return tool;
  }

  remove(owner: string, agentId: string, connectionId: string, expected: unknown): McpConnectionProjection {
    this.agent(owner, agentId); const version = expectedVersion(expected);
    const projection = withImmediateTransaction(this.db, () => {
      const old = this.row(owner, agentId, connectionId);
      if (Number(old.version) !== version) throw new Error('version_conflict');
      this.db.prepare(`UPDATE wb_mcp_connections SET enabled=0,version=version+1,pending_config_json=NULL,pending_version=NULL,
        pending_generation=NULL,approved_tool_ids_json='[]',runtime_state='removing',last_error_code=NULL,updated_at=?
        WHERE owner_id=? AND agent_id=? AND connection_id=? AND version=?`)
        .run(now(), owner, agentId, connectionId, version);
      this.onCapabilityChange?.(owner, agentId);
      return this.project(this.row(owner, agentId, connectionId));
    });
    this.abortConnectionReloads(owner, agentId, connectionId);
    let finished = false;
    const finish = () => { if (finished) return; this.finishRemoval(owner, agentId, connectionId); finished = true; };
    if (!this.onRemovalRequested) {
      finish();
      return { ...projection, state: 'removed', enabled: false, active_generation: 0, pending_generation: null,
        credentials_configured: false, last_error_code: null, tools: [] };
    }
    try {
      const result = this.onRemovalRequested({ owner_id: owner, agent_id: agentId, connection_id: connectionId, finish });
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        void Promise.resolve(result).then(() => { if (!finished) finish(); }).catch(() => {});
      }
    } catch { /* The revoked connection stays in removing state until host cleanup is confirmed. */ }
    return projection;
  }

  finishRemoval(owner: string, agentId: string, connectionId: string): void {
    this.agent(owner, agentId);
    withImmediateTransaction(this.db, () => {
      const old = this.row(owner, agentId, connectionId);
      if (old.runtime_state !== 'removing') throw new Error('mcp_connection_state_conflict');
      this.db.prepare(`UPDATE wb_mcp_connections SET config_json='{}',pending_config_json=NULL,pending_version=NULL,
        pending_generation=NULL,approved_tool_ids_json='[]',active_generation=0,runtime_state='removed',last_error_code=NULL,updated_at=?
        WHERE owner_id=? AND agent_id=? AND connection_id=?`)
        .run(now(), owner, agentId, connectionId);
      this.db.prepare(`DELETE FROM wb_mcp_tool_snapshots WHERE owner_id=? AND agent_id=? AND connection_id=?`)
        .run(owner, agentId, connectionId);
    });
  }

  /** Internal DSH bridge input; public route projections never include configs or references. */
  runtimeConnections(owner: string, agentId: string): McpRuntimeConnection[] {
    this.agent(owner, agentId);
    const rows = this.db.prepare(`SELECT * FROM wb_mcp_connections WHERE owner_id=? AND agent_id=?
      AND enabled=1 AND runtime_state='ready' AND active_generation>0 ORDER BY created_at,connection_id`).all(owner, agentId) as Row[];
    return rows.map(row => {
      const projection = this.project(row), approved = projection.tools.filter(tool => tool.approved);
      const tools = approved.map(({ source: _source, source_untrusted: _sourceUntrusted, ...tool }) => tool);
      return tools.length ? { owner_id: owner, agent_id: agentId, connection_id: projection.connection_id, server_name: projection.server_name,
        transport: projection.transport, version: projection.version, generation: projection.active_generation,
        config: JSON.parse(String(row.config_json)) as McpConnectionConfig, tools } : null;
    }).filter((value): value is McpRuntimeConnection & { owner_id: string; agent_id: string } => value !== null);
  }
}
