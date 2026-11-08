const isRecord=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const positiveInteger=value=>Number.isSafeInteger(value)&&value>0;
const revision=value=>Number.isSafeInteger(value)&&value>=0;
const safeCode=value=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(value)?value:null;
const clone=value=>structuredClone(value);
const steps=new Set(['mode','workspace','credentials','provider_test','save','complete']);
function validSettings(snapshot){
 const settings=snapshot?.settings;
 return isRecord(snapshot)&&revision(snapshot.settings_version)&&positiveInteger(snapshot.schema_version)&&isRecord(settings)
  &&['agent','demo'].includes(settings.mode)&&['workspace_id','provider_id','model_id'].every(key=>typeof settings[key]==='string')
  &&(settings.credential_ref===null||typeof settings.credential_ref==='string')
  &&(settings.voice_provider_id===null||typeof settings.voice_provider_id==='string')
  &&Array.isArray(settings.plugin_selection)&&settings.plugin_selection.every(value=>typeof value==='string');
}

export function hostCapabilityEnabled(caps,name){
 return isRecord(caps)&&isRecord(caps.workbench)&&caps.workbench[name]===true;
}

/** @returns {import('react').ComponentProps<typeof import('./HostSettingsPanel').default>['state'] & {conflictVersion:number|null;unknownPending:boolean}} */
export const initialHostSettingsState=()=>({snapshot:null,draft:null,loading:false,saving:false,dirty:false,error:'',conflict:false,conflictVersion:null,unknownPending:false,activation:null,notice:''});
export function hostSettingsReloadStarted(state){return {...state,loading:true,error:''};}
export function hostSettingsReloadSucceeded(state,snapshot){
 if(!validSettings(snapshot))return hostSettingsReloadFailed(state,'settings_invalid');
 const preserveDraft=state.dirty===true&&isRecord(state.draft)&&state.snapshot?.write_scope===snapshot.write_scope;
 return {...state,snapshot:clone(snapshot),draft:preserveDraft?state.draft:clone(snapshot.settings),loading:false,saving:false,dirty:preserveDraft,unknownPending:preserveDraft&&state.unknownPending===true,error:'',conflict:false,conflictVersion:null,activation:null,notice:''};
}
export function hostSettingsReloadFailed(state,reason){
 const code=safeCode(reason);
 return {...state,loading:false,error:`读取设置失败；保留上次已读取的配置。${code?`（${code}）`:''}`};
}
export function hostSettingsDraftChanged(state,draft){const conflicted=state.conflict===true;return {...state,draft:clone(draft),dirty:true,error:conflicted?state.error:'',conflictVersion:conflicted?state.conflictVersion:null,activation:null,notice:''};}
export function hostSettingsUseServerSnapshot(state){return state.snapshot?{...state,draft:clone(state.snapshot.settings),dirty:false,conflict:false,conflictVersion:null,error:'',activation:null,notice:''}:state;}
export function hostSettingsSaveStarted(state){return {...state,saving:true,error:'',notice:''};}
export function hostSettingsSaveConflict(state,currentVersion){
 const version=revision(currentVersion)?currentVersion:null;
 return {...state,saving:false,dirty:true,conflict:true,conflictVersion:version,unknownPending:false,error:version!==null?`设置版本冲突；Host 当前版本为 ${version}。你的编辑仍保留，请重新读取并检查后再保存。`:'设置版本冲突；Host 当前版本未知。你的编辑仍保留，请重新读取后再保存。',notice:''};
}
export function hostSettingsSaveUnknownPending(state){return {...state,saving:false,dirty:true,conflict:false,conflictVersion:null,unknownPending:true,activation:null,error:'Host 尚未确认这次保存是否完成。草稿已保留；再次点击“查询保存状态”会复用同一个保存键。',notice:''};}
export function hostSettingsSaveFailed(state,reason){
 const code=safeCode(reason);
 return {...state,saving:false,dirty:true,conflict:false,conflictVersion:null,unknownPending:false,error:`保存未确认；继续保留之前已确认的配置。${code?`（${code}）`:''}`,activation:null,notice:''};
}
export function hostSettingsSaveSucceeded(state,result){
 if(result?.receipt?.status==='conflict')return hostSettingsSaveConflict(state,result.current_version);
 if(result?.receipt?.status==='reload_failed'||result?.migration?.state==='failed')return hostSettingsSaveFailed(state,result?.receipt?.reason_code??'reload_failed');
 const validActivation=['live','unknown'].includes(result?.activation);
 const impact=result?.active_run_impact;
 const validImpact=isRecord(impact)&&['active_runs','active_sessions'].every(key=>impact[key]===null||Number.isSafeInteger(impact[key])&&impact[key]>=0)
  &&(impact.active_runs===null)===(impact.active_sessions===null)&&impact.current_sessions_restarted===null;
 const migration=result?.migration,reason=result?.receipt?.reason_code;
 const validMigration=isRecord(migration)&&['not_needed','migrated','failed'].includes(migration.state)&&(migration.from_schema_version===null||Number.isSafeInteger(migration.from_schema_version)&&migration.from_schema_version>=0)&&positiveInteger(migration.to_schema_version)&&migration.to_schema_version===result?.schema_version;
 if(!state.snapshot||!state.draft||result?.receipt?.status!=='saved'||!(reason===null||safeCode(reason))||!positiveInteger(result.settings_version)||!positiveInteger(result.schema_version)||!validActivation||!validImpact||!validMigration)return hostSettingsSaveFailed(state,'save_receipt_invalid');
 if(result.settings_version<state.snapshot.settings_version)return hostSettingsSaveFailed(state,'settings_version_stale');
 const snapshot={...state.snapshot,settings_version:result.settings_version,schema_version:result.schema_version,settings:clone(state.draft)};
 const impactNotice=impact.active_runs===null?'活动影响未知。':'';
 const notice=result.activation==='live'
  ?`设置已保存；Host 报告 applies=live。${impactNotice}当前 Session 的重启状态未知。`
  :`设置已保存；当前生效状态未知。${impactNotice}当前 Session 的重启状态未知。`;
 return {...state,snapshot,draft:clone(snapshot.settings),loading:false,saving:false,dirty:false,error:'',conflict:false,conflictVersion:null,unknownPending:false,activation:result.activation,activeRunImpact:clone(impact),currentSessionsRestarted:null,notice};
}

