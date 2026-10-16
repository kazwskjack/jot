import test from 'node:test';import assert from 'node:assert/strict';
import {SessionControllerClient} from '../../src/harness/session-controller-client.ts';
const validate=(await import('../../src/harness/ordinary-completion.ts').catch(()=>({}))).validateOrdinaryCompletion;
const scope={run_id:'run-a',execution_lease:{owner:'worker-a',generation:1}},commands=['cmd-a'];
const complete={protocol:1,status:'complete',run_id:'run-a',session_id:'session-a',execution_lease:scope.execution_lease,input_sha256:'a'.repeat(64),command_ids:commands,native_message_ids:['root-native','command-native'],answer_sha256:'b'.repeat(64),answer_seq:5,turn_end_seq:6,snapshot_seq:7,execution_authorized:false};
test('ordinary completion validates exact native identity and sequence without granting execution',()=>{
 assert.equal(typeof validate,'function');assert.deepEqual(validate(complete,'session-a',scope,commands),complete);
 for(const patch of [{run_id:'foreign'},{command_ids:[]},{execution_authorized:true},{turn_end_seq:5},{native_message_ids:['same','same']},{owner_id:'forged'}])assert.throws(()=>validate({...complete,...patch},'session-a',scope,commands));
 assert.equal(validate({protocol:1,status:'busy',wait_for:'events',execution_authorized:false},'session-a',scope,commands).status,'busy');
});
test('ordinary completion transport carries original lease and explicit command identities only',async()=>{
 const calls=[],client=new SessionControllerClient('http://127.0.0.1:18841','t'.repeat(32),async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return Response.json(complete);});
 assert.equal(typeof client.inputCompletion,'function');await client.inputCompletion('session-a',scope,commands);assert.ok(calls[0].url.endsWith('/input-completion'));assert.deepEqual(calls[0].body,{ordinary_input:scope,command_ids:commands});
 await assert.rejects(()=>client.inputCompletion('session-a',{...scope,owner_id:'forged'},commands));assert.equal(calls.length,1);
});

test('Runner retains the exact iterator when completion proof shows a later command is running',async()=>{
 const {createHash}=await import('node:crypto');let proofs=0,follows=0,published=0;const lease={owner:'worker-a',generation:1},client={create:async()=>({}),prompt:async()=>({accepted:true}),inputCompletion:async()=>++proofs===1?{protocol:1,status:'busy',wait_for:'events',execution_authorized:false}:{protocol:1,status:'complete',run_id:'run-a',session_id:'session-a',execution_lease:lease,input_sha256:'a'.repeat(64),command_ids:['cmd-a'],native_message_ids:['root-native','cmd-native'],answer_sha256:createHash('sha256').update('New answer').digest('hex'),answer_seq:6,turn_end_seq:7,snapshot_seq:8,execution_authorized:false},async *follow(){follows++;yield{type:'snapshot',cursor:0,records:[]};yield{type:'event',event:{seq:2,type:'assistant/message',data:{message:{content:[{type:'text',text:'Old answer'}]}}}};yield{type:'event',event:{seq:3,type:'turn/end',data:{reason:{kind:'completed'}}}};yield{type:'event',event:{seq:6,type:'assistant/message',data:{message:{content:[{type:'text',text:'New answer'}]}}}};yield{type:'event',event:{seq:7,type:'turn/end',data:{reason:{kind:'completed'}}}};}};
 const {OfficialSessionRunner}=await import('../../src/harness/official-session-runner.ts');const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'}),result=await runner.run({enabled:true,taskRequestId:'run-a',sessionRef:'session-a',message:'Original',deferCompletionProbe:true,originalAdmission:{executionLease:lease},ordinaryCompletion:{executionLease:lease,commands:()=>['cmd-a'],publish:async candidate=>{published++;assert.equal(candidate.final_text,'New answer');return true;}}});
 assert.equal(result.final_text,'New answer');assert.equal(follows,1);assert.equal(published,1);assert.equal(proofs,2);
});

test('Runner retries product acknowledgement settlement without another native stream or prompt',async()=>{
 const {createHash}=await import('node:crypto');let commits=0,follows=0,proofs=0;const lease={owner:'worker-a',generation:1},proof={protocol:1,status:'complete',run_id:'run-a',session_id:'session-a',execution_lease:lease,input_sha256:'a'.repeat(64),command_ids:[],native_message_ids:['root-native'],answer_sha256:createHash('sha256').update('Answer').digest('hex'),answer_seq:2,turn_end_seq:3,snapshot_seq:4,execution_authorized:false};
 const client={create:async()=>({}),prompt:async()=>({accepted:true}),inputCompletion:async()=>{proofs++;return proof;},async *follow(){follows++;yield{type:'snapshot',cursor:0,records:[]};yield{type:'event',event:{seq:2,type:'assistant/message',data:{message:{content:[{type:'text',text:'Answer'}]}}}};yield{type:'event',event:{seq:3,type:'turn/end',data:{reason:{kind:'completed'}}}};}};
 const {OfficialSessionRunner}=await import('../../src/harness/official-session-runner.ts');const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'jot-general'});assert.equal((await runner.run({enabled:true,taskRequestId:'run-a',sessionRef:'session-a',message:'Original',deferCompletionProbe:true,originalAdmission:{executionLease:lease},ordinaryCompletion:{executionLease:lease,commands:()=>[],publish:async()=>++commits>1}})).final_text,'Answer');assert.equal(commits,2);assert.equal(proofs,2);assert.equal(follows,1);
});
