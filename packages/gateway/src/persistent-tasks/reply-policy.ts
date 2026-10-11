import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {OwnerChannelBindings} from '../channels/owner-bindings.ts';
import {normalizeNotificationPolicy} from './notification-policy.ts';

type Row=Record<string,any>;
export type TaskReplyScope={task_id:string;occurrence_id:string;run_id:string;task_version:number;generation:number;policy_version:number;policy_sha256:string;policy:TaskReplyPolicy;authority:Row;allowed:boolean;reason:string|null};
export type TaskReplyPolicy={mode:'report'}|{
 mode:'draft'|'review'|'bounded_auto_reply';
 target:{kind:'conversation';conversation_id:string}|{kind:'channel';channel_binding_id:string};
 direction:{topic:string;tone:string;evidence_required:true;forbidden:string[]};
 limits:{max_per_24_hours:number;min_interval_seconds:number;expires_at:string};
 quiet_hours:null|{start:string;end:string;timezone:string};
};
function record(value:unknown,keys:string[]):Row{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('invalid_task_reply_policy');return value as Row;
}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('invalid_task_reply_policy');return value.trim();}
export function normalizeTaskReplyPolicy(input:unknown,now=new Date()):TaskReplyPolicy{
 const value=record(input,['mode','target','direction','limits','quiet_hours']);
 if(value.mode==='report'){if(Object.keys(value).length!==1)throw new Error('invalid_task_reply_policy');return {mode:'report'};}
 if(!['draft','review','bounded_auto_reply'].includes(value.mode)||Object.keys(value).length!==5)throw new Error('invalid_task_reply_policy');
 const target=record(value.target,['kind','conversation_id','channel_binding_id']);let normalizedTarget:Exclude<TaskReplyPolicy,{mode:'report'}>['target'];
 if(target.kind==='conversation'&&Object.keys(target).length===2&&!Object.hasOwn(target,'channel_binding_id'))normalizedTarget={kind:'conversation',conversation_id:text(target.conversation_id,200)};
 else if(target.kind==='channel'&&Object.keys(target).length===2&&!Object.hasOwn(target,'conversation_id'))normalizedTarget={kind:'channel',channel_binding_id:text(target.channel_binding_id,128)};
 else throw new Error('invalid_task_reply_policy');
 const direction=record(value.direction,['topic','tone','evidence_required','forbidden']);
 if(direction.evidence_required!==true||!Array.isArray(direction.forbidden)||direction.forbidden.length>20)throw new Error('invalid_task_reply_policy');
 const forbidden=direction.forbidden.map(item=>text(item,500));if(new Set(forbidden).size!==forbidden.length)throw new Error('invalid_task_reply_policy');
 const limits=record(value.limits,['max_per_24_hours','min_interval_seconds','expires_at']);
 if(!Number.isSafeInteger(limits.max_per_24_hours)||limits.max_per_24_hours<1||limits.max_per_24_hours>20||!Number.isSafeInteger(limits.min_interval_seconds)||limits.min_interval_seconds<60||limits.min_interval_seconds>86400)throw new Error('invalid_task_reply_policy');
 const expires=text(limits.expires_at,100),expiry=Date.parse(expires);
 const year=Number(expires.slice(0,4)),month=Number(expires.slice(5,7)),day=Number(expires.slice(8,10)),calendar=new Date(Date.UTC(year,month-1,day));
 if(calendar.getUTCFullYear()!==year||calendar.getUTCMonth()!==month-1||calendar.getUTCDate()!==day)throw new Error('invalid_task_reply_policy');
 if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(expires)||!Number.isFinite(expiry)||expiry<=now.valueOf()||expiry>now.valueOf()+30*86400000)throw new Error('invalid_task_reply_policy');
 let quiet:Exclude<TaskReplyPolicy,{mode:'report'}>['quiet_hours'];
 try{quiet=normalizeNotificationPolicy({min_interval_seconds:limits.min_interval_seconds,max_per_24_hours:limits.max_per_24_hours,quiet_hours:value.quiet_hours}).quiet_hours;}catch{throw new Error('invalid_task_reply_policy');}
 return {mode:value.mode,target:normalizedTarget,direction:{topic:text(direction.topic,2000),tone:text(direction.tone,500),evidence_required:true,forbidden},limits:{max_per_24_hours:limits.max_per_24_hours,min_interval_seconds:limits.min_interval_seconds,expires_at:new Date(expiry).toISOString().replace('.000Z','Z')},quiet_hours:quiet};
}