function safeWriteSettings(value){
 if(!isRecord(value)||Object.keys(value).some(key=>!['mode','workspace_id','provider_id','model_id','plugin_selection'].includes(key)))return null;
 const result={};
 for(const [key,item] of Object.entries(value)){
  if(key==='mode'){if(!['agent','demo'].includes(item))return null;result[key]=item;}
  else if(key==='plugin_selection'){if(!Array.isArray(item)||item.some(id=>typeof id!=='string'))return null;result[key]=[...item];}
  else{if(typeof item!=='string')return null;result[key]=item;}
 }
 return result;
}
export function hostSettingsWriteCandidateSaved(state,result,expectedVersion=state.snapshot?.settings_version){
 const migration=result?.migration,patch=safeWriteSettings(result?.settings),impact=result?.active_run_impact,activation=result?.activation?.state;
 const validImpact=isRecord(impact)&&impact.current_sessions_restarted===null
  &&(impact.state==='known'&&Number.isSafeInteger(impact.active_runs)&&impact.active_runs>=0&&Number.isSafeInteger(impact.active_sessions)&&impact.active_sessions>=0
   ||impact.state==='unknown'&&impact.active_runs===null&&impact.active_sessions===null);
 if(!state.snapshot||!state.draft||result?.status!=='saved'||typeof result.namespace!=='string'
  ||!positiveInteger(result.settings_version)||result.settings_version<=expectedVersion||result.settings_version<state.snapshot.settings_version||!patch||Object.keys(patch).length===0
  ||!isRecord(result.activation)||Object.keys(result.activation).sort().join(',')!=='state'||!['live','unknown'].includes(activation)
  ||!validImpact||result.safe_boundary?.state!=='unknown'
  ||!isRecord(migration)||!['not_required','migrated'].includes(migration.state)
  ||migration.from_schema_version!==null&&(!Number.isSafeInteger(migration.from_schema_version)||migration.from_schema_version<0)
  ||!positiveInteger(migration.to_schema_version))return hostSettingsSaveFailed(state,'save_receipt_invalid');
 const settings={...state.snapshot.settings,...patch};
 const snapshot={...state.snapshot,settings_version:result.settings_version,schema_version:migration.to_schema_version,
  schema_fingerprint:migration.state==='not_required'?state.snapshot.schema_fingerprint:null,settings};
 if(!validSettings(snapshot))return hostSettingsSaveFailed(state,'save_receipt_invalid');
 const activeRunImpact=impact.state==='known'?{active_runs:impact.active_runs,active_sessions:impact.active_sessions,current_sessions_restarted:null}
  :{active_runs:null,active_sessions:null,current_sessions_restarted:null};
 return{...state,snapshot,draft:clone(settings),loading:false,saving:false,dirty:false,error:'',conflict:false,conflictVersion:null,unknownPending:false,
  activation,activeRunImpact,currentSessionsRestarted:null,notice:activation==='live'
   ?`Host 已确认保存；Host 报告 applies=live。${impact.state==='unknown'?'活动影响未知。':''}当前 Session 重启状态未知。`
   :`Host 已确认保存；设置对当前运行的生效状态未知。${impact.state==='unknown'?'活动影响未知。':''}当前 Session 重启状态未知。`};
}

