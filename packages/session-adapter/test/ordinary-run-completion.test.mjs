import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const create=(await import('../ordinary-run-completion.js').catch(()=>({}))).createOrdinaryRunCompletionReader;
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const sha=v=>createHash('sha256').update(v).digest('hex');
function fixture(count=2){
 const scope={owner_id:'u',conversation_id:'c',session_ref:'s',run_id:'r',expected_run_version:4};
 const source={protocol:1,kind:'ordinary_run_history',run_id:'r',input_message_id:'input',input_sha256:'a'.repeat(64),owner_id:'u',conversation_id:'c',session_id:'s',run_status:'interrupted',run_version:4,run_state_sha256:'b'.repeat(64),conversation_state_sha256:'c'.repeat(64),session_binding_sha256:'d'.repeat(64),runtime_binding_sha256:null,worker_lease_sha256:null,commands:[],canonical:null,candidates:[],execution_authorized:false};
 const root={id:'native-root',role:'user',source:{kind:'user',rpcId:'r'},content:[{type:'text',text:'Synthetic original'}]};
 const messages=[root];
 for(let i=0;i<count;i++){const id='cmd-'+i,content=[{type:'text',text:'Synthetic supplement '+i}];messages.push({id:'native-'+id,role:'user',source:{kind:'user',rpcId:id},content});source.commands.push({protocol:1,kind:'ordinary_steer_history',owner_id:'u',conversation_id:'c',session_id:'s',run_id:'r',run_version:4,run_status:'interrupted',command_id:id,command_status:'pending',original_input_message_id:'input',input_message_id:'message-'+id,original_input_sha256:source.input_sha256,command_sha256:'e'.repeat(64),input_sha256:'f'.repeat(64),native_content_sha256:sha(JSON.stringify(content)),product_message_present:false,native_acceptance:'unverified',execution_authorized:false,position:i,record_sha256:'1'.repeat(64)});}
 const header={id:'s',createdAt:123,agentPreset:'jot-general',isSeeded:false};
 const events=[['agent/inbox/spliced',{target:'next-turn',start:0,inserted:[root]}],['turn/start',{turn:1}],['step/start',{turn:1,step:1}],...messages.map(m=>['user/message',m]),['assistant/message',{turn:1,step:1,message:{content:[{type:'reasoning',text:'Synthetic reasoning'},{type:'text',text:'Synthetic answer'}]}}],['step/end',{turn:1,step:1}],['turn/end',{turn:1,reason:{kind:'completed'}}]].map(([type,data],seq)=>({seq,type,data,surfaceOp:'append'}));
 const stamps=messages.map((m,i)=>{const c=source.commands[i-1];return{protocol:i?3:2,run_id:'r',input_message_id:i?c.input_message_id:'input',conversation_id:'c',owner_id:'u',session_id:'s',session_created_at:123,input_sha256:i?c.input_sha256:source.input_sha256,native_message_id:m.id,native_message_sha256:sha(canonical(m)),profile_fingerprint:'2'.repeat(64),...(i?{request_id:c.command_id,original_input_message_id:'input',original_input_sha256:source.input_sha256,command_sha256:c.command_sha256,native_content_sha256:c.native_content_sha256}:{})};});
 let opens=0,closes=0;const projected={inbox:{'next-step':[],'next-turn':[]},goal:null};
 const options={bridge:{request:async(path,binding,body)=>{assert.equal(path,'ordinary-run-history');assert.deepEqual(binding,{runId:'r',sessionRef:'s'});assert.deepEqual(body,{owner_id:'u',conversation_id:'c',expected_run_version:4});return{history:structuredClone(source)};}},agents:{get:()=>undefined},sessions:{get:()=>undefined},ordinaryPresets:new Set(['jot-general']),Session:{create:(id,log,meta)=>({id,header:meta,seq:log.length,snapshotEvents:()=>log})},validateLog:async()=>({validated:true}),projections:{snapshot:(session,keys)=>{assert.deepEqual(keys,['inbox','goal']);return{asOfSeq:session.seq-1,values:structuredClone(projected)};}},persistence:{open:async(id,mode)=>{assert.equal(id,'s');assert.equal(mode,'read');opens++;return{header:structuredClone(header),inheritedEventCount:0,read:async()=>({events:structuredClone(events)}),close:async()=>{closes++;}};}},admissions:{entryInspectionProtocol:1,read:async({messageId})=>structuredClone(stamps.find(s=>s.native_message_id===messageId)),inspectEntry:async({messageId})=>({protocol:1,state:'unreserved',entry:null,admission_sha256:sha(canonical(stamps.find(s=>s.native_message_id===messageId))),execution_authorized:false})}};
 const request=()=>({scope,expectedSourceSha256:sha(canonical(source)),signal:new AbortController().signal});const resequence=()=>events.forEach((e,i)=>e.seq=i);
 return{scope,source,root,messages,stamps,header,events,options,projected,request,resequence,counts:()=>({opens,closes})};
}

