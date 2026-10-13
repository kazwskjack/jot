import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {WorkbenchService} from './service.ts';
import type {PersistentTaskService} from '../persistent-tasks/service.ts';
import type {TaskDelegationService} from './task-delegation.ts';

type Policy={version:number;enabled:boolean;team_id:string|null;member_ids:string[];max_delegations:number;max_active:number};
type Row={task_id:string;owner_id:string;version:number;enabled:number;team_id:string|null;team_version:number|null;
 member_ids_json:string;roles_json:string;max_delegations:number;max_active:number};
function latest(db:DatabaseSync,owner:string,taskId:string){return db.prepare('SELECT * FROM wb_task_collaboration_grants WHERE owner_id=? AND task_id=? ORDER BY version DESC LIMIT 1').get(owner,taskId) as Row|undefined;}
function publicPolicy(row:Row|undefined):Policy{return row?{version:row.version,enabled:!!row.enabled,team_id:row.team_id,member_ids:JSON.parse(row.member_ids_json),max_delegations:row.max_delegations,max_active:row.max_active}:{version:0,enabled:false,team_id:null,member_ids:[],max_delegations:0,max_active:0};}
function validateGrant(db:DatabaseSync,row:Row,beforeDispatch=false){
 if(!row.enabled)throw new Error('task_collaboration_revoked');
 const team=db.prepare('SELECT status,version FROM wb_teams WHERE owner_id=? AND team_id=?').get(row.owner_id,row.team_id!) as {status:string;version:number}|undefined;
 if(!team||team.status!=='active'||team.version!==row.team_version)throw new Error('task_collaboration_revoked');
 const roles=JSON.parse(row.roles_json) as Array<{agent_id:string;version:number;epoch:number}>;
 for(const saved of roles){
  const role=db.prepare('SELECT status,version,capability_epoch FROM wb_agents WHERE owner_id=? AND agent_id=?').get(row.owner_id,saved.agent_id) as {status:string;version:number;capability_epoch:number}|undefined;
  if(!role||role.status!=='active'||role.capability_epoch!==saved.epoch||(beforeDispatch&&role.version!==saved.version))throw new Error('task_collaboration_revoked');
 }
}
export function assertNativeCollaborationPolicy(db:DatabaseSync,owner:string,taskId:string,version:number,roleId:string){
 const grant=latest(db,owner,taskId);
 if(!grant||grant.version!==version)throw new Error('task_collaboration_revoked');
 validateGrant(db,grant,true);
 if(!(JSON.parse(grant.member_ids_json) as string[]).includes(roleId))throw new Error('task_collaboration_forbidden');
}
export function automaticDelegationLimit(db:DatabaseSync,owner:string,messageId:string):number {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_delegation_authorizations'").get())return 2;
 const bound=db.prepare(`SELECT d.task_id,a.policy_version FROM wb_task_delegation_authorizations a
   JOIN wb_task_delegations d ON d.delegation_id=a.delegation_id WHERE d.owner_id=? AND d.message_id=?`).get(owner,messageId) as {task_id:string;policy_version:number}|undefined;
 if(!bound)return 2;
 const grant=latest(db,owner,bound.task_id);
 if(!grant||grant.version!==bound.policy_version)throw new Error('task_collaboration_revoked');
 validateGrant(db,grant);return grant.max_active;
}
export class TaskCollaborationService {
 private readonly db:DatabaseSync;private readonly workbench:WorkbenchService;private readonly tasks:PersistentTaskService;private readonly delegations:TaskDelegationService;
 constructor(db:DatabaseSync,workbench:WorkbenchService,tasks:PersistentTaskService,delegations:TaskDelegationService){
  this.db=db;this.workbench=workbench;this.tasks=tasks;this.delegations=delegations;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_collaboration_grants(
    owner_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),version INTEGER NOT NULL,
    enabled INTEGER NOT NULL,team_id TEXT,team_version INTEGER,member_ids_json TEXT NOT NULL,roles_json TEXT NOT NULL,
    max_delegations INTEGER NOT NULL,max_active INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(owner_id,task_id,version));
    CREATE TABLE IF NOT EXISTS wb_task_delegation_authorizations(delegation_id TEXT PRIMARY KEY REFERENCES wb_task_delegations(delegation_id),policy_version INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS wb_collaboration_no_update BEFORE UPDATE ON wb_task_collaboration_grants BEGIN SELECT RAISE(ABORT,'task_collaboration_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_collaboration_no_delete BEFORE DELETE ON wb_task_collaboration_grants BEGIN SELECT RAISE(ABORT,'task_collaboration_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_delegation_authorization_no_update BEFORE UPDATE ON wb_task_delegation_authorizations BEGIN SELECT RAISE(ABORT,'task_collaboration_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_delegation_authorization_no_delete BEFORE DELETE ON wb_task_delegation_authorizations BEGIN SELECT RAISE(ABORT,'task_collaboration_immutable'); END;`);
 }
 get(owner:string,taskId:string){this.tasks.get(owner,taskId);return publicPolicy(latest(this.db,owner,taskId));}
 authorizeNativeMember(owner:string,runId:string,memberId:string,expectedVersion:number){
  this.workbench.assertRunActive(runId);this.tasks.assertRunActive(runId);
  const context=this.workbench.contextForRun(runId);
  const current=this.db.prepare(`SELECT o.task_id,o.occurrence_id,o.generation FROM wb_task_current_occurrences c
   JOIN wb_task_run_occurrences o ON o.run_id=c.run_id WHERE c.run_id=?`).get(runId) as {task_id:string;occurrence_id:string;generation:number}|undefined;
  if(!current||context?.kind!=='task'||context.owner_id!==owner||!this.db.prepare("SELECT 1 FROM ga_runs WHERE id=? AND status IN ('starting','running')").get(runId))throw new Error('task_collaboration_forbidden');
  const grant=latest(this.db,owner,current.task_id);
  if(!grant||grant.version!==expectedVersion)throw new Error('task_collaboration_revoked');
  validateGrant(this.db,grant,true);
  if(!(JSON.parse(grant.member_ids_json) as string[]).includes(memberId))throw new Error('task_collaboration_forbidden');
  const role=this.workbench.getAgent(owner,memberId);
  if(role.workspace_id!==context.workspace_id||role.project_id!==context.project_id)throw new Error('task_collaboration_forbidden');
  return {owner_id:owner,root_run_id:runId,...current,team_id:grant.team_id!,policy_version:grant.version,
   max_active:grant.max_active,max_delegations:grant.max_delegations,role_id:role.agent_id,role_version:role.version,role_epoch:role.capability_epoch,
   workspace_id:context.workspace_id,project_id:context.project_id};
 }
 save(owner:string,taskId:string,input:Record<string,unknown>){
  if(!input||Object.keys(input).some(k=>!['expected_version','enabled','team_id','member_ids','max_delegations','max_active'].includes(k))
   ||!Number.isSafeInteger(input.expected_version)||Number(input.expected_version)<0||typeof input.enabled!=='boolean')throw new Error('invalid_task_collaboration');
  return withImmediateTransaction(this.db,()=>{
   const task=this.tasks.get(owner,taskId),prior=latest(this.db,owner,taskId);
   if((prior?.version??0)!==input.expected_version)throw new Error('version_conflict');
   let teamId:string|null=null,teamVersion:number|null=null,members:string[]=[],roles:unknown[]=[],maximum=0,active=0;
   if(input.enabled){
    if(typeof input.team_id!=='string'||!Array.isArray(input.member_ids)||input.member_ids.length<1||input.member_ids.length>2
     ||input.member_ids.some(id=>typeof id!=='string')||new Set(input.member_ids).size!==input.member_ids.length
     ||!Number.isSafeInteger(input.max_delegations)||Number(input.max_delegations)<1||Number(input.max_delegations)>20
     ||!Number.isSafeInteger(input.max_active)||![1,2].includes(Number(input.max_active)))throw new Error('invalid_task_collaboration');
    const team=this.workbench.getTeam(owner,input.team_id),lead=this.workbench.getAgent(owner,task.agent_id);
    members=input.member_ids as string[];
    if(team.status!=='active'||team.workspace_id!==lead.workspace_id||team.project_id!==lead.project_id||!team.member_ids.includes(lead.agent_id)
     ||members.some(id=>id===lead.agent_id||!team.member_ids.includes(id)))throw new Error('task_collaboration_forbidden');
    roles=[lead,...members.map(id=>this.workbench.getAgent(owner,id))].map(role=>{
     if(role.status!=='active'||role.workspace_id!==lead.workspace_id||role.project_id!==lead.project_id)throw new Error('task_collaboration_forbidden');
     return {agent_id:role.agent_id,version:role.version,epoch:role.capability_epoch};
    });
    teamId=team.team_id;teamVersion=team.version;maximum=Number(input.max_delegations);active=Number(input.max_active);
   }else if(Object.keys(input).some(k=>!['expected_version','enabled'].includes(k)))throw new Error('invalid_task_collaboration');
   this.db.prepare('INSERT INTO wb_task_collaboration_grants VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(owner,taskId,(prior?.version??0)+1,input.enabled?1:0,teamId,teamVersion,JSON.stringify(members),JSON.stringify(roles),maximum,active,new Date().toISOString());
   return this.get(owner,taskId);
  });
 }
 delegateByLead(owner:string,runId:string,input:{subtask_id:string;expected_subtask_version:number;recipient_agent_id:string;client_message_id:string}){
  return withImmediateTransaction(this.db,()=>{
   this.workbench.assertRunActive(runId);this.tasks.assertRunActive(runId);
   const context=this.workbench.contextForRun(runId);
   const current=this.db.prepare('SELECT task_id,occurrence_id FROM wb_task_current_occurrences WHERE run_id=?').get(runId) as {task_id:string;occurrence_id:string}|undefined;
   if(!current||context?.kind!=='task'||context.owner_id!==owner)throw new Error('task_collaboration_forbidden');
   if(!this.db.prepare("SELECT 1 FROM ga_runs WHERE id=? AND status IN ('starting','running')").get(runId))throw new Error('task_collaboration_forbidden');
   if(!this.db.prepare('SELECT 1 FROM wb_model_budget_bindings WHERE run_id=? AND owner_id=?').get(runId,owner))throw new Error('budget_service_unavailable');
   const grant=latest(this.db,owner,current.task_id);
   if(!grant?.enabled)throw new Error('task_collaboration_forbidden');validateGrant(this.db,grant,true);
   if(!(JSON.parse(grant.member_ids_json) as string[]).includes(input.recipient_agent_id))throw new Error('task_collaboration_forbidden');
   const key=`automatic:${input.client_message_id}`;
   const prior=this.db.prepare('SELECT delegation_id FROM wb_task_delegations WHERE owner_id=? AND task_id=? AND client_message_id=?').get(owner,current.task_id,key) as {delegation_id:string}|undefined;
   if(prior){if(!this.db.prepare('SELECT 1 FROM wb_task_delegation_authorizations WHERE delegation_id=? AND policy_version=?').get(prior.delegation_id,grant.version))throw new Error('task_collaboration_revoked');}
   else{
    const spent=this.db.prepare(`SELECT COUNT(*) n FROM wb_task_delegation_authorizations a JOIN wb_task_delegations d ON d.delegation_id=a.delegation_id WHERE d.owner_id=? AND d.task_id=? AND d.occurrence_id=?`).get(owner,current.task_id,current.occurrence_id) as {n:number};
    const native=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_native_child_reservations'").get()
      ?(this.db.prepare('SELECT count(*) n FROM wb_native_child_reservations WHERE owner_id=? AND occurrence_id=?').get(owner,current.occurrence_id) as {n:number}).n:0;
    if(spent.n+native>=grant.max_delegations)throw new Error('task_collaboration_exhausted');
   }
   const receipt=this.delegations.delegate(owner,current.task_id,{...input,client_message_id:key,occurrence_id:current.occurrence_id});
   this.db.prepare('INSERT INTO wb_task_delegation_authorizations VALUES(?,?) ON CONFLICT DO NOTHING').run(receipt.delegation_id,grant.version);
   return receipt;
  });
 }
}
