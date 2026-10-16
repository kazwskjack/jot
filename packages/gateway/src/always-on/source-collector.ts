import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {taskBudgetKey} from '../workbench/model-budget-policy.ts';
import {DiscoveryPolicies} from './discovery-policy.ts';

type Scope={project_id:string;workspace_id:string;agent_id:string};
type Row=Record<string,any>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceId=(kind:string,key:string)=>hash([kind,key]);
const registered=new WeakSet<DatabaseSync>();
const safeScopes=(alias:string)=>`CASE WHEN json_valid(${alias}.scopes_json) THEN ${alias}.scopes_json ELSE '[]' END`;

/** Trusted metadata ingestion, never a model tool, source-content reader or
 * execution grant. The journal is the deduplication authority; no lossy timestamp
 * or rowid cursor, filesystem watcher, extra scheduler or model call is used. */
export class DiscoverySourceCollector{
 private readonly batchSize:number;
 private readonly db:DatabaseSync;
 private readonly policies:DiscoveryPolicies;
 constructor(db:DatabaseSync,policies:DiscoveryPolicies,options:{batchSize?:number}={}){
  this.db=db;this.policies=policies;
  this.batchSize=options.batchSize??50;
  if(!Number.isSafeInteger(this.batchSize)||this.batchSize<1||this.batchSize>1000)throw Error('discovery_collector_batch_invalid');
  if(!registered.has(db)){
   db.function('jot_discovery_source_id',{deterministic:true},(kind,key)=>sourceId(String(kind),String(key)));
   db.function('jot_discovery_task_key',{deterministic:true},id=>taskBudgetKey(String(id)));
   registered.add(db);
  }
 }
 private ownRun(run:string){return `EXISTS(SELECT 1 FROM wb_model_budget_bindings b
  JOIN ga_runs provenance_run ON provenance_run.id=b.run_id JOIN ga_conversations provenance_conversation
   ON provenance_conversation.id=provenance_run.conversation_id AND provenance_conversation.owner_id=b.owner_id
  JOIN json_each(${safeScopes('b')}) j JOIN wb_model_budget_scopes s ON s.scope_id=j.value AND s.owner_id=b.owner_id
  JOIN wb_discovery_task_bindings d ON d.owner_id=b.owner_id AND s.scope_key=jot_discovery_task_key(d.task_id)
  WHERE b.run_id=${run} AND b.owner_id=:owner AND provenance_conversation.project_id=:project AND provenance_conversation.workspace_id=:workspace
   AND d.project_id=:project AND d.workspace_id=:workspace)`;}
 private candidates(owner:string,scope:Scope,policy:string,limit:number){
  const params={owner,project:scope.project_id,workspace:scope.workspace_id,agent:scope.agent_id,policy,limit};
  const messages=this.db.prepare(`SELECT m.id,m.run_id,m.conversation_id,m.created_at,m.updated_at,b.epoch
   FROM ga_messages m JOIN ga_runs r ON r.id=m.run_id AND r.conversation_id=m.conversation_id
   JOIN ga_conversations c ON c.id=r.conversation_id
   JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=c.owner_id AND b.kind='chat'
   JOIN wb_agents a ON a.agent_id=b.agent_id AND a.owner_id=b.owner_id AND a.conversation_id=c.id
   WHERE c.owner_id=:owner AND c.project_id=:project AND c.workspace_id=:workspace AND b.agent_id=:agent
    AND m.role='user' AND m.status='complete' AND NOT ${this.ownRun('r.id')}
    AND NOT EXISTS(SELECT 1 FROM wb_discovery_signals s WHERE s.policy_id=:policy AND s.kind='user_input'
     AND s.source_id=jot_discovery_source_id('message',m.id) AND s.source_version=1)
   ORDER BY m.created_at,m.id LIMIT :limit`).all(params) as Row[];
  const files=this.db.prepare(`SELECT f.path,f.version,f.sha256,f.size,f.created_at FROM wb_file_versions f
   WHERE f.owner_id=:owner AND f.project_id=:project AND f.workspace_id=:workspace
    AND NOT EXISTS(SELECT 1 FROM wb_file_write_runs w WHERE w.owner_id=f.owner_id AND w.project_id=f.project_id
     AND w.workspace_id=f.workspace_id AND w.path=f.path AND w.version=f.version AND ${this.ownRun('w.run_id')})
    AND NOT EXISTS(SELECT 1 FROM wb_discovery_signals s WHERE s.policy_id=:policy AND s.kind='workspace_change'
     AND s.source_id=jot_discovery_source_id('file',f.path) AND s.source_version=f.version)
   ORDER BY f.path,f.version LIMIT :limit`).all({owner,project:scope.project_id,workspace:scope.workspace_id,policy,limit}) as Row[];
  // Interleave bounded streams so a growing input queue does not starve files.
  const result:Array<{kind:'user_input'|'workspace_change';row:Row}>=[];
  for(let i=0;result.length<limit&&(i<messages.length||i<files.length);i++){
   if(i<messages.length)result.push({kind:'user_input',row:messages[i]!});
   if(result.length<limit&&i<files.length)result.push({kind:'workspace_change',row:files[i]!});
  }
  return result;
 }
 private confirmedFile(owner:string,scope:Scope,file:Row){
  const producers=this.db.prepare(`SELECT w.run_id,w.sha256,w.size FROM wb_file_write_runs w WHERE w.owner_id=?
   AND w.project_id=? AND w.workspace_id=? AND w.path=? AND w.version=?`).all(owner,scope.project_id,scope.workspace_id,file.path,file.version) as Row[];
  for(const producer of producers){
   if(producer.sha256!==file.sha256||producer.size!==file.size)return false;
   const binding=this.db.prepare(`SELECT b.scopes_json FROM wb_model_budget_bindings b JOIN ga_runs r ON r.id=b.run_id
    JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=b.owner_id
    WHERE b.run_id=? AND b.owner_id=? AND c.project_id=? AND c.workspace_id=?`).get(producer.run_id,owner,scope.project_id,scope.workspace_id) as Row|undefined;
   if(!binding)return false;
   let ids:unknown;try{ids=JSON.parse(binding.scopes_json);}catch{return false;}
   if(!Array.isArray(ids)||!ids.length||ids.length>8||new Set(ids).size!==ids.length)return false;
   for(const id of ids)if(typeof id!=='string'||!this.db.prepare('SELECT 1 FROM wb_model_budget_scopes WHERE scope_id=? AND owner_id=?').get(id,owner))return false;
  }
  return true;
 }
 collect(owner:string,scope:Scope){
  // All facts and journal writes share a short transaction. Only bounded metadata
  // rows are hashed; no body/blob, network request or Host call holds the writer.
  return withImmediateTransaction(this.db,()=>{
   const policy=this.policies.get(owner,scope).policy;
   const receipt=(recorded:number,caught_up:boolean,reason:string|null)=>Object.freeze({recorded,caught_up,reason,
    signal_revision:this.policies.signals(owner,scope).revision,policy_version:policy?.version??0,execution_authorized:false as const});
   if(!policy||['off','stopped'].includes(policy.state))return receipt(0,false,'POLICY_OFF');
   const role=this.db.prepare('SELECT status,version,capability_epoch FROM wb_agents WHERE owner_id=? AND agent_id=?').get(owner,scope.agent_id) as Row;
   if(role.status!=='active'||role.version!==policy.role_version||role.capability_epoch!==policy.role_epoch)return receipt(0,false,'ROLE_REVOKED');
   for(const table of ['wb_model_budget_bindings','wb_model_budget_scopes','wb_discovery_task_bindings'])
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return receipt(0,false,'SOURCE_PROVENANCE_UNAVAILABLE');
   let recorded=0,unconfirmed=false;const heldPaths=new Set<string>();
   for(const candidate of this.candidates(owner,scope,policy.policy_id,this.batchSize)){
    const {kind,row}=candidate;
    if(kind==='workspace_change'&&(heldPaths.has(row.path)||!this.confirmedFile(owner,scope,row))){unconfirmed=true;heldPaths.add(row.path);continue;}
    const source_id=kind==='user_input'?sourceId('message',row.id):sourceId('file',row.path);
    this.policies.recordSignal(owner,scope,{kind,source_id,source_version:kind==='user_input'?1:row.version,source_sha256:hash(row),origin:'external'});
    recorded++;
   }
   const pending=this.candidates(owner,scope,policy.policy_id,1).length>0;
   return receipt(recorded,!pending,unconfirmed?'SOURCE_PROVENANCE_UNCONFIRMED':null);
  });
 }
}