test('full native completion covers original and every supplement and retains settled output events without replay',async()=>{
 assert.equal(typeof create,'function');for(const count of [0,2]){const f=fixture(count),before=canonical(f.events),view=await create(f.options)(f.request());assert.equal(view.kind,'ordinary_run_completion');assert.equal(view.execution_authorized,false);assert.equal(view.source_sha256,sha(canonical(f.source)));assert.deepEqual(view.command_ids,f.source.commands.map(c=>c.command_id));assert.deepEqual(view.native_message_ids,f.messages.map(m=>m.id));assert.equal(view.answer_event.type,'assistant/message');assert.equal(view.answer_event.data.message.content[0].type,'reasoning');assert.equal(view.answer_sha256,sha('Synthetic answer'));assert.equal(canonical(f.events),before);assert.deepEqual(f.counts(),{opens:2,closes:2});}
});

test('missing, late, duplicate or foreign human input cannot certify complete command coverage',async()=>{
 for(const mode of ['missing','late','duplicate','foreign']){const f=fixture();if(mode==='missing')f.events.splice(5,1);if(mode==='late'){const [m]=f.events.splice(5,1);f.events.splice(-2,0,m);}if(mode==='duplicate')f.events.splice(6,0,structuredClone(f.events[5]));if(mode==='foreign')f.events.splice(6,0,{type:'user/message',data:{id:'foreign',role:'user',source:{kind:'user',rpcId:'other'},content:[]}});f.resequence();await assert.rejects(create(f.options)(f.request()),undefined,mode);assert.equal(f.counts().opens,f.counts().closes);}
});

test('raw open boundaries and projected pending or paused/active/blocked Goals never become completion',async()=>{
 for(const mode of ['open-turn','open-step','pending','paused','active','blocked','invalid-projection','logical-closer']){const f=fixture();if(mode==='open-turn')f.events.pop();if(mode==='open-step')f.events.splice(-2,1);if(mode==='pending')f.projected.inbox['next-step'].push(f.messages[1]);if(['paused','active','blocked'].includes(mode))f.projected.goal={goal:{phase:mode}};if(mode==='invalid-projection')delete f.projected.goal;if(mode==='logical-closer'){f.events.pop();f.options.Session.create=(id,log,header)=>{log.push({seq:log.length,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}});return{id,header,seq:log.length,snapshotEvents:()=>log};};}f.resequence();await assert.rejects(create(f.options)(f.request()),undefined,mode);}
});

test('source, profile/admission, attachment and incarnation changes refuse before publication',async()=>{
 for(const mode of ['source-digest','cancelled','attached','session-attached','seeded','profile','admission','incarnation','abort']){const f=fixture(),q=f.request();if(mode==='source-digest')q.expectedSourceSha256='0'.repeat(64);if(mode==='cancelled'){f.source.run_status='cancelled';q.expectedSourceSha256=sha(canonical(f.source));}if(mode==='attached')f.options.agents.get=()=>({});if(mode==='session-attached')f.options.sessions.get=()=>({});if(mode==='seeded')f.header.isSeeded=true;if(mode==='profile')f.stamps[1].profile_fingerprint='3'.repeat(64);if(mode==='admission')f.stamps[1].native_message_sha256='3'.repeat(64);if(mode==='incarnation')f.header.createdAt++;if(mode==='abort')q.signal=AbortSignal.abort();await assert.rejects(create(f.options)(q),undefined,mode);assert.equal(f.counts().opens,f.counts().closes);if(['source-digest','cancelled','attached','session-attached','abort'].includes(mode))assert.equal(f.counts().opens,0);}
});