/** @returns {import('react').ComponentProps<typeof import('./OnboardingPanel').default>['state'] & {conflictVersion:number|null}} */
export const initialOnboardingState=()=>({snapshot:null,currentStep:null,draft:null,loading:false,saving:false,dirty:false,error:'',conflict:false,conflictVersion:null,notice:''});
export function onboardingHostSettingsDraft(settingsState,draft){
 const snapshot=settingsState?.snapshot,currentSettings=snapshot?.settings;
 if(!isRecord(settingsState)||settingsState.loading||settingsState.saving||settingsState.dirty||settingsState.conflict||settingsState.unknownPending||settingsState.error
  ||!isRecord(settingsState.draft)||!validSettings(snapshot)||!isRecord(draft)
  ||!['agent','demo'].includes(draft.mode)||!['workspace_id','provider_id','model_id'].every(key=>typeof draft[key]==='string'&&draft[key].length>0)
  ||draft.credential_ref!==currentSettings.credential_ref)return null;
 return {...clone(currentSettings),mode:draft.mode,workspace_id:draft.workspace_id,provider_id:draft.provider_id,model_id:draft.model_id};
}
export function onboardingReloadStarted(state){return {...state,loading:true,error:''};}
function validOnboarding(snapshot){
 return isRecord(snapshot)&&positiveInteger(snapshot.version)&&positiveInteger(snapshot.schema_version)&&steps.has(snapshot.current_step)&&isRecord(snapshot.draft)
  &&[null,'agent','demo'].includes(snapshot.draft.mode)
  &&['workspace_id','provider_id','model_id','credential_ref'].every(key=>snapshot.draft[key]===null||typeof snapshot.draft[key]==='string')
  &&(snapshot.last_receipt_id===null||typeof snapshot.last_receipt_id==='string')
  &&(snapshot.last_error_code===null||safeCode(snapshot.last_error_code)!==null);
}
export function onboardingReloadSucceeded(state,snapshot){
 if(!validOnboarding(snapshot))return onboardingReloadFailed(state,'onboarding_invalid');
 const preserveDraft=state.dirty===true&&isRecord(state.draft);
 return {...state,snapshot:clone(snapshot),currentStep:snapshot.current_step,draft:preserveDraft?state.draft:clone(snapshot.draft),loading:false,saving:false,dirty:preserveDraft,error:'',conflict:false,conflictVersion:null,notice:''};
}
export function onboardingReloadFailed(state,reason){
 const code=safeCode(reason);
 return {...state,loading:false,error:`读取引导状态失败；保留上次已读取的步骤和草稿。${code?`（${code}）`:''}`};
}
export function onboardingDraftChanged(state,draft){const conflicted=state.conflict===true;return {...state,draft:clone(draft),dirty:true,error:conflicted?state.error:'',conflictVersion:conflicted?state.conflictVersion:null,notice:''};}
export function onboardingUseServerSnapshot(state){return state.snapshot?{...state,currentStep:state.snapshot.current_step,draft:clone(state.snapshot.draft),dirty:false,conflict:false,conflictVersion:null,error:'',notice:''}:state;}
export function onboardingSaveStarted(state){return {...state,saving:true,error:'',notice:''};}
export function onboardingSaveConflict(state,currentVersion){
 const version=positiveInteger(currentVersion)?currentVersion:null;
 return {...state,saving:false,dirty:true,conflict:true,conflictVersion:version,error:version?`安装引导版本冲突；Host 当前版本为 ${version}。步骤和草稿仍保留，请重新读取并检查后再保存。`:'安装引导版本冲突；Host 当前版本未知。步骤和草稿仍保留，请重新读取后再保存。',notice:''};
}
export function onboardingSaveFailed(state,reason){
 const code=safeCode(reason);
 return {...state,saving:false,dirty:true,conflict:false,error:`引导进度未确认；仍保留上次已确认步骤和草稿。${code?`（${code}）`:''}`,notice:''};
}
export function onboardingSaveSucceeded(state,snapshot){
 if(!validOnboarding(snapshot)||state.snapshot&&snapshot.version<state.snapshot.version)return onboardingSaveFailed(state,'onboarding_receipt_invalid');
 return {...state,snapshot:clone(snapshot),currentStep:snapshot.current_step,draft:clone(snapshot.draft),loading:false,saving:false,dirty:false,error:'',conflict:false,conflictVersion:null,notice:'引导步骤和非敏感草稿已由 Host 保存，可在刷新后恢复。'};
}
