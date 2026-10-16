import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {validateNativeIdleObservation} from '../harness/native-idle-observation.ts';

type Scope=Readonly<{owner_id:string;project_id:string;workspace_id:string;agent_id:string}>;
type Row=Record<string,unknown>;
type NativeReader={nativeIdleObservationReadiness(signal?:AbortSignal):Promise<unknown>;observeNativeIdle(id:string,signal?:AbortSignal):Promise<unknown>};
type WorkspaceReader={projectWorkspaceReady(owner:string,workspace:string,project:string):boolean};
const scopeKeys=['agent_id','owner_id','project_id','workspace_id'];
const terminal=new Set(['succeeded','partial','failed','interrupted','cancelled']);
function hash(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function scopeOf(value:unknown):Scope{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==scopeKeys.join(','))throw Error('discovery_scope_unavailable');
 const row=value as Row;if(scopeKeys.some(key=>typeof row[key]!=='string'||!(row[key] as string).trim()||(row[key] as string).length>256||/[\u0000-\u001f\u007f]/.test(row[key] as string)))throw Error('discovery_scope_unavailable');
 return Object.freeze({...row}) as Scope;
}
function instant(value:unknown):number|null{
 if(value===null||value===undefined)return null;
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)||!Number.isSafeInteger(Date.parse(value))||new Date(value).toISOString()!==value)throw Error('discovery_source_unconfirmed');
 return Date.parse(value);
}
/** Factual project activity only. No policy, budget/capacity grant, task, lease,
 * signal, directory or Agent is created. Do not use this as dispatch authority. */
