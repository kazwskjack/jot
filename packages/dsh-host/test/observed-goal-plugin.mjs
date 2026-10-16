// Synthetic Goal seeding and event observation. Never loaded in production.
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
export const name='jot-observed-goal-inspection';
export const inject=['jotHostReady','sessionPersistence'];
export function apply(ctx,{receipt,seeded,parkInput=false}){
 let created=0;const events=[];const save=()=>writeFileSync(receipt,JSON.stringify({created,events}));save();
 ctx.on('session/event',(session,event)=>{if(session.id!=='observed-goal-fixture')return;events.push({seq:event.seq,type:event.type,...(event.data?.source?{source:event.data.source}:{}),...(event.data?.reason?{reason:event.data.reason}:{})});save();});
 ctx.on('agent/created',async({agent})=>{
  if(agent.id!=='observed-goal-fixture')return;created++;save();if(existsSync(seeded))return;
  const goals=agent.ctx.get('goals');let g=goals.create(agent,{objective:'Complete the synthetic Goal and report OBSERVED-GOAL-OK.',maxGoalRounds:5});goals.disarm(agent);g=goals.pause(agent,{id:g.id,revision:g.revision});
  if(parkInput)agent.send({id:'parked-goal-input',content:[{type:'text',text:'Retain this pending synthetic input'}],source:{kind:'user'}},'next-turn',false);
  await ctx.sessionPersistence.flush(agent.session);writeFileSync(seeded,JSON.stringify({id:g.id,revision:g.revision}));
 });
 ctx.provide('jotObservedGoalReady',true);
}
