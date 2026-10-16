// Test-only audit and seed wrapper. Never install as a product adapter.
import {writeFileSync,renameSync,existsSync} from 'node:fs';
import {apply as applyAdapter} from '../../session-adapter/index.js';
export {name,inject} from '../../session-adapter/index.js';
export async function apply(ctx,{fixture,...config}){
 let created=0,idleFlushed=false,startupPending=[];const users=[],events=[],audits=[],agents=[],messageKinds=[],usage=[],statuses=[];
 const save=()=>{writeFileSync(fixture.receipt+'.new',JSON.stringify({created,idleFlushed,startupPending,users,events,audits,agents,messageKinds,usage,statuses}));renameSync(fixture.receipt+'.new',fixture.receipt);};save();
 ctx.on('session/event',(session,event)=>{if(session.id!==fixture.sessionId)return;events.push({type:event.type,...(event.data?.reason?{reason:event.data.reason}:{})});if(event.type==='assistant/message'&&event.data.usage)usage.push({seq:event.seq,value:event.data.usage});if(event.type==='user/message'){messageKinds.push(event.data.source.kind);if(event.data.source.kind==='user')users.push({id:event.data.id,source:{kind:'user',rpcId:event.data.source.rpcId}});}save();});
 ctx.on('agent/status',async({agent,status})=>{if(agent.id!==fixture.sessionId)return;statuses.push({status,seq:agent.session.seq});save();if(status==='idle'){await ctx.sessionPersistence.flush(agent.session);idleFlushed=true;save();}});
 ctx.on('agent/created',async({agent})=>{
  if(agent.id!==fixture.sessionId)return;created++;agents.push({id:agent.id,seq:agent.session.seq,wake:agent.jotPendingInputProtocol??null,revoke:agent.jotPendingWakeRevocationProtocol??null});save();if(existsSync(fixture.seeded))return;
  const message={id:'original-native-input',role:'user',source:{kind:'user',rpcId:fixture.runId},content:[{type:'text',text:'Complete the original synthetic request.'}]};
  let goal;
  if(fixture.goalPhase){const goals=agent.ctx.get('goals');goal=goals.create(agent,{objective:'Retain the independent synthetic Goal.',maxGoalRounds:5});goals.disarm(agent);if(fixture.goalPhase==='paused')goal=goals.pause(agent,{id:goal.id,revision:goal.revision});if(fixture.goalPhase==='blocked')goal=goals.block(agent,{id:goal.id,revision:goal.revision},{code:'fixture-blocked',message:'Synthetic external prerequisite.'});if(fixture.goalPhase==='complete')goal=goals.complete(agent,{id:goal.id,revision:goal.revision});}
  agent.send(message,'next-turn',false);await ctx.sessionPersistence.flush(agent.session);writeFileSync(fixture.seeded,JSON.stringify({messageId:message.id,sourceRpcId:fixture.runId,...(goal?{goal:{id:goal.id,revision:goal.revision,phase:goal.phase}}:{})}));
 });
 if(existsSync(fixture.seeded)){const projection=await ctx.sessionController.projections({sessionId:fixture.sessionId},new AbortController().signal);startupPending=[...projection.values.inbox['next-step'],...projection.values.inbox['next-turn']].map(message=>message.id);save();}
 return applyAdapter(ctx,{...config,ordinaryInputRecovery:{verifyComposition:async({phase,agent,projection,authority})=>{audits.push({phase,preset:projection.values.agentPreset,seq:agent?.session.seq??null,status:agent?.status??null,wake:agent?.jotPendingInputProtocol??null,revoke:agent?.jotPendingWakeRevocationProtocol??null});save();return{verified:authority.run_id===fixture.runId&&projection.values.agentPreset==='jot-general'&&(!agent||agent.id===fixture.sessionId&&agent.jotPendingWakeRevocationProtocol===1),fingerprint:fixture.fingerprint};}}});
}
