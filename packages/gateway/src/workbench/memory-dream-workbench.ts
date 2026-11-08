import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import type {WorkbenchService} from './service.ts';
import {memoryExpired,serializeMemory,type MemoryRow} from './memory-lifecycle.ts';
import {createMemoryDreamTools,type MemoryDreamIdentity,type MemoryDreamToolPorts,type DreamProjectScope,type DreamProposalInput,type DreamMemoryRecord,type DreamConsolidationRecord} from './memory-dream-tools.ts';

type Row=Record<string,any>;
/** Concrete Workbench adapter. The existing pump supplies its original live
 * policy/lease/cancel guard; identity fields alone never grant permission.
 * No DDL, scheduler, run allocation, model, apply or memory write is added. */
export class MemoryDreamWorkbenchAdapter implements MemoryDreamToolPorts{
 private readonly db:DatabaseSync;private readonly workbench:WorkbenchService;private readonly identity:Readonly<MemoryDreamIdentity>;
 private readonly runId:string;private readonly guard:()=>void|Promise<void>;
 constructor(db:DatabaseSync,workbench:WorkbenchService,identity:MemoryDreamIdentity,runId:string,assertCurrent:()=>void|Promise<void>){
  if(typeof assertCurrent!=='function')throw Error('memory_dream_guard_required');this.db=db;this.workbench=workbench;this.identity=Object.freeze({...identity});this.runId=runId;this.guard=assertCurrent;
 }
 private binding(active:boolean){
  const i=this.identity,agent=this.workbench.getAgent(i.owner_id,i.agent_id),context=this.workbench.contextForRun(this.runId);
  if(agent.status!=='active'||agent.capability_epoch!==i.epoch||agent.project_id!==i.project_id||agent.workspace_id!==i.workspace_id||!context||context.owner_id!==i.owner_id||context.agent_id!==i.agent_id||context.project_id!==i.project_id||context.workspace_id!==i.workspace_id)throw Error('memory_dream_source_forbidden');
  if(active)this.workbench.assertRunActive(this.runId);
 }
 private async current(){await this.guard();this.binding(true);}
 private scope(scope:DreamProjectScope){const i=this.identity;if(scope.owner_id!==i.owner_id||scope.workspace_id!==i.workspace_id||scope.project_id!==i.project_id||scope.scope!=='project'||scope.agent_id!==null)throw Error('memory_dream_source_forbidden');}
 tools(){return createMemoryDreamTools(this.identity,this.runId,this,()=>this.current());}
 async list(scope:DreamProjectScope,input:{q?:string}):Promise<DreamMemoryRecord[]>{
  this.scope(scope);await this.current();const result=this.workbench.listMemory(scope.owner_id,scope.workspace_id,{scope:'project',project_id:scope.project_id,...input});await this.current();
  return result.items.flatMap(value=>{
   const row=this.db.prepare("SELECT * FROM wb_memories WHERE memory_id=? AND owner_id=? AND workspace_id=? AND project_id=? AND scope='project' AND agent_id IS NULL AND status='active'").get(String(value.memory_id),scope.owner_id,scope.workspace_id,scope.project_id) as MemoryRow|undefined;
   if(!row||memoryExpired(row)||Number(row.version)!==Number(value.version))return[];
   return[{memory_id:String(row.memory_id),owner_id:String(row.owner_id),workspace_id:String(row.workspace_id),project_id:String(row.project_id),scope:'project' as const,agent_id:null,version:Number(row.version),source_revision:row.source_revision===null?null:String(row.source_revision),content:String(row.content)}];
  });
 }
 private record(id:string):DreamConsolidationRecord{
  const i=this.identity,row=this.db.prepare('SELECT * FROM wb_memory_consolidations WHERE consolidation_id=? AND owner_id=? AND workspace_id=?').get(id,i.owner_id,i.workspace_id) as Row|undefined;
  if(!row||row.project_id!==i.project_id||row.scope!=='project'||row.agent_id!==null||row.run_id!==this.runId)throw Error('memory_dream_source_forbidden');
  return{consolidation_id:row.consolidation_id,owner_id:row.owner_id,workspace_id:row.workspace_id,project_id:row.project_id,scope:row.scope,agent_id:row.agent_id,run_id:row.run_id,status:row.status,version:Number(row.version)};
 }
 private sourcesCurrent(id:string){
  const i=this.identity,value=this.workbench.memoryConsolidations.get(i.owner_id,i.workspace_id,id);
  return value.sources.every(source=>{
   const row=this.db.prepare('SELECT * FROM wb_memories WHERE memory_id=? AND owner_id=? AND workspace_id=? AND project_id=?').get(String(source.memory_id),i.owner_id,i.workspace_id,i.project_id) as MemoryRow|undefined;
   const job=this.db.prepare('SELECT revision,tombstone FROM wb_memory_index_jobs WHERE memory_id=? AND owner_id=?').get(String(source.memory_id),i.owner_id) as Row|undefined;
   return row&&row.scope==='project'&&row.agent_id===null&&row.status==='active'&&!memoryExpired(row)&&Number(row.version)===source.version&&job?.tombstone===0&&job.revision===source.version&&canonicalJson(serializeMemory(row))===canonicalJson(source);
  });
 }
 private retrievalSourcesCurrent(){
  const i=this.identity,rows=this.db.prepare(`SELECT query,data_json FROM wb_memory_retrievals
   WHERE owner_id=? AND workspace_id=? AND project_id=? AND agent_id=? AND run_id=? AND kind='tool_query' ORDER BY sequence`).all(i.owner_id,i.workspace_id,i.project_id,i.agent_id,this.runId) as Row[];
  if(!rows.length)return false;
  for(const trace of rows){
   let data:Record<string,any>;try{data=JSON.parse(String(trace.data_json));}catch{return false;}
   if(!Array.isArray(data.references))return false;
   const query=String(trace.query),current=this.workbench.listMemory(i.owner_id,i.workspace_id,{scope:'project',project_id:i.project_id,...(query?{q:query}:{})}).items;
   if(current.length!==data.references.length)return false;
   for(let index=0;index<current.length;index++){
    const reference=data.references[index],item=current[index];
    if(!reference||reference.scope!=='project'||reference.memory_id!==item?.memory_id||Number(reference.version)!==Number(item?.version))return false;
   }
  }
  return true;
 }
 async stage(scope:DreamProjectScope,runId:string,input:{memory_ids:string[]}):Promise<DreamConsolidationRecord>{
  this.scope(scope);if(runId!==this.runId)throw Error('memory_dream_source_forbidden');await this.current();
  const result=withImmediateTransaction(this.db,()=>{this.binding(true);const value=this.workbench.memoryConsolidations.stage(scope.owner_id,scope.workspace_id,{scope:'project',project_id:scope.project_id,memory_ids:input.memory_ids},this.runId);return this.record(value.consolidation_id);});
  await this.current();return result;
 }
 async propose(scope:DreamProjectScope,runId:string,id:string,input:DreamProposalInput):Promise<DreamConsolidationRecord>{
  this.scope(scope);if(runId!==this.runId)throw Error('memory_dream_source_forbidden');await this.current();
  const result=withImmediateTransaction(this.db,()=>{this.binding(true);this.record(id);if(!this.sourcesCurrent(id))throw Error('memory_dream_source_changed');this.workbench.memoryConsolidations.propose(scope.owner_id,scope.workspace_id,id,input as unknown as Record<string,unknown>,this.runId);return this.record(id);});
  await this.current();return result;
 }
 /** Durable original proposal observation for pump recovery; no session replay,
  * apply, budget settlement or authority restoration occurs here. */
 readEvidence(id?:string){
  this.binding(false);const i=this.identity,rows=this.db.prepare(`SELECT consolidation_id FROM wb_memory_consolidations
   WHERE owner_id=? AND workspace_id=? AND project_id=? AND run_id=?`).all(i.owner_id,i.workspace_id,i.project_id,this.runId) as Row[];
  if(rows.length>1||id!==undefined&&(rows.length!==1||rows[0]?.consolidation_id!==id))throw Error('memory_dream_source_forbidden');
  const consolidation=rows.length?this.record(String(rows[0]!.consolidation_id)):null;
  return{run_id:this.runId,consolidation,source_current:this.retrievalSourcesCurrent()&&(!consolidation||this.sourcesCurrent(consolidation.consolidation_id))};
 }
}
