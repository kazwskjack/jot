import {createHash,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {withImmediateTransaction} from '../db/database.ts';
import {inspectOrdinaryInputBinding} from './ordinary-input-binding.ts';
import {normalizeExecutionLease} from '../workbench/execution-lease.ts';
import {acceptedModelMetadataBindings,type TrustedModelMetadataBinding} from '../harness/model-metadata.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const canonicalModelJson=(value:unknown)=>JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
type RouteSelection={provider:string;model:string;reasoning_effort?:string};
type Selection=RouteSelection&{fallbacks?:Array<{provider:string;model:string}>};
function routeSelection(value:unknown):RouteSelection{
 if(!plain(value)||!['model,provider','model,provider,reasoning_effort'].includes(Object.keys(value).sort().join(','))
  ||typeof value.provider!=='string'||!ID.test(value.provider)||typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(value.model)
  ||value.reasoning_effort!==undefined&&(typeof value.reasoning_effort!=='string'||!ID.test(value.reasoning_effort)))throw Error('model_policy_invalid');
 return{provider:value.provider,model:value.model,...(value.reasoning_effort===undefined?{}:{reasoning_effort:value.reasoning_effort as string})};
}
function selection(value:unknown):Selection{
 if(!plain(value)||!['model,provider','model,provider,reasoning_effort','fallbacks,model,provider','fallbacks,model,provider,reasoning_effort'].includes(Object.keys(value).sort().join(',')))throw Error('model_policy_invalid');
 const{fallbacks,...base}=value,primary=routeSelection(base);
 if(fallbacks!==undefined){
  if(!Array.isArray(fallbacks)||fallbacks.length>3)throw Error('model_policy_invalid');
  const seen=new Set([JSON.stringify([primary.provider,primary.model])]),routes=[];
  for(const value of fallbacks){const candidate=routeSelection(value),key=JSON.stringify([candidate.provider,candidate.model]);if(seen.has(key))throw Error('model_policy_invalid');seen.add(key);routes.push({provider:candidate.provider,model:candidate.model});}
  return{...primary,fallbacks:routes};
 }
 return primary;
}
export function modelMetadataRoutes(value:unknown){const selected=selection(value);return[{provider:selected.provider,model:selected.model},...(selected.fallbacks??[])];}
export function acceptedModelPolicyCandidates(serialized:unknown){
 if(typeof serialized!=='string')throw Error('model_policy_invalid');
 const original=JSON.parse(serialized) as unknown;
 if(!plain(original)||!['conversation_version,metadata_bindings,model,protocol','conversation_version,model,protocol'].includes(Object.keys(original).sort().join(','))||original.protocol!==1
  ||!Number.isSafeInteger(original.conversation_version)||Number(original.conversation_version)<1)throw Error('model_policy_invalid');
 const model=selection(original.model);if(original.metadata_bindings!==undefined)acceptedModelMetadataBindings(original.metadata_bindings,[{provider:model.provider,model:model.model},...(model.fallbacks??[])]);
 if(canonicalModelJson(original)!==serialized)throw Error('model_policy_invalid');
 return [{provider:model.provider,model:model.model},...(model.fallbacks??[])];
}
/** Called inside acceptance's existing transaction, never from mutable metadata at dispatch. */
export function snapshotAcceptedModelPolicy(db:DatabaseSync,conversationId:string,ownerId:string,modelOverride?:Selection,metadataBindings?:TrustedModelMetadataBinding[]){
 if(!db.isTransaction)throw Error('model_policy_acceptance_transaction_required');
 const row=db.prepare('SELECT model,version FROM ga_conversations WHERE id=? AND owner_id=?').get(conversationId,ownerId);
 if(!row||typeof row.model!=='string'||!Number.isSafeInteger(row.version)||Number(row.version)<1)throw Error('model_policy_invalid');
 const model=selection(modelOverride===undefined?JSON.parse(row.model):modelOverride),base={protocol:1,conversation_version:row.version,model};
 if(metadataBindings===undefined)return canonicalModelJson(base);
 const metadata_bindings=acceptedModelMetadataBindings(metadataBindings,[{provider:model.provider,model:model.model},...(model.fallbacks??[])]);
 return canonicalModelJson({...base,metadata_bindings});
}
function readPolicyInside(db:DatabaseSync,runId:string,sessionId:string,lease:unknown){
 const authority=inspectOrdinaryInputBinding(db,runId,sessionId,lease);
 const row=db.prepare('SELECT model_policy_json,model_resolution_json FROM ga_runs WHERE id=?').get(runId);
 if(typeof row?.model_policy_json!=='string')throw Error('model_policy_missing');
 const original=JSON.parse(row.model_policy_json) as unknown;
 if(!plain(original)||!['conversation_version,metadata_bindings,model,protocol','conversation_version,model,protocol'].includes(Object.keys(original).sort().join(','))||original.protocol!==1
  ||!Number.isSafeInteger(original.conversation_version)||Number(original.conversation_version)<1)throw Error('model_policy_invalid');
 const model=selection(original.model);
 const metadata_bindings=original.metadata_bindings===undefined?undefined:acceptedModelMetadataBindings(original.metadata_bindings,[{provider:model.provider,model:model.model},...(model.fallbacks??[])]);
 if(canonicalModelJson(original)!==row.model_policy_json)throw Error('model_policy_invalid');
 const resolved=row.model_resolution_json===null?null:routeSelection(JSON.parse(String(row.model_resolution_json)));
 if(resolved&&((resolved.provider!==model.provider||resolved.model!==model.model)
  &&!(model.fallbacks??[]).some(route=>route.provider===resolved.provider&&route.model===resolved.model)
  ||model.reasoning_effort!==undefined&&resolved.reasoning_effort!==model.reasoning_effort))throw Error('model_resolution_invalid');
 return{...authority,model,...(metadata_bindings===undefined?{}:{metadata_bindings}),conversation_version:Number(original.conversation_version),policy_sha256:createHash('sha256').update(row.model_policy_json).digest('hex'),resolved_model:resolved};
}
export function inspectOrdinaryModelPolicy(db:DatabaseSync,runId:string,sessionId:string,lease:unknown){
 return withImmediateTransaction(db,()=>readPolicyInside(db,runId,sessionId,lease));
}
export function bindOrdinaryModelResolution(db:DatabaseSync,runId:string,sessionId:string,lease:unknown,hash:string,requested:unknown){
 return withImmediateTransaction(db,()=>{
  const current=readPolicyInside(db,runId,sessionId,lease),resolved=routeSelection(requested);
  const primary=resolved.provider===current.model.provider&&resolved.model===current.model.model;
  const alternate=(current.model.fallbacks??[]).some(route=>route.provider===resolved.provider&&route.model===resolved.model);
  if(current.policy_sha256!==hash||!primary&&!alternate
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
