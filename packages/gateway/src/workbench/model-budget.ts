import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import {HostResourceObservations} from './host-resource-observations.ts';

export interface ModelBudgetRoute {
  provider: string; model: string; revision: string; context_window: number; max_output_tokens: number;
  /** Integer nano-USD per token. These are server configuration, not provider invoice evidence. */
  rates: { input: number; output: number; cache_read: number; cache_write: number };
  /** Host charge/quota per dispatch, not an invoice or token measurement. */
  billing?: {unit:'dispatched_call';nano_usd:number};
}
export interface ModelBudgetLimits { tokens: number; nano_usd: number | null; model_calls: number }
export interface ModelBudgetRequest { attempt_id: string; provider: string; model: string; max_tokens?: number; purpose?: 'compaction' | 'session-title' | 'emotion' | 'web-decision' | 'reply-verification' }
type ObjectValue = Record<string, unknown>;
type Row = Record<string, string>;
type Amounts = { tokens: bigint; nano_usd: bigint; model_calls: bigint };
const zero = (): Amounts => ({ tokens: 0n, nano_usd: 0n, model_calls: 0n });
const routeHold=(route:ModelBudgetRoute):Amounts=>route.billing
  ?{tokens:0n,nano_usd:BigInt(route.billing.nano_usd),model_calls:1n}
  :{tokens:BigInt(route.context_window),nano_usd:BigInt(route.context_window)*BigInt(Math.max(...Object.values(route.rates))),model_calls:1n};
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const routeName = (value: unknown): value is string => typeof value === 'string' && /^[^\s\p{Cc}]{1,256}$/u.test(value);
function count(value: unknown, code: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(code);
  return Number(value);
}
function moneyLimit(value: unknown,code: string): number | null { return value === null ? null : count(value,code); }
function lesserMoney(a:number|null,b:number|null):number|null { return a===null?b:b===null?a:Math.min(a,b); }
function record(value: unknown, keys: string[], code: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(code);
  return value as ObjectValue;
}
function amounts(value: Amounts) { return { tokens: String(value.tokens), nano_usd: String(value.nano_usd), model_calls: String(value.model_calls) }; }
function routeKey(provider: string, model: string) { return JSON.stringify([provider, model]); }
export function normalizeModelBudgetRoutes(input: unknown): ModelBudgetRoute[] {
  if (!Array.isArray(input)) throw new Error('budget_route_invalid');
  const routes = new Map<string,ModelBudgetRoute>();
  for (const value of input) {
    const route = record(value,['provider','model','revision','context_window','max_output_tokens','rates','billing'],'budget_route_invalid');
    if (!routeName(route.provider) || !routeName(route.model) || !identifier(route.revision)) throw new Error('budget_route_invalid');
    const window=count(route.context_window,'budget_route_invalid',1),output=count(route.max_output_tokens,'budget_route_invalid',1);
    if (output>window) throw new Error('budget_route_invalid');
    const rates=record(route.rates,['input','output','cache_read','cache_write'],'budget_route_invalid');
    for(const key of ['input','output','cache_read','cache_write'])count(rates[key],'budget_route_invalid');
    if(route.billing!==undefined){
      const billing=record(route.billing,['unit','nano_usd'],'budget_route_invalid');
      if(billing.unit!=='dispatched_call'||Object.values(rates).some(rate=>rate!==0))throw new Error('budget_route_invalid');
      count(billing.nano_usd,'budget_route_invalid');
    }
    const key=routeKey(String(route.provider),String(route.model));if(routes.has(key))throw new Error('budget_route_invalid');
    routes.set(key,structuredClone(value as ModelBudgetRoute));
  }
  return [...routes.values()];
}

