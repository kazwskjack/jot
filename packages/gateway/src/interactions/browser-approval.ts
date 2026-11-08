import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import type {EventStore} from '../events/event-store.ts';

type BrowserIdentity={owner_id:string;run_id:string;conversation_id:string};
type BrowserPayload=Record<string,unknown>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function invalid():never{throw new Error('invalid_browser_approval');}
export function validateBrowserActionPayload(value:unknown):BrowserPayload{
 if(!value||typeof value!=='object'||Array.isArray(value))return invalid();
 const row=value as BrowserPayload;
 if(Object.getPrototypeOf(row)!==Object.prototype)return invalid();
 const action=row.action;
 if(action==='profile_revoke'){
  if(Object.keys(row).sort().join(',')!=='action,call_id,profile_generation,tool'||row.tool!=='browser_action'
   ||typeof row.call_id!=='string'||!ID.test(row.call_id)||!Number.isSafeInteger(row.profile_generation)||Number(row.profile_generation)<1)return invalid();
  return row;
 }
 const common=['tool','operation_id','call_id','request_hash','url','action'];
 const expected=action==='read'?common
  :['click','scroll'].includes(String(action))?[...common,'candidate_id','page_revision','target']
  :action==='fill'?[...common,'candidate_id','page_revision','target','text']
  :action==='screenshot'?[...common,'page_revision','format','persist']:null;
 if(!expected||Object.keys(row).sort().join('\0')!==expected.sort().join('\0'))return invalid();
 if(row.tool!=='browser_action'||typeof row.operation_id!=='string'||!ID.test(row.operation_id)
  ||typeof row.call_id!=='string'||!ID.test(row.call_id)||typeof row.request_hash!=='string'||! /^[a-f0-9]{64}$/.test(row.request_hash)
  ||typeof row.url!=='string'||row.url.length>2048||!['read','click','fill','scroll','screenshot'].includes(String(action)))return invalid();
 try{const url=new URL(row.url);if(url.protocol!=='https:'||url.username||url.password||url.origin==='null')return invalid();}catch{return invalid();}
 if(['click','fill','scroll'].includes(String(action))){
  if(typeof row.candidate_id!=='string'||! /^[a-f0-9]{24}$/.test(row.candidate_id)
   ||typeof row.page_revision!=='string'||! /^[a-f0-9]{64}$/.test(row.page_revision)
   ||!row.target||typeof row.target!=='object'||Array.isArray(row.target))return invalid();
  const target=row.target as BrowserPayload;
  if(!['name,role','destination,name,role'].includes(Object.keys(target).sort().join(','))||typeof target.name!=='string'||target.name.length>160
   ||typeof target.role!=='string'||target.role.length>40)return invalid();
  if(target.destination!==undefined&&target.destination!==null){
   const destination=target.destination as BrowserPayload;
   if(typeof destination!=='object'||Array.isArray(destination)||!['link','form'].includes(String(destination.kind)))return invalid();
   const keys=Object.keys(destination).sort().join(',');
   if(destination.kind==='link'?keys!=='kind,url':!['kind,method,url','form_binding,kind,method,url'].includes(keys))return invalid();
   if(typeof destination.url!=='string'||destination.url.length>2048)return invalid();
   try{const url=new URL(destination.url);if(url.protocol!=='https:'||url.username||url.password)return invalid();}catch{return invalid();}
   if(destination.kind==='form'&&!['get','post','dialog'].includes(String(destination.method)))return invalid();
   if(destination.form_binding!==undefined){
    const binding=destination.form_binding as BrowserPayload;
    if(!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).sort().join(',')!=='fields,sha256'
     ||typeof binding.sha256!=='string'||!/^[a-f0-9]{64}$/.test(binding.sha256)||!Array.isArray(binding.fields)||binding.fields.length>100)return invalid();
    for(const field of binding.fields){
     if(!field||typeof field!=='object'||Array.isArray(field)||Object.keys(field).sort().join(',')!=='name,value'
      ||typeof field.name!=='string'||field.name.length>100||typeof field.value!=='string'||field.value.length>160)return invalid();
    }
   }
  }
 }
 if(action==='fill'&&(typeof row.text!=='string'||row.text.length>8000))return invalid();
 if(action==='screenshot'&&(typeof row.page_revision!=='string'||! /^[a-f0-9]{64}$/.test(row.page_revision)||row.format!=='png'||row.persist!==true))return invalid();
 return row;
}

export class BrowserApprovalService{
 private readonly db:DatabaseSync;private readonly events:EventStore;
 constructor(db:DatabaseSync,events:EventStore){this.db=db;this.events=events;}

