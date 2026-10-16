// Test-only audit and seed wrapper. Never install as a product adapter.
import {writeFileSync,renameSync,existsSync} from 'node:fs';
import {apply as applyAdapter} from '../../session-adapter/index.js';
export {name,inject} from '../../session-adapter/index.js';
export async function apply(ctx,{fixture,...config}){
 let created=0,idleFlushed=false,startupPending=[];const users=[],events=[],audits=[],agents=[],messageKinds=[];
 const save=()=>{writeFileSync(fixture.receipt+'.new',JSON.stringify({created,idleFlushed,startupPending,users,events,audits,agents,messageKinds}));renameSync(fixture.receipt+'.new',fixture.receipt);};save();
 ctx.on('session/event',(session,event)=>{if(session.id!==fixture.sessionId)return;events.push({type:event.type,...(event.data?.reason?{reason:event.data.reason}:{})});if(event.type==='user/message'){messageKinds.push(event.data.source.kind);if(event.data.source.kind==='user')users.push({id:event.data.id,source:{kind:'user',rpcId:event.data.source.rpcId}});}save();});
 ctx.on('agent/status',async({agent,status})=>{if(agent.id===fixture.sessionId&&status==='idle'){await ctx.sessionPersistence.flush(agent.session);idleFlushed=true;save();}});
 ctx.on('agent/created',async({agent})=>{
  if(agent.id!==fixture.sessionId)return;created++;agents.push({id:agent.id,seq:agent.session.seq,wake:agent.jotPendingInputProtocol??null,revoke:agent.jotPendingWakeRevocationProtocol??null});save();if(existsSync(fixture.seeded))return;
  const message={id:'original-native-input',role:'user',source:{kind:'user',rpcId:fixture.runId},content:[{type:'text',text:'Complete the original synthetic request.'}]};
  agent.send(message,'next-turn',false);await ctx.sessionPersistence.flush(agent.session);writeFileSync(fixture.seeded,JSON.stringify({messageId:message.id,sourceRpcId:fixture.runId}));
 });
 if(existsSync(fixture.seeded)){const projection=await ctx.sessionController.projections({sessionId:fixture.sessionId},new AbortController().signal);startupPending=[...projection.values.inbox['next-step'],...projection.values.inbox['next-turn']].map(message=>message.id);save();}
 return applyAdapter(ctx,{...config,ordinaryInputRecovery:{verifyComposition:async({phase,agent,projection,authority})=>{audits.push({phase,preset:projection.values.agentPreset,seq:agent?.session.seq??null,status:agent?.status??null,wake:agent?.jotPendingInputProtocol??null,revoke:agent?.jotPendingWakeRevocationProtocol??null});save();return{verified:authority.run_id===fixture.runId&&projection.values.agentPreset==='jot-general'&&(!agent||agent.id===fixture.sessionId&&agent.jotPendingWakeRevocationProtocol===1),fingerprint:fixture.fingerprint};}}});
}
