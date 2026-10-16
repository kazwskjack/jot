import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {SessionControllerClient} from '../../src/harness/session-controller-client.ts';
import {ordinaryHistorySourceSha256} from '../../src/harness/ordinary-steering-observation.ts';
const mod=await import('../../src/harness/ordinary-run-completion.ts').catch(()=>({}));
const scope={owner_id:'u',conversation_id:'c',run_id:'r',expected_run_version:4};
const source={protocol:1,kind:'ordinary_run_history',owner_id:'u',conversation_id:'c',session_id:'s',run_id:'r',run_version:4,commands:[{command_id:'cmd',command_status:'pending'}],execution_authorized:false};
const answer={seq:8,type:'assistant/message',data:{turn:1,step:1,message:{content:[{type:'reasoning',text:'Synthetic reasoning'},{type:'text',text:'Synthetic answer'}]}}};
const view={protocol:1,kind:'ordinary_run_completion',run_id:'r',session_id:'s',run_version:4,source_sha256:ordinaryHistorySourceSha256(source),raw_sha256:'a'.repeat(64),raw_event_count:11,profile_fingerprint:'b'.repeat(64),command_ids:['cmd'],native_message_ids:['native-root','native-cmd'],answer_sha256:createHash('sha256').update('Synthetic answer').digest('hex'),answer_seq:8,turn_end_seq:10,answer_event:answer,output_events:[{seq:7,type:'deliverables/presented',data:{files:[{path:'outputs/report.pdf'}]}}],execution_authorized:false};
test('full completion validates complete command coverage, native identity and settled answer hash without execution authority',()=>{
 assert.equal(typeof mod.validateOrdinaryRunCompletion,'function');assert.deepEqual(mod.validateOrdinaryRunCompletion(view,'s',scope,source),view);
 for(const patch of [{protocol:2},{kind:'ordinary_steer_observation'},{execution_authorized:true},{run_id:'other'},{session_id:'other'},{run_version:5},{source_sha256:'0'.repeat(64)},{raw_event_count:10},{command_ids:[]},{command_ids:['cmd','cmd']},{native_message_ids:['same','same']},{answer_sha256:'c'.repeat(64)},{answer_seq:9},{output_events:[{seq:7,type:'user/message',data:{}}]},{output_events:[{seq:11,type:'tool/result',data:{}}]},{execution_lease:{owner:'old',generation:1}}])assert.throws(()=>mod.validateOrdinaryRunCompletion({...view,...patch},'s',scope,source));
});
test('Gateway full completion client binds the exact source snapshot and rejects stale/foreign results before any publication',async()=>{
 const calls=[],client=new SessionControllerClient('http://127.0.0.1:18841','t'.repeat(32),async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return Response.json(view);});
 assert.equal(typeof client.observeRunCompletion,'function');assert.deepEqual(await client.observeRunCompletion('s',scope,source),view);assert.ok(calls[0].url.endsWith('/sessions/s/run-history-completion'));assert.deepEqual(calls[0].body,{history:scope,source_sha256:ordinaryHistorySourceSha256(source)});
 for(const body of [{...scope,expected_run_version:'4'},{...scope,session_ref:'foreign'},{...scope,execution_lease:{owner:'old',generation:1}}])await assert.rejects(()=>client.observeRunCompletion('s',body,source));for(const patch of [{owner_id:'other'},{session_id:'other'},{run_version:5},{execution_authorized:true}])await assert.rejects(()=>client.observeRunCompletion('s',scope,{...source,...patch}));assert.equal(calls.length,1);
 const wrong=new SessionControllerClient('http://127.0.0.1:18841','t'.repeat(32),async()=>Response.json({...view,source_sha256:'0'.repeat(64)}));await assert.rejects(()=>wrong.observeRunCompletion('s',scope,source));
});
