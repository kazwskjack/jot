import {createHash} from 'node:crypto';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** One host-owned dispatch path. Failed native work is never reissued to legacy. */
export function createNativeTaskDispatcher({bridge,host}){
 if(typeof bridge?.bindingFor!=='function'||typeof bridge?.guardBudget!=='function'||typeof bridge?.request!=='function'||typeof host?.spawn!=='function')throw new Error('native_task_dispatch_unavailable');
 return async(agent,binding,callId,args,signal)=>{
  signal?.throwIfAborted();
  const check=()=>{if(!binding||bridge.bindingFor(agent)!==binding)throw new Error('workbench_binding_changed');signal?.throwIfAborted();};
  check();
  if(!ID.test(String(callId))||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['subtask_id','expected_subtask_version','recipient_agent_id'].includes(k))
   ||!ID.test(String(args.subtask_id))||!ID.test(String(args.recipient_agent_id))||!Number.isSafeInteger(args.expected_subtask_version)||args.expected_subtask_version<1)throw new Error('workbench_arguments_invalid');
  const frozen=Object.freeze({...args}),requestId='delegate-'+createHash('sha256').update(JSON.stringify([binding.runId,binding.sessionRef,callId])).digest('hex');
  await bridge.guardBudget(agent,signal);check();
  const {plan}=await bridge.request('native-task-intent',binding,{...frozen,request_id:requestId},signal);check();
  if(!plan||plan.protocol!==1||plan.execution_authorized!==false||plan.request_id!==requestId||plan.role_ref!==frozen.recipient_agent_id
    ||plan.subtask_id!==frozen.subtask_id||plan.expected_subtask_version!==frozen.expected_subtask_version||!Number.isSafeInteger(plan.expected_policy_version)||plan.expected_policy_version<1
    ||typeof plan.name!=='string'||!plan.name.trim()||plan.name.length>80||typeof plan.description!=='string'||!plan.description.trim()||plan.description.length>2000
    ||typeof plan.text!=='string'||!plan.text.trim()||plan.text.length>32000)throw new Error('native_task_plan_invalid');
  const result=await host.spawn(agent,{roleRef:plan.role_ref,policyVersion:plan.expected_policy_version,requestId},
    {name:'role-'+createHash('sha256').update(JSON.stringify([plan.role_ref,requestId])).digest('hex').slice(0,20),description:plan.description,prompt:[{type:'text',text:plan.text}],context:'fresh',signal});
  check();
  if(typeof result?.member?.id!=='string'||!ID.test(result.member.id))throw new Error('native_role_publication_invalid');
  return {runtime:'native_team',request_id:requestId,subtask_id:plan.subtask_id,member:result.member};
 };
}
