import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction,withReadTransaction} from '../db/database.ts';
import {assertExecutionLease} from './execution-lease.ts';
import {assertNativeRun,assertNativeSnapshot,type NativeReservation} from './native-child-identity.ts';

type Input=Record<string,unknown>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
export interface NativeMemberControlClient{
 listNativeMembers(sessionId:string,signal?:AbortSignal):Promise<unknown>;
 interruptNativeMember(sessionId:string,childSessionId:string,requestId:string,signal?:AbortSignal):Promise<unknown>;
}

/** Owner-authorized wake commands for the exact current native child run. */
export class NativeMemberOwnerControls {
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS wb_native_member_interrupt_receipts(
  root_run_id TEXT NOT NULL REFERENCES ga_runs(id),owner_id TEXT NOT NULL,parent_session_ref TEXT NOT NULL,
  child_run_id TEXT NOT NULL REFERENCES ga_runs(id),child_session_ref TEXT NOT NULL,role_id TEXT NOT NULL,
  request_id TEXT NOT NULL,payload_sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('dispatching','accepted','unknown')),
  created_at TEXT NOT NULL,completed_at TEXT,PRIMARY KEY(root_run_id,request_id));
  CREATE TRIGGER IF NOT EXISTS wb_native_member_interrupt_identity BEFORE UPDATE ON wb_native_member_interrupt_receipts
   WHEN OLD.root_run_id IS NOT NEW.root_run_id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.parent_session_ref IS NOT NEW.parent_session_ref
    OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.child_session_ref IS NOT NEW.child_session_ref OR OLD.role_id IS NOT NEW.role_id
    OR OLD.request_id IS NOT NEW.request_id OR OLD.payload_sha256 IS NOT NEW.payload_sha256
    OR OLD.state<>'dispatching' OR NEW.state NOT IN ('accepted','unknown')
   BEGIN SELECT RAISE(ABORT,'native_member_interrupt_receipt_immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wb_native_member_interrupt_no_delete BEFORE DELETE ON wb_native_member_interrupt_receipts
   BEGIN SELECT RAISE(ABORT,'native_member_interrupt_receipt_immutable'); END;`);}

 async list(ownerId:string,runId:string,client:NativeMemberControlClient|undefined){
  if(!ID.test(ownerId)||!ID.test(runId))throw Error('invalid_native_member_message');
  if(typeof client?.listNativeMembers!=='function')throw Error('native_member_control_unavailable');
  const parent=this.parent(ownerId,runId),raw=await client.listNativeMembers(parent.session_id,AbortSignal.timeout(10000));
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('native_member_roster_invalid');
  const value=raw as Input;
  if(Object.keys(value).sort().join(',')!=='execution_authorized,members'||value.execution_authorized!==false||!Array.isArray(value.members))throw Error('native_member_roster_invalid');
  const known=this.db.prepare(`SELECT n.child_session_ref FROM wb_native_execution_runs n JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.owner_id=n.owner_id AND b.kind='native_team'
   JOIN wb_native_spawn_publications p ON p.reservation_id=n.reservation_id WHERE n.owner_id=? AND n.root_run_id=?
    AND NOT EXISTS(SELECT 1 FROM wb_native_child_activations a WHERE a.previous_run_id=n.run_id)`).all(ownerId,runId) as Array<{child_session_ref:string}>;
  const knownIds=new Set(known.map(row=>row.child_session_ref)),seen=new Set<string>(),members=[];
  for(const item of value.members){
   const row=item as Input;
   if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='id,name,role,status'
    ||typeof row.id!=='string'||!ID.test(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>80||row.role!=='teammate'
    ||typeof row.status!=='string'||!row.status||row.status.length>64||seen.has(row.id))throw Error('native_member_roster_invalid');
   seen.add(row.id);if(!knownIds.has(row.id))continue;
   const child=this.child(ownerId,runId,row.id,true),publication=JSON.parse(child.publication_json) as Input,member=publication.member as Input|undefined;
   if(member?.id!==row.id||member.name!==row.name||member.role!=='teammate')throw Error('native_member_roster_invalid');
   members.push({child_session_ref:row.id,name:row.name,role:'teammate' as const,status:row.status});
  }
  return {members,execution_authorized:false as const};
 }

 /** Read immutable ownership/publication bindings, including closed executions. */
 execution(ownerId:string,runId:string,childSessionRef:string,childRunId?:string){
  if(!ID.test(ownerId)||!ID.test(runId)||!ID.test(childSessionRef)||(childRunId!==undefined&&(typeof childRunId!=='string'||!ID.test(childRunId))))throw Error('invalid_native_member_message');
  return withReadTransaction(this.db,()=>{
   const parent=this.parent(ownerId,runId);
   return readNativeMemberExecution(this.db,ownerId,runId,childSessionRef,parent.session_id,childRunId);
  });
 }

 parentHistory(ownerId:string,conversationId:string,query:{cursor?:unknown;limit?:unknown}={}){
  if(!ID.test(ownerId)||!ID.test(conversationId))throw Error('invalid_native_member_history');
  const cursor=query.cursor,limit=query.limit===undefined?25:Number(query.limit);
  if(cursor!==undefined&&(typeof cursor!=='string'||!ID.test(cursor))
   ||query.limit!==undefined&&typeof query.limit!=='number'&&typeof query.limit!=='string'
   ||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('invalid_native_member_history');
  return withReadTransaction(this.db,()=>{
   if(!this.db.prepare('SELECT 1 FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId,ownerId))throw Error('conversation_not_found');
   const scope=`FROM ga_runs r JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=? AND b.kind='task'
    JOIN ga_run_native_sessions s ON s.run_id=r.id AND s.conversation_id=r.conversation_id AND s.owner_id=b.owner_id
    WHERE r.conversation_id=? AND EXISTS(SELECT 1 FROM wb_native_execution_runs n
     JOIN wb_native_spawn_publications p ON p.reservation_id=n.reservation_id WHERE n.owner_id=b.owner_id AND n.root_run_id=r.id)`;
   const boundary=cursor===undefined?undefined:this.db.prepare(`SELECT r.created_at ${scope} AND r.id=?`).get(ownerId,conversationId,cursor as string) as {created_at:string}|undefined;
   if(cursor!==undefined&&!boundary)throw Error('invalid_native_member_history');
   const rows=this.db.prepare(`SELECT r.id run_id,r.conversation_id,r.created_at,r.status,r.version ${scope}
    ${boundary?'AND (r.created_at<? OR (r.created_at=? AND r.id<?))':''}
    ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).all(ownerId,conversationId,
     ...(boundary?[boundary.created_at,boundary.created_at,cursor as string]:[]),limit+1) as
     Array<{run_id:string;conversation_id:string;created_at:string;status:string;version:number}>;
   const selected=rows.slice(0,limit),last=selected.at(-1);
   return {conversation_id:conversationId,execution_authorized:false as const,items:selected,
    ...(rows.length>limit&&last?{next_cursor:last.run_id}:{})};
  });
 }

 executionHistory(ownerId:string,runId:string,query:{cursor?:unknown;limit?:unknown}={}){
  if(!ID.test(ownerId)||!ID.test(runId))throw Error('invalid_native_member_message');
  const cursor=query.cursor;
  if(cursor!==undefined&&(typeof cursor!=='string'||!ID.test(cursor))
   ||query.limit!==undefined&&typeof query.limit!=='string'&&typeof query.limit!=='number')throw Error('invalid_native_member_history');
  const limit=query.limit===undefined?25:Number(query.limit);
  if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('invalid_native_member_history');
  return withReadTransaction(this.db,()=>{
   const parent=this.parent(ownerId,runId);
   if(cursor!==undefined&&!this.db.prepare(`SELECT 1 FROM wb_native_execution_runs n
    JOIN wb_native_spawn_publications p ON p.reservation_id=n.reservation_id
    WHERE n.owner_id=? AND n.root_run_id=? AND n.run_id=?`).get(ownerId,runId,cursor as string))throw Error('invalid_native_member_history');
   const rows=this.db.prepare(`SELECT n.run_id,n.child_session_ref FROM wb_native_execution_runs n
    JOIN wb_native_spawn_publications p ON p.reservation_id=n.reservation_id
    WHERE n.owner_id=? AND n.root_run_id=? ${cursor===undefined?'':'AND n.run_id>?'}
    ORDER BY n.run_id LIMIT ?`).all(ownerId,runId,...(cursor===undefined?[]:[cursor as string]),limit+1) as Array<{run_id:string;child_session_ref:string}>;
   const selected=rows.slice(0,limit),last=selected.at(-1);
   return {root_run_id:runId,execution_authorized:false as const,
    items:selected.map(row=>readNativeMemberExecution(this.db,ownerId,runId,row.child_session_ref,parent.session_id,row.run_id)),
    ...(rows.length>limit&&last?{next_cursor:last.run_id}:{})};
  });
 }

 async interrupt(ownerId:string,runId:string,childSessionRef:string,input:Input,idempotencyKey:string,client:NativeMemberControlClient|undefined){
  if(!ID.test(ownerId)||!ID.test(runId)||!ID.test(childSessionRef)||!input||typeof input!=='object'||Array.isArray(input)
   ||Object.keys(input).sort().join(',')!=='expected_run_version,request_id'||typeof input.request_id!=='string'||!ID.test(input.request_id)
   ||!Number.isSafeInteger(input.expected_run_version)||Number(input.expected_run_version)<1||idempotencyKey!==input.request_id)throw Error('invalid_native_member_interrupt');
  const requestId=String(input.request_id),payloadSha256=hash(JSON.stringify({operation:'interrupt',child_session_ref:childSessionRef,expected_run_version:Number(input.expected_run_version)}));
  const prepared=withImmediateTransaction(this.db,()=>{
   const parent=this.parent(ownerId,runId);
   const prior=this.db.prepare('SELECT owner_id,parent_session_ref,child_run_id,child_session_ref,role_id,payload_sha256,state FROM wb_native_member_interrupt_receipts WHERE root_run_id=? AND request_id=?')
    .get(runId,requestId) as {owner_id:string;parent_session_ref:string;child_run_id:string;child_session_ref:string;role_id:string;payload_sha256:string;state:'dispatching'|'accepted'|'unknown'}|undefined;
   if(prior){
    const bound=this.db.prepare(`SELECT n.role_id,n.child_session_ref FROM wb_native_execution_runs n
     JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.owner_id=n.owner_id AND b.kind='native_team'
     WHERE n.owner_id=? AND n.root_run_id=? AND n.run_id=?`).get(ownerId,runId,prior.child_run_id) as {role_id:string;child_session_ref:string}|undefined;
    if(prior.owner_id!==ownerId||prior.parent_session_ref!==parent.session_id||prior.child_session_ref!==childSessionRef
     ||prior.payload_sha256!==payloadSha256||!bound||bound.role_id!==prior.role_id||bound.child_session_ref!==prior.child_session_ref)throw Error('idempotency_conflict');
    return {receipt:this.interruptReceipt(requestId,prior.state==='accepted'?'accepted':'unknown')};
   }
   if(this.db.prepare('SELECT 1 FROM ga_run_commands WHERE run_id=? AND idempotency_key=?').get(runId,`native-member:${requestId}`))throw Error('idempotency_conflict');
   if(!['starting','running'].includes(parent.status))throw Error('run_state_conflict');
   if(Number(parent.version)!==Number(input.expected_run_version))throw Error('run_version_conflict');
   if(typeof client?.interruptNativeMember!=='function')throw Error('native_member_control_unavailable');
   const child=this.child(ownerId,runId,childSessionRef),publication=JSON.parse(child.publication_json) as Input,member=publication.member as Input|undefined;
   if(member?.id!==childSessionRef||typeof member.name!=='string'||member.role!=='teammate')throw Error('native_member_not_found');
   this.db.prepare('INSERT INTO wb_native_member_interrupt_receipts(root_run_id,owner_id,parent_session_ref,child_run_id,child_session_ref,role_id,request_id,payload_sha256,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(runId,ownerId,parent.session_id,child.run_id,childSessionRef,child.role_id,requestId,payloadSha256,'dispatching',new Date().toISOString());
   return {sessionId:parent.session_id};
  });
  if('receipt' in prepared)return prepared.receipt;
  try{
   const raw=await client!.interruptNativeMember(prepared.sessionId,childSessionRef,requestId,AbortSignal.timeout(20000));
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('native_member_interrupt_receipt_invalid');
   const receipt=raw as Input;
   if(Object.keys(receipt).sort().join(',')!=='execution_authorized,quiescent,request_id,status'||receipt.execution_authorized!==false
    ||receipt.request_id!==requestId||receipt.status!=='accepted'||receipt.quiescent!==false)throw Error('native_member_interrupt_receipt_invalid');
   return this.finishInterrupt(runId,requestId,'accepted');
  }catch{return this.finishInterrupt(runId,requestId,'unknown');}
 }

 wake(ownerId:string,runId:string,childSessionRef:string,input:Input,idempotencyKey:string){
  if(!ID.test(ownerId)||!ID.test(runId)||!ID.test(childSessionRef)||!input||typeof input!=='object'||Array.isArray(input)
   ||Object.keys(input).sort().join(',')!=='expected_run_version,request_id,text'||typeof input.request_id!=='string'||!ID.test(input.request_id)
   ||!Number.isSafeInteger(input.expected_run_version)||Number(input.expected_run_version)<1||typeof input.text!=='string'||!input.text.trim()
   ||Buffer.byteLength(input.text,'utf8')>32768||idempotencyKey!==input.request_id)throw Error('invalid_native_member_message');
  return withImmediateTransaction(this.db,()=>{
   const parent=this.db.prepare(`SELECT r.status,r.version,n.session_id
    FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
    JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=c.owner_id AND b.kind='task'
    JOIN ga_run_native_sessions n ON n.run_id=r.id AND n.conversation_id=c.id AND n.owner_id=c.owner_id
    WHERE r.id=? AND c.owner_id=?`).get(runId,ownerId) as {status:string;version:number;session_id:string}|undefined;
   if(!parent)throw Error('run_not_found');
   const key=`native-member:${input.request_id}`;
   if(this.db.prepare('SELECT 1 FROM wb_native_member_interrupt_receipts WHERE root_run_id=? AND request_id=?').get(runId,String(input.request_id)))throw Error('idempotency_conflict');
   const existing=this.db.prepare("SELECT id,payload_json FROM ga_run_commands WHERE run_id=? AND kind='native_member_control' AND idempotency_key=?").get(runId,key) as {id:string;payload_json:string}|undefined;
   if(existing){const payload=JSON.parse(existing.payload_json) as Input;if(Object.keys(payload).sort().join(',')!=='child_run_id,child_session_ref,operation,request_id,role_ref,text'
    ||payload.operation!=='wake'||payload.request_id!==input.request_id||payload.child_session_ref!==childSessionRef
    ||typeof payload.child_run_id!=='string'||!ID.test(payload.child_run_id)||typeof payload.role_ref!=='string'||!ID.test(payload.role_ref)||payload.text!==input.text)throw Error('idempotency_conflict');
    return {accepted:true,command_id:existing.id,run_id:runId,request_id:input.request_id};}
   const child=this.child(ownerId,runId,childSessionRef,true);
   const payload={operation:'wake',request_id:input.request_id,child_session_ref:childSessionRef,child_run_id:child.run_id,role_ref:child.role_id,text:input.text};
   if(!['starting','running'].includes(parent.status))throw Error('run_state_conflict');
   if(Number(parent.version)!==Number(input.expected_run_version))throw Error('run_version_conflict');
   const now=new Date().toISOString(),commandId=`cmd-${randomUUID()}`;
   this.db.prepare('INSERT INTO ga_run_commands(id,run_id,kind,payload_json,status,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(commandId,runId,'native_member_control',JSON.stringify(payload),'pending',key,now);
   return {accepted:true,command_id:commandId,run_id:runId,request_id:input.request_id};
  });
 }

 private finishInterrupt(runId:string,requestId:string,state:'accepted'|'unknown'){
  return withImmediateTransaction(this.db,()=>{
   const changed=this.db.prepare("UPDATE wb_native_member_interrupt_receipts SET state=?,completed_at=? WHERE root_run_id=? AND request_id=? AND state='dispatching'")
    .run(state,new Date().toISOString(),runId,requestId).changes;
   if(changed!==1){const prior=this.db.prepare('SELECT state FROM wb_native_member_interrupt_receipts WHERE root_run_id=? AND request_id=?').get(runId,requestId) as {state:'dispatching'|'accepted'|'unknown'}|undefined;
    if(!prior)throw Error('native_member_interrupt_receipt_missing');return this.interruptReceipt(requestId,prior.state==='accepted'?'accepted':'unknown');}
   return this.interruptReceipt(requestId,state);
  });
 }

 private interruptReceipt(requestId:string,status:'accepted'|'unknown'){
  return {request_id:requestId,status,quiescent:false as const,execution_authorized:false as const};
 }

 readInterrupt(ownerId:string,runId:string,childSessionRef:string,requestId:string){
  if(!ID.test(ownerId)||!ID.test(runId)||!ID.test(childSessionRef)||!ID.test(requestId))throw Error('invalid_native_member_interrupt');
  const parent=this.parent(ownerId,runId),receipt=this.db.prepare(`SELECT owner_id,parent_session_ref,child_run_id,child_session_ref,role_id,state
   FROM wb_native_member_interrupt_receipts WHERE root_run_id=? AND owner_id=? AND request_id=?`)
   .get(runId,ownerId,requestId) as {owner_id:string;parent_session_ref:string;child_run_id:string;child_session_ref:string;role_id:string;state:'dispatching'|'accepted'|'unknown'}|undefined;
  if(!receipt||receipt.parent_session_ref!==parent.session_id||receipt.child_session_ref!==childSessionRef)return null;
  const bound=this.db.prepare(`SELECT n.role_id,n.child_session_ref FROM wb_native_execution_runs n
   JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.owner_id=n.owner_id AND b.kind='native_team'
   WHERE n.owner_id=? AND n.root_run_id=? AND n.run_id=?`).get(ownerId,runId,receipt.child_run_id) as {role_id:string;child_session_ref:string}|undefined;
  if(!bound||bound.role_id!==receipt.role_id||bound.child_session_ref!==childSessionRef)return null;
  return this.interruptReceipt(requestId,receipt.state==='accepted'?'accepted':'unknown');
 }

 read(ownerId:string,runId:string,childSessionRef:string,requestId:string){
  if(!ID.test(ownerId)||!ID.test(runId)||!ID.test(childSessionRef)||!ID.test(requestId))throw Error('invalid_native_member_message');
  const command=this.db.prepare(`SELECT c.status,c.payload_json FROM ga_run_commands c JOIN ga_runs r ON r.id=c.run_id
   JOIN ga_conversations v ON v.id=r.conversation_id WHERE c.run_id=? AND v.owner_id=? AND c.kind='native_member_control' AND c.idempotency_key=?`)
   .get(runId,ownerId,`native-member:${requestId}`) as {status:string;payload_json:string}|undefined;
  if(!command)return null;
  const payload=JSON.parse(command.payload_json) as Input;if(payload.child_session_ref!==childSessionRef||payload.request_id!==requestId||typeof payload.child_run_id!=='string'||!ID.test(payload.child_run_id))throw Error('run_not_found');
  if(command.status==='superseded')return {request_id:requestId,status:'superseded' as const};
  const receipt=this.db.prepare('SELECT state FROM wb_native_member_message_receipts WHERE root_run_id=? AND request_id=? AND child_run_id=? AND child_session_ref=?')
   .get(runId,requestId,payload.child_run_id,childSessionRef) as {state:string}|undefined;
  const status=receipt?.state==='accepted'?'accepted':receipt?.state==='dispatching'||receipt?.state==='unknown'||command.status==='applied'?'unknown':'pending';
  return {request_id:requestId,status};
 }

 private child(ownerId:string,rootRunId:string,childSessionRef:string,allowClosed=false){
  const child=this.db.prepare(`SELECT n.run_id,n.role_id,n.child_session_ref,n.snapshot_json,p.publication_json
   FROM wb_native_execution_runs n JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.owner_id=n.owner_id AND b.kind='native_team'
   JOIN wb_native_spawn_publications p ON p.reservation_id=n.reservation_id
   WHERE n.owner_id=? AND n.root_run_id=? AND n.child_session_ref=?
    AND NOT EXISTS(SELECT 1 FROM wb_native_child_activations a WHERE a.previous_run_id=n.run_id)
    AND (?=1 OR NOT EXISTS(SELECT 1 FROM wb_native_execution_closures x WHERE x.run_id=n.run_id))`)
   .get(ownerId,rootRunId,childSessionRef,allowClosed?1:0) as {run_id:string;role_id:string;child_session_ref:string;snapshot_json:string;publication_json:string}|undefined;
  if(!child)throw Error('native_member_not_found');
  const closure=this.db.prepare('SELECT receipt_json FROM wb_native_execution_closures WHERE run_id=?').get(child.run_id) as {receipt_json:string}|undefined;
  let saved:NativeReservation;
  if(allowClosed&&closure){
   const prior=JSON.parse(child.snapshot_json) as NativeReservation;
   const lease=this.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(rootRunId) as {owner:string;generation:number}|undefined;
   const currentLease=assertExecutionLease(this.db,rootRunId,lease);
   const budget=this.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(ownerId,rootRunId) as {scopes_json:string}|undefined;
   if(!budget)throw Error('budget_binding_invalid');
   saved=assertNativeSnapshot(this.db,ownerId,{...prior,root_run_id:rootRunId,execution_lease:currentLease,root_budget_scope_ids:JSON.parse(budget.scopes_json)});
  }else saved=assertNativeRun(this.db,ownerId,child.run_id);
  const publication=JSON.parse(child.publication_json) as Input,member=publication.member as Input|undefined;
  if(saved.root_run_id!==rootRunId||saved.parent_session_ref!==this.parentSession(rootRunId,ownerId)
   ||saved.child_session_ref!==childSessionRef||saved.role_id!==child.role_id||member?.id!==childSessionRef||member.role!=='teammate'
   ||!['running','inactive'].includes(String(member.status)))throw Error('native_member_not_found');
  if(closure){const proof=JSON.parse(closure.receipt_json) as Input;
   if(proof.session_ref!==childSessionRef||proof.parent_session_ref!==saved.parent_session_ref||proof.driver_nonresident!==true||proof.inbox_pending!==0
    ||!Number.isSafeInteger(proof.seq_exclusive)||Number(proof.seq_exclusive)<1||!Number.isSafeInteger(proof.turn_end_seq)||Number(proof.turn_end_seq)<0
    ||Number(proof.turn_end_seq)>=Number(proof.seq_exclusive)||typeof proof.log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.log_sha256))throw Error('native_member_not_found');}
  return child;
 }

 private parentSession(runId:string,ownerId:string){
  const row=this.db.prepare(`SELECT n.session_id FROM ga_run_native_sessions n JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.owner_id=n.owner_id AND b.kind='task'
   WHERE n.run_id=? AND n.owner_id=?`).get(runId,ownerId) as {session_id:string}|undefined;
  if(!row)throw Error('run_not_found');return row.session_id;
 }

 private parent(ownerId:string,runId:string){
  const row=this.db.prepare(`SELECT r.status,r.version,n.session_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
   JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=c.owner_id AND b.kind='task'
   JOIN ga_run_native_sessions n ON n.run_id=r.id AND n.conversation_id=c.id AND n.owner_id=c.owner_id
   WHERE r.id=? AND c.owner_id=?`).get(runId,ownerId) as {status:string;version:number;session_id:string}|undefined;
  if(!row)throw Error('run_not_found');return row;
 }
}

