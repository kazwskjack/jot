import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import { ConversationRepository } from '../conversations/repository.ts';
import { ProjectRepository } from '../projects/repository.ts';
import { EventStore } from '../events/event-store.ts';
import { RunRepository } from '../runs/repository.ts';
import { RunCommandService } from '../runs/commands.ts';
import { MemoryLifecycle, memoryExpired, memoryMetadata, rankMemory, serializeMemory, type MemoryRankAdapter } from './memory-lifecycle.ts';
import type { WorkbenchBudgetPolicy } from './model-budget-policy.ts';
import {installTaskRunLineage,bindTaskContinuation} from '../persistent-tasks/task-runs.ts';
import {installTaskMailbox,bindTaskMailbox,currentTaskMailbox,taskMemberCapacityAvailable} from './task-mailbox.ts';
import {taskAssignmentForMessage} from './task-delegation.ts';
import {automaticDelegationLimit} from './task-collaboration.ts';
import {installNativeChildRuns,assertNativeReservation,assertNativeRun,assertNativeSnapshot,type NativeReservation} from './native-child-identity.ts';
import {assertExecutionLease} from './execution-lease.ts';

type Input = Record<string, unknown>;
type Row = Record<string, string | number | null>;
export interface Agent {
  agent_id: string; name: string; instructions: string; workspace_id: string; project_id: string;
  conversation_id: string; status: 'active' | 'disabled' | 'deleting' | 'deleted'; version: number;
  capability_epoch: number; allowed_tools: string[]; created_at: string; updated_at: string;
}
export interface AgentRunContext {
  run_id: string; agent_id: string; owner_id: string; workspace_id: string; project_id: string; instructions: string;
  name: string; capability_epoch: number; allowed_tools: string[]; memories: Input[]; kind: string;
  task_assignment?:{subtask_id:string;subtask_version:number;title:string;acceptance:string;dependencies:string[]};
}
export interface WorkbenchOptions {
  workspaceIds: string[]; root: string; allowedToolIds?: string[]; maxMailboxRunsPerDay?: number;
  memoryRankAdapter?: MemoryRankAdapter;
  modelBudgetPolicy?: WorkbenchBudgetPolicy;
}
const timestamp = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function text(value: unknown, code: string, max = 20_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(code);
  return value.trim();
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('invalid_expected_version');
  return Number(value);
}
function noSymlinkAncestors(target: string): void {
  let path = resolve(target);
  for (;;) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('workspace_path_escape');
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
}

