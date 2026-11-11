import React,{useCallback,useContext,useEffect,useRef,useState} from 'react';
import type {Caps,HostAdminClient,HostOnboardingSnapshot,HostReadinessResponse,HostSettingsSnapshot,HostSettingsUpdate,HostSettingsValues} from './types';
import {taskDraftScope} from '../jot/client';
import {createHostSettingsSaveAttempt,hostSettingsSaveCommand} from './host-settings-save-attempt.mjs';
import {createHostSettingsRecovery} from './host-settings-recovery.mjs';
import {useLayoutDisplayPreferences,useMessageDisplayPreferences,useToolDisplayPreference} from '../jot/useToolDisplayPreference';
import HostCredentialsPanel from './HostCredentialsPanel';
import PluginProfilesPanel from './PluginProfilesPanel';
import HostReadinessPanel from './HostReadinessPanel';
import HostSettingsPanel from './HostSettingsPanel';
import HostSettingsReadPanel from './HostSettingsReadPanel';
import OnboardingPanel from './OnboardingPanel';
import {MutationPending} from './useMutationReceipt';
import {
 hostCapabilityEnabled,initialHostSettingsState,hostSettingsReloadStarted,hostSettingsReloadSucceeded,hostSettingsReloadFailed,hostSettingsDraftChanged,hostSettingsUseServerSnapshot,hostSettingsSaveStarted,hostSettingsSaveConflict,hostSettingsSaveFailed,hostSettingsSaveSucceeded,
 hostSettingsSaveUnknownPending,hostSettingsWriteCandidateSaved,
 initialOnboardingState,onboardingHostSettingsDraft,onboardingReloadStarted,onboardingReloadSucceeded,onboardingReloadFailed,onboardingDraftChanged,onboardingUseServerSnapshot,onboardingSaveStarted,onboardingSaveConflict,onboardingSaveFailed,onboardingSaveSucceeded,
} from './host-setup-state.mjs';

