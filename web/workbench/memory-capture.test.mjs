import test from 'node:test';
import assert from 'node:assert/strict';
import {captureMatches,captureSourceView,captureAction,capturePolicyInput} from './memory-capture.mjs';
test('capture review remains bound to the current role and project',()=>{
 assert.equal(captureMatches({agent_id:'a',project_id:'p'},{agent_id:'a',project_id:'p'}),true);assert.equal(captureMatches({agent_id:'b',project_id:'p'},{agent_id:'a',project_id:'p'}),false);
});
test('unavailable sources suppress cached text and invalid batches cannot be approved',()=>{
 assert.equal(captureSourceView({available:false,text:'old secret'}).text,'');
 const value={capture_id:'capture-a',status:'proposed',version:3,policy_current:true,sources:[{available:true}]};assert.deepEqual(captureAction(value,'apply'),{expected_version:3});
 for(const changed of [{policy_current:false},{status:'ready'},{sources:[{available:false}]}])assert.throws(()=>captureAction({...value,...changed},'apply'),/capture_unavailable/);
 assert.deepEqual(captureAction({...value,policy_current:false},'reject'),{expected_version:3});
});
test('policy commands use the current version and contain no identity fields',()=>{
 const input=capturePolicyInput({version:0},true,false,true);assert.deepEqual(input,{expected_version:0,mode:'suggest',include_assistant:false,include_automation:true});
 assert.equal(capturePolicyInput({version:2},false,true,false).mode,'off');
});
