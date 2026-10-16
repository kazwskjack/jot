import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import type {ConversationRepository} from './repository.ts';
import {validateConversationGoalView} from '../harness/conversation-goal-view.ts';
import type {ConversationGoalControls} from './goal-controls.ts';
export interface ConversationGoalClient {
  conversationGoal(sessionId:string,body?:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>;
  conversationGoalResumeReadiness?(signal?:AbortSignal):Promise<Record<string,unknown>>;
}
type Admission={enabled:boolean;controls:ConversationGoalControls;atomic:<T>(request:FastifyRequest,status:number,operation:()=>T)=>T};
export function registerConversationGoalRoutes(app:FastifyInstance,{db,conversations,actor,client,resumeAdmission}:{db:DatabaseSync;conversations:ConversationRepository;actor:(request:FastifyRequest)=>string;client?:ConversationGoalClient|undefined;resumeAdmission?:Admission}){
  function session(request:FastifyRequest){
    const id=String((request.params as Record<string,unknown>).conversationId),owner=actor(request);
    conversations.get(id,owner);
    if(db.prepare('SELECT 1 FROM wb_agents WHERE conversation_id=? AND owner_id=?').get(id,owner)
      ||db.prepare('SELECT 1 FROM wb_run_bindings b JOIN ga_runs r ON r.id=b.run_id WHERE r.conversation_id=? AND b.owner_id=? LIMIT 1').get(id,owner))return {forbidden:true as const};
    const binding=db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=? AND owner_id=?').get(id,owner) as {session_id:string}|undefined;
    return {id,owner,sessionId:binding?.session_id};
  }
  async function readiness(binding:{id:string;sessionId:string|undefined}){
    const notReady=(reason:string)=>({enabled:resumeAdmission?.enabled===true,ready:false,reason});
    if(!resumeAdmission?.enabled)return notReady('DISABLED');
    if(!binding.sessionId)return notReady('NO_SESSION');
    if(db.prepare("SELECT 1 FROM ga_runs WHERE conversation_id=? AND status IN ('queued','starting','running','waiting_user','waiting_approval','cancelling') LIMIT 1").get(binding.id))return notReady('RUN_BUSY');
    if(db.prepare("SELECT 1 FROM ga_conversation_goal_controls WHERE conversation_id=? AND state='dispatching' LIMIT 1").get(binding.id))return notReady('UNCONFIRMED_CONTROL');
    try{
      const value=await client?.conversationGoalResumeReadiness?.(AbortSignal.timeout(5000));
      if(!value||Object.keys(value).join(',')!=='ready'||value.ready!==true)return notReady('HOST_UNAVAILABLE');
      return {enabled:true,ready:true,reason:'READY'};
    }catch{return notReady('HOST_UNAVAILABLE');}
  }
  async function native(sessionId:string,body:Record<string,unknown>){
    if(!client)throw Error('conversation_goal_unavailable');
    let value;
    try{value=await client.conversationGoal(sessionId,body,AbortSignal.timeout(20_000));}
    catch(error){const code=(error as {protocolCode?:string})?.protocolCode;if(code==='goal_revision_changed')throw Error('conversation_goal_revision_changed');if(code==='goal_cold_input_pending')throw Error('conversation_goal_recovery_required');throw Error('conversation_goal_unavailable');}
    return validateConversationGoalView(value);
  }
  const failure=(reply:FastifyReply,error:unknown)=>{
    if((error as Error)?.message==='conversation_goal_state_invalid')return reply.code(502).send({error:{code:'GOAL_STATE_INVALID'}});
    if((error as Error)?.message==='conversation_goal_revision_changed')return reply.code(409).send({error:{code:'GOAL_REVISION_CHANGED'}});
    if((error as Error)?.message==='conversation_goal_recovery_required')return reply.code(409).send({error:{code:'GOAL_CONTEXT_RECOVERY_REQUIRED'}});
    const code=(error as Error)?.message;
    if(code==='goal_control_revision_changed')return reply.code(409).send({error:{code:'GOAL_REVISION_CHANGED'}});
    if(code==='goal_control_run_busy')return reply.code(409).send({error:{code:'GOAL_RUN_BUSY'}});
    if(code==='goal_control_dispatch_unknown')return reply.code(409).send({error:{code:'GOAL_CONTROL_UNCONFIRMED'}});
    if(code==='goal_control_idempotency_conflict')return reply.code(409).send({error:{code:'IDEMPOTENCY_CONFLICT'}});
    if(code==='goal_control_not_resumable')return reply.code(409).send({error:{code:'GOAL_NOT_RESUMABLE'}});
    return reply.code(503).send({error:{code:'GOAL_UNAVAILABLE'}});
  };
  app.get('/v1/conversations/:conversationId/goal/resume-readiness',async(request,reply)=>{
    const binding=session(request);if(binding.forbidden)return reply.code(409).send({error:{code:'GOAL_SCOPE_INVALID'}});
    if(Object.keys(request.query as object).length)return reply.code(400).send({error:{code:'GOAL_INPUT_INVALID'}});
    return readiness(binding);
  });
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
      ||typeof body.action!=='string'||!['pause','resume','stop'].includes(body.action)||typeof body.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(body.id)||!Number.isSafeInteger(body.revision)||Number(body.revision)<1)return reply.code(400).send({error:{code:'GOAL_INPUT_INVALID'}});
    if(!binding.sessionId)return reply.code(503).send({error:{code:'GOAL_UNAVAILABLE'}});
    if(body.action==='resume'){
      const key=String(request.headers['idempotency-key']??'');
      if(!/^[\x21-\x7e]{8,128}$/.test(key))return reply.code(400).send({error:{code:'IDEMPOTENCY_KEY_INVALID'}});
      if(!resumeAdmission)return reply.code(409).send({error:{code:'GOAL_RESUME_DISABLED'}});
      const input={ownerId:binding.owner,conversationId:binding.id,sessionId:binding.sessionId,idempotencyKey:key,ref:{id:body.id as string,revision:Number(body.revision)}};
      try{
        if(resumeAdmission.controls.acceptedFor(input))return reply.code(202).send(resumeAdmission.atomic(request,202,()=>resumeAdmission.controls.enqueue(input,undefined)));
        const ready=await readiness(binding);
        if(!ready.ready){const codes:Record<string,string>={DISABLED:'GOAL_RESUME_DISABLED',NO_SESSION:'GOAL_UNAVAILABLE',RUN_BUSY:'GOAL_RUN_BUSY',UNCONFIRMED_CONTROL:'GOAL_CONTROL_UNCONFIRMED',HOST_UNAVAILABLE:'GOAL_HOST_UNAVAILABLE'};return reply.code(['HOST_UNAVAILABLE','NO_SESSION'].includes(ready.reason)?503:409).send({error:{code:codes[ready.reason]}});}
        const view=await native(binding.sessionId,{});
        return reply.code(202).send(resumeAdmission.atomic(request,202,()=>resumeAdmission.controls.enqueue(input,view)));
      }catch(error){return failure(reply,error);}
    }
    try{return await native(binding.sessionId,body);}catch(error){return failure(reply,error);}
  });
}
