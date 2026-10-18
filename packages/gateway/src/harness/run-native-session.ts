import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {assertExecutionLease} from '../workbench/execution-lease.ts';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Pin the exact native identity before dispatch, under the original Worker
 * lease. A conversation pointer is initialization data, never recovery authority
 * once this run has a saved identity. This does not activate a native Session. */
export function pinRunNativeSession(db:DatabaseSync,runId:string,lease:unknown,sessionId:string){
 if(typeof sessionId!=='string'||!ID.test(sessionId))throw Error('run_native_session_invalid');
 return withImmediateTransaction(db,()=>{
  assertExecutionLease(db,runId,lease);
  const row=db.prepare(`SELECT r.native_session_ref,r.native_owner_id,r.native_conversation_id,r.conversation_id,r.status,c.owner_id,c.archived_at,b.session_id,b.owner_id AS binding_owner
   FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
   LEFT JOIN ga_harness_session_bindings b ON b.conversation_id=c.id WHERE r.id=?`).get(runId);
  if(!row||typeof row.owner_id!=='string'||typeof row.conversation_id!=='string'
   ||!['starting','running'].includes(String(row.status))||row.archived_at!==null
   ||row.native_session_ref!==null&&row.native_session_ref!==sessionId
   ||row.native_session_ref!==null&&(row.native_owner_id!==row.owner_id||row.native_conversation_id!==row.conversation_id)
   ||row.native_session_ref===null&&(row.native_owner_id!==null||row.native_conversation_id!==null)
   ||row.binding_owner!==null&&row.binding_owner!==row.owner_id
   ||row.native_session_ref===null&&row.session_id!==null&&row.session_id!==sessionId)throw Error('run_native_session_conflict');
  if(db.prepare(`SELECT 1 FROM ga_runs WHERE native_session_ref=? AND (native_conversation_id<>? OR native_owner_id<>?)
   UNION ALL SELECT 1 FROM ga_harness_session_bindings WHERE session_id=? AND (conversation_id<>? OR owner_id<>?) LIMIT 1`)
   .get(sessionId,row.conversation_id,row.owner_id,sessionId,row.conversation_id,row.owner_id))throw Error('run_native_session_conflict');
  if(row.native_session_ref===null)db.prepare('UPDATE ga_runs SET native_session_ref=?,native_owner_id=?,native_conversation_id=? WHERE id=? AND native_session_ref IS NULL').run(sessionId,row.owner_id,row.conversation_id,runId);
  return sessionId;
 });
}
