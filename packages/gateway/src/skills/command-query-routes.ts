import {timingSafeEqual} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import {NativeCommandQueryJournal} from './command-query-journal.ts';
import type {SkillCatalogService,SkillCatalogHost} from './catalog.ts';

const planPolicyPath=import.meta.url.endsWith('/dist/src/skills/command-query-routes.js')?'../../../../skills/plan-mode-command.js':'../../../skills/plan-mode-command.js';
const {nativePlanModePolicy}=await import(new URL(planPolicyPath,import.meta.url).href) as typeof import('../../../skills/plan-mode-command.js');

type NativeCommandRouteOptions={
 db:DatabaseSync;
 catalog:SkillCatalogService;
 client:SkillCatalogHost;
 actor:(request:FastifyRequest)=>string;
 token:string|undefined;
 operation?:{
  journal:NativeCommandQueryJournal;
  path:'native-plan-mode';
  prefix:'native-plan-mode';
  execute?:SkillCatalogHost['executePlanMode'];
  reconcile?:SkillCatalogHost['reconcilePlanMode'];
  assertScope:(scope:unknown)=>void;
 };
};
export function registerNativePlanModeRoutes(app:FastifyInstance,options:Omit<NativeCommandRouteOptions,'operation'>){
 return registerNativeCommandQueryRoutes(app,{...options,operation:{
  journal:new NativeCommandQueryJournal(options.db,nativePlanModePolicy),
  path:'native-plan-mode',prefix:'native-plan-mode',
  execute:options.client.executePlanMode?.bind(options.client),
  reconcile:options.client.reconcilePlanMode?.bind(options.client),
  assertScope:nativePlanModePolicy.assertScope,
 }});
}
export function registerNativeCommandQueryRoutes(app:FastifyInstance,{db,catalog,client,actor,token,operation}:NativeCommandRouteOptions){
 const journal=operation?.journal??new NativeCommandQueryJournal(db);
 const publicPath='/v1/runs/:runId/'+(operation?.path??'native-command-queries');
 const callbackPrefix=operation?.prefix??'native-command-query';
 const execute=operation?operation.execute:client.executeCommandQuery?.bind(client);
 const reconcile=operation?operation.reconcile:client.reconcileCommandQuery?.bind(client);
 const owned=(request:FastifyRequest)=>{
  const owner=actor(request),params=request.params as {runId:string;requestId?:string};
  if(!db.prepare('SELECT 1 FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=?').get(params.runId,owner))throw Error('native_command_query_not_found');
  return {owner,...params};
 };
 const error=(reply:any,cause:unknown)=>{
  const code=cause instanceof Error?cause.message:'';
  if(code==='native_command_query_invalid')return reply.code(422).send({error:{code:'NATIVE_COMMAND_QUERY_INVALID'}});
  if(['native_command_query_conflict','skill_catalog_scope_changed'].includes(code))return reply.code(409).send({error:{code:'NATIVE_COMMAND_QUERY_CONFLICT'}});
  if(code==='native_command_query_audit_unpaired')return reply.code(409).send({error:{code:'NATIVE_COMMAND_QUERY_AUDIT_UNPAIRED'}});
  if(['native_command_query_audit_conflict','native_command_query_result_conflict'].includes(code))return reply.code(409).send({error:{code:'NATIVE_COMMAND_QUERY_AUDIT_CONFLICT'}});
  if(['native_command_query_audit_unavailable','native_command_query_audit_invalid','native_command_query_result_invalid'].includes(code))return reply.code(503).send({error:{code:'NATIVE_COMMAND_QUERY_AUDIT_UNAVAILABLE'}});
  if(['native_command_query_not_found','skill_catalog_scope_forbidden'].includes(code))return reply.code(404).send({error:{code:'NATIVE_COMMAND_QUERY_NOT_FOUND'}});
  throw cause;
 };
 app.post(publicPath,{config:{nativeCommandQueryMutation:true}},async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{
   if(Object.keys(request.query as object).length)throw Error('native_command_query_invalid');
   const {owner,runId}=owned(request),input=request.body as Record<string,unknown>;
   if(!input||input.request_id!==request.headers['idempotency-key'])throw Error('native_command_query_invalid');
   if(!execute)return reply.code(503).send({error:{code:'NATIVE_COMMAND_QUERY_UNAVAILABLE'}});
   const prepared=journal.prepare(owner,runId,input,()=>{const scope=catalog.originalScope(owner,runId);operation?.assertScope(scope);return scope;});
   if(prepared.packet){
    try{
     await execute(prepared.packet);
     const settled=journal.read(owner,runId,prepared.receipt.request_id);
     if(['prepared','dispatched'].includes(settled.state))journal.finish(prepared.packet,'unknown');
    }
    catch{try{journal.finish(prepared.packet,'unknown');}catch{}}
   }
   return reply.code(202).send({accepted:true,request_id:prepared.receipt.request_id,run_id:runId});
  }catch(cause){return error(reply,cause);}
 });
 app.get(publicPath,async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{
   const query=request.query as Record<string,unknown>;
   if(Object.keys(query).some(key=>!['history','before'].includes(key))
    ||query.history!==undefined&&query.history!=='1'
    ||query.before!==undefined&&(query.history!=='1'||typeof query.before!=='string'
     ||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(query.before)))throw Error('native_command_query_invalid');
   const {owner,runId}=owned(request);
   return journal.list(owner,runId,{...(query.history==='1'?{history:true as const}:{}),...(typeof query.before==='string'?{before:query.before}:{})});
  }
  catch(cause){return error(reply,cause);}
 });
 app.get(publicPath+'/:requestId',async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{if(Object.keys(request.query as object).length)throw Error('native_command_query_invalid');const {owner,runId,requestId}=owned(request);return journal.read(owner,runId,requestId!);}
  catch(cause){return error(reply,cause);}
 });
 app.post(publicPath+'/:requestId/close',{config:{nativeCommandQueryMutation:true}},async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{
   const {owner,runId,requestId}=owned(request),input=request.body as Record<string,unknown>;
   if(Object.keys(request.query as object).length||!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).join(',')!=='name'||requestId!==request.headers['idempotency-key'])throw Error('native_command_query_invalid');
   return journal.close(owner,runId,requestId!,input.name);
  }catch(cause){return error(reply,cause);}
 });
 app.post(publicPath+'/:requestId/reconcile',{config:{nativeCommandQueryMutation:true}},async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{
   const {owner,runId,requestId}=owned(request),body=request.body;
   if(Object.keys(request.query as object).length||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length
    ||requestId!==request.headers['idempotency-key'])throw Error('native_command_query_invalid');
   const original=journal.read(owner,runId,requestId!);
   if(!['dispatched','unknown'].includes(original.state))return original;
   const packet=journal.recoveryPacket(owner,runId,requestId!);
   if(!reconcile)throw Error('native_command_query_audit_unavailable');
   const response=await reconcile(packet) as Record<string,unknown>;
   if(!response||Object.keys(response).sort().join(',')!=='execution_authorized,recovery,request_id'
    ||response.execution_authorized!==false||response.request_id!==requestId)throw Error('native_command_query_audit_unavailable');
   return response.recovery===null?journal.read(owner,runId,requestId!):journal.recover(owner,runId,requestId!,response.recovery);
  }catch(cause){return error(reply,cause);}
 });
 for(const action of ['claim','settle','bind','audit'] as const)app.post(`/internal/v1/workbench/${callbackPrefix}-${action}`,
  {config:{skillReadInternal:true},bodyLimit:8*1024*1024},async(request,reply)=>{
   const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
   if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
   const input=request.body as Record<string,any>,allowed=['scope','request','grant_token','run_id','session_ref',
    ...(action==='settle'?['state','result']:[]),...(['bind','audit'].includes(action)?['audit']:[])];
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key))
    ||!input.scope||input.run_id!==input.scope.run_id||input.session_ref!==input.scope.session_ref
    ||action==='settle'&&!['settled','unknown','rejected'].includes(input.state))return reply.code(422).send({error:{code:'NATIVE_COMMAND_QUERY_INVALID'}});
   if(action==='claim')return journal.claim(input,scope=>{catalog.assertScopeCurrent(scope);operation?.assertScope(scope);});
   if(action==='bind')return journal.bindAudit(input);
   if(action==='audit')return journal.authorizeAudit(input);
   return journal.finish(input,input.state,input.result);
  });
}
