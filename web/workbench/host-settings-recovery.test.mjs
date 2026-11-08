import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostSettingsRecovery} from './host-settings-recovery.mjs';
import {createHostSettingsSaveAttempt,hostSettingsSaveCommand} from './host-settings-save-attempt.mjs';
import {hostSettingsWriteCandidateSaved,hostSettingsReloadSucceeded,initialHostSettingsState} from './host-setup-state.mjs';

const task='a'.repeat(64),host='b'.repeat(64);
const scope={task_scope:task,write_scope:host,namespace:'jot-session-adapter',settings_version:7,schema_version:2};
const command={expected_version:7,expected_schema_fingerprint:'c'.repeat(64),settings:{mode:'demo',workspace_id:'w',provider_id:'p',model_id:'m',plugin_selection:[]}};
function storage(){const rows=new Map();return{rows,getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};}

test('the real DSH initial revision zero remains a valid expected revision',()=>{
 const snapshot={settings_version:0,schema_version:1,schema_fingerprint:'c'.repeat(64),write_scope:host,settings:{...command.settings,credential_ref:null,voice_provider_id:null}};
 const loaded=hostSettingsReloadSucceeded(initialHostSettingsState(),snapshot);
 assert.equal(loaded.snapshot.settings_version,0);
 const input=hostSettingsSaveCommand(snapshot,snapshot.settings),initialScope={...scope,settings_version:0,schema_version:1};
 assert.equal(input.expected_version,0);
 const attempts=createHostSettingsSaveAttempt({createKey:()=> 'save-revision-zero'}),attempt=attempts.begin(initialScope,input);
 const recovery=createHostSettingsRecovery(storage(),task);recovery.write({scope:initialScope,command:input,key:attempt.key});
 assert.equal(recovery.read(host).command.expected_version,0);
});

test('page reload recovers the exact original command and key without persisting references',()=>{
 const data=storage(),store=createHostSettingsRecovery(data,task);
 store.write({scope,command,key:'save-recovery-0001'});
 const recovered=createHostSettingsRecovery(data,task).read(host);
 assert.deepEqual(recovered,{scope,command,key:'save-recovery-0001'});
 const attempts=createHostSettingsSaveAttempt({createKey:()=>{throw Error('must not generate a recovery key');}});
 attempts.restore(recovered.scope,recovered.command,recovered.key);
 assert.equal(attempts.begin(scope,command).key,recovered.key);
 assert.equal(createHostSettingsRecovery(data,'d'.repeat(64)).read(host),null);
 assert.equal(store.read('e'.repeat(64)),null,'another owner/Host epoch cannot read the pending draft');
 assert.equal(store.clear(host,'other-save-key'),false);
 assert.equal(store.clear(host,'save-recovery-0001'),true);
 assert.equal(store.read(host),null);
});

test('a recovered original receipt can confirm the revision already seen by the fresh read',()=>{
 const settings={...command.settings,credential_ref:null,voice_provider_id:null};
 const state={snapshot:{settings_version:8,schema_version:2,schema_fingerprint:'c'.repeat(64),write_scope:host,settings},draft:settings,dirty:true,unknownPending:true};
 const receipt={status:'saved',namespace:'jot-session-adapter',settings_version:8,settings:command.settings,activation:{state:'unknown'},
  active_run_impact:{state:'unknown',active_runs:null,active_sessions:null,current_sessions_restarted:null},
  migration:{state:'not_required',from_schema_version:null,to_schema_version:2},safe_boundary:{state:'unknown'}};
 const saved=hostSettingsWriteCandidateSaved(state,receipt,7);
 assert.equal(saved.dirty,false);assert.equal(saved.unknownPending,false);assert.equal(saved.snapshot.settings_version,8);assert.equal(saved.activation,'unknown');
 assert.deepEqual(saved.activeRunImpact,{active_runs:null,active_sessions:null,current_sessions_restarted:null});
 assert.equal(hostSettingsWriteCandidateSaved(state,receipt,8).dirty,true,'a result must advance the original expected revision');
});

test('a new owner write scope never inherits the previous owner draft or pending state',()=>{
 const settings={...command.settings,credential_ref:null,voice_provider_id:null};
 const previous={snapshot:{settings_version:7,schema_version:2,write_scope:host,settings},draft:{...settings,mode:'agent'},dirty:true,unknownPending:true};
 const next=hostSettingsReloadSucceeded(previous,{...previous.snapshot,write_scope:'e'.repeat(64)});
 assert.equal(next.draft.mode,'demo');assert.equal(next.unknownPending,false);assert.equal(next.dirty,false);
});

test('recovery refuses unsafe bodies and does not replace an unresolved command',()=>{
 const data=storage(),store=createHostSettingsRecovery(data,task);
 assert.throws(()=>store.write({scope,command:{...command,settings:{...command.settings,credential_ref:'must-never-persist'}},key:'save-recovery-0001'}),/recovery_invalid/);
 assert.equal(data.rows.size,0);
 store.write({scope,command,key:'save-recovery-0001'});
 assert.throws(()=>store.write({scope,command:{...command,settings:{...command.settings,mode:'agent'}},key:'save-recovery-0002'}),/recovery_pending/);
 assert.deepEqual(store.read(host).command,command);
});

test('corrupt or unavailable browser receipts stop a new dispatch',()=>{
 const data=storage(),store=createHostSettingsRecovery(data,task);
 store.write({scope,command,key:'save-recovery-0001'});
 data.rows.set([...data.rows.keys()][0],'{broken');
 assert.throws(()=>store.read(host),/recovery_invalid/);
 assert.throws(()=>store.write({scope,command,key:'save-recovery-0001'}),/recovery_invalid/);
 const unavailable=createHostSettingsRecovery({getItem:()=>null,setItem:()=>{throw Error('quota');},removeItem:()=>{}},task);
 assert.throws(()=>unavailable.write({scope,command,key:'save-recovery-0001'}),/recovery_unavailable/);
});
