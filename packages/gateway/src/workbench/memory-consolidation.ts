import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {MemoryLifecycle,memoryExpired,serializeMemory,type MemoryRow} from './memory-lifecycle.ts';

type Input=Record<string,unknown>;
export interface ConsolidationScope {project_id:string;scope:'project'|'private';agent_id:string|null}
type Authorize=(owner:string,workspace:string,scope:ConsolidationScope,runId?:string)=>void;
type Change={action:'rewrite';memory_id:string;content:string}|{action:'supersede';memory_id:string;replacement_id:string};
type Result={memory_id:string;version:number;status:string};
type Batch=Record<string,string|number|null>;
const now=()=>new Date().toISOString();
const invalid=()=>{throw new Error('invalid_memory_consolidation');};
function exact(input:Input,keys:string[]){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))invalid();}
function label(value:unknown,max=128):string{if(typeof value!=='string'||!value.trim()||value.length>max)invalid();return (value as string).trim();}
function selection(input:Input):ConsolidationScope{
 const project_id=label(input.project_id);if(input.scope!=='project'&&input.scope!=='private')invalid();
 const agent_id=input.scope==='private'?label(input.agent_id):null;
 if(input.scope==='project'&&input.agent_id!=null)invalid();
 return {project_id,scope:input.scope as ConsolidationScope['scope'],agent_id};
}
function expected(value:unknown,actual:number){if(!Number.isSafeInteger(value)||Number(value)<1)invalid();if(value!==actual)throw new Error('version_conflict');}