export class ProjectActivityObserver{
 private readonly db:DatabaseSync;private readonly workbench:WorkspaceReader;private readonly native:NativeReader;
 private readonly now:()=>number;private readonly maxAgeMs:number;
 constructor(options:{db:DatabaseSync;workbench:WorkspaceReader;native:NativeReader;now?:()=>number;maxAgeMs:number}){
  if(!Number.isSafeInteger(options.maxAgeMs)||options.maxAgeMs<1)throw Error('discovery_observation_config_invalid');
  this.db=options.db;this.workbench=options.workbench;this.native=options.native;this.now=options.now??Date.now;this.maxAgeMs=options.maxAgeMs;
 }
 private snapshot(scope:Scope){
  if(this.db.isTransaction)throw Error('discovery_observation_transaction_active');
  this.db.exec('BEGIN DEFERRED');
  try{
   const {owner_id:owner,project_id:project,workspace_id:workspace,agent_id:agent}=scope;
   const p=this.db.prepare('SELECT version FROM ga_projects WHERE id=? AND owner_id=?').get(project,owner) as Row|undefined;
   const role=this.db.prepare('SELECT version,capability_epoch,status,conversation_id FROM wb_agents WHERE agent_id=? AND owner_id=? AND project_id=? AND workspace_id=?').get(agent,owner,project,workspace) as Row|undefined;
   if(!p||!role)throw Error('discovery_scope_unavailable');
   if(![p.version,role.version,role.capability_epoch].every(x=>Number.isSafeInteger(x)&&Number(x)>0))throw Error('discovery_source_unconfirmed');
   const conversations=this.db.prepare(`SELECT c.id,c.version,c.archived_at,b.owner_id AS binding_owner,b.session_id FROM ga_conversations c
    LEFT JOIN ga_harness_session_bindings b ON b.conversation_id=c.id WHERE c.owner_id=? AND c.project_id=? AND c.workspace_id=? ORDER BY c.id`).all(owner,project,workspace) as Row[];
   if(!conversations.some(c=>c.id===role.conversation_id)||conversations.some(c=>c.binding_owner!==null&&c.binding_owner!==owner))throw Error('discovery_source_unconfirmed');
   const runs=this.db.prepare(`SELECT r.id,r.status,r.version,r.reason_code,r.updated_at FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
    WHERE c.owner_id=? AND c.project_id=? AND c.workspace_id=? ORDER BY r.id`).all(owner,project,workspace) as Row[];
   const children=this.db.prepare(`SELECT n.run_id,n.child_session_ref FROM wb_native_execution_runs n JOIN ga_runs r ON r.id=n.root_run_id JOIN ga_conversations c ON c.id=r.conversation_id
    WHERE n.owner_id=? AND c.owner_id=? AND c.project_id=? AND c.workspace_id=? ORDER BY n.run_id`).all(owner,owner,project,workspace) as Row[];
   const controls=this.db.prepare(`SELECT g.control_id,g.state FROM ga_conversation_goal_controls g JOIN ga_conversations c ON c.id=g.conversation_id
    WHERE g.owner_id=? AND c.owner_id=? AND c.project_id=? AND c.workspace_id=? AND g.state IN ('queued','dispatching') ORDER BY g.control_id`).all(owner,owner,project,workspace);
   const inputs=this.db.prepare(`SELECT m.id,m.created_at,m.updated_at,m.status FROM ga_messages m JOIN ga_conversations c ON c.id=m.conversation_id
    WHERE c.owner_id=? AND c.project_id=? AND c.workspace_id=? AND m.role='user' ORDER BY m.id`).all(owner,project,workspace) as Row[];
   return {project:p,role,conversations,runs,children,controls,inputs};
  }finally{this.db.exec('ROLLBACK');}
 }
 async observe(value:unknown,signal?:AbortSignal){
  const scope=scopeOf(value);signal?.throwIfAborted();const first=this.snapshot(scope),started=this.now();
  if(!Number.isSafeInteger(started)||started<0)throw Error('discovery_observation_config_invalid');
  const source_sha256=hash(first),sessions=[...new Set([...first.conversations.map(c=>c.session_id),...first.children.map(c=>c.child_session_ref)].filter((id):id is string=>typeof id==='string'))].sort();
  let workspaceReady=false;try{workspaceReady=this.workbench.projectWorkspaceReady(scope.owner_id,scope.workspace_id,scope.project_id);}catch{}
  const runBusy=first.runs.some(r=>!terminal.has(String(r.status)))||first.controls.length>0;
  const ended=first.runs.filter(r=>terminal.has(String(r.status))).map(r=>instant(r.updated_at)!).filter(x=>x!==null);
  const inputs=first.inputs.map(input=>instant(input.created_at)!);
  const facts={project_version:Number(first.project.version),role_version:Number(first.role.version),role_epoch:Number(first.role.capability_epoch),workspace_ready:workspaceReady,
   role_active:first.role.status==='active',run_busy:runBusy,last_user_input_at:inputs.length?inputs.reduce((a,b)=>Math.max(a,b)):null,last_terminal_at:ended.length?ended.reduce((a,b)=>Math.max(a,b)):null,
   native_idle:'unknown' as 'idle'|'busy'|'unknown',host_ready:false,session_count:sessions.length};
  if([facts.last_user_input_at,facts.last_terminal_at].some(time=>time!==null&&time>started))throw Error('discovery_source_unconfirmed');
  const result=(reason:string|null)=>Object.freeze({protocol:1 as const,scope,facts:Object.freeze({...facts}),source_sha256,observed_at:started,reason,execution_authorized:false as const});
  if(!workspaceReady)return result('WORKSPACE_UNAVAILABLE');if(!facts.role_active)return result('ROLE_UNAVAILABLE');if(runBusy)return result('AGENT_BUSY');
  if(!sessions.length||first.conversations.some(c=>c.session_id===null))return result('SESSION_BINDING_MISSING');
  const deadline=AbortSignal.timeout(20_000),bounded=signal?AbortSignal.any([signal,deadline]):deadline;
  let oldest=started;
  try{
   const ready=await this.native.nativeIdleObservationReadiness(bounded) as Row;
   if(!ready||typeof ready!=='object'||Object.keys(ready).sort().join(',')!=='execution_authorized,protocol,ready'||ready.protocol!==1||ready.execution_authorized!==false||ready.ready!==true)return result('HOST_UNAVAILABLE');
   facts.host_ready=true;
   for(const session of sessions){
    bounded.throwIfAborted();let fact;try{fact=validateNativeIdleObservation(await this.native.observeNativeIdle(session,bounded),session);}catch(error){if(bounded.aborted)throw error;return result('NATIVE_IDLE_UNCONFIRMED');}
    oldest=Math.min(oldest,fact.observed_at);
    const now=this.now();if(!Number.isSafeInteger(now)||now<started||fact.observed_at>now||now-oldest>this.maxAgeMs||now-started>this.maxAgeMs)return result('OBSERVATION_STALE');
    if(fact.native_idle==='busy'){facts.native_idle='busy';return result('AGENT_BUSY');}
    if(fact.native_idle!=='idle')return result('NATIVE_IDLE_UNCONFIRMED');
   }
  }catch(error){if(signal?.aborted)throw error;return result('HOST_UNAVAILABLE');}
  signal?.throwIfAborted();
  let second;try{second=this.snapshot(scope);}catch{return result('SOURCE_CHANGED');}
  let workspaceStillReady=false;try{workspaceStillReady=this.workbench.projectWorkspaceReady(scope.owner_id,scope.workspace_id,scope.project_id);}catch{}
  if(hash(second)!==source_sha256||!workspaceStillReady)return result('SOURCE_CHANGED');
  const finished=this.now();if(!Number.isSafeInteger(finished)||finished<started||finished-oldest>this.maxAgeMs)return result('OBSERVATION_STALE');
  facts.native_idle='idle';return result(null);
 }
}
