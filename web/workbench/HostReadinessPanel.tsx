import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import React,{useEffect,useRef,useState} from 'react';
import type {HostAdminClient,HostReadinessResponse} from './types';
import {connectHostReadiness,jotCapabilityFacts,readinessNamespace,readinessRequestIsCurrent,workspacePermissionLabel,workspaceWritePermissionLabel} from './host-readiness-ui.mjs';

const reasons=(items:unknown)=>Array.isArray(items)?items.filter((item):item is string=>typeof item==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(item)).join('、')||'宿主未报告':'宿主未报告';
const safeFailureCode=(error:unknown)=>{
 const row=error!==null&&typeof error==='object'?error as Record<string,unknown>:null;
 const code=row?.code??row?.message;
 return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(code)?code:'HOST_READINESS_UNAVAILABLE';
};

export default function HostReadinessPanel({enabled,namespaces,client,jotCapabilities,scopeKey,onReadiness}:{enabled:boolean;namespaces:unknown;client:HostAdminClient;jotCapabilities?:unknown;scopeKey?:string;onReadiness?:(value:HostReadinessResponse|null)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const labels:Record<string,string>={ready:t('就绪','Ready'),starting:t('启动中','Starting'),preparing:t('准备中','Preparing'),disabled:t('已禁用','Disabled'),unavailable:t('不可用','Unavailable'),unverified:t('未验证','Unverified'),enforced:t('已强制执行','Enforced'),failed:t('失败','Failed'),unknown:t('未知','Unknown'),not_configured:t('未配置','Not Configured'),fault:t('故障','Fault'),unsupported:t('不支持','Unsupported')};
 const statusLabel=(value:unknown)=>{const key=String(value);return Object.hasOwn(labels,key)?labels[key]:t('未知','Unknown');};
 const showReasons=(items:unknown)=>{const value=reasons(items);return value==='宿主未报告'?t(value,'Not Reported by Host'):language==='en'?value.replaceAll('、',', '):value;};
 const readPermission=(value:unknown)=>t(workspacePermissionLabel(value),value===true?'Readable':value===false?'Not Readable':'Unknown');
 const writePermission=(value:unknown)=>t(workspaceWritePermissionLabel(value),value===true?'Writable':value===false?'Read-only':'Unknown');

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
  <section lang={language} className="wb-form" aria-labelledby="wb-settings-jot-facts">
   <h3 id="wb-settings-jot-facts">{t('Jot/Gateway 能力事实','Jot/Gateway Capability Facts')}</h3>
   <p className="wb-status">{t("来源：Settings 页已读取的 Gateway capabilities。以下是 Jot/Gateway 应用层事实，与 Host settings.read DTO 分开显示。","Source: Gateway capabilities already read by Settings. These application-layer facts are shown separately from the Host settings.read DTO.")}</p>
   <dl className="wb-settings-facts">
    <div><dt>{t("默认对话模式","Default Conversation Mode")}</dt><dd>{jot.conversation_mode_default==='unknown'?t("未知","Unknown"):jot.conversation_mode_default}{t(" · Gateway 默认值，不代表某个会话当前模式。"," · Gateway default; not the current mode of a particular conversation.")}</dd></div>
    <div><dt>{t("Chat 模式策略","Chat Mode Policy")}</dt><dd>{jot.chat_policy==='available'?t("配置已通过结构校验","Configuration Passed Structural Validation"):jot.chat_policy==='unavailable'?t("配置未就绪","Configuration Not Ready"):t("未知","Unknown")}{t(" · 不代表模型调用健康。"," · Does not indicate model call health.")}</dd></div>
    <div><dt>{t("Work 模式","Work Mode")}</dt><dd>{jot.work_mode_supported===true?t("支持","Supported"):jot.work_mode_supported===false?t("不支持","Unsupported"):t("未知","Unknown")}</dd></div>
    <div><dt>Workbench API</dt><dd>{jot.workbench_api_enabled===true?t("已启用","Enabled"):jot.workbench_api_enabled===false?t("未启用","Not Enabled"):t("未知","Unknown")}</dd></div>
    <div><dt>{t("Gateway file_read/file_edit 声明","Gateway file_read/file_edit Declarations")}</dt><dd>{t("读取","Read: ")}{readPermission(jot.file_read_capability)}{t(" · 写入"," · Write: ")}{jot.file_edit_capability===true?t("可写","Writable"):jot.file_edit_capability===false?t("不可写","Not Writable"):t("未知","Unknown")}{t(" · capability 声明不是 OS 权限检查。"," · Capability declarations are not OS permission checks.")}</dd></div>
    <div><dt>{t("执行配置门槛","Execution Configuration Gate")}</dt><dd>{jot.execution_gate_enabled===true?t("已满足","Met"):jot.execution_gate_enabled===false?t("未满足","Not Met"):t("未知","Unknown")}{t(" · Gateway 配置门槛，不是 Worker 心跳或运行成功。"," · Gateway configuration gate; does not indicate Worker heartbeat or successful execution.")}</dd></div>
    <div><dt>{t("Worker 心跳","Worker Heartbeat")}</dt><dd>{t("未知 · capabilities 不提供通用的在线 Worker 池状态。","Unknown · capabilities do not report general online Worker pool status.")}</dd></div>
    <div><dt>{t("通用 Adapter 生命周期","General Adapter Lifecycle")}</dt><dd>{t("未知 · 当前 owner capabilities 不提供通用 Adapter 生命周期状态。","Unknown · current owner capabilities do not report general Adapter lifecycle status.")}</dd></div>
    <div><dt>{t("语音准备阶段","Voice Preparation")}</dt><dd>{jot.voice.status==='ready'?t("准备就绪","Prepared"):jot.voice.status==='standby'?t("待命","Standby"):jot.voice.status==='preparing'?t("准备中","Preparing"):jot.voice.status==='unavailable'?t("不可用","Unavailable"):t("未知","Unknown")}{t(" · 不是转写测试。"," · Not a transcription test.")}</dd></div>
   </dl>
   <h4>{t("Gateway 工作区应用标志","Gateway Workspace Application Flags")}</h4>
   {jot.workspaces.length?<ul className="wb-settings-list">{jot.workspaces.map(item=><li key={item.workspace_id}><strong>{item.title}</strong><span>{t("Gateway 应用层：读取","Gateway Application Layer: Read ")}{readPermission(item.gateway_can_read)}{t(" · 写入"," · Write: ")}{item.gateway_can_write===true?t("可写","Writable"):item.gateway_can_write===false?t("不可写","Not Writable"):t("未知","Unknown")}</span><span>{t("OS 读取/写入权限：未知","OS Read/Write Permissions: Unknown")}</span></li>)}</ul>:<p className="wb-status">{t("Gateway 工作区应用标志：未知或未配置；OS 读取/写入权限：未知。","Gateway workspace application flags: unknown or not configured; OS read/write permissions: unknown.")}</p>}
  </section>
  <section lang={language} className="wb-form" aria-labelledby="wb-settings-runtime">
  <h3 id="wb-settings-runtime">{t("运行时状态","Runtime Status")}</h3>
  {!enabled?<p className="wb-status">{t("Host readiness capability 未开放；状态未知。","Host readiness capability is unavailable; status is unknown.")}</p>:<>
   {!namespace?<p className="wb-status">{t("Host readiness 不支持：只接受一个安全的 settings.read namespace；当前配置未满足此范围。","Host readiness is unsupported: exactly one safe settings.read namespace is required; the current configuration does not meet this scope.")}</p>:null}
   <div className="wb-actions"><button type="button" disabled={!namespace||loading} onClick={()=>void read()}>{loading?t("正在读取…","Reading…"):t("由宿主授权并读取状态","Authorize with Host and Read Status")}</button>{approved?<span className="wb-status">{t("本次读取已获宿主授权","The Host Authorized This Read")}</span>:null}</div>
   {error?<p className="wb-error" role="alert">{t(`读取宿主状态失败。（${error}）`,`Reading Host status failed. (${error})`)}</p>:null}
   {!data?<p className="wb-status">{t("Host、Worker、运行模式和权限状态：未知。未从配置、目录或 capability 推导就绪状态。","Host, Worker, mode and permission status: unknown. Readiness is not inferred from configuration, directories or capabilities.")}</p>:<>
    <p className="wb-status">{t("只读范围：","Read-only Scope: ")}{data.scope?.namespace??t("未知","Unknown")}{t(" · 设置源状态："," · Settings Source Status: ")}{statusLabel(data.scope?.state)}{t(" · 版本 "," · Revision ")}{data.scope?.revision??t("未知","Unknown")}{t("。整体 readiness：",". Overall Readiness: ")}{statusLabel(data.state)}{t('。','.')}</p>
    <dl className="wb-settings-facts">
     <div><dt>Host</dt><dd>{statusLabel(data.host?.state)} · {showReasons(data.host?.reason_codes)}</dd></div>
     <div><dt>Worker</dt><dd>{statusLabel(data.worker?.state)} · {showReasons(data.worker?.reason_codes)}</dd></div>
     <div><dt>{t("默认对话模式","Default Conversation Mode")}</dt><dd>{data.mode?.default_conversation??t("未知","Unknown")} · {statusLabel(data.mode?.state)} · {showReasons(data.mode?.reason_codes)}</dd></div>
     <div><dt>{t("语音","Voice")}</dt><dd>{statusLabel(data.voice?.state)} · {showReasons(data.voice?.reason_codes)}</dd></div>
     <div><dt>{t("浏览器策略","Browser Policy")}</dt><dd>{statusLabel(data.network_policy?.browser?.state)} · {showReasons(data.network_policy?.browser?.reason_codes)}</dd></div>
     <div><dt>{t("MCP 策略","MCP Policy")}</dt><dd>{statusLabel(data.network_policy?.mcp?.state)} · {showReasons(data.network_policy?.mcp?.reason_codes)}</dd></div>
    </dl>
    <h4>{t("默认模型选择","Default Model Selection")}</h4>
    {data.providers?.length?data.providers.map((provider,index)=><p className="wb-status" key={`${provider.provider_id??'unknown'}:${index}`}>
     {provider.provider_id??t("提供方未知","Unknown Provider")}{provider.selected_model_id?` · ${provider.selected_model_id}`:''}{t('：',': ')}{statusLabel(provider.state)} · {showReasons(provider.reason_codes)}{t(" · 模型调用未测试；凭据引用状态未知"," · Model calls untested; credential reference status unknown")}
    </p>):<p className="wb-status">{t("提供方选择：未知。","Provider selection: unknown.")}</p>}
    <h4>{t("工作区权限","Workspace Permissions")}</h4>
    {data.workspace?.items?.length?<ul className="wb-settings-list">{data.workspace.items.map((item,index)=><li key={`${item.workspace_id??'unknown'}:${index}`}><strong>{item.title??t("工作区未知","Unknown Workspace")}</strong><span>{readPermission(item.can_read)} · {writePermission(item.can_write)}</span></li>)}</ul>:<p className="wb-status">{t("工作区及读取/写入权限：","Workspace and Read/Write Permissions: ")}{showReasons(data.workspace?.reason_codes)}{t('。','.')}</p>}
    {data.plugins?.length>0?<p className="wb-status">{t("插件：","Plugins: ")}{data.plugins.map((plugin,index)=>`${plugin.plugin_id??t("未知","Unknown")} ${statusLabel(plugin.state)}${t('（',' (')}${showReasons(plugin.reason_codes)}${t('）',')')}${index<data.plugins.length-1?t('；','; '):''}`)}</p>:null}
   </>}
  </>}
 </section>
 </>;
}