/** Stores user policy only. Saving a revision is not a posting receipt or a
 * model authorization. Runtime scope capture, review and send fences must use
 * this revision before autonomous delivery is exposed. */
export class TaskReplyPolicies{
 private readonly db:DatabaseSync;
 private readonly options:{now?:()=>Date};
 constructor(db:DatabaseSync,options:{now?:()=>Date}={}){
  this.db=db;this.options=options;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_reply_policies(task_id TEXT PRIMARY KEY REFERENCES wb_persistent_tasks(task_id),owner_id TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_task_reply_policy_revisions(task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),owner_id TEXT NOT NULL,version INTEGER NOT NULL,policy_json TEXT NOT NULL,policy_sha256 TEXT NOT NULL,authority_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(task_id,version));
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_policy_revision_no_update BEFORE UPDATE ON wb_task_reply_policy_revisions BEGIN SELECT RAISE(ABORT,'reply_policy_revision_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_policy_revision_no_delete BEFORE DELETE ON wb_task_reply_policy_revisions BEGIN SELECT RAISE(ABORT,'reply_policy_revision_immutable'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_reply_scopes(occurrence_id TEXT PRIMARY KEY REFERENCES wb_task_occurrences(occurrence_id),task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),owner_id TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE REFERENCES ga_runs(id),scope_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_scope_no_update BEFORE UPDATE ON wb_task_reply_scopes BEGIN SELECT RAISE(ABORT,'reply_scope_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_scope_no_delete BEFORE DELETE ON wb_task_reply_scopes BEGIN SELECT RAISE(ABORT,'reply_scope_immutable'); END;`);
 }
 private task(owner:string,id:string):Row{const task=this.db.prepare('SELECT t.*,a.workspace_id,a.project_id,a.status AS agent_status,a.capability_epoch FROM wb_persistent_tasks t JOIN wb_agents a ON a.agent_id=t.agent_id AND a.owner_id=t.owner_id WHERE t.task_id=? AND t.owner_id=?').get(id,owner) as Row|undefined;if(!task)throw new Error('task_not_found');return task;}
 get(owner:string,id:string){this.task(owner,id);const row=this.db.prepare('SELECT r.* FROM wb_task_reply_policies p JOIN wb_task_reply_policy_revisions r ON r.task_id=p.task_id AND r.owner_id=p.owner_id AND r.version=p.version WHERE p.task_id=? AND p.owner_id=?').get(id,owner) as Row|undefined;return {task_id:id,version:row?Number(row.version):0,policy:row?JSON.parse(row.policy_json) as TaskReplyPolicy:{mode:'report'} as TaskReplyPolicy};}
 private targetReason(owner:string,task:Row,policy:TaskReplyPolicy,authority:Row):string|null{
  if(policy.mode==='report')return 'REPLY_REPORT_ONLY';
  if(Date.parse(policy.limits.expires_at)<=(this.options.now?.()??new Date()).valueOf())return 'REPLY_POLICY_EXPIRED';
  if(task.agent_id!==authority.agent_id||task.capability_epoch!==authority.epoch||task.workspace_id!==authority.workspace_id||(task.project_id??null)!==(authority.project_id??null)||task.agent_status!=='active')return 'REPLY_ROLE_CHANGED';
  if(policy.target.kind==='conversation'){
   const target=this.db.prepare('SELECT workspace_id,project_id,version FROM ga_conversations WHERE id=? AND owner_id=? AND archived_at IS NULL').get(policy.target.conversation_id,owner) as Row|undefined;
   if(!target||target.workspace_id!==task.workspace_id||(target.project_id??null)!==(task.project_id??null)||target.version!==authority.target_version)return 'REPLY_TARGET_CHANGED';
  }else{
   try{const binding=new OwnerChannelBindings(this.db).resolve(owner,policy.target.channel_binding_id);if(binding.version!==authority.binding_version||binding.channel!==authority.channel)return 'REPLY_TARGET_CHANGED';}catch(error){if(error instanceof Error&&['channel_binding_not_found','channel_binding_not_verified'].includes(error.message))return 'REPLY_TARGET_CHANGED';throw error;}
  }
  return null;
 }
 private prepared(owner:string,id:string){
  // Legacy task adapters may use an in-memory role. They can run reports,
  // but never gain reply authority without the persistent role/epoch adapter.
  if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_agents'").get()){
   const task=this.db.prepare('SELECT version,generation,agent_id FROM wb_persistent_tasks WHERE task_id=? AND owner_id=?').get(id,owner) as Row|undefined;if(!task)throw new Error('task_not_found');
   const revision=this.db.prepare('SELECT r.* FROM wb_task_reply_policies p JOIN wb_task_reply_policy_revisions r ON r.task_id=p.task_id AND r.owner_id=p.owner_id AND r.version=p.version WHERE p.task_id=? AND p.owner_id=?').get(id,owner) as Row|undefined;
   const policy:TaskReplyPolicy=revision?JSON.parse(revision.policy_json):{mode:'report'};
   return {task_id:id,task_version:Number(task.version),generation:Number(task.generation),policy_version:revision?Number(revision.version):0,policy_sha256:createHash('sha256').update(JSON.stringify(policy)).digest('hex'),policy,authority:{agent_id:task.agent_id,epoch:null,workspace_id:null,project_id:null},allowed:false,reason:policy.mode==='report'?'REPLY_REPORT_ONLY':'REPLY_ROLE_ADAPTER_UNAVAILABLE'};
  }
  const task=this.task(owner,id),current=this.get(owner,id),revision=this.db.prepare('SELECT policy_sha256,authority_json FROM wb_task_reply_policy_revisions WHERE task_id=? AND owner_id=? AND version=?').get(id,owner,current.version) as Row|undefined;
  const policyHash=createHash('sha256').update(JSON.stringify(current.policy)).digest('hex');if(revision&&revision.policy_sha256!==policyHash)throw new Error('task_reply_policy_corrupt');
  const authority=revision?JSON.parse(revision.authority_json):{agent_id:task.agent_id,epoch:task.capability_epoch,workspace_id:task.workspace_id,project_id:task.project_id};
  const reason=!['active','budget_exhausted'].includes(task.status)?'REPLY_TASK_CHANGED':this.targetReason(owner,task,current.policy,authority);
  return {task_id:id,task_version:Number(task.version),generation:Number(task.generation),policy_version:current.version,policy_sha256:policyHash,policy:current.policy,authority,allowed:reason===null,reason};
 }
 planningContext(owner:string,id:string){const scope=this.prepared(owner,id);return scope.allowed?`回复规则（服务端已核对，本次仅用于DSH规划）：${JSON.stringify(scope.policy)}\n实际回复须经独立草稿、证据和发送前权限复核；不能直接发送，不能把通知授权当作回复授权。`: `回复规则：本次仅整理结果（${scope.reason}），不能直接发送。`;}
 capture(owner:string,id:string,occurrenceId:string,runId:string):TaskReplyScope{return withImmediateTransaction(this.db,()=>{
  const occurrence=this.db.prepare('SELECT o.run_id FROM wb_task_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id JOIN ga_runs r ON r.id=o.run_id JOIN ga_conversations c ON c.id=r.conversation_id WHERE o.occurrence_id=? AND o.task_id=? AND t.owner_id=? AND c.owner_id=?').get(occurrenceId,id,owner,owner) as Row|undefined;
  if(!occurrence||occurrence.run_id!==runId)throw new Error('task_reply_scope_not_found');
  const existing=this.db.prepare('SELECT scope_json FROM wb_task_reply_scopes WHERE occurrence_id=? AND owner_id=?').get(occurrenceId,owner) as Row|undefined;if(existing)return JSON.parse(existing.scope_json);
  const scope={...this.prepared(owner,id),occurrence_id:occurrenceId,run_id:runId};
  this.db.prepare('INSERT INTO wb_task_reply_scopes VALUES(?,?,?,?,?,?)').run(occurrenceId,id,owner,runId,JSON.stringify(scope),(this.options.now?.()??new Date()).toISOString());return scope;
 });}
 scope(owner:string,runId:string):TaskReplyScope{
  const row=this.db.prepare('SELECT s.scope_json FROM wb_task_reply_scopes s JOIN wb_task_run_occurrences o ON o.occurrence_id=s.occurrence_id JOIN ga_runs r ON r.id=o.run_id JOIN ga_conversations c ON c.id=r.conversation_id WHERE o.run_id=? AND s.owner_id=? AND c.owner_id=?').get(runId,owner,owner) as Row|undefined;if(!row)throw new Error('task_reply_scope_not_found');return JSON.parse(row.scope_json);
 }
 authorize(owner:string,runId:string){
  const scope=this.scope(owner,runId);const denied=(reason:string)=>({allowed:false,reason,scope});if(!scope.allowed)return denied(scope.reason??'REPLY_NOT_AUTHORIZED');
  const task=this.task(owner,scope.task_id),current=this.get(owner,scope.task_id);
  if(task.version!==scope.task_version||task.generation!==scope.generation||!['active','budget_exhausted'].includes(task.status))return denied('REPLY_TASK_CHANGED');
  if(current.version!==scope.policy_version||createHash('sha256').update(JSON.stringify(current.policy)).digest('hex')!==scope.policy_sha256)return denied('REPLY_POLICY_CHANGED');
  const active=this.db.prepare("SELECT r.status,r.reason_code FROM wb_task_current_occurrences o JOIN ga_runs r ON r.id=o.run_id WHERE o.occurrence_id=? AND o.run_id=? AND o.generation=?").get(scope.occurrence_id,runId,scope.generation) as Row|undefined;
  if(!active||['cancelled','interrupted','failed'].includes(active.status)||active.reason_code==='OUTCOME_UNKNOWN')return denied('REPLY_RUN_CHANGED');
  const reason=this.targetReason(owner,task,scope.policy,scope.authority);return reason?denied(reason):{allowed:true,reason:null,scope};
 }
 update(owner:string,id:string,input:Row){return withImmediateTransaction(this.db,()=>{
  const task=this.task(owner,id);if(!input||Object.keys(input).some(key=>!['expected_version','policy'].includes(key))||!Number.isSafeInteger(input.expected_version)||input.expected_version<0)throw new Error('invalid_task_reply_policy');
  if(task.status==='archived'||task.agent_status!=='active')throw new Error('task_state_conflict');
  if(this.db.prepare("SELECT 1 FROM wb_task_current_occurrences o JOIN ga_runs r ON r.id=o.run_id WHERE o.task_id=? AND (r.reason_code='OUTCOME_UNKNOWN' OR r.status NOT IN ('succeeded','partial','failed','cancelled','interrupted'))").get(id))throw new Error('task_reply_run_active');
  const current=this.get(owner,id);if(current.version!==input.expected_version)throw new Error('version_conflict');
  const now=this.options.now?.()??new Date(),policy=normalizeTaskReplyPolicy(input.policy,now);let authority:Row={agent_id:task.agent_id,epoch:task.capability_epoch,workspace_id:task.workspace_id,project_id:task.project_id};
  if(policy.mode!=='report'){
   if(policy.target.kind==='conversation'){
    const target=this.db.prepare('SELECT workspace_id,project_id,version FROM ga_conversations WHERE id=? AND owner_id=? AND archived_at IS NULL').get(policy.target.conversation_id,owner) as Row|undefined;
    if(!target||target.workspace_id!==task.workspace_id||(target.project_id??null)!==(task.project_id??null))throw new Error('task_reply_target_invalid');authority={...authority,target_version:target.version};
   }else{const binding=new OwnerChannelBindings(this.db).resolve(owner,policy.target.channel_binding_id);authority={...authority,binding_version:binding.version,channel:binding.channel};}
  }
  const serialized=JSON.stringify(policy),version=current.version+1;
  this.db.prepare('INSERT INTO wb_task_reply_policy_revisions VALUES(?,?,?,?,?,?,?)').run(id,owner,version,serialized,createHash('sha256').update(serialized).digest('hex'),JSON.stringify(authority),now.toISOString());
  this.db.prepare('INSERT INTO wb_task_reply_policies VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at').run(id,owner,version,now.toISOString());
  this.db.prepare('UPDATE wb_persistent_tasks SET version=version+1,projection_pending=1,updated_at=? WHERE task_id=? AND owner_id=?').run(now.toISOString(),id,owner);
  return this.get(owner,id);
 });}
}
