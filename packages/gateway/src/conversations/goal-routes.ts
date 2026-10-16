import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import type {ConversationRepository} from './repository.ts';
import {validateConversationGoalView} from '../harness/conversation-goal-view.ts';
export interface ConversationGoalClient {
  conversationGoal(sessionId:string,body?:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>;
}
export function registerConversationGoalRoutes(app:FastifyInstance,{db,conversations,actor,client}:{db:DatabaseSync;conversations:ConversationRepository;actor:(request:FastifyRequest)=>string;client?:ConversationGoalClient|undefined}){
  function session(request:FastifyRequest){
    const id=String((request.params as Record<string,unknown>).conversationId),owner=actor(request);
    conversations.get(id,owner);
    if(db.prepare('SELECT 1 FROM wb_agents WHERE conversation_id=? AND owner_id=?').get(id,owner)
      ||db.prepare('SELECT 1 FROM wb_run_bindings b JOIN ga_runs r ON r.id=b.run_id WHERE r.conversation_id=? AND b.owner_id=? LIMIT 1').get(id,owner))return {forbidden:true as const};
    const binding=db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=? AND owner_id=?').get(id,owner) as {session_id:string}|undefined;
    return {sessionId:binding?.session_id};
  }
  async function native(sessionId:string,body:Record<string,unknown>){
    if(!client)throw Error('conversation_goal_unavailable');
    let value;
    try{value=await client.conversationGoal(sessionId,body,AbortSignal.timeout(20_000));}
    catch(error){if((error as {protocolCode?:string})?.protocolCode==='goal_revision_changed')throw Error('conversation_goal_revision_changed');throw Error('conversation_goal_unavailable');}
    return validateConversationGoalView(value);
  }
  const failure=(reply:FastifyReply,error:unknown)=>{
    if((error as Error)?.message==='conversation_goal_state_invalid')return reply.code(502).send({error:{code:'GOAL_STATE_INVALID'}});
    if((error as Error)?.message==='conversation_goal_revision_changed')return reply.code(409).send({error:{code:'GOAL_REVISION_CHANGED'}});
    return reply.code(503).send({error:{code:'GOAL_UNAVAILABLE'}});
  };
  app.get('/v1/conversations/:conversationId/goal',async(request,reply)=>{
    const binding=session(request);if(binding.forbidden)return reply.code(409).send({error:{code:'GOAL_SCOPE_INVALID'}});
    if(Object.keys(request.query as object).length)return reply.code(400).send({error:{code:'GOAL_INPUT_INVALID'}});
    if(!binding.sessionId)return {goal:null};
    try{return await native(binding.sessionId,{});}catch(error){return failure(reply,error);}
  });
  app.post('/v1/conversations/:conversationId/goal',async(request,reply)=>{
    const binding=session(request);if(binding.forbidden)return reply.code(409).send({error:{code:'GOAL_SCOPE_INVALID'}});
    const body=request.body as Record<string,unknown>;
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==3||Object.keys(body).some(k=>!['action','id','revision'].includes(k))
      ||!['pause','resume','stop'].includes(String(body.action))||typeof body.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(body.id)||!Number.isSafeInteger(body.revision)||Number(body.revision)<1)return reply.code(400).send({error:{code:'GOAL_INPUT_INVALID'}});
    if(!binding.sessionId)return reply.code(503).send({error:{code:'GOAL_UNAVAILABLE'}});
    if(body.action==='resume'&&!db.prepare("SELECT 1 FROM ga_runs WHERE conversation_id=? AND status='running' LIMIT 1").get(String((request.params as Record<string,unknown>).conversationId)))return reply.code(409).send({error:{code:'GOAL_RUN_REQUIRED'}});
    try{return await native(binding.sessionId,body);}catch(error){return failure(reply,error);}
  });
}
