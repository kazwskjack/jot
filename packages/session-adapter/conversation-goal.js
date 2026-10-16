// Native DSH owns goal state and scheduling. This is only the trusted host UI face.
function controlInput(body){
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('goal_input_invalid');
 if(!Object.keys(body).length)return false;
 if(Object.keys(body).length!==3||Object.keys(body).some(key=>!['action','id','revision'].includes(key))
  ||!['pause','resume','stop'].includes(body.action)||typeof body.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(body.id)||!Number.isSafeInteger(body.revision)||body.revision<1)throw Error('goal_action_invalid');
 return true;
}
export async function readConversationGoal({agent,agents,persistence,controller,sessionId,body,signal,ordinaryPresets}){
 const mutation=controlInput(body);signal?.throwIfAborted();
 if(agent)return conversationGoal(agent,body);
 // Resume needs an observed product run; a cold control must not arm a driver.
 if(mutation&&(body.action==='resume'||typeof agents?.get!=='function'||typeof persistence?.flush!=='function'||typeof controller?.resolveAgent!=='function'||typeof controller?.inspect!=='function'))throw Error('goal_unavailable');
 if(typeof controller?.projections!=='function')throw Error('goal_unavailable');
 const projection=await controller.projections({sessionId},signal);
 const view=projectedGoal(projection);
 if(!mutation)return view;
 if(!view.goal||view.goal.id!==body.id||view.goal.revision!==body.revision)throw Error('goal_revision_changed');
 if(body.action==='pause'&&view.goal.phase!=='active')throw Error('goal_action_invalid');
 const inbox=projection?.values?.inbox,preset=projection?.values?.agentPreset;
 if(!ordinaryPresets?.has(preset)||!inbox||Object.keys(inbox).length!==2||!['next-turn','next-step'].every(key=>Array.isArray(inbox[key])&&inbox[key].length===0))throw Error('goal_cold_input_pending');
 // turnBoundary is Host-only, not a wire projection. Inspect the official
 // validated history without activating an Agent; an open turn needs recovery.
 const history=await controller.inspect(sessionId,signal);signal?.throwIfAborted();
 if(history?.meta?.id!==sessionId||!Array.isArray(history.events))throw Error('goal_unavailable');
 let openTurn=null;
 for(const [index,event] of history.events.entries()){
  if(event?.seq!==index||typeof event.type!=='string')throw Error('goal_unavailable');
  if(event.type==='turn/start'){if(openTurn!==null||!Number.isSafeInteger(event.data?.turn)||event.data.turn<0)throw Error('goal_unavailable');openTurn=event.data.turn;}
  if(event.type==='turn/end'){if(openTurn===null||event.data?.turn!==openTurn)throw Error('goal_unavailable');openTurn=null;}
 }
 if(openTurn!==null)throw Error('goal_cold_input_pending');
 signal?.throwIfAborted();const resolved=await controller.resolveAgent(sessionId);agent=resolved?.agent;
 const check=()=>{signal?.throwIfAborted();if(resolved?.error||!agent||agent.id!==sessionId||agent.session?.id!==sessionId||agents.get(sessionId)!==agent||agent.status!=='idle'||!['nextTurn','nextStep'].every(key=>Array.isArray(agent.inbox?.[key])&&agent.inbox[key].length===0))throw Error('goal_unavailable');};
 check();if(typeof agent.runMaintenance!=='function')throw Error('goal_unavailable');
 return agent.runMaintenance(async maintenanceSignal=>{
  maintenanceSignal.throwIfAborted();check();const result=conversationGoal(agent,body);
  await persistence.flush(agent.session);maintenanceSignal.throwIfAborted();signal?.throwIfAborted();return result;
 });
}
function projectedGoal(projection){
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
 const mutation=controlInput(body);
 const scope=agent.ctx;
 const service=typeof scope?.get==='function'?scope.get('goals'):scope?.goals;
 if(!service){if(Object.keys(body).length===0)return {goal:null};throw new Error('goal_unavailable');}
 const goal=service.get(agent);
 if(!mutation)return {goal:goal??null};
 if(!goal||goal.id!==body.id||goal.revision!==body.revision)throw new Error('goal_revision_changed');
 const ref={id:goal.id,revision:goal.revision};
 if(body.action==='stop'){
   service.clear(agent,ref);return {goal:null};
 }
 return {goal:service[body.action](agent,ref)};
}

// Only the observed human-command path may use this resolver for resume. It
// performs the same cold safety checks before official Agent resolution; it
// neither arms the Goal nor supplies a prompt.
export async function prepareConversationGoalResume({controller,agents,persistence,sessionId,ref,signal,ordinaryPresets}){
 controlInput({action:'resume',...ref});signal?.throwIfAborted();
 if(typeof controller?.projections!=='function'||typeof controller?.inspect!=='function'||typeof controller?.resolveAgent!=='function'||typeof agents?.get!=='function'||typeof persistence?.flush!=='function')throw Error('goal_unavailable');
 const projection=await controller.projections({sessionId},signal),view=projectedGoal(projection);signal?.throwIfAborted();
 if(!view.goal||view.goal.id!==ref.id||view.goal.revision!==ref.revision)throw Error('goal_revision_changed');
 if(view.goal.phase==='complete')throw Error('goal_not_resumable');
 const inbox=projection?.values?.inbox;
 if(!ordinaryPresets?.has(projection?.values?.agentPreset)||!inbox||Object.keys(inbox).length!==2||!['next-turn','next-step'].every(key=>Array.isArray(inbox[key])&&!inbox[key].length))throw Error('goal_cold_input_pending');
 const history=await controller.inspect(sessionId,signal);signal?.throwIfAborted();
 if(history?.meta?.id!==sessionId||!Array.isArray(history.events))throw Error('goal_unavailable');
 let open=null;
 for(const [index,event] of history.events.entries()){
  if(event?.seq!==index||typeof event.type!=='string')throw Error('goal_unavailable');
  if(event.type==='turn/start'){if(open!==null||!Number.isSafeInteger(event.data?.turn)||event.data.turn<0)throw Error('goal_unavailable');open=event.data.turn;}
  if(event.type==='turn/end'){if(open===null||event.data?.turn!==open)throw Error('goal_unavailable');open=null;}
 }
 if(open!==null)throw Error('goal_cold_input_pending');
 const resolved=await controller.resolveAgent(sessionId),agent=resolved?.agent;
 const check=()=>{
  signal?.throwIfAborted();
  if(resolved?.error||!agent||agent.id!==sessionId||agent.session?.id!==sessionId||agents.get(sessionId)!==agent||agent.status!=='idle'||!['nextTurn','nextStep'].every(key=>Array.isArray(agent.inbox?.[key])&&!agent.inbox[key].length)||typeof agent.runMaintenance!=='function'||typeof agent.ctx?.on!=='function')throw Error('goal_unavailable');
 };
 check();return {agent,check};
}
