import {TaskSaveReceipt} from './task-save.mjs';
const messages={
 INVALID_PRD_TEMPLATE_DEPENDENCIES:'依赖 ID 须来自此原任务的子任务账本，请核对后重新预览。',
 PRD_WORK_PLAN_RESEARCH_REQUIRED:'研究模式需要本批真实 web.read 或 files.read 资料回执，请将回执引用加入计划 evidence。',
 PRD_WORK_PLAN_RESEARCH_UNVERIFIED:'研究资料回执与原读取结果未完成核对。',
 PRD_WORK_PLAN_APPEND_CHANGED:'追加基线中的原生子任务定义或依赖已变化，请保留基线后重新提交计划。',
 PRD_APPEND_SOURCE_INTEGRITY_FAILED:'原追加基线校验未完成，请保留回执并稍后重读。',
 INVALID_PRD_TASK_COUNT:'期望任务数需为非负安全整数，0 或留空由原 DSH 自动拆解。',
 PRD_WORK_PLAN_TASK_COUNT_MISMATCH:'本批原生子任务账本数量与已确认期望数量不一致。',
 PRD_TASKMASTER_RUNTIME_UNAVAILABLE:'Taskmaster 实际运行版本尚待确认，请重读安装资料后再观察。',
 INVALID_PRD_WORK_ADMISSION:'准入请求无效，请重新核对原 grant。',
 PRD_WORK_ADMISSION_UNAVAILABLE:'原 Worker 工作配置尚未就绪，请保留原请求。',
 PRD_WORK_ADMISSION_SCOPE_CHANGED:'原计划、grant 或工作循环已变化，请重新核对。',
 PRD_WORK_ADMISSION_INTEGRITY_FAILED:'原准入记录校验未完成，请保留请求并稍后重读。',
 PRD_WORK_ADMISSION_RECEIPT_INVALID:'原准入回执待核对，请保留原请求并重试。',
 ADMISSION_PENDING:'准入请求已保存，等待现有 Worker 核对。',
 ADMISSION_CHECKING:'现有 Worker 正在核对原生状态、快照字节和预算。',
 ADMISSION_RETRY:'准入条件尚待确认，原请求继续保留并由现有 Worker 重试。',
 CAPACITY_UNAVAILABLE:'原 Worker 容量暂不可用，保留请求并等待。',
 NATIVE_IDLE_UNCONFIRMED:'原生空闲状态待确认。',
 OBSERVATION_STALE:'原生或预算观测已过期，等待重新核对。',
 AUTHORITY_CHANGED:'原角色或授权版本已变化，请核对原任务与工作循环。',
 AGENT_BUSY:'原角色仍有执行，等待原生空闲。',
 HOST_UNAVAILABLE:'原生 Host 暂不可用，请核对原环境状态。',
 WORKSPACE_UNAVAILABLE:'原工作区暂不可用，请核对原项目。',
 ROLE_UNAVAILABLE:'原角色暂不可用，请核对原角色状态。',
 BUDGET_BLOCKED:'原任务预算已阻塞，请核对原累计费用和执行次数。',
 BUDGET_UNCONFIRMED:'原任务预算尚待确认。',
 SOURCE_CHANGED:'原来源已经变化，请重新核对原工作循环。',
 WORK_CYCLE_CLOSED:'原工作循环已关闭，请核对原计划。',
 WORK_CYCLE_AUTHORITY_REVOKED:'原工作循环权限已变化，请重新核对。',
 WORK_GRANT_AUTHORITY_REVOKED:'原 grant 权限已变化，请重新核对。',
 WORK_ADMISSION_SOURCE_CHANGED:'原来源版本已变化，请重新核对。',
 WORK_ADMISSION_SNAPSHOT_CHANGED:'原快照已变化，请保留记录并核对。',
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
 PRD_SOURCE_UNSUPPORTED:'来源格式不支持，请使用 UTF-8 文本、Markdown 或有效的 Taskmaster JSON 任务文件。',
 PRD_TASKMASTER_UNAVAILABLE:'当前用户运行环境的 Taskmaster 安装资料暂不可读取。可继续使用原 PRD 文件来源流程。',
 PRD_TASKMASTER_CONTEXT_CHANGED:'任务或角色已变化，请刷新后重新读取来源。',
 PRD_TASKMASTER_IMPORT_UNAVAILABLE:'项目文件导入暂不可用，请保留原请求并稍后重试。',
 PRD_TASKMASTER_IMPORT_UNCONFIRMED:'项目文件导入回执待核对，请保留原请求并重试原回执。',
 WORKSPACE_COORDINATION_REQUIRED:'项目正在进行目录协调操作，请等待原回执完成后重试。',
 PRD_TASKMASTER_PROJECT_UNAVAILABLE:'项目 Taskmaster 文件暂不可读取，请确认服务器已配置此项目的 Git 目录且文件保持稳定。可继续使用原 PRD 文件来源流程。',
 PRD_SOURCE_TOO_LARGE:'来源超过 1 MiB 的服务读取上限，请核对来源大小。',
 PRD_OBJECTIVE_TOO_LARGE:'任务目标超过 12,000 字符，请核对原任务目标配置。',
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
 INVALID_PRD_WORK_PLAN:'文件计划提案格式或大小不符合要求，请核对路径、步骤和原读取回执。',
 PRD_WORK_PLAN_FULL_READ_REQUIRED:'请用原读取回执连续覆盖本批全部 PRD 原文后，再提交提案。',
 PRD_WORK_PLAN_READ_UNVERIFIED:'提案读取回执与本批固定 PRD、运行身份或原文范围不匹配。',
 PRD_WORK_PLAN_SCOPE_CHANGED:'原任务或角色范围已变化，请核对当前来源后重新规划。',
 PRD_WORK_PLAN_UNAVAILABLE:'文件计划提案入口暂不可用。',
 PRD_WORK_PLAN_NOT_FOUND:'此任务的文件计划提案不可访问。',
 PRD_WORK_PLAN_INTEGRITY_FAILED:'文件计划提案原记录校验未完成，请稍后重读。',
 INVALID_PRD_WORK_RESOURCE:'快照或路径确认请求无效，请重新读取原记录。',
 PRD_WORK_PREPARATION_UNAVAILABLE:'原工作快照或 grant 尚未配置，请保留原请求。',
 PRD_WORK_PREPARATION_CHANGED:'原快照、确认来源或循环版本已变化，请核对原记录。',
 PRD_WORK_PREPARATION_UNRESOLVED:'原执行或费用尚未收束，请先核对交接记录中的阻塞项。',
 PRD_WORK_PREPARATION_INTEGRITY_FAILED:'原快照或 grant 记录校验未完成，请保留请求并稍后重读。',
 PRD_WORK_RESOURCE_RECEIPT_INVALID:'原快照或 grant 回执待核对，请保留原请求并重试。',
 WORK_GRANT_BUDGET_UNCONFIRMED:'原任务预算或执行次数待核对，请查看原任务额度。',
 WORK_GRANT_EXISTS:'此循环已有原 grant，请重新读取资源记录。',
 WORK_GRANT_SOURCE_CHANGED:'原逻辑文件版本已变化，请核对原工作循环。',
 INVALID_PRD_WORK_HANDOFF:'规划交接请求无效，请重新核对原运行和版本。',
 PRD_WORK_HANDOFF_UNAVAILABLE:'原生工作交接尚未配置，请保留原请求。',
 PRD_WORK_HANDOFF_SCOPE_CHANGED:'规划运行或确认来源已变化，请重新读取原记录。',
 PRD_WORK_HANDOFF_BINDING_UNCONFIRMED:'原运行的原生 Session 绑定尚未确认，请核对原执行。',
 PRD_WORK_HANDOFF_INTEGRITY_FAILED:'原交接命令记录校验未完成，请保留原请求并重新读取。',
 PRD_WORK_HANDOFF_SUPERSEDED:'原交接命令已因运行状态或绑定变化停止，请核对原运行及当前原生状态。',
 PRD_WORK_HANDOFF_PENDING:'原生取消命令尚未确认，请等待原取消回执。',
 PRD_WORK_HANDOFF_RECEIPT_INVALID:'原交接请求回执待核对，请保留原请求并重试。',
 INVALID_PRD_WORK_CYCLE:'工作循环请求无效，请重新核对计划和原版本。',
 WORK_CYCLE_PRD_REVIEW_CHANGED:'提案确认记录与原请求不匹配，请重新读取确认记录。',
 WORK_CYCLE_AUTHORITY_REVOKED:'任务、角色或原执行来源已变化，请由原任务重新提交并确认计划。',
 WORK_CYCLE_BUDGET_BINDING_UNCONFIRMED:'原任务累计预算绑定待核对，暂不可创建工作循环。',
 WORK_CYCLE_SLOT_OCCUPIED:'此项目工作区已有开放循环，请核对原循环记录。',
 WORK_CYCLE_NOT_FOUND:'原工作循环不可访问，请重新读取原记录。',
 WORK_CYCLE_VERSION_CONFLICT:'原循环版本已变化，请重新读取。',
 WORK_CYCLE_CLOSED:'原工作循环已关闭，请读取原关闭回执。',
 WORK_CYCLE_CORRUPT:'原工作循环与来源记录校验未完成，请保留原请求并稍后重读。',
 PRD_WORK_CYCLE_RECEIPT_INVALID:'原循环回执待核对，请保留请求并重试。',
 INVALID_PRD_WORK_PLAN_ACCEPTANCE:'提案确认请求无效，请重新核对提案及版本。',
 PRD_WORK_PLAN_LEDGER_CHANGED:'提案提交后原账本已变化，请由原任务重新提交当前计划。',
 PRD_WORK_PLAN_ACCEPTANCE_CONFLICT:'此提案已有另一份确认请求，请读取原确认记录。',
 PRD_WORK_PLAN_ACCEPTANCE_INTEGRITY_FAILED:'提案确认回执校验未完成，请保留原请求并重试原回执。',
 PRD_WORK_PLAN_ACCEPTANCE_UNAVAILABLE:'提案确认入口暂不可用，请保留原请求并稍后重试。',
 INVALID_PRD_WORK_PLAN_LEDGER_TOO_LARGE:'本次原子任务账本超过 4 MiB 的提案冻结上限。',
 INVALID_PRD_FILE_NAME:'项目 PRD 文件名无效，请选择单层 Markdown 或文本文件。',
 INVALID_PRD_TEMPLATE_FILE:'模板文件名无效，请使用单层 Markdown 或文本文件名。',
 INVALID_PRD_TEMPLATE_VALUES:'模板字段须为最多 32 个字符串字段，每个值最多 2,000 字符。',
 PRD_TEMPLATE_NOT_FOUND:'模板已变化，请刷新模板目录后重新选择。',
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
function appendMatches(value,enabled){
 if(!enabled)return value.append===undefined&&value.append_source===undefined;
 const source=value.append_source;
 return value.append===true&&!!source&&Number.isSafeInteger(source.task_count)&&source.task_count>=0&&/^[a-f0-9]{64}$/.test(source.sha256);
}
export class PrdCommandStore {
 constructor(storage,scope,taskId,operation='bind'){
  if(!/^[a-f0-9]{64}$/.test(scope)||!['bind','taskmaster-import','template-apply','taskmaster-prd-import','work-plan-accept','work-plan-cycle','work-plan-handoff','work-plan-prepare','work-plan-grant','work-plan-admit'].includes(operation))throw Error('PRD 回执用户范围不可用');
  this.storage=storage;this.operation=operation;this.path=`/persistent-tasks/${encodeURIComponent(taskId)}/prd/${operation}`;
  this.key=`jot-task-prd/v1/${scope}/${encodeURIComponent(taskId)}`+(operation==='bind'?'':`/${operation}`);
 }
 read(){const raw=this.storage.getItem(this.key);if(!raw)return null;if(raw.length>(this.operation==='template-apply'?3145728:16000))throw Error('PRD 回执过大');const value=JSON.parse(raw),command=value?.command;
  if(!command||command.path!==this.path||command.method!=='POST'||typeof command.key!=='string'||!command.key||command.key.length>200||!/^[a-f0-9]{64}$/.test(command.body?.preview_sha256))throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  if(this.operation==='template-apply'){
   const body=command.body,values=body.values;
   const fieldLimits=new Map(body.template_id==='task-request'?[['任务提示词',1048576],['依赖原生ID',10240]]:[]);
   if(body.template_id!=='task-request'&&raw.length>524288)throw Error('PRD 回执过大');
   if(Object.keys(body).some(key=>!['template_id','file_name','values','preview_sha256'].includes(key))
    ||!['task-request','web-app','api','mobile-app','data-analysis'].includes(body.template_id)||typeof body.file_name!=='string'||!body.file_name||body.file_name.length>200
    ||(values!==undefined&&(!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length>32
     ||Object.entries(values).some(([key,value])=>!key||key.length>100||typeof value!=='string'||value.length>(fieldLimits.get(key)??2000)))))throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  }else if(this.operation==='work-plan-accept'){
   const body=command.body;
   if(Object.keys(body).sort().join(',')!=='expected_role_epoch,expected_role_version,expected_task_version,plan_id,preview_sha256'
    ||typeof body.plan_id!=='string'||!/^prd-plan-[a-f0-9]{64}$/.test(body.plan_id)
    ||[body.expected_task_version,body.expected_role_version,body.expected_role_epoch].some(value=>!Number.isSafeInteger(value)||value<1))throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  }else if(this.operation==='work-plan-cycle'){
   const body=command.body,keys=body.action==='create'?'action,plan_id,preview_sha256':body.action==='close'?'action,cycle_id,expected_version,plan_id,preview_sha256':'';
   if(!keys||Object.keys(body).sort().join(',')!==keys||typeof body.plan_id!=='string'||!/^prd-plan-[a-f0-9]{64}$/.test(body.plan_id)
    ||body.action==='close'&&(typeof body.cycle_id!=='string'||!body.cycle_id||body.cycle_id.length>256||!Number.isSafeInteger(body.expected_version)||body.expected_version<1))throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  }else if(this.operation==='work-plan-handoff'){
   const body=command.body;
   if(Object.keys(body).sort().join(',')!=='cycle_id,expected_run_version,plan_id,preview_sha256,run_id'
    ||typeof body.plan_id!=='string'||!/^prd-plan-[a-f0-9]{64}$/.test(body.plan_id)||typeof body.cycle_id!=='string'||!body.cycle_id||body.cycle_id.length>256
    ||typeof body.run_id!=='string'||!body.run_id||body.run_id.length>200||!Number.isSafeInteger(body.expected_run_version)||body.expected_run_version<1)throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  }else if(this.operation==='work-plan-admit'){
   const body=command.body;
   if(Object.keys(body).sort().join(',')!=='cycle_id,grant_id,plan_id,preview_sha256'||typeof body.plan_id!=='string'||!/^prd-plan-[a-f0-9]{64}$/.test(body.plan_id)
    ||[body.cycle_id,body.grant_id].some(id=>typeof id!=='string'||!id||id.length>256))throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  }else if(this.operation==='work-plan-prepare'||this.operation==='work-plan-grant'){
   const body=command.body,keys=this.operation==='work-plan-prepare'?'cycle_id,expected_cycle_version,plan_id,preview_sha256':'cycle_id,plan_id,preview_sha256';
   if(Object.keys(body).sort().join(',')!==keys||typeof body.plan_id!=='string'||!/^prd-plan-[a-f0-9]{64}$/.test(body.plan_id)
    ||typeof body.cycle_id!=='string'||!body.cycle_id||body.cycle_id.length>256
    ||this.operation==='work-plan-prepare'&&(!Number.isSafeInteger(body.expected_cycle_version)||body.expected_cycle_version<1))throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  }else if(this.operation==='taskmaster-prd-import'){
   if(Object.keys(command.body).sort().join(',')!=='file_name,preview_sha256'||typeof command.body.file_name!=='string'||!command.body.file_name||command.body.file_name.length>255)throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  }else if(this.operation==='bind'?(JSON.stringify(selection(command.body.source))!==JSON.stringify(command.body.source)||Object.keys(command.body).some(key=>!['source','preview_sha256','num_tasks','append','research'].includes(key))||['append','research'].some(key=>Object.hasOwn(command.body,key)&&typeof command.body[key]!=='boolean')||Object.hasOwn(command.body,'num_tasks')&&(!Number.isSafeInteger(command.body.num_tasks)||command.body.num_tasks<0))
   :Object.keys(command.body).join(',')!=='preview_sha256')throw Error('PRD 原请求回执无效，请保留本站存储以便核对');
  return {command};
 }
 saveCommand(command){if(command===null){this.complete();return;}this.storage.setItem(this.key,JSON.stringify({command}));}
 complete(){this.storage.removeItem(this.key);}
}
export class PrdFlow {
 /** @param {import('./types').Task} task @param {boolean} executionReady @param {(()=>string)|undefined} key @param {PrdCommandStore|null} [store] */
 constructor(task,executionReady,key,store=null){this.task={...task};this.executionReady=executionReady;this.save=new TaskSaveReceipt(key,store);this.sources=null;this.selection=null;this.preview=null;this.receipt=null;this.numTasks=undefined;this.append=false;this.research=false;this.busy=false;this.refreshRequired=false;this.epoch=0;}
 get pending(){return this.save.pending;}
 get ready(){return this.executionReady&&this.task.status==='paused'&&this.sources?.task_id===this.task.task_id&&this.sources?.task_version===this.task.version&&this.sources?.readiness?.ready===true;}
 assertEditable(){if(this.pending)throw Error('请先确认原绑定回执');if(this.busy)throw Error('正在读取预览');}
 invalidate(){this.epoch++;this.selection=null;this.preview=null;this.sources=null;this.refreshRequired=true;}
 setContext(task,executionReady){if(task.task_id!==this.task.task_id||task.version!==this.task.version||task.status!==this.task.status||executionReady!==this.executionReady){if(!this.pending)this.invalidate();}this.task={...task};this.executionReady=executionReady;}
 setSources(data){this.assertEditable();this.sources=data;this.selection=null;this.preview=null;this.refreshRequired=false;this.epoch++;}
 choose(index){this.assertEditable();this.selection=index===''?null:selection(this.sources?.sources[index]);this.preview=null;this.receipt=null;this.epoch++;}
 setTaskCount(value){
  this.assertEditable();const input=value===''?undefined:Number(value),count=input===0?undefined:input;this.preview=null;this.receipt=null;this.epoch++;
  if(count!==undefined&&(!Number.isSafeInteger(count)||count<1))throw Error('INVALID_PRD_TASK_COUNT');this.numTasks=count;
 }
 setAppend(value){this.assertEditable();if(typeof value!=='boolean')throw Error('PRD_PREVIEW_VERSION_CONFLICT');this.append=value;this.preview=null;this.receipt=null;this.epoch++;}
 setResearch(value){this.assertEditable();if(typeof value!=='boolean')throw Error('PRD_PREVIEW_VERSION_CONFLICT');this.research=value;this.preview=null;this.receipt=null;this.epoch++;}
 async loadPreview(request){
  this.assertEditable();if(!this.selection)throw Error('请重新选择来源');if(!this.ready)throw Error('请暂停原任务并等待执行与来源就绪');
  const epoch=this.epoch,source=structuredClone(this.selection),numTasks=this.numTasks,append=this.append,research=this.research;this.busy=true;this.preview=null;
  try{const value=await request(`/persistent-tasks/${encodeURIComponent(this.task.task_id)}/prd/preview`,'POST',{source,...(research?{research:true}:{}),...(append?{append:true}:{}),...(numTasks===undefined?{}:{num_tasks:numTasks})});
   if(epoch!==this.epoch)return;
   if(value.research!==(research?true:undefined)||!appendMatches(value,append)||append&&(!Array.isArray(value.append_source.subtasks)||value.append_source.subtasks.length!==value.append_source.task_count)||value.num_tasks!==numTasks||value.task_id!==this.task.task_id||value.task_version!==this.task.version||value.execution_authorized!==false||JSON.stringify(selection(value.source))!==JSON.stringify(source)||typeof value.content!=='string'||typeof value.objective!=='string'||(value.source_delivery!==undefined&&(value.source_delivery!=='reference'||typeof value.source_instructions!=='string'||!value.source_instructions||value.source_instructions.length>16384))||(value.source_delivery===undefined&&value.source_instructions!==undefined)||!/^[a-f0-9]{64}$/.test(value.preview_sha256))throw Error('PRD_PREVIEW_VERSION_CONFLICT');
   this.preview=value;
  }catch(error){if(rejected(error)||/CONFLICT/.test(error.message))this.invalidate();throw error;}finally{this.busy=false;}
 }
 async bind(request,confirmed){
  if(this.busy)throw Error('正在处理绑定');
  if(!this.pending&&(!confirmed||!this.preview||!this.ready))throw Error('请阅读预览并显式确认绑定原暂停任务');
  this.busy=true;
  const checkedRequest=async(...args)=>{const result=await request(...args),expectedCount=args[2]?.num_tasks===0?undefined:args[2]?.num_tasks;
   if(!result||result.research!==(args[2]?.research===true?true:undefined)||!appendMatches(result,args[2]?.append===true)||result.num_tasks!==expectedCount||result.task_id!==this.task.task_id||typeof result.binding_id!=='string'||!result.binding_id||!Number.isSafeInteger(result.task_version)||!Number.isSafeInteger(result.revision)||result.execution_authorized!==false||!/^[a-f0-9]{64}$/.test(result.content_sha256)||!/^[a-f0-9]{64}$/.test(result.objective_sha256))throw Error('PRD_BIND_RECEIPT_INVALID');
   return result;
  };
  try{const result=await this.save.submit(checkedRequest,`/persistent-tasks/${encodeURIComponent(this.task.task_id)}/prd/bind`,'POST',this.pending?{}:{source:selection(this.preview.source),...(this.preview.research?{research:true}:{}),...(this.preview.append?{append:true}:{}),preview_sha256:this.preview.preview_sha256,...(this.preview.num_tasks===undefined?{}:{num_tasks:this.preview.num_tasks})});this.receipt=result;this.preview=null;return result;}
  catch(error){if(!this.pending&&rejected(error))this.invalidate();throw error;}finally{this.busy=false;}
 }
}

// Capture before parent dialog and navigation handlers. Browser chrome navigation
// is covered by beforeunload; ordinary UI navigation cannot discard an unknown command.
/** @param {Window} target @param {()=>boolean} pending @param {(node:EventTarget|null)=>boolean} inside */
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