/** Transactional allocation across intersecting scopes; it does not introduce another task scheduler. */
export class ModelBudgetLedger {
  private readonly db: DatabaseSync;
  private readonly routes: Map<string, ModelBudgetRoute>;
  private readonly now: () => Date;
  private readonly admissionGuard: () => void;
  private readonly scopeCeiling: (key:string,base:ModelBudgetLimits)=>ModelBudgetLimits;
  private readonly hasConfiguredCeiling: boolean;
  private readonly hostResources:HostResourceObservations;
  constructor(db: DatabaseSync, options: { routes: ModelBudgetRoute[]; now?: () => Date; admissionGuard?: () => void;scopeCeiling?:(key:string,base:ModelBudgetLimits)=>ModelBudgetLimits }) {
    this.db = db; this.now = options.now ?? (() => new Date()); this.routes = new Map();
    this.admissionGuard=options.admissionGuard??(()=>{});
    this.scopeCeiling=options.scopeCeiling??((_key,base)=>base);
    this.hasConfiguredCeiling=options.scopeCeiling!==undefined;
    for(const route of normalizeModelBudgetRoutes(options.routes))this.routes.set(routeKey(route.provider,route.model),route);
    // Decimal text preserves exact integer arithmetic even after an unexpected
    // provider overrun. Floating point dollars are never used for admission.
    db.exec(`CREATE TABLE IF NOT EXISTS wb_model_budget_scopes (
      scope_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,scope_key TEXT NOT NULL,limits_json TEXT NOT NULL,
      starts_at TEXT,ends_at TEXT,held_tokens TEXT NOT NULL DEFAULT '0',held_nano_usd TEXT NOT NULL DEFAULT '0',
      held_model_calls TEXT NOT NULL DEFAULT '0',used_tokens TEXT NOT NULL DEFAULT '0',used_nano_usd TEXT NOT NULL DEFAULT '0',
      used_model_calls TEXT NOT NULL DEFAULT '0',created_at TEXT NOT NULL,UNIQUE(owner_id,scope_key));
      CREATE TABLE IF NOT EXISTS wb_model_budget_bindings (
        run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),owner_id TEXT NOT NULL,scopes_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_model_budget_attempts (
        run_id TEXT NOT NULL REFERENCES ga_runs(id),attempt_id TEXT NOT NULL,request_json TEXT NOT NULL,route_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved','in_flight','unknown','settled','released')),
        held_tokens TEXT NOT NULL,held_nano_usd TEXT NOT NULL,usage_json TEXT,actual_tokens TEXT,actual_nano_usd TEXT,
        bound_exceeded INTEGER NOT NULL DEFAULT 0,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(run_id,attempt_id));
      CREATE TABLE IF NOT EXISTS wb_model_budget_events (
        event_id INTEGER PRIMARY KEY,run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,state TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_model_budget_admissions (
        run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),attempt_id TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_model_budget_limit_revisions (
        owner_id TEXT NOT NULL,scope_key TEXT NOT NULL,version INTEGER NOT NULL,limits_json TEXT NOT NULL,
        ceiling_json TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_id,scope_key,version));
      CREATE TRIGGER IF NOT EXISTS wb_budget_limit_revision_no_update BEFORE UPDATE ON wb_model_budget_limit_revisions
        BEGIN SELECT RAISE(ABORT,'budget_limit_revision_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_limit_revision_no_delete BEFORE DELETE ON wb_model_budget_limit_revisions
        BEGIN SELECT RAISE(ABORT,'budget_limit_revision_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_admission_no_update BEFORE UPDATE ON wb_model_budget_admissions
        BEGIN SELECT RAISE(ABORT,'budget_admission_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_admission_no_delete BEFORE DELETE ON wb_model_budget_admissions
        BEGIN SELECT RAISE(ABORT,'budget_admission_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_binding_immutable BEFORE UPDATE ON wb_model_budget_bindings
        BEGIN SELECT RAISE(ABORT,'budget_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_binding_no_delete BEFORE DELETE ON wb_model_budget_bindings
        BEGIN SELECT RAISE(ABORT,'budget_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_scope_config_immutable BEFORE UPDATE OF scope_id,owner_id,scope_key,limits_json,starts_at,ends_at ON wb_model_budget_scopes
        BEGIN SELECT RAISE(ABORT,'budget_scope_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_scope_no_delete BEFORE DELETE ON wb_model_budget_scopes
        BEGIN SELECT RAISE(ABORT,'budget_scope_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_final_receipt_immutable BEFORE UPDATE ON wb_model_budget_attempts WHEN OLD.state IN ('settled','released')
        BEGIN SELECT RAISE(ABORT,'budget_receipt_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_attempt_no_delete BEFORE DELETE ON wb_model_budget_attempts
        BEGIN SELECT RAISE(ABORT,'budget_receipt_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_event_no_update BEFORE UPDATE ON wb_model_budget_events
        BEGIN SELECT RAISE(ABORT,'budget_event_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_event_no_delete BEFORE DELETE ON wb_model_budget_events
        BEGIN SELECT RAISE(ABORT,'budget_event_immutable'); END;`);
    this.hostResources=new HostResourceObservations(db);
  }

