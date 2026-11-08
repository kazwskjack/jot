import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {validateChannelMatrixTerminalRefusal, type ChannelMatrixTerminalRefusal} from './runtime-contracts.ts';

type Row=Record<string,unknown>;
type Cursor=Readonly<{next_batch:string|null;generation:number}>;
type CommitInput=Readonly<{account_id:string;expected_next_batch:string|null;expected_generation:number;
 next_batch:string;terminal_refusals:readonly ChannelMatrixTerminalRefusal[]}>;

const CURSORS_SQL=`CREATE TABLE IF NOT EXISTS ga_matrix_poll_cursors(
 account_id TEXT PRIMARY KEY,
 next_batch TEXT NOT NULL CHECK(length(next_batch) BETWEEN 1 AND 1024),
 generation INTEGER NOT NULL CHECK(generation>0),
 updated_at INTEGER NOT NULL CHECK(updated_at>=0)
)`;
const REFUSALS_SQL=`CREATE TABLE IF NOT EXISTS ga_matrix_poll_refusals(
 account_id TEXT NOT NULL,
 provider_message_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL CHECK(length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^a-f0-9]*'),
 status_code INTEGER NOT NULL CHECK(status_code BETWEEN 400 AND 499),
 error_code TEXT NOT NULL,
 created_at INTEGER NOT NULL CHECK(created_at>=0),
 PRIMARY KEY(account_id,provider_message_id)
)`;
const REFUSAL_IMMUTABLE_SQL=`CREATE TRIGGER IF NOT EXISTS ga_matrix_poll_refusal_immutable
 BEFORE UPDATE ON ga_matrix_poll_refusals
 BEGIN SELECT RAISE(ABORT,'matrix_refusal_immutable'); END`;
const normalizeSql=(value:string)=>value.replace(/\s+/g,'').toLowerCase();
const fail=(code:string):never=>{throw Error(code);};
const OPAQUE=/^[^\u0000-\u001f\u007f]{1,1024}$/u;
const MATRIX_ACCOUNT=/^@[A-Za-z0-9._=:+/-]{1,255}$/;

function requireAccountId(value:unknown):asserts value is string{
 if(typeof value!=='string'||!MATRIX_ACCOUNT.test(value)||!value.includes(':')||value!==value.trim())fail('matrix_account_id_invalid');
}
function requireCursor(value:unknown,nullable=false):asserts value is string|null{
 if(nullable&&value===null)return;
 if(typeof value!=='string'||!OPAQUE.test(value)||value!==value.trim())fail('matrix_sync_cursor_invalid');
}
function requireGeneration(value:unknown,allowZero=true):asserts value is number{
 if(!Number.isSafeInteger(value)||Number(value)<(allowZero?0:1))fail('matrix_cursor_generation_invalid');
}
function installTable(db:DatabaseSync,name:string,expected:string):void{
 db.exec(expected);
 const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as Row|undefined;
 const actual=typeof row?.sql==='string'?row.sql:'';
 if(!actual||normalizeSql(actual)!==normalizeSql(expected.replace('IF NOT EXISTS','')))fail('matrix_sync_schema_mismatch');
}

