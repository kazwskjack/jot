import React from 'react';
import type {HostOnboardingSnapshot,HostReadinessResponse,OnboardingDraft,OnboardingStep} from './types';

type State={snapshot:HostOnboardingSnapshot|null;currentStep:OnboardingStep|null;draft:OnboardingDraft|null;loading:boolean;saving:boolean;dirty:boolean;conflict:boolean;error:string;notice:string};
const steps:{id:OnboardingStep;label:string}[]=[{id:'mode',label:'选择模式'},{id:'workspace',label:'工作区'},{id:'credentials',label:'凭据引用'},{id:'provider_test',label:'提供方测试'},{id:'save',label:'保存'},{id:'complete',label:'完成'}];
const safeCode=(value:unknown)=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value)?value:'unknown';
const safeReasons=(value:unknown)=>Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(item)).join('、')||'Host 未报告':'Host 未报告';
export default function OnboardingPanel({enabled,state,readiness,settingsApplyAvailable=false,settingsSaving=false,onApplySettings=()=>{},onDraftChange,onUseHostDraft,onReload,onSave}:{enabled:boolean;state:State;readiness:HostReadinessResponse|null;settingsApplyAvailable?:boolean;settingsSaving?:boolean;onApplySettings?:()=>void|Promise<unknown>;onDraftChange:(draft:OnboardingDraft)=>void;onUseHostDraft:()=>void;onReload:()=>void;onSave:()=>void}){
 if(!enabled)return <section className="wb-form" aria-labelledby="wb-host-onboarding"><h3 id="wb-host-onboarding">可恢复安装引导</h3><p className="wb-status">安装引导接口未开放；页面不会保存引导状态。</p></section>;
 const snapshot=state.snapshot,draft=state.draft,workspaces=(readiness?.workspace?.items??[]).filter((item):item is typeof item & {workspace_id:string}=>typeof item.workspace_id==='string'),providers=(readiness?.providers??[]).filter((item):item is typeof item & {provider_id:string}=>typeof item.provider_id==='string'),selected=providers.find(item=>item.provider_id===draft?.provider_id),models=selected?.model_ids??[];
 const change=(key:keyof OnboardingDraft,value:OnboardingDraft[keyof OnboardingDraft])=>{if(draft)onDraftChange({...draft,[key]:value} as OnboardingDraft);};
 return <section className="wb-form" aria-labelledby="wb-host-onboarding">
  <div className="wb-form-head"><h3 id="wb-host-onboarding">可恢复安装引导</h3><button type="button" disabled={state.loading||state.saving} onClick={onReload}>重新读取</button></div>
  {state.error?<p className="wb-error" role="alert">{state.error}</p>:null}
  {state.loading&&!snapshot?<p className="wb-status" role="status">正在读取已保存的引导步骤…</p>:null}
  {!snapshot||!draft||!state.currentStep?<p className="wb-status">引导进度：未知（尚无已确认步骤或草稿）。</p>:<>
   <p className="wb-status">引导版本 {snapshot.version} · 结构版本 {snapshot.schema_version}。Host 保存的步骤和非敏感草稿可在刷新后恢复。</p>
   {snapshot.last_error_code?<p className="wb-status" role="status">Host 上次报告：{snapshot.last_error_code}</p>:null}
   {snapshot.last_receipt_id?<p className="wb-status">最近 Host 回执：{snapshot.last_receipt_id}</p>:null}
   <ol className="wb-actions" aria-label="安装步骤">{steps.map((step,index)=><li key={step.id} aria-current={state.currentStep===step.id?'step':undefined}>{index+1}. {step.label}{state.currentStep===step.id?'（当前）':''}</li>)}</ol>
   <fieldset className="wb-input-fields" disabled={state.loading||state.saving||state.currentStep==='complete'}>
    <p className="wb-status">当前步骤由 Host 管理：{steps.find(step=>step.id===state.currentStep)?.label??'未知'}。此页不会跳过提供方测试或伪造完成状态。</p>
    <label>运行模式<select value={draft.mode??''} onChange={event=>change('mode',event.target.value?event.target.value as OnboardingDraft['mode']:null)}><option value="">未知</option><option value="agent">Agent</option><option value="demo">演示</option></select></label>
    <label>工作区<select value={draft.workspace_id??''} onChange={event=>change('workspace_id',event.target.value||null)} disabled={!workspaces.length}>{!draft.workspace_id?<option value="">未知</option>:null}{!workspaces.some(item=>item.workspace_id===draft.workspace_id)&&draft.workspace_id?<option value={draft.workspace_id}>{draft.workspace_id} · 当前值</option>:null}{workspaces.map(item=><option value={item.workspace_id} key={item.workspace_id}>{item.title}</option>)}</select></label>
    <label>模型提供方<select value={draft.provider_id??''} onChange={event=>{const id=event.target.value||null,next=providers.find(item=>item.provider_id===id);onDraftChange({...draft,provider_id:id,...(next?.model_ids.length?{model_id:next.model_ids[0]}:{})});}} disabled={!providers.length}>{!draft.provider_id?<option value="">未知</option>:null}{!providers.some(item=>item.provider_id===draft.provider_id)&&draft.provider_id?<option value={draft.provider_id}>{draft.provider_id} · 当前值</option>:null}{providers.map(item=><option value={item.provider_id} key={item.provider_id}>{item.provider_id}</option>)}</select></label>
   {selected?<p className="wb-status">提供方 readiness：{safeCode(selected.state)} · {safeReasons(selected.reason_codes)}</p>:null}
    <label>模型<select value={draft.model_id??''} onChange={event=>change('model_id',event.target.value||null)} disabled={!models.length}>{!draft.model_id?<option value="">未知</option>:null}{!models.includes(draft.model_id??'')&&draft.model_id?<option value={draft.model_id}>{draft.model_id} · 当前值</option>:null}{models.map(id=><option value={id} key={id}>{id}</option>)}</select></label>
   </fieldset>
   <p className="wb-status">凭据引用：{draft.credential_ref?'已配置（引用不展示）':'未配置'}。凭据由 Host 管理，不会在浏览器采集或显示。</p>
   {state.currentStep==='provider_test'?<p className="wb-status">提供方测试能力未开放；步骤只记录为待处理，不会发送模型请求，也不会显示虚假成功。</p>:null}
   {state.currentStep==='save'?<><p className="wb-status">引导进度与设置应用分别保存。“应用设置到 Host”调用现有 Host 设置保存接口；凭据引用由 Host 管理，不会在此更改，也不会创建 Session 或发送模型请求。</p>{settingsApplyAvailable?<button type="button" disabled={state.loading||state.saving||settingsSaving} onClick={onApplySettings}>应用设置到 Host</button>:<p className="wb-status">Host 设置写入不可用，或当前设置有未解决草稿、冲突、恢复回执或凭据引用不一致；请先读取并核对 Host 设置。</p>}</>:null}
   <div className="wb-actions"><button className="wb-primary" type="button" disabled={!state.dirty||state.loading||state.saving||state.currentStep==='complete'||state.conflict} onClick={onSave}>保存引导进度</button>{state.dirty?<><button type="button" disabled={state.loading||state.saving} onClick={onUseHostDraft}>采用 Host 已保存草稿</button><span className="wb-status">草稿尚未确认保存。</span></>:null}</div>
   {state.notice?<p className="wb-execution-notice" role="status">{state.notice}</p>:null}
  </>}
 </section>;
}
