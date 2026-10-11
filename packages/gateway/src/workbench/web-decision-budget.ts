import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {ModelBudgetLedger} from './model-budget.ts';
type Row=Record<string,string>;type Input=Record<string,unknown>;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function fields(input:Input,allowed:string[]){if(!input||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw new Error('invalid_web_budget_request');}
function responseBytes(input:Input){
 if(typeof input.response_json!=='string'||Buffer.byteLength(input.response_json)>262144||!hash(input.response_hash)||digest(input.response_json)!==input.response_hash)throw new Error('invalid_web_budget_response');
 let value:Input;try{value=JSON.parse(input.response_json);}catch{throw new Error('invalid_web_budget_response');}
 if(!value||Array.isArray(value)||value.protocol!==1)throw new Error('invalid_web_budget_response');
 if(value.encoding==='json'){fields(value,['protocol','encoding','value']);if(!Object.hasOwn(value,'value'))throw new Error('invalid_web_budget_response');}
 else if(value.encoding==='http'){
  fields(value,['protocol','encoding','status_code','body_base64','retry_after']);
  if(!Number.isInteger(value.status_code)||Number(value.status_code)<100||Number(value.status_code)>599
   ||typeof value.body_base64!=='string'||Buffer.from(value.body_base64,'base64').toString('base64')!==value.body_base64
   ||Buffer.from(value.body_base64,'base64').length>131072
   ||!(value.retry_after===null||typeof value.retry_after==='string'&&value.retry_after.length<=256&&/^[\x20-\x7e]*$/.test(value.retry_after)))throw new Error('invalid_web_budget_response');
 }else throw new Error('invalid_web_budget_response');
 return {response_json:input.response_json,response_hash:input.response_hash};
}
/** A host-minted transport capability. It confers only metered model attempts,
 * never browser action permission or another planner. Owners/native sessions
 * are resolved by the authenticated DSH boundary, not from model arguments. */
export class WebDecisionBudgetService {
 constructor(privateDb:DatabaseSync,privateOptions:{ledger:ModelBudgetLedger;secret:string;guard:(owner:string,run:string)=>{scopeKey:string;guard:()=>void};now?:()=>number}){
  this.db=privateDb;this.options=privateOptions;
  if(privateOptions.secret.length<16)throw new Error('budget_service_unavailable');
  privateDb.exec(`CREATE TABLE IF NOT EXISTS wb_web_model_grants (
   grant_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES ga_runs(id),owner_id TEXT NOT NULL,
   call_id TEXT NOT NULL,tool_name TEXT NOT NULL,request_hash TEXT NOT NULL,session_hash TEXT NOT NULL,
   lease_scope TEXT NOT NULL,expires_at TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','closed')),
   closed_at TEXT,UNIQUE(run_id,call_id));
   CREATE TRIGGER IF NOT EXISTS wb_web_grant_no_update BEFORE UPDATE ON wb_web_model_grants
   WHEN OLD.state='closed' OR NEW.grant_id!=OLD.grant_id OR NEW.run_id!=OLD.run_id OR NEW.owner_id!=OLD.owner_id
    OR NEW.call_id!=OLD.call_id OR NEW.tool_name!=OLD.tool_name OR NEW.request_hash!=OLD.request_hash
    OR NEW.session_hash!=OLD.session_hash OR NEW.lease_scope!=OLD.lease_scope OR NEW.expires_at!=OLD.expires_at
    OR NEW.state!='closed' OR NEW.closed_at IS NULL BEGIN SELECT RAISE(ABORT,'web_budget_grant_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_web_grant_no_delete BEFORE DELETE ON wb_web_model_grants
   BEGIN SELECT RAISE(ABORT,'web_budget_grant_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_web_grant_no_replace BEFORE INSERT ON wb_web_model_grants
   WHEN EXISTS(SELECT 1 FROM wb_web_model_grants WHERE grant_id=NEW.grant_id OR (run_id=NEW.run_id AND call_id=NEW.call_id))
   BEGIN SELECT RAISE(ABORT,'web_budget_grant_immutable'); END;
   CREATE TABLE IF NOT EXISTS wb_web_model_attempts (
    grant_id TEXT NOT NULL REFERENCES wb_web_model_grants(grant_id),run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,
    request_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,request_hash TEXT NOT NULL,
    PRIMARY KEY(grant_id,provider,request_id),UNIQUE(run_id,attempt_id),
    FOREIGN KEY(run_id,attempt_id) REFERENCES wb_model_budget_attempts(run_id,attempt_id));
   CREATE TRIGGER IF NOT EXISTS wb_web_attempt_no_update BEFORE UPDATE ON wb_web_model_attempts
   BEGIN SELECT RAISE(ABORT,'web_budget_attempt_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_web_attempt_no_delete BEFORE DELETE ON wb_web_model_attempts
   BEGIN SELECT RAISE(ABORT,'web_budget_attempt_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_web_attempt_no_replace BEFORE INSERT ON wb_web_model_attempts
   WHEN EXISTS(SELECT 1 FROM wb_web_model_attempts WHERE (grant_id=NEW.grant_id AND provider=NEW.provider AND request_id=NEW.request_id) OR (run_id=NEW.run_id AND attempt_id=NEW.attempt_id))
   BEGIN SELECT RAISE(ABORT,'web_budget_attempt_immutable'); END;
   CREATE TABLE IF NOT EXISTS wb_web_model_responses (
    run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES wb_web_model_grants(grant_id),
    response_json TEXT NOT NULL,response_hash TEXT NOT NULL,created_at TEXT NOT NULL,
    PRIMARY KEY(run_id,attempt_id),FOREIGN KEY(run_id,attempt_id) REFERENCES wb_model_budget_attempts(run_id,attempt_id));
   CREATE TRIGGER IF NOT EXISTS wb_web_response_no_update BEFORE UPDATE ON wb_web_model_responses
   BEGIN SELECT RAISE(ABORT,'web_budget_response_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_web_response_no_delete BEFORE DELETE ON wb_web_model_responses
   BEGIN SELECT RAISE(ABORT,'web_budget_response_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_web_response_no_replace BEFORE INSERT ON wb_web_model_responses
   WHEN EXISTS(SELECT 1 FROM wb_web_model_responses WHERE run_id=NEW.run_id AND attempt_id=NEW.attempt_id)
   BEGIN SELECT RAISE(ABORT,'web_budget_response_immutable'); END;`);
 }
 private readonly db:DatabaseSync;
 private readonly options:{ledger:ModelBudgetLedger;secret:string;guard:(owner:string,run:string)=>{scopeKey:string;guard:()=>void};now?:()=>number};
 private now(){return (this.options.now??Date.now)();}
 private token(row:Row){return createHmac('sha256',this.options.secret).update(JSON.stringify([row.owner_id,row.run_id,row.call_id,row.tool_name,row.request_hash,row.session_hash,row.lease_scope,row.expires_at])).digest('hex');}
 private live(row:Row){const guard=this.options.guard(row.owner_id!,row.run_id!);guard.guard();if(guard.scopeKey!==row.lease_scope)throw new Error('web_budget_grant_revoked');const binding=this.db.prepare('SELECT b.session_id FROM ga_harness_session_bindings b JOIN ga_runs r ON r.conversation_id=b.conversation_id WHERE r.id=? AND b.owner_id=?').get(row.run_id!,row.owner_id!);if(!binding||digest(String(binding.session_id))!==row.session_hash)throw new Error('web_budget_grant_revoked');if(row.state!=='active'||Number(row.expires_at)<=this.now())throw new Error('web_budget_grant_revoked');}
 mint(owner:string,run:string,session:string,call:string,tool:string,requestHash:string){
  if(!id(call)||!id(tool)||!hash(requestHash))throw new Error('invalid_web_budget_request');
  return withImmediateTransaction(this.db,()=>{const current=this.options.guard(owner,run);current.guard();const old=this.db.prepare('SELECT * FROM wb_web_model_grants WHERE run_id=? AND call_id=?').get(run,call) as Row|undefined;
   const row:Row=old??{owner_id:owner,run_id:run,call_id:call,tool_name:tool,request_hash:requestHash,session_hash:digest(session),lease_scope:current.scopeKey,expires_at:String(this.now()+300000),state:'active'};
   if(row.owner_id!==owner||row.tool_name!==tool||row.request_hash!==requestHash||row.session_hash!==digest(session))throw new Error('web_budget_grant_state_conflict');this.live(row);const token=this.token(row),grantId=digest(token);if(!old)this.db.prepare('INSERT INTO wb_web_model_grants(grant_id,run_id,owner_id,call_id,tool_name,request_hash,session_hash,lease_scope,expires_at,state) VALUES(?,?,?,?,?,?,?,?,?,?)').run(grantId,run,owner,call,tool,requestHash,row.session_hash!,row.lease_scope!,row.expires_at!,'active');return {protocol:1,grant:token,expires_at:new Date(Number(row.expires_at)).toISOString()};
  });
 }
 close(owner:string,run:string,call:string){return withImmediateTransaction(this.db,()=>{const row=this.db.prepare('SELECT * FROM wb_web_model_grants WHERE run_id=? AND call_id=? AND owner_id=?').get(run,call,owner) as Row|undefined;if(!row)throw new Error('web_budget_grant_forbidden');if(row.state==='active')this.db.prepare("UPDATE wb_web_model_grants SET state='closed',closed_at=? WHERE grant_id=? AND state='active'").run(new Date(this.now()).toISOString(),row.grant_id!);const pending=this.db.prepare("SELECT w.attempt_id FROM wb_web_model_attempts w JOIN wb_model_budget_attempts a ON a.run_id=w.run_id AND a.attempt_id=w.attempt_id WHERE w.grant_id=? AND a.state='reserved'").all(row.grant_id!);for(const attempt of pending)this.options.ledger.releaseUndispatched(owner,run,String(attempt.attempt_id));return {closed:true};});}
 private authorized(token:string){if(!hash(token))throw new Error('unauthorized');const row=this.db.prepare('SELECT * FROM wb_web_model_grants WHERE grant_id=?').get(digest(token)) as Row|undefined;if(!row||!timingSafeEqual(Buffer.from(token),Buffer.from(this.token(row))))throw new Error('unauthorized');return row;}
 command(token:string,input:Input){
  return withImmediateTransaction(this.db,()=>{if(typeof input.action!=='string')throw new Error('invalid_web_budget_request');const grant=this.authorized(token),action=input.action,ledger=this.options.ledger,owner=grant.owner_id!,run=grant.run_id!;
   if(action==='reserve'){
    fields(input,['action','request_id','provider','model','request_hash']);
    if(!id(input.request_id)||(typeof input.provider!=='string'||!['openjev','laya'].includes(input.provider))||typeof input.model!=='string'||!input.model||input.model.length>256||!hash(input.request_hash))throw new Error('invalid_web_budget_request');
    const old=this.db.prepare('SELECT * FROM wb_web_model_attempts WHERE grant_id=? AND provider=? AND request_id=?').get(grant.grant_id!,input.provider,String(input.request_id)) as Row|undefined;
    if(old&&(old.model!==input.model||old.request_hash!==input.request_hash))throw new Error('web_budget_grant_state_conflict');
    // Existing exact identity is an accounting lookup, not new admission.
    // Require the original ledger row before reserve() can return its receipt;
    // a missing row must never recreate a spend from a closed grant.
    if(old){
     if(!this.db.prepare('SELECT 1 FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(run,old.attempt_id!))throw new Error('web_budget_attempt_forbidden');
    }else this.live(grant);
    const attempt=old?.attempt_id??'web-'+digest(JSON.stringify([grant.grant_id,input.provider,input.model,input.request_id,input.request_hash]));
    const receipt=ledger.reserve(owner,run,{attempt_id:attempt,provider:input.provider,model:input.model,purpose:'web-decision'});
    if(!old)this.db.prepare('INSERT INTO wb_web_model_attempts VALUES(?,?,?,?,?,?,?)').run(grant.grant_id!,run,attempt,String(input.request_id),input.provider,input.model,String(input.request_hash));
    return {fresh:!old,receipt};
   }
   const allowed:Record<string,string[]>={dispatch:['action','attempt_id'],settle:['action','attempt_id','usage'],unknown:['action','attempt_id','reason'],release:['action','attempt_id'],response_record:['action','attempt_id','response_json','response_hash'],response_read:['action','attempt_id']};if(!allowed[action])throw new Error('invalid_web_budget_request');fields(input,allowed[action]!);if(!id(input.attempt_id))throw new Error('invalid_web_budget_request');const mapped=this.db.prepare('SELECT 1 FROM wb_web_model_attempts WHERE grant_id=? AND run_id=? AND attempt_id=?').get(grant.grant_id!,run,String(input.attempt_id));if(!mapped)throw new Error('web_budget_attempt_forbidden');const attempt=String(input.attempt_id),route=this.db.prepare('SELECT route_json,state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(run,attempt)!;const byCall=JSON.parse(String(route.route_json)).billing?.unit==='dispatched_call';
   if(action==='response_record'||action==='response_read'){
    const existing=this.db.prepare('SELECT response_json,response_hash FROM wb_web_model_responses WHERE run_id=? AND attempt_id=? AND grant_id=?').get(run,attempt,grant.grant_id!) as Row|undefined;
    if(action==='response_read'){if(existing)responseBytes(existing);return {response:existing??null};}
    if(!['in_flight','unknown','settled'].includes(String(route.state)))throw new Error('web_budget_response_state_conflict');
    const response=responseBytes(input);
    if(existing){if(existing.response_json!==response.response_json||existing.response_hash!==response.response_hash)throw new Error('web_budget_response_state_conflict');}
    else this.db.prepare('INSERT INTO wb_web_model_responses VALUES(?,?,?,?,?,?)').run(run,attempt,grant.grant_id!,response.response_json,response.response_hash,new Date(this.now()).toISOString());
    return {response};
   }
   if(action==='dispatch'){this.live(grant);let receipt=ledger.dispatch(owner,run,attempt,()=>this.live(grant));if(byCall)receipt=ledger.settleDispatchedCall(owner,run,attempt);return {receipt};}
   // Accounting on an already dispatched original attempt survives closure or
   // revoked role/lease. It cannot authorize a new provider invocation.
   if(action==='settle'){if(byCall&&input.usage!==undefined)throw new Error('invalid_web_budget_request');return {receipt:byCall?ledger.settleDispatchedCall(owner,run,attempt):ledger.settle(owner,run,attempt,input.usage)};}
   if(action==='release')return {receipt:ledger.releaseUndispatched(owner,run,attempt)};
   if(typeof input.reason!=='string'||!['usage_incomplete','provider_failed','transport_unknown','settlement_pending'].includes(input.reason))throw new Error('invalid_web_budget_request');
   const reason=input.reason==='settlement_pending'?'settlement_unavailable':input.reason==='usage_incomplete'?'usage_incomplete':'stream_incomplete';
   return {receipt:byCall?ledger.settleDispatchedCall(owner,run,attempt):ledger.markUnknown(owner,run,attempt,reason)};
  });
 }
}