/** Durable Matrix sync position and exact terminal event refusals, separate from Weixin cursors. */
export class MatrixSyncState{
 private readonly db:DatabaseSync;
 private readonly now:()=>number;
 constructor(db:DatabaseSync,now:()=>number=()=>Math.floor(Date.now()/1000)){
  if(!db||typeof db.prepare!=='function'||typeof now!=='function')fail('matrix_sync_state_invalid');
  this.db=db;this.now=now;
  installTable(db,'ga_matrix_poll_cursors',CURSORS_SQL);
  installTable(db,'ga_matrix_poll_refusals',REFUSALS_SQL);
  db.exec(REFUSAL_IMMUTABLE_SQL);
  const trigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='ga_matrix_poll_refusal_immutable'").get() as Row|undefined;
  if(typeof trigger?.sql!=='string'||normalizeSql(trigger.sql)!==normalizeSql(REFUSAL_IMMUTABLE_SQL.replace('IF NOT EXISTS',''))){
   fail('matrix_sync_schema_mismatch');
  }
 }
 load(accountId:string):Cursor{
  requireAccountId(accountId);
  const row=this.db.prepare('SELECT next_batch,generation FROM ga_matrix_poll_cursors WHERE account_id=?').get(accountId) as Row|undefined;
  if(!row)return {next_batch:null,generation:0};
  requireCursor(row.next_batch);requireGeneration(Number(row.generation),false);
  return {next_batch:String(row.next_batch),generation:Number(row.generation)};
 }
 findTerminalRefusal(accountId:string,providerMessageId:string,sourceSha256:string):ChannelMatrixTerminalRefusal|null{
  requireAccountId(accountId);
  if(typeof providerMessageId!=='string'||!/^\$[A-Za-z0-9._=:+/-]{1,255}$/.test(providerMessageId)
   ||typeof sourceSha256!=='string'||!/^[a-f0-9]{64}$/.test(sourceSha256))fail('matrix_terminal_refusal_invalid');
  const row=this.db.prepare(`SELECT provider_message_id,source_sha256,status_code,error_code
   FROM ga_matrix_poll_refusals WHERE account_id=? AND provider_message_id=?`).get(accountId,providerMessageId) as Row|undefined;
  if(!row)return null;
  const refusal=validateChannelMatrixTerminalRefusal({provider_message_id:row.provider_message_id,
   source_sha256:row.source_sha256,status_code:Number(row.status_code),error_code:row.error_code});
  if(refusal.source_sha256!==sourceSha256)fail('matrix_refusal_source_conflict');
  return refusal;
 }
 commitBatch(input:CommitInput):Cursor{
  if(!input||typeof input!=='object'||Array.isArray(input))fail('matrix_sync_batch_invalid');
  requireAccountId(input.account_id);requireCursor(input.expected_next_batch,true);requireCursor(input.next_batch);
  requireGeneration(input.expected_generation);
  if((input.expected_generation===0)!==(input.expected_next_batch===null)
   ||!Array.isArray(input.terminal_refusals)||input.terminal_refusals.length>10000)fail('matrix_sync_batch_invalid');
  const refusals=input.terminal_refusals.map(validateChannelMatrixTerminalRefusal);
  const seen=new Set<string>();
  for(const refusal of refusals){
   if(seen.has(refusal.provider_message_id))fail('matrix_sync_batch_invalid');
   seen.add(refusal.provider_message_id);
  }
  const timestamp=this.now();
  if(!Number.isSafeInteger(timestamp)||timestamp<0)fail('matrix_sync_clock_invalid');
  return withImmediateTransaction(this.db,()=>{
   const current=this.load(input.account_id);
   if(current.next_batch!==input.expected_next_batch||current.generation!==input.expected_generation)fail('matrix_cursor_conflict');
   for(const refusal of refusals){
    const existing=this.findTerminalRefusal(input.account_id,refusal.provider_message_id,refusal.source_sha256);
    if(existing){
     if(existing.status_code!==refusal.status_code||existing.error_code!==refusal.error_code)fail('matrix_refusal_receipt_conflict');
     continue;
    }
    this.db.prepare(`INSERT INTO ga_matrix_poll_refusals
     (account_id,provider_message_id,source_sha256,status_code,error_code,created_at) VALUES(?,?,?,?,?,?)`)
     .run(input.account_id,refusal.provider_message_id,refusal.source_sha256,refusal.status_code,refusal.error_code,timestamp);
   }
   const next:Cursor={next_batch:input.next_batch,generation:current.generation+1};
   if(current.generation===0){
    this.db.prepare('INSERT INTO ga_matrix_poll_cursors(account_id,next_batch,generation,updated_at) VALUES(?,?,?,?)')
     .run(input.account_id,next.next_batch,next.generation,timestamp);
   }else{
    const result=this.db.prepare(`UPDATE ga_matrix_poll_cursors SET next_batch=?,generation=?,updated_at=?
     WHERE account_id=? AND next_batch=? AND generation=?`).run(next.next_batch,next.generation,timestamp,
      input.account_id,current.next_batch,current.generation);
    if(Number(result.changes)!==1)fail('matrix_cursor_conflict');
   }
   return next;
  });
 }
}
