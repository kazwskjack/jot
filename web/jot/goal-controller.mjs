import {validateConversationGoalView,validateConversationGoalAcceptance,validateConversationGoalResumeReadiness} from '../../packages/gateway/src/harness/conversation-goal-view.ts';
function validate(value){try{return validateConversationGoalView(value).goal;}catch{throw Error('goal_view_invalid');}}
export class ConversationGoalController {
 constructor(id,api,onChange=()=>{},requireRecovery=false){this.id=id;this.api=api;this.onChange=onChange;this.goal=undefined;this.available=false;this.loading=false;this.busy=false;this.command=null;this.generation=0;this.requests=new Set();this.execution=null;this.resumeReadiness=undefined;this.readinessGeneration=0;this.recoveryReady=!requireRecovery;this.lifecycle=0;this.preparing=false;}
 async configureRecovery(store,verifyScope){
  if(store.conversation!==this.id||typeof verifyScope!=='function')throw Error('goal_recovery_invalid');
  const lifecycle=this.lifecycle;
  const reuse=()=>{if(!this.store)return false;if(store!==this.store)store.close?.();if(this.store.prefix!==store.prefix)throw Error('goal_recovery_scope_changed');return true;};
  if(reuse())return;const pending=await store.pending();if(lifecycle!==this.lifecycle){store.close?.();throw Error('goal_control_disposed');}if(reuse())return;
  this.store=store;this.verifyScope=verifyScope;this.command=pending[0]??null;this.recoveryReady=true;this.changed();
 }
 async checkScope(){if(!this.recoveryReady)throw Error('goal_recovery_unavailable');if(this.store&&await this.verifyScope(this.store.scope)!==true)throw Error('goal_recovery_scope_changed');}
 async acknowledge(command){if(this.store)await this.store.acknowledge(command);this.command=(this.store?await this.store.pending():[])[0]??null;}
 get pending(){return this.command!==null||this.preparing===true;}
 get executing(){return ['queued','starting','running','waiting_user','waiting_approval','cancelling'].includes(this.execution?.status);}
 changed(){this.onChange(this);}
 get path(){return `/conversations/${encodeURIComponent(this.id)}/goal`;}
 dispose(){this.lifecycle=(this.lifecycle??0)+1;this.generation++;this.readinessGeneration++;for(const request of this.requests)request.abort();this.requests.clear();this.store?.close?.();}
 refresh(){
  if(this.busy||this.preparing)return Promise.resolve(this.goal);
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
  const value={accepted:true,control_id:run.goal_control_id,run_id:run.run_id,conversation_id:this.id,status:run.status,...(typeof run.error_code==='string'?{error_code:run.error_code}:{})};
  if(JSON.stringify(this.execution)!==JSON.stringify(value)){this.execution=value;this.changed();}
 }
 async control(action){
  if(this.pending)throw Error('goal_control_pending');
  if(!this.recoveryReady)throw Error('goal_recovery_unavailable');
  const generation=this.generation;this.preparing=true;this.changed();
  try{
  if(this.store){this.command=(await this.store.pending())[0]??null;if(this.command){this.changed();throw Error('goal_control_pending');}}
  if(!this.available||!this.goal||!goalPresentation(this.goal).actions.includes(action))throw Error('goal_state_unavailable');
  if(action==='resume'){if(this.executing)throw Error('goal_control_pending');if(this.resumeReadiness?.ready!==true)throw Error('goal_resume_unavailable');}
  const command={body:{action,id:this.goal.id,revision:this.goal.revision},key:crypto.randomUUID()};
  if(this.store)await this.store.save(command);if(generation!==this.generation)throw Error('goal_control_disposed');this.command=command;
  }finally{this.preparing=false;this.changed();}
  return this.retry();
 }
 async retry(){
  if(this.busy||this.preparing||!this.command)throw Error('goal_control_pending');
  const generation=++this.generation,command=this.command,abort=new AbortController();this.requests.add(abort);this.busy=true;this.loading=false;this.changed();
  try{
   await this.checkScope();
   if(generation!==this.generation)throw Error('goal_control_disposed');
   const response=await this.api.request(this.path,'POST',command.body,command.key,abort.signal);
   if(this.store)await this.checkScope();
   if(command.body.action==='resume'){
    const accepted=validateConversationGoalAcceptance(response);if(accepted.conversation_id!==this.id)throw Error('goal_acceptance_invalid');
    if(generation===this.generation){await this.acknowledge(command);if(generation!==this.generation)throw Error('goal_control_disposed');this.execution={...accepted,status:'queued'};this.available=true;this.resumeReadiness=undefined;}return accepted;
   }
   const goal=validate(response);
   if(command.body.action==='stop'?goal!==null:!goal||goal.id!==command.body.id||goal.revision!==command.body.revision+1||goal.phase!=='paused'||goal.activation!=='disarmed')throw Error('goal_control_receipt_invalid');
   if(generation===this.generation){await this.acknowledge(command);if(generation!==this.generation)throw Error('goal_control_disposed');this.goal=goal;this.available=true;if(!goal)this.execution=null;}return goal;
  }catch(error){
   if(generation===this.generation){this.available=false;if(error?.status===409&&['GOAL_CONTEXT_RECOVERY_REQUIRED','GOAL_REVISION_CHANGED','GOAL_NOT_RESUMABLE','GOAL_RESUME_NOT_APPLIED'].includes(error.message))await this.acknowledge(command);}
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
 if(error?.message==='goal_recovery_scope_changed')return '登录用户已变化，请重新进入原用户的对话核对操作。';
 if(error?.message?.startsWith('goal_recovery_'))return '无法保存或读取目标操作回执，请检查浏览器存储后刷新。';
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

export function goalExecutionHint(execution){
 if(!execution||!['interrupted','failed'].includes(execution.status))return '';
 return ({GOAL_CONTEXT_RECOVERY_REQUIRED:'本次未启动：会话有待恢复内容，目标已保留。',GOAL_REVISION_CHANGED:'本次未启动：目标已变化，请刷新后确认。',GOAL_NOT_RESUMABLE:'本次未启动：当前目标暂不能继续。',GOAL_RESUME_NOT_APPLIED:'本次未启动，目标已保留，请核对后重试。'}[execution.error_code])??'续跑未完成，请核对执行记录后重试。';
}
