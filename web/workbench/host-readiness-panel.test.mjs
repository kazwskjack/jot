import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {connectHostReadiness,jotCapabilityFacts,readinessNamespace,readinessRequestIsCurrent,workspacePermissionLabel,workspaceWritePermissionLabel} from './host-readiness-ui.mjs';
import {createHostAdminClient} from './host-admin-client.mjs';

const workbenchRoot=fileURLToPath(new URL('.',import.meta.url));
const output=fileURLToPath(new URL('../../.test-tmp/host-readiness-panel-test/',import.meta.url));
await mkdir(output,{recursive:true});
await build({entryPoints:[join(workbenchRoot,'HostReadinessPanel.tsx')],bundle:true,format:'cjs',platform:'node',external:['react'],outfile:join(output,'HostReadinessPanel.cjs'),logLevel:'silent'});
await build({entryPoints:[join(workbenchRoot,'OnboardingPanel.tsx')],bundle:true,format:'cjs',platform:'node',external:['react'],outfile:join(output,'OnboardingPanel.cjs'),logLevel:'silent'});
const require=createRequire(import.meta.url);
const {default:HostReadinessPanel}=require(join(output,'HostReadinessPanel.cjs'));
const {default:OnboardingPanel}=require(join(output,'OnboardingPanel.cjs'));

test('readiness requires exactly one safe advertised namespace',()=>{
  assert.equal(readinessNamespace(['agent-default-model']),'agent-default-model');
  assert.equal(readinessNamespace([]),null);
  assert.equal(readinessNamespace(['agent-default-model','jot-session-adapter']),null);
  assert.equal(readinessNamespace(['jot-host-policy']),null);
  assert.equal(readinessNamespace(['../private']),null);
});

test('Jot capability facts keep mode policy, execution configuration and workspace app flags separate',()=>{
  assert.deepEqual(jotCapabilityFacts({
    conversation_modes:{default:'chat',work:{supported:true},chat:{ready:true}},
    workbench:{enabled:true,execution_ready:false},
    file_read:true,file_edit:false,
    workspaces:[
      {workspace_id:'workspace-main',title:'Workspace Main',can_read:true,can_write:false},
      {workspace_id:'C:\\private\\workspace',title:'private path',can_read:true,can_write:true}
    ],
    voice:{enabled:true,status:'ready'}
  }),{
    conversation_mode_default:'chat',work_mode_supported:true,chat_policy:'available',
    workbench_api_enabled:true,execution_gate_enabled:false,file_read_capability:true,file_edit_capability:false,
    adapter_lifecycle:'unknown',
    workspaces:[{workspace_id:'workspace-main',title:'Workspace Main',gateway_can_read:true,gateway_can_write:false,os_read:'unknown',os_write:'unknown'}],
    voice:{enabled:true,status:'ready'}
  });
});

test('mounting the readiness panel performs no request and offers an explicit owner approval action',()=>{
  const calls=[];
  const client={approveSettingsRead:async()=>{calls.push('approve');return{approved:true,namespaces:['agent-default-model']};},readiness:async namespace=>{calls.push(['readiness',namespace]);return{};}};
  const jotCapabilities={conversation_modes:{default:'chat',work:{supported:true},chat:{ready:true}},workbench:{enabled:true,execution_ready:false},workspaces:[{workspace_id:'workspace-main',title:'Workspace Main',can_read:true,can_write:false}],voice:{enabled:true,status:'ready'}};
  const markup=renderToStaticMarkup(React.createElement(HostReadinessPanel,{enabled:true,namespaces:['agent-default-model'],client,jotCapabilities}));
  assert.deepEqual(calls,[]);
  assert.match(markup,/由宿主授权并读取状态/);
  assert.match(markup,/Jot\/Gateway/);
  assert.match(markup,/Gateway 应用层/);
  assert.match(markup,/Gateway 应用层：读取可读 · 写入不可写/);
  assert.match(markup,/Gateway file_read\/file_edit 声明/);
  assert.match(markup,/OS 读取\/写入权限：未知/);
  assert.match(markup,/<dt>Worker 心跳<\/dt><dd>未知/);
  assert.match(markup,/<dt>通用 Adapter 生命周期<\/dt><dd>未知/);
  assert.match(markup,/未知|未验证|不支持/);
});

test('only an exact one-namespace owner approval can call the readiness endpoint',async()=>{
  const calls=[];
  const published=[];
  const client={
    approveSettingsRead:async()=>{calls.push('approve');return{approved:true,namespaces:['agent-default-model']};},
    readiness:async namespace=>{calls.push(['readiness',namespace]);return{protocol:1,scope:{namespace}};}
  };
  assert.deepEqual(await connectHostReadiness({client,namespace:'agent-default-model',onReadiness:value=>published.push(value)}),{protocol:1,scope:{namespace:'agent-default-model'}});
  assert.deepEqual(calls,['approve',['readiness','agent-default-model']]);
  assert.deepEqual(published,[{protocol:1,scope:{namespace:'agent-default-model'}}]);

  for(const namespaces of [[],['agent-default-model','jot-session-adapter'],['jot-session-adapter']]){
    calls.length=0;
    published.length=0;
    const denied={...client,approveSettingsRead:async()=>({approved:true,namespaces})};
    await assert.rejects(connectHostReadiness({client:denied,namespace:'agent-default-model',onReadiness:value=>published.push(value)}),/HOST_READINESS_APPROVAL_SCOPE_MISMATCH/);
    assert.deepEqual(calls,[],'scope mismatch must stop before any readiness request');
    assert.deepEqual(published,[null],'an approval failure clears previously published onboarding data');
  }
});

