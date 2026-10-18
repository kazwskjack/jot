import {timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {withImmediateTransaction} from '../db/database.ts';
import {normalizeExecutionLease} from '../workbench/execution-lease.ts';
import {inspectOrdinaryInputBinding} from './ordinary-input-binding.ts';
import {executionPolicy,policyHash} from './mode-policy.ts';
import {canonicalModelJson} from './model-policy.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Original accepted policy only. Reading it does not grant native execution. */
export function inspectOrdinaryExecutionPolicy(db:DatabaseSync,run:string,session:string,lease:unknown){
 return withImmediateTransaction(db,()=>{
  const authority=inspectOrdinaryInputBinding(db,run,session,lease),row=db.prepare('SELECT execution_policy_json,model_policy_json FROM ga_runs WHERE id=?').get(run);
  if(typeof row?.execution_policy_json!=='string'||typeof row.model_policy_json!=='string')throw Error('execution_policy_missing');
  const policy=executionPolicy(JSON.parse(row.execution_policy_json),row.model_policy_json);
  if(canonicalModelJson(policy)!==row.execution_policy_json)throw Error('execution_policy_invalid');
  return{...authority,policy,policy_sha256:policyHash(row.execution_policy_json)};
 });
}
export function registerOrdinaryExecutionPolicy(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 app.post('/internal/v1/workbench/ordinary-execution-policy',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const b=request.body as Record<string,unknown>;
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='execution_lease,run_id,session_ref'||typeof b.run_id!=='string'||!ID.test(b.run_id)||typeof b.session_ref!=='string'||!ID.test(b.session_ref))return reply.code(422).send({error:{code:'EXECUTION_POLICY_INVALID'}});
  try{return{execution:inspectOrdinaryExecutionPolicy(db,b.run_id,b.session_ref,normalizeExecutionLease(b.execution_lease))};}
  catch{return reply.code(409).send({error:{code:'EXECUTION_POLICY_REJECTED'}});}
 });
}
