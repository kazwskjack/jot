import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hostCapabilityEnabled,
  initialHostSettingsState,
  hostSettingsReloadStarted,
  hostSettingsReloadSucceeded,
  hostSettingsReloadFailed,
  hostSettingsDraftChanged,
  hostSettingsUseServerSnapshot,
  hostSettingsSaveConflict,
  hostSettingsSaveUnknownPending,
  hostSettingsWriteCandidateSaved,
  hostSettingsSaveSucceeded,
  onboardingHostSettingsDraft,
  initialOnboardingState,
  onboardingReloadStarted,
  onboardingReloadSucceeded,
  onboardingReloadFailed,
  onboardingUseServerSnapshot,
  onboardingSaveConflict,
  onboardingSaveSucceeded,
} from './host-setup-state.mjs';

const settings={mode:'agent',workspace_id:'workspace-a',provider_id:'provider-a',model_id:'model-a',credential_ref:'opaque-ref-a',voice_provider_id:null,plugin_selection:[]};
const settingsSnapshot={settings_version:7,schema_version:2,schema_fingerprint:'a'.repeat(64),settings};
const onboardingSnapshot={version:4,schema_version:1,current_step:'workspace',draft:{mode:'agent',workspace_id:'workspace-a',provider_id:null,model_id:null,credential_ref:null},last_receipt_id:null,last_error_code:null};

test('host endpoints remain unavailable unless the server advertises the exact capability',()=>{
 assert.equal(hostCapabilityEnabled({workbench:{host_settings:true}},'host_settings'),true);
 assert.equal(hostCapabilityEnabled({workbench:{host_settings:false}},'host_settings'),false);
 assert.equal(hostCapabilityEnabled({workbench:{}},'host_settings'),false);
 assert.equal(hostCapabilityEnabled(null,'host_settings'),false);
 assert.equal(hostCapabilityEnabled({workbench:{host_settings:'true'}},'host_settings'),false);
});

test('failed settings reload keeps the last server snapshot and the edited draft',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 const edited=hostSettingsDraftChanged(loaded,{...settings,model_id:'model-b'});
 const reloading=hostSettingsReloadStarted(edited);
 const failed=hostSettingsReloadFailed(reloading,'network_unavailable');
 assert.equal(failed.snapshot,loaded.snapshot);
 assert.deepEqual(failed.draft,{...settings,model_id:'model-b'});
 assert.equal(failed.loading,false);
 assert.match(failed.error,/保留上次/);
});

test('invalid settings data cannot replace the previous confirmed snapshot',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 const invalid=hostSettingsReloadSucceeded(loaded,{...settingsSnapshot,settings:{...settings,plugin_selection:'not-an-array'}});
 assert.equal(invalid.snapshot.settings_version,7);
 assert.deepEqual(invalid.draft,settings);
 assert.match(invalid.error,/settings_invalid/);
});

test('409 settings conflict preserves the old config and draft while reporting current version',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 const edited=hostSettingsDraftChanged(loaded,{...settings,model_id:'model-b'});
 const conflicted=hostSettingsSaveConflict(edited,9);
 assert.equal(conflicted.snapshot.settings_version,7);
 assert.deepEqual(conflicted.draft,{...settings,model_id:'model-b'});
 assert.equal(conflicted.conflict,true);
 assert.equal(conflicted.conflictVersion,9);
 assert.match(conflicted.error,/版本冲突/);
 const reloaded=hostSettingsReloadSucceeded(hostSettingsReloadStarted(conflicted),{...settingsSnapshot,settings_version:9});
 assert.equal(reloaded.conflict,false);
 assert.equal(reloaded.draft.model_id,'model-b');
 const adopted=hostSettingsUseServerSnapshot(reloaded);
 assert.equal(adopted.dirty,false);
 assert.equal(adopted.draft.model_id,'model-a');
});

test('unknown settings receipt keeps the draft and presents same-key recovery without claiming a save',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 const edited=hostSettingsDraftChanged(loaded,{...settings,model_id:'model-b'});
 const pending=hostSettingsSaveUnknownPending({...edited,saving:true});
 assert.equal(pending.snapshot.settings_version,7);
 assert.equal(pending.draft.model_id,'model-b');
 assert.equal(pending.dirty,true);
 assert.equal(pending.saving,false);
 assert.equal(pending.unknownPending,true);
 assert.equal(pending.activation,null);
 assert.match(pending.error,/查询保存状态/);
});

