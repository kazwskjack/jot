import {validateConversationGoalView,validateConversationGoalAcceptance,validateConversationGoalResumeReadiness} from '../../packages/gateway/src/harness/conversation-goal-view.ts';
function validate(value){try{return validateConversationGoalView(value).goal;}catch{throw Error('goal_view_invalid');}}
export class ConversationGoalController {
 constructor(id,api,onChange=()=>{}){this.id=id;this.api=api;this.onChange=onChange;this.goal=undefined;this.available=false;this.loading=false;this.busy=false;this.command=null;this.generation=0;this.requests=new Set();this.execution=null;this.resumeReadiness=undefined;this.readinessGeneration=0;}
 get pending(){return this.command!==null;}
 get executing(){return ['queued','starting','running','waiting_user','waiting_approval','cancelling'].includes(this.execution?.status);}
 changed(){this.onChange(this);}
 get path(){return `/conversations/${encodeURIComponent(this.id)}/goal`;}
 dispose(){this.generation++;this.readinessGeneration++;for(const request of this.requests)request.abort();this.requests.clear();}
 refresh(){
  if(this.busy)return Promise.resolve(this.goal);
  if(this.loading&&this.reading)return this.reading;
  const generation=++this.generation,abort=new AbortController();this.requests.add(abort);this.loading=true;this.changed();
  return this.reading=(async()=>{
   try{const goal=validate(await this.api.request(this.path,'GET',undefined,undefined,abort.signal));if(generation===this.generation){this.goal=goal;this.available=true;}return goal;}
   catch(error){if(generation===this.generation)this.available=false;throw error;}
   finally{this.requests.delete(abort);if(generation===this.generation){this.loading=false;this.changed();}}
  })();
 }
 refreshReadiness(){
  if(this.readinessPromise)return this.readinessPromise;
  const generation=++this.readinessGeneration,abort=new AbortController();this.requests.add(abort);
  return this.readinessPromise=(async()=>{
   try{const value=validateConversationGoalResumeReadiness(await Promise.resolve().then(()=>this.api.request(this.path+'/resume-readiness','GET',undefined,undefined,abort.signal)));if(generation===this.readinessGeneration)this.resumeReadiness=value;return value;}
   catch(error){if(generation===this.readinessGeneration)this.resumeReadiness=undefined;throw error;}
   finally{this.requests.delete(abort);this.readinessPromise=null;this.changed();}
  })();
 }
 observeRun(run){
  if(!run||run.conversation_id!==this.id||typeof run.run_id!=='string'||typeof run.goal_control_id!=='string'||!/^goal-control-[A-Za-z0-9-]{1,128}$/.test(run.goal_control_id)||!['queued','starting','running','waiting_user','waiting_approval','cancelling','succeeded','partial','failed','cancelled','interrupted'].includes(run.status))return;
  const value={accepted:true,control_id:run.goal_control_id,run_id:run.run_id,conversation_id:this.id,status:run.status};
  if(JSON.stringify(this.execution)!==JSON.stringify(value)){this.execution=value;this.changed();}
 }
 async control(action){
  if(this.pending)throw Error('goal_control_pending');
  if(!this.available||!this.goal||!goalPresentation(this.goal).actions.includes(action))throw Error('goal_state_unavailable');
  if(action==='resume'){if(this.executing)throw Error('goal_control_pending');if(this.resumeReadiness?.ready!==true)throw Error('goal_resume_unavailable');}
  this.command={body:{action,id:this.goal.id,revision:this.goal.revision},key:crypto.randomUUID()};return this.retry();
 }
 async retry(){
  if(this.busy||!this.command)throw Error('goal_control_pending');
  const generation=++this.generation,command=this.command,abort=new AbortController();this.requests.add(abort);this.busy=true;this.loading=false;this.changed();
  try{
   const response=await this.api.request(this.path,'POST',command.body,command.key,abort.signal);
   if(command.body.action==='resume'){
    const accepted=validateConversationGoalAcceptance(response);if(accepted.conversation_id!==this.id)throw Error('goal_acceptance_invalid');
    if(generation===this.generation){this.execution={...accepted,status:'queued'};this.available=true;this.command=null;this.resumeReadiness=undefined;}return accepted;
   }
   const goal=validate(response);
   if(generation===this.generation){this.goal=goal;this.available=true;this.command=null;if(!goal)this.execution=null;}return goal;
  }catch(error){
   if(generation===this.generation){this.available=false;if(error?.status>=400&&error.status<500&&error.status!==408&&error.message!=='IDEMPOTENCY_IN_PROGRESS')this.command=null;}
   throw error;
  }finally{this.requests.delete(abort);this.busy=false;this.changed();}
 }
}
export function goalPresentation(goal){
 const label=goal.phase==='active'?(goal.activation==='armed'?'目标进行中':'目标待继续'):({paused:'目标已暂停',blocked:'目标需要处理',complete:'目标已完成'}[goal.phase]);
 return {label,actions:goal.phase==='complete'?['stop']:goal.phase==='active'&&goal.activation==='armed'?['pause','stop']:['resume','stop']};
}
export function goalPrompt(text,enabled=false){
 if(!enabled)return text;
 return '目标模式：先调用 get_goal。没有目标时，调用 create_goal 创建以下目标，max_goal_rounds=9007199254740991（不设业务轮次上限）。已有目标时根据本条消息继续或调整，不重复创建、不丢进度。由原生目标驱动继续执行；用户暂停或停止、需要人工验证或真实阻塞时正确停止。按真实工具回执验收，不把进度答复当完成。\n用户目标：'+text;
}
export function goalControlError(error){
 if(error?.status===409&&error.message==='GOAL_CONTEXT_RECOVERY_REQUIRED')return '会话有待恢复内容，请先恢复当前任务。';
 if(error?.status===409&&error.message==='IDEMPOTENCY_IN_PROGRESS')return '操作仍在处理中，请重试原操作。';
 if(error?.status===409)return '目标或运行状态已变化，请刷新后确认。';
 return '操作结果尚未确认，请核对后重试原操作。';
}

export function goalResumeHint(readiness){
 return ({DISABLED:'续跑功能尚未启用。',NO_SESSION:'目标会话尚未就绪。',RUN_BUSY:'请等待当前执行结束后再继续。',UNCONFIRMED_CONTROL:'上次恢复结果待核对，暂不能再次启动。',HOST_UNAVAILABLE:'续跑服务暂不可用，请稍后刷新。'}[readiness?.reason])??'正在检查续跑状态…';
}

export function latestGoalRun(runs,conversationId){
 const candidates=runs.filter(run=>run.conversation_id===conversationId&&typeof run.goal_control_id==='string');
 return candidates.find(run=>['queued','starting','running','waiting_user','waiting_approval','cancelling'].includes(run.status))??candidates.sort((a,b)=>String(b.created_at??'').localeCompare(String(a.created_at??''))||String(b.run_id).localeCompare(String(a.run_id)))[0];
}
