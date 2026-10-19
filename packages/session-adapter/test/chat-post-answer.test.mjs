import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAdapterHandler,apply} from '../index.js';
const impl=await import('../chat-post-answer.js').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
function fixture(){
 const scope={owner_id:'owner',conversation_id:'conversation',run_id:'run',session_ref:'session',expected_run_version:4};
 const source={protocol:1,kind:'chat_compaction_source',owner_id:'owner',conversation_id:'conversation',run_id:'run',session_id:'session',run_version:4,policy:{mode:'chat',thinking:'disabled',context_revision:'checkpoint-text-v2'},model:{provider:'fixture',model:'fast',reasoning_effort:'off'},execution_authorized:false};
 const intent={protocol:1,intent_id:'intent',run_id:'run',source_sha256:digest(source),source,execution_authorized:false},state={prepared:0,inspected:0,called:0,recovered:0,receipt:null,current:null,wait:async()=>{},run:async()=>({status:'compacted'})};
 const agent={id:'session',session:{id:'session',header:{agentPreset:'jot-chat'}},whenIdle:()=>state.wait(),status:'idle',inbox:{nextStep:[],nextTurn:[]}};state.current=agent;
 const options={agents:{get:id=>id==='session'?state.current:undefined},bridge:{request:async(path,binding,body,signal)=>{signal.throwIfAborted();assert.deepEqual(binding,{runId:'run',sessionRef:'session'});assert.deepEqual(body.scope,undefined);if(path==='chat-compaction-source'){assert.equal(body.action,'prepare');state.prepared++;return{intent:structuredClone(intent)};}assert.equal(path,'chat-compaction-attempt');assert.equal(body.action,'inspect');state.inspected++;return{attempt:{protocol:1,kind:'chat_compaction_attempt_inspection',intent_id:'intent',owner_id:'owner',conversation_id:'conversation',run_id:'run',run_version:4,session_id:'session',source_sha256:intent.source_sha256,source:structuredClone(source),receipt:state.receipt,native_witness:null,execution_authorized:false}};}},manager:{run:async request=>{state.called++;assert.deepEqual(request.scope,scope);assert.equal(request.intent_id,'intent');assert.equal(request.source_sha256,intent.source_sha256);assert.equal(Object.hasOwn(request,'execution_lease'),false);request.signal.throwIfAborted();return state.run(request);}},recover:async request=>{state.recovered++;assert.deepEqual(request.scope,scope);return{status:'already_published'};}};
 return{scope,intent,source,state,agent,options};
}

test('post-answer acceptance is detached, coalesces exact in-flight notifications and delegates only to the original manager',async()=>{
 assert.equal(typeof impl.createChatPostAnswer,'function');const f=fixture();let release;f.state.wait=()=>new Promise(resolve=>release=resolve);const service=impl.createChatPostAnswer(f.options),request={scope:f.scope,signal:new AbortController().signal},a=service.notify(request),b=service.notify(request);assert.deepEqual(a.receipt,b.receipt);assert.equal(a.done,b.done);assert.equal(a.receipt.status,'accepted');assert.equal(a.receipt.execution_authorized,false);
 while(!release)await new Promise(resolve=>setImmediate(resolve));assert.equal(f.state.called,0);assert.equal(f.state.prepared,1);assert.equal(f.state.inspected,1);release();assert.equal((await a.done).status,'compacted');assert.equal(f.state.called,1);await service.dispose();
});

test('a prior attempt always uses original recovery, including a failed or ambiguous recovery, without new inference',async()=>{
 assert.equal(typeof impl.createChatPostAnswer,'function');for(const failure of [false,true]){const f=fixture();f.state.receipt={state:'usage_unknown'};f.state.current=undefined;if(failure)f.options.recover=async()=>{f.state.recovered++;throw Error('partial native result');};const service=impl.createChatPostAnswer(f.options),job=service.notify({scope:f.scope});if(failure)await assert.rejects(job.done);else assert.equal((await job.done).status,'already_published');assert.equal(f.state.called,0);assert.equal(f.state.recovered,1);await service.dispose();}
});

