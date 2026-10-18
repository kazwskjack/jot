import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOrdinaryModelSelector} from '../ordinary-model-selection.js';
import {apply} from '../index.js';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function fixture(model={provider:'fixture',model:'chosen',reasoning_effort:'high'}){
 const binding={runId:'run-a',sessionRef:'session-a',executionLease:{owner:'worker-a',generation:1}};
 const authority={protocol:1,run_id:'run-a',request_id:'run-a',input_message_id:'input-a',conversation_id:'conversation-a',owner_id:'owner-a',session_id:'session-a',execution_lease:binding.executionLease,input_sha256:'a'.repeat(64),execution_authorized:false};
 const policy={...authority,conversation_version:3,model,policy_sha256:createHash('sha256').update(canonical({protocol:1,conversation_version:3,model})).digest('hex'),resolved_model:null};
 const agent={id:'session-a',session:{id:'session-a'}},state={current:undefined},installed=[],calls=[];
 const f={agent,binding,policy,installed,calls,defaultEffort:'low',binds:0,checks:0,registered:agent};
 const bridge={request:async(path,scope,payload)=>{
  assert.equal(scope.runId,binding.runId);assert.deepEqual(scope.executionLease,binding.executionLease);
  if(path==='ordinary-input-binding')return{binding:structuredClone(authority)};
  assert.equal(path,'ordinary-model-policy');
  if(payload.action==='bind'){f.binds++;policy.resolved_model=structuredClone(payload.model);if(f.loseBindReceipt){f.loseBindReceipt=false;throw Error('fixture_response_lost');}}
  return{policy:structuredClone(policy)};
 }};
 const llm={resolveCallConfig:async(config,signal)=>{calls.push({config,signal});return{...config,reasoningEffort:config.reasoningEffort??f.defaultEffort};}};
 const agents={selectionFor:()=>state,selectForNextRequest:(_agent,value)=>{installed.push(value);state.current=value;}};
 f.options={bridge,llm,agents,registry:{get:()=>f.registered}};
 f.invoke=async(signal=new AbortController().signal)=>{const select=createOrdinaryModelSelector(f.options);select.prepareAgent(agent);return select({agent,binding,signal,check:async()=>{f.checks++;}});};
 return f;
}
test('exact owned route and effort are resolved, frozen and selected without changing a global default',async()=>{
 const f=fixture(),controller=new AbortController();await f.invoke(controller.signal);
 assert.deepEqual(f.calls[0],{config:{provider:'fixture',model:'chosen',reasoningEffort:'high'},signal:controller.signal});
 assert.deepEqual(f.installed,[{provider:'fixture',model:'chosen',reasoningEffort:'high'}]);assert.equal(f.binds,1);assert.ok(f.checks>=4);
 await f.invoke();assert.equal(f.binds,1);assert.equal(f.installed.length,1);
});
test('provider default is pinned once and a fresh selector reuses it after defaults change',async()=>{
 const f=fixture({provider:'fixture',model:'chosen'});await f.invoke();assert.equal(f.policy.resolved_model.reasoning_effort,'low');
 f.defaultEffort='high';await f.invoke();assert.equal(f.calls.at(-1).config.reasoningEffort,'low');assert.equal(f.binds,1);
});
for(const scenario of ['owner','hash','extra','route','effort'])test('model selection rejects changed '+scenario+' before installation',async()=>{
 const f=fixture();
 if(scenario==='owner')f.policy.owner_id='another-owner';
 if(scenario==='hash')f.policy.policy_sha256='0'.repeat(64);
 if(scenario==='extra')f.policy.secret='fixture-non-public';
 if(scenario==='route'||scenario==='effort')f.options.llm.resolveCallConfig=async config=>({...config,...(scenario==='route'?{model:'another'}:{reasoningEffort:'low'})});
 await assert.rejects(()=>f.invoke());assert.equal(f.installed.length,0);
});
test('an uncertain resolution receipt is recovered from original storage without repeating the bind',async()=>{
 const f=fixture();f.loseBindReceipt=true;await assert.rejects(()=>f.invoke(),/fixture_response_lost/);assert.equal(f.installed.length,0);assert.equal(f.binds,1);
 await f.invoke();assert.equal(f.binds,1);assert.equal(f.installed.length,1);
});
test('agent replacement during provider resolution prevents binding or model installation',async()=>{
 const f=fixture();f.options.llm.resolveCallConfig=async config=>{f.registered={id:f.agent.id};return config;};
 await assert.rejects(()=>f.invoke());assert.equal(f.binds,0);assert.equal(f.installed.length,0);
});
test('cancellation reaches a pending resolver and no model is selected afterwards',async()=>{
 const f=fixture(),controller=new AbortController(),entered=Promise.withResolvers();
 f.options.llm.resolveCallConfig=async(_config,signal)=>{assert.equal(signal,controller.signal);entered.resolve();return new Promise((done,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));};
 const pending=f.invoke(controller.signal),rejected=assert.rejects(pending,error=>error.name==='AbortError');await entered.promise;controller.abort();await rejected;
 assert.equal(f.binds,0);assert.equal(f.installed.length,0);
});
test('model policy cannot be enabled without original admission and malformed flags fail before setup',()=>{
 for(const config of [{ordinaryModelSelection:true},{ordinaryModelSelection:'true'},{ordinaryModelSelection:1}])assert.throws(()=>apply({},config),/ordinary_model_policy_config_invalid/);
});
