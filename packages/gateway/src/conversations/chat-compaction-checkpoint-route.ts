import {timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {ChatCompactionCheckpoints} from './chat-compaction-checkpoints.ts';
export function registerChatCompactionCheckpoints(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 const store=new ChatCompactionCheckpoints(db);
 app.post('/internal/v1/workbench/chat-compaction-checkpoint',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const b=request.body as Record<string,unknown>;
  if(b?.action==='read'){
   if(typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='action,attempt_id,conversation_id,expected_run_version,fence_id,intent_id,observer_id,owner_id,run_id,session_ref'||!['owner_id','conversation_id','run_id','session_ref','intent_id','attempt_id','observer_id','fence_id'].every(k=>typeof b[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(b[k] as string))||!Number.isSafeInteger(b.expected_run_version)||Number(b.expected_run_version)<1)return reply.code(422).send({error:{code:'CHAT_CHECKPOINT_INVALID'}});
   try{return{checkpoint:store.read({owner_id:b.owner_id as string,conversation_id:b.conversation_id as string,run_id:b.run_id as string,session_ref:b.session_ref as string,expected_run_version:b.expected_run_version as number},{intent_id:b.intent_id as string,attempt_id:b.attempt_id as string,observer_id:b.observer_id as string,fence_id:b.fence_id as string})};}
   catch{return reply.code(409).send({error:{code:'CHAT_CHECKPOINT_UNCONFIRMED'}});}
  }
  if(!b||typeof b!=='object'||Array.isArray(b)||b.action!=='publish'||Object.keys(b).sort().join(',')!=='action,attempt_id,conversation_id,expected_run_version,fence_id,intent_id,observer_id,owner_id,run_id,session_ref,source_sha256,summary_text,witness'||!['owner_id','conversation_id','run_id','session_ref','intent_id','attempt_id','fence_id','observer_id'].every(k=>typeof b[k]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(b[k] as string))||!Number.isSafeInteger(b.expected_run_version)||Number(b.expected_run_version)<1)return reply.code(422).send({error:{code:'CHAT_CHECKPOINT_INVALID'}});
  const scope={owner_id:b.owner_id as string,conversation_id:b.conversation_id as string,run_id:b.run_id as string,session_ref:b.session_ref as string,expected_run_version:b.expected_run_version as number};
  try{return{checkpoint:store.publish(scope,{intent_id:b.intent_id as string,attempt_id:b.attempt_id as string,fence_id:b.fence_id as string,observer_id:b.observer_id as string,source_sha256:b.source_sha256 as string,summary_text:b.summary_text as string,witness:b.witness})};}
  catch{return reply.code(409).send({error:{code:'CHAT_CHECKPOINT_UNCONFIRMED'}});}
 });
}
