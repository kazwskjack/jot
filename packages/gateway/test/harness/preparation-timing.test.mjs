import test from 'node:test';
import assert from 'node:assert/strict';
import {OfficialSessionRunner} from '../../src/harness/official-session-runner.ts';
import {PreparationTiming} from '../../src/harness/preparation-timing.ts';

function client(fail){return{
 create:async()=>{if(fail==='session_confirm')throw Error('private-error-content');return{};},
 prompt:async()=>{if(fail==='prompt_submit')throw Error('private-error-content');return{};},
 async *follow(){if(fail==='opening_snapshot')throw Error('private-error-content');yield{type:'snapshot',cursor:0,records:[],hasMore:false,private:'must-not-log'};yield{type:'event',event:{type:'assistant/message',seq:1,data:{message:{content:[{type:'text',text:'fixture answer'}]}}}};yield{type:'event',event:{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}};}
};}
const input={enabled:true,taskRequestId:'private-run-reference',sessionRef:'private-session-reference',message:'private-question-content',deferCompletionProbe:true};
test('preparation logs measure the three interfaces, attachments and total without recording content',async()=>{
 const records=[];let ready=false;
 const runner=new OfficialSessionRunner(client(),{cwd:'/fixture',agentPreset:'fixture',onPreparationTiming:r=>records.push(r)});
 const result=await runner.run({...input,onReady:()=>{ready=true;assert.equal(records.at(-1).phase,'preparation_total');}});
 assert.equal(result.completed,true);assert.equal(ready,true);assert.deepEqual(records.map(r=>r.phase),['session_confirm','opening_snapshot','attachments','prompt_submit','preparation_total']);
 assert.ok(records.every(r=>r.event==='jot_preparation_timing'&&r.outcome==='succeeded'&&r.mode==='unknown'&&/^[a-f0-9]{64}$/.test(r.run_hash)&&r.duration_ms>=0&&r.offset_ms>=0&&Number.isFinite(Date.parse(r.started_at))));
 assert.equal(records[1].snapshot_records,0);assert.equal(records[1].snapshot_has_more,false);assert.equal(records[2].attachment_count,0);
 assert.doesNotMatch(JSON.stringify(records),/private|must-not-log|fixture answer|Bearer|session_ref|message|token/i);
 const allowed=['event','phase','mode','run_hash','duration_ms','offset_ms','started_at','outcome','snapshot_records','snapshot_has_more','attachment_count'];assert.ok(records.every(r=>Object.keys(r).every(k=>allowed.includes(k))));
});
for(const phase of ['session_confirm','opening_snapshot','prompt_submit'])test('preparation failure retains phase and total but omits the raw error: '+phase,async()=>{
 const records=[],runner=new OfficialSessionRunner(client(phase),{cwd:'/fixture',agentPreset:'fixture',onPreparationTiming:r=>records.push(r)});
 await assert.rejects(()=>runner.run(input),/private-error-content/);assert.equal(records.find(r=>r.phase===phase)?.outcome,'failed');assert.equal(records.at(-1)?.phase,'preparation_total');assert.equal(records.at(-1)?.outcome,'failed');assert.doesNotMatch(JSON.stringify(records),/private-error-content|private-question/);
});
test('a preparation timeout is recorded as cancelled, without changing cancellation behavior',async()=>{
 const records=[],slow={...client(),create:async(_id,_cwd,_preset,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))};
 const runner=new OfficialSessionRunner(slow,{cwd:'/fixture',agentPreset:'fixture',timeoutMs:15,onPreparationTiming:r=>records.push(r)});
 await assert.rejects(()=>runner.run(input),/aborted/);assert.equal(records[0]?.outcome,'cancelled');assert.equal(records.at(-1)?.outcome,'cancelled');
});
test('a failing timing reporter cannot reject an otherwise successful answer',async()=>{
 const result=await new OfficialSessionRunner(client(),{cwd:'/fixture',agentPreset:'fixture',onPreparationTiming:()=>{throw Error('diagnostic sink unavailable');}}).run(input);assert.equal(result.completed,true);
});

test('late answer failure cannot relabel or duplicate an already completed preparation',async()=>{
 const records=[],original=Error('late-private-answer-error');
 const failing={...client(),async *follow(){yield{type:'snapshot',cursor:0,records:[]};throw original;}};
 await assert.rejects(()=>new OfficialSessionRunner(failing,{cwd:'/fixture',agentPreset:'fixture',onPreparationTiming:r=>records.push(r)}).run(input),e=>e===original);
 assert.equal(records.filter(r=>r.phase==='preparation_total').length,1);assert.equal(records.at(-1).outcome,'succeeded');assert.doesNotMatch(JSON.stringify(records),/late-private/);
});

test('ordinary recovery records observation and original recovery without creating or prompting',async()=>{
 const records=[],calls=[],base=client();
 const recovering={...base,create:async()=>{throw Error('no create');},prompt:async()=>{throw Error('no prompt');},recoverInput:async(session,execution)=>{calls.push({session,execution});return{accepted:true,run_id:'recovery-run',session_id:'recovery-session',input_message_id:'product-input',native_message_ids:['native-input']};}};
 const result=await new OfficialSessionRunner(recovering,{cwd:'/fixture',agentPreset:'fixture',onPreparationTiming:r=>records.push(r)}).recoverInput({...input,taskRequestId:'recovery-run',sessionRef:'recovery-session',message:'',originalInput:{inputMessageId:'product-input',executionLease:{owner:'original-worker',generation:2}}});
 assert.equal(result.completed,true);assert.equal(calls.length,1);assert.deepEqual(calls[0].execution,{run_id:'recovery-run',execution_lease:{owner:'original-worker',generation:2}});assert.deepEqual(records.map(r=>r.phase),['opening_snapshot','input_recovery','preparation_total']);
});

test('diagnostic metadata stays bounded and finish emits only once',async()=>{
 const records=[],timer=new PreparationTiming('sensitive-run','work',new AbortController().signal,r=>records.push(r));
 await timer.measure('attachments',async()=>1,()=>({attachment_count:100001,snapshot_records:-1,snapshot_has_more:true,private:'not-loggable'}));timer.finish('succeeded');timer.finish('failed');assert.equal(records.length,2);assert.equal(records[0].mode,'work');assert.equal(records[0].snapshot_has_more,true);assert.equal(records[0].attachment_count,undefined);assert.equal(records[0].snapshot_records,undefined);assert.doesNotMatch(JSON.stringify(records),/sensitive-run|not-loggable/);
});