  /** Internal authority creates immutable scopes. Public/model APIs must not choose scope identities. */
  createScope(owner: string, key: string, input: ModelBudgetLimits, window: {starts_at?: string; ends_at?: string} = {}) {
    if (!identifier(owner) || !identifier(key)) throw new Error('budget_scope_invalid');
    const value = record(input,['tokens','nano_usd','model_calls'],'budget_scope_invalid');
    const limits = { tokens: count(value.tokens,'budget_scope_invalid'),nano_usd: moneyLimit(value.nano_usd,'budget_scope_invalid'),model_calls: count(value.model_calls,'budget_scope_invalid') };
    record(window,['starts_at','ends_at'],'budget_scope_invalid');
    function date(value: unknown) {
      if (value === undefined) return null;
      if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('budget_scope_invalid');
      return new Date(value).toISOString();
    }
    const start = date(window.starts_at), end = date(window.ends_at);
    if (start && end && start >= end) throw new Error('budget_scope_invalid');
    return withImmediateTransaction(this.db,() => {
      this.admissionGuard();
      const prior = this.db.prepare('SELECT * FROM wb_model_budget_scopes WHERE owner_id=? AND scope_key=?').get(owner,key) as Row | undefined;
      if (prior) {
        if (prior.starts_at !== start || prior.ends_at !== end) throw new Error('budget_scope_conflict');
        if (prior.limits_json !== JSON.stringify(limits)) {
          // A current trusted server policy may change the effective ceiling.
          // Keep the original identity, immutable base and every accounting amount.
          const ceiling=this.scopeCeiling(key,JSON.parse(prior.limits_json!));
          if (!this.hasConfiguredCeiling || limits.tokens!==ceiling.tokens || limits.nano_usd!==ceiling.nano_usd
            || limits.model_calls!==ceiling.model_calls) throw new Error('budget_scope_conflict');
        }
        return {scope_id: prior.scope_id!};
      }
      const id = `budget-${randomUUID()}`;
      this.db.prepare('INSERT INTO wb_model_budget_scopes(scope_id,owner_id,scope_key,limits_json,starts_at,ends_at,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id,owner,key,JSON.stringify(limits),start,end,this.now().toISOString());
      return {scope_id: id};
    });
  }

  private run(owner: string, runId: string) {
    const row = this.db.prepare('SELECT r.status FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=?')
      .get(runId,owner) as {status: string} | undefined;
    if (!row) throw new Error('budget_run_not_found');
    return row;
  }
  private scope(owner: string, id: string): Row {
    const row = this.db.prepare('SELECT * FROM wb_model_budget_scopes WHERE owner_id=? AND scope_id=?').get(owner,id) as Row | undefined;
    if (!row) throw new Error('budget_scope_not_found');
    return row;
  }
  private binding(owner: string, runId: string): string[] {
    this.run(owner,runId);
    const row = this.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(owner,runId) as Row | undefined;
    if (!row) throw new Error('budget_binding_missing');
    return JSON.parse(row.scopes_json!);
  }
  isBound(owner: string, runId: string): boolean {
    this.run(owner,runId);
    return !!this.db.prepare('SELECT 1 FROM wb_model_budget_bindings WHERE run_id=? AND owner_id=?').get(runId,owner);
  }
  bindRun(owner: string, runId: string, ids: string[]) {
    return withImmediateTransaction(this.db,() => {
      this.run(owner,runId);
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 8 || ids.some(id => !identifier(id)) || new Set(ids).size !== ids.length) throw new Error('budget_binding_invalid');
      for (const id of ids) this.scope(owner,id);
      const json = JSON.stringify([...ids].sort()), prior = this.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE run_id=?').get(runId) as Row | undefined;
      if (prior) { if (prior.scopes_json !== json) throw new Error('budget_binding_conflict'); return; }
      this.db.prepare('INSERT INTO wb_model_budget_bindings VALUES(?,?,?,?)').run(runId,owner,json,this.now().toISOString());
    });
  }
  balance(owner: string, id: string) {
    const row = this.scope(owner,id), limits = this.effectiveLimits(row), used = this.readAmounts(row,'used'), held = this.readAmounts(row,'held');
    return {scope_id: id,limits: {tokens:String(limits.tokens),nano_usd:limits.nano_usd===null?null:String(limits.nano_usd),model_calls:String(limits.model_calls)},used: amounts(used),held: amounts(held)};
  }
  /** Observation only: no reservation, release, reconciliation or authority. */
  balancesForRun(owner: string, runId: string) {
    return this.binding(owner,runId).map(id=>this.balance(owner,id));
  }
  /** Read the exact durable root, including native members and continuations.
   * Shared daily scopes alone must not fence unrelated tasks. No reconciliation. */
  observeDurableUsage(owner:string,key:string){
    if(!identifier(owner)||!identifier(key)||!['task-total','chat-root','mailbox-thread'].includes(key.split(':')[0]!))throw Error('budget_scope_invalid');
    return this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN a.state='unknown' THEN 1 ELSE 0 END),0) AS unknown_calls,
      COALESCE(SUM(CASE WHEN a.state='in_flight' THEN 1 ELSE 0 END),0) AS in_flight_calls,
      COALESCE(SUM(CASE WHEN a.state='settled' AND json_extract(a.route_json,'$.billing.unit')='dispatched_call' THEN 1 ELSE 0 END),0) AS unmetered_calls
      FROM wb_model_budget_attempts a JOIN wb_model_budget_bindings b ON b.run_id=a.run_id WHERE b.owner_id=?
      AND EXISTS(SELECT 1 FROM json_each(b.scopes_json) binding_scope JOIN wb_model_budget_scopes s ON s.scope_id=binding_scope.value
        WHERE s.owner_id=b.owner_id AND s.scope_key=?)`).get(owner,key) as {unknown_calls:number;in_flight_calls:number;unmetered_calls:number};
  }
  /** Unknown usage belongs to the durable task/chat/thread, including members.
   * Daily quota overlap alone must not freeze unrelated tasks for the owner. */
  private assertKnownUsage(owner:string,runId:string) {
    if(this.db.prepare(`SELECT 1 FROM wb_model_budget_attempts a
      JOIN wb_model_budget_bindings sibling ON sibling.run_id=a.run_id AND sibling.owner_id=?
      WHERE a.state='unknown' AND (a.run_id=? OR EXISTS (
        SELECT 1 FROM wb_model_budget_bindings current
        JOIN json_each(current.scopes_json) current_scope
        JOIN json_each(sibling.scopes_json) sibling_scope ON sibling_scope.value=current_scope.value
        JOIN wb_model_budget_scopes s ON s.scope_id=current_scope.value AND s.owner_id=current.owner_id
        WHERE current.run_id=? AND current.owner_id=?
          AND (s.scope_key LIKE 'task-total:%' OR s.scope_key LIKE 'chat-root:%' OR s.scope_key LIKE 'mailbox-thread:%')
      )) LIMIT 1`).get(owner,runId,runId,owner))throw new Error('budget_usage_unknown');
  }
  /** Preliminary route check, never a spending grant. The actual routed stream
   * must still reserve and dispatch atomically against the current policy. */
  previewCall(owner: string, runId: string, input: {provider:string;model:string;max_tokens?:number}) {
    const value=record(input,['provider','model','max_tokens'],'budget_request_invalid');
    if(!routeName(value.provider)||!routeName(value.model))throw new Error('budget_request_invalid');
    if(value.max_tokens!==undefined)count(value.max_tokens,'budget_request_invalid',1);
    return withImmediateTransaction(this.db,()=>{
      const ids=this.binding(owner,runId);this.admissionGuard();
      if(!['starting','running'].includes(this.run(owner,runId).status))throw new Error('budget_run_inactive');
      this.assertKnownUsage(owner,runId);
      if(this.db.prepare("SELECT 1 FROM wb_model_budget_attempts WHERE run_id=? AND state='in_flight' LIMIT 1").get(runId))throw new Error('budget_usage_pending');
      if(this.db.prepare('SELECT 1 FROM wb_model_budget_attempts WHERE run_id=? AND bound_exceeded=1 LIMIT 1').get(runId))throw new Error('model_budget_exhausted');
      const route=this.routes.get(routeKey(String(value.provider),String(value.model)));
      if(!route)throw new Error('budget_route_unavailable');
      if(value.max_tokens!==undefined&&Number(value.max_tokens)>route.max_output_tokens)throw new Error('budget_request_invalid');
      const admission=this.db.prepare(`SELECT a.* FROM wb_model_budget_attempts a JOIN wb_model_budget_admissions q
        ON q.run_id=a.run_id AND q.attempt_id=a.attempt_id WHERE a.run_id=? AND a.state='reserved'`).get(runId) as Row|undefined;
      let credit=zero();
      if(admission){const prior:ModelBudgetRoute=JSON.parse(admission.route_json!);
        if(prior.provider===route.provider&&prior.model===route.model)
          credit={tokens:BigInt(admission.held_tokens!),nano_usd:BigInt(admission.held_nano_usd!),model_calls:1n};
      }
      const held=routeHold(route);
      const now=this.now().toISOString();
      for(const id of ids){
        const row=this.scope(owner,id),limits=this.effectiveLimits(row),used=this.readAmounts(row,'used'),reserved=this.readAmounts(row,'held');
        if((row.starts_at&&now<row.starts_at)||(row.ends_at&&now>=row.ends_at))throw new Error('budget_window_closed');
        for(const key of ['tokens','nano_usd','model_calls'] as const){
          if(reserved[key]<credit[key])throw new Error('budget_accounting_corrupt');
          if(limits[key]!==null && used[key]+reserved[key]-credit[key]+held[key]>BigInt(limits[key]!))throw new Error('model_budget_exhausted');
        }
      }
      return {provider:route.provider,model:route.model,pricing_revision:route.revision,reserved:amounts(held),queue_credit:amounts(credit)};
    });
  }
  limitPolicy(owner: string, key: string, fallback: ModelBudgetLimits) {
    const row = this.db.prepare('SELECT version,limits_json FROM wb_model_budget_limit_revisions WHERE owner_id=? AND scope_key=? ORDER BY version DESC LIMIT 1').get(owner,key) as Row | undefined;
    const desired=row?JSON.parse(row.limits_json!) as ModelBudgetLimits:fallback;
    const limits={tokens:Math.min(desired.tokens,fallback.tokens),nano_usd:lesserMoney(desired.nano_usd,fallback.nano_usd),model_calls:Math.min(desired.model_calls,fallback.model_calls)};
    return {version: row ? Number(row.version) : 0,limits};
  }
  private effectiveLimits(row: Row): ModelBudgetLimits {
    return this.limitPolicy(row.owner_id!,row.scope_key!,this.scopeCeiling(row.scope_key!,JSON.parse(row.limits_json!))).limits;
  }
  /** Trusted user service only. Revisions alter ceilings, never accounting or frozen scope identity. */
  setLimits(owner: string, key: string, expectedVersion: number, input: ModelBudgetLimits, ceiling: ModelBudgetLimits) {
    if (!identifier(owner) || !identifier(key)) throw new Error('budget_scope_invalid');
    count(expectedVersion,'budget_limit_invalid');
    const raw=record(input,['tokens','nano_usd','model_calls'],'budget_limit_invalid');
    const limits={tokens:count(raw.tokens,'budget_limit_invalid'),nano_usd:moneyLimit(raw.nano_usd,'budget_limit_invalid'),model_calls:count(raw.model_calls,'budget_limit_invalid')};
    return withImmediateTransaction(this.db,()=>{
      this.admissionGuard();
      const previous=this.limitPolicy(owner,key,ceiling);
      if(previous.version!==expectedVersion)throw new Error('budget_limit_version_conflict');
      if(previous.version===Number.MAX_SAFE_INTEGER)throw new Error('budget_limit_invalid');
      const row=this.db.prepare('SELECT * FROM wb_model_budget_scopes WHERE owner_id=? AND scope_key=?').get(owner,key) as Row|undefined;
      for(const field of ['tokens','nano_usd','model_calls'] as const){
        if(ceiling[field]!==null)count(ceiling[field],'budget_limit_invalid');
        if(ceiling[field]!==null&&(limits[field]===null||limits[field]!>ceiling[field]!))throw new Error('budget_ceiling_exceeded');
        if(row && limits[field]!==null && BigInt(limits[field]!)<BigInt(row[`used_${field}`]!)+BigInt(row[`held_${field}`]!))throw new Error('budget_limit_below_commitment');
      }
      this.db.prepare('INSERT INTO wb_model_budget_limit_revisions VALUES(?,?,?,?,?,?,?)').run(owner,key,previous.version+1,JSON.stringify(limits),JSON.stringify(ceiling),'owner_adjustment',this.now().toISOString());
      return {version:previous.version+1,limits};
    });
  }
  private readAmounts(row: Row, prefix: string): Amounts {
    return {tokens: BigInt(row[`${prefix}_tokens`]!),nano_usd: BigInt(row[`${prefix}_nano_usd`]!),model_calls: BigInt(row[`${prefix}_model_calls`]!)};
  }
  private adjust(owner: string, ids: string[], held: Amounts, used = zero()) {
    for (const id of ids) {
      const row = this.scope(owner,id), a = this.readAmounts(row,'held'), b = this.readAmounts(row,'used');
      for (const key of ['tokens','nano_usd','model_calls'] as const) {
        a[key] += held[key]; b[key] += used[key];
        if (a[key] < 0n || b[key] < 0n) throw new Error('budget_accounting_corrupt');
      }
      this.db.prepare('UPDATE wb_model_budget_scopes SET held_tokens=?,held_nano_usd=?,held_model_calls=?,used_tokens=?,used_nano_usd=?,used_model_calls=? WHERE scope_id=? AND owner_id=?')
        .run(String(a.tokens),String(a.nano_usd),String(a.model_calls),String(b.tokens),String(b.nano_usd),String(b.model_calls),id,owner);
    }
  }
  private event(runId: string, attemptId: string, state: string, detail: unknown = {}) {
    this.db.prepare('INSERT INTO wb_model_budget_events(run_id,attempt_id,state,detail_json,created_at) VALUES(?,?,?,?,?)')
      .run(runId,attemptId,state,JSON.stringify(detail),this.now().toISOString());
  }
  private attempt(owner: string, runId: string, attemptId: string): Row {
    this.binding(owner,runId);
    const row = this.db.prepare('SELECT * FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(runId,attemptId) as Row | undefined;
    if (!row) throw new Error('budget_attempt_not_found');
    return row;
  }
  /** Called only from a trusted host adapter after the original budget dispatch. */
  observeAuxiliaryCall<T>(owner:string,runId:string,attemptId:string,invoke:()=>Promise<T>){
    const row=this.attempt(owner,runId,attemptId);if(!['in_flight','settled'].includes(row.state!))throw new Error('budget_dispatch_conflict');
    return this.hostResources.observe(owner,runId,attemptId,invoke);
  }
  resourceReport(owner:string,runId:string){this.binding(owner,runId);return this.hostResources.report(owner,runId);}
  private receipt(row: Row) {
    const route: ModelBudgetRoute = JSON.parse(row.route_json!);
    return {attempt_id: row.attempt_id!,state: row.state!,provider: route.provider,model: route.model,pricing_revision: route.revision,
      cost_basis: 'configured_rates' as const,reserved: {tokens: row.held_tokens!,nano_usd: row.held_nano_usd!},
      actual: row.state === 'settled' ? {tokens: route.billing?null:row.actual_tokens!,nano_usd: row.actual_nano_usd!} : null,
      ...(route.billing?{metering:'dispatched_call' as const}:{}),
      bound_exceeded: Number(row.bound_exceeded) === 1,reason: row.reason ?? null};
  }

  reserve(owner: string, runId: string, input: ModelBudgetRequest) {
    if(input?.attempt_id==='queue-admission')throw new Error('budget_request_invalid');
    return this.reserveAttempt(owner,runId,input,false);
  }
  /** Called only by the trusted run allocator inside its queue transaction. */
  admitRun(owner: string, runId: string, route: {provider:string;model:string}) {
    return withImmediateTransaction(this.db,()=>{
      record(route,['provider','model'],'budget_request_invalid');
      const receipt=this.reserveAttempt(owner,runId,{attempt_id:'queue-admission',provider:route.provider,model:route.model},true);
      this.db.prepare('INSERT INTO wb_model_budget_admissions VALUES(?,?,?) ON CONFLICT(run_id) DO NOTHING').run(runId,'queue-admission',this.now().toISOString());
      return receipt;
    });
  }
  private reserveAttempt(owner: string, runId: string, input: ModelBudgetRequest, allowQueued: boolean) {
    const value = record(input,['attempt_id','provider','model','max_tokens','purpose'],'budget_request_invalid');
    if (!identifier(value.attempt_id) || !routeName(value.provider) || !routeName(value.model)
      || (value.purpose !== undefined && !['compaction','session-title','emotion','web-decision','reply-verification'].includes(String(value.purpose)))) throw new Error('budget_request_invalid');
    if (value.max_tokens !== undefined) count(value.max_tokens,'budget_request_invalid',1);
    const request = JSON.stringify({attempt_id: value.attempt_id,provider: value.provider,model: value.model,
      ...(value.max_tokens === undefined ? {} : {max_tokens: value.max_tokens}),...(value.purpose === undefined ? {} : {purpose: value.purpose})});
    return withImmediateTransaction(this.db,() => {
      const ids = this.binding(owner,runId);
      const prior = this.db.prepare('SELECT * FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(runId,String(value.attempt_id)) as Row | undefined;
      if (prior) { if (prior.request_json !== request) throw new Error('budget_attempt_conflict'); return this.receipt(prior); }
      this.admissionGuard();
      if (!(allowQueued?['queued','starting','running']:['starting','running']).includes(this.run(owner,runId).status)) throw new Error('budget_run_inactive');
      this.assertKnownUsage(owner,runId);
      if (this.db.prepare('SELECT 1 FROM wb_model_budget_attempts WHERE run_id=? AND bound_exceeded=1 LIMIT 1').get(runId)) throw new Error('model_budget_exhausted');
      const route = this.routes.get(routeKey(String(value.provider),String(value.model)));
      if (!route) throw new Error('budget_route_unavailable');
      if(route.billing&&!['emotion','web-decision'].includes(String(value.purpose)))throw new Error('budget_request_invalid');
      if (value.max_tokens !== undefined && Number(value.max_tokens) > route.max_output_tokens) throw new Error('budget_request_invalid');
      if(!allowQueued){
        const admission=this.db.prepare(`SELECT a.* FROM wb_model_budget_attempts a JOIN wb_model_budget_admissions q
          ON q.run_id=a.run_id AND q.attempt_id=a.attempt_id WHERE a.run_id=? AND a.state='reserved'`).get(runId) as Row|undefined;
        if(admission){const reserved:ModelBudgetRoute=JSON.parse(admission.route_json!);
          if(reserved.provider===route.provider&&reserved.model===route.model)this.releaseUndispatched(owner,runId,admission.attempt_id!);
        }
      }
      // A verified provider context bound is conservative; a heuristic prompt
      // estimate is not a spending limit. All token categories are disjoint.
      const held = routeHold(route);
      const now = this.now().toISOString();
      for (const id of ids) {
        const row = this.scope(owner,id), limits = this.effectiveLimits(row), a = this.readAmounts(row,'used'), b = this.readAmounts(row,'held');
        if ((row.starts_at && now < row.starts_at) || (row.ends_at && now >= row.ends_at)) throw new Error('budget_window_closed');
        for (const key of ['tokens','nano_usd','model_calls'] as const) if (limits[key]!==null && a[key] + b[key] + held[key] > BigInt(limits[key]!)) throw new Error('model_budget_exhausted');
      }
      this.adjust(owner,ids,held);
      this.db.prepare('INSERT INTO wb_model_budget_attempts(run_id,attempt_id,request_json,route_json,state,held_tokens,held_nano_usd,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(runId,String(value.attempt_id),request,JSON.stringify(route),'reserved',String(held.tokens),String(held.nano_usd),now,now);
      this.event(runId,String(value.attempt_id),'reserved',amounts(held));
      return this.receipt(this.attempt(owner,runId,String(value.attempt_id)));
    });
  }
  dispatch(owner: string, runId: string, attemptId: string, guard?:()=>void) {
    return withImmediateTransaction(this.db,() => {
      guard?.();
      this.admissionGuard();
      if(attemptId==='queue-admission')throw new Error('budget_dispatch_conflict');
      const row = this.attempt(owner,runId,attemptId);
      if (row.state !== 'reserved') throw new Error('budget_dispatch_conflict');
      if (!['starting','running'].includes(this.run(owner,runId).status)) throw new Error('budget_run_inactive');
      this.assertKnownUsage(owner,runId);
      if (this.db.prepare('SELECT 1 FROM wb_model_budget_attempts WHERE run_id=? AND bound_exceeded=1 LIMIT 1').get(runId)) throw new Error('model_budget_exhausted');
      const now = this.now().toISOString();
      for (const id of this.binding(owner,runId)) {
        const scope = this.scope(owner,id), limits = this.effectiveLimits(scope), used = this.readAmounts(scope,'used'), held = this.readAmounts(scope,'held');
        if ((scope.starts_at && now < scope.starts_at) || (scope.ends_at && now >= scope.ends_at)) throw new Error('budget_window_closed');
        for (const key of ['tokens','nano_usd','model_calls'] as const) if (limits[key]!==null && used[key] + held[key] > BigInt(limits[key]!)) throw new Error('model_budget_exhausted');
      }
      this.db.prepare("UPDATE wb_model_budget_attempts SET state='in_flight',updated_at=? WHERE run_id=? AND attempt_id=? AND state='reserved'").run(this.now().toISOString(),runId,attemptId);
      this.event(runId,attemptId,'in_flight');return this.receipt(this.attempt(owner,runId,attemptId));
    });
  }
  releaseUndispatched(owner: string, runId: string, attemptId: string) {
    return withImmediateTransaction(this.db,() => {
      const row = this.attempt(owner,runId,attemptId);
      if (row.state === 'released') return this.receipt(row);
      if (row.state !== 'reserved') throw new Error('budget_dispatch_conflict');
      this.adjust(owner,this.binding(owner,runId),{tokens: -BigInt(row.held_tokens!),nano_usd: -BigInt(row.held_nano_usd!),model_calls: -1n});
      this.db.prepare("UPDATE wb_model_budget_attempts SET state='released',updated_at=? WHERE run_id=? AND attempt_id=?").run(this.now().toISOString(),runId,attemptId);
      this.event(runId,attemptId,'released');return this.receipt(this.attempt(owner,runId,attemptId));
    });
  }
  reconcileUndispatched() {
    return withImmediateTransaction(this.db,()=>{
      const now=this.now().toISOString();
      const rows=this.db.prepare(`SELECT a.run_id,a.attempt_id,b.owner_id,r.status FROM wb_model_budget_attempts a
        JOIN wb_model_budget_bindings b ON b.run_id=a.run_id JOIN ga_runs r ON r.id=a.run_id
        WHERE a.state='reserved' AND (r.status NOT IN ('queued','starting','running','waiting_user','waiting_approval')
          OR (a.attempt_id='queue-admission' AND EXISTS (
            SELECT 1 FROM json_each(b.scopes_json) ids JOIN wb_model_budget_scopes s ON s.scope_id=ids.value
            WHERE s.owner_id=b.owner_id AND s.ends_at IS NOT NULL AND s.ends_at<=?)))
        ORDER BY a.created_at,a.run_id,a.attempt_id LIMIT 100`).all(now) as Row[];
      let released=0;
      for(const row of rows){
        const stopped=!['queued','starting','running','waiting_user','waiting_approval'].includes(row.status!);
        const expired=row.attempt_id==='queue-admission'&&this.binding(row.owner_id!,row.run_id!).some(id=>{
          const scope=this.scope(row.owner_id!,id);return !!scope.ends_at&&now>=scope.ends_at;
        });
        if(stopped||expired){this.releaseUndispatched(row.owner_id!,row.run_id!,row.attempt_id!);released++;}
      }
      return {released};
    });
  }
  markUnknown(owner: string, runId: string, attemptId: string, reason: string) {
    return withImmediateTransaction(this.db,() => {
      const row = this.attempt(owner,runId,attemptId);
      if (!['stream_incomplete','usage_incomplete','settlement_unavailable'].includes(reason)) throw new Error('budget_unknown_reason_invalid');
      if (row.state === 'settled') return this.receipt(row);
      if (!['in_flight','unknown'].includes(row.state!)) throw new Error('budget_dispatch_conflict');
      if (row.state === 'unknown' && row.reason === reason) return this.receipt(row);
      this.db.prepare("UPDATE wb_model_budget_attempts SET state='unknown',reason=?,updated_at=? WHERE run_id=? AND attempt_id=?").run(reason,this.now().toISOString(),runId,attemptId);
      this.event(runId,attemptId,'unknown',{reason});return this.receipt(this.attempt(owner,runId,attemptId));
    });
  }
  settle(owner: string, runId: string, attemptId: string, input: unknown) {
    return withImmediateTransaction(this.db,() => {
      const row = this.attempt(owner,runId,attemptId);
      if((JSON.parse(row.route_json!) as ModelBudgetRoute).billing)throw new Error('budget_usage_invalid');
      if (!['in_flight','unknown','settled'].includes(row.state!)) throw new Error('budget_dispatch_conflict');
      const value = record(input,['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens','reasoningTokens'],'budget_usage_invalid');
      const uncached = BigInt(count(value.inputTokens,'budget_usage_invalid')), output = BigInt(count(value.outputTokens,'budget_usage_invalid'));
      let read = value.cacheReadTokens === undefined ? undefined : BigInt(count(value.cacheReadTokens,'budget_usage_invalid'));
      let write = value.cacheWriteTokens === undefined ? undefined : BigInt(count(value.cacheWriteTokens,'budget_usage_invalid'));
      const reasoning = value.reasoningTokens === undefined ? undefined : BigInt(count(value.reasoningTokens,'budget_usage_invalid'));
      const reported = value.totalTokens === undefined ? undefined : BigInt(count(value.totalTokens,'budget_usage_invalid'));
      if (reasoning !== undefined && reasoning > output) throw new Error('budget_usage_invalid');
      const known = uncached + output + (read ?? 0n) + (write ?? 0n);
      if (reported !== undefined && (reported < known || (read !== undefined && write !== undefined && reported !== known))) throw new Error('budget_usage_invalid');
      // Absent caches are provably zero only when the exact total contains no
      // unassigned tokens. Otherwise preserve the full hold for reconciliation.
      if (reported !== undefined && reported === known) { read ??= 0n; write ??= 0n; }
      if (read === undefined || write === undefined) {
        if (row.state === 'settled') throw new Error('budget_settlement_conflict');
        return this.markUnknown(owner,runId,attemptId,'usage_incomplete');
      }
      const tokens = uncached + output + read + write, route: ModelBudgetRoute = JSON.parse(row.route_json!);
      const cost = uncached * BigInt(route.rates.input) + output * BigInt(route.rates.output) + read * BigInt(route.rates.cache_read) + write * BigInt(route.rates.cache_write);
      const normalized = JSON.stringify({inputTokens: String(uncached),outputTokens: String(output),cacheReadTokens: String(read),cacheWriteTokens: String(write),totalTokens: String(tokens),reasoningTokens: reasoning === undefined ? null : String(reasoning)});
      if (row.state === 'settled') { if (row.usage_json !== normalized) throw new Error('budget_settlement_conflict'); return this.receipt(row); }
      const request: ModelBudgetRequest = JSON.parse(row.request_json!);
      const exceeded = tokens > BigInt(row.held_tokens!) || cost > BigInt(row.held_nano_usd!) || output > BigInt(request.max_tokens ?? route.max_output_tokens);
      this.adjust(owner,this.binding(owner,runId),{tokens: -BigInt(row.held_tokens!),nano_usd: -BigInt(row.held_nano_usd!),model_calls: -1n},{tokens,nano_usd: cost,model_calls: 1n});
      this.db.prepare("UPDATE wb_model_budget_attempts SET state='settled',usage_json=?,actual_tokens=?,actual_nano_usd=?,bound_exceeded=?,reason=NULL,updated_at=? WHERE run_id=? AND attempt_id=?")
        .run(normalized,String(tokens),String(cost),exceeded ? 1 : 0,this.now().toISOString(),runId,attemptId);
      this.event(runId,attemptId,'settled',{usage: JSON.parse(normalized),nano_usd: String(cost),bound_exceeded: exceeded,pricing_revision: route.revision});
      return this.receipt(this.attempt(owner,runId,attemptId));
    });
  }
  /** Durable dispatch is the measured unit; tokens remain unmeasured. */
  settleDispatchedCall(owner:string,runId:string,attemptId:string){
    return withImmediateTransaction(this.db,()=>{
      const row=this.attempt(owner,runId,attemptId),route:ModelBudgetRoute=JSON.parse(row.route_json!);
      if(!route.billing)throw new Error('budget_usage_invalid');
      if(row.state==='settled')return this.receipt(row);
      if(!['in_flight','unknown'].includes(row.state!))throw new Error('budget_dispatch_conflict');
      const cost=BigInt(route.billing.nano_usd);
      this.adjust(owner,this.binding(owner,runId),{tokens:-BigInt(row.held_tokens!),nano_usd:-BigInt(row.held_nano_usd!),model_calls:-1n},{tokens:0n,nano_usd:cost,model_calls:1n});
      this.db.prepare(`UPDATE wb_model_budget_attempts SET state='settled',usage_json=?,actual_tokens=NULL,actual_nano_usd=?,reason=NULL,updated_at=? WHERE run_id=? AND attempt_id=?`)
        .run(JSON.stringify({unit:'dispatched_call',calls:1,token_usage:'not_metered'}),String(cost),this.now().toISOString(),runId,attemptId);
      this.event(runId,attemptId,'settled',{unit:'dispatched_call',calls:1,token_usage:'not_metered',nano_usd:String(cost),pricing_revision:route.revision});
      return this.receipt(this.attempt(owner,runId,attemptId));
    });
  }
  reconcileDispatchedCalls(limit=100){
    count(limit,'budget_request_invalid',1);if(limit>1000)throw new Error('budget_request_invalid');
    return withImmediateTransaction(this.db,()=>{
      const rows=this.db.prepare(`SELECT b.owner_id,a.run_id,a.attempt_id FROM wb_model_budget_attempts a
        JOIN wb_model_budget_bindings b ON b.run_id=a.run_id
        WHERE a.state IN ('in_flight','unknown') AND json_extract(a.route_json,'$.billing.unit')='dispatched_call'
        ORDER BY a.created_at,a.run_id,a.attempt_id LIMIT ?`).all(limit);
      for(const row of rows)this.settleDispatchedCall(String(row.owner_id),String(row.run_id),String(row.attempt_id));
      return {settled:rows.length};
    });
  }
}
