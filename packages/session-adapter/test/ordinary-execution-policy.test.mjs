import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createOrdinaryExecutionPolicyReader} from '../ordinary-execution-policy.js';
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const chat={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-v1',context_revision:'bounded-v1'};
function fixture(){
 const binding={runId:'run-a',sessionRef:'session-a',executionLease:{owner:'worker-a',generation:1}},authority={protocol:1,run_id:'run-a',request_id:'run-a',input_message_id:'input-a',conversation_id:'conversation-a',owner_id:'owner-a',session_id:'session-a',execution_lease:binding.executionLease,input_sha256:'a'.repeat(64),execution_authorized:false};
 const modelPolicy={...authority,conversation_version:3,model:chat.model,policy_sha256:hash({protocol:1,conversation_version:3,model:chat.model}),resolved_model:null};
 const policy={...chat,conversation_version:3,model_policy_sha256:modelPolicy.policy_sha256},execution={...structuredClone(authority),policy,policy_sha256:hash(policy)},agent={id:binding.sessionRef,session:{id:binding.sessionRef,header:{agentPreset:'jot-chat'}}};
 const f={binding,authority,modelPolicy,policy,execution,agent,checks:0,requests:0};
 f.bridge={request:async(path,scope,body,signal)=>{assert.equal(path,'ordinary-execution-policy');assert.deepEqual(scope,binding);assert.deepEqual(body,{});assert.ok(signal instanceof AbortSignal);f.requests++;return{execution:structuredClone(f.execution)};}};
 f.read=()=>createOrdinaryExecutionPolicyReader({bridge:f.bridge,chatPolicy:chat})({agent,binding,modelPolicy,signal:new AbortController().signal,check:async()=>{f.checks++;}});
 return f;
}
test('native policy reader verifies the original authority, both hashes and exact mounted Chat declaration',async()=>{
 const f=fixture();assert.deepEqual(await f.read(),f.policy);assert.equal(f.requests,1);assert.ok(f.checks>=2);
});
for(const scenario of ['owner','session','lease','policy-hash','model-hash','version','route','preset','thinking','revision','extra'])test('native policy rejects '+scenario+' drift before inference',async()=>{
 const f=fixture();
 if(scenario==='owner')f.execution.owner_id='other';
 if(scenario==='session')f.agent.session.id='other';
 if(scenario==='lease')f.execution.execution_lease.generation=2;
 if(scenario==='policy-hash')f.execution.policy_sha256='0'.repeat(64);
 if(scenario==='model-hash')f.policy.model_policy_sha256='0'.repeat(64);
 if(scenario==='version')f.policy.conversation_version=4;
 if(scenario==='route')f.policy.model={provider:'fixture',model:'other'};
 if(scenario==='preset')f.agent.session.header.agentPreset='jot-general';
 if(scenario==='thinking')f.policy.thinking='provider';
 if(scenario==='revision')f.policy.context_revision='different';
 if(scenario==='extra')f.policy.prompt='untrusted';
 if(scenario!=='policy-hash')f.execution.policy_sha256=hash(f.policy);
 await assert.rejects(()=>f.read(),/ordinary_execution_policy_unconfirmed/);
});
test('late cancellation and malformed host policy never return a usable execution policy',async()=>{
 const f=fixture(),controller=new AbortController();f.bridge.request=async()=>{controller.abort();return{execution:f.execution};};
 const reader=createOrdinaryExecutionPolicyReader({bridge:f.bridge,chatPolicy:chat});
 await assert.rejects(()=>reader({agent:f.agent,binding:f.binding,modelPolicy:f.modelPolicy,signal:controller.signal,check:async()=>{}}));
 for(const value of [null,{...chat,thinking:'enabled'},{...chat,secret:'not-allowed'}])assert.throws(()=>createOrdinaryExecutionPolicyReader({bridge:f.bridge,chatPolicy:value}));
});
