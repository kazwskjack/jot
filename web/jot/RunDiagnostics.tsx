import React,{useState} from 'react';
import {request,taskDraftScope} from './client';
import {useResource} from '../workbench/useResource';
import {diagnosticView,loadRunDiagnostics} from './run-diagnostics.mjs';
import type {Run} from './types';
type View=ReturnType<typeof diagnosticView>;
const ms=(value:number|null)=>value===null?'未记录':`${value} ms`;
const usageStatuses={available:'已记录',partial:'部分记录',not_metered:'未计量',unknown:'未确认'} as const;
function cost(value:string|null){if(value===null)return '未记录';const n=BigInt(value);return `$${n/1000000000n}.${String(n%1000000000n).padStart(9,'0')}`;}
export function RuntimeDiagnosticFacts({view}:{view:View}){
 return <div className="jot-runtime-diagnostic-facts">
  <dl><dt>排队</dt><dd>{ms(view.queue_ms)}</dd><dt>准备</dt><dd>{ms(view.preparation_ms)}</dd><dt>已派发模型调用</dt><dd>{view.dispatched_calls}</dd><dt>重试次数</dt><dd>未确认</dd></dl>
  {view.phases.length>0&&<ul>{view.phases.map((phase:any,index:number)=><li key={index}>{phase.label}：{ms(phase.duration_ms)} · {phase.outcome}</li>)}</ul>}
  {view.calls.map((call,index:number)=><section key={index} aria-label={`模型调用 ${index+1}`}><h4>{call.ordinal===null?'待确认调用':`调用 ${call.ordinal}`} · {call.state}</h4>
   <dl><dt>首段正文到达</dt><dd>{ms(call.ttft_ms)}</dd><dt>派发至回答结束</dt><dd>{ms(call.generation_ms)}</dd>
    {([['input_tokens','输入 token'],['output_tokens','输出 token'],['cache_read_tokens','Cache 读取 token'],['cache_write_tokens','Cache 写入 token'],['total_tokens','总 token']] as const).map(([key,label])=><React.Fragment key={key}><dt>{label}</dt><dd>{call.usage[key]??'未记录'}</dd></React.Fragment>)}
    <dt>用量状态</dt><dd>{usageStatuses[call.usage_status]}</dd>
    <dt>配置费率估算</dt><dd>{cost(call.cost)}</dd></dl>
   {call.usage_status==='not_metered'&&<p>此调用未按 token 计量。</p>}
  </section>)}
  {!view.calls.length&&<p>尚无模型调用记录。</p>}
  {view.manual_intervention_required&&<p role="status">有调用结果尚未确认，需要复核。</p>}
  {view.partial&&<p>部分诊断尚未记录或超出读取范围。</p>}
  <small>时序来自 Gateway 已记录的事件；首段正文到达包含投影缓冲时间。费用按配置费率估算。</small>
 </div>;
}
export default function RunDiagnostics({run}:{run:Pick<Run,'run_id'|'conversation_id'>}){
 const [open,setOpen]=useState(false),scope=taskDraftScope();
 const resource=useResource<View>(signal=>loadRunDiagnostics(request,taskDraftScope,run,signal),`${run.conversation_id}:${run.run_id}:${scope}`,open);
 return <details className="jot-runtime-diagnostics" onToggle={event=>setOpen(event.currentTarget.open)}><summary>运行诊断</summary>
  <button type="button" disabled={resource.loading} onClick={resource.reload}>刷新诊断</button>
  {resource.loading&&<p role="status">正在读取运行诊断…</p>}
  {resource.error&&<p role="alert">运行诊断暂不可用，请重试或重新打开对话。</p>}
  {!resource.loading&&!resource.error&&resource.data&&<RuntimeDiagnosticFacts view={resource.data}/>}
 </details>;
}
