import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import {SessionAdapterError} from '../harness/session-controller-client.ts';
import {readOwnedTerminalSession} from './inventory-routes.ts';
import {validateTerminalInventory,type TerminalInventory} from './inventory.js';
import {validateTerminalOptions,validateTerminalCommand,type TerminalOptions,type TerminalCommand} from './control.js';

export interface TerminalControlClient {
  terminalOptions(ownerId:string,sessionId:string,signal?:AbortSignal):Promise<TerminalOptions>;
  terminalCommand(ownerId:string,sessionId:string,command:TerminalCommand,signal?:AbortSignal):Promise<TerminalInventory>;
}

export function registerTerminalControlRoutes(app:FastifyInstance,options:{
  db:DatabaseSync;actor(request:{headers:Record<string,unknown>}):string;client?:TerminalControlClient|undefined;
}) {
  const {db,actor,client}=options;
  const path='/v1/conversations/:conversationId/runs/:runId/terminals';
  async function handle(request:FastifyRequest,reply:FastifyReply,write:boolean) {
    reply.header('cache-control','private, no-store');
    const abort=new AbortController(),disconnected=()=>abort.abort();
    request.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    if(request.raw.aborted||reply.raw.destroyed)disconnected();
    try {
      const owner=actor(request),{conversationId,runId}=request.params as {conversationId:string;runId:string};
      const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
      if(!id.test(conversationId)||!id.test(runId)||Object.keys(request.query as object).length)throw Error('terminal_command_invalid');
      const command=write?validateTerminalCommand(request.body):undefined;
      if(command&&request.headers['idempotency-key']!==command.request_id)throw Error('terminal_command_invalid');
      const binding=()=>readOwnedTerminalSession(db,owner,conversationId,runId),before=binding();
      if(!before)return reply.code(404).send({error:{code:'TERMINAL_SESSION_NOT_FOUND'}});
      if(before.archived_at!==null&&command?.action!=='close')return reply.code(409).send({error:{code:'TERMINAL_SESSION_ARCHIVED'}});
      if(!client)return reply.code(503).send({error:{code:'TERMINAL_UNAVAILABLE'}});
      const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]);
      const result=command
        ?validateTerminalInventory(await client.terminalCommand(owner,before.session_id,command,signal),before.session_id)
        :validateTerminalOptions(await client.terminalOptions(owner,before.session_id,signal),before.session_id);
      signal.throwIfAborted();
      const after=binding();
      if(after?.session_id!==before.session_id||after.archived_at!==before.archived_at)
        return reply.code(write?503:409).send({error:{code:write?'TERMINAL_OUTCOME_UNKNOWN':'TERMINAL_SESSION_CHANGED'}});
      return result;
    } catch(error) {
      if(error instanceof SessionAdapterError&&error.status===409&&error.protocolCode==='terminal_host_changed')
        return reply.code(409).send({error:{code:'TERMINAL_HOST_CHANGED'}});
      const code=(error as Error)?.message;
      if(code==='unauthorized')return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
      if(code==='terminal_command_invalid')return reply.code(422).send({error:{code:'TERMINAL_INPUT_INVALID'}});
      return reply.code(503).send({error:{code:'TERMINAL_UNAVAILABLE'}});
    } finally {
      request.raw.off('aborted',disconnected);reply.raw.off('close',disconnected);
    }
  }
  app.get(path+'/options',(request,reply)=>handle(request,reply,false));
  app.post(path+'/commands',(request,reply)=>handle(request,reply,true));
}
