import {timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {FastifyInstance} from 'fastify';
import {normalizeExecutionLease} from '../workbench/execution-lease.ts';
import {reserveOrdinaryChatWeb} from './chat-web-allowance.ts';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export function registerOrdinaryChatWeb(app:FastifyInstance,db:DatabaseSync,token:string|undefined){
 app.post('/internal/v1/workbench/ordinary-chat-web',async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const b=request.body as Record<string,unknown>;
  if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).sort().join(',')!=='call_id,execution_lease,group,run_id,session_ref'||!['call_id','run_id','session_ref'].every(k=>typeof b[k]==='string'&&ID.test(b[k] as string)))return reply.code(422).send({error:{code:'CHAT_WEB_INVALID'}});
  try{return{reservation:reserveOrdinaryChatWeb(db,{run_id:b.run_id as string,session_ref:b.session_ref as string,execution_lease:normalizeExecutionLease(b.execution_lease),group:b.group,call_id:b.call_id as string})};}
  catch(error){return reply.code(409).send({error:{code:error instanceof Error&&error.message==='chat_web_group_exhausted'?'CHAT_WEB_ALLOWANCE_CONSUMED':'CHAT_WEB_UNCONFIRMED'}});}
 });
}