type Resource<T>={data:T|null;loading:boolean;error:string};
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const safeCode=(value:unknown)=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value)?value:null;
function failureCode(error:unknown){const row=record(error);return safeCode(row?.code)??'host_unavailable';}
function httpStatus(error:unknown){const status=record(error)?.status;return typeof status==='number'&&Number.isSafeInteger(status)?status:null;}
function conflictVersion(error:unknown){
 const row=record(error),nested=record(row?.error),data=record(row?.data);
 for(const value of [row?.currentVersion,row?.current_version,row?.settings_version,nested?.current_version,nested?.settings_version,data?.current_version,data?.settings_version])if(Number.isSafeInteger(value)&&Number(value)>=0)return Number(value);
 return null;
}
export default function SettingsPanel({caps,client}:{caps:Caps;client:HostAdminClient}){
 const toolDisplay=useToolDisplayPreference(),messageDisplay=useMessageDisplayPreferences(),layoutDisplay=useLayoutDisplayPreferences();
 const readinessEnabled=hostCapabilityEnabled(caps,'host_readiness');
 const settingsNamespace=typeof caps.workbench?.host_settings_write_namespace==='string'&&/^[a-z][a-z0-9._-]{0,127}$/.test(caps.workbench.host_settings_write_namespace)&&caps.workbench.host_settings_write_namespace!=='jot-host-policy'?caps.workbench.host_settings_write_namespace:null;
 const settingsEnabled=hostCapabilityEnabled(caps,'host_settings')&&settingsNamespace!==null;
 const settingsReadEnabled=hostCapabilityEnabled(caps,'host_settings_read');
 const onboardingEnabled=hostCapabilityEnabled(caps,'host_onboarding');
 const reportPending=useContext(MutationPending),pendingCount=useRef(0);
 const beginMutation=useCallback(()=>{pendingCount.current+=1;reportPending(true);},[reportPending]);
 const endMutation=useCallback(()=>{pendingCount.current=Math.max(0,pendingCount.current-1);reportPending(pendingCount.current>0);},[reportPending]);
 const pluginPending=useRef(false);
 const reportPluginPending=useCallback((pending:boolean)=>{
  if(pluginPending.current===pending)return;
  pluginPending.current=pending;
  if(pending)beginMutation();else endMutation();
 },[beginMutation,endMutation]);
 const [settings,setSettings]=useState(initialHostSettingsState);
 const [readiness,setReadiness]=useState<HostReadinessResponse|null>(null);
 const settingsRef=useRef(settings);settingsRef.current=settings;
 const settingsEnabledRef=useRef(settingsEnabled);settingsEnabledRef.current=settingsEnabled;
 const namespaceRef=useRef(settingsNamespace);namespaceRef.current=settingsNamespace;
 const clientRef=useRef(client);clientRef.current=client;
 const settingsLoad=useRef(0),saveInFlight=useRef<object|null>(null),mounted=useRef(true);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;settingsLoad.current+=1;};},[]);
 const saveAttempts=useRef<ReturnType<typeof createHostSettingsSaveAttempt>|null>(null);
 if(saveAttempts.current===null)saveAttempts.current=createHostSettingsSaveAttempt();
 const currentTaskScope=taskDraftScope(),scopeIdentity=currentTaskScope+':'+settingsNamespace,taskScopeRef=useRef(scopeIdentity);
 useEffect(()=>{if(taskScopeRef.current!==scopeIdentity){taskScopeRef.current=scopeIdentity;settingsLoad.current+=1;saveInFlight.current=null;saveAttempts.current?.clear();setSettings(initialHostSettingsState());setReadiness(null);}},[scopeIdentity]);
 const readinessNamespacesIdentity=Array.isArray(caps.workbench?.host_settings_read_namespaces)?caps.workbench.host_settings_read_namespaces.join('\u0000'):'';
 useEffect(()=>{setReadiness(null);},[client,readinessEnabled,readinessNamespacesIdentity]);
 const [onboarding,setOnboarding]=useState(initialOnboardingState);
 const reloadSettings=useCallback(async()=>{
  if(!settingsEnabled||!settingsNamespace)return;
  const generation=++settingsLoad.current,ownerScope=taskDraftScope();
  const current=()=>mounted.current&&settingsEnabledRef.current&&namespaceRef.current===settingsNamespace&&clientRef.current===client&&taskDraftScope()===ownerScope&&settingsLoad.current===generation;
  setSettings(current=>hostSettingsReloadStarted(current));
  try{
   const snapshot=await client.settings(settingsNamespace) as HostSettingsSnapshot;if(!current())return;
   if(snapshot.namespace!==settingsNamespace)throw Error('host_settings_namespace_changed');
   const pending=/^[a-f0-9]{64}$/.test(snapshot?.write_scope??'')?createHostSettingsRecovery(window.sessionStorage,ownerScope).read(snapshot.write_scope):null;
   if(!current())return;
   if(settingsRef.current.snapshot?.write_scope!==snapshot.write_scope)saveInFlight.current=null;
   if(pending&&pending.scope.namespace!==settingsNamespace)throw Error('host_settings_namespace_changed');
   if(pending)saveAttempts.current?.restore(pending.scope,pending.command,pending.key);
   setSettings(state=>{
    if(!current())return state;
    const next=hostSettingsReloadSucceeded(state,snapshot);
    return pending&&!next.error?hostSettingsSaveUnknownPending({...next,draft:{...next.draft,...pending.command.settings}}):next;
   });
  }catch(error){if(current())setSettings(state=>current()?hostSettingsReloadFailed(state,failureCode(error)):state);}
 },[client,settingsEnabled,settingsNamespace,currentTaskScope]);
 const reloadOnboarding=useCallback(async()=>{
  if(!onboardingEnabled)return;
  setOnboarding(current=>onboardingReloadStarted(current));
  try{const snapshot=await client.onboarding() as HostOnboardingSnapshot;setOnboarding(current=>onboardingReloadSucceeded(current,snapshot));}
  catch(error){setOnboarding(current=>onboardingReloadFailed(current,failureCode(error)));}
 },[client,onboardingEnabled]);

 useEffect(()=>{if(settingsEnabled)void reloadSettings();},[settingsEnabled,reloadSettings]);
 useEffect(()=>{if(onboardingEnabled)void reloadOnboarding();},[onboardingEnabled,reloadOnboarding]);

 const saveSettings=useCallback(async(candidateDraft?:HostSettingsValues)=>{
  if(!settingsEnabled||!settingsNamespace||saveInFlight.current)return false;
  const currentState=settingsRef.current;
  const current=candidateDraft?{...currentState,draft:candidateDraft,dirty:true,error:'',conflict:false,conflictVersion:null,unknownPending:false,activation:null,notice:''}:currentState;
  if(candidateDraft){settingsRef.current=current;setSettings(current);}
  if(!current.snapshot||!current.draft)return false;
  let saved=false;
  let command,scope,attempt,recovery,recovering=false;
  try{
   const taskScope=taskDraftScope(),writeScope=current.snapshot.write_scope;
   if(!/^[a-f0-9]{64}$/.test(writeScope??''))throw Error('host_settings_write_scope_unavailable');
   recovery=createHostSettingsRecovery(window.sessionStorage,taskScope);
   const stored=recovery.read(writeScope);
   if(stored){
    if(stored.scope.namespace!==settingsNamespace)throw Error('host_settings_namespace_changed');
    recovering=true;
    scope=stored.scope;command=stored.command;attempt={key:stored.key};
    saveAttempts.current!.restore(scope,command,attempt.key);
   }else{
    command=hostSettingsSaveCommand(current.snapshot,current.draft);
    scope={task_scope:taskScope,write_scope:writeScope,namespace:settingsNamespace,settings_version:current.snapshot.settings_version,schema_version:current.snapshot.schema_version};
    attempt=saveAttempts.current!.begin(scope,command);
    recovery.write({scope,command,key:attempt.key});
   }
  }catch{
   setSettings(state=>({...hostSettingsSaveFailed(state,'host_settings_recovery_unavailable'),error:'浏览器恢复回执不可用，无法提交设置。请保留浏览器存储后重试。'}));
   return;
  }
  const flight={};saveInFlight.current=flight;
  const snapshot=current.snapshot;
  const isCurrent=(state:typeof settings)=>{
   if(!mounted.current||namespaceRef.current!==scope.namespace||clientRef.current!==client||taskDraftScope()!==scope.task_scope||!settingsEnabledRef.current||!saveAttempts.current?.isCurrent(scope,command,attempt.key)
    ||state.snapshot?.write_scope!==scope.write_scope||state.snapshot?.settings_version!==snapshot.settings_version||state.snapshot?.schema_version!==snapshot.schema_version||!state.draft)return false;
   try{return JSON.stringify(hostSettingsSaveCommand(state.snapshot,state.draft).settings)===JSON.stringify(command.settings);}catch{return false;}
  };
  const updateCurrent=(transition:(state:typeof settings)=>typeof settings)=>setSettings(state=>isCurrent(state)?transition(state):state);
  const unknown=()=>{saveAttempts.current?.markUnknown(scope,command,attempt.key);updateCurrent(hostSettingsSaveUnknownPending);};
  const finish=(transition:(state:typeof settings)=>typeof settings)=>{
   recovery.clear(scope.write_scope,attempt.key);
   saveAttempts.current?.settle(scope,command,attempt.key);
   updateCurrent(transition);
  };
  beginMutation();
  setSettings(state=>hostSettingsSaveStarted(state));
  try{
   const result=recovering?await client.settingsAttempt(settingsNamespace,attempt.key):await client.saveSettings(settingsNamespace,command,attempt.key);
   if(!isCurrent(settingsRef.current))return;
   if('status' in result&&result.status==='unknown_pending'){
    unknown();
   }else if('status' in result&&result.status==='saved'){
    const apply=(state:typeof settings)=>hostSettingsWriteCandidateSaved(state,result,command.expected_version);
    if(apply(settingsRef.current).dirty)unknown();else{finish(apply);saved=true;}
   }else if('status' in result&&result.status==='conflict'){
    finish(state=>hostSettingsSaveConflict(state,result.current_version));
   }else if('status' in result&&(result.status==='held'||result.status==='rejected'||result.status==='stale_scope')){
    finish(state=>hostSettingsSaveFailed(state,result.status==='stale_scope'?'host_settings_scope_changed':result.reason_code));
   }else{
    const apply=(state:typeof settings)=>hostSettingsSaveSucceeded(state,result as HostSettingsUpdate);
    if(apply(settingsRef.current).dirty)unknown();else{finish(apply);saved=true;}
   }
  }catch(error){
   if(!isCurrent(settingsRef.current))return;
   if(httpStatus(error)===409){
    try{finish(state=>hostSettingsSaveConflict(state,conflictVersion(error)));}catch{unknown();}
   }else if((httpStatus(error)??500)>=500){
    unknown();
   }else{
    try{finish(state=>hostSettingsSaveFailed(state,failureCode(error)));}catch{unknown();}
   }
  }finally{if(saveInFlight.current===flight)saveInFlight.current=null;endMutation();}
  return saved;
 },[beginMutation,client,endMutation,settingsEnabled,settingsNamespace]);
 const applyOnboardingSettings=useCallback(async()=>{
  const current=settingsRef.current,draft=onboarding.draft;
  if(!settingsEnabled||!settingsNamespace||!draft)return false;
  const candidate=onboardingHostSettingsDraft(current,draft);
  if(!candidate)return false;
  return saveSettings(candidate);
 },[onboarding.draft,saveSettings,settingsEnabled,settingsNamespace]);
 const saveOnboarding=useCallback(async()=>{
  if(!onboardingEnabled||!onboarding.snapshot||!onboarding.draft||!onboarding.currentStep)return;
  beginMutation();
  setOnboarding(state=>onboardingSaveStarted(state));
  try{
   const result=await client.saveOnboarding({expected_version:onboarding.snapshot.version,current_step:onboarding.currentStep,draft:onboarding.draft}) as HostOnboardingSnapshot;
   setOnboarding(state=>onboardingSaveSucceeded(state,result));
  }catch(error){
   if(httpStatus(error)===409){
    let version=conflictVersion(error);
    if(version===null)try{const latest=await client.onboarding();if(Number.isSafeInteger(latest.version)&&latest.version>0)version=latest.version;}catch{}
    setOnboarding(state=>onboardingSaveConflict(state,version));
   }else setOnboarding(state=>onboardingSaveFailed(state,failureCode(error)));
  }finally{endMutation();}
 },[beginMutation,client,endMutation,onboarding,onboardingEnabled]);

 return <>
  <h2 data-desktop-target="settings" tabIndex={-1}>模型、凭据与安装设置</h2>
  <p className="wb-page-intro">查看模型目录、宿主状态及凭据入口，管理当前 Host profile 的设置与插件包。</p>
  <div className="wb-settings-grid">
   <section className="wb-form" aria-labelledby="wb-tool-display">
    <h3 id="wb-tool-display">会话显示</h3>
    <label className="wb-checkbox"><input type="checkbox" checked={toolDisplay.enabled} disabled={!toolDisplay.available} onChange={event=>toolDisplay.setEnabled(event.currentTarget.checked)}/>自动展开工具步骤</label>
    <p className="wb-settings-note">显示已加载的工具分组和步骤详情；手动折叠的选择会保留，工具正文和文件仍需主动打开。</p>
    <label className="wb-checkbox"><input type="checkbox" checked={messageDisplay.value.showThinking} disabled={!messageDisplay.available} onChange={event=>messageDisplay.setPreference('showThinking',event.currentTarget.checked)}/>显示模型思考与摘要</label>
    {messageDisplay.value.showThinking&&<label className="wb-checkbox"><input type="checkbox" checked={messageDisplay.value.inlineThinking} disabled={!messageDisplay.available} onChange={event=>messageDisplay.setPreference('inlineThinking',event.currentTarget.checked)}/>以行内样式显示思考内容</label>}
    <label className="wb-checkbox"><input type="checkbox" checked={messageDisplay.value.sendByCtrlEnter} disabled={!messageDisplay.available} onChange={event=>messageDisplay.setPreference('sendByCtrlEnter',event.currentTarget.checked)}/>使用 Ctrl/Cmd + Enter 发送</label>
    <p className="wb-settings-note">开启快捷键选项后，Enter 换行；Shift + Enter 始终换行。</p>
    <label className="wb-checkbox"><input type="checkbox" checked={layoutDisplay.value.autoScrollToBottom} disabled={!layoutDisplay.available} onChange={event=>layoutDisplay.setPreference('autoScrollToBottom',event.currentTarget.checked)}/>自动滚动到会话末尾</label>
    <p className="wb-settings-note">上滑阅读或打开检索后暂停跟随，可用“回到会话末尾”返回最新位置。</p>
    <label className="wb-checkbox"><input type="checkbox" checked={layoutDisplay.value.sidebarVisible} disabled={!layoutDisplay.available} onChange={event=>layoutDisplay.setPreference('sidebarVisible',event.currentTarget.checked)}/>显示工作台导航</label>
    {!toolDisplay.available?<p role="status">当前账户身份尚未确认，暂不能保存偏好。</p>:(!toolDisplay.persisted||!messageDisplay.persisted||!layoutDisplay.persisted)&&<p role="status">浏览器未保存此偏好，当前页面内的选择仍然有效，刷新后可能恢复之前的设置。</p>}
   </section>
   {caps.workbench?.plugin_profiles===true&&<PluginProfilesPanel key={currentTaskScope} scopeKey={currentTaskScope} onPendingChange={reportPluginPending}/>}
   {settingsReadEnabled&&<HostCredentialsPanel client={client} scopeKey={currentTaskScope}/>}
   <HostReadinessPanel enabled={readinessEnabled} namespaces={caps.workbench?.host_settings_read_namespaces} client={client} jotCapabilities={caps} scopeKey={currentTaskScope} onReadiness={setReadiness}/>
   <HostSettingsReadPanel enabled={settingsReadEnabled} namespaces={caps.workbench?.host_settings_read_namespaces} client={client} scopeKey={currentTaskScope}/>
   <HostSettingsPanel enabled={settingsEnabled} state={settings} readiness={null} onDraftChange={draft=>setSettings(state=>hostSettingsDraftChanged(state,draft))} onUseHostValues={()=>setSettings(state=>hostSettingsUseServerSnapshot(state))} onReload={()=>void reloadSettings()} onSave={()=>void saveSettings()}/>
   <OnboardingPanel enabled={onboardingEnabled} state={onboarding} readiness={readiness} settingsApplyAvailable={settingsEnabled&&!!onboardingHostSettingsDraft(settings,onboarding.draft)} settingsSaving={settings.saving} onApplySettings={()=>void applyOnboardingSettings()} onDraftChange={draft=>setOnboarding(state=>onboardingDraftChanged(state,draft))} onUseHostDraft={()=>setOnboarding(state=>onboardingUseServerSnapshot(state))} onReload={()=>void reloadOnboarding()} onSave={()=>void saveOnboarding()}/>
   <section className="wb-form" aria-labelledby="wb-settings-catalog">
    <h3 id="wb-settings-catalog">模型目录</h3>
    <p className="wb-status">模型目录只表示已发现的条目，不代表凭据有效、模型调用已验证或 RuntimeReadiness 已就绪。</p>
    {Array.isArray(caps.models)&&caps.models.length? <ul className="wb-settings-list">{caps.models.map((item,index)=>{const row=record(item);const provider=typeof row?.provider==='string'?row.provider:'未知提供方';const model=typeof row?.model==='string'?row.model:'未知模型';return <li key={`${provider}:${model}:${index}`}><strong>{model}</strong><span>{provider}</span></li>;})}</ul>:<p className="wb-status">目录未知或为空。</p>}
    <p className="wb-settings-note">提供方测试：未验证（Host 测试接口未在此界面开放）。</p>
   </section>
  </div>
 </>;
}
