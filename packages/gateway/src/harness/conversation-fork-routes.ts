import type {FastifyInstance,FastifyRequest} from 'fastify';
import {createHash,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ConversationForks} from './conversation-fork.ts';
import {inspectOrdinaryInputBinding} from '../conversations/ordinary-input-binding.ts';
import {normalizeExecutionLease} from '../workbench/execution-lease.ts';

/** Register in the existing authenticated Jot Gateway. The actor is the
 * original channel/session actor; no owner/session/grant comes from the body. */
type AtomicCommand=<T>(request:FastifyRequest,status:number,operation:()=>T)=>T;

export function registerConversationForkRoutes(app:FastifyInstance,{forks,actor,atomicCommand}:{forks:ConversationForks;actor:(request:FastifyRequest)=>string;atomicCommand:AtomicCommand}){
 app.post('/v1/conversations/:conversationId/fork',async(request,reply)=>{
  const abort=new AbortController(),cancel=()=>abort.abort();request.raw.once('aborted',cancel);
  try{
   const result=await forks.fork(actor(request),String((request.params as Record<string,unknown>).conversationId),request.body,String(request.headers['idempotency-key']??''),abort.signal);
   const receipt=atomicCommand(request,201,()=>result);
   return reply.code(201).send(receipt);
  }catch(error){
   if(abort.signal.aborted)return reply.code(409).send({error:{code:'FORK_CANCELLED'}});
   const reason=(error as Error)?.message;
   if(reason==='conversation_not_found')return reply.code(404).send({error:{code:'CONVERSATION_NOT_FOUND'}});
   if(reason==='fork_input_invalid')return reply.code(400).send({error:{code:'FORK_INPUT_INVALID'}});
   if(reason==='fork_idempotency_conflict')return reply.code(409).send({error:{code:'IDEMPOTENCY_CONFLICT'}});
   if(reason==='fork_boundary_not_found')return reply.code(409).send({error:{code:'FORK_BOUNDARY_NOT_FOUND'}});
   if(reason==='fork_source_changed')return reply.code(409).send({error:{code:'FORK_SOURCE_CHANGED'}});
   if(reason==='fork_attachment_count_invalid'||reason==='fork_attachment_aggregate_size_invalid')return reply.code(413).send({error:{code:reason.toUpperCase()}});
   if(['fork_source_unsettled','fork_source_session_missing','fork_message_projection_unsupported','fork_attachment_provenance_required','fork_attachment_bytes_unverified','fork_target_unavailable'].includes(reason))return reply.code(409).send({error:{code:reason.toUpperCase()}});
   return reply.code(503).send({error:{code:'FORK_SOURCE_UNAVAILABLE'}});
  }finally{request.raw.off('aborted',cancel);}
 });
}

/** Uses the existing input binding and lease authority. This is an inert
 * history read, not a new admission, execution permission or completion gate. */
export function registerConversationForkContextRoute(app:FastifyInstance,{db,forks,token}:{db:DatabaseSync;forks?:ConversationForks;token:string|undefined}){
 app.post('/internal/v1/workbench/ordinary-fork-context',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected='Bearer '+(token??'');
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const body=request.body as Record<string,unknown>;
  if(!body||Array.isArray(body)||Object.keys(body).sort().join(',')!=='execution_lease,run_id,session_ref'||![body.run_id,body.session_ref].every(v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v)))return reply.code(422).send({error:{code:'FORK_CONTEXT_INPUT_INVALID'}});
  let lease;try{lease=normalizeExecutionLease(body.execution_lease);}catch{return reply.code(422).send({error:{code:'FORK_CONTEXT_INPUT_INVALID'}});}
  try{
   const authority=inspectOrdinaryInputBinding(db,String(body.run_id),String(body.session_ref),lease),manifest=forks?.context(authority.owner_id,authority.conversation_id,authority.session_id)??null;
   if(manifest===null)return{context:null};
   const canonical=JSON.stringify(manifest,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
   return{context:{authority,manifest,manifest_sha256:createHash('sha256').update(canonical).digest('hex')}};
  }catch{return reply.code(409).send({error:{code:'FORK_CONTEXT_REJECTED'}});}
 });
}