/** Authoritative workbench records use the product database and existing run queue. */
export class WorkbenchService {
  private readonly db: DatabaseSync;
  private readonly options: WorkbenchOptions;
  private readonly projects: ProjectRepository;
  private readonly conversations: ConversationRepository;
  private readonly events: EventStore;
  private readonly runs: RunRepository;
  private readonly commands: RunCommandService;
  private readonly canonicalRoot: string;
  private readonly memoryLifecycle: MemoryLifecycle;
  constructor(db: DatabaseSync, options: WorkbenchOptions) {
    this.db = db; this.options = options;
    installTaskRunLineage(db);
    installTaskMailbox(db);
    installNativeChildRuns(db);
    this.projects = new ProjectRepository(db);
    this.conversations = new ConversationRepository(db, this.projects);
    this.events = new EventStore(db); this.runs = new RunRepository(db, this.events);
    this.commands = new RunCommandService(db, this.events);
    noSymlinkAncestors(options.root);
    mkdirSync(resolve(options.root), { recursive: true });
    this.canonicalRoot = realpathSync(resolve(options.root));
    db.exec(`
      CREATE TABLE IF NOT EXISTS wb_agents (
        agent_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,instructions TEXT NOT NULL,
        workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,version INTEGER NOT NULL,capability_epoch INTEGER NOT NULL,
        allowed_tools_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS wb_agents_owner ON wb_agents(owner_id,workspace_id,status);
      CREATE TABLE IF NOT EXISTS wb_agent_revisions (
        agent_id TEXT NOT NULL,version INTEGER NOT NULL,config_json TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(agent_id,version));
      CREATE TRIGGER IF NOT EXISTS wb_agent_revision_no_update BEFORE UPDATE ON wb_agent_revisions
        BEGIN SELECT RAISE(ABORT,'agent_revision_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_agent_revision_no_delete BEFORE DELETE ON wb_agent_revisions
        BEGIN SELECT RAISE(ABORT,'agent_revision_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_agent_revision_no_replace BEFORE INSERT ON wb_agent_revisions
        WHEN EXISTS(SELECT 1 FROM wb_agent_revisions WHERE agent_id=NEW.agent_id AND version=NEW.version)
        BEGIN SELECT RAISE(ABORT,'agent_revision_immutable'); END;
      CREATE TABLE IF NOT EXISTS wb_run_bindings (
        run_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,agent_id TEXT NOT NULL,epoch INTEGER NOT NULL,
        kind TEXT NOT NULL,context_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_deletion_jobs (
        agent_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_teams (
        team_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_team_members (
        team_id TEXT NOT NULL,agent_id TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(team_id,agent_id));
      CREATE TABLE IF NOT EXISTS wb_memories (
        memory_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
        scope TEXT NOT NULL,agent_id TEXT,content TEXT NOT NULL,verified INTEGER NOT NULL,version INTEGER NOT NULL,
        status TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_message_threads (
        thread_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
        max_runs INTEGER NOT NULL,used_runs INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_agent_messages (
        message_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
        sender_agent_id TEXT NOT NULL,recipient_agent_id TEXT NOT NULL,thread_id TEXT NOT NULL,root_causation_id TEXT NOT NULL,
        reply_to TEXT,text TEXT NOT NULL,initiator TEXT NOT NULL,status TEXT NOT NULL,auto_reply INTEGER NOT NULL,
        client_message_id TEXT NOT NULL,run_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        UNIQUE(owner_id,sender_agent_id,client_message_id));
      CREATE TABLE IF NOT EXISTS wb_mailbox_budgets (
        owner_id TEXT NOT NULL,day TEXT NOT NULL,reserved_runs INTEGER NOT NULL,PRIMARY KEY(owner_id,day));
      CREATE TABLE IF NOT EXISTS wb_files (
        owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,path TEXT NOT NULL,
        version INTEGER NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,blob_name TEXT NOT NULL,updated_at TEXT NOT NULL,
        PRIMARY KEY(owner_id,workspace_id,project_id,path));
      CREATE TABLE IF NOT EXISTS wb_file_versions (
        owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,path TEXT NOT NULL,
        version INTEGER NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,blob_name TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(owner_id,workspace_id,project_id,path,version));
      CREATE TRIGGER IF NOT EXISTS wb_file_version_no_update BEFORE UPDATE ON wb_file_versions
        BEGIN SELECT RAISE(ABORT,'file_version_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_file_version_no_delete BEFORE DELETE ON wb_file_versions
        BEGIN SELECT RAISE(ABORT,'file_version_immutable'); END;
      CREATE TABLE IF NOT EXISTS wb_file_write_runs (
        run_id TEXT NOT NULL REFERENCES ga_runs(id),owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
        path TEXT NOT NULL,version INTEGER NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,
        PRIMARY KEY(run_id,path,version),
        FOREIGN KEY(owner_id,workspace_id,project_id,path,version) REFERENCES wb_file_versions(owner_id,workspace_id,project_id,path,version));
      CREATE TRIGGER IF NOT EXISTS wb_file_write_run_no_update BEFORE UPDATE ON wb_file_write_runs
        BEGIN SELECT RAISE(ABORT,'file_write_run_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_file_write_run_no_delete BEFORE DELETE ON wb_file_write_runs
        BEGIN SELECT RAISE(ABORT,'file_write_run_immutable'); END;
    `);
    this.memoryLifecycle = new MemoryLifecycle(db);
  }
  private transaction<T>(fn: () => T): T { return withImmediateTransaction(this.db, fn); }
  private workspace(value: unknown): string {
    const workspace = value === undefined ? this.options.workspaceIds[0] : String(value);
    if (!workspace || !this.options.workspaceIds.includes(workspace)) throw new Error('workspace_not_found');
    return workspace;
  }
  private tools(value: unknown): string[] {
    if (value === undefined) return [...(this.options.allowedToolIds ?? [])];
    if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !(this.options.allowedToolIds ?? []).includes(x))) throw new Error('invalid_allowed_tools');
    return [...new Set(value as string[])];
  }
  private agent(row: Row): Agent {
    return { agent_id: String(row.agent_id), name: String(row.name), instructions: String(row.instructions),
      workspace_id: String(row.workspace_id), project_id: String(row.project_id), conversation_id: String(row.conversation_id),
      status: row.status as Agent['status'], version: Number(row.version), capability_epoch: Number(row.capability_epoch),
      allowed_tools: JSON.parse(String(row.allowed_tools_json)) as string[], created_at: String(row.created_at), updated_at: String(row.updated_at) };
  }
  getAgent(owner: string, agentId: string): Agent {
    const row = this.db.prepare('SELECT * FROM wb_agents WHERE owner_id=? AND agent_id=?').get(owner, agentId) as Row | undefined;
    if (!row) throw new Error('agent_not_found');
    return this.agent(row);
  }
  agentForConversation(owner: string, conversationId: string): Agent | null {
    const row = this.db.prepare(`SELECT * FROM wb_agents WHERE owner_id=? AND conversation_id=?`)
      .get(owner, conversationId) as Row | undefined
      ?? this.db.prepare(`SELECT a.* FROM wb_agents a JOIN wb_run_bindings b ON b.agent_id=a.agent_id
        JOIN ga_runs r ON r.id=b.run_id WHERE a.owner_id=? AND b.owner_id=? AND r.conversation_id=?
        ORDER BY r.created_at DESC LIMIT 1`).get(owner, owner, conversationId) as Row | undefined;
    return row ? this.agent(row) : null;
  }
  private active(owner: string, agentId: string): Agent {
    const agent = this.getAgent(owner, agentId);
    if (agent.status !== 'active') throw new Error('agent_capability_revoked');
    return agent;
  }
  listAgents(owner: string) {
    const rows = this.db.prepare("SELECT * FROM wb_agents WHERE owner_id=? AND status!='deleted' ORDER BY created_at,agent_id").all(owner) as Row[];
    return { items: rows.map(row => this.agent(row)) };
  }
  createAgent(owner: string, input: Input): Agent {
    const name = text(input.name, 'invalid_agent_name', 100);
    const instructions = input.instructions === undefined ? '' : text(input.instructions, 'invalid_agent_instructions');
    const workspace = this.workspace(input.workspace_id);
    const project = input.project_id === undefined ? this.projects.ensureDefault(owner).project_id : String(input.project_id);
    this.projects.assertOwned(project, owner);
    const tools = this.tools(input.allowed_tools);
    return this.transaction(() => {
      const conversation = this.conversations.create(owner, { workspace_id: workspace, project_id: project, title: name, model: { provider: 'harness', model: 'automatic' } });
      const agentId = id('agent'), now = timestamp();
      this.db.prepare('INSERT INTO wb_agents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(agentId, owner, name, instructions, workspace, project, conversation.conversation_id, 'active', 1, 1, JSON.stringify(tools), now, now);
      const agent = this.getAgent(owner, agentId); this.revision(agent); return agent;
    });
  }
  private revision(agent: Agent) {
    this.db.prepare('INSERT INTO wb_agent_revisions VALUES(?,?,?,?)').run(agent.agent_id, agent.version, JSON.stringify(agent), timestamp());
  }
  updateAgent(owner: string, agentId: string, input: Input): Agent {
    return this.transaction(() => {
      const old = this.getAgent(owner, agentId);
      if (old.status === 'deleting' || old.status === 'deleted') throw new Error('agent_capability_revoked');
      if (integer(input.expected_version) !== old.version) throw new Error('version_conflict');
      const name = input.name === undefined ? old.name : text(input.name, 'invalid_agent_name', 100);
      const instructions = input.instructions === undefined ? old.instructions : text(input.instructions, 'invalid_agent_instructions');
      if (input.workspace_id !== undefined && input.workspace_id !== old.workspace_id) throw new Error('agent_workspace_immutable');
      if (input.project_id !== undefined && input.project_id !== old.project_id) throw new Error('agent_project_immutable');
      const tools = input.allowed_tools === undefined ? old.allowed_tools : this.tools(input.allowed_tools);
      const status = input.status === undefined ? old.status : String(input.status);
      if (!['active', 'disabled'].includes(status)) throw new Error('invalid_agent_status');
      const revoked = status === 'disabled' || old.allowed_tools.some(tool => !tools.includes(tool));
      this.db.prepare('UPDATE wb_agents SET name=?,instructions=?,allowed_tools_json=?,status=?,version=version+1,capability_epoch=capability_epoch+?,updated_at=? WHERE agent_id=? AND owner_id=? AND version=?')
        .run(name, instructions, JSON.stringify(tools), status, revoked ? 1 : 0, timestamp(), agentId, owner, old.version);
      const agent = this.getAgent(owner, agentId); this.revision(agent); return agent;
    });
  }
  bindRun(owner: string, agentId: string, runId: string, kind = 'task'): void {
    this.transaction(() => {
      this.assertBudgetService();
      const agent = this.active(owner, agentId);
      const run = this.runs.get(runId, owner);
      const conversation = this.conversations.get(String(run.conversation_id), owner);
      if (conversation.workspace_id !== agent.workspace_id || conversation.project_id !== agent.project_id) throw new Error('run_agent_scope_mismatch');
      const existing = this.db.prepare('SELECT * FROM wb_run_bindings WHERE run_id=?').get(runId) as Row | undefined;
      if (existing) {
        if (existing.agent_id !== agentId || existing.owner_id !== owner || existing.kind !== kind) throw new Error('run_binding_conflict');
        this.assertRunActive(runId); return;
      }
      const context: AgentRunContext = { run_id: runId, agent_id: agentId, owner_id: owner, name: agent.name, instructions: agent.instructions,
        workspace_id: agent.workspace_id, project_id: agent.project_id, capability_epoch: agent.capability_epoch,
        allowed_tools: agent.allowed_tools, memories: this.recalledMemory(owner, agent), kind };
      this.db.prepare('INSERT INTO wb_run_bindings VALUES(?,?,?,?,?,?,?)').run(runId, owner, agentId, agent.capability_epoch, kind, JSON.stringify(context), timestamp());
      this.options.modelBudgetPolicy?.allocate(owner,runId);
    });
  }
  /** Authenticated native host only. Preparing records never starts a driver. */
  prepareNativeChild(owner:string,reservationId:string){
    return this.transaction(()=>{
      const saved=assertNativeReservation(this.db,owner,reservationId);
      const prior=this.db.prepare('SELECT run_id FROM wb_native_child_runs WHERE reservation_id=? AND owner_id=?').get(reservationId,owner) as {run_id:string}|undefined;
      if(prior){this.assertRunActive(prior.run_id);const run=this.runs.get(prior.run_id,owner);return {run_id:prior.run_id,conversation_id:String(run.conversation_id),session_ref:saved.child_session_ref};}
      const role=this.active(owner,saved.role_id);
      if(role.version!==saved.role_version||role.capability_epoch!==saved.role_epoch)throw new Error('task_collaboration_revoked');
      const model=this.conversations.get(role.conversation_id,owner).model;
      const conversation=this.conversations.create(owner,{workspace_id:saved.workspace_id,project_id:saved.project_id,title:`Team：${role.name}`,model});
      const now=timestamp();this.db.prepare('UPDATE ga_conversations SET archived_at=? WHERE id=?').run(now,conversation.conversation_id);
      const run=this.runs.enqueue(conversation.conversation_id,owner,{client_message_id:`native:${reservationId}`,content:[{type:'text',text:'原生Team成员运行；使用已保存角色和同一工作区，只在父任务权限内处理成员消息。'}]},{executionMode:'native'});
      this.db.prepare('INSERT INTO wb_native_child_runs VALUES(?,?,?,?,?,?,?,?,?)').run(String(run.run_id),reservationId,owner,saved.root_run_id,saved.task_id,saved.occurrence_id,saved.role_id,saved.child_session_ref,now);
      this.bindRun(owner,saved.role_id,String(run.run_id),'native_team');
      this.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(conversation.conversation_id,owner,saved.child_session_ref,now,now);
      return {run_id:String(run.run_id),conversation_id:conversation.conversation_id,session_ref:saved.child_session_ref};
    });
  }
  /** A new fenced root worker may classify lost native streams as unknown.
   * Never infer failure from a timeout or classify a still-authorized driver. */
  reconcileNativeInterruptedCalls(owner:string,rootRunId:string,expectedLease:unknown){
    return this.transaction(()=>{
      const current=assertExecutionLease(this.db,rootRunId,expectedLease);
      const parent=this.db.prepare(`SELECT b.kind FROM wb_run_bindings b JOIN ga_runs r ON r.id=b.run_id JOIN ga_conversations c ON c.id=r.conversation_id
        WHERE b.run_id=? AND b.owner_id=? AND c.owner_id=?`).get(rootRunId,owner,owner);
      if(parent?.kind!=='task')throw new Error('workbench_identity_forbidden');
      const ledger=this.options.modelBudgetPolicy?.ledger;if(!ledger)throw new Error('budget_service_unavailable');
      const attempts=this.db.prepare(`SELECT a.run_id,a.attempt_id,n.snapshot_json FROM wb_model_budget_attempts a
        JOIN wb_native_execution_runs n ON n.run_id=a.run_id WHERE n.owner_id=? AND n.root_run_id=? AND a.state='in_flight'`).all(owner,rootRunId);
      for(const row of attempts){const saved=JSON.parse(String(row.snapshot_json)) as NativeReservation;
        if(current.generation<=saved.execution_lease.generation)throw new Error('native_recovery_fence_live');}
      for(const row of attempts)ledger.markUnknown(owner,String(row.run_id),String(row.attempt_id),'stream_incomplete');
      return {marked_unknown:attempts.length};
    });
  }
  /** Resolve durable recovery metadata. This is not execution admission. */
  nativeChildSource(owner:string,input:Input){
    return this.transaction(()=>{
      const child=String(input.child_session_ref??'');if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(child))throw new Error('native_activation_invalid');
      const row=this.db.prepare(`SELECT n.run_id,n.snapshot_json,c.receipt_json FROM wb_native_execution_runs n
        LEFT JOIN wb_native_execution_closures c ON c.run_id=n.run_id WHERE n.owner_id=? AND n.child_session_ref=?
        AND NOT EXISTS (SELECT 1 FROM wb_native_child_activations next WHERE next.previous_run_id=n.run_id)`).get(owner,child) as Row|undefined;
      if(!row)throw new Error('workbench_identity_forbidden');
      const saved=JSON.parse(String(row.snapshot_json)) as NativeReservation;
      if(saved.parent_session_ref!==input.session_ref)throw new Error('workbench_identity_forbidden');
      const lease=assertExecutionLease(this.db,String(input.run_id),input.execution_lease);
      const budget=this.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(owner,String(input.run_id)) as Row|undefined;
      if(!budget)throw new Error('budget_binding_invalid');
      assertNativeSnapshot(this.db,owner,{...saved,root_run_id:String(input.run_id),execution_lease:lease,root_budget_scope_ids:JSON.parse(String(budget.scopes_json))});
      const role=this.active(owner,saved.role_id);if(role.version!==saved.role_version||role.capability_epoch!==saved.role_epoch)throw new Error('task_collaboration_revoked');
      if(!row.receipt_json)throw new Error('native_activation_source_pending');
      return {previous_run_id:String(row.run_id),role_ref:saved.role_id,proof:JSON.parse(String(row.receipt_json))};
    });
  }
  /** Prepare a new execution identity for the same durable native Session.
   * This does not deliver messages or start an SDK driver. */
  prepareNativeActivation(owner:string,input:Input){
    const keys=['run_id','session_ref','child_session_ref','previous_run_id','previous_log_sha256','previous_seq_exclusive','execution_lease'];
    if(!input||Object.keys(input).some(key=>!keys.includes(key))||keys.slice(0,4).some(key=>typeof input[key]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(String(input[key])))
      ||typeof input.previous_log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.previous_log_sha256)||!Number.isSafeInteger(input.previous_seq_exclusive)||Number(input.previous_seq_exclusive)<1)throw new Error('native_activation_invalid');
    return this.transaction(()=>{
      const previous=this.db.prepare(`SELECT n.*,r.conversation_id FROM wb_native_execution_runs n JOIN ga_runs r ON r.id=n.run_id
        WHERE n.run_id=? AND n.owner_id=? AND n.child_session_ref=?`).get(String(input.previous_run_id),owner,String(input.child_session_ref)) as Row|undefined;
      if(!previous)throw new Error('workbench_identity_forbidden');
      const saved=JSON.parse(String(previous.snapshot_json)) as NativeReservation;
      if(saved.parent_session_ref!==input.session_ref)throw new Error('workbench_identity_forbidden');
      const priorClosure=this.db.prepare('SELECT receipt_json FROM wb_native_execution_closures WHERE run_id=?').get(String(input.previous_run_id)) as Row|undefined;
      if(!priorClosure)throw new Error('native_activation_source_pending');
      const proof=JSON.parse(String(priorClosure.receipt_json));
      if(proof.log_sha256!==input.previous_log_sha256||proof.seq_exclusive!==input.previous_seq_exclusive)throw new Error('native_activation_source_changed');
      const lease=assertExecutionLease(this.db,String(input.run_id),input.execution_lease);
      const budget=this.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(owner,String(input.run_id)) as Row|undefined;
      if(!budget)throw new Error('budget_binding_invalid');
      const snapshot={...saved,root_run_id:String(input.run_id),execution_lease:lease,root_budget_scope_ids:JSON.parse(String(budget.scopes_json)),
        previous_run_id:String(input.previous_run_id),source_log_sha256:input.previous_log_sha256,source_seq_exclusive:input.previous_seq_exclusive};
      assertNativeSnapshot(this.db,owner,snapshot);
      const role=this.active(owner,saved.role_id);if(role.version!==saved.role_version||role.capability_epoch!==saved.role_epoch)throw new Error('task_collaboration_revoked');
      const digest=hash(JSON.stringify(snapshot));
      const existing=this.db.prepare('SELECT run_id,snapshot_json FROM wb_native_child_activations WHERE previous_run_id=?').get(String(input.previous_run_id)) as Row|undefined;
      if(existing){if(hash(String(existing.snapshot_json))!==digest)throw new Error('native_activation_source_changed');this.assertRunActive(String(existing.run_id));return {run_id:String(existing.run_id),conversation_id:String(previous.conversation_id),session_ref:saved.child_session_ref};}
      const policy=this.db.prepare('SELECT max_active FROM wb_task_collaboration_grants WHERE owner_id=? AND task_id=? AND version=?').get(owner,saved.task_id,saved.policy_version) as Row|undefined;
      if(!policy||!taskMemberCapacityAvailable(this.db,owner,saved.occurrence_id,Number(policy.max_active)))throw new Error('task_collaboration_exhausted');
      const activationId=`activation-${randomUUID()}`,now=timestamp();
      const run=this.runs.enqueue(String(previous.conversation_id),owner,{client_message_id:activationId,content:[{type:'text',text:'原生Team成员恢复；同一会话中的新执行身份，仅处理原生邮箱消息。'}]},{executionMode:'native'});
      this.db.prepare('INSERT INTO wb_native_child_activations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(String(run.run_id),activationId,saved.reservation_id,String(input.previous_run_id),owner,snapshot.root_run_id,saved.task_id,saved.occurrence_id,saved.role_id,saved.child_session_ref,JSON.stringify(snapshot),now);
      this.bindRun(owner,saved.role_id,String(run.run_id),'native_team');
      return {run_id:String(run.run_id),conversation_id:String(previous.conversation_id),session_ref:saved.child_session_ref};
    });
  }
  /** Trusted native host persistence readback, never model/user completion. */
  closeNativeChild(owner:string,runId:string,proof:Input){
    const keys=['protocol','session_ref','parent_session_ref','seq_exclusive','turn_end_seq','log_sha256','driver_nonresident','inbox_pending'];
    if(!proof||Array.isArray(proof)||Object.keys(proof).some(key=>!keys.includes(key))||proof.protocol!==1||proof.driver_nonresident!==true||proof.inbox_pending!==0
      ||typeof proof.session_ref!=='string'||typeof proof.parent_session_ref!=='string'||!Number.isSafeInteger(proof.seq_exclusive)||Number(proof.seq_exclusive)<1
      ||!Number.isSafeInteger(proof.turn_end_seq)||Number(proof.turn_end_seq)<0||Number(proof.turn_end_seq)>=Number(proof.seq_exclusive)
      ||typeof proof.log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.log_sha256))throw new Error('native_child_closure_invalid');
    return this.transaction(()=>{
      const native=this.db.prepare(`SELECT n.reservation_id,n.activation_id,n.child_session_ref,n.snapshot_json,r.conversation_id,r.reason_code FROM wb_native_execution_runs n
        JOIN ga_runs r ON r.id=n.run_id
        JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.owner_id=n.owner_id AND b.kind='native_team' WHERE n.run_id=? AND n.owner_id=?`).get(runId,owner) as Row|undefined;
      if(!native||native.child_session_ref!==proof.session_ref||JSON.parse(String(native.snapshot_json)).parent_session_ref!==proof.parent_session_ref)throw new Error('workbench_identity_forbidden');
      const receiptJson=JSON.stringify(Object.fromEntries(keys.map(key=>[key,proof[key]]))),digest=hash(receiptJson);
      const prior=this.db.prepare('SELECT receipt_sha256 FROM wb_native_execution_closures WHERE run_id=?').get(runId) as Row|undefined;
      if(prior){if(prior.receipt_sha256!==digest)throw new Error('native_child_closure_conflict');return {closed:true,run_id:runId,reservation_id:String(native.reservation_id)};}
      if(native.reason_code==='OUTCOME_UNKNOWN'||this.db.prepare("SELECT 1 FROM wb_model_budget_attempts WHERE run_id=? AND state IN ('in_flight','unknown') LIMIT 1").get(runId))throw new Error('native_child_closure_pending');
      const ledger=this.options.modelBudgetPolicy?.ledger;if(!ledger)throw new Error('budget_service_unavailable');
      const reserved=this.db.prepare("SELECT attempt_id FROM wb_model_budget_attempts WHERE run_id=? AND state='reserved'").all(runId);
      for(const row of reserved)ledger.releaseUndispatched(owner,runId,String(row.attempt_id));
      const now=timestamp();
      if(native.activation_id)this.db.prepare('INSERT INTO wb_native_activation_closures VALUES(?,?,?,?)').run(runId,digest,receiptJson,now);
      else this.db.prepare('INSERT INTO wb_native_child_closures VALUES(?,?,?,?,?)').run(String(native.reservation_id),runId,digest,receiptJson,now);
      // Parking is an execution observation, not business success or permission
      // to cold-resume. A new activation needs a new durable authorization.
      this.db.prepare("UPDATE ga_runs SET status='interrupted',reason_code='NATIVE_CHILD_QUIESCENT',version=version+1,updated_at=? WHERE id=?").run(now,runId);
      this.events.append(String(native.conversation_id),runId,'run.state',this.runs.get(runId,owner));
      return {closed:true,run_id:runId,reservation_id:String(native.reservation_id)};
    });
  }
  /** Continuations may not lose their frozen role or escape an occurrence budget. */
  inheritCheckpointRun(owner:string,originalRunId:string,newRunId:string):void {
    const context=this.contextForRun(originalRunId);
    if(context?.kind!=='task'){this.inheritChatRun(owner,originalRunId,newRunId);return;}
    this.transaction(()=>{
      this.assertBudgetService();
      if(!this.options.modelBudgetPolicy)throw new Error('budget_service_unavailable');
      this.runs.get(originalRunId,owner);this.runs.get(newRunId,owner);
      if(context.owner_id!==owner)throw new Error('run_agent_scope_mismatch');
      bindTaskContinuation(this.db,owner,originalRunId,newRunId);
      const row=this.db.prepare('SELECT epoch FROM wb_run_bindings WHERE run_id=? AND owner_id=?').get(originalRunId,owner) as Row;
      this.db.prepare('INSERT INTO wb_run_bindings VALUES(?,?,?,?,?,?,?)').run(newRunId,owner,context.agent_id,Number(row.epoch),'task',JSON.stringify({...context,run_id:newRunId}),timestamp());
      this.options.modelBudgetPolicy?.allocate(owner,newRunId);
      this.assertRunActive(newRunId);
      this.db.prepare('UPDATE wb_persistent_tasks SET projection_pending=1 WHERE task_id=(SELECT task_id FROM wb_task_run_occurrences WHERE run_id=?)').run(newRunId);
    });
  }
  inheritChatRun(owner: string, originalRunId: string, newRunId: string): void {
    this.transaction(() => {
      this.assertBudgetService();
      const original = this.runs.get(originalRunId, owner);
      const next = this.runs.get(newRunId, owner);
      const context = this.contextForRun(originalRunId);
      const agent = this.agentForConversation(owner, String(original.conversation_id));
      if (!context) {
        if (agent && agent.conversation_id !== original.conversation_id) throw new Error('task_continuation_unsupported');
        if (agent) this.bindRun(owner, agent.agent_id, newRunId, 'chat');
        return;
      }
      if (context.kind !== 'chat') throw new Error('task_continuation_unsupported');
      if (next.conversation_id !== original.conversation_id) throw new Error('run_agent_scope_mismatch');
      const row = this.db.prepare('SELECT * FROM wb_run_bindings WHERE run_id=?').get(originalRunId) as Row;
      this.db.prepare('INSERT INTO wb_run_bindings VALUES(?,?,?,?,?,?,?)').run(newRunId, owner,
        context.agent_id, Number(row.epoch), 'chat', JSON.stringify({...context, run_id: newRunId}), timestamp());
      this.options.modelBudgetPolicy?.inheritChatRun(owner,originalRunId,newRunId);
      this.assertRunActive(newRunId);
    });
  }
  private recalledMemory(owner: string, agent: Agent): Input[] {
    let remaining = 12_000 - 2; // Includes the serialized array delimiters and every metadata field.
    const result: Input[] = [];
    const seen = new Set<string>();
    for (const entry of this.listMemory(owner, agent.workspace_id, { agent_id: agent.agent_id }).items) {
      if (remaining <= 0 || result.length >= 30) break;
      const normalized = String(entry.content).trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const content = String(entry.content);
      const sources = entry.provenance as Array<{ kind: string; reference: string }>;
      const provenance = sources.slice(0, 3).map(source => ({ kind: source.kind, reference: source.reference.slice(0, 256) }));
      const candidate: Input = { ...entry, provenance, provenance_truncated: sources.length > 3 || sources.some(source => source.reference.length > 256),
        content: content.slice(0, 3000), truncated: content.length > 3000 };
      const allowance = remaining - (result.length ? 1 : 0);
      if (JSON.stringify(candidate).length > allowance) {
        candidate.truncated = true;
        let low = 0, high = Math.min(content.length, 3000);
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          candidate.content = content.slice(0, middle);
          if (JSON.stringify(candidate).length <= allowance) low = middle;
          else high = middle - 1;
        }
        candidate.content = content.slice(0, low);
        if (!low || JSON.stringify(candidate).length > allowance) continue;
      }
      const cost = JSON.stringify(candidate).length + (result.length ? 1 : 0);
      result.push(candidate); remaining -= cost;
    }
    return result;
  }
  contextForRun(runId: string): AgentRunContext | null {
    const row = this.db.prepare('SELECT * FROM wb_run_bindings WHERE run_id=?').get(runId) as Row | undefined;
    if (!row) return null;
    const agent = this.active(String(row.owner_id), String(row.agent_id));
    if (agent.capability_epoch !== Number(row.epoch)) throw new Error('agent_capability_revoked');
    const context = { ...JSON.parse(String(row.context_json)), run_id: runId } as AgentRunContext;
    if(row.kind==='native_team'){
      const saved=assertNativeRun(this.db,String(row.owner_id),runId);
      if(saved.role_id!==agent.agent_id||saved.role_epoch!==agent.capability_epoch)throw new Error('task_collaboration_revoked');
      if(saved.task_assignment)Object.assign(context,{task_assignment:saved.task_assignment});
    }
    if(row.kind==='internal_mailbox'){
      const msg=this.db.prepare('SELECT message_id,thread_id FROM wb_agent_messages WHERE run_id=? AND owner_id=?').get(runId,String(row.owner_id)) as Row|undefined;
      if(msg){currentTaskMailbox(this.db,String(row.owner_id),String(msg.thread_id));
        const assignment=taskAssignmentForMessage(this.db,String(row.owner_id),String(msg.message_id));
        if(assignment)Object.assign(context,{task_assignment:assignment});}
    }
    // Frozen instructions and valid snapshots survive continuation. Revoked/expired/corrected facts do not recur.
    context.memories = context.memories.filter(entry => {
      const current = this.db.prepare(`SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND project_id=? AND memory_id=?
        AND status='active' AND (scope='project' OR (scope='private' AND agent_id=?))`)
        .get(String(row.owner_id), agent.workspace_id, agent.project_id, String(entry.memory_id), agent.agent_id) as Row | undefined;
      return current && !memoryExpired(current) && Number(current.version) === Number(entry.version);
    });
    return context;
  }
  assertRunActive(runId: string): void {
    const context = this.contextForRun(runId);
    if (!context) return;
    this.assertBudgetService();
    this.options.modelBudgetPolicy?.allocation(context.owner_id,runId);
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_occurrences'").get()) {
      const task = this.db.prepare(`SELECT t.status,t.generation AS current_generation,o.generation
        FROM wb_task_run_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id WHERE o.run_id=?`).get(runId) as Row | undefined;
      if (task && (!['active', 'budget_exhausted'].includes(String(task.status)) || task.generation !== task.current_generation)) throw new Error('task_generation_revoked');
    }
    const run = this.runs.get(runId, context.owner_id);
    if (!['queued', 'starting', 'running', 'waiting_user', 'waiting_approval'].includes(String(run.status))) throw new Error('run_capability_revoked');
  }
  private assertBudgetService(): void {
    if (this.options.modelBudgetPolicy) { this.options.modelBudgetPolicy.assertCurrent(); return; }
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_model_budget_policy_registry'").get()
      && this.db.prepare('SELECT 1 FROM wb_model_budget_policy_registry WHERE singleton=1').get()) throw new Error('budget_service_unavailable');
  }
  reconcileBudgets() {
    const ledger=this.options.modelBudgetPolicy?.ledger;
    ledger?.reconcileDispatchedCalls();
    return ledger?.reconcileUndispatched() ?? {released:0};
  }
  private runIdentity(owner: string, workspace: string, runId: string): AgentRunContext {
    this.assertRunActive(runId);
    const context = this.contextForRun(runId);
    if (!context || context.owner_id !== owner || context.workspace_id !== workspace) throw new Error('invalid_message_identity');
    return context;
  }
  enqueueAgentMessage(owner: string, agentId: string, input: Input) {
    const value = text(input.text, 'invalid_message_text');
    const clientId = text(input.client_message_id, 'invalid_client_message_id', 128);
    return this.transaction(() => {
      const agent = this.active(owner, agentId);
      const result = this.runs.enqueue(agent.conversation_id, owner, { client_message_id: clientId, content: [{ type: 'text', text: value }] });
      this.bindRun(owner, agentId, String(result.run_id), 'chat'); return result;
    });
  }
  deletionPreview(owner: string, agentId: string) {
    const agent = this.getAgent(owner, agentId);
    const activeRuns = this.db.prepare(`SELECT r.id AS run_id,r.status FROM ga_runs r JOIN wb_run_bindings b ON b.run_id=r.id
      WHERE b.agent_id=? AND b.owner_id=? AND r.status IN ('queued','starting','running','waiting_user','waiting_approval','cancelling')`).all(agentId, owner);
    const tasks = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_persistent_tasks'").get()
      ? this.db.prepare("SELECT task_id,status FROM wb_persistent_tasks WHERE owner_id=? AND agent_id=? AND status!='archived'").all(owner, agentId) : [];
    return { agent_id: agentId, version: agent.version, active_runs: activeRuns, persistent_tasks: tasks,
      private_memory_count: Number((this.db.prepare("SELECT count(*) n FROM wb_memories WHERE owner_id=? AND agent_id=? AND scope='private' AND status='active'").get(owner, agentId) as Row).n),
      pending_message_count: Number((this.db.prepare("SELECT count(*) n FROM wb_agent_messages WHERE owner_id=? AND recipient_agent_id=? AND status IN ('pending','processing')").get(owner, agentId) as Row).n) };
  }
  beginDeletion(owner: string, agentId: string, expectedVersion: number) {
    return this.transaction(() => {
      const agent = this.getAgent(owner, agentId);
      if (agent.status === 'deleted' || agent.status === 'deleting') return agent;
      if (integer(expectedVersion) !== agent.version) throw new Error('version_conflict');
      const now = timestamp();
      this.db.prepare("UPDATE wb_agents SET status='deleting',capability_epoch=capability_epoch+1,version=version+1,updated_at=? WHERE owner_id=? AND agent_id=?")
        .run(now, owner, agentId);
      this.db.prepare("INSERT INTO wb_deletion_jobs VALUES(?,?,'pending',?,?) ON CONFLICT(agent_id) DO NOTHING").run(agentId, owner, now, now);
      return this.getAgent(owner, agentId);
    });
  }
  deleteAgent(owner: string, agentId: string, expectedVersion: number) {
    this.beginDeletion(owner, agentId, expectedVersion); this.resumeDeletions();
    return { agent_id: agentId, status: this.getAgent(owner, agentId).status };
  }
  resumeDeletions() {
    const jobs = this.db.prepare("SELECT * FROM wb_deletion_jobs WHERE status='pending'").all() as Row[];
    for (const job of jobs) this.transaction(() => {
      const now = timestamp(), agentId = String(job.agent_id), owner = String(job.owner_id);
      const bound = this.db.prepare(`SELECT r.id,r.conversation_id,r.status,r.version FROM ga_runs r JOIN wb_run_bindings b ON b.run_id=r.id
        WHERE b.agent_id=? AND b.owner_id=? AND r.status IN ('queued','starting','running','waiting_user','waiting_approval','cancelling')`).all(agentId, owner) as Row[];
      for (const run of bound) {
        this.commands.cancel(String(run.id), owner, { expected_run_version: Number(run.version), reason: 'agent_deleted' }, `agent-deletion:${agentId}`);
        this.db.prepare("UPDATE ga_runs SET reason_code=CASE WHEN reason_code='OUTCOME_UNKNOWN' THEN reason_code ELSE 'AGENT_DELETED' END WHERE id=?").run(String(run.id));
      }
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_persistent_tasks'").get()) {
        this.db.prepare("UPDATE wb_persistent_tasks SET status='paused',generation=generation+1,version=version+1,projection_pending=1,updated_at=? WHERE owner_id=? AND agent_id=? AND status IN ('active','budget_exhausted')").run(now, owner, agentId);
      }
      this.db.prepare('DELETE FROM wb_team_members WHERE agent_id=?').run(agentId);
      this.db.prepare("UPDATE wb_agent_messages SET status='recipient_deleted',updated_at=? WHERE owner_id=? AND recipient_agent_id=? AND status IN ('pending','processing')").run(now, owner, agentId);
      this.db.prepare("UPDATE wb_agent_messages SET status='sender_deleted',updated_at=? WHERE owner_id=? AND sender_agent_id=? AND status='pending'").run(now, owner, agentId);
      const privateMemories = this.db.prepare("SELECT memory_id FROM wb_memories WHERE owner_id=? AND agent_id=? AND scope='private' AND status='active'").all(owner, agentId) as Row[];
      this.db.prepare("UPDATE wb_memories SET status='deleted',version=version+1,updated_at=? WHERE owner_id=? AND agent_id=? AND scope='private' AND status='active'").run(now, owner, agentId);
      for (const memory of privateMemories) this.memoryLifecycle.record(this.db.prepare('SELECT * FROM wb_memories WHERE memory_id=?').get(String(memory.memory_id)) as Row);
      this.db.prepare("UPDATE wb_agents SET status='deleted',version=version+1,updated_at=? WHERE owner_id=? AND agent_id=? AND status='deleting'").run(now, owner, agentId);
      this.db.prepare("UPDATE wb_deletion_jobs SET status='completed',updated_at=? WHERE agent_id=?").run(now, agentId);
    });
    return { resumed: jobs.length };
  }
  private team(owner: string, teamId: string) {
    const row = this.db.prepare('SELECT * FROM wb_teams WHERE owner_id=? AND team_id=?').get(owner, teamId) as Row | undefined;
    if (!row) throw new Error('team_not_found');
    const members = this.db.prepare('SELECT agent_id FROM wb_team_members WHERE team_id=? ORDER BY position').all(teamId) as Row[];
    return { team_id: teamId, name: String(row.name), workspace_id: String(row.workspace_id), project_id: String(row.project_id),
      status: String(row.status), version: Number(row.version), created_at: String(row.created_at), updated_at: String(row.updated_at), member_ids: members.map(x => String(x.agent_id)) };
  }
  getTeam(owner: string, teamId: string) { return this.team(owner, teamId); }
  listTeams(owner: string) {
    const rows = this.db.prepare("SELECT team_id FROM wb_teams WHERE owner_id=? AND status='active' ORDER BY created_at,team_id").all(owner) as Row[];
    return { items: rows.map(row => this.team(owner, String(row.team_id))) };
  }
  private members(owner: string, input: unknown, workspace: string, project: string): string[] {
    if (!Array.isArray(input) || input.length > 20 || input.some(x => typeof x !== 'string')) throw new Error('invalid_team_members');
    const members = [...new Set(input as string[])];
    for (const memberId of members) {
      const member = this.active(owner, memberId);
      if (member.workspace_id !== workspace || member.project_id !== project) throw new Error('team_workspace_mismatch');
    }
    return members;
  }
  createTeam(owner: string, input: Input) {
    return this.transaction(() => {
      const name = text(input.name, 'invalid_team_name', 100);
      const first = Array.isArray(input.member_ids) && input.member_ids.length ? this.active(owner, String(input.member_ids[0])) : null;
      const workspace = this.workspace(input.workspace_id ?? first?.workspace_id);
      const project = String(input.project_id ?? first?.project_id ?? this.projects.ensureDefault(owner).project_id);
      this.projects.assertOwned(project, owner);
      const members = this.members(owner, input.member_ids ?? [], workspace, project);
      const teamId = id('team'), now = timestamp();
      this.db.prepare('INSERT INTO wb_teams VALUES(?,?,?,?,?,?,?,?,?)').run(teamId, owner, name, workspace, project, 'active', 1, now, now);
      members.forEach((member, index) => this.db.prepare('INSERT INTO wb_team_members VALUES(?,?,?)').run(teamId, member, index));
      return this.team(owner, teamId);
    });
  }
  updateTeam(owner: string, teamId: string, input: Input) {
    return this.transaction(() => {
      const current = this.team(owner, teamId);
      if (current.status !== 'active') throw new Error('team_not_found');
      if (integer(input.expected_version) !== current.version) throw new Error('version_conflict');
      const members = this.members(owner, input.member_ids ?? current.member_ids, current.workspace_id, current.project_id);
      const name = input.name === undefined ? current.name : text(input.name, 'invalid_team_name', 100);
      this.db.prepare('UPDATE wb_teams SET name=?,version=version+1,updated_at=? WHERE team_id=?').run(name, timestamp(), teamId);
      this.db.prepare('DELETE FROM wb_team_members WHERE team_id=?').run(teamId);
      members.forEach((member, index) => this.db.prepare('INSERT INTO wb_team_members VALUES(?,?,?)').run(teamId, member, index));
      return this.team(owner, teamId);
    });
  }
  deleteTeam(owner: string, teamId: string, expectedVersion: number) {
    return this.transaction(() => {
      const current = this.team(owner, teamId);
      if (integer(expectedVersion) !== current.version) throw new Error('version_conflict');
      this.db.prepare("UPDATE wb_teams SET status='deleted',version=version+1,updated_at=? WHERE team_id=?").run(timestamp(), teamId);
      this.db.prepare('DELETE FROM wb_team_members WHERE team_id=?').run(teamId);
      return { team_id: teamId, status: 'deleted' };
    });
  }
  getWorkspace(owner: string, workspaceId: string) {
    const workspace = this.workspace(workspaceId);
    return { workspace_id: workspace, agents: this.listAgents(owner).items.filter(x => x.workspace_id === workspace), teams: this.listTeams(owner).items.filter(x => x.workspace_id === workspace) };
  }
  private memoryValue(row: Row): Input {
    return serializeMemory(row);
  }
  private memoryRows(owner: string, workspaceId: string, query: Input = {}, runId?: string, includeSuperseded = false): Row[] {
    const workspace = this.workspace(workspaceId);
    const context = runId ? this.runIdentity(owner, workspace, runId) : null;
    const agentId = context?.agent_id ?? (query.agent_id === undefined ? undefined : String(query.agent_id));
    const agent = agentId ? this.active(owner, agentId) : null;
    if (agent && agent.workspace_id !== workspace) throw new Error('agent_workspace_mismatch');
    const project = context?.project_id ?? (query.project_id === undefined ? agent?.project_id : String(query.project_id));
    if (project) this.projects.assertOwned(project, owner);
    if (!context && agent && project !== agent.project_id) throw new Error('memory_scope_forbidden');
    if (query.scope !== undefined && query.scope !== 'project' && query.scope !== 'private') throw new Error('invalid_memory_scope');
    if (query.include_expired !== undefined && ![true, false, 'true', 'false'].includes(query.include_expired as boolean | string)) throw new Error('invalid_memory_include_expired');
    const includeExpired = query.include_expired === true || query.include_expired === 'true';
    const clauses = ['owner_id=?', 'workspace_id=?', includeSuperseded ? "status IN ('active','superseded')" : "status='active'", "(scope='project' OR (scope='private' AND agent_id=?))"];
    const params: Array<string> = [owner, workspace, agentId ?? ''];
    if (project) { clauses.push('project_id=?'); params.push(project); }
    if (query.scope !== undefined) { clauses.push('scope=?'); params.push(String(query.scope)); }
    if (context || !includeExpired) { clauses.push('(expires_at IS NULL OR expires_at>?)'); params.push(timestamp()); }
    return this.db.prepare(`SELECT * FROM wb_memories WHERE ${clauses.join(' AND ')} ORDER BY created_at,memory_id`).all(...params) as Row[];
  }
  listMemory(owner: string, workspaceId: string, query: Input = {}, runId?: string) {
    const rows = this.memoryRows(owner, workspaceId, query, runId);
    // Management may inspect expired records; those never enter a semantic adapter's candidate set.
    const adapter = rows.some(row => memoryExpired(row)) ? undefined : this.options.memoryRankAdapter;
    return { items: rankMemory(rows.map(row => this.memoryValue(row)), this.memoryQuery(query), adapter).slice(0, 200) };
  }
  private memoryQuery(query: Input): string {
    if (query.q !== undefined && (typeof query.q !== 'string' || query.q.length > 2000)) throw new Error('invalid_memory_query');
    return String(query.q ?? '').trim();
  }
  exportMemory(owner: string, workspaceId: string, query: Input = {}) {
    const rows = this.memoryRows(owner, workspaceId, query, undefined, true);
    return { schema_version: 1, workspace_id: this.workspace(workspaceId), exported_at: timestamp(),
      items: rankMemory(rows.map(row => this.memoryValue(row)), this.memoryQuery(query))
        .map(entry => ({ ...entry, history: this.memoryLifecycle.history(owner, String(entry.memory_id)) })) };
  }
  saveMemory(owner: string, workspaceId: string, input: Input, runId?: string) {
    return this.transaction(() => {
      const workspace = this.workspace(workspaceId);
      const context = runId ? this.runIdentity(owner, workspace, runId) : null;
      if (input.scope !== 'project' && input.scope !== 'private') throw new Error('invalid_memory_scope');
      const scope = input.scope;
      const agentId = scope === 'private' ? context?.agent_id ?? text(input.agent_id, 'invalid_memory_agent', 128) : null;
      if (context && input.agent_id !== undefined && input.agent_id !== context.agent_id) throw new Error('memory_scope_forbidden');
      const agent = agentId ? this.active(owner, agentId) : null;
      if (agent && agent.workspace_id !== workspace) throw new Error('agent_workspace_mismatch');
      const project = String(context?.project_id ?? input.project_id ?? agent?.project_id ?? this.projects.ensureDefault(owner).project_id);
      if (context && input.project_id !== undefined && input.project_id !== context.project_id) throw new Error('memory_scope_forbidden');
      this.projects.assertOwned(project, owner);
      if (agent && agent.project_id !== project) throw new Error('memory_scope_forbidden');
      const content = text(input.content, 'invalid_memory_content');
      if (input.verified !== undefined && typeof input.verified !== 'boolean') throw new Error('invalid_memory_verified');
      const now = timestamp(), memoryId = input.memory_id === undefined ? id('memory') : String(input.memory_id);
      const old = input.memory_id === undefined ? undefined : this.db.prepare("SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND memory_id=? AND status='active'").get(owner, workspace, memoryId) as Row | undefined;
      if (input.memory_id !== undefined && !old) throw new Error('memory_not_found');
      const metadata = memoryMetadata(input, old);
      if (metadata.supersedes === memoryId) throw new Error('invalid_memory_supersedes');
      // Supersession is established when creating a new record, never rewritten as an edit side effect.
      if (old && input.supersedes !== undefined && metadata.supersedes !== old.supersedes) throw new Error('invalid_memory_supersedes');
      let replaced: Row | undefined;
      if (!old && metadata.supersedes !== null) {
        replaced = this.db.prepare("SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND memory_id=? AND status='active'").get(owner, workspace, String(metadata.supersedes)) as Row | undefined;
        if (!replaced) throw new Error('memory_not_found');
        if (replaced.project_id !== project || replaced.scope !== scope || replaced.agent_id !== agentId) throw new Error('memory_scope_forbidden');
        if (context && Boolean(replaced.verified)) throw new Error('memory_verification_required');
      }
      const verified = !context && input.verified === true ? 1 : 0;
      const verifiedAt = verified ? now : null;
      if (input.memory_id !== undefined) {
        if (!old) throw new Error('memory_not_found');
        if (old.scope !== scope || old.agent_id !== agentId || old.project_id !== project) throw new Error('memory_scope_forbidden');
        if (integer(input.expected_version) !== Number(old.version)) throw new Error('version_conflict');
        if (context && Boolean(old.verified)) throw new Error('memory_verification_required');
        this.db.prepare('UPDATE wb_memories SET content=?,verified=?,provenance_json=?,source_revision=?,expires_at=?,verified_at=?,version=version+1,updated_at=? WHERE memory_id=? AND owner_id=? AND version=?')
          .run(content, verified, metadata.provenance_json, metadata.source_revision, metadata.expires_at, verifiedAt, now, memoryId, owner, Number(old.version));
      } else {
        const columns = 'memory_id,owner_id,workspace_id,project_id,scope,agent_id,content,verified,version,status,created_at,updated_at,provenance_json,source_revision,expires_at,supersedes,verified_at';
        const legacyColumn = this.memoryLifecycle.legacyActive ? ',active' : '';
        const values: Array<string | number | null> = [memoryId, owner, workspace, project, scope, agentId, content, verified, 1, 'active', now, now,
          metadata.provenance_json, metadata.source_revision as string | null, metadata.expires_at as string | null, metadata.supersedes as string | null, verifiedAt];
        if (this.memoryLifecycle.legacyActive) values.push(1);
        this.db.prepare(`INSERT INTO wb_memories(${columns}${legacyColumn}) VALUES(${values.map(() => '?').join(',')})`).run(...values);
      }
      if (replaced) {
        this.db.prepare("UPDATE wb_memories SET status='superseded',version=version+1,updated_at=? WHERE memory_id=? AND owner_id=? AND version=?")
          .run(now, String(replaced.memory_id), owner, Number(replaced.version));
        this.memoryLifecycle.record(this.db.prepare('SELECT * FROM wb_memories WHERE memory_id=?').get(String(replaced.memory_id)) as Row);
      }
      const saved = this.db.prepare('SELECT * FROM wb_memories WHERE memory_id=?').get(memoryId) as Row;
      this.memoryLifecycle.record(saved);
      return this.memoryValue(saved);
    });
  }
  deleteMemory(owner: string, workspaceId: string, memoryId: string, expectedVersion: number, runId?: string) {
    const workspace = this.workspace(workspaceId);
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND memory_id=? AND status='active'").get(owner, workspace, memoryId) as Row | undefined;
      if (!row) throw new Error('memory_not_found');
      const context = runId ? this.runIdentity(owner, workspace, runId) : null;
      if (context && (row.project_id !== context.project_id || (row.scope === 'private' && row.agent_id !== context.agent_id))) throw new Error('memory_scope_forbidden');
      if (context && Boolean(row.verified)) throw new Error('memory_verification_required');
      if (integer(expectedVersion) !== Number(row.version)) throw new Error('version_conflict');
      this.db.prepare("UPDATE wb_memories SET status='deleted',version=version+1,updated_at=? WHERE memory_id=?").run(timestamp(), memoryId);
      this.memoryLifecycle.record(this.db.prepare('SELECT * FROM wb_memories WHERE memory_id=?').get(memoryId) as Row);
      return { memory_id: memoryId, status: 'deleted' };
    });
  }
  private messageValue(row: Row): Input {
    const result: Input = { ...row, auto_reply: Boolean(row.auto_reply) }; delete result.owner_id; delete result.client_message_id;
    return result;
  }
  listMessages(owner: string, workspaceId: string, runId?: string, occurrenceId?: string) {
    const workspace = this.workspace(workspaceId);
    const context = runId ? this.runIdentity(owner, workspace, runId) : null;
    if (occurrenceId !== undefined) {
      if(context || typeof occurrenceId!=='string' || !occurrenceId || occurrenceId.length>128)throw new Error('invalid_workbench_request');
      const occurrence=this.db.prepare(`SELECT 1 FROM wb_task_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id
        JOIN wb_agents a ON a.agent_id=t.agent_id WHERE o.occurrence_id=? AND t.owner_id=? AND a.workspace_id=?`).get(occurrenceId,owner,workspace);
      if(!occurrence)throw new Error('task_not_found');
      const rows=this.db.prepare(`SELECT m.* FROM wb_agent_messages m JOIN wb_mailbox_task_roots r ON r.thread_id=m.thread_id AND r.owner_id=m.owner_id
        WHERE m.owner_id=? AND m.workspace_id=? AND r.occurrence_id=? ORDER BY m.created_at,m.message_id LIMIT 200`).all(owner,workspace,occurrenceId) as Row[];
      return {items:rows.map(row=>this.messageValue(row))};
    }
    const rows = context
      ? this.db.prepare('SELECT * FROM wb_agent_messages WHERE owner_id=? AND workspace_id=? AND project_id=? AND (sender_agent_id=? OR recipient_agent_id=?) ORDER BY created_at,message_id LIMIT 200').all(owner, workspace, context.project_id, context.agent_id, context.agent_id) as Row[]
      : this.db.prepare('SELECT * FROM wb_agent_messages WHERE owner_id=? AND workspace_id=? ORDER BY created_at,message_id LIMIT 200').all(owner, workspace) as Row[];
    return { items: rows.map(row => this.messageValue(row)) };
  }
  sendMessage(owner: string, workspaceId: string, input: Input, runId?: string) {
    return this.transaction(() => {
      const workspace = this.workspace(workspaceId);
      const context = runId ? this.runIdentity(owner, workspace, runId) : null;
      if (!context && input.initiator !== undefined && input.initiator !== 'user') throw new Error('invalid_message_identity');
      const senderId = context?.agent_id ?? text(input.sender_agent_id, 'invalid_message_identity', 128);
      if (context && input.sender_agent_id !== undefined && input.sender_agent_id !== senderId) throw new Error('invalid_message_identity');
      const sender = this.active(owner, senderId), recipient = this.active(owner, text(input.recipient_agent_id, 'invalid_message_recipient', 128));
      if (sender.workspace_id !== workspace || recipient.workspace_id !== workspace || sender.project_id !== recipient.project_id) throw new Error('message_scope_forbidden');
      const value = text(input.text, 'invalid_message_text'), clientId = text(input.client_message_id, 'invalid_client_message_id', 128);
      const duplicate = this.db.prepare('SELECT * FROM wb_agent_messages WHERE owner_id=? AND sender_agent_id=? AND client_message_id=?').get(owner, senderId, clientId) as Row | undefined;
      if (duplicate) {
        if (duplicate.text !== value || duplicate.recipient_agent_id !== recipient.agent_id) throw new Error('idempotency_conflict');
        const taskRoot=this.db.prepare('SELECT source_run_id FROM wb_mailbox_task_roots WHERE thread_id=? AND owner_id=?').get(String(duplicate.thread_id),owner) as Row|undefined;
        if(taskRoot?.source_run_id!==input.task_run_id)throw new Error('idempotency_conflict');
        return this.messageValue(duplicate);
      }
      if (input.auto_reply !== undefined && typeof input.auto_reply !== 'boolean') throw new Error('invalid_mailbox_rule');
      // Only an owner may authorize new automatic processing rules; agent messages never grant more model turns.
      if (context && (input.auto_reply || input.thread_id === undefined)) {
        if (input.auto_reply) throw new Error('mailbox_rule_forbidden');
      }
      const autoReply = !context && input.auto_reply === true;
      if(input.task_run_id!==undefined&&(context||!autoReply||typeof input.task_run_id!=='string'))throw new Error('task_mailbox_binding_invalid');
      const maxRuns = input.max_replies === undefined ? 2 : integer(input.max_replies);
      if (maxRuns < 1 || maxRuns > 4) throw new Error('invalid_mailbox_budget');
      const pending = this.db.prepare("SELECT count(*) n FROM wb_agent_messages WHERE owner_id=? AND status IN ('pending','processing')").get(owner) as Row;
      if (Number(pending.n) >= 100) throw new Error('mailbox_queue_full');
      const messageId = id('message'), threadId = id('thread'), now = timestamp();
      this.db.prepare('INSERT INTO wb_message_threads VALUES(?,?,?,?,?,0,?)').run(threadId, owner, workspace, sender.project_id, maxRuns, now);
      if(input.task_run_id!==undefined)bindTaskMailbox(this.db,owner,threadId,String(input.task_run_id),senderId);
      this.db.prepare('INSERT INTO wb_agent_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(messageId, owner, workspace, sender.project_id, senderId, recipient.agent_id, threadId, messageId, null, value,
          context ? 'agent' : 'user', 'pending', autoReply ? 1 : 0, clientId, null, now, now);
      return this.messageValue(this.db.prepare('SELECT * FROM wb_agent_messages WHERE message_id=?').get(messageId) as Row);
    });
  }
  processMailbox() {
    let queued = 0, completed = 0;
    const processing = this.db.prepare("SELECT * FROM wb_agent_messages WHERE status='processing' ORDER BY created_at LIMIT 50").all() as Row[];
    for (const msg of processing) this.transaction(() => {
      const current = this.db.prepare('SELECT status FROM wb_agent_messages WHERE message_id=?').get(String(msg.message_id)) as Row;
      if (current.status !== 'processing') return;
      const run = this.runs.get(String(msg.run_id), String(msg.owner_id));
      try{currentTaskMailbox(this.db,String(msg.owner_id),String(msg.thread_id));taskAssignmentForMessage(this.db,String(msg.owner_id),String(msg.message_id));}catch{
        if(['queued','starting','running','waiting_user','waiting_approval'].includes(String(run.status)))this.commands.cancel(String(msg.run_id),String(msg.owner_id),
          {expected_run_version:Number(run.version),reason:'task_mailbox_revoked'},`task-mailbox-cancel:${msg.message_id}`);
        this.db.prepare("UPDATE wb_agent_messages SET status='task_revoked',updated_at=? WHERE message_id=? AND status='processing'").run(timestamp(),String(msg.message_id));completed++;return;
      }
      if (!['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'].includes(String(run.status))) return;
      if (run.error_code === 'OUTCOME_UNKNOWN') {
        this.db.prepare("UPDATE wb_agent_messages SET status='outcome_unknown',updated_at=? WHERE message_id=? AND status='processing'").run(timestamp(), String(msg.message_id));
        completed++; return;
      }
      try { this.contextForRun(String(msg.run_id)); } catch {
        this.db.prepare("UPDATE wb_agent_messages SET status='recipient_deleted',updated_at=? WHERE message_id=? AND status='processing'").run(timestamp(), String(msg.message_id)); return;
      }
      try { this.active(String(msg.owner_id), String(msg.sender_agent_id)); } catch {
        this.db.prepare("UPDATE wb_agent_messages SET status='sender_deleted',updated_at=? WHERE message_id=? AND status='processing'").run(timestamp(), String(msg.message_id)); return;
      }
      const now = timestamp();
      const assistant = this.db.prepare("SELECT id FROM ga_messages WHERE run_id=? AND role='assistant' AND status='complete' ORDER BY created_at DESC LIMIT 1").get(String(msg.run_id)) as Row | undefined;
      const ok = ['succeeded', 'partial'].includes(String(run.status)) && assistant;
      this.db.prepare("UPDATE wb_agent_messages SET status=?,updated_at=? WHERE message_id=? AND status='processing'").run(ok ? 'completed' : 'failed', now, String(msg.message_id));
      if (ok) {
        const response = this.runs.message(String(assistant.id));
        const result = response.blocks.filter(block => block.kind === 'text').map(block => block.text ?? '').join('\n').trim();
        if (result) {
          const thread = this.db.prepare('SELECT * FROM wb_message_threads WHERE thread_id=?').get(String(msg.thread_id)) as Row;
          const canContinue = Number(thread.used_runs) < Number(thread.max_runs);
          this.db.prepare('INSERT INTO wb_agent_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(id('message'), String(msg.owner_id), String(msg.workspace_id), String(msg.project_id), String(msg.recipient_agent_id),
              String(msg.sender_agent_id), String(msg.thread_id), String(msg.root_causation_id), String(msg.message_id), result, 'agent',
              canContinue ? 'pending' : 'delivered', canContinue ? 1 : 0, `reply:${msg.message_id}`, null, now, now);
        }
      }
      completed++;
    });
    const pending = this.db.prepare("SELECT * FROM wb_agent_messages WHERE status='pending' AND auto_reply=1 ORDER BY created_at,message_id LIMIT 10").all() as Row[];
    for (const msg of pending) {
      try { this.transaction(() => {
      const current = this.db.prepare('SELECT status FROM wb_agent_messages WHERE message_id=?').get(String(msg.message_id)) as Row;
      if (current.status !== 'pending') return;
      const owner = String(msg.owner_id), recipientId = String(msg.recipient_agent_id), now = timestamp();
      let taskRoot,assignment;
      try{taskRoot=currentTaskMailbox(this.db,owner,String(msg.thread_id));assignment=taskAssignmentForMessage(this.db,owner,String(msg.message_id),true);}catch{
        this.db.prepare("UPDATE wb_agent_messages SET status='task_revoked',updated_at=? WHERE message_id=?").run(now,String(msg.message_id));return;
      }
      if(taskRoot&&!taskMemberCapacityAvailable(this.db,owner,taskRoot.occurrence_id,automaticDelegationLimit(this.db,owner,String(msg.message_id))))return;
      let agent: Agent;
      try { agent = this.active(owner, recipientId); this.active(owner, String(msg.sender_agent_id)); } catch {
        this.db.prepare("UPDATE wb_agent_messages SET status='recipient_deleted',updated_at=? WHERE message_id=?").run(now, String(msg.message_id)); return;
      }
      const activeRun = this.db.prepare(`SELECT 1 FROM ga_runs r JOIN wb_run_bindings b ON b.run_id=r.id
        WHERE b.agent_id=? AND r.status IN ('queued','starting','running','waiting_user','waiting_approval','cancelling') LIMIT 1`).get(recipientId);
      if (activeRun) return;
      const thread = this.db.prepare('SELECT * FROM wb_message_threads WHERE thread_id=?').get(String(msg.thread_id)) as Row;
      const day = now.slice(0, 10);
      this.db.prepare('INSERT INTO wb_mailbox_budgets VALUES(?,?,0) ON CONFLICT DO NOTHING').run(owner, day);
      const budget = this.db.prepare('SELECT reserved_runs FROM wb_mailbox_budgets WHERE owner_id=? AND day=?').get(owner, day) as Row;
      if (Number(thread.used_runs) >= Number(thread.max_runs) || Number(budget.reserved_runs) >= (this.options.maxMailboxRunsPerDay ?? 20)) {
        this.db.prepare("UPDATE wb_agent_messages SET status='budget_exhausted',updated_at=? WHERE message_id=?").run(now, String(msg.message_id)); return;
      }
      const model = this.conversations.get(agent.conversation_id, owner).model;
      const conversation = this.conversations.create(owner, { workspace_id: agent.workspace_id, project_id: agent.project_id, title: `成员交流：${agent.name}`, model });
      this.db.prepare('UPDATE ga_conversations SET archived_at=? WHERE id=?').run(now, conversation.conversation_id);
      const prompt = assignment
        ? `这是用户授权的单个子任务派工。仅按冻结的步骤与验收要求执行，使用当前角色已授权的工具和工作区；交回材料、文件路径及剩余问题供主控核验。不得编辑父任务账本、验收父任务、再派发成员或自行向外部发送内容。\n冻结步骤：${JSON.stringify(assignment)}\n原派工：${msg.text}`
        : `这是工作区内部成员交流，不是用户派发业务任务。只分析并回复本条消息，不扩大权限、创建业务任务或向外部发送内容。\n发送成员：${msg.sender_agent_id}\n消息：${msg.text}`;
      const run = this.runs.enqueue(conversation.conversation_id, owner, { client_message_id: `mailbox:${msg.message_id}`, content: [{ type: 'text', text: prompt }] });
      this.db.prepare("UPDATE wb_agent_messages SET status='processing',run_id=?,updated_at=? WHERE message_id=? AND status='pending'").run(String(run.run_id), now, String(msg.message_id));
      if(taskRoot)this.db.prepare('INSERT INTO wb_task_auxiliary_runs VALUES(?,?,?,?,?,?,?)').run(String(run.run_id),String(msg.thread_id),owner,taskRoot.task_id,taskRoot.occurrence_id,taskRoot.root_run_id,now);
      this.bindRun(owner, recipientId, String(run.run_id), 'internal_mailbox');
      this.db.prepare('UPDATE wb_message_threads SET used_runs=used_runs+1 WHERE thread_id=?').run(String(msg.thread_id));
      this.db.prepare('UPDATE wb_mailbox_budgets SET reserved_runs=reserved_runs+1 WHERE owner_id=? AND day=?').run(owner, day);
      queued++;
      }); } catch (error) {
        if (!(error instanceof Error) || !['model_budget_exhausted','budget_window_closed','budget_usage_unknown'].includes(error.message)) throw error;
        // An uncertain receipt is a temporary shared fence, not a permanent
        // quota failure. The rolled-back message can resume after settlement.
        if(error.message==='budget_usage_unknown')continue;
        this.db.prepare("UPDATE wb_agent_messages SET status='budget_exhausted',updated_at=? WHERE message_id=? AND status='pending'")
          .run(timestamp(),String(msg.message_id));
      }
    }
    return { queued, completed };
  }
  private filePath(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 400 || isAbsolute(value) || /[\\:\x00-\x1f]/.test(value)) throw new Error('invalid_file_path');
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[. ]$/.test(part) || /[<>"|?*]/.test(part)
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('invalid_file_path');
    return parts.join('/');
  }
  projectRoot(owner: string, workspaceId: string, projectId: string): string {
    const workspace = this.workspace(workspaceId); this.projects.assertOwned(projectId, owner);
    const root = resolve(this.options.root), dir = join(root, hash(`${owner}\0${workspace}\0${projectId}`));
    noSymlinkAncestors(root);
    if (realpathSync(root) !== this.canonicalRoot) throw new Error('workspace_path_escape');
    if (!existsSync(dir)) mkdirSync(dir);
    if (lstatSync(dir).isSymbolicLink()) throw new Error('workspace_path_escape');
    const canonicalRoot = realpathSync(root), canonicalDir = realpathSync(dir);
    if (relative(canonicalRoot, canonicalDir).startsWith('..') || isAbsolute(relative(canonicalRoot, canonicalDir))) throw new Error('workspace_path_escape');
    return canonicalDir;
  }
  private safeLogicalPath(root: string, path: string, create: boolean): string {
    const result = resolve(root, ...path.split('/'));
    const rel = relative(root, result);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('workspace_path_escape');
    let current = root;
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      if (existsSync(current)) {
        if (lstatSync(current).isSymbolicLink()) throw new Error('workspace_path_escape');
        const canonical = relative(root, realpathSync(current));
        if (canonical === '..' || canonical.startsWith(`..${sep}`) || isAbsolute(canonical)) throw new Error('workspace_path_escape');
      } else if (create && index < parts.length - 1) mkdirSync(current);
    }
    return result;
  }
  private fileValue(row: Row): Input { return { path: row.path, version: Number(row.version), sha256: row.sha256, size: Number(row.size), updated_at: row.updated_at }; }
  listFiles(owner: string, workspaceId: string, projectId: string, runId?: string) {
    const context = runId ? this.runIdentity(owner, workspaceId, runId) : null;
    if (context && context.project_id !== projectId) throw new Error('file_scope_forbidden');
    this.projectRoot(owner, workspaceId, projectId);
    const rows = this.db.prepare('SELECT * FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? ORDER BY path LIMIT 200').all(owner, workspaceId, projectId) as Row[];
    return { items: rows.map(row => this.fileValue(row)) };
  }
  readFile(owner: string, workspaceId: string, projectId: string, filePath: string, runId?: string) {
    const context = runId ? this.runIdentity(owner, workspaceId, runId) : null;
    if (context && context.project_id !== projectId) throw new Error('file_scope_forbidden');
    const path = this.filePath(filePath), root = this.projectRoot(owner, workspaceId, projectId);
    this.safeLogicalPath(root, path, false);
    const row = this.db.prepare('SELECT * FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=?').get(owner, workspaceId, projectId, path) as Row | undefined;
    if (!row) throw new Error('file_not_found');
    const blob = this.safeLogicalPath(root, `blobs/${String(row.blob_name)}`, false);
    const content = readFileSync(blob, 'utf8');
    if (hash(content) !== row.sha256) throw new Error('file_integrity_failed');
    return { ...this.fileValue(row), content };
  }
  /** Internal pinned-output read. A later logical overwrite cannot change the
   * selected immutable bytes; current owner/run permissions still apply. */
  readFileVersion(owner:string,workspaceId:string,projectId:string,filePath:string,version:number,runId?:string) {
    if(!Number.isSafeInteger(version)||version<1)throw new Error('invalid_file_version');
    const context=runId?this.runIdentity(owner,workspaceId,runId):null;
    if(context&&context.project_id!==projectId)throw new Error('file_scope_forbidden');
    const path=this.filePath(filePath),root=this.projectRoot(owner,workspaceId,projectId);
    this.safeLogicalPath(root,path,false);
    const row=this.db.prepare('SELECT * FROM wb_file_versions WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=? AND version=?')
      .get(owner,workspaceId,projectId,path,version) as Row|undefined;
    if(!row)throw new Error('file_not_found');
    const blob=this.safeLogicalPath(root,`blobs/${String(row.blob_name)}`,false),content=readFileSync(blob,'utf8');
    if(hash(content)!==row.sha256||Buffer.byteLength(content)!==Number(row.size))throw new Error('file_integrity_failed');
    return {path:String(row.path),version:Number(row.version),sha256:String(row.sha256),size:Number(row.size),created_at:String(row.created_at),content};
  }
  writeFile(owner: string, workspaceId: string, input: Input, runId?: string) {
    const workspace = this.workspace(workspaceId);
    const context = runId ? this.runIdentity(owner, workspace, runId) : null;
    const project = text(input.project_id, 'invalid_project_id', 128);
    if (context && context.project_id !== project) throw new Error('file_scope_forbidden');
    const path = this.filePath(input.path);
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content) > 1_048_576) throw new Error('invalid_file_content');
    const content = input.content, expected = integer(input.expected_version), root = this.projectRoot(owner, workspace, project);
    // Immutable blobs + database CAS make a committed version authoritative even across process crashes.
    return this.transaction(() => {
      this.safeLogicalPath(root, path, true);
      const old = this.db.prepare('SELECT version FROM wb_files WHERE owner_id=? AND workspace_id=? AND project_id=? AND path=?').get(owner, workspace, project, path) as Row | undefined;
      if (Number(old?.version ?? 0) !== expected) throw new Error('version_conflict');
      const digest = hash(content), version = expected + 1, now = timestamp(), blobName = `${randomUUID()}.txt`;
      const blob = this.safeLogicalPath(root, `blobs/${blobName}`, true), staging = `${blob}.pending`;
      try { writeFileSync(staging, content, { flag: 'wx', mode: 0o600 }); renameSync(staging, blob); }
      finally { if (existsSync(staging)) rmSync(staging); }
      this.db.prepare(`INSERT INTO wb_files VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,workspace_id,project_id,path)
        DO UPDATE SET version=excluded.version,sha256=excluded.sha256,size=excluded.size,blob_name=excluded.blob_name,updated_at=excluded.updated_at`)
        .run(owner, workspace, project, path, version, digest, Buffer.byteLength(content), blobName, now);
      this.db.prepare('INSERT INTO wb_file_versions VALUES(?,?,?,?,?,?,?,?,?)').run(owner, workspace, project, path, version, digest, Buffer.byteLength(content), blobName, now);
      if(runId)this.db.prepare('INSERT INTO wb_file_write_runs VALUES(?,?,?,?,?,?,?,?)')
        .run(runId,owner,workspace,project,path,version,digest,Buffer.byteLength(content));
      return { path, version, sha256: digest, size: Buffer.byteLength(content), updated_at: now };
    });
  }
}
