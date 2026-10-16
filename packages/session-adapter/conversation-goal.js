// Native DSH owns goal state and scheduling. This is only the trusted host UI face.
export async function readConversationGoal({agent,controller,sessionId,body,signal}){
 if(agent)return conversationGoal(agent,body);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length||typeof controller?.projections!=='function')throw Error('goal_unavailable');
 const projection=await controller.projections({sessionId},signal);
 if(projection===null)return {goal:null};
 if(!projection?.values||!Object.hasOwn(projection.values,'goal'))throw Error('goal_unavailable');
 const state=projection.values.goal;
 if(state===null)return {goal:null};
 const goal=state?.goal;
 if(!goal||typeof goal.id!=='string'||!goal.id||!Number.isSafeInteger(goal.revision)||goal.revision<1
  ||typeof goal.objective!=='string'||!goal.objective||!['active','paused','blocked','complete'].includes(goal.phase)
  ||!Number.isSafeInteger(goal.maxGoalRounds)||goal.maxGoalRounds<1
  ||!Number.isSafeInteger(state.roundsStarted)||state.roundsStarted<0||state.roundsStarted>goal.maxGoalRounds
  ||!Number.isFinite(state.createdAt)||!Number.isFinite(state.updatedAt)||state.updatedAt<state.createdAt)throw Error('goal_unavailable');
 return {goal:{...goal,roundsStarted:state.roundsStarted,createdAt:state.createdAt,updatedAt:state.updatedAt,activation:'disarmed'}};
}
export function conversationGoal(agent,body){
 if(!agent)throw new Error('goal_unavailable');
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('goal_input_invalid');
 const scope=agent.ctx;
 const service=typeof scope?.get==='function'?scope.get('goals'):scope?.goals;
 if(!service){if(Object.keys(body).length===0)return {goal:null};throw new Error('goal_unavailable');}
 const goal=service.get(agent);
 if(Object.keys(body).length===0)return {goal:goal??null};
 if(!['pause','resume','stop'].includes(body.action)||Object.keys(body).some(k=>!['action','id','revision'].includes(k)))throw new Error('goal_action_invalid');
 if(!goal||goal.id!==body.id||goal.revision!==body.revision)throw new Error('goal_revision_changed');
 const ref={id:goal.id,revision:goal.revision};
 if(body.action==='stop'){
   const stopped=goal.phase==='active'?service.pause(agent,ref):goal;
   service.clear(agent,{id:stopped.id,revision:stopped.revision});return {goal:null};
 }
 return {goal:service[body.action](agent,ref)};
}
