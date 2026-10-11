const integer=value=>{
 if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||BigInt(value)>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('请填写有效的非负整数');
 return Number(value);
};
export function dollarsToNano(value){
 if(typeof value!=='string'||!/^(0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value))throw new Error('美元费用最多保留 9 位小数');
 const [whole,fraction='']=value.split('.'),nano=BigInt(whole)*1000000000n+BigInt(fraction.padEnd(9,'0'));
 if(nano>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('费用超过可设置范围');return Number(nano);
}
export function nanoToDollars(value){
 const nano=BigInt(value),whole=nano/1000000000n,fraction=String(nano%1000000000n).padStart(9,'0').replace(/0+$/,'');
 return `${whole}${fraction?'.'+fraction:''}`;
}
export function budgetLimitInput(value){return {tokens:integer(value.tokens),nano_usd:dollarsToNano(value.dollars),model_calls:integer(value.model_calls)};}
export function budgetReason(reason){
 if(reason==='usage_unknown')return '上次模型用量尚待确认，预留额度继续保留';
 const [scope,field]=reason.split(':'),names={task_total:'任务',owner_daily:'每日总',project_daily:'项目每日',agent_daily:'角色每日',occurrence:'单次执行'};
 const dimensions={tokens:'Token 额度',nano_usd:'费用额度',model_calls:'模型调用次数'};
 return names[scope]&&dimensions[field]?`${names[scope]}${dimensions[field]}不足以预留下一次调用`:'暂时不能继续调用模型，请检查任务状态';
}
export function budgetError(code){
 return ({BUDGET_LIMIT_BELOW_COMMITMENT:'上限不能低于已消耗与预留的总量，请先处理当前运行。',BUDGET_CEILING_EXCEEDED:'设置超过服务器允许的上限。',BUDGET_LIMIT_VERSION_CONFLICT:'额度已被更新，请取消编辑，刷新预算后重新设置。',BUDGET_POLICY_STALE:'服务器配置已更新，请稍后刷新重试。',BUDGET_SERVICE_UNAVAILABLE:'服务器尚未启用模型预算。',MODEL_BUDGET_EXHAUSTED:'模型预算不足，请查看额度与消耗。',BUDGET_USAGE_UNKNOWN:'上次模型用量尚待确认，暂时不能开始新的执行。'})[code]??'预算操作未完成，请检查填写内容或刷新重试。';
}
