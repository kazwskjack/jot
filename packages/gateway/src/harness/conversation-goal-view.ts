export interface ConversationGoal {
  id:string;revision:number;objective:string;
  phase:'active'|'paused'|'blocked'|'complete';activation:'armed'|'disarmed';
  maxGoalRounds?:number;roundsStarted?:number;createdAt?:number;updatedAt?:number;
  blockedReason?:{code:string;message:string};
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
/** Native facts for display and continuation observation, never execution authority. */
export function validateConversationGoalView(value:unknown):{goal:ConversationGoal|null}{
  const invalid=():never=>{throw Error('conversation_goal_state_invalid');};
  if(!object(value)||Object.keys(value).length!==1||!Object.hasOwn(value,'goal'))return invalid();
  if(value.goal===null)return {goal:null};
  const g=value.goal;
  if(!object(g)||Object.keys(g).some(k=>!['id','revision','objective','phase','activation','maxGoalRounds','roundsStarted','createdAt','updatedAt','blockedReason'].includes(k))
    ||typeof g.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(g.id)
    ||!Number.isSafeInteger(g.revision)||Number(g.revision)<1||typeof g.objective!=='string'||!g.objective.trim()
    ||typeof g.phase!=='string'||!['active','paused','blocked','complete'].includes(g.phase)||typeof g.activation!=='string'||!['armed','disarmed'].includes(g.activation))return invalid();
  for(const key of ['maxGoalRounds','roundsStarted'])if(g[key]!==undefined&&(!Number.isSafeInteger(g[key])||Number(g[key])<(key==='maxGoalRounds'?1:0)))return invalid();
  if(g.maxGoalRounds!==undefined&&g.roundsStarted!==undefined&&Number(g.roundsStarted)>Number(g.maxGoalRounds))return invalid();
  for(const key of ['createdAt','updatedAt'])if(g[key]!==undefined&&(typeof g[key]!=='number'||!Number.isFinite(g[key])))return invalid();
  if(g.createdAt!==undefined&&g.updatedAt!==undefined&&Number(g.updatedAt)<Number(g.createdAt))return invalid();
  if(g.blockedReason!==undefined&&(!object(g.blockedReason)||Object.keys(g.blockedReason).some(k=>!['code','message'].includes(k))||typeof g.blockedReason.code!=='string'||typeof g.blockedReason.message!=='string'))return invalid();
  return {goal:structuredClone(g) as unknown as ConversationGoal};
}

export interface ConversationGoalAcceptance {accepted:true;control_id:string;run_id:string;conversation_id:string}
export function validateConversationGoalAcceptance(value:unknown):ConversationGoalAcceptance{
 if(!object(value)||Object.keys(value).sort().join(',')!=='accepted,control_id,conversation_id,run_id'||value.accepted!==true||typeof value.control_id!=='string'||value.control_id.length>128||!/^goal-control-[A-Za-z0-9-]{1,128}$/.test(value.control_id)||!['run_id','conversation_id'].every(key=>typeof value[key]==='string'&&/^[A-Za-z0-9][A-Za-z0-9_:\-]{0,127}$/.test(value[key] as string)))throw Error('goal_acceptance_invalid');
 return structuredClone(value) as unknown as ConversationGoalAcceptance;
}
export interface ConversationGoalResumeReadiness {enabled:boolean;ready:boolean;reason:'READY'|'DISABLED'|'NO_SESSION'|'RUN_BUSY'|'UNCONFIRMED_CONTROL'|'HOST_UNAVAILABLE'}
export function validateConversationGoalResumeReadiness(value:unknown):ConversationGoalResumeReadiness{
 if(!object(value)||Object.keys(value).sort().join(',')!=='enabled,ready,reason'||typeof value.enabled!=='boolean'||typeof value.ready!=='boolean'||typeof value.reason!=='string'||!['READY','DISABLED','NO_SESSION','RUN_BUSY','UNCONFIRMED_CONTROL','HOST_UNAVAILABLE'].includes(value.reason)||value.ready&&(!value.enabled||value.reason!=='READY')||!value.ready&&value.reason==='READY'||!value.enabled&&(value.ready||value.reason!=='DISABLED'))throw Error('goal_resume_readiness_invalid');
 return structuredClone(value) as unknown as ConversationGoalResumeReadiness;
}
