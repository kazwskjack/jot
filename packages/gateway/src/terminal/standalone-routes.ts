import {timingSafeEqual} from 'node:crypto';
import {claimStandaloneNativeAttempt} from './standalone-admissions.ts';
import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {claimStandaloneTerminalCommandAttempt} from './standalone-commands.ts';
import {validateTerminalCommand} from './control.js';
import type {DatabaseSync} from 'node:sqlite';
import {StandaloneTerminalAdmissions,type StandaloneTerminalClient} from './standalone-service.ts';
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:unknown,keys:string)=>object(value)&&Object.keys(value).sort().join(',')===keys;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function failure(error:unknown){
 const code=(error as Error)?.message;
 if(code==='unauthorized')return{status:401,code:'UNAUTHORIZED'};
 if(code==='terminal_command_invalid')return{status:422,code:'TERMINAL_INPUT_INVALID'};
 if(code==='terminal_wait_ended_unknown')return{status:409,code:'TERMINAL_WAIT_ENDED_UNKNOWN'};
 if(code==='terminal_outcome_unknown')return{status:503,code:'TERMINAL_OUTCOME_UNKNOWN'};
 if(code==='standalone_terminal_command_conflict')return{status:409,code:'STANDALONE_TERMINAL_COMMAND_CONFLICT'};
 if(code==='standalone_terminal_input_invalid')return{status:422,code:'STANDALONE_TERMINAL_INPUT_INVALID'};
 if(code==='standalone_terminal_workspace_forbidden')return{status:403,code:'WORKSPACE_FORBIDDEN'};
 if(code==='standalone_terminal_admission_missing')return{status:404,code:'STANDALONE_TERMINAL_ADMISSION_MISSING'};
 if(['standalone_terminal_request_conflict','standalone_terminal_state_changed','standalone_terminal_authority_changed','standalone_terminal_transition_invalid'].includes(code??''))return{status:409,code:code!.toUpperCase()};
 return{status:503,code:'STANDALONE_TERMINAL_UNAVAILABLE'};
}
/** Existing actor/CSRF hooks remain mandatory; admission storage owns dispatch replay protection. */
export function registerStandaloneTerminalAdmissionRoutes(app:FastifyInstance,options:{db:DatabaseSync;actor:(request:{headers:Record<string,unknown>})=>string;workspaces:readonly string[];client?:StandaloneTerminalClient|undefined;internalToken?:string|undefined}){
 const internalBearer=async(request:FastifyRequest,reply:FastifyReply)=>{
  const actual=Buffer.from(String(request.headers.authorization??'')),expected=Buffer.from('Bearer '+(options.internalToken??''));
  if(!options.internalToken||options.internalToken.length<32||actual.length!==expected.length||!timingSafeEqual(actual,expected))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
 };
 app.post('/internal/v1/workbench/standalone-terminal-native-attempt',{config:{standaloneTerminalInternal:true},bodyLimit:4096,onRequest:internalBearer},async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{
   const body=request.body;
   if(Object.keys(request.query as object).length||!object(body)||!exact(body,'authority_sha256,expected_state_sha256,expected_version,owner_id,request_id,session_id')
    ||typeof body.owner_id!=='string'||!uuid(body.request_id)||typeof body.session_id!=='string'||!hash(body.authority_sha256)
    ||!hash(body.expected_state_sha256)||!Number.isSafeInteger(body.expected_version)||Number(body.expected_version)<1)throw Error('standalone_terminal_input_invalid');
   return claimStandaloneNativeAttempt(options.db,{owner_id:body.owner_id,request_id:body.request_id,session_id:body.session_id,
    authority_sha256:body.authority_sha256,expected_version:Number(body.expected_version),expected_state_sha256:body.expected_state_sha256});
  }catch(error){const result=failure(error);return reply.code(result.status).send({error:{code:result.code}});}
 });
 app.post('/internal/v1/workbench/standalone-terminal-command-attempt',{config:{standaloneTerminalInternal:true},bodyLimit:4096,onRequest:internalBearer},async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{
   const body=request.body;
   if(Object.keys(request.query as object).length||!object(body)||!exact(body,'admission_id,admission_state_sha256,command_sha256,owner_id,request_id')
    ||typeof body.owner_id!=='string'||!uuid(body.admission_id)||!uuid(body.request_id)||!hash(body.admission_state_sha256)||!hash(body.command_sha256))throw Error('standalone_terminal_input_invalid');
   return claimStandaloneTerminalCommandAttempt(options.db,{owner_id:body.owner_id,admission_id:body.admission_id,request_id:body.request_id,
    admission_state_sha256:body.admission_state_sha256,command_sha256:body.command_sha256});
  }catch(error){const result=failure(error);return reply.code(result.status).send({error:{code:result.code}});}
 });
 const service=new StandaloneTerminalAdmissions(options.db,options.workspaces,options.client),path='/v1/standalone-terminals/admissions';
 app.get(path+'/:requestId',async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  try{
   const owner=options.actor(request),id=(request.params as {requestId:string}).requestId;
   if(!uuid(id)||Object.keys(request.query as object).length)throw Error('standalone_terminal_input_invalid');
   const value=service.read(owner,id);if(!value)throw Error('standalone_terminal_admission_missing');return value;
  }catch(error){const result=failure(error);return reply.code(result.status).send({error:{code:result.code}});}
 });
 for(const operation of ['dispatch','reconcile','end-wait'] as const){
  app.post(path+'/:requestId/terminals/commands'+(operation==='dispatch'?'':'/:commandId/'+operation),{config:{terminalStreamCommand:true},bodyLimit:32768},async(request,reply)=>{
   reply.header('cache-control','private, no-store');
   const abort=new AbortController(),close=()=>abort.abort();request.raw.once('aborted',close);reply.raw.once('close',close);
   if(request.raw.aborted||reply.raw.destroyed)close();
   try{
    const owner=options.actor(request),params=request.params as {requestId:string;commandId?:string},command=validateTerminalCommand(request.body);
    if(!uuid(params.requestId)||Object.keys(request.query as object).length||request.headers['idempotency-key']!==command.request_id
     ||operation!=='dispatch'&&params.commandId!==command.request_id||command.action==='create'&&command.cols<2)throw Error('terminal_command_invalid');
    return await(operation==='dispatch'?service.terminalCommand(owner,params.requestId,command,abort.signal):service.terminalReceipt(owner,params.requestId,command,abort.signal,operation==='end-wait'));
   }catch(error){const result=failure(error);return reply.code(result.status).send({error:{code:result.code}});}
   finally{request.raw.off('aborted',close);reply.raw.off('close',close);abort.abort();}
  });
 }
 for(const recover of [false,true]){
  const route=path+'/:requestId/terminals/'+(recover?'recover':'options');
  app.route({method:recover?'POST':'GET',url:route,config:{terminalStreamCommand:true},bodyLimit:4096,handler:async(request,reply)=>{
   reply.header('cache-control','private, no-store');
   const abort=new AbortController(),close=()=>abort.abort();request.raw.once('aborted',close);reply.raw.once('close',close);
   if(request.raw.aborted||reply.raw.destroyed)close();
   try{
    const owner=options.actor(request),id=(request.params as {requestId:string}).requestId;
    if(!uuid(id)||Object.keys(request.query as object).length||recover&&(!object(request.body)||Object.keys(request.body).length||!/^[-A-Za-z0-9._:]{8,128}$/.test(String(request.headers['idempotency-key']??''))))throw Error('standalone_terminal_input_invalid');
    return await service.terminalOptions(owner,id,abort.signal,recover);
   }catch(error){const result=failure(error);return reply.code(result.status).send({error:{code:result.code}});}
   finally{request.raw.off('aborted',close);reply.raw.off('close',close);abort.abort();}
  });
 }
 app.get(path+'/:requestId/terminals',async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  const abort=new AbortController(),close=()=>abort.abort();request.raw.once('aborted',close);reply.raw.once('close',close);
  if(request.raw.aborted||reply.raw.destroyed)close();
  try{
   const owner=options.actor(request),id=(request.params as {requestId:string}).requestId;
   if(!uuid(id)||Object.keys(request.query as object).length)throw Error('standalone_terminal_input_invalid');
   return await service.inventory(owner,id,abort.signal);
  }catch(error){const result=failure(error);return reply.code(result.status).send({error:{code:result.code}});}
  finally{request.raw.off('aborted',close);reply.raw.off('close',close);abort.abort();}
 });
 for(const control of [false,true])app.post(path+(control?'/:requestId/control':''),{config:{terminalStreamCommand:true},bodyLimit:32*1024},async(request,reply)=>{
  reply.header('cache-control','private, no-store');
  const abort=new AbortController(),close=()=>abort.abort();request.raw.once('aborted',close);reply.raw.once('close',close);
  if(request.raw.aborted||reply.raw.destroyed)close();
  try{
   const owner=options.actor(request),body=request.body;
   if(Object.keys(request.query as object).length||!object(body))throw Error('standalone_terminal_input_invalid');
   if(!control){
    if(!exact(body,'request_id,workspace_id')||!uuid(body.request_id)||typeof body.workspace_id!=='string'||request.headers['idempotency-key']!==body.request_id)throw Error('standalone_terminal_input_invalid');
    return await service.prepare(owner,{request_id:body.request_id,workspace_id:body.workspace_id},abort.signal);
   }
   const id=(request.params as {requestId:string}).requestId;
   if(!uuid(id)||!exact(body,'action,expected_state_sha256,expected_version')||!['dispatch','cancel','observe'].includes(String(body.action))
    ||!Number.isSafeInteger(body.expected_version)||Number(body.expected_version)<1||!hash(body.expected_state_sha256))throw Error('standalone_terminal_input_invalid');
   const input={request_id:id,expected_version:Number(body.expected_version),expected_state_sha256:body.expected_state_sha256};
   if(body.action==='cancel')return service.cancel(owner,input);
   return await(body.action==='dispatch'?service.dispatch(owner,input,abort.signal):service.observe(owner,input,abort.signal));
  }catch(error){const result=failure(error);return reply.code(result.status).send({error:{code:result.code}});}
  finally{request.raw.off('aborted',close);reply.raw.off('close',close);abort.abort();}
 });
}
