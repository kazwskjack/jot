import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeHandoffInboxGate} from '../native-handoff-inbox.js';
function fixture(){
 const events=[],hooks=new Map(),queue=[],guards=new Set();let next=0,maintenance=0;
 const parent={id:'lead',status:'idle',session:{id:'lead',seq:0,eventAt:i=>events[i]},ctx:{on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);},tools:{guard:fn=>{guards.add(fn);return()=>guards.delete(fn);}}},inbox:{get nextTurn(){return queue;},get nextStep(){return [];},prepend:(_target,message)=>{queue.unshift(message);append('agent/inbox/spliced',{target:'next-step',start:0,inserted:[message]});}},runMaintenance:async fn=>{maintenance++;return fn(new AbortController().signal);},whenIdle:()=>{throw Error('must not wait for held driver');}};
 const append=(type,data)=>{events.push({seq:events.length,type,data});parent.session.seq=events.length;};
 const binding=Object.freeze({runId:'root-run',sessionRef:'lead'}),scope={parent,parentBinding:binding,childRunId:'child-run',childSessionRef:'child',roleRef:'reviewer',activeRevision:2};let currentBinding=binding;
 const gate=createNativeHandoffInboxGate({ctx:{effect:()=>{}},bridge:{bindingFor:()=>currentBinding},registry:{get:()=>parent},persistence:{flush:async()=>{}}});
 const enter=async(messages,signal)=>{parent.status='running';append('turn/start',{turn:1});return hooks.get('agent/pre-step')({agent:parent,turn:1,step:1,messages,signal},async()=>{next++;return {kind:'enter',messages};});};
 return {parent,binding,scope,gate,events,hooks,queue,guards,append,enter,setBinding:value=>currentBinding=value,next:()=>next,maintenance:()=>maintenance,receipt:{revision:3,phase:'returned',controller:'lead-role',route:['lead-role','reviewer','lead-role']}};
}
test('a held original step resumes only after its exact control receipt without self-wait or another message',async()=>{
 const f=fixture(),abort=new AbortController(),message={id:'original',source:{kind:'user'}};f.gate.arm(f.scope);f.append('subagent/catalog',{version:0,childId:'child',mode:'continuable'});f.append('team/member',{version:2,teamId:'lead',member:{id:'child',phase:'active'}});const step=f.enter([message],abort.signal);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.next(),0);assert.equal([...f.guards][0](),'NATIVE_HANDOFF_CONTROL_HELD');
 f.append('agent/inbox/spliced',{target:'next-step',start:0,inserted:[{id:'later'}]});
 const result=await f.gate.transition(f.scope,async(_proof,check)=>{check();return {state:f.receipt};});assert.equal(f.maintenance(),0);assert.equal(f.next(),0);
 f.gate.complete({...f.scope,receipt:result.state});assert.deepEqual(await step,{kind:'enter',messages:[message]});assert.equal(f.next(),1);assert.equal(f.guards.size,0);await f.gate.dispose();
});
test('native cancellation restores the same claimed identities once without waking the driver',async()=>{
 const f=fixture(),abort=new AbortController(),one={id:'one',source:{kind:'user'}},two={id:'two',source:{kind:'subagent'}};f.gate.arm(f.scope);const step=f.enter([one,two],abort.signal),rejected=assert.rejects(step,reason=>reason?.kind==='user');
 await new Promise(resolve=>setImmediate(resolve));abort.abort({kind:'user'});await rejected;assert.deepEqual(f.queue,[one,two]);assert.equal(f.next(),0);
 await assert.rejects(f.gate.transition(f.scope,async()=>({state:f.receipt})));assert.deepEqual(f.queue,[one,two]);await f.gate.dispose();
});
test('another binding, execution or appended business event cannot pass a held return boundary',async()=>{
 const f=fixture(),abort=new AbortController();f.gate.arm(f.scope);const step=f.enter([{id:'one',source:{kind:'user'}}],abort.signal);const rejected=assert.rejects(step);await new Promise(resolve=>setImmediate(resolve));
 await assert.rejects(f.gate.transition({...f.scope,childRunId:'other-run'},async()=>{}));
 await assert.rejects(f.gate.transition({...f.scope,parentBinding:{...f.binding}},async()=>{}));
 f.append('tool/call',{callId:'unexpected'});await assert.rejects(f.gate.transition(f.scope,async()=>{}));assert.equal(f.next(),0);abort.abort(Error('stop'));await rejected;await f.gate.dispose();
});
test('an idle protected lead uses native maintenance and accepts queue-only changes',async()=>{
 const f=fixture();f.gate.arm(f.scope);const result=await f.gate.transition(f.scope,async(_proof,check)=>{f.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[{id:'queued'}]});check();return {state:f.receipt};});assert.equal(f.maintenance(),1);f.gate.complete({...f.scope,receipt:result.state});await f.gate.dispose();
});
test('publication metadata for a different member cannot stand in for the protected execution',async()=>{for(const [type,data] of [['subagent/catalog',{version:0,childId:'foreign',mode:'continuable'}],['team/member',{version:2,teamId:'lead',member:{id:'foreign',phase:'active'}}]]){const f=fixture();f.gate.arm(f.scope);f.append(type,data);await assert.rejects(f.gate.transition(f.scope,async()=>({state:f.receipt})));await f.gate.dispose();}});
test('host disposal rejects a held step and restores original input without granting continuation',async()=>{
 const f=fixture();f.gate.arm(f.scope);const message={id:'original',source:{kind:'user'}},step=f.enter([message],new AbortController().signal),rejected=assert.rejects(step);await new Promise(resolve=>setImmediate(resolve));await f.gate.dispose();await rejected;assert.equal(f.next(),0);assert.deepEqual(f.queue,[message]);assert.equal(f.hooks.size,0);
});
test('cancelled protection can be cleared by an exact returned receipt without waking restored input',async()=>{
 const f=fixture(),abort=new AbortController(),message={id:'original',source:{kind:'user'}};f.gate.arm(f.scope);const step=f.enter([message],abort.signal),rejected=assert.rejects(step);await new Promise(resolve=>setImmediate(resolve));abort.abort(Error('cancel'));await rejected;f.parent.status='idle';
 f.gate.complete({...f.scope,receipt:f.receipt});assert.equal(f.guards.size,0);assert.deepEqual(f.queue,[message]);assert.equal(f.next(),0);await f.gate.dispose();
});
test('the same target arm is idempotent and a different execution cannot redirect a held step',async()=>{
 const f=fixture(),abort=new AbortController();f.gate.arm(f.scope);const step=f.enter([{id:'input',source:{kind:'user'}}],abort.signal),rejected=assert.rejects(step);await new Promise(resolve=>setImmediate(resolve));f.gate.arm(f.scope);assert.throws(()=>f.gate.arm({...f.scope,childRunId:'another-child'}));assert.throws(()=>f.gate.arm({...f.scope,activeRevision:4}));abort.abort(Error('stop'));await rejected;await f.gate.dispose();
});
test('a failed return ends the wait with restored input and an observable blocked state',async()=>{
 const f=fixture(),message={id:'original',source:{kind:'user'}};f.gate.arm(f.scope);const step=f.enter([message],new AbortController().signal),rejected=assert.rejects(step);await new Promise(resolve=>setImmediate(resolve));f.gate.fail(f.scope);await rejected;assert.deepEqual(f.queue,[message]);assert.equal(f.gate.statusFor(f.parent,f.binding).state,'blocked');assert.equal(f.next(),0);f.parent.status='idle';f.gate.complete({...f.scope,receipt:f.receipt});assert.equal(f.guards.size,0);await f.gate.dispose();
});

