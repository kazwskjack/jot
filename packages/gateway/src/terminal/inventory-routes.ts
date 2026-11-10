import type {FastifyInstance} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import {withReadTransaction} from '../db/database.ts';
import {validateTerminalInventory,type TerminalInventory} from './inventory.js';

export interface TerminalInventoryClient {
  listTerminals(ownerId:string,sessionId:string,signal?:AbortSignal):Promise<TerminalInventory>;
}

/** Read retained Host terminals through the original owned run/session binding. */
export function registerTerminalInventoryRoutes(app:FastifyInstance,options:{
  db:DatabaseSync;
  actor(request:{headers:Record<string,unknown>}):string;
  client?:TerminalInventoryClient|undefined;
}) {
  const {db,actor,client}=options;
  app.get('/v1/conversations/:conversationId/runs/:runId/terminals',async(request,reply)=>{
    reply.header('cache-control','private, no-store');
    const abort=new AbortController(),disconnected=()=>abort.abort();
    request.raw.once('aborted',disconnected);
    reply.raw.once('close',disconnected);
    if(request.raw.aborted||reply.raw.destroyed)disconnected();
    try {
      const owner=actor(request),{conversationId,runId}=request.params as {conversationId:string;runId:string};
      const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
      if(!id.test(conversationId)||!id.test(runId)||Object.keys(request.query as object).length)
        return reply.code(400).send({error:{code:'TERMINAL_INPUT_INVALID'}});
      const binding=()=>withReadTransaction(db,()=>db.prepare(`SELECT s.session_id FROM ga_run_native_sessions s
        JOIN ga_runs r ON r.id=s.run_id AND r.conversation_id=s.conversation_id
        JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=s.owner_id
        WHERE s.run_id=? AND c.id=? AND c.owner_id=?`).get(runId,conversationId,owner) as {session_id:string}|undefined);
      const source=binding();
      if(!source)return reply.code(404).send({error:{code:'TERMINAL_SESSION_NOT_FOUND'}});
      if(typeof client?.listTerminals!=='function')return reply.code(503).send({error:{code:'TERMINAL_UNAVAILABLE'}});
      const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(10000)]);
      const value=validateTerminalInventory(await client.listTerminals(owner,source.session_id,signal),source.session_id);
      signal.throwIfAborted();
      if(binding()?.session_id!==source.session_id)return reply.code(409).send({error:{code:'TERMINAL_SESSION_CHANGED'}});
      return value;
    } catch(error) {
      if((error as Error)?.message==='unauthorized')return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
      return reply.code((error as Error)?.message==='terminal_inventory_invalid'?502:503)
        .send({error:{code:(error as Error)?.message==='terminal_inventory_invalid'?'TERMINAL_RESPONSE_INVALID':'TERMINAL_UNAVAILABLE'}});
    } finally {
      request.raw.off('aborted',disconnected);
      reply.raw.off('close',disconnected);
    }
  });
}