/** Shared original descriptor reader. Callers hold the owning transaction. */
export function readNativeMemberExecution(db:DatabaseSync,ownerId:string,runId:string,childSessionRef:string,parentSessionRef:string,childRunId?:string){
  const child=db.prepare(`SELECT n.run_id,n.role_id,n.snapshot_json,p.publication_json,
   r.conversation_id,r.status,r.version,CAST(c.next_seq-1 AS TEXT) child_as_of_seq,c.workspace_id,c.project_id
   FROM wb_native_execution_runs n
   JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.owner_id=n.owner_id AND b.kind='native_team' AND b.agent_id=n.role_id
   JOIN wb_native_spawn_publications p ON p.reservation_id=n.reservation_id
   JOIN ga_runs r ON r.id=n.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=n.owner_id
   JOIN ga_harness_session_bindings h ON h.conversation_id=c.id AND h.owner_id=c.owner_id AND h.session_id=n.child_session_ref
   JOIN ga_runs root ON root.id=n.root_run_id JOIN ga_conversations pc ON pc.id=root.conversation_id AND pc.owner_id=c.owner_id
    AND pc.workspace_id=c.workspace_id AND pc.project_id=c.project_id
   WHERE n.owner_id=? AND n.root_run_id=? AND n.child_session_ref=?
    ${childRunId===undefined?'AND NOT EXISTS(SELECT 1 FROM wb_native_child_activations a WHERE a.previous_run_id=n.run_id AND a.owner_id=n.owner_id AND a.root_run_id=n.root_run_id)':'AND n.run_id=?'}
   ORDER BY n.created_at DESC,n.run_id DESC LIMIT 1`).get(ownerId,runId,childSessionRef,...(childRunId===undefined?[]:[childRunId])) as
   {run_id:string;role_id:string;snapshot_json:string;publication_json:string;conversation_id:string;status:string;version:number;child_as_of_seq:string;workspace_id:string;project_id:string}|undefined;
  if(!child)throw Error('native_member_not_found');
  let saved:NativeReservation,publication:Input;
  try{saved=JSON.parse(child.snapshot_json);publication=JSON.parse(child.publication_json);}catch{throw Error('native_member_execution_invalid');}
  const member=publication?.member as Input|undefined;
  if(!saved||saved.owner_id!==ownerId||saved.root_run_id!==runId||saved.parent_session_ref!==parentSessionRef
   ||saved.child_session_ref!==childSessionRef||saved.role_id!==child.role_id
   ||saved.workspace_id!==child.workspace_id||saved.project_id!==child.project_id
   ||!member||member.id!==childSessionRef||member.role!=='teammate')throw Error('native_member_execution_invalid');
  return {root_run_id:runId,child_session_ref:childSessionRef,child_run_id:child.run_id,
   child_conversation_id:child.conversation_id,role_ref:child.role_id,child_status:child.status,child_version:child.version,child_as_of_seq:child.child_as_of_seq,execution_authorized:false as const};
 }
