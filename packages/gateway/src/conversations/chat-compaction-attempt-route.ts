import {timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {ChatCompactionAttempts} from './chat-compaction-attempts.ts';
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
export function registerChatCompactionAttempts(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 const ledger=new ChatCompactionAttempts(db);
 app.post('/internal/v1/workbench/chat-compaction-attempt',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const b=request.body as Record<string,unknown>,action=b?.action;
  const extra=action==='reserve'?['request','witness']:action==='settle'?['fence_id','usage']:action==='unknown'?['fence_id','reason',...(Object.hasOwn(b??{},'usage')?['usage']:[])]:['fence_id'];
  const keys=['action','owner_id','conversation_id','run_id','session_ref','expected_run_version','intent_id','attempt_id','observer_id',...extra];
  if(!b||typeof b!=='object'||Array.isArray(b)||!['reserve','read','dispatch','release','unknown','settle'].includes(String(action))||Object.keys(b).sort().join(',')!==keys.sort().join(',')
   ||!['owner_id','conversation_id','run_id','session_ref','intent_id','attempt_id','observer_id',...(action==='reserve'?[]:['fence_id'])].every(k=>id(b[k]))||!Number.isSafeInteger(b.expected_run_version)||Number(b.expected_run_version)<1)return reply.code(422).send({error:{code:'CHAT_COMPACTION_ATTEMPT_INVALID'}});
  const scope={owner_id:b.owner_id as string,conversation_id:b.conversation_id as string,run_id:b.run_id as string,session_ref:b.session_ref as string,expected_run_version:b.expected_run_version as number},base={intent_id:b.intent_id as string,attempt_id:b.attempt_id as string,observer_id:b.observer_id as string},binding={...base,fence_id:b.fence_id as string};
  try{
   const receipt=action==='reserve'?ledger.reserve(scope,{...base,request:b.request,witness:b.witness}):action==='read'?ledger.read(scope,binding):action==='dispatch'?ledger.dispatch(scope,binding):action==='release'?ledger.release(scope,binding):action==='settle'?ledger.settle(scope,binding,b.usage):ledger.unknown(scope,binding,String(b.reason),b.usage);
   return{receipt};
  }catch{return reply.code(409).send({error:{code:'CHAT_COMPACTION_ATTEMPT_UNCONFIRMED'}});}
 });
}