test('a confirmed private CAS receipt updates only writable values and leaves activation unknown',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 const edited=hostSettingsDraftChanged(loaded,{...settings,model_id:'model-b'});
 const saved=hostSettingsWriteCandidateSaved(edited,{status:'saved',namespace:'jot-session-adapter',settings_version:8,
  settings:{mode:'demo',workspace_id:'workspace-b',provider_id:'provider-a',model_id:'model-b',plugin_selection:['plugin-a']},
  activation:{state:'unknown'},active_run_impact:{state:'known',active_runs:2,active_sessions:1,current_sessions_restarted:null},
  migration:{state:'not_required',from_schema_version:null,to_schema_version:2},safe_boundary:{state:'unknown'}});
 assert.equal(saved.snapshot.settings_version,8);
 assert.equal(saved.snapshot.schema_fingerprint,'a'.repeat(64));
 assert.equal(saved.draft.mode,'demo');
 assert.equal(saved.draft.credential_ref,'opaque-ref-a','the read-only credential capability remains in local state');
 assert.equal(saved.activation,'unknown');
 assert.equal(saved.currentSessionsRestarted,null);
 assert.equal(saved.unknownPending,false);
 assert.match(saved.notice,/生效状态未知/);
});

test('candidate save preserves live activation while keeping restart and unknown impact facts explicit',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot),edited=hostSettingsDraftChanged(loaded,{...settings,model_id:'model-b'});
 const saved=hostSettingsWriteCandidateSaved(edited,{status:'saved',namespace:'jot-session-adapter',settings_version:8,
  settings:{mode:'demo'},activation:{state:'live'},active_run_impact:{state:'unknown',active_runs:null,active_sessions:null,current_sessions_restarted:null},
  migration:{state:'not_required',from_schema_version:null,to_schema_version:2},safe_boundary:{state:'unknown'}});
 assert.equal(saved.dirty,false);assert.equal(saved.activation,'live');
 assert.deepEqual(saved.activeRunImpact,{active_runs:null,active_sessions:null,current_sessions_restarted:null});
 assert.equal(saved.currentSessionsRestarted,null);assert.match(saved.notice,/applies=live/);assert.match(saved.notice,/重启状态未知/);
});

test('reload_failed receipt retains the previous settings without claiming activation or restart',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 const edited=hostSettingsDraftChanged(loaded,{...settings,model_id:'model-b'});
 const result=hostSettingsSaveSucceeded(edited,{settings_version:8,schema_version:2,activation:'live',active_run_impact:{active_runs:0,active_sessions:0,current_sessions_restarted:null},migration:{from_schema_version:2,to_schema_version:2,state:'not_needed'},receipt:{status:'reload_failed',reason_code:'reload_unavailable'}});
 assert.equal(result.snapshot.settings_version,7);
 assert.deepEqual(result.draft,{...settings,model_id:'model-b'});
 assert.equal(result.activation,null);
 assert.match(result.error,/之前已确认的配置/);
});

test('successful settings receipt preserves live apply semantics without claiming session restarts',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 const edited=hostSettingsDraftChanged(loaded,{...settings,model_id:'model-b'});
 const saved=hostSettingsSaveSucceeded(edited,{settings_version:8,schema_version:2,activation:'live',active_run_impact:{active_runs:2,active_sessions:1,current_sessions_restarted:null},migration:{from_schema_version:2,to_schema_version:2,state:'not_needed'},receipt:{status:'saved',reason_code:null}});
 assert.equal(saved.snapshot.settings_version,8);
 assert.equal(saved.snapshot.settings.model_id,'model-b');
 assert.equal(saved.activation,'live');
 assert.equal(saved.currentSessionsRestarted,null);
 assert.match(saved.notice,/applies=live/);
 assert.doesNotMatch(saved.notice,/未重启/);
});

test('unknown activity remains unknown after a confirmed save',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 const edited=hostSettingsDraftChanged(loaded,{...settings,model_id:'model-b'});
 const saved=hostSettingsSaveSucceeded(edited,{settings_version:8,schema_version:2,activation:'unknown',
  active_run_impact:{active_runs:null,active_sessions:null,current_sessions_restarted:null},
  migration:{from_schema_version:2,to_schema_version:2,state:'not_needed'},receipt:{status:'saved',reason_code:null}});
 assert.equal(saved.dirty,false);assert.equal(saved.activation,'unknown');
 assert.deepEqual(saved.activeRunImpact,{active_runs:null,active_sessions:null,current_sessions_restarted:null});
 assert.equal(saved.currentSessionsRestarted,null);assert.match(saved.notice,/影响未知/);
});

