import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import type {Readable} from 'node:stream';
import {SessionAdapterError} from '../harness/session-controller-client.ts';
import {readOwnedTerminalSession} from './inventory-routes.ts';
import {validateTerminalAttachment,validateTerminalInputPacket,validateTerminalQueued,type TerminalAttachment,type TerminalInputPacket,type TerminalQueued} from './stream.js';

export interface TerminalStreamClient {
  attachTerminal(owner:string,session:string,terminal:string,packet:TerminalAttachment,signal?:AbortSignal):Promise<Readable>;
  terminalInput(owner:string,session:string,terminal:string,attachment:string,packet:TerminalInputPacket,signal?:AbortSignal):Promise<TerminalQueued>;
}

function connectionLifetime(request:FastifyRequest,reply:FastifyReply) {
  const controller=new AbortController(),abort=()=>controller.abort();
  request.raw.once('aborted',abort);reply.raw.once('close',abort);
  if(request.raw.aborted||reply.raw.destroyed)abort();
  return {signal:controller.signal,close(){request.raw.off('aborted',abort);reply.raw.off('close',abort);controller.abort();}};
}

function failure(reply:FastifyReply,error:unknown,input=false) {
  const code=(error as Error)?.message;
  if(code==='unauthorized')return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  if(code==='terminal_attachment_invalid'||code==='terminal_input_invalid')return reply.code(422).send({error:{code:'TERMINAL_INPUT_INVALID'}});
  if(code==='terminal_session_missing')return reply.code(404).send({error:{code:'TERMINAL_SESSION_NOT_FOUND'}});
  if(code==='terminal_session_archived')return reply.code(409).send({error:{code:'TERMINAL_SESSION_ARCHIVED'}});
  if(error instanceof SessionAdapterError&&[409,422,429].includes(error.status))return reply.code(error.status).send({error:{code:input?'TERMINAL_INPUT_NOT_QUEUED':'TERMINAL_ATTACHMENT_REFUSED'}});
  return reply.code(503).send({error:{code:input?'TERMINAL_INPUT_OUTCOME_UNKNOWN':'TERMINAL_ATTACHMENT_UNAVAILABLE'}});
}

/** Transient input never enters a durable command receipt or replay queue. */
export function registerTerminalStreamRoutes(app:FastifyInstance,options:{
  db:DatabaseSync;actor(request:{headers:Record<string,unknown>}):string;client?:TerminalStreamClient|undefined;
}) {
  const {db,actor,client}=options,path='/v1/conversations/:conversationId/runs/:runId/terminals/:terminalId';
  function scope(request:FastifyRequest) {
    const owner=actor(request),params=request.params as {conversationId:string;runId:string;terminalId:string;attachmentId?:string};
    const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    if(!id.test(params.conversationId)||!id.test(params.runId)||!/^[_A-Za-z0-9-]{1,128}$/.test(params.terminalId)
      ||Object.keys(request.query as object).length)throw Error('terminal_attachment_invalid');
    const binding=()=>readOwnedTerminalSession(db,owner,params.conversationId,params.runId),source=binding();
    if(!source)throw Error('terminal_session_missing');
    if(source.archived_at!==null)throw Error('terminal_session_archived');
    return {owner,params,binding,source};
  }
  app.post(path+'/attach',{config:{terminalStreamCommand:true},bodyLimit:4096},async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const lifetime=connectionLifetime(request,reply);let stream:Readable|undefined;
    try {
      const bound=scope(request),packet=validateTerminalAttachment(request.body);
      if(request.headers['idempotency-key']!==packet.attachment_id)throw Error('terminal_attachment_invalid');
      if(!client)throw Error('terminal_attachment_unavailable');
      stream=await client.attachTerminal(bound.owner,bound.source.session_id,bound.params.terminalId,packet,lifetime.signal);
      lifetime.signal.throwIfAborted();
      const current=bound.binding();
      if(current?.session_id!==bound.source.session_id||current.archived_at!==null)throw Error('terminal_attachment_unavailable');
      stream.once('close',lifetime.close);
      return reply.type('application/x-ndjson; charset=utf-8').header('x-accel-buffering','no').send(stream);
    }catch(error){stream?.destroy();lifetime.close();return failure(reply,error);}
  });
  app.post(path+'/attachments/:attachmentId/input',{config:{terminalStreamCommand:true},bodyLimit:32*1024*1024},async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const lifetime=connectionLifetime(request,reply);
    try {
      const bound=scope(request),packet=validateTerminalInputPacket(request.body),attachment=bound.params.attachmentId!;
      validateTerminalAttachment({host_instance:packet.host_instance,attachment_id:attachment});
      if(!client)throw Error('terminal_attachment_unavailable');
      const signal=AbortSignal.any([lifetime.signal,AbortSignal.timeout(10000)]);
      const result=validateTerminalQueued(await client.terminalInput(bound.owner,bound.source.session_id,bound.params.terminalId,attachment,packet,signal),attachment,packet.command.sequence);
      signal.throwIfAborted();
      const current=bound.binding();
      if(current?.session_id!==bound.source.session_id||current.archived_at!==null)
        return reply.code(503).send({error:{code:'TERMINAL_INPUT_OUTCOME_UNKNOWN'}});
      return result;
    }catch(error){return failure(reply,error,true);}
    finally{lifetime.close();}
  });
}
