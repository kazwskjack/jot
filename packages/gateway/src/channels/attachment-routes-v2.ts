import {timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {ArtifactService} from '../artifacts/service.ts';
import type {ChannelIntakeService} from './intake.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {readVerifiedChannelBinding,requireVerifiedChannelThread} from './authority-proofs.ts';

const marker=Symbol('original-channel-attachment-intake-v2');
declare module 'fastify' {interface FastifyContextConfig {[marker]?:true}}
/** Original server may exempt only these registered, mandatory-bearer routes
 * from its web CSRF/idempotency handler. A request JSON cannot mint the marker. */
export function isChannelAttachmentIntakeV2Route(request:FastifyRequest){
 return request.routeOptions.config?.[marker]===true;
}
const failures:Record<string,{status:number;code:string}>={
 channel_attachment_event_conflict:{status:409,code:'CHANNEL_ATTACHMENT_EVENT_CONFLICT'},
 channel_attachment_context_changed:{status:409,code:'CHANNEL_ATTACHMENT_CONTEXT_CHANGED'},
 channel_attachment_batch_incomplete:{status:409,code:'CHANNEL_ATTACHMENT_BATCH_INCOMPLETE'},
 channel_attachment_stage_expired:{status:410,code:'CHANNEL_ATTACHMENT_STAGE_EXPIRED'},
 channel_attachment_stage_unavailable:{status:409,code:'CHANNEL_ATTACHMENT_STAGE_UNAVAILABLE'},
 channel_attachment_authority_mismatch:{status:403,code:'CHANNEL_ATTACHMENT_SCOPE_UNAVAILABLE'},
 channel_authority_binding_missing:{status:403,code:'CHANNEL_ATTACHMENT_SCOPE_UNAVAILABLE'},
 channel_attachment_manifest_invalid:{status:422,code:'CHANNEL_ATTACHMENT_MANIFEST_INVALID'},
 channel_attachment_stage_invalid:{status:422,code:'CHANNEL_ATTACHMENT_STAGE_INVALID'},
 upload_sha256_mismatch:{status:422,code:'CHANNEL_ATTACHMENT_HASH_MISMATCH'},
 upload_size_mismatch:{status:422,code:'CHANNEL_ATTACHMENT_SIZE_MISMATCH'},
 upload_state_conflict:{status:409,code:'CHANNEL_ATTACHMENT_PART_CONFLICT'},
 channel_attachment_media_mismatch:{status:422,code:'CHANNEL_ATTACHMENT_MEDIA_MISMATCH'},
};
function envelope(value:unknown):string{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='manifest_sha256,protocol'||!('protocol' in value)||value.protocol!==2||!('manifest_sha256' in value)||typeof value.manifest_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.manifest_sha256))throw Error('channel_attachment_manifest_invalid');
 return value.manifest_sha256;
}
/** Register on the original app with its existing producer and database.
 * No new DB, store, authority, listener, provider or background loop is created. */
