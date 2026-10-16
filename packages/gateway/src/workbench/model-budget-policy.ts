import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import { parseWorkerConcurrency } from '../harness/worker-pool.ts';
import { ModelBudgetLedger, normalizeModelBudgetRoutes, type ModelBudgetLimits, type ModelBudgetRoute } from './model-budget.ts';
import {installTaskMailbox,currentTaskMailbox} from './task-mailbox.ts';
import {assertNativeRun} from './native-child-identity.ts';
import {assertMemoryProcessingIdentity} from './memory-processing.ts';

const categories = ['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'] as const;
type Category = typeof categories[number];
type Row = Record<string, string | number | null>;
export interface ModelBudgetPolicyConfig {
  revision: number;
  admission_route: { provider: string; model: string };
  routes: ModelBudgetRoute[];
  limits: Record<Category, ModelBudgetLimits>;
}
type Allocation = { run_id: string; scopes: Array<{key: string; scope_id: string}> };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const taskBudgetKey = (taskId: string) => `task-total:${hash(taskId)}`;
export function dailyBudgetDefinitions(workspace: string, project: string, agent: string, instant: Date) {
  const day=instant.toISOString().slice(0,10);
  const window={starts_at:`${day}T00:00:00.000Z`,ends_at:new Date(Date.parse(`${day}T00:00:00.000Z`)+86400000).toISOString()};
  return {window,definitions:[
    {key:`owner-day:${day}`,category:'owner_daily' as const,daily:true},
    {key:`project-day:${hash(JSON.stringify([workspace,project]))}:${day}`,category:'project_daily' as const,daily:true},
    {key:`agent-day:${hash(agent)}:${day}`,category:'agent_daily' as const,daily:true},
  ]};
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('budget_policy_invalid');
  return value as Record<string, unknown>;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)])) : value;
}
export function normalizeModelBudgetPolicy(input: unknown): ModelBudgetPolicyConfig {
  try {
    const value = object(input,['revision','admission_route','routes','limits']);
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error();
    const routes = normalizeModelBudgetRoutes(value.routes);
    if (!routes.length || routes.length > 64) throw new Error();
    const admission = object(value.admission_route,['provider','model']);
    if (!routes.some(route => route.provider === admission.provider && route.model === admission.model&&!route.billing)) throw new Error();
    const limits = object(value.limits,categories), normalized = {} as Record<Category,ModelBudgetLimits>;
    for (const category of categories) {
      const item = object(limits[category],['tokens','nano_usd','model_calls']);
      for (const key of ['tokens','nano_usd','model_calls']) {
        if(key==='nano_usd' && item[key]===null)continue;
        if (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0) throw new Error();
      }
      normalized[category] = {tokens: Number(item.tokens),nano_usd: item.nano_usd===null?null:Number(item.nano_usd),model_calls: Number(item.model_calls)};
    }
    return {revision: Number(value.revision),admission_route: {provider: String(admission.provider),model: String(admission.model)},routes,limits: normalized};
  } catch { throw new Error('budget_policy_invalid'); }
}
/** Read at most one bounded policy, never credentials or model-supplied files. */
export function loadModelBudgetPolicy(path?: string): ModelBudgetPolicyConfig | undefined {
  if (!path?.trim()) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path,'r');
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 262144) throw new Error();
    const buffer = Buffer.alloc(262145); let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd,buffer,length,buffer.length-length,null);
      if (!read) break;
      length += read;
    }
    if (length > 262144) throw new Error();
    return normalizeModelBudgetPolicy(JSON.parse(buffer.subarray(0,length).toString('utf8')));
  } catch { throw new Error('budget_policy_invalid'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function workbenchExecutionConfiguration(env: Record<string,string | undefined>) {
  const modelBudgetPolicy = loadModelBudgetPolicy(env.GENERAL_AGENT_MODEL_BUDGET_POLICY_FILE);
  return {modelBudgetPolicy,workbenchExecutionReady: env.GENERAL_AGENT_WORKBENCH_EXECUTION_READY === 'true'
    && parseWorkerConcurrency(env.GENERAL_AGENT_WORKER_CONCURRENCY) >= 2 && modelBudgetPolicy !== undefined};
}

/** Derive quota scopes from authoritative bindings inside the existing run transaction. */
export class WorkbenchBudgetPolicy {
  readonly ledger: ModelBudgetLedger;
  private readonly db: DatabaseSync;
  private readonly config: ModelBudgetPolicyConfig;
  private readonly fingerprint: string;
  private readonly now: () => Date;
  constructor(db: DatabaseSync, input: ModelBudgetPolicyConfig, options: {now?: () => Date} = {}) {
    this.db = db; this.config = normalizeModelBudgetPolicy(input); this.now = options.now ?? (() => new Date());
    installTaskMailbox(db);
    this.fingerprint = hash(JSON.stringify(canonical(this.config)));
    db.exec(`CREATE TABLE IF NOT EXISTS wb_model_budget_policy_registry (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,policy_hash TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_model_budget_policy_history (
      revision INTEGER PRIMARY KEY CHECK(revision>0),policy_hash TEXT NOT NULL,policy_json TEXT NOT NULL,activated_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS wb_budget_policy_history_no_update BEFORE UPDATE ON wb_model_budget_policy_history
        BEGIN SELECT RAISE(ABORT,'budget_policy_history_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_policy_history_no_delete BEFORE DELETE ON wb_model_budget_policy_history
        BEGIN SELECT RAISE(ABORT,'budget_policy_history_immutable'); END;
      CREATE TABLE IF NOT EXISTS wb_budget_allocations (
      run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),owner_id TEXT NOT NULL,allocation_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_budget_chat_lineage (
      run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),parent_run_id TEXT NOT NULL REFERENCES ga_runs(id),owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,CHECK(run_id!=parent_run_id));
      CREATE TRIGGER IF NOT EXISTS wb_budget_chat_lineage_immutable BEFORE UPDATE ON wb_budget_chat_lineage
        BEGIN SELECT RAISE(ABORT,'budget_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_chat_lineage_no_delete BEFORE DELETE ON wb_budget_chat_lineage
        BEGIN SELECT RAISE(ABORT,'budget_binding_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_allocation_immutable BEFORE UPDATE ON wb_budget_allocations
        BEGIN SELECT RAISE(ABORT,'budget_allocation_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_budget_allocation_no_delete BEFORE DELETE ON wb_budget_allocations
        BEGIN SELECT RAISE(ABORT,'budget_allocation_immutable'); END;`);
    withImmediateTransaction(db,() => {
      const old = db.prepare('SELECT * FROM wb_model_budget_policy_registry WHERE singleton=1').get() as Row | undefined;
      if (old && Number(old.revision) > this.config.revision) throw new Error('budget_policy_stale');
      if (old && Number(old.revision) === this.config.revision && old.policy_hash !== this.fingerprint) throw new Error('budget_policy_conflict');
      const history=db.prepare('SELECT policy_hash FROM wb_model_budget_policy_history WHERE revision=?').get(this.config.revision) as Row|undefined;
      if(history && history.policy_hash!==this.fingerprint)throw new Error('budget_policy_conflict');
      // Record only configurations observed here; never reconstruct missing past revisions.
      if(!history)db.prepare('INSERT INTO wb_model_budget_policy_history VALUES(?,?,?,?)')
        .run(this.config.revision,this.fingerprint,JSON.stringify(canonical(this.config)),this.now().toISOString());
      if (!old || Number(old.revision) < this.config.revision) db.prepare(`INSERT INTO wb_model_budget_policy_registry VALUES(1,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,policy_hash=excluded.policy_hash,updated_at=excluded.updated_at`)
        .run(this.config.revision,this.fingerprint,this.now().toISOString());
    });
    this.ledger = new ModelBudgetLedger(db,{routes: this.config.routes,now: this.now,admissionGuard: () => this.assertCurrent(),scopeCeiling:(key,base)=>{
      const kind=({'owner-day':'owner_daily','project-day':'project_daily','agent-day':'agent_daily','task-total':'task_total',occurrence:'occurrence','chat-root':'chat_root','mailbox-thread':'mailbox_thread'} as Record<string,Category>)[key.split(':')[0]!];
      return kind?this.config.limits[kind]:base;
    }});
  }
  assertCurrent(): void {
    const row = this.db.prepare('SELECT * FROM wb_model_budget_policy_registry WHERE singleton=1').get() as Row | undefined;
    if (!row || Number(row.revision) !== this.config.revision || row.policy_hash !== this.fingerprint) throw new Error('budget_policy_stale');
  }
  budgetSettings() {
    this.assertCurrent();
    const route=this.config.routes.find(item=>item.provider===this.config.admission_route.provider && item.model===this.config.admission_route.model)!;
    return {instant:this.now(),limits:structuredClone(this.config.limits),nextCall:{tokens:BigInt(route.context_window),nano_usd:BigInt(route.context_window)*BigInt(Math.max(...Object.values(route.rates))),model_calls:1n}};
  }
  private owned(owner: string, runId: string): Row {
    const row = this.db.prepare(`SELECT r.*,c.owner_id,c.workspace_id,c.project_id FROM ga_runs r
      JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=?`).get(runId,owner) as Row | undefined;
    if (!row) throw new Error('budget_run_not_found');
    return row;
  }
  allocation(owner: string, runId: string): Allocation {
    this.owned(owner,runId);
    const row = this.db.prepare('SELECT allocation_json FROM wb_budget_allocations WHERE owner_id=? AND run_id=?').get(owner,runId) as Row | undefined;
    if (!row) throw new Error('budget_binding_missing');
    return JSON.parse(String(row.allocation_json));
  }
  /** The trusted steering dispatcher also continues a root when no native checkpoint exists. */
  inheritChatRun(owner: string, originalId: string, nextId: string): Allocation {
    return withImmediateTransaction(this.db,() => {
      this.assertCurrent();
      const original = this.owned(owner,originalId), next = this.owned(owner,nextId);
      if (originalId === nextId || original.conversation_id !== next.conversation_id
        || (next.continuation_of && next.continuation_of !== originalId)) throw new Error('budget_binding_invalid');
      const before = this.db.prepare('SELECT agent_id,kind FROM wb_run_bindings WHERE run_id=? AND owner_id=?').get(originalId,owner) as Row | undefined;
      const after = this.db.prepare('SELECT agent_id,kind FROM wb_run_bindings WHERE run_id=? AND owner_id=?').get(nextId,owner) as Row | undefined;
      if (!before || !after || before.kind !== 'chat' || after.kind !== 'chat' || before.agent_id !== after.agent_id) throw new Error('budget_binding_invalid');
      this.allocation(owner,originalId);
      const existing = this.db.prepare('SELECT parent_run_id,owner_id FROM wb_budget_chat_lineage WHERE run_id=?').get(nextId) as Row | undefined;
      if (existing && (existing.parent_run_id !== originalId || existing.owner_id !== owner)) throw new Error('budget_binding_conflict');
      if (!existing) {
        if (this.db.prepare('SELECT 1 FROM wb_budget_allocations WHERE run_id=?').get(nextId)) throw new Error('budget_binding_conflict');
        this.db.prepare('INSERT INTO wb_budget_chat_lineage VALUES(?,?,?,?)').run(nextId,originalId,owner,this.now().toISOString());
      }
      return this.allocate(owner,nextId);
    });
  }
  allocate(owner: string, runId: string): Allocation {
    return withImmediateTransaction(this.db,() => {
      this.assertCurrent();
      const run = this.owned(owner,runId);
      if (this.db.prepare('SELECT 1 FROM wb_budget_allocations WHERE run_id=? AND owner_id=?').get(runId,owner)) return this.allocation(owner,runId);
      const binding = this.db.prepare(`SELECT b.*,a.workspace_id,a.project_id,a.owner_id AS agent_owner,a.capability_epoch,a.status
        FROM wb_run_bindings b JOIN wb_agents a ON a.agent_id=b.agent_id WHERE b.run_id=? AND b.owner_id=?`).get(runId,owner) as Row | undefined;
      if (!binding || binding.agent_owner !== owner || binding.workspace_id !== run.workspace_id || binding.project_id !== run.project_id
        || binding.status !== 'active' || binding.epoch !== binding.capability_epoch) throw new Error('budget_binding_invalid');
      const instant = this.now();
      const daily=dailyBudgetDefinitions(String(run.workspace_id),String(run.project_id),String(binding.agent_id),instant),window=daily.window;
      const definitions: Array<{key:string; category: Category; daily?:boolean}> = [...daily.definitions];
      if (binding.kind === 'task') {
        const task = this.db.prepare(`SELECT o.occurrence_id,o.generation,t.generation AS current_generation,t.task_id,t.owner_id,t.agent_id
          FROM wb_task_run_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id WHERE o.run_id=?`).get(runId) as Row | undefined;
        if (!task || task.owner_id !== owner || task.agent_id !== binding.agent_id || task.generation !== task.current_generation) throw new Error('budget_binding_invalid');
        if(this.db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN wb_task_run_occurrences o ON o.run_id=a.run_id
          JOIN wb_model_budget_bindings b ON b.run_id=a.run_id WHERE o.task_id=? AND b.owner_id=? AND a.state='unknown' LIMIT 1`).get(task.task_id!,owner))throw new Error('budget_usage_unknown');
        definitions.push({key:taskBudgetKey(String(task.task_id)),category:'task_total'},
          {key:`occurrence:${hash(String(task.occurrence_id))}`,category:'occurrence'});
      } else if (binding.kind === 'native_team') {
        const saved=assertNativeRun(this.db,owner,runId);
        if(saved.role_id!==binding.agent_id||saved.workspace_id!==run.workspace_id||saved.project_id!==run.project_id)throw new Error('budget_binding_invalid');
        definitions.push({key:taskBudgetKey(saved.task_id),category:'task_total'},
          {key:`occurrence:${hash(saved.occurrence_id)}`,category:'occurrence'});
      } else if (binding.kind === 'internal_mailbox') {
        const thread = this.db.prepare(`SELECT m.recipient_agent_id,m.owner_id,m.workspace_id,m.project_id,t.thread_id,t.owner_id AS thread_owner
          FROM wb_agent_messages m JOIN wb_message_threads t ON t.thread_id=m.thread_id WHERE m.run_id=?`).get(runId) as Row | undefined;
        if (!thread || thread.owner_id !== owner || thread.thread_owner !== owner || thread.recipient_agent_id !== binding.agent_id
          || thread.workspace_id !== run.workspace_id || thread.project_id !== run.project_id) throw new Error('budget_binding_invalid');
        definitions.push({key:`mailbox-thread:${hash(String(thread.thread_id))}`,category:'mailbox_thread'});
        const taskRoot=currentTaskMailbox(this.db,owner,String(thread.thread_id));
        if(taskRoot)definitions.push({key:taskBudgetKey(taskRoot.task_id),category:'task_total'},
          {key:`occurrence:${hash(taskRoot.occurrence_id)}`,category:'occurrence'});
      } else if (binding.kind === 'memory_capture') {
        const saved=assertMemoryProcessingIdentity(this.db,owner,runId);
        if(saved.agent_id!==binding.agent_id)throw new Error('budget_binding_invalid');
        const source=this.allocation(owner,String(saved.source_run_id)),cumulative=source.scopes.filter(scope=>!['owner-day','project-day','agent-day'].includes(scope.key.split(':')[0]!));
        if(!cumulative.length)throw new Error('budget_binding_invalid');
        const categoryByPrefix:Record<string,Category>={'task-total':'task_total',occurrence:'occurrence','chat-root':'chat_root','mailbox-thread':'mailbox_thread'};
        for(const scope of cumulative){const category=categoryByPrefix[scope.key.split(':')[0]!];if(!category)throw new Error('budget_binding_invalid');definitions.push({key:scope.key,category});}
        if(this.db.prepare(`SELECT 1 FROM wb_model_budget_attempts attempts JOIN wb_model_budget_bindings bindings ON bindings.run_id=attempts.run_id WHERE bindings.owner_id=? AND EXISTS (SELECT 1 FROM json_each(bindings.scopes_json) scope WHERE scope.value IN (${cumulative.map(()=>'?').join(',')})) AND attempts.state IN ('unknown','in_flight') LIMIT 1`).get(owner,...cumulative.map(scope=>scope.scope_id)))throw new Error('budget_usage_unknown');
      } else if (binding.kind === 'chat') {
        let root = run, seen = new Set<string>();
        for (;;) {
          const lineage = this.db.prepare('SELECT parent_run_id FROM wb_budget_chat_lineage WHERE run_id=? AND owner_id=?').get(String(root.id),owner) as Row | undefined;
          if (lineage && root.continuation_of && lineage.parent_run_id !== root.continuation_of) throw new Error('budget_binding_invalid');
          const parent = lineage?.parent_run_id ?? root.continuation_of;
          if (!parent) break;
          if (seen.has(String(root.id)) || seen.size >= 100) throw new Error('budget_binding_invalid');
          seen.add(String(root.id));
          root = this.owned(owner,String(parent));
          const ancestor = this.db.prepare('SELECT agent_id,kind FROM wb_run_bindings WHERE run_id=? AND owner_id=?').get(String(root.id),owner) as Row | undefined;
          if (root.conversation_id !== run.conversation_id || !ancestor || ancestor.kind !== 'chat' || ancestor.agent_id !== binding.agent_id) throw new Error('budget_binding_invalid');
        }
        definitions.push({key:`chat-root:${hash(String(root.id))}`,category:'chat_root'});
      } else throw new Error('budget_binding_invalid');
      const scopes = definitions.map(definition => ({key:definition.key,...this.ledger.createScope(owner,definition.key,
        this.config.limits[definition.category],definition.daily ? window : {})}));
      this.ledger.bindRun(owner,runId,scopes.map(scope => scope.scope_id));
      this.ledger.admitRun(owner,runId,this.config.admission_route);
      const allocation = {run_id:runId,scopes};
      this.db.prepare('INSERT INTO wb_budget_allocations VALUES(?,?,?,?)').run(runId,owner,JSON.stringify(allocation),instant.toISOString());
      return allocation;
    });
  }
}
