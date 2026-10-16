import test from 'node:test';import assert from 'node:assert/strict';
import {createConversationGoalRunHost} from '../conversation-goal-run-host.js';
const binding={control_id:'control-a',run_id:'run-a',execution_lease:{owner:'worker-a',generation:1}};
const goal={id:'goal-a',revision:3,objective:'Original goal',phase:'paused',activation:'disarmed',maxGoalRounds:10,roundsStarted:1,createdAt:1,updatedAt:2};
function fixture(){
 const calls=[],handlers=new Map();let current={...goal},state='queued',receipt=null,observerId=null,allow=true,created=0,cancelled=0;
 const agent={id:'session-a',status:'idle',session:{id:'session-a'},inbox:{nextTurn:[],nextStep:[]},cancel:()=>{cancelled++;agent.status='idle';},runMaintenance:async fn=>{calls.push('maintenance');return fn(new AbortController().signal)}};
 const goals={get:()=>current,resume:(_a,ref)=>{assert.equal(ref.id,current.id);assert.equal(ref.revision,current.revision);calls.push('resume');current={...current,revision:current.revision+1,phase:'active',activation:'armed'};return current;},disarm:()=>{calls.push('disarm');current={...current,activation:'disarmed'};}};
 agent.ctx={get:name=>{assert.equal(name,'goals');return goals},on:(name,fn)=>{const list=handlers.get(name)||[];list.push(fn);handlers.set(name,list);return()=>handlers.set(name,(handlers.get(name)||[]).filter(x=>x!==fn));}};
 const controller={projections:async()=>{calls.push('projection');return {values:{goal:{goal:current,roundsStarted:1,createdAt:1,updatedAt:2},agentPreset:'jot-general',inbox:{'next-turn':[],'next-step':[]}}}},inspect:async()=>({meta:{id:'session-a'},events:[{seq:0,type:'fixture'}]}),resolveAgent:async()=>{created++;calls.push('resolve');return{agent}},async *follow(_request,signal){calls.push('follow-open');yield {type:'snapshot',cursor:8,records:[],projections:{}};await new Promise(resolve=>{if(signal.aborted)return resolve();signal.addEventListener('abort',resolve,{once:true});});}};
 const bridge={async request(path,b,payload){assert.equal(path,'conversation-goal-control');assert.equal(b.sessionRef,'session-a');assert.equal(b.runId,'run-a');assert.deepEqual(b.executionLease,binding.execution_lease);assert.equal(payload.control_id,'control-a');if(!allow)throw Error('fixture_revoked');calls.push(payload.operation);
  if(payload.operation==='begin'){assert.equal(state,'queued');assert.equal(payload.cursor,8);state='dispatching';observerId=payload.observer_id;return{acquired:true,control:view()};}
  if(payload.operation==='applied'){state='applied';receipt=payload.receipt;return{control:view()};}return{control:view()};
 }};
 const view=()=>({control_id:'control-a',run_id:'run-a',conversation_id:'conversation-a',session_id:'session-a',ref:{id:'goal-a',revision:3},state,observer_id:observerId,native_cursor:state==='queued'?null:8,receipt});
 const registry={get:()=>agent},persistence={flush:async()=>{calls.push('flush')}};
 const host=createConversationGoalRunHost({controller,agents:registry,persistence,bridge,ordinaryPresets:new Set(['jot-general'])});
 return {host,agent,controller,bridge,persistence,calls,handlers,abort:new AbortController(),counts:()=>({created,cancelled}),setState:v=>state=v,setGoal:v=>current=v,revoke:()=>allow=false,current:()=>current,journal:view};
}
async function open(f){const stream=f.host.follow('session-a',binding,{address:{kind:'session',sessionId:'session-a'},assistantStream:true},f.abort.signal);assert.equal((await stream.next()).value.type,'snapshot');return stream;}
test('observed human resume follows first, uses native maintenance and flushes before persisting the receipt',async()=>{
 const f=fixture(),stream=await open(f);const result=await f.host.resume('session-a',binding);assert.equal(result.goal.revision,4);
 assert.ok(f.calls.indexOf('follow-open')<f.calls.indexOf('resolve'));assert.ok(f.calls.indexOf('begin')<f.calls.indexOf('resume'));assert.ok(f.calls.indexOf('resume')<f.calls.indexOf('flush'));assert.ok(f.calls.indexOf('flush')<f.calls.indexOf('applied'));
 assert.deepEqual(await f.host.resume('session-a',binding),result);assert.equal(f.calls.filter(x=>x==='resume').length,1);assert.equal(f.counts().created,1);f.abort.abort();await stream.return();await f.host.dispose();
});
test('a human resume without the exact live follower cannot resolve or activate an Agent',async()=>{
 const f=fixture();await assert.rejects(()=>f.host.resume('session-a',binding),/goal_observer_required/);assert.equal(f.counts().created,0);
 const stream=await open(f);await assert.rejects(()=>f.host.resume('session-a',{...binding,execution_lease:{owner:'other',generation:1}}),/goal_observer_required/);assert.equal(f.counts().created,0);f.abort.abort();await stream.return();await f.host.dispose();
});
test('only one observer may own a Session and a prior dispatch is not rearmed after process-local state is lost',async()=>{
 const f=fixture(),stream=await open(f);const duplicate=f.host.follow('session-a',binding,{address:{kind:'session',sessionId:'session-a'}},new AbortController().signal);await assert.rejects(()=>duplicate.next(),/goal_observer_conflict/);f.setState('dispatching');await assert.rejects(()=>f.host.resume('session-a',binding),/goal_control_dispatch_unknown/);assert.equal(f.counts().created,0);f.abort.abort();await stream.return();await f.host.dispose();
});
test('pending cold input is refused before Agent resolution or dispatch',async()=>{
 const f=fixture(),stream=await open(f),original=f.controller.projections;f.controller.projections=async()=>{const p=await original();p.values.inbox['next-turn'].push({text:'Parked human input'});return p};
 await assert.rejects(()=>f.host.resume('session-a',binding),/goal_cold_input_pending/);assert.equal(f.counts().created,0);assert.equal(f.calls.includes('begin'),false);f.abort.abort();await stream.return();await f.host.dispose();
});
test('disconnect disarms native continuation and cancels its in-flight turn without changing durable phase',async()=>{
 const f=fixture(),stream=await open(f);await f.host.resume('session-a',binding);f.agent.status='running';f.abort.abort();await stream.return();assert.equal(f.current().activation,'disarmed');assert.equal(f.current().phase,'active');assert.equal(f.counts().cancelled,1);await f.host.dispose();
});
test('original step and tool hooks recheck the exact lease without replacing native execution',async()=>{
 const f=fixture(),stream=await open(f);await f.host.resume('session-a',binding);let next=0;const step=f.handlers.get('agent/pre-step')[0],tool=f.handlers.get('tools/execute')[0];
 assert.deepEqual(await step({agent:f.agent,signal:new AbortController().signal},async()=>{next++;return{kind:'accept',messages:[]}}),{kind:'accept',messages:[]});assert.equal(await tool({signal:new AbortController().signal},async()=>{next++;return'original-tool'}),'original-tool');assert.equal(next,2);
 f.revoke();assert.deepEqual(await step({agent:f.agent,signal:new AbortController().signal},async()=>{next++;return{kind:'accept'}}),{kind:'reject'});await assert.rejects(()=>tool({signal:new AbortController().signal},async()=>{next++;}),/goal_control_execution_revoked/);assert.equal(next,2);f.abort.abort();await stream.return();await f.host.dispose();
});

