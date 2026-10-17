import {TaskSaveReceipt} from './task-save.mjs';
const messages={
 PRD_TASK_MUST_BE_PAUSED:'请先暂停原任务，再绑定 PRD。',
 PRD_ROLE_UNAVAILABLE:'原执行角色不可用，请先检查角色状态与权限。',
 PRD_EXECUTION_UNRESOLVED:'原任务仍有执行或未知执行结果，请先等待并核对回执。',
 PRD_BUDGET_UNRESOLVED:'原任务仍有模型额度预留或消耗待核对，请等待原预算回执确认。',
 PRD_OBJECTIVE_CHANGED:'原任务目标已被其他操作修改，请核对目标后重新选择来源。',
 PRD_MANAGED_TASK_FORBIDDEN:'此任务由项目发现策略管理，不能通过此入口绑定 PRD。',
 PRD_SOURCE_CHANGED:'来源版本或内容已变化，请刷新并重新选择。',
 PRD_PREVIEW_CHANGED:'任务、角色或来源已变化，预览已失效，请重新预览确认。',
 PRD_PREVIEW_VERSION_CONFLICT:'预览与原任务版本不一致，请刷新并重新选择来源。',
 PRD_SOURCE_UNAVAILABLE:'来源已移除或不可读取，请刷新并重新选择。',
 PRD_SOURCE_UNSUPPORTED:'来源格式不支持，请使用 UTF-8 文本或 Markdown 附件。',
 PRD_SOURCE_TOO_LARGE:'来源超过服务允许的大小，请精简需求后重新选择。',
 PRD_OBJECTIVE_TOO_LARGE:'完整任务目标超过服务允许的长度，请精简需求后重新预览。',
 PRD_SOURCE_INTEGRITY_FAILED:'来源内容与记录哈希不一致，请检查文件后重新选择。',
 PRD_BIND_RECEIPT_INVALID:'未收到有效绑定回执；请保留原请求并重试确认结果。',
 VERSION_CONFLICT:'原任务版本已变化，请刷新并重新选择来源。',
 ROLE_VERSION_CONFLICT:'原执行角色版本已变化，请刷新并重新选择来源。',
 IDEMPOTENCY_IN_PROGRESS:'原绑定请求仍在处理中，请稍后重试原请求。',
 IDEMPOTENCY_CONFLICT:'原请求回执存在冲突，请核对服务端绑定记录后重新选择。',
 TASK_NOT_FOUND:'原任务不存在或不可访问，请核对任务。',
 AGENT_NOT_FOUND:'原执行角色不存在或不可访问，请检查角色。',
 UNAUTHORIZED:'登录状态已失效，请恢复当前账户会话后重试。',
 CSRF_INVALID:'页面验证已失效，请刷新当前页面后重试原请求。',
 ORIGIN_FORBIDDEN:'当前页面来源未获允许，请从正式工作台重新打开。',
 INTERNAL_ERROR:'服务暂未确认结果，请稍后重试原请求。',
 INVALID_PRD_REQUEST:'请求内容无效，请刷新来源并重新预览。',
 INVALID_PRD_SOURCE:'来源标识无效，请从列表重新选择。',
 INVALID_WORKBENCH_REQUEST:'请求未通过服务校验，请刷新来源并重新预览。',
};
export function prdMessage(code){return messages[code]??(/^[A-Z][A-Z0-9_]+$/.test(code)?'当前状态暂不允许 PRD 操作，请核对原任务和服务状态后重试。':code==='Failed to fetch'?'连接中断，结果尚未确认；请重试原请求。':code);}

