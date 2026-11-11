import {useApplicationLanguage,useApplicationText} from './application-language';
import React,{useState} from 'react';
import {request,taskDraftScope} from './client';
import {useResource} from '../workbench/useResource';
import {diagnosticView,loadRunDiagnostics} from './run-diagnostics.mjs';
import type {Run} from './types';
type View=ReturnType<typeof diagnosticView>;
const ms=(value:number|null)=>value===null?'未记录':`${value} ms`;
const usageStatuses={available:'已记录',partial:'部分记录',not_metered:'未计量',unknown:'未确认'} as const;
function cost(value:string|null){if(value===null)return '未记录';const n=BigInt(value);return `$${n/1000000000n}.${String(n%1000000000n).padStart(9,'0')}`;}
const englishLabels:Record<string,string>={
  "未记录": "Not Recorded",
  "已记录": "Recorded",
  "部分记录": "Partially Recorded",
  "未计量": "Not Metered",
  "未确认": "Unconfirmed",
  "确认会话": "Confirm Session",
  "读取会话": "Read Session",
  "准备附件": "Prepare Attachments",
  "提交输入": "Submit Input",
  "恢复原输入": "Recover Original Input",
  "恢复目标": "Resume Goal",
  "准备合计": "Preparation Total",
  "已完成": "Completed",
  "失败": "Failed",
  "已取消": "Cancelled",
  "待派发": "Awaiting Dispatch",
  "进行中": "In Progress",
  "已结算": "Settled",
  "已释放": "Released",
  "结果待确认": "Result Unconfirmed",
  "已拒绝": "Rejected",
  "状态未确认": "State Unconfirmed",
  "结果未确认": "Result Unconfirmed",
  "数据库": "Database",
  "数据结构": "Schema",
  "原生运行时": "Native Runtime",
  "执行消费者": "Execution Consumer",
  "执行策略": "Execution Policy",
  "存储": "Storage",
  "浏览器驱动": "Browser Driver",
  "就绪": "Ready",
  "已停用": "Disabled",
  "待确认": "Unconfirmed",
  "故障": "Fault",
  "输入 token": "Input Tokens",
  "输出 token": "Output Tokens",
  "Cache 读取 token": "Cache Read Tokens",
  "Cache 写入 token": "Cache Write Tokens",
  "总 token": "Total Tokens"
};
export function RuntimeDiagnosticFacts({view}:{view:View}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const caption=(value:string)=>language==='en'&&Object.hasOwn(englishLabels,value)?englishLabels[value]!:value;
 return <div lang={language} className="jot-runtime-diagnostic-facts">
  <section aria-label={t('运行依赖状态','Runtime Dependency Status')}><h4>{t("运行依赖状态","Runtime Dependency Status")}</h4>
   {view.runtime_readiness?<>
    <p>{t('采集于 ','Collected at ')}<time dateTime={view.runtime_readiness.collected_at}>{view.runtime_readiness.collected_at}</time>{view.runtime_readiness.stale?t(' · 记录已过期',' · Record Stale'):''}</p>
    <ul>{view.runtime_readiness.components.map(component=><li key={component.component}>{caption(component.label)} · {caption(component.status)}{component.reason&&<> · <code>{component.reason}</code></>}</li>)}</ul>
    <small>{t("记录对应本次运行的采集时刻。执行仍需通过当前权限、预算和租约检查。","These records reflect the collection time for this run. Execution still requires current permission, budget and lease checks.")}</small>
   </>:<p>{t("尚无组件就绪记录。","No component readiness record is available yet.")}</p>}
  </section>
  <dl><dt>{t("排队","Queue")}</dt><dd>{caption(ms(view.queue_ms))}</dd><dt>{t("准备","Preparation")}</dt><dd>{caption(ms(view.preparation_ms))}</dd><dt>{t("已派发模型调用","Dispatched Model Calls")}</dt><dd>{view.dispatched_calls}</dd><dt>{t("重试次数","Retry Count")}</dt><dd>{t("未确认","Unconfirmed")}</dd></dl>
  {view.phases.length>0&&<ul>{view.phases.map((phase:any,index:number)=><li key={index}>{caption(phase.label)}{t('：',': ')}{caption(ms(phase.duration_ms))} · {caption(phase.outcome)}</li>)}</ul>}
  {view.calls.map((call,index:number)=><section key={index} aria-label={t(`模型调用 ${index+1}`,`Model Call ${index+1}`)}><h4>{call.ordinal===null?t('待确认调用','Unconfirmed Call'):t(`调用 ${call.ordinal}`,`Call ${call.ordinal}`)} · {caption(call.state)}</h4>
   <dl><dt>{t("首段正文到达","First Body Content Arrival")}</dt><dd>{caption(ms(call.ttft_ms))}</dd><dt>{t("派发至回答结束","Dispatch to Answer Completion")}</dt><dd>{caption(ms(call.generation_ms))}</dd>
    {([['input_tokens','输入 token'],['output_tokens','输出 token'],['cache_read_tokens','Cache 读取 token'],['cache_write_tokens','Cache 写入 token'],['total_tokens','总 token']] as const).map(([key,label])=><React.Fragment key={key}><dt>{t(label,englishLabels[label]??label)}</dt><dd>{call.usage[key]??t('未记录','Not Recorded')}</dd></React.Fragment>)}
    <dt>{t("用量状态","Usage Status")}</dt><dd>{caption(usageStatuses[call.usage_status])}</dd>
    <dt>{t("配置费率估算","Estimate at Configured Rates")}</dt><dd>{caption(cost(call.cost))}</dd></dl>
   {call.usage_status==='not_metered'&&<p>{t("此调用未按 token 计量。","This call was not metered by tokens.")}</p>}
  </section>)}
  {!view.calls.length&&<p>{t("尚无模型调用记录。","No model call record is available yet.")}</p>}
  {view.manual_intervention_required&&<p role="status">{t("有调用结果尚未确认，需要复核。","A call result is unconfirmed and requires review.")}</p>}
  {view.partial&&<p>{t("部分诊断尚未记录或超出读取范围。","Some diagnostics are unrecorded or beyond the read scope.")}</p>}
  <small>{t("时序来自 Gateway 已记录的事件；首段正文到达包含投影缓冲时间。费用按配置费率估算。","Timing comes from events recorded by the Gateway; first body content arrival includes projection buffering. Costs are estimated using configured rates.")}</small>
 </div>;
}
export default function RunDiagnostics({run}:{run:Pick<Run,'run_id'|'conversation_id'>}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [open,setOpen]=useState(false),scope=taskDraftScope();
 const resource=useResource<View>(signal=>loadRunDiagnostics(request,taskDraftScope,run,signal),`${run.conversation_id}:${run.run_id}:${scope}`,open);
 return <details lang={language} className="jot-runtime-diagnostics" onToggle={event=>setOpen(event.currentTarget.open)}><summary>{t("运行诊断","Run Diagnostics")}</summary>
  <button type="button" disabled={resource.loading} onClick={resource.reload}>{t("刷新诊断","Refresh Diagnostics")}</button>
  {resource.loading&&<p role="status">{t("正在读取运行诊断…","Reading Run Diagnostics…")}</p>}
  {resource.error&&<p role="alert">{t("运行诊断暂不可用，请重试或重新打开对话。","Run diagnostics are unavailable. Retry or reopen the conversation.")}</p>}
  {!resource.loading&&!resource.error&&resource.data&&<RuntimeDiagnosticFacts view={resource.data}/>}
 </details>;
}