test('onboarding reload failure and conflict retain the recoverable server step and draft',()=>{
 const loaded=onboardingReloadSucceeded(initialOnboardingState(),onboardingSnapshot);
 const reloading=onboardingReloadStarted(loaded);
 const failed=onboardingReloadFailed(reloading,'host_unavailable');
 assert.equal(failed.snapshot,loaded.snapshot);
 assert.equal(failed.snapshot.current_step,'workspace');
 assert.match(failed.error,/保留上次/);
 const conflicted=onboardingSaveConflict(failed,6);
 assert.equal(conflicted.snapshot.version,4);
 assert.equal(conflicted.conflict,true);
 assert.equal(conflicted.conflictVersion,6);
 assert.equal(conflicted.snapshot.draft.workspace_id,'workspace-a');
});

test('onboarding refresh follows the Host-owned step while preserving unsaved draft values',()=>{
 const loaded=onboardingReloadSucceeded(initialOnboardingState(),onboardingSnapshot);
 const edited={...loaded,draft:{...loaded.draft,workspace_id:'workspace-local'},dirty:true};
 const refreshed=onboardingReloadSucceeded(edited,{...onboardingSnapshot,version:5,current_step:'provider_test',draft:{...onboardingSnapshot.draft,workspace_id:'workspace-server'}});
 assert.equal(refreshed.currentStep,'provider_test');
 assert.equal(refreshed.snapshot.version,5);
 assert.equal(refreshed.draft.workspace_id,'workspace-local');
 assert.equal(refreshed.dirty,true);
 const adopted=onboardingUseServerSnapshot(refreshed);
 assert.equal(adopted.dirty,false);
 assert.equal(adopted.currentStep,'provider_test');
 assert.equal(adopted.draft.workspace_id,'workspace-server');
});

test('successful onboarding save records the server-returned recovery step and version',()=>{
 const loaded=onboardingReloadSucceeded(initialOnboardingState(),onboardingSnapshot);
 const saved=onboardingSaveSucceeded(loaded,{...onboardingSnapshot,version:5,current_step:'credentials',draft:{...onboardingSnapshot.draft,workspace_id:'workspace-b'}});
 assert.equal(saved.snapshot.version,5);
 assert.equal(saved.snapshot.current_step,'credentials');
 assert.equal(saved.snapshot.draft.workspace_id,'workspace-b');
 assert.equal(saved.error,'');
});

test('onboarding settings application maps only writable fields and keeps Host-managed credential references',()=>{
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 const onboardingDraft={mode:'demo',workspace_id:'workspace-b',provider_id:'provider-b',model_id:'model-b',credential_ref:'opaque-ref-a'};
 const applied=onboardingHostSettingsDraft(loaded,onboardingDraft);
 assert.deepEqual(applied,{...settings,mode:'demo',workspace_id:'workspace-b',provider_id:'provider-b',model_id:'model-b'});
 assert.equal(applied.credential_ref,'opaque-ref-a');
 assert.notEqual(applied,settings);
 assert.equal(onboardingHostSettingsDraft(loaded,{...onboardingDraft,credential_ref:'another-ref'}),null,
  'onboarding cannot silently claim to update a Host-managed credential reference');
 assert.equal(onboardingHostSettingsDraft(loaded,{...onboardingDraft,provider_id:null}),null);
});

test('onboarding application uses a clean confirmed Host snapshot and blocks unresolved Host drafts',()=>{
 const onboardingDraft={mode:'demo',workspace_id:'workspace-b',provider_id:'provider-b',model_id:'model-b',credential_ref:'opaque-ref-a'};
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),settingsSnapshot);
 assert.deepEqual(onboardingHostSettingsDraft(loaded,onboardingDraft),{...settings,mode:'demo',workspace_id:'workspace-b',provider_id:'provider-b',model_id:'model-b'});
 const edited=hostSettingsDraftChanged(loaded,{...settings,plugin_selection:['plugin-unconfirmed']});
 assert.equal(onboardingHostSettingsDraft(edited,onboardingDraft),null);
 const pending=hostSettingsSaveUnknownPending({...loaded,saving:true});
 assert.equal(onboardingHostSettingsDraft(pending,onboardingDraft),null);
});

