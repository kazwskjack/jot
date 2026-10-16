import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';

type Row=Record<string,string|number|null>;
interface Actor{agent_id:string;workspace_id:string;project_id:string;capability_epoch:number;status:string}
interface Source{capture_id:string;agent_id:string;workspace_id:string;project_id:string;source_run_id:string;source_conversation_id:string;version:number;policy_version:number;policy_current:boolean;status:string;sources:Array<{available:boolean}>}
interface Receipt{run_id:string;conversation_id:string}
interface Ports{
 actor(owner:string,agentId:string):Actor;
 source(owner:string,agentId:string,captureId:string):Source;
 createRun(owner:string,actor:Actor):Receipt;
 bindRun(owner:string,agentId:string,runId:string):void;
}
/** Reconstruct purpose and source ownership from immutable server records. */
export function assertMemoryProcessingIdentity(db:DatabaseSync,owner:string,runId:string){
 const row=db.prepare(`SELECT p.*,sb.kind AS source_kind FROM wb_memory_processing_runs p
  JOIN ga_runs r ON r.id=p.processor_run_id JOIN ga_conversations c ON c.id=r.conversation_id
  JOIN wb_memory_captures b ON b.capture_id=p.capture_id JOIN wb_memory_capture_policies policy ON policy.agent_id=p.agent_id
  JOIN wb_agents a ON a.agent_id=p.agent_id JOIN ga_runs sr ON sr.id=p.source_run_id JOIN ga_conversations sc ON sc.id=sr.conversation_id
  JOIN wb_run_bindings sb ON sb.run_id=sr.id
  WHERE p.processor_run_id=? AND p.owner_id=? AND c.id=p.conversation_id AND c.owner_id=p.owner_id AND c.workspace_id=p.workspace_id AND c.project_id=p.project_id
   AND b.owner_id=p.owner_id AND b.agent_id=p.agent_id AND b.workspace_id=p.workspace_id AND b.project_id=p.project_id AND b.source_run_id=p.source_run_id AND b.source_conversation_id=p.source_conversation_id
   AND b.epoch=p.epoch AND b.policy_version=p.policy_version AND ((b.status='ready' AND b.version=p.source_version AND b.processor_run_id IS NULL) OR (b.processor_run_id=p.processor_run_id AND b.status IN ('proposed','no_notes','applied') AND b.version>p.source_version))
   AND policy.owner_id=p.owner_id AND policy.mode='suggest' AND policy.version=p.policy_version AND policy.epoch=p.epoch
   AND a.owner_id=p.owner_id AND a.status='active' AND a.workspace_id=p.workspace_id AND a.project_id=p.project_id AND a.capability_epoch=p.epoch
   AND sr.status IN ('succeeded','partial') AND sc.id=p.source_conversation_id AND sc.owner_id=p.owner_id AND sc.workspace_id=p.workspace_id AND sc.project_id=p.project_id
   AND sb.owner_id=p.owner_id AND sb.agent_id=p.agent_id AND sb.epoch=p.epoch AND sb.kind IN ('chat','task','native_team','internal_mailbox')
   AND NOT EXISTS(SELECT 1 FROM ga_runs foreground JOIN wb_run_bindings fb ON fb.run_id=foreground.id WHERE fb.owner_id=p.owner_id AND fb.agent_id=p.agent_id AND fb.kind!='memory_capture' AND foreground.id!=p.processor_run_id AND foreground.status IN ('queued','starting','running','waiting_user','waiting_approval','cancelling'))`).get(runId,owner) as Row|undefined;
 if(!row)throw Error('memory_processing_source_unavailable');
 if(row.source_kind==='chat')return row;
 const has=(name:string)=>!!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(name),tasks:Row[]=[];
 if(has('wb_task_run_occurrences'))tasks.push(...db.prepare(`SELECT t.owner_id,t.status,t.generation AS current_generation,o.generation FROM wb_task_run_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id WHERE o.run_id=?`).all(String(row.source_run_id)) as Row[]);
 if(has('wb_native_execution_runs'))tasks.push(...db.prepare(`SELECT t.owner_id,t.status,t.generation AS current_generation,json_extract(n.snapshot_json,'$.generation') AS generation FROM wb_native_execution_runs n JOIN wb_persistent_tasks t ON t.task_id=n.task_id WHERE n.run_id=?`).all(String(row.source_run_id)) as Row[]);
 if(has('wb_task_auxiliary_runs'))tasks.push(...db.prepare(`SELECT t.owner_id,t.status,t.generation AS current_generation,root.generation FROM wb_task_auxiliary_runs a JOIN wb_persistent_tasks t ON t.task_id=a.task_id JOIN wb_mailbox_task_roots root ON root.thread_id=a.thread_id WHERE a.run_id=?`).all(String(row.source_run_id)) as Row[]);
 if(tasks.some(task=>task.owner_id!==owner||!['active','completed'].includes(String(task.status))||(task.generation!==undefined&&task.generation!==task.current_generation)))throw Error('memory_processing_source_unavailable');
 return row;
}
/** Immutable purpose/lineage only. The original ga_run owns execution state;
 * this registry never starts a model, claims a worker lease or grants budget.
 */
