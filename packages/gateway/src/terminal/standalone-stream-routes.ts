import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {Readable} from 'node:stream';
import type {StandaloneTerminalAdmissions,StandaloneTerminalClient} from './standalone-service.ts';
import {connectionLifetime} from './stream-routes.ts';
import {validateTerminalAttachment,validateTerminalInputPacket,validateTerminalQueued} from './stream.js';
const uuid=(value:string)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
function failure(reply:FastifyReply,error:unknown,input=false){
 const code=(error as Error)?.message;
 if(code==='unauthorized')return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
 if(code==='terminal_attachment_invalid'||code==='terminal_input_invalid')return reply.code(422).send({error:{code:'TERMINAL_INPUT_INVALID'}});
 if(code==='standalone_terminal_workspace_forbidden')return reply.code(403).send({error:{code:'WORKSPACE_FORBIDDEN'}});
 if(code==='standalone_terminal_admission_missing')return reply.code(404).send({error:{code:'STANDALONE_TERMINAL_ADMISSION_MISSING'}});
 if(code==='standalone_terminal_transition_invalid')return reply.code(409).send({error:{code:'STANDALONE_TERMINAL_TRANSITION_INVALID'}});
 return reply.code(503).send({error:{code:input?'TERMINAL_INPUT_OUTCOME_UNKNOWN':'TERMINAL_ATTACHMENT_UNAVAILABLE'}});
}
/** Standalone attachments use original native queues without inventing a conversation/run. */
export function registerStandaloneTerminalStreamRoutes(app:FastifyInstance,options:{admissions:StandaloneTerminalAdmissions;
 actor(request:{headers:Record<string,unknown>}):string;client?:StandaloneTerminalClient|undefined}){
 const path='/v1/standalone-terminals/admissions/:requestId/terminals/:terminalId';
 function scope(request:FastifyRequest){
  const owner=options.actor(request),params=request.params as {requestId:string;terminalId:string;attachmentId?:string};
  if(!uuid(params.requestId)||!/^[_A-Za-z0-9-]{1,128}$/.test(params.terminalId)||Object.keys(request.query as object).length)throw Error('terminal_attachment_invalid');
  const binding=()=>options.admissions.read(owner,params.requestId),source=binding();
  if(!source)throw Error('standalone_terminal_admission_missing');
  if(source.state!=='ready')throw Error('standalone_terminal_transition_invalid');
  return{params,binding,source};
 }
 app.post(path+'/attach',{config:{terminalStreamCommand:true},bodyLimit:4096},async(request,reply)=>{
  reply.header('cache-control','private, no-store');const lifetime=connectionLifetime(request,reply);let stream:Readable|undefined;
  try{
   const bound=scope(request),packet=validateTerminalAttachment(request.body);
   if(request.headers['idempotency-key']!==packet.attachment_id)throw Error('terminal_attachment_invalid');
   if(typeof options.client?.attachStandaloneTerminal!=='function')throw Error('terminal_attachment_unavailable');
   stream=await options.client.attachStandaloneTerminal(bound.source,bound.params.terminalId,packet,lifetime.signal);
   lifetime.signal.throwIfAborted();
   if(bound.binding()?.state_sha256!==bound.source.state_sha256)throw Error('terminal_attachment_unavailable');
   stream.once('close',lifetime.close);
   return reply.type('application/x-ndjson; charset=utf-8').header('x-accel-buffering','no').send(stream);
  }catch(error){stream?.destroy();lifetime.close();return failure(reply,error);}
 });
 app.post(path+'/attachments/:attachmentId/input',{config:{terminalStreamCommand:true},bodyLimit:32*1024*1024},async(request,reply)=>{
  reply.header('cache-control','private, no-store');const lifetime=connectionLifetime(request,reply);
  try{
   const bound=scope(request),packet=validateTerminalInputPacket(request.body),attachment=bound.params.attachmentId!;
   validateTerminalAttachment({host_instance:packet.host_instance,attachment_id:attachment});
   if(typeof options.client?.standaloneTerminalInput!=='function')throw Error('terminal_attachment_unavailable');
   const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(10000)]);
   const value=validateTerminalQueued(await options.client.standaloneTerminalInput(bound.source,bound.params.terminalId,attachment,packet,signal),attachment,packet.command.sequence);
   signal.throwIfAborted();
   if(bound.binding()?.state_sha256!==bound.source.state_sha256)throw Error('terminal_input_outcome_unknown');
   return value;
  }catch(error){return failure(reply,error,true);}
  finally{lifetime.close();}
 });
}
