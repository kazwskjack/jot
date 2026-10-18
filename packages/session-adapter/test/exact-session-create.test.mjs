import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createAdapterHandler} from '../index.js';

const token='x'.repeat(32),cwd=path.resolve('session-exact-workspace');
class NativeNotFound extends Error{}
function fixture(change={}){
 const calls=[];
 const meta={id:'original-session',cwd,agentPreset:'jot-general',createdAt:1,isSeeded:false,...change.meta};
 let agent=change.resident?{id:'original-session',session:{id:'original-session',header:{...meta}}}:undefined;
 const controller={
  async inspect(id){calls.push('inspect');assert.equal(id,'original-session');if(change.inspectError)throw change.inspectError;if(change.inspectionNull)return null;return{meta:{...meta},events:[{type:'turn/start'}]};},
  async resolveAgent(id){calls.push('resolve');assert.equal(id,'original-session');if(change.resolveError)return{error:change.resolveError};agent={id:'original-session',session:{id:'original-session',header:{...meta,...change.resolvedMeta}}};return{agent};},
  async create(request){calls.push('create');assert.deepEqual(request,{sessionId:'original-session',cwd,agentPreset:'jot-general'});if(change.createdId==='original-session')agent={id:'original-session',session:{id:'original-session',header:{...meta}}};return{sessionId:change.createdId??'minted-session',agentPreset:'jot-general'};},
 };
 const composer=change.composer?{async withCreation(scope,operation){calls.push('composer-enter');assert.equal(scope.sessionId,'original-session');const value=await operation();calls.push('composer-exit');return{value,recovery:{state:'none'}};}}:undefined;
 const bridge=change.composer?{async request(){calls.push('guard');return{context:{}};},async attach(){calls.push('attach');}}:undefined;
 const handler=createAdapterHandler({token,controller,agents:{get:()=>agent},sessions:{get:()=>agent?.session},sessionNotFoundError:NativeNotFound,nativeClaimedComposer:composer,workbenchBridge:bridge});
 return{calls,invoke:()=>handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions'),headers:{authorization:`Bearer ${token}`},body:{session_id:'original-session',cwd,agent_preset:'jot-general',...(composer?{workbench_context:{run_id:'original-run',execution_lease:{owner:'worker',generation:1}}}:{})}})};
}

test('nonblank saved Session resumes the exact original identity without conversation creation',async()=>{
 const f=fixture(),response=await f.invoke();assert.equal(response.status,201);assert.deepEqual(response.value,{sessionId:'original-session',agentPreset:'jot-general'});assert.deepEqual(f.calls,['inspect','resolve']);
});
for(const inspectError of [new NativeNotFound('missing'),Object.assign(Error('missing'),{code:'session/not-found'})])test('only native absence admits creation of the requested exact identity',async()=>{
 const f=fixture({inspectError,createdId:'original-session'}),response=await f.invoke();assert.equal(response.status,201);assert.equal(response.value.sessionId,'original-session');assert.deepEqual(f.calls,['inspect','create']);
});
for(const inspectError of [Error('session not found'),Object.assign(Error('absent'),{name:'ApiSessionNotFound'}),Error('read_failed')])test('unknown inspection failures cannot authorize replacement creation',async()=>{
 const f=fixture({inspectError}),response=await f.invoke();assert.equal(response.status,503);assert.deepEqual(f.calls,['inspect']);
});
for(const meta of [{id:'foreign-session'},{cwd:path.resolve('other-workspace')},{agentPreset:'jot-workbench-budgeted'}])test('saved identity location and preset conflicts reject before native activation',async()=>{
 const f=fixture({meta}),response=await f.invoke();assert.equal(response.status,409);assert.deepEqual(f.calls,['inspect']);
});
for(const code of ['session/not-found','session/agent-busy','session/writer-held','gateway/internal'])test('an inspected Session that cannot resolve never falls back to create',async()=>{
 const f=fixture({resolveError:Object.assign(Error('blocked'),{code})}),response=await f.invoke();assert.equal(response.status,503);assert.deepEqual(f.calls,['inspect','resolve']);
});
for(const resolvedMeta of [{cwd:path.resolve('other-workspace')},{agentPreset:'jot-workbench-budgeted'},{parentSession:'foreign-parent'},{origin:'subagent'},{isSeeded:true},{createdAt:2}])test('native resume cannot substitute saved placement preset or lineage',async()=>{
 const f=fixture({resolvedMeta}),response=await f.invoke();assert.equal(response.status,409);assert.deepEqual(f.calls,['inspect','resolve']);
});
test('absence conflicting with a resident Session cannot authorize create',async()=>{
 const f=fixture({resident:true,inspectError:new NativeNotFound('missing')}),response=await f.invoke();assert.equal(response.status,409);assert.deepEqual(f.calls,['inspect']);
});
test('conversation creation cannot return a newly minted identity as the requested Session',async()=>{
 const f=fixture({inspectError:new NativeNotFound('missing')}),response=await f.invoke();assert.equal(response.status,409);assert.deepEqual(f.calls,['inspect','create']);
});
test('claimed composer and original work lease guard enclose exact Session inspection and resume',async()=>{
 const f=fixture({composer:true}),response=await f.invoke();assert.equal(response.status,201);assert.equal(response.value.sessionId,'original-session');assert.deepEqual(f.calls,['guard','composer-enter','inspect','resolve','composer-exit','attach']);
});

test('unavailable inspection cannot be treated as native absence',async()=>{
 const f=fixture({inspectionNull:true}),response=await f.invoke();assert.equal(response.status,503);assert.deepEqual(f.calls,['inspect']);
});
test('a resident nonblank Session is resolved without replacing its identity',async()=>{
 const f=fixture({resident:true}),response=await f.invoke();assert.equal(response.status,201);assert.equal(response.value.sessionId,'original-session');assert.deepEqual(f.calls,['inspect','resolve']);
});
function concurrentFixture(composerFailure){
 let agent,creates=0,inspections=0,release,entered;
 const hold=new Promise(resolve=>{release=resolve}),started=new Promise(resolve=>{entered=resolve});
 const controller={async inspect(){inspections++;if(!agent)throw new NativeNotFound('absent');return{meta:{...agent.session.header},events:[{type:'turn/start'}]};},async resolveAgent(){return{agent};},async create(){creates++;entered();await hold;if(agent)return{sessionId:'unwanted-minted-session'};agent={id:'original-session',session:{id:'original-session',header:{id:'original-session',cwd,agentPreset:'jot-general',createdAt:1,isSeeded:false}}};return{sessionId:'original-session',agentPreset:'jot-general'};}};
 let compositions=0;
 const nativeClaimedComposer=composerFailure?{async withCreation({signal},operation){
  const pending=operation();pending.catch(()=>{});compositions++;
  if(compositions===1){await started;if(composerFailure==='abort')await new Promise((resolve,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});throw Error('native_claim_composer_deadline');}
  return{value:await pending};
 }}:undefined;
 const workbenchBridge=composerFailure?{async request(){return{context:{}};},async attach(){}}:undefined;
 const handler=createAdapterHandler({token,controller,agents:{get:()=>agent},sessions:{get:()=>agent?.session},sessionNotFoundError:NativeNotFound,nativeClaimedComposer,workbenchBridge});
 const invoke=signal=>handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions'),headers:{authorization:`Bearer ${token}`},body:{session_id:'original-session',cwd,agent_preset:'jot-general',...(composerFailure?{workbench_context:{run_id:'original-run',execution_lease:{owner:'worker',generation:1}}}:{})},...(signal?{signal}:{})});
 return{invoke,started,release,counts:()=>({creates,inspections})};
}

test('concurrent exact Session admission reinspects after the first create and never mints a replacement',async()=>{
 const f=concurrentFixture(),first=f.invoke();await f.started;const second=f.invoke();await new Promise(resolve=>setImmediate(resolve));f.release();
 const responses=await Promise.all([first,second]);assert.deepEqual(responses.map(row=>row.status),[201,201]);assert.deepEqual(responses.map(row=>row.value.sessionId),['original-session','original-session']);assert.equal(f.counts().creates,1);
});
test('aborting queued exact admission cannot dispatch create or block later admission',async()=>{
 const f=concurrentFixture(),first=f.invoke();await f.started;const abort=new AbortController(),second=f.invoke(abort.signal);abort.abort();
 const cancelled=assert.rejects(second,error=>error.name==='AbortError');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.counts().creates,1);f.release();await cancelled;assert.equal((await first).status,201);
 assert.equal((await f.invoke()).status,201);assert.deepEqual(f.counts(),{creates:1,inspections:2});
});

for(const failure of ['deadline','abort'])test('composer '+failure+' response retains dispatched native creation until it settles',async()=>{
 const f=concurrentFixture(failure),abort=new AbortController(),first=f.invoke(abort.signal).then(value=>({value}),error=>({error}));await f.started;
 if(failure==='abort')abort.abort();const outcome=await first;if(failure==='abort')assert.equal(outcome.error?.name,'AbortError');else assert.equal(outcome.value.status,503);
 const second=f.invoke();
 try{await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.counts(),{creates:1,inspections:1});}
 finally{f.release();await second;}
 assert.equal((await second).status,201);assert.deepEqual(f.counts(),{creates:1,inspections:2});
});
