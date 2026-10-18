// Test-only explicit one-shot in the original official maintenance boundary.
// This does not compose BasicCompactionEngine or publish a summary/checkpoint.
import {readFile,writeFile} from 'node:fs/promises';
import {WorkbenchBridge} from '../../session-adapter/workbench.js';
import {createLiveChatRunCompletionReader} from '../../session-adapter/ordinary-run-completion.js';
import {chatMaintenanceNativeWitness} from '../../session-adapter/chat-maintenance-observation.js';
import {accountedChatCompactionStream} from '../../session-adapter/chat-compaction-stream.js';
export function installChatAccountingProbe(ctx,{requestPath,receiptPath,origin,admissions,kit}){
 const bridge=new WorkbenchBridge({origin,token:process.env.GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN});
 const reader=createLiveChatRunCompletionReader({bridge,agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,admissions,projections:ctx.sessionProjections,ordinaryPresets:new Set(['jot-chat']),...kit});let started=false;
 const timer=setInterval(async()=>{
  if(started)return;let body;try{body=JSON.parse(await readFile(requestPath,'utf8'));}catch{return;}started=true;
  try{
   const controller=new AbortController(),scope=body.scope,intent=(await bridge.request('chat-compaction-source',{runId:scope.run_id,sessionRef:scope.session_ref},{action:'read',...scope,intent_id:body.intent_id},controller.signal)).intent;
   const proof=await reader({scope,expectedSourceSha256:intent.source.history_sha256,signal:controller.signal}),agent=ctx.agents.get(scope.session_ref),session=agent.session,witness=chatMaintenanceNativeWitness(proof);let finished=false,usage;
   await agent.runMaintenance(async nativeSignal=>{
    const signal=AbortSignal.any([nativeSignal,controller.signal]),options=Object.freeze({provider:intent.source.model.provider,model:intent.source.model.model,reasoningEffort:'off',purpose:'compaction',sessionId:scope.session_ref,messages:[{role:'user',content:[{type:'text',text:'SYNTHETIC-COMPACTION-ACCOUNTING-PROBE'}]}],signal});
    const check=async active=>{active.throwIfAborted();if(ctx.agents.get(scope.session_ref)!==agent||agent.session!==session||session.seq!==proof.raw_event_count||agent.inbox.nextStep.length||agent.inbox.nextTurn.length)throw Error('probe_native_boundary_changed');};
    for await(const chunk of accountedChatCompactionStream({attempt:{scope,intent_id:body.intent_id,attempt_id:'actual-sdk-compaction-probe',observer_id:'actual-sdk-host-instance',witness},options,request:bridge.request.bind(bridge),check,next:()=>ctx.llm.stream(options)})){if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finished=true;}
   });
   await writeFile(receiptPath,JSON.stringify({finished,usage,sessionUnchanged:session.seq===proof.raw_event_count,compactionExecuted:false,checkpointPublished:false}));
  }catch{await writeFile(receiptPath,JSON.stringify({error:'synthetic_accounting_probe_failed'}));}
 },40);ctx.effect(()=>()=>clearInterval(timer));
}
