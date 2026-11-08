import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';

type Scope = {owner_id:string;agent_id:string;run_id:string;session_ref:string};
type Row = Record<string,string|number|null>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const HASH = /^[a-f0-9]{64}$/;
const now = () => new Date().toISOString();
function fail(code:string):never {throw new Error(code);}
function object(value:unknown):Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('hook_operation_invalid');
  return value as Record<string,unknown>;
}
function exact(input:Record<string,unknown>,keys:string[]) {
  if (Object.keys(input).some(key=>!keys.includes(key))) fail('hook_operation_invalid');
}
function scope(value:Scope) {
  if (!value || ![value.owner_id,value.agent_id,value.run_id,value.session_ref].every(part=>typeof part==='string'&&ID.test(part))) fail('hook_operation_scope_invalid');
}
function same(row:Row,identity:Scope) {
  if (['owner_id','agent_id','run_id','session_ref'].some(key=>row[key]!==identity[key as keyof Scope])) fail('hook_operation_scope_invalid');
}
function project(row:Row,dispatch=false) {
  return {operation_id:String(row.operation_id),state:String(row.state),dispatch,
    ...(row.state==='settled'?{result:JSON.parse(String(row.result_json))}:{} )};
}

/** Original Gateway run custody owns Hook at-most-once dispatch and late settlement. */
export class HookExecutionJournal {
  constructor(private readonly db:DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS wb_hook_operations (
      operation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,agent_id TEXT NOT NULL,
      run_id TEXT NOT NULL,session_ref TEXT NOT NULL,
      hook_id TEXT NOT NULL,event_name TEXT NOT NULL,event_id TEXT NOT NULL,request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','settled','rejected','unknown')),
      result_json TEXT,result_hash TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(run_id,hook_id,event_name,event_id));
      CREATE INDEX IF NOT EXISTS wb_hook_operations_owner ON wb_hook_operations(owner_id,run_id,state)`);
  }
  prepare(identity:Scope,value:unknown) {
    scope(identity);
    const input=object(value);exact(input,['hook_id','event','event_id','request_hash']);
    if (typeof input.hook_id!=='string'||!HASH.test(input.hook_id)||typeof input.event_id!=='string'||!HASH.test(input.event_id)
      ||typeof input.request_hash!=='string'||!HASH.test(input.request_hash)||typeof input.event!=='string'
      ||!/^[A-Z][A-Za-z]{0,63}$/.test(input.event)) fail('hook_operation_invalid');
    return withImmediateTransaction(this.db,()=>{
      const old=this.db.prepare('SELECT * FROM wb_hook_operations WHERE run_id=? AND hook_id=? AND event_name=? AND event_id=?')
        .get(identity.run_id,input.hook_id,input.event,input.event_id) as Row|undefined;
      if (old) {
        same(old,identity);
        if (old.request_hash!==input.request_hash) fail('hook_operation_conflict');
        return project(old);
      }
      const operationId='hook-op-'+randomUUID(),time=now();
      this.db.prepare(`INSERT INTO wb_hook_operations(operation_id,owner_id,agent_id,run_id,session_ref,
        hook_id,event_name,event_id,request_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'prepared',?,?)`)
        .run(operationId,identity.owner_id,identity.agent_id,identity.run_id,identity.session_ref,input.hook_id,input.event,input.event_id,input.request_hash,time,time);
      return {operation_id:operationId,state:'prepared',dispatch:false,reserved:true};
    });
  }
  private row(identity:Scope,operationId:unknown):Row {
    scope(identity);
    if (typeof operationId!=='string'||!/^hook-op-[a-f0-9-]{36}$/.test(operationId)) fail('hook_operation_invalid');
    const row=this.db.prepare('SELECT * FROM wb_hook_operations WHERE operation_id=?').get(operationId) as Row|undefined;
    if (!row) fail('hook_operation_not_found');
    same(row,identity);return row;
  }
  read(identity:Scope,operationId:unknown) {return project(this.row(identity,operationId));}
  dispatch(identity:Scope,operationId:unknown) {
    return withImmediateTransaction(this.db,()=>{
      const row=this.row(identity,operationId);
      if (row.state!=='prepared') return project(row);
      const changed=this.db.prepare("UPDATE wb_hook_operations SET state='dispatched',updated_at=? WHERE operation_id=? AND state='prepared'")
        .run(now(),String(row.operation_id)).changes;
      if (changed!==1) fail('hook_operation_conflict');
      return project({...row,state:'dispatched'},true);
    });
  }
  finish(identity:Scope,value:unknown) {
    const input=object(value);exact(input,['operation_id','state','result']);
    if (!['settled','rejected','unknown'].includes(String(input.state)) || input.state!=='settled'&&Object.hasOwn(input,'result')) fail('hook_operation_invalid');
    let serialized:string|undefined,resultHash:string|undefined;
    if (input.state==='settled') {
      serialized=JSON.stringify(input.result);
      if (serialized===undefined||Buffer.byteLength(serialized,'utf8')>2*1024*1024) fail('hook_result_too_large');
      resultHash=createHash('sha256').update(serialized).digest('hex');
    }
    return withImmediateTransaction(this.db,()=>{
      const row=this.row(identity,input.operation_id);
      if (row.state==='settled') {
        if (input.state==='settled'&&row.result_hash!==resultHash) fail('hook_operation_result_conflict');
        return project(row);
      }
      if (row.state==='rejected') return project(row);
      if (input.state==='rejected'&&row.state!=='prepared' || input.state==='settled'&&!['dispatched','unknown'].includes(String(row.state))) fail('hook_operation_state_conflict');
      this.db.prepare('UPDATE wb_hook_operations SET state=?,result_json=?,result_hash=?,updated_at=? WHERE operation_id=?')
        .run(String(input.state),serialized??null,resultHash??null,now(),String(row.operation_id));
      return project({...row,state:String(input.state),result_json:serialized??null,result_hash:resultHash??null});
    });
  }
}
