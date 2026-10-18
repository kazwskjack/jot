import {timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {inspectChatCompactionSource,prepareChatCompactionIntent,readChatCompactionIntent} from './chat-compaction-source.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export function registerChatCompactionSource(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 app.post('/internal/v1/workbench/chat-compaction-source',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const b=request.body as Record<string,unknown>,read=b?.action==='read';
  if(!b||typeof b!=='object'||Array.isArray(b)||!['inspect','prepare','read'].includes(String(b.action))||Object.keys(b).sort().join(',')!==(read?'action,conversation_id,expected_run_version,intent_id,owner_id,run_id,session_ref':'action,conversation_id,expected_run_version,owner_id,run_id,session_ref')
   ||!['conversation_id','owner_id','run_id','session_ref',...(read?['intent_id']:[])].every(k=>typeof b[k]==='string'&&ID.test(b[k] as string))||!Number.isSafeInteger(b.expected_run_version)||Number(b.expected_run_version)<1)return reply.code(422).send({error:{code:'CHAT_COMPACTION_SOURCE_INVALID'}});
  const scope={owner_id:b.owner_id as string,conversation_id:b.conversation_id as string,run_id:b.run_id as string,session_ref:b.session_ref as string,expected_run_version:b.expected_run_version as number};
  try{if(b.action==='inspect')return{source:inspectChatCompactionSource(db,scope)};return{intent:read?readChatCompactionIntent(db,scope,b.intent_id as string):prepareChatCompactionIntent(db,scope)};}
  catch{return reply.code(409).send({error:{code:'CHAT_COMPACTION_SOURCE_UNCONFIRMED'}});}
 });
}