test('Host disposal aborts the original follow and never leaves a live observer behind',async()=>{
 const f=fixture(),stream=await open(f);const pending=stream.next();await f.host.dispose();assert.equal((await pending).done,true);await assert.rejects(()=>f.host.resume('session-a',binding),/goal_observer_required/);
});
test('a lost persisted-receipt acknowledgement is reconciled without another native resume',async()=>{
 const f=fixture(),original=f.bridge.request;let lost=false;f.bridge.request=async(...args)=>{const response=await original(...args);if(args[2].operation==='applied'&&!lost){lost=true;throw Error('fixture_reply_lost');}return response;};
 const stream=await open(f);assert.equal((await f.host.resume('session-a',binding)).goal.revision,4);assert.equal(f.calls.filter(x=>x==='resume').length,1);assert.equal(f.calls.filter(x=>x==='applied').length,1);f.abort.abort();await stream.return();await f.host.dispose();
});

test('adapter exposes observed resume only when its trusted Host is configured',async()=>{
 const {createAdapterHandler}=await import('../index.js'),token='a'.repeat(32),calls=[];
 const invoke=(handler,path,body)=>handler({method:'POST',url:new URL('http://127.0.0.1'+path),headers:{authorization:`Bearer ${token}`},body});
 const disabled=createAdapterHandler({token,controller:{}});assert.deepEqual((await invoke(disabled,'/v1/conversation-goal-resume/readiness',{})).value,{ready:false});assert.equal((await invoke(disabled,'/v1/sessions/session-a/goal-resume',{goal_control:binding})).status,503);
 const host={resume:async(...args)=>{calls.push(args);return {goal}},async *follow(){yield {type:'snapshot',cursor:4}}};
 const handler=createAdapterHandler({token,controller:{},conversationGoalRunHost:host});assert.deepEqual((await invoke(handler,'/v1/conversation-goal-resume/readiness',{})).value,{ready:true});assert.equal((await invoke(handler,'/v1/sessions/session-a/goal-resume',{goal_control:binding})).status,200);assert.deepEqual(calls,[['session-a',binding]]);
 assert.equal((await invoke(handler,'/v1/sessions/session-a/goal-resume',{goal_control:binding,text:'continue'})).status,422);
 const followed=await invoke(handler,'/v1/sessions/session-a/follow',{goal_control:binding,assistant_stream:true});assert.equal((await followed.stream.next()).value.type,'snapshot');await followed.stream.return();
});

