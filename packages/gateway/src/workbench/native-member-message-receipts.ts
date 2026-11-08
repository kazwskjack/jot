import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {assertExecutionLease} from './execution-lease.ts';
import {assertNativeRun,assertNativeSnapshot,type NativeReservation} from './native-child-identity.ts';

type Input=Record<string,unknown>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');

/** A dispatch receipt is written before the native Team message is attempted. */
export class NativeMemberMessageReceipts {
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){
  this.db=db;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_native_member_message_receipts(
    root_run_id TEXT NOT NULL REFERENCES ga_runs(id),owner_id TEXT NOT NULL,parent_session_ref TEXT NOT NULL,
    child_run_id TEXT NOT NULL REFERENCES ga_runs(id),child_session_ref TEXT NOT NULL,role_id TEXT NOT NULL,
    request_id TEXT NOT NULL,message_sha256 TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('dispatching','accepted','unknown')),
    created_at TEXT NOT NULL,completed_at TEXT,PRIMARY KEY(root_run_id,request_id));
   CREATE TRIGGER IF NOT EXISTS wb_native_member_message_identity BEFORE UPDATE ON wb_native_member_message_receipts
    WHEN OLD.root_run_id IS NOT NEW.root_run_id OR OLD.owner_id IS NOT NEW.owner_id OR OLD.parent_session_ref IS NOT NEW.parent_session_ref
      OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.child_session_ref IS NOT NEW.child_session_ref OR OLD.role_id IS NOT NEW.role_id
      OR OLD.request_id IS NOT NEW.request_id OR OLD.message_sha256 IS NOT NEW.message_sha256
      OR OLD.state<>'dispatching' OR NEW.state NOT IN ('accepted','unknown')
    BEGIN SELECT RAISE(ABORT,'native_member_message_receipt_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_native_member_message_no_delete BEFORE DELETE ON wb_native_member_message_receipts
    BEGIN SELECT RAISE(ABORT,'native_member_message_receipt_immutable'); END;`);
 }

 begin(ownerId:string,input:Input){
  this.validate(ownerId,input,'begin');
  return withImmediateTransaction(this.db,()=>{
   const identity=this.identity(ownerId,input),command=this.command(input,identity.root_run_id,identity.child_run_id,identity.role_id);
   const prior=this.prior(identity.root_run_id,input.request_id as string);
   if(prior){this.match(prior,ownerId,identity,input);return {decision:prior.state==='accepted'?'accepted':'unknown' as const};}
   if(command.status!=='pending')return {decision:'unknown' as const};
   const child=this.db.prepare(`SELECT n.role_id,n.child_session_ref,n.snapshot_json,p.publication_json,x.receipt_json
    FROM wb_native_execution_runs n JOIN wb_run_bindings b ON b.run_id=n.run_id AND b.owner_id=n.owner_id AND b.kind='native_team'
    JOIN wb_native_spawn_publications p ON p.reservation_id=n.reservation_id LEFT JOIN wb_native_execution_closures x ON x.run_id=n.run_id
    WHERE n.run_id=? AND n.owner_id=? AND n.root_run_id=? AND n.role_id=? AND n.child_session_ref=?
      AND NOT EXISTS(SELECT 1 FROM wb_native_child_activations a WHERE a.previous_run_id=n.run_id)`)
    .get(identity.child_run_id,ownerId,identity.root_run_id,identity.role_id,identity.child_session_ref) as {role_id:string;child_session_ref:string;snapshot_json:string;publication_json:string;receipt_json:string|null}|undefined;
   if(!child)throw Error('native_member_not_found');
   let saved:NativeReservation;
   if(child.receipt_json){
    const prior=JSON.parse(child.snapshot_json) as NativeReservation;
    const budget=this.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(ownerId,identity.root_run_id) as {scopes_json:string}|undefined;
    if(!budget)throw Error('budget_binding_invalid');
    saved=assertNativeSnapshot(this.db,ownerId,{...prior,root_run_id:identity.root_run_id,execution_lease:identity.execution_lease,root_budget_scope_ids:JSON.parse(budget.scopes_json)});
   }else saved=assertNativeRun(this.db,ownerId,identity.child_run_id);
   const member=(JSON.parse(child.publication_json) as Input).member as Input|undefined;
   if(saved.root_run_id!==identity.root_run_id||saved.parent_session_ref!==identity.parent_session_ref||saved.role_id!==identity.role_id
    ||saved.child_session_ref!==identity.child_session_ref||member?.id!==identity.child_session_ref||member.role!=='teammate'
    ||!['running','inactive'].includes(String(member.status)))throw Error('native_member_not_found');
   if(child.receipt_json){const proof=JSON.parse(child.receipt_json) as Input;
    if(proof.session_ref!==identity.child_session_ref||proof.parent_session_ref!==identity.parent_session_ref||proof.driver_nonresident!==true||proof.inbox_pending!==0
     ||!Number.isSafeInteger(proof.seq_exclusive)||Number(proof.seq_exclusive)<1||!Number.isSafeInteger(proof.turn_end_seq)||Number(proof.turn_end_seq)<0
     ||Number(proof.turn_end_seq)>=Number(proof.seq_exclusive)||typeof proof.log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.log_sha256))throw Error('native_member_not_found');}
   this.db.prepare('INSERT INTO wb_native_member_message_receipts(root_run_id,owner_id,parent_session_ref,child_run_id,child_session_ref,role_id,request_id,message_sha256,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(identity.root_run_id,ownerId,identity.parent_session_ref,identity.child_run_id,identity.child_session_ref,identity.role_id,String(input.request_id),String(input.message_sha256),'dispatching',new Date().toISOString());
   return {decision:'dispatch' as const};
  });
 }

 complete(ownerId:string,input:Input){
  this.validate(ownerId,input,'complete');
  return withImmediateTransaction(this.db,()=>{
   const identity=this.identity(ownerId,input);this.command(input,identity.root_run_id,identity.child_run_id,identity.role_id);
   const prior=this.prior(identity.root_run_id,input.request_id as string);if(!prior)throw Error('native_member_message_receipt_missing');
   this.match(prior,ownerId,identity,input);
   if(prior.state==='dispatching')this.db.prepare("UPDATE wb_native_member_message_receipts SET state=?,completed_at=? WHERE root_run_id=? AND request_id=? AND state='dispatching'")
     .run(String(input.result),new Date().toISOString(),identity.root_run_id,String(input.request_id));
   const state=prior.state==='dispatching'?String(input.result):prior.state;
   return {state};
  });
 }

 private validate(ownerId:string,input:Input,action:'begin'|'complete'){
  const expected=['action','child_run_id','child_session_ref','execution_lease','message_sha256','operation','receipt_action','request_id','role_ref','run_id','session_ref',...(action==='complete'?['result']:[])].sort();
  if(!ID.test(ownerId)||!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!==expected.join(',')
   ||input.action!=='member-message'||input.receipt_action!==action||input.operation!=='wake'
   ||['run_id','session_ref','child_run_id','child_session_ref','request_id','role_ref'].some(key=>typeof input[key]!=='string'||!ID.test(input[key] as string))
   ||typeof input.message_sha256!=='string'||!/^[a-f0-9]{64}$/.test(input.message_sha256)
   ||action==='complete'&&!['accepted','unknown'].includes(String(input.result)))throw Error('invalid_native_member_message');
 }

 private identity(ownerId:string,input:Input){
  const rootRunId=String(input.run_id),parentSessionRef=String(input.session_ref);
  const executionLease=assertExecutionLease(this.db,rootRunId,input.execution_lease);
  const parent=this.db.prepare(`SELECT r.status,n.session_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
   JOIN wb_run_bindings b ON b.run_id=r.id AND b.owner_id=c.owner_id AND b.kind='task'
   JOIN ga_run_native_sessions n ON n.run_id=r.id AND n.conversation_id=c.id AND n.owner_id=c.owner_id
   WHERE r.id=? AND c.owner_id=?`).get(rootRunId,ownerId) as {status:string;session_id:string}|undefined;
  if(!parent||parent.session_id!==parentSessionRef||!['starting','running'].includes(parent.status))throw Error('workbench_identity_forbidden');
  return {root_run_id:rootRunId,parent_session_ref:parentSessionRef,execution_lease:executionLease,child_run_id:String(input.child_run_id),child_session_ref:String(input.child_session_ref),role_id:String(input.role_ref)};
 }

 private command(input:Input,rootRunId:string,childRunId:string,roleId:string){
  const row=this.db.prepare("SELECT status,payload_json FROM ga_run_commands WHERE run_id=? AND kind='native_member_control' AND idempotency_key=?")
   .get(rootRunId,`native-member:${input.request_id}`) as {status:string;payload_json:string}|undefined;
  if(!row)throw Error('workbench_identity_forbidden');
  const payload=JSON.parse(row.payload_json) as Input;
  if(Object.keys(payload).sort().join(',')!=='child_run_id,child_session_ref,operation,request_id,role_ref,text'||payload.operation!=='wake'
   ||payload.request_id!==input.request_id||payload.child_session_ref!==input.child_session_ref||payload.child_run_id!==childRunId||payload.role_ref!==roleId
   ||typeof payload.text!=='string'||hash(payload.text)!==input.message_sha256)throw Error('workbench_identity_forbidden');
  return row;
 }

 private prior(rootRunId:string,requestId:string){
  return this.db.prepare('SELECT owner_id,parent_session_ref,child_run_id,child_session_ref,role_id,message_sha256,state FROM wb_native_member_message_receipts WHERE root_run_id=? AND request_id=?')
   .get(rootRunId,requestId) as {owner_id:string;parent_session_ref:string;child_run_id:string;child_session_ref:string;role_id:string;message_sha256:string;state:'dispatching'|'accepted'|'unknown'}|undefined;
 }
 private match(prior:{owner_id:string;parent_session_ref:string;child_run_id:string;child_session_ref:string;role_id:string;message_sha256:string;state:'dispatching'|'accepted'|'unknown'},ownerId:string,identity:ReturnType<NativeMemberMessageReceipts['identity']>,input:Input){
  if(prior.owner_id!==ownerId||prior.parent_session_ref!==identity.parent_session_ref||prior.child_run_id!==identity.child_run_id
   ||prior.child_session_ref!==identity.child_session_ref||prior.role_id!==identity.role_id||prior.message_sha256!==input.message_sha256)throw Error('idempotency_conflict');
 }
}
