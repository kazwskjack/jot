import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import type {SkillCatalogScope} from './catalog.ts';
const policyPath=import.meta.url.endsWith('/dist/src/skills/command-query-journal.js')?'../../../../skills/command-query.js':'../../../skills/command-query.js';
const {validateNativeCommandQuery,validateNativeCommandQueryIdentity,validateNativeCommandQueryResult}=await import(new URL(policyPath,import.meta.url).href) as typeof import('../../../skills/command-query.js');
const {validateNativeCommandAudit,validateNativeCommandRecovery}=await import(new URL('command-query-audit.js',new URL(policyPath,import.meta.url)).href) as typeof import('../../../skills/command-query-audit.js');

type Row=Record<string,any>;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const planTarget=(row:Row)=>row.name==='plan'?{enabled:row.request_json?JSON.parse(row.request_json).enabled:null}:{};
const project=(row:Row)=>({request_id:row.request_id,run_id:row.run_id,name:row.name,state:row.state,updated_at:row.updated_at,...planTarget(row),
 ...(row.state==='settled'?{result:JSON.parse(row.result_json)}:{})});
export interface NativeCommandJournalPolicy{
 kind:'plan';
 validateRequest:(value:unknown)=>Row;
 validateIdentity:(value:unknown)=>Row;
}
export class NativeCommandQueryJournal{
 private readonly tables:{operations:string;fences:string;audits:string};
 private readonly validateRequest:(value:unknown)=>Row;
 private readonly validateIdentity:(value:unknown)=>Row;
 constructor(private readonly db:DatabaseSync,policy?:NativeCommandJournalPolicy){
  if(policy&&policy.kind!=='plan')throw Error('native_command_query_invalid');
  this.tables=policy?.kind==='plan'
   ?{operations:'ga_native_plan_mode_operations',fences:'ga_native_plan_mode_fences',audits:'ga_native_plan_mode_audits'}
   :{operations:'ga_native_command_queries',fences:'ga_native_command_query_fences',audits:'ga_native_command_query_audits'};
  this.validateRequest=policy?.validateRequest??validateNativeCommandQuery;
  this.validateIdentity=policy?.validateIdentity??validateNativeCommandQueryIdentity;
  db.exec(`CREATE TABLE IF NOT EXISTS ${this.tables.operations}(
 owner_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,request_id TEXT NOT NULL,session_ref TEXT NOT NULL,name TEXT NOT NULL,
 scope_json TEXT NOT NULL,request_json TEXT NOT NULL,request_sha256 TEXT NOT NULL,grant_sha256 TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','dispatched','settled','rejected','unknown')),
 result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,run_id,request_id));
 CREATE TABLE IF NOT EXISTS ${this.tables.fences}(owner_id TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,request_id TEXT NOT NULL,name TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,run_id,request_id));
 CREATE TABLE IF NOT EXISTS ${this.tables.audits}(owner_id TEXT NOT NULL,run_id TEXT NOT NULL,request_id TEXT NOT NULL,
 proof_json TEXT NOT NULL,recovery_json TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(owner_id,run_id,request_id),
 FOREIGN KEY(owner_id,run_id,request_id) REFERENCES ${this.tables.operations}(owner_id,run_id,request_id) ON DELETE CASCADE);`);}
 private fence(owner:string,runId:string,id:string){return this.db.prepare(`SELECT request_id,run_id,name,'rejected' AS state,updated_at FROM ${this.tables.fences} WHERE owner_id=? AND run_id=? AND request_id=?`).get(owner,runId,id) as Row|undefined;}
 private row(owner:string,runId:string,id:string){
  const row=this.db.prepare(`SELECT * FROM ${this.tables.operations} WHERE owner_id=? AND run_id=? AND request_id=?`).get(owner,runId,id) as Row|undefined;
  if(!row)throw Error('native_command_query_not_found');return row;
 }
 read(owner:string,runId:string,id:string){
  const row=this.db.prepare(`SELECT * FROM ${this.tables.operations} WHERE owner_id=? AND run_id=? AND request_id=?`).get(owner,runId,id) as Row|undefined;
  if(row)return project(row);
  const fenced=this.fence(owner,runId,id);if(fenced)return project(fenced);
  throw Error('native_command_query_not_found');
 }
 list(owner:string,runId:string,options:{history?:true;before?:string}={}){
  // History cursors retain their position when the original operation settles.
  let boundary:Row|undefined;
  if(options.before){
   boundary=this.db.prepare(`SELECT created_at,request_id FROM ${this.tables.operations} WHERE owner_id=? AND run_id=? AND request_id=?`).get(owner,runId,options.before) as Row|undefined;
   if(!boundary){
    const fenced=this.fence(owner,runId,options.before);
    if(!fenced)throw Error('native_command_query_not_found');
    boundary={created_at:fenced.updated_at,request_id:fenced.request_id};
   }
  }
  const order=options.history?'created_at':'updated_at';
  const predicate=boundary?'WHERE created_at<? OR (created_at=? AND request_id<?)':'';
  const parameters=boundary?[boundary.created_at,boundary.created_at,boundary.request_id]:[];
  return {items:(this.db.prepare(`WITH operations AS (
   SELECT request_id,run_id,name,state,updated_at,created_at,request_json FROM ${this.tables.operations} WHERE owner_id=? AND run_id=?
   UNION ALL SELECT f.request_id,f.run_id,f.name,'rejected' AS state,f.updated_at,f.updated_at AS created_at,NULL AS request_json FROM ${this.tables.fences} f
   WHERE f.owner_id=? AND f.run_id=? AND NOT EXISTS(SELECT 1 FROM ${this.tables.operations} q WHERE q.owner_id=f.owner_id AND q.run_id=f.run_id AND q.request_id=f.request_id)
   ) SELECT request_id,run_id,name,state,updated_at,request_json FROM operations ${predicate}
   ORDER BY ${order} DESC,request_id DESC LIMIT 50`).all(owner,runId,owner,runId,...parameters) as Row[])
   .map(row=>({request_id:row.request_id,run_id:row.run_id,name:row.name,state:row.state,updated_at:row.updated_at,...planTarget(row)}))};
 }
 prepare(owner:string,runId:string,input:unknown,scope:()=>SkillCatalogScope){
  const request=this.validateRequest(input),requestHash=hash(canonicalJson(request));
  return withImmediateTransaction(this.db,()=>{
   const old=this.db.prepare(`SELECT * FROM ${this.tables.operations} WHERE owner_id=? AND run_id=? AND request_id=?`).get(owner,runId,request.request_id) as Row|undefined;
   if(old){if(old.request_sha256!==requestHash)throw Error('native_command_query_conflict');return {receipt:project(old)};}
   const fenced=this.fence(owner,runId,request.request_id);
   if(fenced){if(fenced.name!==request.name)throw Error('native_command_query_conflict');return {receipt:project(fenced)};}
   const original=scope(),token=randomBytes(32).toString('base64url'),time=now();
   this.db.prepare(`INSERT INTO ${this.tables.operations} VALUES(?,?,?,?,?,?,?,?,?,'prepared',NULL,?,?)`)
    .run(owner,runId,request.request_id,original.session_ref,request.name,canonicalJson(original),canonicalJson(request),requestHash,hash(token),time,time);
   return {receipt:{request_id:request.request_id,run_id:runId,name:request.name,state:'prepared',updated_at:time},packet:{scope:original,request,grant_token:token}};
  });
 }
 close(owner:string,runId:string,id:string,name:unknown){
  const identity=this.validateIdentity({request_id:id,name});
  return withImmediateTransaction(this.db,()=>{
   const old=this.db.prepare(`SELECT name FROM ${this.tables.operations} WHERE owner_id=? AND run_id=? AND request_id=?`).get(owner,runId,id) as Row|undefined;
   const fenced=this.fence(owner,runId,id);
   if(old&&old.name!==name||fenced&&fenced.name!==name)throw Error('native_command_query_conflict');
   this.db.prepare(`INSERT OR IGNORE INTO ${this.tables.fences} VALUES(?,?,?,?,?)`).run(owner,runId,id,identity.name,now());
   this.db.prepare(`UPDATE ${this.tables.operations} SET state='rejected',updated_at=? WHERE owner_id=? AND run_id=? AND request_id=? AND state='prepared'`).run(now(),owner,runId,id);
   return this.read(owner,runId,id);
  });
 }
 private authorized(value:Row){
  const scope=value.scope as SkillCatalogScope,request=this.validateRequest(value.request);
  if(!scope||typeof scope.owner_id!=='string'||typeof scope.run_id!=='string'||typeof value.grant_token!=='string'||value.grant_token.length!==43)throw Error('native_command_query_forbidden');
  const row=this.row(scope.owner_id,scope.run_id,request.request_id),token=Buffer.from(hash(value.grant_token),'hex'),expected=Buffer.from(row.grant_sha256,'hex');
  if(!timingSafeEqual(token,expected)||row.scope_json!==canonicalJson(scope)||row.request_sha256!==hash(canonicalJson(request)))throw Error('native_command_query_forbidden');
  return row;
 }
 claim(packet:Row,check:(scope:SkillCatalogScope)=>void){
  return withImmediateTransaction(this.db,()=>{
   const row=this.authorized(packet);
   if(row.state!=='prepared')return {dispatch:false};
   check(packet.scope);
   const changed=this.db.prepare(`UPDATE ${this.tables.operations} SET state='dispatched',updated_at=? WHERE owner_id=? AND run_id=? AND request_id=? AND state='prepared'`)
    .run(now(),row.owner_id,row.run_id,row.request_id).changes;
   return {dispatch:changed===1};
  });
 }
 private audit(owner:string,runId:string,id:string){return this.db.prepare(`SELECT * FROM ${this.tables.audits} WHERE owner_id=? AND run_id=? AND request_id=?`).get(owner,runId,id) as Row|undefined;}
 bindAudit(packet:Row){
  const proof=canonicalJson(validateNativeCommandAudit(packet.audit));
  return withImmediateTransaction(this.db,()=>{
   const row=this.authorized(packet);
   if(!['dispatched','unknown','settled'].includes(row.state))throw Error('native_command_query_state_conflict');
   const audit=this.audit(row.owner_id,row.run_id,row.request_id);
   if(audit&&audit.proof_json!==proof)throw Error('native_command_query_audit_conflict');
   if(row.state==='settled'&&JSON.parse(row.result_json).commandId!==packet.audit.command_id)throw Error('native_command_query_audit_conflict');
   this.db.prepare(`INSERT OR IGNORE INTO ${this.tables.audits} VALUES(?,?,?,?,NULL,?)`).run(row.owner_id,row.run_id,row.request_id,proof,now());
   return {audit:JSON.parse(proof),execution_authorized:false};
  });
 }
 recoveryPacket(owner:string,runId:string,id:string){
  const row=this.row(owner,runId,id),audit=this.audit(owner,runId,id);
  if(!audit)throw Error('native_command_query_audit_unpaired');
  return {scope:JSON.parse(row.scope_json),request:this.validateRequest(JSON.parse(row.request_json)),audit:validateNativeCommandAudit(JSON.parse(audit.proof_json))};
 }
 authorizeAudit(packet:Row){
  const request=this.validateRequest(packet.request),scope=packet.scope;
  if(!scope||typeof scope.owner_id!=='string'||typeof scope.run_id!=='string')throw Error('native_command_query_forbidden');
  const row=this.row(scope.owner_id,scope.run_id,request.request_id),audit=this.audit(scope.owner_id,scope.run_id,request.request_id);
  if(row.scope_json!==canonicalJson(scope)||row.request_sha256!==hash(canonicalJson(request))||!audit
   ||audit.proof_json!==canonicalJson(validateNativeCommandAudit(packet.audit)))throw Error('native_command_query_audit_conflict');
  return {audit:JSON.parse(audit.proof_json),execution_authorized:false};
 }
 recover(owner:string,runId:string,id:string,value:unknown){
  const proof=validateNativeCommandRecovery(value),serialized=canonicalJson(proof.result);
  return withImmediateTransaction(this.db,()=>{
   const packet=this.recoveryPacket(owner,runId,id),row=this.row(owner,runId,id);
   if(canonicalJson(packet.audit)!==canonicalJson(proof.audit))throw Error('native_command_query_audit_conflict');
   const audit=this.audit(owner,runId,id)!,receipt=canonicalJson({end_event_seq:proof.end_event_seq,end_event_sha256:proof.end_event_sha256,result_sha256:hash(serialized)});
   if(audit.recovery_json!==null&&audit.recovery_json!==receipt)throw Error('native_command_query_audit_conflict');
   if(row.state==='settled'&&row.result_json!==serialized)throw Error('native_command_query_result_conflict');
   if(!['dispatched','unknown','settled'].includes(row.state))throw Error('native_command_query_state_conflict');
   this.db.prepare(`UPDATE ${this.tables.audits} SET recovery_json=?,updated_at=? WHERE owner_id=? AND run_id=? AND request_id=?`).run(receipt,now(),owner,runId,id);
   if(row.state!=='settled')this.db.prepare(`UPDATE ${this.tables.operations} SET state='settled',result_json=?,updated_at=? WHERE owner_id=? AND run_id=? AND request_id=?`).run(serialized,now(),owner,runId,id);
   return this.read(owner,runId,id);
  });
 }
 finish(packet:Row,state:'settled'|'rejected'|'unknown',result?:unknown){
  const serialized=state==='settled'?canonicalJson(validateNativeCommandQueryResult(result)):null;
  return withImmediateTransaction(this.db,()=>{
   const row=this.authorized(packet);
   if(state==='settled'){
    const audit=this.audit(row.owner_id,row.run_id,row.request_id);
    if(audit&&JSON.parse(audit.proof_json).command_id!==JSON.parse(serialized!).commandId)throw Error('native_command_query_audit_conflict');
   }
   if(row.state==='settled'){
    if(state==='settled'&&serialized!==row.result_json)throw Error('native_command_query_result_conflict');return project(row);
   }
   if(row.state==='rejected')return project(row);
   if(state==='rejected'&&row.state!=='prepared'||state==='settled'&&!['dispatched','unknown'].includes(row.state))throw Error('native_command_query_state_conflict');
   this.db.prepare(`UPDATE ${this.tables.operations} SET state=?,result_json=?,updated_at=? WHERE owner_id=? AND run_id=? AND request_id=?`)
    .run(state,serialized,now(),row.owner_id,row.run_id,row.request_id);
   return this.read(row.owner_id,row.run_id,row.request_id);
  });
 }
}
