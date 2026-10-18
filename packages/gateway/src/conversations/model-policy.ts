import {createHash,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {withImmediateTransaction} from '../db/database.ts';
import {inspectOrdinaryInputBinding} from './ordinary-input-binding.ts';
import {normalizeExecutionLease} from '../workbench/execution-lease.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const canonicalModelJson=(value:unknown)=>JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
type Selection={provider:string;model:string;reasoning_effort?:string};
function selection(value:unknown):Selection{
 if(!plain(value)||!['model,provider','model,provider,reasoning_effort'].includes(Object.keys(value).sort().join(','))
  ||typeof value.provider!=='string'||!ID.test(value.provider)||typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value.model)
  ||value.reasoning_effort!==undefined&&(typeof value.reasoning_effort!=='string'||!ID.test(value.reasoning_effort)))throw Error('model_policy_invalid');
 return{provider:value.provider,model:value.model,...(value.reasoning_effort===undefined?{}:{reasoning_effort:value.reasoning_effort as string})};
}
/** Called inside acceptance's existing transaction, never from mutable metadata at dispatch. */
export function snapshotAcceptedModelPolicy(db:DatabaseSync,conversationId:string,ownerId:string){
 if(!db.isTransaction)throw Error('model_policy_acceptance_transaction_required');
 const row=db.prepare('SELECT model,version FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId,ownerId);
 if(!row||typeof row.model!=='string'||!Number.isSafeInteger(row.version)||Number(row.version)<1)throw Error('model_policy_invalid');
 return canonicalModelJson({protocol:1,conversation_version:row.version,model:JSON.parse(row.model)});
}
function readPolicyInside(db:DatabaseSync,runId:string,sessionId:string,lease:unknown){
 const authority=inspectOrdinaryInputBinding(db,runId,sessionId,lease);
 const row=db.prepare('SELECT model_policy_json,model_resolution_json FROM ga_runs WHERE id=?').get(runId);
 if(typeof row?.model_policy_json!=='string')throw Error('model_policy_missing');
 const original=JSON.parse(row.model_policy_json) as unknown;
 if(!plain(original)||Object.keys(original).sort().join(',')!=='conversation_version,model,protocol'||original.protocol!==1
  ||!Number.isSafeInteger(original.conversation_version)||Number(original.conversation_version)<1)throw Error('model_policy_invalid');
 const model=selection(original.model);
 if(canonicalModelJson(original)!==row.model_policy_json)throw Error('model_policy_invalid');
 const resolved=row.model_resolution_json===null?null:selection(JSON.parse(String(row.model_resolution_json)));
 if(resolved&&(resolved.provider!==model.provider||resolved.model!==model.model||model.reasoning_effort!==undefined&&resolved.reasoning_effort!==model.reasoning_effort))throw Error('model_resolution_invalid');
 return{...authority,model,conversation_version:Number(original.conversation_version),policy_sha256:createHash('sha256').update(row.model_policy_json).digest('hex'),resolved_model:resolved};
}
export function inspectOrdinaryModelPolicy(db:DatabaseSync,runId:string,sessionId:string,lease:unknown){
 return withImmediateTransaction(db,()=>readPolicyInside(db,runId,sessionId,lease));
}
export function bindOrdinaryModelResolution(db:DatabaseSync,runId:string,sessionId:string,lease:unknown,hash:string,requested:unknown){
 return withImmediateTransaction(db,()=>{
  const current=readPolicyInside(db,runId,sessionId,lease),resolved=selection(requested);
  if(current.policy_sha256!==hash||resolved.provider!==current.model.provider||resolved.model!==current.model.model
   ||current.model.reasoning_effort!==undefined&&resolved.reasoning_effort!==current.model.reasoning_effort)throw Error('model_resolution_invalid');
  const serialized=canonicalModelJson(resolved);
  if(current.resolved_model){if(canonicalModelJson(current.resolved_model)!==serialized)throw Error('model_resolution_conflict');return current;}
  const updated=db.prepare('UPDATE ga_runs SET model_resolution_json=? WHERE id=? AND model_resolution_json IS NULL').run(serialized,runId);
  if(updated.changes!==1)throw Error('model_resolution_conflict');
  return readPolicyInside(db,runId,sessionId,lease);
 });
}
export function registerOrdinaryModelPolicy(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 app.post('/internal/v1/workbench/ordinary-model-policy',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const body=request.body as Record<string,unknown>,keys=plain(body)?Object.keys(body).sort().join(','):'';
  const binding=keys==='action,execution_lease,model,policy_sha256,run_id,session_ref';
  if(keys!=='execution_lease,run_id,session_ref'&&!binding||typeof body?.run_id!=='string'||!ID.test(body.run_id)
   ||typeof body.session_ref!=='string'||!ID.test(body.session_ref)||binding&&(body.action!=='bind'||typeof body.policy_sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.policy_sha256)))return reply.code(422).send({error:{code:'MODEL_POLICY_INVALID'}});
  let lease;try{lease=normalizeExecutionLease(body.execution_lease);}catch{return reply.code(422).send({error:{code:'MODEL_POLICY_INVALID'}});}
  try{return{policy:binding?bindOrdinaryModelResolution(db,body.run_id,body.session_ref,lease,String(body.policy_sha256),body.model):inspectOrdinaryModelPolicy(db,body.run_id,body.session_ref,lease)};}
  catch{return reply.code(409).send({error:{code:'MODEL_POLICY_REJECTED'}});}
 });
}