export class MemoryProcessingRegistry{
 private readonly db:DatabaseSync;private readonly ports:Ports;
 constructor(db:DatabaseSync,ports:Ports){this.db=db;this.ports=ports;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_memory_processing_runs(
   processor_run_id TEXT PRIMARY KEY,conversation_id TEXT UNIQUE NOT NULL,capture_id TEXT UNIQUE NOT NULL,
   source_run_id TEXT NOT NULL,source_conversation_id TEXT NOT NULL,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
   agent_id TEXT NOT NULL,epoch INTEGER NOT NULL,policy_version INTEGER NOT NULL,source_version INTEGER NOT NULL,created_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS wb_memory_processing_owner ON wb_memory_processing_runs(owner_id,agent_id,created_at);
   CREATE TRIGGER IF NOT EXISTS wb_memory_processing_no_update BEFORE UPDATE ON wb_memory_processing_runs BEGIN SELECT RAISE(ABORT,'memory_processing_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_processing_no_delete BEFORE DELETE ON wb_memory_processing_runs BEGIN SELECT RAISE(ABORT,'memory_processing_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_processing_no_replace BEFORE INSERT ON wb_memory_processing_runs WHEN EXISTS(SELECT 1 FROM wb_memory_processing_runs WHERE processor_run_id=NEW.processor_run_id OR conversation_id=NEW.conversation_id OR capture_id=NEW.capture_id) BEGIN SELECT RAISE(ABORT,'memory_processing_immutable'); END;`);
 }
 private actor(owner:string,agentId:string){const actor=this.ports.actor(owner,agentId);if(actor.status!=='active')throw Error('agent_not_active');return actor;}
 private row(owner:string,agentId:string,captureId:string){return this.db.prepare('SELECT * FROM wb_memory_processing_runs WHERE owner_id=? AND agent_id=? AND capture_id=?').get(owner,agentId,captureId) as Row|undefined;}
 private view(row:Row){
  const run=this.db.prepare(`SELECT r.status,c.owner_id,c.workspace_id,c.project_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND r.conversation_id=?`).get(String(row.processor_run_id),String(row.conversation_id)) as Row|undefined;
  if(run&&(run.owner_id!==row.owner_id||run.workspace_id!==row.workspace_id||run.project_id!==row.project_id))throw Error('memory_processing_scope_conflict');
  return {capture_id:String(row.capture_id),processor_run_id:String(row.processor_run_id),conversation_id:String(row.conversation_id),source_run_id:String(row.source_run_id),agent_id:String(row.agent_id),project_id:String(row.project_id),workspace_id:String(row.workspace_id),policy_version:Number(row.policy_version),source_version:Number(row.source_version),epoch:Number(row.epoch),status:run?String(run.status):'missing',created_at:String(row.created_at)};
 }
 get(owner:string,agentId:string,captureId:string){const actor=this.actor(owner,agentId),row=this.row(owner,agentId,captureId);if(!row)throw Error('memory_processing_not_found');if(row.workspace_id!==actor.workspace_id||row.project_id!==actor.project_id)throw Error('memory_processing_scope_conflict');return this.view(row);}
 assertRun(owner:string,agentId:string,runId:string){const actor=this.actor(owner,agentId),row=assertMemoryProcessingIdentity(this.db,owner,runId);if(row.agent_id!==agentId||row.epoch!==actor.capability_epoch)throw Error('memory_processing_scope_conflict');const source=this.ports.source(owner,agentId,String(row.capture_id));if(!source.sources.length||source.sources.some(item=>!item.available))throw Error('memory_processing_source_unavailable');return row;}
 prepare(owner:string,agentId:string,captureId:string){return withImmediateTransaction(this.db,()=>{
  const actor=this.actor(owner,agentId),existing=this.row(owner,agentId,captureId);if(existing)return this.get(owner,agentId,captureId);
  const source=this.ports.source(owner,agentId,captureId);
  if(source.capture_id!==captureId||source.agent_id!==agentId||source.workspace_id!==actor.workspace_id||source.project_id!==actor.project_id||source.status!=='ready'||!source.policy_current||!source.sources.length||source.sources.some(item=>item.available!==true))throw Error('memory_processing_source_unavailable');
  const original=this.db.prepare(`SELECT r.status,c.owner_id,c.workspace_id,c.project_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND r.conversation_id=?`).get(source.source_run_id,source.source_conversation_id) as Row|undefined;
  if(!original||!['succeeded','partial'].includes(String(original.status))||original.owner_id!==owner||original.workspace_id!==actor.workspace_id||original.project_id!==actor.project_id)throw Error('memory_processing_source_unavailable');
  if(this.db.prepare(`SELECT 1 FROM ga_runs r JOIN wb_run_bindings b ON b.run_id=r.id WHERE b.owner_id=? AND b.agent_id=? AND r.status IN ('queued','starting','running','waiting_user','waiting_approval','cancelling') LIMIT 1`).get(owner,agentId))throw Error('memory_processing_busy');
  const run=this.ports.createRun(owner,actor);
  const created=this.db.prepare(`SELECT r.id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND r.conversation_id=? AND c.owner_id=? AND c.workspace_id=? AND c.project_id=? AND r.status='queued'`).get(run.run_id,run.conversation_id,owner,actor.workspace_id,actor.project_id);
  if(!created||run.run_id===source.source_run_id||run.conversation_id===source.source_conversation_id)throw Error('memory_processing_scope_conflict');
  this.db.prepare('INSERT INTO wb_memory_processing_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(run.run_id,run.conversation_id,captureId,source.source_run_id,source.source_conversation_id,owner,actor.workspace_id,actor.project_id,agentId,actor.capability_epoch,source.policy_version,source.version,new Date().toISOString());
  this.ports.bindRun(owner,agentId,run.run_id);return this.get(owner,agentId,captureId);
 });}
}