test('the native LLM middleware returns an AsyncIterable synchronously and forwards original chunks',async()=>{
 const f=fixture(),stream=await open(f);await f.host.resume('session-a',binding);const llm=f.handlers.get('llm/stream')[0],chunks=llm({sessionId:'session-a',signal:new AbortController().signal},async function*(){yield{type:'original-chunk'};});assert.equal(typeof chunks[Symbol.asyncIterator],'function');const seen=[];for await(const chunk of chunks)seen.push(chunk);assert.deepEqual(seen,[{type:'original-chunk'}]);f.abort.abort();await stream.return();await f.host.dispose();
});

test('concurrent acknowledgements share one native mutation and one dispatch',async()=>{
 const f=fixture(),stream=await open(f);const values=await Promise.all([1,2,3].map(()=>f.host.resume('session-a',binding)));assert.deepEqual(values[0],values[1]);assert.deepEqual(values[1],values[2]);assert.equal(f.calls.filter(x=>x==='resume').length,1);assert.equal(f.calls.filter(x=>x==='begin').length,1);f.abort.abort();await stream.return();await f.host.dispose();
});

test('opt-in Host readiness cannot be constructed from an incomplete native service contract',()=>{
 const f=fixture();assert.throws(()=>createConversationGoalRunHost({controller:{...f.controller,resolveAgent:undefined},agents:{get:()=>f.agent},persistence:{flush:async()=>{}},bridge:f.bridge,ordinaryPresets:new Set(['jot-general'])}),/goal_control_unavailable/);
});

