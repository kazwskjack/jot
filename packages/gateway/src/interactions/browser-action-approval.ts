import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {EventStore} from '../events/event-store.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {validateBrowserActionPayload} from './browser-approval.ts';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
type BindingInput={ownerId:string;runId:string;sessionRef:string};
export type BrowserActionRequest=BindingInput&{callId:string;actionPayload:unknown;actionSummary:string};
export type BrowserActionObservation=BindingInput&{interactionId:string;callId:string;actionPayload:unknown};
type InteractionRow=Record<string,unknown>;

function validPayload(value:unknown,callId:string):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('workbench_browser_approval_invalid');
  let payload:Record<string,unknown>;
  try{payload=validateBrowserActionPayload(JSON.parse(JSON.stringify(value)));}catch{throw new Error('workbench_browser_approval_invalid');}
  if(payload.tool!=='browser_action'||payload.call_id!==callId)throw new Error('workbench_browser_approval_invalid');
  return payload;
}

function validBinding(db:DatabaseSync,{ownerId,runId,sessionRef}:BindingInput):string{
  if(![ownerId,runId,sessionRef].every(value=>typeof value==='string'&&ID.test(value)))throw new Error('workbench_identity_forbidden');
  const row=db.prepare(`SELECT r.conversation_id FROM ga_runs r
    JOIN ga_conversations c ON c.id=r.conversation_id
    JOIN ga_harness_session_bindings b ON b.conversation_id=c.id AND b.owner_id=c.owner_id
    WHERE r.id=? AND b.session_id=? AND c.owner_id=?`).get(runId,sessionRef,ownerId) as {conversation_id:string}|undefined;
  if(!row)throw new Error('workbench_identity_forbidden');
  return row.conversation_id;
}

function actionDigest(runId:string,sessionRef:string,callId:string,payload:Record<string,unknown>):string{
  return 'sha256:'+createHash('sha256').update(canonicalJson({run_id:runId,session_ref:sessionRef,call_id:callId,action_payload:payload})).digest('hex');
}

function requestFor(row:InteractionRow):Record<string,unknown>{
  try{return JSON.parse(String(row.request_json)) as Record<string,unknown>;}catch{throw new Error('workbench_browser_approval_invalid');}
}

function findPrior(db:DatabaseSync,conversationId:string,runId:string,callId:string):InteractionRow|undefined{
  const rows=db.prepare("SELECT * FROM ga_interactions WHERE conversation_id=? AND run_id=? AND kind='approval' ORDER BY created_at,id")
    .all(conversationId,runId) as InteractionRow[];
  return rows.find(row=>{
    const request=requestFor(row);
    return request.purpose==='browser_action'&&request.tool_call_id===callId;
  });
}

export function createBrowserActionInteraction(db:DatabaseSync,events:EventStore,input:BrowserActionRequest):InteractionRow{
  if(!db.isTransaction)throw new Error('browser_approval_transaction_required');
  const conversationId=validBinding(db,input),{runId,sessionRef,callId}=input;
  if(typeof callId!=='string'||!ID.test(callId)||typeof input.actionSummary!=='string'||!input.actionSummary.trim()||input.actionSummary.length>12_000||/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(input.actionSummary))
    throw new Error('workbench_browser_approval_invalid');
  const payload=validPayload(input.actionPayload,callId),digest=actionDigest(runId,sessionRef,callId,payload);
  const prior=findPrior(db,conversationId,runId,callId);
  if(prior){
    const request=requestFor(prior);
    if(prior.action_digest!==digest||request.action_digest!==digest||request.run_id!==runId||request.interaction_id!==prior.id||request.action_summary!==input.actionSummary)
      throw new Error('idempotency_conflict');
    return prior;
  }
  const now=new Date(),createdAt=now.toISOString(),expiresAt=new Date(now.getTime()+15*60_000).toISOString(),id=`int-${randomUUID()}`;
  const request={interaction_id:id,run_id:runId,tool_call_id:callId,version:1,status:'pending',created_at:createdAt,expires_at:expiresAt,
    kind:'approval',purpose:'browser_action',action_digest:digest,action_summary:input.actionSummary,risk:'medium'};
  db.prepare('INSERT INTO ga_interactions(id,conversation_id,run_id,kind,status,version,action_digest,request_json,expires_at,created_at) VALUES(?,?,?,\'approval\',\'pending\',1,?,?,?,?)')
    .run(id,conversationId,runId,digest,JSON.stringify(request),expiresAt,createdAt);
  events.append(conversationId,runId,'interaction.requested',request);
  const row=db.prepare('SELECT * FROM ga_interactions WHERE id=?').get(id) as InteractionRow|undefined;
  if(!row)throw new Error('workbench_browser_approval_invalid');
  return row;
}

export function readBrowserActionInteraction(db:DatabaseSync,input:BrowserActionObservation):{state:'pending'|'approved'|'denied'|'expired';row:InteractionRow}{
  const conversationId=validBinding(db,input),{ownerId,runId,sessionRef,interactionId,callId}=input;
  if(typeof interactionId!=='string'||!ID.test(interactionId)||typeof callId!=='string'||!ID.test(callId))throw new Error('workbench_browser_approval_invalid');
  const payload=validPayload(input.actionPayload,callId);
  const row=db.prepare(`SELECT i.* FROM ga_interactions i
    JOIN ga_conversations c ON c.id=i.conversation_id
    WHERE i.id=? AND i.conversation_id=? AND i.run_id=? AND c.owner_id=? AND i.kind='approval'`)
    .get(interactionId,conversationId,runId,ownerId) as InteractionRow|undefined;
  if(!row)throw new Error('interaction_not_found');
  const request=requestFor(row),digest=actionDigest(runId,sessionRef,callId,payload);
  if(request.purpose!=='browser_action'||request.run_id!==runId||request.interaction_id!==interactionId||request.tool_call_id!==callId
    ||request.action_digest!==digest||row.action_digest!==digest)throw new Error('workbench_browser_approval_invalid');
  if(row.status==='denied')return{state:'denied',row};
  if(row.status==='expired')return{state:'expired',row};
  if(row.status==='pending')return{state:row.expires_at&&Date.parse(String(row.expires_at))<=Date.now()?'expired':'pending',row};
  if(row.status==='answered'){
    let response:Record<string,unknown>;
    try{response=JSON.parse(String(row.response_json)) as Record<string,unknown>;}catch{throw new Error('workbench_browser_approval_invalid');}
    if(response.decision==='approve')return{state:'approved',row};
    if(response.decision==='deny')return{state:'denied',row};
  }
  throw new Error('workbench_browser_approval_invalid');
}
