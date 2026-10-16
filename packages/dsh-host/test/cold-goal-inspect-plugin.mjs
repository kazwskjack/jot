// Test-only seeding; native services own all state and persistence.
import {writeFileSync,existsSync} from 'node:fs';
export const name='jot-cold-goal-inspection';
export const inject=['jotHostReady','sessionPersistence'];
export function apply(ctx,{receipt,seeded}){
 let created=0,modelCalls=0;const save=()=>writeFileSync(receipt,JSON.stringify({created,modelCalls}));save();
 ctx.on('llm/stream',()=>{modelCalls++;save();throw Error('test_inference_forbidden');},{prepend:true});
 ctx.on('agent/created',async({agent})=>{
  if(agent.id!=='cold-goal-canary')return;created++;save();if(existsSync(seeded))return;
  const goals=agent.ctx.get('goals');if(!goals)throw Error('real_goal_service_missing');
  const goal=goals.create(agent,{objective:'Retain the synthetic task after restart',maxGoalRounds:11});
  const paused=goals.pause(agent,{id:goal.id,revision:goal.revision});
  await ctx.sessionPersistence.flush(agent.session);writeFileSync(seeded,JSON.stringify({id:paused.id,revision:paused.revision,phase:paused.phase}));
 });
 ctx.provide('jotColdGoalInspectionReady',true);
}
