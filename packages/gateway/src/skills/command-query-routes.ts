import {timingSafeEqual} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import {NativeCommandQueryJournal} from './command-query-journal.ts';
import type {SkillCatalogService,SkillCatalogHost} from './catalog.ts';

export function registerNativeCommandQueryRoutes(app:FastifyInstance,{db,catalog,client,actor,token}:{
 db:DatabaseSync;catalog:SkillCatalogService;client:SkillCatalogHost;actor:(request:FastifyRequest)=>string;token:string|undefined;
}){
 const journal=new NativeCommandQueryJournal(db);
 const owned=(request:FastifyRequest)=>{
  const owner=actor(request),params=request.params as {runId:string;requestId?:string};
  if(!db.prepare('SELECT 1 FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=?').get(params.runId,owner))throw Error('native_command_query_not_found');
  return {owner,...params};
 };
 const error=(reply:any,cause:unknown)=>{
  const code=cause instanceof Error?cause.message:'';
  if(code==='native_command_query_invalid')return reply.code(422).send({error:{code:'NATIVE_COMMAND_QUERY_INVALID'}});
  if(['native_command_query_conflict','skill_catalog_scope_changed'].includes(code))return reply.code(409).send({error:{code:'NATIVE_COMMAND_QUERY_CONFLICT'}});
  if(['native_command_query_not_found','skill_catalog_scope_forbidden'].includes(code))return reply.code(404).send({error:{code:'NATIVE_COMMAND_QUERY_NOT_FOUND'}});
  throw cause;
 };
 app.post('/v1/runs/:runId/native-command-queries',{config:{nativeCommandQueryMutation:true}},async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{
   if(Object.keys(request.query as object).length)throw Error('native_command_query_invalid');
   const {owner,runId}=owned(request),input=request.body as Record<string,unknown>;
   if(!input||input.request_id!==request.headers['idempotency-key'])throw Error('native_command_query_invalid');
   if(!client.executeCommandQuery)return reply.code(503).send({error:{code:'NATIVE_COMMAND_QUERY_UNAVAILABLE'}});
   const prepared=journal.prepare(owner,runId,input,()=>catalog.originalScope(owner,runId));
   if(prepared.packet){
    try{
     await client.executeCommandQuery(prepared.packet);
     const settled=journal.read(owner,runId,prepared.receipt.request_id);
     if(['prepared','dispatched'].includes(settled.state))journal.finish(prepared.packet,'unknown');
    }
    catch{try{journal.finish(prepared.packet,'unknown');}catch{}}
   }
   return reply.code(202).send({accepted:true,request_id:prepared.receipt.request_id,run_id:runId});
  }catch(cause){return error(reply,cause);}
 });
 app.get('/v1/runs/:runId/native-command-queries',async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{if(Object.keys(request.query as object).length)throw Error('native_command_query_invalid');const {owner,runId}=owned(request);return journal.list(owner,runId);}
  catch(cause){return error(reply,cause);}
 });
 app.get('/v1/runs/:runId/native-command-queries/:requestId',async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{if(Object.keys(request.query as object).length)throw Error('native_command_query_invalid');const {owner,runId,requestId}=owned(request);return journal.read(owner,runId,requestId!);}
  catch(cause){return error(reply,cause);}
 });
 app.post('/v1/runs/:runId/native-command-queries/:requestId/close',{config:{nativeCommandQueryMutation:true}},async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{
   const {owner,runId,requestId}=owned(request),input=request.body as Record<string,unknown>;
   if(Object.keys(request.query as object).length||!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).join(',')!=='name'||requestId!==request.headers['idempotency-key'])throw Error('native_command_query_invalid');
   return journal.close(owner,runId,requestId!,input.name);
  }catch(cause){return error(reply,cause);}
 });
 for(const action of ['claim','settle'] as const)app.post(`/internal/v1/workbench/native-command-query-${action}`,
  {config:{skillReadInternal:true},bodyLimit:8*1024*1024},async(request,reply)=>{
   const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
   if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
   const input=request.body as Record<string,any>,allowed=['scope','request','grant_token','run_id','session_ref',...(action==='settle'?['state','result']:[])];
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key))
    ||!input.scope||input.run_id!==input.scope.run_id||input.session_ref!==input.scope.session_ref
    ||action==='settle'&&!['settled','unknown','rejected'].includes(input.state))return reply.code(422).send({error:{code:'NATIVE_COMMAND_QUERY_INVALID'}});
   return action==='claim'?journal.claim(input,scope=>catalog.assertScopeCurrent(scope)):journal.finish(input,input.state,input.result);
  });
}
