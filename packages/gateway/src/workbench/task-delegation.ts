import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {WorkbenchService} from './service.ts';
import type {PersistentTaskService} from '../persistent-tasks/service.ts';
import {currentTaskMailbox} from './task-mailbox.ts';
import {TaskExecutionEvidence} from '../persistent-tasks/execution-evidence.ts';
import {taskDependencyReasons,assertDependencyReasons} from '../persistent-tasks/execution-eligibility.ts';
import {automaticDelegationLimit} from './task-collaboration.ts';

type Input={occurrence_id:string;subtask_id:string;expected_subtask_version:number;recipient_agent_id:string;client_message_id:string};
type Assignment={message_id:string;owner_id:string;task_id:string;occurrence_id:string;subtask_id:string;subtask_version:number;
 recipient_agent_id:string;role_version:number;role_epoch:number;snapshot_json:string};
const evidenceServices=new WeakMap<DatabaseSync,TaskExecutionEvidence>();
export function installTaskDelegations(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_delegations(
  delegation_id TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE REFERENCES wb_agent_messages(message_id),
  owner_id TEXT NOT NULL,task_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,subtask_id TEXT NOT NULL,
  subtask_version INTEGER NOT NULL,recipient_agent_id TEXT NOT NULL,role_version INTEGER NOT NULL,role_epoch INTEGER NOT NULL,
  client_message_id TEXT NOT NULL,input_hash TEXT NOT NULL,snapshot_json TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL,
  UNIQUE(owner_id,task_id,client_message_id));
  CREATE TRIGGER IF NOT EXISTS wb_task_delegations_no_update BEFORE UPDATE ON wb_task_delegations BEGIN SELECT RAISE(ABORT,'task_delegation_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_task_delegations_no_delete BEFORE DELETE ON wb_task_delegations BEGIN SELECT RAISE(ABORT,'task_delegation_immutable'); END;`);
 if(!evidenceServices.has(db))evidenceServices.set(db,new TaskExecutionEvidence(db));
}
export function taskAssignmentForMessage(db:DatabaseSync,owner:string,messageId:string,beforeDispatch=false){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_delegations'").get())return;
 const a=db.prepare('SELECT * FROM wb_task_delegations WHERE owner_id=? AND message_id=?').get(owner,messageId) as Assignment|undefined;
 if(!a)return;
 // Workers use their own database connection; the Gateway's WeakMap cache is
 // not shared with that connection or a restarted process.
 if(!evidenceServices.has(db))installTaskDelegations(db);
 automaticDelegationLimit(db,owner,messageId);
 const msg=db.prepare('SELECT thread_id FROM wb_agent_messages WHERE message_id=? AND owner_id=?').get(messageId,owner) as {thread_id:string};
 const root=currentTaskMailbox(db,owner,msg.thread_id);
 const step=db.prepare('SELECT version,status,dependencies_json FROM wb_task_subtasks WHERE task_id=? AND subtask_id=?').get(a.task_id,a.subtask_id) as {version:number;status:string;dependencies_json:string}|undefined;
 const role=db.prepare('SELECT status,version,capability_epoch FROM wb_agents WHERE owner_id=? AND agent_id=?').get(owner,a.recipient_agent_id) as {status:string;version:number;capability_epoch:number}|undefined;
 if(!root||root.task_id!==a.task_id||root.occurrence_id!==a.occurrence_id||!step||step.version!==a.subtask_version||step.status!=='running'
   ||!role||role.status!=='active'||role.capability_epoch!==a.role_epoch||(beforeDispatch&&role.version!==a.role_version))throw new Error('task_assignment_revoked');
 assertDependencyReasons(taskDependencyReasons(db,evidenceServices.get(db)!,owner,a.task_id,JSON.parse(step.dependencies_json),a.occurrence_id));
 return JSON.parse(a.snapshot_json) as {subtask_id:string;subtask_version:number;title:string;acceptance:string;lead_agent_id:string;dependencies:string[]};
}
export class TaskDelegationService {
 private readonly db:DatabaseSync;
 private readonly workbench:WorkbenchService;
 private readonly tasks:PersistentTaskService;
 constructor(db:DatabaseSync,workbench:WorkbenchService,tasks:PersistentTaskService){this.db=db;this.workbench=workbench;this.tasks=tasks;installTaskDelegations(db);}
 delegate(owner:string,taskId:string,input:Input){
  if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['occurrence_id','subtask_id','expected_subtask_version','recipient_agent_id','client_message_id'].includes(k))
   ||['occurrence_id','subtask_id','recipient_agent_id','client_message_id'].some(k=>typeof input[k as keyof Input]!=='string'||!String(input[k as keyof Input]).trim()||String(input[k as keyof Input]).length>200)
   ||!Number.isSafeInteger(input.expected_subtask_version)||input.expected_subtask_version<1)throw new Error('invalid_task_delegation');
  return withImmediateTransaction(this.db,()=>{
   const task=this.tasks.get(owner,taskId);
   const digest=createHash('sha256').update(JSON.stringify([input.occurrence_id,input.subtask_id,input.expected_subtask_version,input.recipient_agent_id,input.client_message_id])).digest('hex');
   const prior=this.db.prepare('SELECT input_hash,receipt_json FROM wb_task_delegations WHERE owner_id=? AND task_id=? AND client_message_id=?').get(owner,taskId,input.client_message_id) as {input_hash:string;receipt_json:string}|undefined;
   if(prior){if(prior.input_hash!==digest)throw new Error('idempotency_conflict');return JSON.parse(prior.receipt_json);}
   const current=this.db.prepare('SELECT run_id FROM wb_task_current_occurrences WHERE task_id=? AND occurrence_id=?').get(taskId,input.occurrence_id) as {run_id:string}|undefined;
   if(!current)throw new Error('task_execution_revoked');
   this.workbench.assertRunActive(current.run_id);this.tasks.assertRunActive(current.run_id);
   const member=this.workbench.getAgent(owner,input.recipient_agent_id),lead=this.workbench.getAgent(owner,task.agent_id);
   if(member.agent_id===lead.agent_id||member.status!=='active'||member.workspace_id!==lead.workspace_id||member.project_id!==lead.project_id)throw new Error('message_scope_forbidden');
   const step=this.tasks.subtasks(owner,taskId).items.find(s=>s.subtask_id===input.subtask_id);
   if(!step)throw new Error('subtask_not_found');
   if(step.version!==input.expected_subtask_version)throw new Error('version_conflict');
   if(!['pending','blocked'].includes(step.status))throw new Error('task_assignment_revoked');
   const assigned=this.tasks.upsertSubtask(owner,taskId,{subtask_id:step.subtask_id,expected_version:step.version,status:'running'},current.run_id);
   const snapshot={subtask_id:step.subtask_id,subtask_version:assigned.version,title:assigned.title,acceptance:assigned.acceptance,dependencies:assigned.dependencies,lead_agent_id:lead.agent_id};
   const msg=this.workbench.sendMessage(owner,lead.workspace_id,{sender_agent_id:lead.agent_id,recipient_agent_id:member.agent_id,
    text:`执行子任务：${assigned.title}\n验收要求：${assigned.acceptance}\n只交回材料与证据，由主控核验，不派发更多成员。`,
    client_message_id:`delegate-${createHash('sha256').update(`${taskId}\0${input.client_message_id}`).digest('hex')}`,auto_reply:true,max_replies:1,task_run_id:current.run_id});
   const receipt={delegation_id:`delegation-${randomUUID()}`,message_id:String(msg.message_id),occurrence_id:input.occurrence_id,subtask_id:step.subtask_id,subtask_version:assigned.version,recipient_agent_id:member.agent_id};
   this.db.prepare('INSERT INTO wb_task_delegations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(receipt.delegation_id,receipt.message_id,owner,taskId,input.occurrence_id,step.subtask_id,assigned.version,member.agent_id,member.version,member.capability_epoch,input.client_message_id,digest,JSON.stringify(snapshot),JSON.stringify(receipt),new Date().toISOString());
   return receipt;
  });
 }
}
