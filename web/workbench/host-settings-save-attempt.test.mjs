import assert from 'node:assert/strict';
import test from 'node:test';
import {createHostSettingsSaveAttempt,hostSettingsSaveCommand} from './host-settings-save-attempt.mjs';

test('unknown settings outcome retains one key for the exact scope and command',()=>{
  const keys=['save-key-0001','save-key-0002'];
  const attempts=createHostSettingsSaveAttempt({createKey:()=>keys.shift()});
  const command={expected_version:7,expected_schema_fingerprint:'f'.repeat(64),settings:{mode:'demo',workspace_id:'workspace-a',provider_id:'provider-a',model_id:'model-a',plugin_selection:[]}};
  const scope={task_scope:'a'.repeat(64),settings_version:7,schema_version:2};
  const first=attempts.begin(scope,command);
  assert.equal(first.key,'save-key-0001');
  assert.equal(attempts.markUnknown(scope,command,first.key),true);
  const recovery=attempts.begin(scope,command);
  assert.equal(recovery.key,first.key);
  assert.equal(recovery.status,'unknown_pending');
  assert.equal(attempts.isCurrent(scope,command,first.key),true);

  const otherScope=attempts.begin({...scope,task_scope:'b'.repeat(64)},command);
  assert.equal(otherScope.key,'save-key-0002');
  assert.equal(attempts.isCurrent(scope,command,first.key),false,'old scope response is no longer current');
});

test('a changed settings version or patch gets a new save key',()=>{
  const keys=['save-key-0001','save-key-0002','save-key-0003'];
  const attempts=createHostSettingsSaveAttempt({createKey:()=>keys.shift()});
  const scope={task_scope:'a'.repeat(64),settings_version:7,schema_version:2};
  const base={expected_version:7,expected_schema_fingerprint:'f'.repeat(64),settings:{mode:'agent'}};
  assert.equal(attempts.begin(scope,base).key,'save-key-0001');
  assert.equal(attempts.begin({...scope,settings_version:8},{...base,expected_version:8}).key,'save-key-0002');
  assert.equal(attempts.begin(scope,{...base,settings:{mode:'demo'}}).key,'save-key-0003');
});

test('a completed receipt gets a fresh key for a later explicit save',()=>{
  const keys=['save-key-0001','save-key-0002'];
  const attempts=createHostSettingsSaveAttempt({createKey:()=>keys.shift()});
  const scope={task_scope:'a'.repeat(64),settings_version:7,schema_version:2},command={expected_version:7,expected_schema_fingerprint:'f'.repeat(64),settings:{mode:'agent'}};
  const first=attempts.begin(scope,command);
  assert.equal(attempts.settle(scope,command,first.key),true);
  assert.equal(attempts.isCurrent(scope,command,first.key),true,'the scheduled UI state update can still verify the completed response');
  assert.equal(attempts.begin(scope,command).key,'save-key-0002');
});

test('the controlled save command excludes credential references and non-editable provider fields',()=>{
  const command=hostSettingsSaveCommand({settings_version:7,schema_fingerprint:'f'.repeat(64)},{mode:'agent',workspace_id:'workspace-a',provider_id:'provider-a',model_id:'model-a',plugin_selection:[],credential_ref:'old-opaque-ref',voice_provider_id:'voice-a'});
  assert.deepEqual(command,{expected_version:7,expected_schema_fingerprint:'f'.repeat(64),settings:{mode:'agent',workspace_id:'workspace-a',provider_id:'provider-a',model_id:'model-a',plugin_selection:[]}});
  assert.equal(JSON.stringify(command).includes('old-opaque-ref'),false);
  assert.throws(()=>hostSettingsSaveCommand({settings_version:7},{mode:'agent',workspace_id:'workspace-a',provider_id:'provider-a',model_id:'model-a',plugin_selection:[]}),/host_settings_save_input_invalid/);
});
