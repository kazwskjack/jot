// Synthetic Goal seeding and event observation. Never loaded in production.
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
export const name='jot-observed-goal-inspection';
export const inject=['jotHostReady','sessionPersistence','sessionController','agents'];
export async function apply(ctx,{receipt,seeded,parkInput=false,interruptTail=false,interruptTool=null,parkDuringRun=false}){
 let created=0,repairedTail=false,recoveryCodes=[],originalCalls=0,parkedDuringRun=false,pendingFlushed=false,pendingOnIdle=[],startupPending=[];const events=[];const save=()=>writeFileSync(receipt,JSON.stringify({created,events,repairedTail,recoveryCodes,originalCalls,parkedDuringRun,pendingFlushed,pendingOnIdle,startupPending}));save();
 ctx.on('llm/stream',(payload,next)=>{
  if(parkDuringRun&&!parkedDuringRun&&payload.sessionId==='observed-goal-fixture'){
   const agent=ctx.agents.get(payload.sessionId);parkedDuringRun=true;
   for(const [target,id] of [['next-turn','later-queued-human'],['next-step','later-steering-human']])agent.send({id,role:'user',content:[{type:'text',text:'Retain this later synthetic input'}],source:{kind:'user',rpcId:id+'-run'}},target,false);
   save();
  }
  return next();
 });
 ctx.on('agent/status',async({agent,status})=>{if(parkDuringRun&&parkedDuringRun&&agent.id==='observed-goal-fixture'&&status==='idle'){pendingOnIdle=[...agent.inbox.nextTurn,...agent.inbox.nextStep].map(message=>message.id).filter(id=>id.startsWith('later-')).sort();await ctx.sessionPersistence.flush(agent.session);pendingFlushed=true;save();}});
 ctx.on('session/event',(session,event)=>{if(session.id!=='observed-goal-fixture')return;events.push({seq:event.seq,type:event.type,...(event.data?.source?{source:event.data.source}:{}),...(event.data?.reason?{reason:event.data.reason}:{})});save();});
 ctx.on('agent/created',async({agent})=>{
  if(agent.id!=='observed-goal-fixture')return;created++;if(existsSync(seeded)){const history=agent.session.snapshotEvents(0);repairedTail=history.some(event=>event.type==='turn/end'&&event.data.turn===1&&event.data.reason?.kind==='interrupted');recoveryCodes=history.filter(event=>event.type==='tool/result'&&event.data.message.source.callId==='interrupted-original-call').map(event=>event.data.error?.code);originalCalls=history.filter(event=>event.type==='tool/call'&&event.data.callId==='interrupted-original-call').length;save();return;}save();
  const goals=agent.ctx.get('goals');let g=goals.create(agent,{objective:'Complete the synthetic Goal and report OBSERVED-GOAL-OK.',maxGoalRounds:5});goals.disarm(agent);g=goals.pause(agent,{id:g.id,revision:g.revision});
  if(parkInput)agent.send({id:'parked-goal-input',content:[{type:'text',text:'Retain this pending synthetic input'}],source:{kind:'user'}},'next-turn',false);
  if(interruptTail)agent.session.append('turn/start',{turn:1});
  if(interruptTool){
   agent.session.append('step/start',{turn:1,step:1});
   agent.session.append('system/message',{turn:1,step:1,message:{id:'interrupted-original-system',role:'system',source:{kind:'system-prompt'},content:[]}},{surfaceOp:'append'});
   const call={type:'tool-call',id:'interrupted-original-call',name:'write',arguments:JSON.stringify({path:'never-replayed.txt',content:'MUST-NOT-REPLAY'})};
   agent.session.append('assistant/message',{turn:1,step:1,message:{id:'interrupted-original-assistant',role:'assistant',source:{kind:'model',provider:'deepseek',model:'deepseek-flash'},content:[call]},stream:[]},{surfaceOp:'append'});
   if(interruptTool==='started')agent.session.append('tool/call',{turn:1,step:1,callId:call.id,name:call.name,arguments:call.arguments});
  }
  await ctx.sessionPersistence.flush(agent.session);writeFileSync(seeded,JSON.stringify({id:g.id,revision:g.revision}));
 });
 if(parkDuringRun&&existsSync(seeded)){const p=await ctx.sessionController.projections({sessionId:'observed-goal-fixture'},new AbortController().signal);startupPending=[...p.values.inbox['next-turn'],...p.values.inbox['next-step']].map(message=>message.id).filter(id=>id.startsWith('later-')).sort();save();}
 ctx.provide('jotObservedGoalReady',true);
}
