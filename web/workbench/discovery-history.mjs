const runs={queued:'等待执行',starting:'正在启动',running:'正在执行',waiting_user:'等待补充',waiting_approval:'等待确认',cancelling:'正在取消',succeeded:'执行已结束',partial:'部分执行',failed:'执行失败',cancelled:'已取消',interrupted:'执行已中断',outcome_unknown:'执行结果待核对'};
const business={...runs,waiting_review:'等待审核',waiting_evidence:'等待证据',evidence_recorded:'已记录证据',input_requested:'需要补充',approval_requested:'需要确认',acceptance_confirmed:'业务审核已确认',acceptance_rejected:'验收未通过',completed:'业务流程已结束'};
business.waiting_approval='等待审核';
export function discoveryCyclePresentation(cycle){return {run:runs[cycle?.run?.status]??'执行状态待核对',business:business[cycle?.run?.business_state]??'业务状态待核对',acceptance:cycle?.accepted===true?'原验收已完成':'尚未验收'};}
export function discoveryDetailMatches(value,admissionId){return !!value&&value.execution_authorized===false&&value.cycle?.admission_id===admissionId&&Array.isArray(value.plans);}
export function discoveryCoverage(value){return value&&Number.isSafeInteger(value.signal_count)&&Number.isSafeInteger(value.fully_read)&&value.signal_count>=0&&value.fully_read>=0&&value.fully_read<=value.signal_count?`完整读取 ${value.fully_read} / ${value.signal_count} 条来源`:'来源覆盖待核对';}
