const statuses=['pending','running','blocked','completed','failed','cancelled'];
const knownStatus=new Set(statuses);
const messages={
 version_conflict:'子任务已被更新；请核对最新账本后再保存。',
 invalid_dependencies:'请选择仍存在且不包含自身的前置任务。',
 dependency_cycle:'前置任务不能形成循环。',
 dependency_not_completed:'请先完成并核验所有前置任务。',
 dependency_evidence_unverified:'前置任务缺少已核验的完成证据。',
 evidence_required:'标记完成前需要已有的执行证据。',
 invalid_subtask_status:'新建子任务必须从待执行开始。',
 invalid_subtask_title:'请填写不超过 200 个字符的子任务标题。',
 invalid_acceptance:'请填写不超过 2000 个字符的验收条件。',
 invalid_priority:'优先级必须是 0 到 100 的整数。',
};

export function taskSubtaskCounts(items){
 const rows=Array.isArray(items)?items:[],counts={total:rows.length,pending:0,running:0,blocked:0,completed:0,failed:0,cancelled:0,other:0};
 for(const item of rows){const status=item?.status;if(knownStatus.has(status))counts[status]++;else counts.other++;}
 return counts;
}

export function buildTaskSubtaskInput(existing,draft){
 const title=typeof draft?.title==='string'?draft.title.trim():'';
 const acceptance=typeof draft?.acceptance==='string'?draft.acceptance.trim():'';
 if(!title||title.length>200)throw new Error('invalid_subtask_title');
 if(!acceptance||acceptance.length>2000)throw new Error('invalid_acceptance');
 const priorityText=String(draft.priority??'').trim();
 if(!/^\d+$/.test(priorityText))throw new Error('invalid_priority');
 const priority=Number(priorityText);if(!Number.isSafeInteger(priority)||priority<0||priority>100)throw new Error('invalid_priority');
 const status=draft?.status??existing?.status??'pending';
 if(!knownStatus.has(status)||(!existing&&status!=='pending'))throw new Error('invalid_subtask_status');
 if(status==='completed'&&!(Array.isArray(existing?.evidence)&&existing.evidence.length))throw new Error('evidence_required');
 if(!Array.isArray(draft.dependencies)||draft.dependencies.length>50||draft.dependencies.some(id=>typeof id!=='string'||!id.trim()))throw new Error('invalid_dependencies');
 const dependencies=[...new Set(draft.dependencies.map(id=>id.trim()))];
 if(existing&&dependencies.includes(existing.subtask_id))throw new Error('不能依赖自身');
 if(existing&&(!existing.subtask_id||!Number.isSafeInteger(existing.version)||existing.version<1))throw new Error('invalid_subtask_version');
 return {...(existing?{subtask_id:existing.subtask_id,expected_version:existing.version}:{}),title,acceptance,priority,status,dependencies};
}

export function taskLedgerError(error){
 const code=String(error?.message??'').toLowerCase();
 return messages[code]??'子任务账本未保存，请检查输入并重试。';
}

export function taskSubtaskFailure(error,submitted){
 const status=Number.isSafeInteger(error?.status)?Number(error.status):null;
 const known=!submitted||(status!==null&&status>=400&&status<500);
 return {message:known?taskLedgerError(error):'保存结果尚未确认。账本已刷新，请先核对列表，避免重复提交。',uncertain:submitted&&!known,refresh:submitted};
}
