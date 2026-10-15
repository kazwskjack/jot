import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {memoryExpired,type MemoryRow,type MemoryRankReference} from './memory-lifecycle.ts';
export type RetrievalKind='context_snapshot'|'continuation_snapshot'|'tool_query';
export interface RetrievalReference extends MemoryRankReference {scope:'project'|'private';content_chars:number;truncated:boolean;provenance_truncated:boolean}
export interface RetrievalData {
 method:'scope_order'|'keyword'|'adapter'|'inherited';fallback_reason:'adapter_failed'|'invalid_adapter_result'|null;
 candidate_count:number;context_chars:number|null;excluded:{query_miss:number;result_limit:number;context_limit:number;duplicate:number;context_budget:number};references:RetrievalReference[];
}
type Row=Record<string,string|number|null>;
type Authorize=(owner:string,workspace:string,agentId:string)=>{project_id:string};
/** Immutable version references, not another copy of memory or a claim about Provider usage. */
export class MemoryRetrievalLog {
 private readonly db:DatabaseSync;
 private readonly authorize:Authorize;
 constructor(db:DatabaseSync,authorize:Authorize){
  this.db=db;this.authorize=authorize;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_memory_retrievals(
   sequence INTEGER PRIMARY KEY AUTOINCREMENT,retrieval_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,agent_id TEXT NOT NULL,project_id TEXT NOT NULL,
   run_id TEXT NOT NULL REFERENCES ga_runs(id),source_run_id TEXT,kind TEXT NOT NULL CHECK(kind IN ('context_snapshot','continuation_snapshot','tool_query')),
   query TEXT NOT NULL,observation_key TEXT NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(owner_id,run_id,observation_key));
   CREATE INDEX IF NOT EXISTS wb_memory_retrieval_scope ON wb_memory_retrievals(owner_id,workspace_id,agent_id,sequence DESC);
   CREATE TRIGGER IF NOT EXISTS wb_memory_retrievals_no_update BEFORE UPDATE ON wb_memory_retrievals BEGIN SELECT RAISE(ABORT,'memory_retrieval_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_retrievals_no_delete BEFORE DELETE ON wb_memory_retrievals BEGIN SELECT RAISE(ABORT,'memory_retrieval_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_memory_retrievals_no_replace BEFORE INSERT ON wb_memory_retrievals
    WHEN EXISTS(SELECT 1 FROM wb_memory_retrievals WHERE sequence=NEW.sequence OR retrieval_id=NEW.retrieval_id OR (owner_id=NEW.owner_id AND run_id=NEW.run_id AND observation_key=NEW.observation_key))
    BEGIN SELECT RAISE(ABORT,'memory_retrieval_immutable'); END;`);
 }
 record(owner:string,workspace:string,agentId:string,runId:string,kind:RetrievalKind,query:string,key:string,data:RetrievalData,sourceRunId:string|null=null):string{
  if(!this.db.isTransaction)throw new Error('memory_retrieval_transaction_required');
  const scope=this.authorize(owner,workspace,agentId);
  for(const id of [runId,...(sourceRunId?[sourceRunId]:[])])if(!this.db.prepare('SELECT 1 FROM wb_run_bindings WHERE owner_id=? AND agent_id=? AND run_id=?').get(owner,agentId,id))throw new Error('memory_scope_forbidden');
  const json=JSON.stringify(data),observation=kind==='tool_query'?key+':'+createHash('sha256').update(JSON.stringify([query,data])).digest('hex'):key;
  const prior=this.db.prepare('SELECT * FROM wb_memory_retrievals WHERE owner_id=? AND run_id=? AND observation_key=?').get(owner,runId,observation) as Row|undefined;
  if(prior){if(prior.workspace_id!==workspace||prior.agent_id!==agentId||prior.project_id!==scope.project_id||prior.kind!==kind||prior.query!==query||prior.data_json!==json||prior.source_run_id!==sourceRunId)throw new Error('memory_retrieval_conflict');return String(prior.retrieval_id);}
  const id='retrieval-'+randomUUID();this.db.prepare(`INSERT INTO wb_memory_retrievals(retrieval_id,owner_id,workspace_id,agent_id,project_id,run_id,source_run_id,kind,query,observation_key,data_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(id,owner,workspace,agentId,scope.project_id,runId,sourceRunId,kind,query,observation,json,new Date().toISOString());return id;
 }
 private header(row:Row){const {references,...data}=JSON.parse(String(row.data_json)) as RetrievalData;return {retrieval_id:String(row.retrieval_id),workspace_id:String(row.workspace_id),agent_id:String(row.agent_id),project_id:String(row.project_id),run_id:String(row.run_id),source_run_id:row.source_run_id===null?null:String(row.source_run_id),kind:row.kind,query:String(row.query),...data,result_count:references.length,created_at:String(row.created_at)};}
 list(owner:string,workspace:string,agentId:string,beforeId?:string){
  const scope=this.authorize(owner,workspace,agentId);let before:number|null=null;
  if(beforeId!==undefined){if(typeof beforeId!=='string'||!beforeId||beforeId.length>128)throw new Error('invalid_memory_retrieval_cursor');
   const cursor=this.db.prepare('SELECT sequence FROM wb_memory_retrievals WHERE owner_id=? AND workspace_id=? AND agent_id=? AND project_id=? AND retrieval_id=?').get(owner,workspace,agentId,scope.project_id,beforeId) as {sequence:number}|undefined;
   if(!cursor)throw new Error('memory_retrieval_not_found');before=cursor.sequence;
  }
  const rows=this.db.prepare(`SELECT * FROM wb_memory_retrievals WHERE owner_id=? AND workspace_id=? AND agent_id=? AND project_id=? AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT 26`).all(owner,workspace,agentId,scope.project_id,before,before) as Row[],page=rows.slice(0,25);
  return {items:page.map(row=>this.header(row)),next_before_id:rows.length>25?String(page.at(-1)!.retrieval_id):null};
 }
 get(owner:string,workspace:string,id:string){
  const row=this.db.prepare('SELECT * FROM wb_memory_retrievals WHERE owner_id=? AND workspace_id=? AND retrieval_id=?').get(owner,workspace,id) as Row|undefined;
  if(!row)throw new Error('memory_retrieval_not_found');const scope=this.authorize(owner,workspace,String(row.agent_id));if(scope.project_id!==row.project_id)throw new Error('memory_scope_forbidden');
  const data=JSON.parse(String(row.data_json)) as RetrievalData;
  const references=data.references.map(reference=>{
   const current=this.db.prepare(`SELECT * FROM wb_memories WHERE owner_id=? AND workspace_id=? AND project_id=? AND memory_id=? AND version=? AND status='active' AND (scope='project' OR (scope='private' AND agent_id=?))`).get(owner,workspace,scope.project_id,reference.memory_id,reference.version,String(row.agent_id)) as MemoryRow|undefined;
   const available=!!current&&!memoryExpired(current);
   return {...reference,available,...(available?{content_preview:String(current!.content).slice(0,Math.min(reference.content_chars,800)),provenance:(JSON.parse(String(current!.provenance_json??'[]')) as Array<{kind:string;reference:string}>).slice(0,3).map(source=>({kind:source.kind,reference:source.reference.slice(0,256)}))}:{})};
  });return {...this.header(row),references};
 }
}
