import {isAbsolute} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const workbenchKeys=['owner_id','project_id','workspace_id','agent_id','run_id','session_ref','capability_epoch'];
const ordinaryKeys=['kind','owner_id','project_id','workspace_id','conversation_id','conversation_version','run_id','run_version','session_ref','mode'];
export function normalizeSkillReadScope(value){
 const ordinary=value?.kind==='ordinary',keys=ordinary?ordinaryKeys:workbenchKeys;
 const ids=ordinary?['owner_id','workspace_id','conversation_id','run_id','session_ref']:keys.slice(0,-1);
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(',')
  ||ids.some(key=>typeof value[key]!=='string'||!ID.test(value[key]))
  ||ordinary&&(value.project_id!==null&&(typeof value.project_id!=='string'||!ID.test(value.project_id))
   ||!['work','chat'].includes(value.mode)||!['run_version','conversation_version'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=1))
  ||!ordinary&&(!Number.isSafeInteger(value.capability_epoch)||value.capability_epoch<1))throw Error('skill_catalog_scope_forbidden');
 return Object.freeze({...value});
}
/** Borrow an exact resident Agent. Ordinary reads verify their original DB binding. */
export function createSkillReadBinding({scope,signal,agents,sessions,bridge,ordinaryPresets}){
 const agent=agents.get(scope.session_ref),session=sessions.get(scope.session_ref),binding=agent&&bridge.bindingFor(agent),cwd=session?.header?.cwd;
 const ordinary=scope.kind==='ordinary';
 const check=()=>{
  signal.throwIfAborted();
  if(!agent||agent.id!==scope.session_ref||agent.session!==session||session?.id!==scope.session_ref
   ||typeof cwd!=='string'||!isAbsolute(cwd)||session.header.cwd!==cwd||agents.get(agent.id)!==agent||sessions.get(session.id)!==session
   ||bridge.bindingFor(agent)!==binding
   ||ordinary&&(binding!==undefined||!ordinaryPresets?.has(session.header.agentPreset)
    ||(scope.mode==='chat')!==(session.header.agentPreset==='jot-chat'))
   ||!ordinary&&(binding?.runId!==scope.run_id||binding?.sessionRef!==scope.session_ref))throw Error('skill_catalog_scope_changed');
 };
 const authorize=async()=>{
  check();
  if(ordinary){
   const result=await bridge.request('ordinary-skill-scope',{runId:scope.run_id,sessionRef:scope.session_ref},{scope},signal);
   check();if(result?.execution_authorized!==false||!isDeepStrictEqual(result.scope,scope))throw Error('skill_catalog_scope_changed');
  }else{
   await bridge.guard(agent,signal);check();
   const {context}=await bridge.request('guard',binding,{},signal);check();
   if(!context||workbenchKeys.filter(key=>key!=='session_ref').some(key=>context[key]!==scope[key]))throw Error('skill_catalog_scope_forbidden');
  }
 };
 return {agent,session,cwd,authorize};
}
