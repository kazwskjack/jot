import React from 'react';
import type {HostReadinessResponse,HostSettingsValues} from './types';

type State={snapshot:{namespace?:string;settings_version:number;schema_version:number;schema_fingerprint?:string|null;write_scope?:string|null;settings:HostSettingsValues}|null;draft:HostSettingsValues|null;loading:boolean;saving:boolean;dirty:boolean;conflict:boolean;unknownPending?:boolean;error:string;notice:string;activation:string|null;activeRunImpact?:{active_runs:number|null;active_sessions:number|null;current_sessions_restarted:null};currentSessionsRestarted?:null};
export default function HostSettingsPanel({enabled,state,readiness,onDraftChange,onUseHostValues,onReload,onSave}:{enabled:boolean;state:State;readiness:HostReadinessResponse|null;onDraftChange:(value:HostSettingsValues)=>void;onUseHostValues:()=>void;onReload:()=>void;onSave:()=>void}){
 if(!enabled)return <section className="wb-form" aria-labelledby="wb-host-settings"><h3 id="wb-host-settings">版本化宿主设置</h3><p className="wb-status">版本化设置接口未开放；页面不会提交设置。</p></section>;
 const snapshot=state.snapshot,draft=state.draft;
 const workspaces=(readiness?.workspace?.items??[]).filter((item):item is typeof item & {workspace_id:string}=>typeof item.workspace_id==='string'),providers=(readiness?.providers??[]).filter((item):item is typeof item & {provider_id:string}=>typeof item.provider_id==='string'),plugins=(readiness?.plugins??[]).filter((item):item is typeof item & {plugin_id:string}=>typeof item.plugin_id==='string');
 const provider=providers.find(item=>item.provider_id===draft?.provider_id),models=provider?.model_ids??[];
 const validDraft=!!draft&&['agent','demo'].includes(draft.mode)&&draft.workspace_id.trim().length>0&&draft.provider_id.trim().length>0&&draft.model_id.trim().length>0;
 const schemaFingerprintReady=typeof snapshot?.schema_fingerprint==='string'&&/^[a-f0-9]{64}$/.test(snapshot.schema_fingerprint);
 const writeScopeReady=typeof snapshot?.write_scope==='string'&&/^[a-f0-9]{64}$/.test(snapshot.write_scope);
 const change=(key:keyof HostSettingsValues,value:HostSettingsValues[keyof HostSettingsValues])=>{if(draft)onDraftChange({...draft,[key]:value} as HostSettingsValues);};
 return <section className="wb-form" aria-labelledby="wb-host-settings">
  <div className="wb-form-head"><h3 id="wb-host-settings">版本化宿主设置</h3><button type="button" disabled={state.loading||state.saving||state.unknownPending} onClick={onReload}>重新读取</button></div>
  {state.loading&&!snapshot?<p className="wb-status" role="status">正在读取宿主设置…</p>:null}
  {state.error?<p className="wb-error" role="alert">{state.error}</p>:null}
  {state.unknownPending?<p className="wb-status" role="status">本次保存结果尚未确认。请用“查询保存状态”继续恢复；该操作沿用同一保存键。</p>:null}
  {!snapshot||!draft?<p className="wb-status">宿主设置：未知（尚无已确认快照）。</p>:<>
   <p className="wb-status">设置 namespace：{snapshot.namespace??'尚未确认'}。</p>
   <p className="wb-status">设置版本 {snapshot.settings_version} · 结构版本 {snapshot.schema_version}。保存使用该版本进行并发检查。</p>
   {!schemaFingerprintReady?<p className="wb-status">Host 结构指纹来源未接入；当前不能提交版本化保存。</p>:null}
   {!writeScopeReady?<p className="wb-status">Host 保存范围尚未确认；请重新连接后读取设置。</p>:null}
   <details><summary>查看 Host 已确认值（不含凭据引用）</summary><dl className="wb-settings-facts"><div><dt>运行模式</dt><dd>{snapshot.settings.mode}</dd></div><div><dt>工作区 ID</dt><dd>{snapshot.settings.workspace_id}</dd></div><div><dt>提供方 ID</dt><dd>{snapshot.settings.provider_id}</dd></div><div><dt>模型 ID</dt><dd>{snapshot.settings.model_id}</dd></div><div><dt>插件选择数</dt><dd>{snapshot.settings.plugin_selection.length}</dd></div></dl></details>
   <fieldset className="wb-input-fields" disabled={state.loading||state.saving||state.unknownPending}>
    <label>运行模式<select value={draft.mode} onChange={event=>change('mode',event.target.value as HostSettingsValues['mode'])}><option value="agent">Agent</option><option value="demo">演示</option></select></label>
    <label>工作区<select value={draft.workspace_id} onChange={event=>change('workspace_id',event.target.value)} disabled={workspaces.length===0}>{!workspaces.some(item=>item.workspace_id===draft.workspace_id)?<option value={draft.workspace_id}>{draft.workspace_id} · 当前值</option>:null}{workspaces.map(item=><option key={item.workspace_id} value={item.workspace_id}>{item.title}</option>)}</select>{workspaces.length===0?<small>工作区选项未知；保留当前值。</small>:null}</label>
    <label>模型提供方<select value={draft.provider_id} onChange={event=>{const id=event.target.value,selected=providers.find(item=>item.provider_id===id);onDraftChange({...draft,provider_id:id,...(selected?.model_ids.length?{model_id:selected.model_ids[0]}:{})});}} disabled={providers.length===0}>{!providers.some(item=>item.provider_id===draft.provider_id)?<option value={draft.provider_id}>{draft.provider_id} · 当前值</option>:null}{providers.map(item=><option key={item.provider_id} value={item.provider_id}>{item.provider_id} · {item.state}</option>)}</select>{providers.length===0?<small>提供方选项未知；保留当前值。</small>:null}</label>
    <label>模型<select value={draft.model_id} onChange={event=>change('model_id',event.target.value)} disabled={models.length===0}>{!models.includes(draft.model_id)?<option value={draft.model_id}>{draft.model_id} · 当前值</option>:null}{models.map(id=><option key={id} value={id}>{id}</option>)}</select>{models.length===0?<small>模型选项未知；目录不代表调用已验证。</small>:null}</label>
    <p className="wb-status">凭据引用：{draft.credential_ref?'已配置（引用不展示）':'未配置'}。凭据仅由 Host 管理。</p>
    <p className="wb-status">语音提供方：{draft.voice_provider_id?'已配置（标识不展示）':'未配置'}；此 UI 不改写语音提供方。</p>
    <fieldset><legend>插件选择</legend>{plugins.length?plugins.map(item=><label className="wb-checkbox" key={item.plugin_id}><input type="checkbox" checked={draft.plugin_selection.includes(item.plugin_id)} onChange={event=>change('plugin_selection',event.target.checked?[...new Set([...draft.plugin_selection,item.plugin_id])]:draft.plugin_selection.filter(id=>id!==item.plugin_id))}/>{item.plugin_id} · {item.state}</label>):<p className="wb-status">插件选项未知；保留当前选择。</p>}</fieldset>
   </fieldset>
   <p className="wb-status">提供方连通性测试未开放。此页不会发送测试请求。</p>
   <p className="wb-status">保存回执会显示已确认的运行和 Session 影响；缺少事实时保持未知。保存设置后的生效状态会单独显示。</p>
   <div className="wb-actions"><button className="wb-primary" type="button" disabled={!state.dirty||!validDraft||!schemaFingerprintReady||!writeScopeReady||state.saving||state.loading||state.conflict} onClick={onSave}>{state.saving&&state.unknownPending?'正在查询保存状态…':state.unknownPending?'查询保存状态':'保存宿主设置'}</button>{state.dirty?<><button type="button" disabled={state.saving||state.loading||state.unknownPending} onClick={onUseHostValues}>采用 Host 当前值</button><span className="wb-status">未保存的编辑会在读取失败时保留。</span></>:null}</div>
   {state.dirty&&!validDraft?<p className="wb-status">模式、工作区、提供方和模型需要是已选值后才能保存。</p>:null}
   {state.notice?<p className="wb-execution-notice" role="status">{state.notice}{state.activeRunImpact&&Number.isSafeInteger(state.activeRunImpact.active_runs)&&Number.isSafeInteger(state.activeRunImpact.active_sessions)?` 活跃运行 ${state.activeRunImpact.active_runs} 个，活跃 Session ${state.activeRunImpact.active_sessions} 个。`:''}</p>:null}
  </>}
 </section>;
}
