import React,{useEffect,useRef,useState} from 'react';
import type {HostAdminClient,HostReadinessResponse} from './types';
import {connectHostReadiness,jotCapabilityFacts,readinessNamespace,readinessRequestIsCurrent,workspacePermissionLabel,workspaceWritePermissionLabel} from './host-readiness-ui.mjs';

const labels:Record<string,string>={
 ready:'就绪',starting:'启动中',preparing:'准备中',disabled:'已禁用',unavailable:'不可用',unverified:'未验证',
 enforced:'已强制执行',failed:'失败',unknown:'未知',not_configured:'未配置',fault:'故障',unsupported:'不支持'
};
const statusLabel=(value:unknown)=>{const key=String(value);return Object.prototype.hasOwnProperty.call(labels,key)?labels[key]:'未知';};
const reasons=(items:unknown)=>Array.isArray(items)?items.filter((item):item is string=>typeof item==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(item)).join('、')||'宿主未报告':'宿主未报告';
const safeFailureCode=(error:unknown)=>{
 const row=error!==null&&typeof error==='object'?error as Record<string,unknown>:null;
 const code=row?.code??row?.message;
 return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(code)?code:'HOST_READINESS_UNAVAILABLE';
};

export default function HostReadinessPanel({enabled,namespaces,client,jotCapabilities,scopeKey,onReadiness}:{enabled:boolean;namespaces:unknown;client:HostAdminClient;jotCapabilities?:unknown;scopeKey?:string;onReadiness?:(value:HostReadinessResponse|null)=>void}){
 const namespace=readinessNamespace(namespaces);
 const jot=jotCapabilityFacts(jotCapabilities);
 const contextRef=useRef({enabled,namespace,client,scopeKey});contextRef.current={enabled,namespace,client,scopeKey};
 const requestSequence=useRef(0);
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[data,setData]=useState<HostReadinessResponse|null>(null),[approved,setApproved]=useState(false);
 useEffect(()=>{
  requestSequence.current+=1;setLoading(false);setError('');setData(null);setApproved(false);onReadiness?.(null);
  return()=>{requestSequence.current+=1;};
 },[enabled,namespace,client,scopeKey,onReadiness]);
 const read=async()=>{
  if(!enabled||!namespace||loading)return;
  const sequence=++requestSequence.current,request={enabled,namespace,client,scopeKey};
  const isCurrent=()=>requestSequence.current===sequence&&readinessRequestIsCurrent(request,contextRef.current);
  setLoading(true);setError('');setData(null);setApproved(false);onReadiness?.(null);
  try{
   const snapshot=await connectHostReadiness({client,namespace,onReadiness:(value:HostReadinessResponse|null)=>{if(isCurrent())onReadiness?.(value);}});
   if(!isCurrent())return;
   setData(snapshot);setApproved(true);
  }catch(reason){
   if(!isCurrent())return;
   // Any denial ends the local approval view; the next attempt repeats owner approval.
   setApproved(false);setData(null);setError(safeFailureCode(reason));
  }finally{if(isCurrent())setLoading(false);}
 };

 return <>
  <section className="wb-form" aria-labelledby="wb-settings-jot-facts">
   <h3 id="wb-settings-jot-facts">Jot/Gateway capability facts</h3>
   <p className="wb-status">来源：Settings 页已读取的 Gateway capabilities。以下是 Jot/Gateway 应用层事实，与 Host settings.read DTO 分开显示。</p>
   <dl className="wb-settings-facts">
    <div><dt>默认对话模式</dt><dd>{jot.conversation_mode_default==='unknown'?'未知':jot.conversation_mode_default} · Gateway 默认值，不代表某个会话当前模式。</dd></div>
    <div><dt>Chat 模式策略</dt><dd>{jot.chat_policy==='available'?'配置已通过结构校验':jot.chat_policy==='unavailable'?'配置未就绪':'未知'} · 不代表模型调用健康。</dd></div>
    <div><dt>Work 模式</dt><dd>{jot.work_mode_supported===true?'支持':jot.work_mode_supported===false?'不支持':'未知'}</dd></div>
    <div><dt>Workbench API</dt><dd>{jot.workbench_api_enabled===true?'已启用':jot.workbench_api_enabled===false?'未启用':'未知'}</dd></div>
    <div><dt>Gateway file_read/file_edit 声明</dt><dd>读取{workspacePermissionLabel(jot.file_read_capability)} · 写入{jot.file_edit_capability===true?'可写':jot.file_edit_capability===false?'不可写':'未知'} · capability 声明不是 OS 权限检查。</dd></div>
    <div><dt>执行配置门槛</dt><dd>{jot.execution_gate_enabled===true?'已满足':jot.execution_gate_enabled===false?'未满足':'未知'} · Gateway 配置门槛，不是 Worker 心跳或运行成功。</dd></div>
    <div><dt>Worker 心跳</dt><dd>未知 · capabilities 不提供通用的在线 Worker 池状态。</dd></div>
    <div><dt>通用 Adapter 生命周期</dt><dd>未知 · 当前 owner capabilities 不提供通用 Adapter 生命周期状态。</dd></div>
    <div><dt>语音准备阶段</dt><dd>{jot.voice.status==='ready'?'准备就绪':jot.voice.status==='standby'?'待命':jot.voice.status==='preparing'?'准备中':jot.voice.status==='unavailable'?'不可用':'未知'} · 不是转写测试。</dd></div>
   </dl>
   <h4>Gateway 工作区应用标志</h4>
   {jot.workspaces.length?<ul className="wb-settings-list">{jot.workspaces.map(item=><li key={item.workspace_id}><strong>{item.title}</strong><span>Gateway 应用层：读取{workspacePermissionLabel(item.gateway_can_read)} · 写入{item.gateway_can_write===true?'可写':item.gateway_can_write===false?'不可写':'未知'}</span><span>OS 读取/写入权限：未知</span></li>)}</ul>:<p className="wb-status">Gateway 工作区应用标志：未知或未配置；OS 读取/写入权限：未知。</p>}
  </section>
  <section className="wb-form" aria-labelledby="wb-settings-runtime">
  <h3 id="wb-settings-runtime">运行时状态</h3>
  {!enabled?<p className="wb-status">Host readiness capability 未开放；状态未知。</p>:<>
   {!namespace?<p className="wb-status">Host readiness 不支持：只接受一个安全的 settings.read namespace；当前配置未满足此范围。</p>:null}
   <div className="wb-actions"><button type="button" disabled={!namespace||loading} onClick={()=>void read()}>{loading?'正在读取…':'由宿主授权并读取状态'}</button>{approved?<span className="wb-status">本次读取已获宿主授权</span>:null}</div>
   {error?<p className="wb-error" role="alert">读取宿主状态失败。（{error}）</p>:null}
   {!data?<p className="wb-status">Host、Worker、运行模式和权限状态：未知。未从配置、目录或 capability 推导就绪状态。</p>:<>
    <p className="wb-status">只读范围：{data.scope?.namespace??'未知'} · 设置源状态：{statusLabel(data.scope?.state)} · 版本 {data.scope?.revision??'未知'}。整体 readiness：{statusLabel(data.state)}。</p>
    <dl className="wb-settings-facts">
     <div><dt>Host</dt><dd>{statusLabel(data.host?.state)} · {reasons(data.host?.reason_codes)}</dd></div>
     <div><dt>Worker</dt><dd>{statusLabel(data.worker?.state)} · {reasons(data.worker?.reason_codes)}</dd></div>
     <div><dt>默认对话模式</dt><dd>{data.mode?.default_conversation??'未知'} · {statusLabel(data.mode?.state)} · {reasons(data.mode?.reason_codes)}</dd></div>
     <div><dt>语音</dt><dd>{statusLabel(data.voice?.state)} · {reasons(data.voice?.reason_codes)}</dd></div>
     <div><dt>浏览器策略</dt><dd>{statusLabel(data.network_policy?.browser?.state)} · {reasons(data.network_policy?.browser?.reason_codes)}</dd></div>
     <div><dt>MCP 策略</dt><dd>{statusLabel(data.network_policy?.mcp?.state)} · {reasons(data.network_policy?.mcp?.reason_codes)}</dd></div>
    </dl>
    <h4>默认模型选择</h4>
    {data.providers?.length?data.providers.map((provider,index)=><p className="wb-status" key={`${provider.provider_id??'unknown'}:${index}`}>
     {provider.provider_id??'提供方未知'}{provider.selected_model_id?` · ${provider.selected_model_id}`:''}：{statusLabel(provider.state)} · {reasons(provider.reason_codes)} · 模型调用未测试；凭据引用状态未知
    </p>):<p className="wb-status">提供方选择：未知。</p>}
    <h4>工作区权限</h4>
    {data.workspace?.items?.length?<ul className="wb-settings-list">{data.workspace.items.map((item,index)=><li key={`${item.workspace_id??'unknown'}:${index}`}><strong>{item.title??'工作区未知'}</strong><span>{workspacePermissionLabel(item.can_read)} · {workspaceWritePermissionLabel(item.can_write)}</span></li>)}</ul>:<p className="wb-status">工作区及读取/写入权限：{reasons(data.workspace?.reason_codes)}。</p>}
    {data.plugins?.length>0?<p className="wb-status">插件：{data.plugins.map((plugin,index)=>`${plugin.plugin_id??'未知'} ${statusLabel(plugin.state)}（${reasons(plugin.reason_codes)}）${index<data.plugins.length-1?'；':''}`)}</p>:null}
   </>}
  </>}
 </section>
 </>;
}