test('reconciliation cannot erase a detected business-log change or substitute a binding',async()=>{
 const f=fixture();f.gate.arm(f.scope);f.append('tool/call',{callId:'unexpected'});await assert.rejects(f.gate.transition(f.scope,async()=>{}));f.gate.fail(f.scope);
 assert.throws(()=>f.gate.complete({...f.scope,receipt:f.receipt}),/inbox_changed/);assert.throws(()=>f.gate.arm(f.scope),/inbox_changed/);assert.throws(()=>f.gate.complete({...f.scope,parentBinding:{...f.binding},receipt:f.receipt}),/scope_changed/);await f.gate.dispose();
});

test('abort before the next fence cannot hide an unchecked business event during reauthorization',async()=>{
 const f=fixture(),abort=new AbortController();f.gate.arm(f.scope);const step=f.enter([{id:'input',source:{kind:'user'}}],abort.signal),rejected=assert.rejects(step);await new Promise(resolve=>setImmediate(resolve));f.append('tool/call',{callId:'unchecked'});abort.abort(Error('cancel'));await rejected;f.parent.status='idle';assert.throws(()=>f.gate.arm(f.scope),/inbox_changed/);assert.throws(()=>f.gate.complete({...f.scope,receipt:f.receipt}),/inbox_changed/);assert.equal(f.guards.size,1);await f.gate.dispose();
});

test('revoked bindings can abort their original local wait but cannot release or read another scope',async()=>{
 for(const replacement of [undefined,{}]){const f=fixture();f.gate.arm(f.scope);const input={id:'input',source:{kind:'user'}},step=f.enter([input],new AbortController().signal),rejected=assert.rejects(step);await new Promise(resolve=>setImmediate(resolve));f.setBinding(replacement);f.gate.fail(f.scope);await rejected;assert.equal(f.next(),0);assert.deepEqual(f.queue,[input]);assert.equal(f.gate.statusFor(f.parent,f.binding).state,'blocked');assert.throws(()=>f.gate.statusFor(f.parent,{}),/scope_changed/);assert.throws(()=>f.gate.complete({...f.scope,receipt:f.receipt}),/inbox_changed/);await f.gate.dispose();}
});

test('a replaced Session never receives the old claimed input',async()=>{
 const f=fixture();f.gate.arm(f.scope);const step=f.enter([{id:'private-old-input',source:{kind:'user'}}],new AbortController().signal),rejected=assert.rejects(step);await new Promise(resolve=>setImmediate(resolve));f.parent.session={id:'new-session',seq:0};f.parent.inbox={nextStep:[],nextTurn:[],prepend:()=>{throw Error('must not restore into replacement');}};f.gate.fail(f.scope);await rejected;assert.deepEqual(f.queue,[]);assert.equal(f.gate.statusFor(f.parent,f.binding).retained_input_count,1);assert.equal(f.next(),0);await f.gate.dispose();
});
