import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {assertExecutionLease,type ExecutionLease} from '../workbench/execution-lease.ts';

type Execution={execution_id:string;protocol:number;request_sha256:string;binding_sha256:string|null};
type Start={protocol:1;execution_id:string;request_sha256:string;binding_sha256:string;lease:ExecutionLease;started_at:string};
export type ProducerFinishState='failed_before_preparation'|'cancelled_before_preparation'|'prepared'|'unknown'|'applied';
type Finish={protocol:1;execution_id:string;producer_sha256:string;state:ProducerFinishState;finished_at:string};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Facts about the original effect owner, not a scheduler or a permission grant. */
export class GitIndexProducers{
 private readonly db:DatabaseSync;private readonly now:()=>number;
 constructor(db:DatabaseSync,now:()=>number){
  this.db=db;this.now=now;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_git_index_producers(execution_id TEXT PRIMARY KEY REFERENCES wb_git_index_executions(execution_id),record_json TEXT NOT NULL,record_sha256 TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_git_index_producer_finishes(execution_id TEXT PRIMARY KEY REFERENCES wb_git_index_producers(execution_id),record_json TEXT NOT NULL,record_sha256 TEXT NOT NULL);`);
  for(const table of ['wb_git_index_producers','wb_git_index_producer_finishes'])for(const kind of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${kind.toLowerCase()} BEFORE ${kind} ON ${table} BEGIN SELECT RAISE(ABORT,'git_execution_immutable'); END;`);
 }
 record(row:Execution){
  const record=this.db.prepare('SELECT * FROM wb_git_index_producers WHERE execution_id=?').get(row.execution_id) as {record_json:string;record_sha256:string}|undefined;
  if(!record){if(this.db.prepare('SELECT 1 FROM wb_git_index_producer_finishes WHERE execution_id=?').get(row.execution_id))throw Error('git_execution_producer_corrupt');return;}
  try{
   const start=JSON.parse(record.record_json) as Start;
   if(row.protocol!==4||digest(start)!==record.record_sha256||!start.lease||typeof start.lease.owner!=='string'||!/^git-executor-[a-f0-9-]{36}$/.test(start.lease.owner)||!Number.isSafeInteger(start.lease.generation)||start.lease.generation<1||typeof start.started_at!=='string'||!Number.isFinite(Date.parse(start.started_at))||JSON.stringify(start)!==JSON.stringify({protocol:1,execution_id:row.execution_id,request_sha256:row.request_sha256,binding_sha256:row.binding_sha256,lease:{owner:start.lease.owner,generation:start.lease.generation},started_at:start.started_at}))throw Error();
   const saved=this.db.prepare('SELECT * FROM wb_git_index_producer_finishes WHERE execution_id=?').get(row.execution_id) as {record_json:string;record_sha256:string}|undefined;
   if(!saved)return{start,sha256:record.record_sha256};
   const finish=JSON.parse(saved.record_json) as Finish;
   if(digest(finish)!==saved.record_sha256||!['failed_before_preparation','cancelled_before_preparation','prepared','unknown','applied'].includes(finish.state)||typeof finish.finished_at!=='string'||!Number.isFinite(Date.parse(finish.finished_at))||JSON.stringify(finish)!==JSON.stringify({protocol:1,execution_id:row.execution_id,producer_sha256:record.record_sha256,state:finish.state,finished_at:finish.finished_at}))throw Error();
   const has=(table:string)=>!!this.db.prepare('SELECT 1 FROM '+table+' WHERE execution_id=?').get(row.execution_id),prepared=has('wb_git_index_preparations'),dispatched=has('wb_git_index_dispatches');
   if((finish.state==='failed_before_preparation'||finish.state==='cancelled_before_preparation')&&(prepared||dispatched)||finish.state==='prepared'&&(!prepared||dispatched)||finish.state==='unknown'&&!dispatched||finish.state==='applied'&&!has('wb_git_index_outcomes'))throw Error();
   return{start,sha256:record.record_sha256,finish};
  }catch{throw Error('git_execution_producer_corrupt');}
 }
 view(row:Execution,resource:string){
  const record=this.record(row),base={execution_id:row.execution_id,execution_authorized:false as const};
  if(!record)return{...base,state:row.protocol<4?'legacy_untracked' as const:'not_started' as const};
  if(record.finish)return{...base,state:record.finish.state};
  try{assertExecutionLease(this.db,resource,record.start.lease,this.now);return{...base,state:'running' as const};}catch{return{...base,state:'interrupted' as const};}
 }
 assertStartable(row:Execution,resource:string){const state=this.view(row,resource).state;if(state==='running')throw Error('git_execution_busy');if(state==='interrupted')throw Error('git_execution_producer_unsettled');if(state==='legacy_untracked')throw Error('git_execution_producer_legacy');if(state!=='not_started')throw Error('git_execution_producer_closed');}
 start(row:Execution,resource:string,lease:ExecutionLease){
  this.assertStartable(row,resource);if(!this.db.isTransaction)throw Error('git_execution_transaction_required');assertExecutionLease(this.db,resource,lease,this.now);
  const start:Start={protocol:1,execution_id:row.execution_id,request_sha256:row.request_sha256,binding_sha256:row.binding_sha256!,lease:{...lease},started_at:new Date(this.now()).toISOString()};
  this.db.prepare('INSERT INTO wb_git_index_producers VALUES(?,?,?)').run(row.execution_id,JSON.stringify(start),digest(start));
 }
 finish(row:Execution,resource:string,lease:ExecutionLease,state:ProducerFinishState){
  if(!this.db.isTransaction)throw Error('git_execution_transaction_required');assertExecutionLease(this.db,resource,lease,this.now);
  const record=this.record(row);if(!record||record.finish||JSON.stringify(record.start.lease)!==JSON.stringify(lease))throw Error('git_execution_producer_corrupt');
  const finish:Finish={protocol:1,execution_id:row.execution_id,producer_sha256:record.sha256,state,finished_at:new Date(this.now()).toISOString()};
  this.db.prepare('INSERT INTO wb_git_index_producer_finishes VALUES(?,?,?)').run(row.execution_id,JSON.stringify(finish),digest(finish));this.record(row);
 }
}
