// Synthetic seeding and observation only; never installed by a production profile.
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
export const name='jot-cold-goal-control-inspection';
export const inject=['jotHostReady','sessionPersistence'];
export function apply(ctx,{receipt,seeded}){
 let created=0,modelCalls=0;const save=()=>writeFileSync(receipt,JSON.stringify({created,modelCalls}));save();
 ctx.on('llm/stream',()=>{modelCalls++;save();throw Error('test_inference_forbidden');},{prepend:true});
 ctx.on('agent/created',async({agent})=>{
  if(!['cold-stop-fixture','cold-clear-active-fixture','cold-pause-fixture','cold-pending-fixture'].includes(agent.id))return;
  created++;save();const records=existsSync(seeded)?JSON.parse(readFileSync(seeded,'utf8')):{};if(records[agent.id])return;
  const goals=agent.ctx.get('goals');let goal=goals.create(agent,{objective:'Retain this synthetic objective across restart',maxGoalRounds:11});
  goals.disarm(agent);if(agent.id==='cold-stop-fixture')goal=goals.pause(agent,{id:goal.id,revision:goal.revision});
  if(agent.id==='cold-pending-fixture')agent.send({id:'parked-synthetic-input',content:[{type:'text',text:'Keep this synthetic input parked'}],source:{kind:'user'}},'next-turn',false);
  await ctx.sessionPersistence.flush(agent.session);records[agent.id]={id:goal.id,revision:goal.revision,phase:goal.phase};writeFileSync(seeded,JSON.stringify(records));
 });
 ctx.provide('jotColdGoalControlReady',true);
}
