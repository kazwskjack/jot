const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const milliseconds=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const amount=value=>typeof value==='string'&&/^\d{1,40}$/.test(value)?value:null;
const phases={session_confirm:'确认会话',opening_snapshot:'读取会话',attachments:'准备附件',prompt_submit:'提交输入',input_recovery:'恢复原输入',goal_resume:'恢复目标',preparation_total:'准备合计'};
const outcomes={succeeded:'已完成',failed:'失败',cancelled:'已取消'};
const states={reserved:'待派发',in_flight:'进行中',settled:'已结算',released:'已释放',unknown:'结果待确认',rejected:'已拒绝'};
const usageFields=['input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','total_tokens'];

/** UI-only allowlist of the existing DTO. Missing evidence stays missing. */
export function diagnosticView(raw,runId){
 if(!object(raw)||raw.run_id!==runId)throw Error('诊断目标尚未确认');
 if(raw.schema_version!==1||!object(raw.preparation)||!Array.isArray(raw.preparation.phases)||!Array.isArray(raw.attempts)||raw.attempts.length>1000)throw Error('运行诊断格式尚未确认');
 /** @type {{ordinal:number|null,state:string,ttft_ms:number|null,generation_ms:number|null,usage:Record<string,string|null>,usage_status:'available'|'partial'|'not_metered'|'unknown',cost:string|null,manual_intervention_required:boolean}[]} */
 const calls=raw.attempts.map(row=>{
  if(!object(row))throw Error('运行诊断格式尚未确认');
  const usage=object(row.usage)?row.usage:{};
  return {ordinal:Number.isSafeInteger(row.retry_index)&&row.retry_index>=0?row.retry_index+1:null,
   state:Object.hasOwn(states,row.state)?states[row.state]:'状态未确认',ttft_ms:milliseconds(row.ttft_ms),generation_ms:milliseconds(row.generation_ms),
   usage:Object.fromEntries(usageFields.map(field=>[field,amount(usage[field])])),
   usage_status:['available','partial','not_metered','unknown'].includes(row.usage_status)?row.usage_status:'unknown',
   cost:object(row.cost)&&row.cost.basis==='configured_rates'?amount(row.cost.nano_usd):null,
   manual_intervention_required:row.unknown===true||row.state==='unknown'||row.manual_intervention_required===true};
 });
 return {queue_ms:milliseconds(raw.queue_ms),preparation_ms:milliseconds(raw.preparation.total_ms),
  phases:raw.preparation.phases.slice(0,128).filter(row=>object(row)&&Object.hasOwn(phases,row.phase)).map(row=>({label:phases[row.phase],duration_ms:milliseconds(row.duration_ms),outcome:Object.hasOwn(outcomes,row.outcome)?outcomes[row.outcome]:'结果未确认'})),
  calls,dispatched_calls:calls.filter(call=>call.ordinal!==null).length,
  // The current DTO's retry_index/count are dispatch ordinals, with no retry lineage.
  retry_status:'unknown',manual_intervention_required:raw.manual_intervention_required===true||calls.some(call=>call.manual_intervention_required),
  partial:raw.partial===true||raw.preparation.phases.length>128||(Array.isArray(raw.missing)&&raw.missing.length>0)};
}

/** Use the existing run-owner fences; refresh the opaque owner scope before display. */
export async function loadRunDiagnostics(request,readScope,run,signal){
 const scope=readScope();
 const current=()=>{signal.throwIfAborted();if(!/^[a-f0-9]{64}$/.test(scope??'')||readScope()!==scope)throw Error('用户范围尚未确认，请重新打开对话');};
 current();
 const path=`/runs/${encodeURIComponent(run.run_id)}`;
 const original=await request(path,'GET',undefined,undefined,signal);current();
 if(original?.run_id!==run.run_id||original?.conversation_id!==run.conversation_id)throw Error('诊断目标尚未确认');
 const report=await request(`${path}/diagnostics`,'GET',undefined,undefined,signal);current();
 await request('/capabilities','GET',undefined,undefined,signal);current();
 return diagnosticView(report,run.run_id);
}