test('foreign, changed, legacy or non-Chat sources never dispatch and cannot mutate the caller scope',async()=>{
 assert.equal(typeof impl.createChatPostAnswer,'function');for(const mode of ['scope','source','legacy','thinking','model','work','cold','busy','pending']){const f=fixture();if(mode==='scope')f.scope.owner_id='other';if(mode==='source')f.intent.source_sha256='a'.repeat(64);if(mode==='legacy')f.source.policy.context_revision='bounded-text-v1';if(mode==='thinking')f.source.policy.thinking='enabled';if(mode==='model')f.source.model.reasoning_effort='high';if(mode==='work')f.agent.session.header.agentPreset='jot-general';if(mode==='cold')f.state.current=undefined;if(mode==='busy')f.agent.status='running';if(mode==='pending')f.agent.inbox.nextTurn.push({});const before=structuredClone(f.scope),service=impl.createChatPostAnswer(f.options);await assert.rejects(service.notify({scope:f.scope}).done,undefined,mode);assert.deepEqual(f.scope,before);assert.equal(f.state.called,0);await service.dispose();}
});

test('accepted jobs survive the notification request closing, while shutdown aborts and drains their own idle wait',async()=>{
 assert.equal(typeof impl.createChatPostAnswer,'function');const f=fixture();let release;f.state.wait=()=>new Promise(resolve=>release=resolve);const service=impl.createChatPostAnswer(f.options),request=new AbortController(),job=service.notify({scope:f.scope,signal:request.signal});request.abort();while(!release)await new Promise(resolve=>setImmediate(resolve));release();await job.done;assert.equal(f.state.called,1);await service.dispose();
 const g=fixture();let waiting=false;g.state.wait=()=>{waiting=true;return new Promise(()=>{});};const stopped=impl.createChatPostAnswer(g.options),pending=stopped.notify({scope:g.scope});while(!waiting)await new Promise(resolve=>setImmediate(resolve));await stopped.dispose();await assert.rejects(pending.done);assert.equal(g.state.called,0);assert.throws(()=>stopped.notify({scope:g.scope}));
});

test('a new input or changed Agent while awaiting idle cannot start maintenance; another run cannot inherit a pending job',async()=>{
 assert.equal(typeof impl.createChatPostAnswer,'function');for(const mode of ['agent','input']){const f=fixture();let release;f.state.wait=()=>new Promise(resolve=>release=resolve);const service=impl.createChatPostAnswer(f.options),job=service.notify({scope:f.scope});while(!release)await new Promise(resolve=>setImmediate(resolve));assert.throws(()=>service.notify({scope:{...f.scope,run_id:'other'}}));if(mode==='agent')f.state.current={...f.agent};else f.agent.inbox.nextTurn.push({});release();await assert.rejects(job.done);assert.equal(f.state.called,0);await service.dispose();}
});

test('post-answer transport is exact, bearer-only and acknowledges acceptance without awaiting maintenance',async()=>{
 const token='test-original-chat-post-answer-token-2026',f=fixture();let called=0;const handler=createAdapterHandler({token,chatPostAnswer:{notify:value=>{called++;assert.deepEqual(value.scope,f.scope);return{receipt:{protocol:1,status:'accepted',execution_authorized:false},done:new Promise(()=>{})};}}}),{session_ref,...history}=f.scope,body={history},url=new URL('http://127.0.0.1/v1/sessions/'+session_ref+'/chat-post-answer'),invoke=(payload=body,auth=token)=>handler({method:'POST',url,headers:{authorization:'Bearer '+auth},body:payload});
 assert.equal((await invoke(body,'wrong')).status,401);assert.equal((await invoke({...body,execution_lease:{owner:'expired',generation:1}})).status,422);assert.equal(called,0);assert.equal((await invoke()).status,202);assert.equal(called,1);assert.equal((await createAdapterHandler({token})({method:'POST',url,headers:{authorization:'Bearer '+token},body})).status,503);assert.equal((await handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/%ZZ/chat-post-answer'),headers:{authorization:'Bearer '+token},body})).status,422);
 for(const config of [{ordinaryChatCompactionAuto:true},{ordinaryChatCompactionAuto:'yes'}])assert.throws(()=>apply({},config),/chat_post_answer_config_invalid/);
});

test('internal completion observation contains bounded metadata only and cannot change an already finished operation',async()=>{
 for(const failure of [false,true]){const f=fixture(),observed=[];f.state.run=async()=>{if(failure)throw Error('private failure text');return{status:'compacted',result:{summary:'private summary body'}};};f.options.onSettled=value=>{observed.push(value);throw Error('observer failed');};const service=impl.createChatPostAnswer(f.options),job=service.notify({scope:f.scope});if(failure)await assert.rejects(job.done);else assert.equal((await job.done).status,'compacted');assert.equal(observed.length,1);assert.equal(observed[0].status,failure?'unconfirmed':'compacted');assert.ok(!JSON.stringify(observed).includes('private'));assert.equal(observed[0].execution_authorized,false);await service.dispose();}
});
