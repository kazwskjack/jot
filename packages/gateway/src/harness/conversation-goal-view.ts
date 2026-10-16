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