test('an applied old receipt cannot authorize a replacement native Goal or its model call',async()=>{
 const f=fixture(),stream=await open(f);await f.host.resume('session-a',binding);f.setGoal({...f.current(),id:'replacement-goal',revision:1});let called=false;
 const chunks=f.handlers.get('llm/stream')[0]({sessionId:'session-a',signal:new AbortController().signal},async function*(){called=true;yield{type:'must-not-run'};});
 await assert.rejects(async()=>{for await(const _ of chunks){}},/goal_control_execution_revoked/);assert.equal(called,false);assert.equal(f.current().activation,'armed','the old observer must not mutate a replacement Goal');f.abort.abort();await stream.return();await f.host.dispose();
});

test('completion of the same native Goal still permits its original closing answer',async()=>{
 const f=fixture(),stream=await open(f);await f.host.resume('session-a',binding);f.setGoal({...f.current(),revision:5,phase:'complete',activation:'disarmed'});
 const chunks=f.handlers.get('llm/stream')[0]({sessionId:'session-a',signal:new AbortController().signal},async function*(){yield{type:'closing-answer'};});const seen=[];for await(const chunk of chunks)seen.push(chunk);assert.deepEqual(seen,[{type:'closing-answer'}]);f.abort.abort();await stream.return();await f.host.dispose();
});

for(const stage of ['preflight','begin-reply-lost','native-call-threw','native-flush','applied-reply-unconfirmed'])test('resume failure classification keeps native-call knowledge exact: '+stage,async()=>{
 const f=fixture(),original=f.bridge.request,stream=await open(f);
 f.bridge.request=async(...args)=>{const payload=args[2];if(payload.operation==='rejected'){f.setState('rejected');return{control:{...f.journal(),receipt:{rejected:true,mutation:'not_called',reason_code:payload.reason_code}}};}if(stage==='begin-reply-lost'&&payload.operation==='begin'){await original(...args);throw Error('fixture_reply_lost');}if(stage==='applied-reply-unconfirmed'&&payload.operation==='applied')throw Error('fixture_offline');return original(...args)};
 if(stage==='preflight'){const projections=f.controller.projections;f.controller.projections=async()=>{const p=await projections();p.values.inbox['next-turn']=[{text:'pending'}];return p;};}
 if(stage==='native-call-threw'){const goals=f.agent.ctx.get('goals'),resume=goals.resume;goals.resume=(...args)=>{resume(...args);throw Error('fixture_after_native_append')};}
 if(stage==='native-flush')f.persistence.flush=async()=>{throw Error('fixture_flush_failed')};
 await assert.rejects(()=>f.host.resume('session-a',binding));const invoked=f.calls.includes('resume');assert.equal(invoked,['native-call-threw','native-flush','applied-reply-unconfirmed'].includes(stage));assert.equal(f.journal().state,invoked?'dispatching':'rejected');assert.equal(f.calls.includes('applied'),false);assert.equal(f.current().activation,'disarmed');
 await assert.rejects(()=>f.host.resume('session-a',binding));assert.equal(f.calls.filter(x=>x==='resume').length,invoked?1:0);f.abort.abort();await stream.return();await f.host.dispose();
});



test('advancing the product observer cannot trigger official post-snapshot promotion before maintenance',async()=>{
 const f=fixture();f.controller.follow=async function*(_request,signal){f.calls.push('follow-open');yield{type:'snapshot',cursor:8};f.calls.push('follow-promote');await new Promise(resolve=>{if(signal.aborted)return resolve();signal.addEventListener('abort',resolve,{once:true})});};const stream=await open(f),tail=stream.next();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.includes('follow-promote'),false);assert.equal(f.counts().created,0);
 await f.host.resume('session-a',binding);await new Promise(resolve=>setImmediate(resolve));assert.ok(f.calls.indexOf('maintenance')<f.calls.indexOf('follow-promote'));f.abort.abort();assert.equal((await tail).done,true);await f.host.dispose();
});