test('a source or raw-prefix change during admission checks invalidates the complete observation',async()=>{
 for(const mode of ['source','raw']){const f=fixture(),read=f.options.admissions.read;let changed=false;f.options.admissions.read=async q=>{const value=await read(q);if(!changed){changed=true;if(mode==='source')f.source.canonical={message_id:'old',status:'complete',content_sha256:'4'.repeat(64),record_sha256:'5'.repeat(64)};else f.events.push({seq:f.events.length,type:'session/end-seed',data:{}});}return value;};await assert.rejects(create(f.options)(f.request()),undefined,mode);assert.equal(f.counts().opens,f.counts().closes);}
});

test('unmatched tool calls remain unknown; matched outputs and file presentations are retained for existing output interpretation',async()=>{
 for(const complete of [false,true]){const f=fixture(0),call={type:'tool/call',data:{turn:1,step:1,callId:'call-1',name:'file_tool'}};f.events.splice(4,0,call);if(complete)f.events.splice(5,0,{type:'tool/result',data:{turn:1,step:1,message:{source:{callId:'call-1'},content:[{type:'text',text:JSON.stringify({status:'completed',output_version:1,artifact_ref:'artifact-fixture'})}]}}},{type:'deliverables/presented',data:{files:[{path:'outputs/report.pdf',description:'Report'}]}});f.resequence();if(!complete)await assert.rejects(create(f.options)(f.request()));else{const view=await create(f.options)(f.request());assert.deepEqual(view.output_events.map(e=>e.type),['tool/result','deliverables/presented']);}}
});

test('an explicit unknown tool result or an uncommitted foreign claimed input cannot be hidden by closed steps',async()=>{
 for(const mode of ['unknown-tool','foreign-claim']){const f=fixture(0);if(mode==='unknown-tool')f.events.splice(4,0,{type:'tool/call',data:{turn:1,step:1,callId:'call-1'}},{type:'tool/result',data:{turn:1,step:1,error:{code:'TOOL_OUTCOME_UNKNOWN'},message:{source:{callId:'call-1'},isError:true}}});else f.events.splice(4,0,{type:'agent/inbox/spliced',data:{target:'next-step',start:0,inserted:[{id:'foreign-claim',role:'user',source:{kind:'user',rpcId:'foreign'},content:[]}]}},{type:'agent/inbox/spliced',data:{target:'next-step',start:0,removedCount:1,inserted:[]}});f.resequence();await assert.rejects(create(f.options)(f.request()),undefined,mode);}
});

test('a foreign claim between original admission and original commit is also part of the unknown tail',async()=>{
 const f=fixture(0);f.events.splice(3,0,{type:'agent/inbox/spliced',data:{target:'next-step',start:0,inserted:[{id:'foreign-before-root',role:'user',source:{kind:'user',rpcId:'foreign'},content:[]}]}},{type:'agent/inbox/spliced',data:{target:'next-step',start:0,removedCount:1,inserted:[]}});f.resequence();await assert.rejects(create(f.options)(f.request()));
});

test('new unfinished assistant chunks cannot be replaced by an older settled answer',async()=>{
 const f=fixture(0);f.events.splice(-1,0,{type:'step/start',data:{turn:1,step:2}},{type:'assistant/chunk',data:{turn:1,step:2,chunk:{type:'text-delta',text:'Unsettled newer draft'}}},{type:'step/end',data:{turn:1,step:2}});f.resequence();await assert.rejects(create(f.options)(f.request()));
});

test('a supplement committed before its original input cannot borrow that original lineage',async()=>{
 const f=fixture(1);[f.events[3],f.events[4]]=[f.events[4],f.events[3]];f.resequence();await assert.rejects(create(f.options)(f.request()));
});