test('a readiness DTO from a different namespace is never published',async()=>{
 const published=[];
 const client={
  approveSettingsRead:async()=>({approved:true,namespaces:['agent-default-model']}),
  readiness:async()=>({protocol:1,scope:{namespace:'other-models'}})
 };
 await assert.rejects(connectHostReadiness({client,namespace:'agent-default-model',onReadiness:value=>published.push(value)}),/HOST_READINESS_SCOPE_MISMATCH/);
 assert.deepEqual(published,[null]);
});

test('a late readiness result is discarded after its approved client or namespace changes',()=>{
 const clientA={},clientB={};
 const request={enabled:true,namespace:'agent-default-model',client:clientA,scopeKey:'task-a'};
 assert.equal(readinessRequestIsCurrent(request,{enabled:true,namespace:'agent-default-model',client:clientA,scopeKey:'task-a'}),true);
 assert.equal(readinessRequestIsCurrent(request,{enabled:true,namespace:'agent-default-model',client:clientA,scopeKey:'task-b'}),false);
 assert.equal(readinessRequestIsCurrent(request,{enabled:true,namespace:'other-models',client:clientA,scopeKey:'task-a'}),false);
 assert.equal(readinessRequestIsCurrent(request,{enabled:true,namespace:'agent-default-model',client:clientB,scopeKey:'task-a'}),false);
 assert.equal(readinessRequestIsCurrent(request,{enabled:false,namespace:'agent-default-model',client:clientA,scopeKey:'task-a'}),false);
});

test('a readiness scope denial stays sanitized and permission gaps remain unknown',async()=>{
  const client={approveSettingsRead:async()=>({approved:true,namespaces:['agent-default-model']}),readiness:async()=>({ok:false,reason:'namespace_forbidden'})};
  await assert.rejects(connectHostReadiness({client,namespace:'agent-default-model'}),/HOST_READINESS_SCOPE_DENIED/);
  assert.equal(workspacePermissionLabel(null),'未知');
  assert.equal(workspaceWritePermissionLabel(null),'未知');
  assert.equal(workspacePermissionLabel(true),'可读');
  assert.equal(workspacePermissionLabel(false),'不可读');
});

test('readiness client places only the encoded exact namespace in the request URL',async()=>{
  const calls=[];
  const client=createHostAdminClient(async(...args)=>{calls.push(args);return{};});
  const signal=new AbortController().signal;
  await client.readiness('agent-default-model',signal);
  assert.deepEqual(calls.map(([path,method])=>[path,method]),[['/host/readiness?namespace=agent-default-model','GET']]);
  assert.equal(calls[0][4],signal);
  assert.equal(JSON.stringify(calls).includes('actor'),false);
  assert.equal(JSON.stringify(calls).includes('ticket'),false);
  assert.equal(JSON.stringify(calls).includes('token'),false);
});

test('onboarding selectors consume the authorized readiness DTO without exposing the credential reference',()=>{
  const draft={mode:'agent',workspace_id:'workspace-main',provider_id:'provider-main',model_id:'model-a',credential_ref:'credential-reference-private'};
  const state={snapshot:{version:1,schema_version:1,current_step:'workspace',draft,last_receipt_id:null,last_error_code:null},
    currentStep:'workspace',draft,loading:false,saving:false,dirty:true,conflict:false,error:'',notice:''};
  const readiness={workspace:{items:[{workspace_id:'workspace-main',title:'Workspace Main',can_read:true,can_write:false}]},
    providers:[{provider_id:'provider-main',selected_model_id:'model-a',model_ids:['model-a'],credential_ref_present:null,state:'unsupported',reason_codes:['provider_test_required']}]};
  const markup=renderToStaticMarkup(React.createElement(OnboardingPanel,{enabled:true,state,readiness,onDraftChange(){},onUseHostDraft(){},onReload(){},onSave(){}}));
  assert.match(markup,/Workspace Main/);
  assert.match(markup,/provider-main/);
  assert.match(markup,/model-a/);
  assert.match(markup,/provider_test_required/);
  assert.match(markup,/凭据由 Host 管理/);
  assert.doesNotMatch(markup,/credential-reference-private/);
  const saveState={...state,currentStep:'save',snapshot:{...state.snapshot,current_step:'save'}};
  const saveMarkup=renderToStaticMarkup(React.createElement(OnboardingPanel,{enabled:true,state:saveState,readiness,settingsApplyAvailable:true,
    onDraftChange(){},onUseHostDraft(){},onReload(){},onSave(){},onApplySettings(){}}));
  assert.match(saveMarkup,/应用设置到 Host/);
  assert.match(saveMarkup,/凭据引用由 Host 管理/);
});
