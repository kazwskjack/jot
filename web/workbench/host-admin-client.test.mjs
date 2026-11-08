import assert from 'node:assert/strict';
import test from 'node:test';
import {createHostAdminClient} from './host-admin-client.mjs';

test('injected Host client forwards versioned mutations only to the approved routes',async()=>{
 const calls=[],request=async(...args)=>{calls.push(args);return {receipt:{status:'saved'}};};
 const client=createHostAdminClient(request),signal=new AbortController().signal;
 await client.readiness('agent-default-model',signal);await client.settings('agent-default-model',signal);await client.saveSettings('agent-default-model',{expected_version:7,settings:{mode:'agent'}},'key-settings');
 await client.onboarding(signal);await client.saveOnboarding({expected_version:4,current_step:'workspace',draft:{mode:'agent'}},'key-onboarding');
 assert.deepEqual(calls.map(([path,method])=>[path,method]),[
  ['/host/readiness?namespace=agent-default-model','GET'],['/host/settings/editor?namespace=agent-default-model','GET'],['/host/settings?namespace=agent-default-model','PATCH'],['/host/onboarding','GET'],['/host/onboarding','PATCH'],
 ]);
 assert.equal(calls[2][2].expected_version,7);assert.equal(calls[2][3],'key-settings');
 assert.equal(calls[4][2].expected_version,4);assert.equal(calls[4][3],'key-onboarding');
 assert.equal(calls.some(([path,method])=>method==='POST'||/profiles/.test(path)),false);
});

test('Host read approval opens the fixed owner page, checks the popup source and redeems its one-time code',async()=>{
 const state='s'.repeat(43),code='c'.repeat(43),messages=[],calls=[],listeners=new Set(),order=[];
 const popup={closed:false,location:{href:'about:blank'},close(){this.closed=true;},postMessage(data,targetOrigin){messages.push({data,targetOrigin});}};
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window');
 Object.defineProperty(globalThis,'window',{configurable:true,value:{open(url,target,features){order.push('open');assert.equal(url,'about:blank');assert.equal(target,'_blank');assert.match(features,/popup/);return popup;},addEventListener(type,listener){if(type==='message')listeners.add(listener);},removeEventListener(type,listener){if(type==='message')listeners.delete(listener);}}});
 try{
  const client=createHostAdminClient(async(...args)=>{calls.push(['request',...args]);return{};},async(action,input)=>{calls.push([action,input]);if(action==='challenge')return{state,actor_id:'actor-test',dsh_origin:'http://127.0.0.1:44001',bootstrap_path:'/api/jot-host-policy/bootstrap',namespaces:['agent-default-model']};return{approved:true};});
  const resultPromise=client.approveSettingsRead();
  assert.deepEqual(order,['open'],'the popup must open synchronously from the user gesture before network work');
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,[['challenge',undefined]],'the injected bootstrap client owns the challenge request');
  assert.equal(popup.location.href,'http://127.0.0.1:44001/api/jot-host-policy/bootstrap');
  const dispatch=(event)=>{for(const listener of listeners)listener(event);};
  dispatch({source:popup,origin:'http://evil.invalid',data:{type:'jot-host-bootstrap-ready'}});
  dispatch({source:{},origin:'http://127.0.0.1:44001',data:{type:'jot-host-bootstrap-ready'}});
  assert.equal(messages.length,0,'wrong-origin and wrong-window messages do not initialize approval');
  dispatch({source:popup,origin:'http://127.0.0.1:44001',data:{type:'jot-host-bootstrap-ready'}});
  assert.deepEqual(messages,[{data:{type:'jot-host-bootstrap-init',state},targetOrigin:'http://127.0.0.1:44001'}]);
  dispatch({source:popup,origin:'http://127.0.0.1:44001',data:{type:'jot-host-bootstrap-approved',state:'x'.repeat(43),code,namespaces:['agent-default-model']}});
  assert.equal(calls.some(([action])=>action==='redeem'),false,'mismatched state cannot redeem a code');
  dispatch({source:popup,origin:'http://127.0.0.1:44001',data:{type:'jot-host-bootstrap-approved',state,code,namespaces:['agent-default-model']}});
  assert.deepEqual(await resultPromise,{approved:true,namespaces:['agent-default-model']});
  assert.deepEqual(calls,[['challenge',undefined],['redeem',{state,code}]],'the injected bootstrap client redeems only the owner-approved code');
  assert.equal(popup.closed,true);
  assert.equal(listeners.size,0);
 }finally{if(previous)Object.defineProperty(globalThis,'window',previous);else delete globalThis.window;}
});

test('Host namespace reads use one exact configured namespace and never carry an actor or ticket in the URL',async()=>{
 const calls=[],client=createHostAdminClient(async(...args)=>{calls.push(args);return{protocol:1,namespaces:[]};},async()=>({approved:true}));
 await client.namespaceSettings('agent-default-model');
 assert.deepEqual(calls.map(([path,method])=>[path,method]),[['/host/settings?namespace=agent-default-model','GET']]);
 assert.equal(JSON.stringify(calls).includes('ticket'),false);
 assert.equal(JSON.stringify(calls).includes('actor'),false);
});