export const PRD_TEMPLATE='# 产品需求\n\n## 目标\n描述期望解决的问题与最终结果。\n\n## 范围\n列出包含的工作与不包含的工作。\n\n## 验收标准\n逐项说明可验证的完成条件与证据。\n\n## 依赖\n列出前置条件、所需输入和任务依赖。';
function selection(source){
 if(!source||!['logical_file','upload'].includes(source.kind)||!Number.isSafeInteger(source.version)||source.version<1||!/^[a-f0-9]{64}$/.test(source.sha256))throw Error('来源版本或哈希无效');
 const field=source.kind==='logical_file'?'path':'artifact_id';if(typeof source[field]!=='string'||!source[field])throw Error('来源标识无效');
 return {kind:source.kind,[field]:source[field],version:source.version,sha256:source.sha256};
}
function rejected(error){return Number.isInteger(error?.status)&&error.status>=400&&error.status<500&&error.status!==408&&error.message!=='IDEMPOTENCY_IN_PROGRESS';}
export class PrdCommandStore {
 constructor(storage,scope,taskId){if(!/^[a-f0-9]{64}$/.test(scope))throw Error('PRD 回执用户范围不可用');this.storage=storage;this.path=`/persistent-tasks/${encodeURIComponent(taskId)}/prd/bind`;this.key=`jot-task-prd/v1/${scope}/${encodeURIComponent(taskId)}`;}
 read(){const raw=this.storage.getItem(this.key);if(!raw)return null;if(raw.length>16000)throw Error('PRD 回执过大');const value=JSON.parse(raw),command=value?.command;
  if(!command||command.path!==this.path||command.method!=='POST'||typeof command.key!=='string'||!command.key||command.key.length>200||!/^[a-f0-9]{64}$/.test(command.body?.preview_sha256)||JSON.stringify(selection(command.body.source))!==JSON.stringify(command.body.source)||Object.keys(command.body).sort().join(',')!=='preview_sha256,source')throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  return {command};
 }
 saveCommand(command){if(command===null){this.complete();return;}this.storage.setItem(this.key,JSON.stringify({command}));}
 complete(){this.storage.removeItem(this.key);}
}
export class PrdFlow {
 constructor(task,executionReady,key,store=null){this.task={...task};this.executionReady=executionReady;this.save=new TaskSaveReceipt(key,store);this.sources=null;this.selection=null;this.preview=null;this.receipt=null;this.busy=false;this.refreshRequired=false;this.epoch=0;}
 get pending(){return this.save.pending;}
 get ready(){return this.executionReady&&this.task.status==='paused'&&this.sources?.task_id===this.task.task_id&&this.sources?.task_version===this.task.version&&this.sources?.readiness?.ready===true;}
 assertEditable(){if(this.pending)throw Error('请先确认原绑定回执');if(this.busy)throw Error('正在读取预览');}
 invalidate(){this.epoch++;this.selection=null;this.preview=null;this.sources=null;this.refreshRequired=true;}
 setContext(task,executionReady){if(task.task_id!==this.task.task_id||task.version!==this.task.version||task.status!==this.task.status||executionReady!==this.executionReady){if(!this.pending)this.invalidate();}this.task={...task};this.executionReady=executionReady;}
 setSources(data){this.assertEditable();this.sources=data;this.selection=null;this.preview=null;this.refreshRequired=false;this.epoch++;}
 choose(index){this.assertEditable();this.selection=index===''?null:selection(this.sources?.sources[index]);this.preview=null;this.receipt=null;this.epoch++;}
 async loadPreview(request){
  this.assertEditable();if(!this.selection)throw Error('请重新选择来源');if(!this.ready)throw Error('请暂停原任务并等待执行与来源就绪');
  const epoch=this.epoch,source=structuredClone(this.selection);this.busy=true;this.preview=null;
  try{const value=await request(`/persistent-tasks/${encodeURIComponent(this.task.task_id)}/prd/preview`,'POST',{source});
   if(epoch!==this.epoch)return;
   if(value.task_id!==this.task.task_id||value.task_version!==this.task.version||value.execution_authorized!==false||JSON.stringify(selection(value.source))!==JSON.stringify(source)||typeof value.content!=='string'||typeof value.objective!=='string'||!/^[a-f0-9]{64}$/.test(value.preview_sha256))throw Error('PRD_PREVIEW_VERSION_CONFLICT');
   this.preview=value;
  }catch(error){if(rejected(error)||/CONFLICT/.test(error.message))this.invalidate();throw error;}finally{this.busy=false;}
 }
 async bind(request,confirmed){
  if(this.busy)throw Error('正在处理绑定');
  if(!this.pending&&(!confirmed||!this.preview||!this.ready))throw Error('请阅读预览并显式确认绑定原暂停任务');
  this.busy=true;
  const checkedRequest=async(...args)=>{const result=await request(...args);
   if(!result||result.task_id!==this.task.task_id||typeof result.binding_id!=='string'||!result.binding_id||!Number.isSafeInteger(result.task_version)||!Number.isSafeInteger(result.revision)||result.execution_authorized!==false||!/^[a-f0-9]{64}$/.test(result.content_sha256)||!/^[a-f0-9]{64}$/.test(result.objective_sha256))throw Error('PRD_BIND_RECEIPT_INVALID');
   return result;
  };
  try{const result=await this.save.submit(checkedRequest,`/persistent-tasks/${encodeURIComponent(this.task.task_id)}/prd/bind`,'POST',this.pending?{}:{source:selection(this.preview.source),preview_sha256:this.preview.preview_sha256});this.receipt=result;this.preview=null;return result;}
  catch(error){if(!this.pending&&rejected(error))this.invalidate();throw error;}finally{this.busy=false;}
 }
}

// Capture before parent dialog and navigation handlers. Browser chrome navigation
// is covered by beforeunload; ordinary UI navigation cannot discard an unknown command.
export function installPrdLeaveGuard(target,pending,inside){
 const guard=event=>{if(!pending())return;
  if(event.type==='beforeunload'){event.preventDefault();event.returnValue='';return;}
  if(event.type==='keydown'&&event.key==='Tab')return;
  if(event.type==='keydown'&&event.key!=='Escape'&&inside(event.target)&&!(event.altKey&&['ArrowLeft','ArrowRight'].includes(event.key)))return;
  if(event.type!=='keydown'&&inside(event.target))return;
  event.preventDefault();event.stopImmediatePropagation();
 };
 const types=['click','pointerdown','submit','keydown','beforeunload'],options={capture:true};for(const type of types)target.addEventListener(type,guard,options);
 return ()=>{for(const type of types)target.removeEventListener(type,guard,options);};
}