export function registerChannelAttachmentIntakeV2(app:FastifyInstance,deps:{db:DatabaseSync;intake:ChannelIntakeService;artifacts:ArtifactService;internalChannelToken:string;admission:'enabled'|'unavailable'|'recovery_only'}){
 const {db,intake,artifacts,internalChannelToken:token}=deps;
 const mode=deps.admission;
 if(!['enabled','unavailable','recovery_only'].includes(mode)||typeof token!=='string'||token.length<16||!intake.usesDatabase(db)||!artifacts.usesDatabase(db))throw Error('channel_attachment_intake_config_invalid');
 const expected=Buffer.from('Bearer '+token),config=Object.freeze({[marker]:true as const});
 const authenticate=async(request:FastifyRequest,reply:FastifyReply)=>{
  reply.header('cache-control','no-store');const actual=Buffer.from(String(request.headers.authorization??''));
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  if(!isChannelAttachmentIntakeV2Route(request))throw Error('channel_attachment_intake_config_invalid');
 };
 if(!app.hasContentTypeParser('application/octet-stream'))app.addContentTypeParser('application/octet-stream',(_request,stream,done)=>done(null,stream));
 const execute=async(reply:FastifyReply,action:()=>unknown|Promise<unknown>,status=200)=>{
  try{return reply.code(status).send(await action());}
  catch(error){const detail=failures[error instanceof Error?error.message:'']??{status:503,code:'CHANNEL_ATTACHMENT_UNAVAILABLE'};return reply.code(detail.status).send({error:{code:detail.code}});}
 };
 const scoped=(key:string,hash:string)=>withImmediateTransaction(db,()=>{
  if(!/^[a-f0-9]{64}$/.test(hash))throw Error('channel_attachment_manifest_invalid');
  const stage=artifacts.readChannelUploadBatch(key);if(!stage)throw Error('channel_attachment_stage_unavailable');
  if(stage.manifest_sha256!==hash)throw Error('channel_attachment_event_conflict');
  const binding=readVerifiedChannelBinding(db,stage.source.event.channel,stage.source.event.principal);
  requireVerifiedChannelThread(db,binding,stage.source.event.thread_id);
  if(binding.owner_id!==stage.source.owner_id||binding.channel_binding_id!==stage.source.channel_binding_id||binding.version!==stage.source.binding_version)throw Error('channel_attachment_authority_mismatch');
  return binding;
 });
 const prefix='/internal/v2/channel/attachment-batches';
 app.post(prefix+'/lookup',{config,onRequest:authenticate},(request,reply)=>execute(reply,()=>intake.lookupAttachmentBatchRequestV2(request.body,artifacts)));
 app.post(prefix+'/:stageKey/receipt',{config,onRequest:authenticate},(request,reply)=>execute(reply,()=>{
  const {stageKey}=request.params as {stageKey:string};
  try{const binding=scoped(stageKey,envelope(request.body));return intake.lookupAttachmentBatchV2(binding.owner_id,binding.channel_binding_id,stageKey,artifacts);}
  catch{return{protocol:2,state:'unproven',original_admission:'unproven',automatic_replay:false};}
 }));
 if(mode==='recovery_only')return;
 const authenticateMutation=async(request:FastifyRequest,reply:FastifyReply)=>{await authenticate(request,reply);if(reply.sent)return;if(mode!=='enabled')return reply.code(503).send({error:{code:'CHANNEL_ATTACHMENT_NATIVE_UNAVAILABLE'}});};
 app.post(prefix,{config,onRequest:authenticateMutation},(request,reply)=>execute(reply,()=>intake.reserveAttachmentBatchV2(request.body,artifacts),201));
 app.put(prefix+'/:stageKey/parts/:index',{config,onRequest:authenticateMutation,bodyLimit:100*1024*1024},(request,reply)=>execute(reply,async()=>{
  const {stageKey,index}=request.params as {stageKey:string;index:string};if(!/^(0|[1-9])$/.test(index)||String(request.headers['content-type']??'').split(';')[0]!=='application/octet-stream')throw Error('channel_attachment_stage_invalid');
  const binding=scoped(stageKey,String(request.headers['x-channel-manifest-sha256']??'')),body=request.body as AsyncIterable<Uint8Array>;
  if(!body||typeof body[Symbol.asyncIterator]!=='function')throw Error('channel_attachment_stage_invalid');
  const controller=new AbortController(),abort=()=>controller.abort();request.raw.once('aborted',abort);
  try{if(request.raw.aborted)controller.abort();await intake.writeAttachmentBatchPartV2(binding.owner_id,binding.channel_binding_id,stageKey,Number(index),body,artifacts,controller.signal);return{protocol:2,state:'part_staged',index:Number(index)};}
  finally{request.raw.removeListener('aborted',abort);}
 }));
 app.post(prefix+'/:stageKey/admit',{config,onRequest:authenticateMutation},(request,reply)=>execute(reply,async()=>{
  const {stageKey}=request.params as {stageKey:string},binding=scoped(stageKey,envelope(request.body));
  return intake.acceptAttachmentBatchV2(binding.owner_id,binding.channel_binding_id,stageKey,artifacts);
 },202));
}