 requestBrowserApproval(identity:BrowserIdentity,sessionRef:string,callId:string,actionPayload:unknown,actionSummary:string){
  if(!this.db.isTransaction)throw new Error('browser_approval_transaction_required');
  const operation=validateBrowserActionPayload(actionPayload);
  if(typeof sessionRef!=='string'||!ID.test(sessionRef)||typeof callId!=='string'||!ID.test(callId)||operation.call_id!==callId
   ||typeof actionSummary!=='string'||!actionSummary.trim()||actionSummary.length>12_000||/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(actionSummary))invalid();
  const bound=this.db.prepare(`SELECT 1 FROM ga_harness_session_bindings s JOIN ga_conversations c ON c.id=s.conversation_id
    JOIN ga_runs r ON r.conversation_id=c.id WHERE s.conversation_id=? AND s.owner_id=? AND s.session_id=? AND c.owner_id=? AND r.id=?`)
    .get(identity.conversation_id,identity.owner_id,sessionRef,identity.owner_id,identity.run_id);
  if(!bound)throw new Error('workbench_identity_forbidden');
  const digest='sha256:'+createHash('sha256').update(canonicalJson({run_id:identity.run_id,session_ref:sessionRef,call_id:callId,action_payload:operation})).digest('hex');
  const existing=this.db.prepare("SELECT * FROM ga_interactions WHERE run_id=? AND kind='approval' ORDER BY created_at DESC").all(identity.run_id) as Array<Record<string,unknown>>;
  for(const row of existing){
   const prior=JSON.parse(String(row.request_json)) as Record<string,unknown>;
   if(prior.purpose!=='browser_action'||prior.tool_call_id!==callId)continue;
   if(row.action_digest!==digest)throw new Error('idempotency_conflict');
   return {interaction:{...prior,status:String(row.status),version:Number(row.version),...(row.response_json?{decision:(JSON.parse(String(row.response_json)) as Record<string,unknown>).decision}:{})}};
  }
  const now=new Date().toISOString(),expires=new Date(Date.now()+10*60_000).toISOString(),id=`int-${randomUUID()}`;
  const interaction={interaction_id:id,run_id:identity.run_id,tool_call_id:callId,version:1,status:'pending',created_at:now,expires_at:expires,
   kind:'approval',purpose:'browser_action',action_digest:digest,action_summary:actionSummary.trim(),risk:'medium'};
  this.db.prepare("INSERT INTO ga_interactions(id,conversation_id,run_id,kind,status,version,action_digest,request_json,expires_at,created_at) VALUES(?,?,?,'approval','pending',1,?,?,?,?)")
   .run(id,identity.conversation_id,identity.run_id,digest,JSON.stringify(interaction),expires,now);
  this.events.append(identity.conversation_id,identity.run_id,'interaction.requested',interaction);
  return {interaction};
 }

 readBrowserApproval(identity:BrowserIdentity,sessionRef:string,interactionId:string,callId:string,actionPayload:unknown){
  const operation=validateBrowserActionPayload(actionPayload);
  if(typeof sessionRef!=='string'||!ID.test(sessionRef)||typeof interactionId!=='string'||!ID.test(interactionId)||typeof callId!=='string'||!ID.test(callId)||operation.call_id!==callId)invalid();
  const bound=this.db.prepare(`SELECT 1 FROM ga_harness_session_bindings s JOIN ga_conversations c ON c.id=s.conversation_id
    JOIN ga_runs r ON r.conversation_id=c.id WHERE s.conversation_id=? AND s.owner_id=? AND s.session_id=? AND c.owner_id=? AND r.id=?`)
    .get(identity.conversation_id,identity.owner_id,sessionRef,identity.owner_id,identity.run_id);
  if(!bound)throw new Error('workbench_identity_forbidden');
  const digest='sha256:'+createHash('sha256').update(canonicalJson({run_id:identity.run_id,session_ref:sessionRef,call_id:callId,action_payload:operation})).digest('hex');
  const row=this.db.prepare(`SELECT i.* FROM ga_interactions i JOIN ga_conversations c ON c.id=i.conversation_id
    WHERE i.id=? AND i.run_id=? AND i.conversation_id=? AND c.owner_id=? AND i.kind='approval'`)
    .get(interactionId,identity.run_id,identity.conversation_id,identity.owner_id) as Record<string,unknown>|undefined;
  if(!row)throw new Error('browser_approval_not_found');
  const request=JSON.parse(String(row.request_json)) as Record<string,unknown>;
  if(request.purpose!=='browser_action'||request.tool_call_id!==callId||row.action_digest!==digest)throw new Error('action_digest_mismatch');
  if(row.status==='pending')return {state:row.expires_at&&Date.parse(String(row.expires_at))<=Date.now()?'expired':'pending'};
  if(row.status==='denied')return {state:'denied'};
  if(row.status==='answered'&&row.response_json){
   const response=JSON.parse(String(row.response_json)) as Record<string,unknown>;
   if(response.decision==='approve')return {state:'approved'};
   if(response.decision==='deny')return {state:'denied'};
  }
  throw new Error('interaction_state_conflict');
 }
}