/** A staged memory rewrite is a proposal, never a second Agent planner or an authorization source. */
export class MemoryConsolidationService {
 private readonly db:DatabaseSync;
 private readonly lifecycle:MemoryLifecycle;
 private readonly authorize:Authorize;
 constructor(db:DatabaseSync,lifecycle:MemoryLifecycle,authorize:Authorize){
  this.db=db;this.lifecycle=lifecycle;this.authorize=authorize;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_memory_consolidations(
   consolidation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,
   scope TEXT NOT NULL CHECK(scope IN ('project','private')),agent_id TEXT,run_id TEXT,
   status TEXT NOT NULL CHECK(status IN ('draft','proposed','applied','rolled_back','rejected')),version INTEGER NOT NULL CHECK(version>0),
   sources_json TEXT NOT NULL,proposal_json TEXT,results_json TEXT,rollback_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
   CHECK((scope='project' AND agent_id IS NULL) OR (scope='private' AND agent_id IS NOT NULL)));
   CREATE INDEX IF NOT EXISTS wb_memory_consolidation_scope ON wb_memory_consolidations(owner_id,workspace_id,project_id,scope,agent_id,created_at);
   CREATE TRIGGER IF NOT EXISTS wb_memory_consolidations_no_delete BEFORE DELETE ON wb_memory_consolidations BEGIN SELECT RAISE(ABORT,'memory_consolidation_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_consolidations_no_replace BEFORE INSERT ON wb_memory_consolidations
    WHEN EXISTS(SELECT 1 FROM wb_memory_consolidations WHERE consolidation_id=NEW.consolidation_id) BEGIN SELECT RAISE(ABORT,'memory_consolidation_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_consolidations_guard BEFORE UPDATE ON wb_memory_consolidations
    WHEN NEW.consolidation_id IS NOT OLD.consolidation_id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.workspace_id IS NOT OLD.workspace_id
     OR NEW.project_id IS NOT OLD.project_id OR NEW.scope IS NOT OLD.scope OR NEW.agent_id IS NOT OLD.agent_id OR NEW.run_id IS NOT OLD.run_id
     OR NEW.sources_json IS NOT OLD.sources_json OR NEW.created_at IS NOT OLD.created_at OR NEW.version!=OLD.version+1
     OR (OLD.proposal_json IS NOT NULL AND NEW.proposal_json IS NOT OLD.proposal_json)
     OR (OLD.results_json IS NOT NULL AND NEW.results_json IS NOT OLD.results_json)
     OR (OLD.rollback_json IS NOT NULL AND NEW.rollback_json IS NOT OLD.rollback_json)
     OR (NEW.proposal_json IS NOT OLD.proposal_json AND NOT(OLD.status='draft' AND NEW.status='proposed' AND NEW.proposal_json IS NOT NULL))
     OR (NEW.results_json IS NOT OLD.results_json AND NOT(OLD.status='proposed' AND NEW.status='applied' AND NEW.results_json IS NOT NULL))
     OR (NEW.rollback_json IS NOT OLD.rollback_json AND NOT(OLD.status='applied' AND NEW.status='rolled_back' AND NEW.rollback_json IS NOT NULL))
     OR NOT ((OLD.status='draft' AND NEW.status IN ('proposed','rejected')) OR (OLD.status='proposed' AND NEW.status IN ('applied','rejected')) OR (OLD.status='applied' AND NEW.status='rolled_back'))
    BEGIN SELECT RAISE(ABORT,'memory_consolidation_immutable'); END;`);
 }
 private row(owner:string,workspace:string,id:string,runId?:string):Batch{
  const row=this.db.prepare('SELECT * FROM wb_memory_consolidations WHERE owner_id=? AND workspace_id=? AND consolidation_id=?').get(owner,workspace,id) as Batch|undefined;
  if(!row)throw new Error('memory_consolidation_not_found');
  this.authorize(owner,workspace,selection(row),runId);
  if(runId&&row.run_id!==runId)throw new Error('memory_scope_forbidden');
  return row;
 }
 private value(row:Batch){return {
  consolidation_id:String(row.consolidation_id),workspace_id:String(row.workspace_id),project_id:String(row.project_id),scope:row.scope,agent_id:row.agent_id,
  status:row.status,version:Number(row.version),source_kind:row.run_id?'agent':'user',
  sources:(JSON.parse(String(row.sources_json)) as MemoryRow[]).map(source=>serializeMemory(source)),
  proposal:row.proposal_json===null?null:JSON.parse(String(row.proposal_json)),
  results:row.results_json===null?null:JSON.parse(String(row.results_json)),rollback_results:row.rollback_json===null?null:JSON.parse(String(row.rollback_json)),
  created_at:String(row.created_at),updated_at:String(row.updated_at)};}
 get(owner:string,workspace:string,id:string,runId?:string){return this.value(this.row(owner,workspace,id,runId));}
 list(owner:string,workspace:string,input:Input,runId?:string){
  exact(input,['project_id','scope','agent_id']);const scope=selection(input);this.authorize(owner,workspace,scope,runId);
  const rows=this.db.prepare(`SELECT * FROM wb_memory_consolidations WHERE owner_id=? AND workspace_id=? AND project_id=? AND scope=? AND agent_id IS ?
   AND (? IS NULL OR run_id=?) ORDER BY created_at DESC,consolidation_id DESC LIMIT 50`).all(owner,workspace,scope.project_id,scope.scope,scope.agent_id,runId??null,runId??null) as Batch[];
  return {items:rows.map(row=>{const {sources,proposal,results,rollback_results,...value}=this.value(row);return {...value,source_count:sources.length,summary:proposal?.summary??null,change_count:proposal?.changes.length??0};})};
 }
 stage(owner:string,workspace:string,input:Input,runId?:string){return withImmediateTransaction(this.db,()=>{
  exact(input,['project_id','scope','agent_id','memory_ids']);const scope=selection(input);this.authorize(owner,workspace,scope,runId);
  if(!Array.isArray(input.memory_ids)||input.memory_ids.length<1||input.memory_ids.length>25)invalid();
  const ids=(input.memory_ids as unknown[]).map(id=>label(id));if(new Set(ids).size!==ids.length)invalid();
  const pending=this.db.prepare(`SELECT count(*) n FROM wb_memory_consolidations WHERE owner_id=? AND workspace_id=? AND project_id=? AND scope=? AND agent_id IS ? AND status IN ('draft','proposed')`).get(owner,workspace,scope.project_id,scope.scope,scope.agent_id) as {n:number};
  if(pending.n>=10)throw new Error('memory_consolidation_pending_limit');
  const sources=ids.map(id=>{
   const row=this.db.prepare("SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND memory_id=? AND status='active'").get(owner,workspace,id) as MemoryRow|undefined;
   if(!row||memoryExpired(row))throw new Error('memory_not_found');
   if(row.project_id!==scope.project_id||row.scope!==scope.scope||row.agent_id!==scope.agent_id)throw new Error('memory_scope_forbidden');
   return row;
  });
  if(sources.reduce((sum,row)=>sum+String(row.content).length,0)>200000)throw new Error('memory_consolidation_source_limit');
  const id='consolidation-'+randomUUID(),at=now();
  this.db.prepare(`INSERT INTO wb_memory_consolidations VALUES(?,?,?,?,?,?,?,'draft',1,?,NULL,NULL,NULL,?,?)`).run(id,owner,workspace,scope.project_id,scope.scope,scope.agent_id,runId??null,JSON.stringify(sources),at,at);
  return this.get(owner,workspace,id,runId);
 });}
 propose(owner:string,workspace:string,id:string,input:Input,runId?:string){return withImmediateTransaction(this.db,()=>{
  exact(input,['expected_version','summary','changes']);const row=this.row(owner,workspace,id,runId);expected(input.expected_version,Number(row.version));
  if(row.status!=='draft')throw new Error('memory_consolidation_state_conflict');
  const summary=label(input.summary,2000),sources=JSON.parse(String(row.sources_json)) as MemoryRow[],allowed=new Set(sources.map(source=>String(source.memory_id)));
  if(!Array.isArray(input.changes)||input.changes.length>sources.length)invalid();
  const changes:Change[]=(input.changes as Input[]).map(change=>{
   if(!change||typeof change!=='object'||Array.isArray(change))invalid();const memory_id=label(change.memory_id);if(!allowed.has(memory_id))invalid();
   if(change.action==='rewrite'){exact(change,['action','memory_id','content']);return {action:'rewrite',memory_id,content:label(change.content,20000)};}
   if(change.action==='supersede'){exact(change,['action','memory_id','replacement_id']);const replacement_id=label(change.replacement_id);if(!allowed.has(replacement_id)||replacement_id===memory_id)invalid();return {action:'supersede',memory_id,replacement_id};}
   return invalid();
  });
  if(new Set(changes.map(change=>change.memory_id)).size!==changes.length)invalid();
  const removed=new Set(changes.filter(change=>change.action==='supersede').map(change=>change.memory_id));
  if(changes.some(change=>change.action==='supersede'&&removed.has(change.replacement_id)))invalid();
  if(changes.reduce((sum,change)=>sum+(change.action==='rewrite'?change.content.length:0),0)>200000)invalid();
  this.db.prepare("UPDATE wb_memory_consolidations SET proposal_json=?,status='proposed',version=version+1,updated_at=? WHERE consolidation_id=?").run(JSON.stringify({summary,changes}),now(),id);
  return this.get(owner,workspace,id,runId);
 });}
 private live(owner:string,workspace:string,source:MemoryRow,version:number,status:string):MemoryRow{
  const row=this.db.prepare('SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND memory_id=?').get(owner,workspace,String(source.memory_id)) as MemoryRow|undefined;
  if(!row||Number(row.version)!==version)throw new Error('version_conflict');
  if(row.project_id!==source.project_id||row.scope!==source.scope||row.agent_id!==source.agent_id||row.status!==status||memoryExpired(row)||memoryExpired(source))throw new Error('memory_consolidation_source_conflict');
  return row;
 }
 private revise(owner:string,row:MemoryRow,changes:Partial<MemoryRow>):Result{
  const value={...row,...changes},at=now();
  const result=this.db.prepare(`UPDATE wb_memories SET content=?,verified=?,verified_at=?,provenance_json=?,source_revision=?,expires_at=?,supersedes=?,status=?,version=version+1,updated_at=? WHERE owner_id=? AND memory_id=? AND version=?`)
   .run(String(value.content),Number(value.verified),value.verified_at??null,String(value.provenance_json),value.source_revision??null,value.expires_at??null,value.supersedes??null,String(value.status),at,owner,String(row.memory_id),Number(row.version));
  if(Number(result.changes)!==1)throw new Error('version_conflict');
  const saved=this.db.prepare('SELECT * FROM wb_memories WHERE owner_id=? AND memory_id=?').get(owner,String(row.memory_id)) as MemoryRow;
  this.lifecycle.record(saved);return {memory_id:String(saved.memory_id),version:Number(saved.version),status:String(saved.status)};
 }
 apply(owner:string,workspace:string,id:string,expectedVersion:number){return withImmediateTransaction(this.db,()=>{
  const row=this.row(owner,workspace,id);expected(expectedVersion,Number(row.version));if(row.status!=='proposed')throw new Error('memory_consolidation_state_conflict');
  const sources=JSON.parse(String(row.sources_json)) as MemoryRow[],current=new Map<string,MemoryRow>();
  for(const source of sources){const value=this.live(owner,workspace,source,Number(source.version),'active');if(JSON.stringify(value)!==JSON.stringify(source))throw new Error('memory_consolidation_source_conflict');current.set(String(source.memory_id),value);}
  const proposal=JSON.parse(String(row.proposal_json)) as {changes:Change[]};
  const results=proposal.changes.map(change=>this.revise(owner,current.get(change.memory_id)!,change.action==='rewrite'?{content:change.content,verified:0,verified_at:null}:{status:'superseded'}));
  this.db.prepare("UPDATE wb_memory_consolidations SET results_json=?,status='applied',version=version+1,updated_at=? WHERE consolidation_id=?").run(JSON.stringify(results),now(),id);
  return this.get(owner,workspace,id);
 });}
 rollback(owner:string,workspace:string,id:string,expectedVersion:number){return withImmediateTransaction(this.db,()=>{
  const row=this.row(owner,workspace,id);expected(expectedVersion,Number(row.version));if(row.status!=='applied')throw new Error('memory_consolidation_state_conflict');
  const sources=new Map((JSON.parse(String(row.sources_json)) as MemoryRow[]).map(source=>[String(source.memory_id),source])),results=JSON.parse(String(row.results_json)) as Result[];
  const live=results.map(result=>this.live(owner,workspace,sources.get(result.memory_id)!,result.version,result.status));
  const restored=live.map(current=>{
   const source=sources.get(String(current.memory_id))!;
   const expiry=current.expires_at===null?source.expires_at:source.expires_at===null?current.expires_at:String(current.expires_at)<String(source.expires_at)?current.expires_at:source.expires_at;
   return this.revise(owner,current,{...source,expires_at:expiry,verified:0,verified_at:null,status:'active'});
  });
  this.db.prepare("UPDATE wb_memory_consolidations SET rollback_json=?,status='rolled_back',version=version+1,updated_at=? WHERE consolidation_id=?").run(JSON.stringify(restored),now(),id);
  return this.get(owner,workspace,id);
 });}
 reject(owner:string,workspace:string,id:string,expectedVersion:number){return withImmediateTransaction(this.db,()=>{
  const row=this.row(owner,workspace,id);expected(expectedVersion,Number(row.version));if(row.status!=='draft'&&row.status!=='proposed')throw new Error('memory_consolidation_state_conflict');
  this.db.prepare("UPDATE wb_memory_consolidations SET status='rejected',version=version+1,updated_at=? WHERE consolidation_id=?").run(now(),id);return this.get(owner,workspace,id);
 });}
}
