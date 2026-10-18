import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const create=(await import('../ordinary-input-admission-host.js').catch(()=>({}))).createOrdinaryInputAdmissionHost;
function fixture(){const attachmentBytes=Buffer.from('synthetic-private-image');const hooks=new Map(),writes=[],binding={runId:'run-a',sessionRef:'session-a',executionLease:{owner:'worker-a',generation:1}},authority={protocol:1,run_id:'run-a',request_id:'run-a',input_message_id:'product-a',conversation_id:'conv-a',owner_id:'owner-a',session_id:'session-a',execution_lease:binding.executionLease,input_sha256:'a'.repeat(64),execution_authorized:false};
 const message={id:'native-a',role:'user',source:{kind:'user',rpcId:'run-a'},content:[{type:'text',text:'Final original message.'},{type:'image',attachment:{attachmentId:'sha256:'+createHash('sha256').update(attachmentBytes).digest('hex'),bytes:attachmentBytes.length,mediaType:'image/png'}}]},events=[];
 const agent={id:'session-a',status:'running',session:{id:'session-a',seq:4,header:{createdAt:1234,agentPreset:'jot-general'},snapshotEvents:()=>events},inbox:{nextStep:[],nextTurn:[],prepend:(_target,m)=>agent.inbox.nextStep.unshift(m)},cancel(cause,options){assert.equal(cause.kind,'parent');assert.equal(options.keepInbox,true);agent.cancelled=true;}};
 const profile={protocol:1,profile_id:'profile-a',preset_id:'jot-general',audit_id:'audit-a',fingerprint:'b'.repeat(64)};
 const options={ctx:{attachments:{readImage:async ref=>({ref,data:attachmentBytes})},sessions:{flush:async()=>true},on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);}},agents:{get:()=>agent},bridge:{request:async()=>({binding:structuredClone(authority)})},profile:{read:async()=>({...profile})},admissions:{entryReservationProtocol:1,reserveEntry:async()=>{},readReplayCandidate:async()=>writes[0],create:async(_session,value)=>{writes.push(structuredClone(value));},read:async()=>writes[0]},ordinaryPresets:new Set(['jot-general'])};return{hooks,writes,binding,authority,message,events,agent,profile,options};}
test('original admission records final native message before response and model entry',async()=>{assert.equal(typeof create,'function');const f=fixture(),host=create(f.options);let release,writing;const pending=new Promise(done=>release=done),entered=new Promise(done=>writing=done);f.options.admissions.create=async(_session,value)=>{f.writes.push(structuredClone(value));writing();await pending;};let model=0,step;
 const response=host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});step=f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:new AbortController().signal},async()=>{model++;return{kind:'enter',messages:[f.message]};});return{accepted:true};});await entered;assert.equal(model,0);assert.equal(f.writes.length,1);release();assert.equal((await response).accepted,true);assert.equal((await step).kind,'enter');assert.equal(model,1);assert.equal(f.writes[0].native_message_id,'native-a');assert.equal(f.writes[0].profile_fingerprint,'b'.repeat(64));assert.ok(!JSON.stringify(f.writes).includes('Final original message'));f.events.push({type:'user/message',data:f.message});f.hooks.get('session/event')(f.agent.session,f.events[0]);await host.dispose();
});
for(const kind of ['store','lease','profile','content'])test('admission refuses '+kind+' before model entry and retains known unentered input',async()=>{assert.equal(typeof create,'function');const f=fixture(),host=create(f.options);if(kind==='store')f.options.admissions.create=async()=>{throw Error('unavailable');};let step,model=0;
 const response=host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});if(kind==='lease')f.authority.execution_lease={owner:'replacement',generation:2};if(kind==='profile')f.profile.fingerprint='c'.repeat(64);if(kind==='content')f.message.content[0].text='Changed';step=f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:new AbortController().signal},async()=>{model++;return{kind:'enter',messages:[f.message]};});return{accepted:true};});await assert.rejects(response);assert.equal((await step).kind,'reject');assert.equal(model,0);assert.equal(f.agent.cancelled,true);assert.equal(f.agent.inbox.nextStep.length,1);await host.dispose();
});
test('an existing RPC requires its original admission; it cannot be certified retrospectively',async()=>{assert.equal(typeof create,'function');const f=fixture(),host=create(f.options);f.events.push({type:'user/message',data:f.message});let called=0;await assert.rejects(host.withPrompt({binding:f.binding},async()=>{called++;return{accepted:true};}));assert.equal(called,0);assert.equal(f.writes.length,0);await host.dispose();});


test('an unexpected human RPC emitted inside original admission cannot enter a model',async()=>{
 const f=fixture(),host=create(f.options);f.message.source.rpcId='foreign-run';let step,model=0;const response=host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});step=f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:new AbortController().signal},async()=>{model++;return{kind:'enter',messages:[f.message]};});return{accepted:true};});await assert.rejects(response);assert.equal((await step).kind,'reject');assert.equal(model,0);assert.equal(f.writes.length,0);await host.dispose();
});
test('native user cancellation during durable admission never resurrects the claimed input',async()=>{
 const f=fixture(),host=create(f.options);let release,started;const pending=new Promise(done=>release=done),writing=new Promise(done=>started=done),abort=new AbortController();f.options.admissions.create=async()=>{started();await pending;};let step,model=0;const response=host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});step=f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:abort.signal},async()=>{model++;return{kind:'enter',messages:[f.message]};});return{accepted:true};});await writing;abort.abort();release();await response;assert.equal((await step).kind,'reject');assert.equal(model,0);assert.equal(f.agent.inbox.nextStep.length,0);assert.ok(!f.agent.cancelled);await host.dispose();
});


test('repeat original admission during native claim returns acceptance without calling Controller again',async()=>{
 const f=fixture(),host=create(f.options);await host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});return{accepted:true};});let called=0;assert.deepEqual(await host.withPrompt({binding:f.binding},async()=>{called++;return{accepted:true};}),{accepted:true});assert.equal(called,0);assert.equal(f.writes.length,1);await host.dispose();
});
test('an original RPC previously removed from inbox cannot be resubmitted as fresh admission',async()=>{
 const f=fixture(),host=create(f.options);f.events.push({type:'agent/inbox/spliced',data:{inserted:[f.message]}});let called=0;await assert.rejects(host.withPrompt({binding:f.binding},async()=>{called++;return{accepted:true};}));assert.equal(called,0);assert.equal(f.writes.length,0);await host.dispose();
});


test('a later pre-step hook cannot replace the original message after its receipt was recorded',async()=>{
 const f=fixture(),host=create(f.options);let step;const response=host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});step=f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:new AbortController().signal},async()=>({kind:'enter',messages:[{...f.message,content:[{type:'text',text:'Replaced after admission'}]}]}));return{accepted:true};});await response;assert.equal((await step).kind,'reject');assert.deepEqual(f.agent.inbox.nextStep[0],f.message);await host.dispose();
});


test('cancellation immediately before prompt scheduling never invokes Controller admission',async()=>{
 const f=fixture(),host=create(f.options),abort=new AbortController();f.agent.session.snapshotEvents=()=>{abort.abort();return[];};let calls=0;await assert.rejects(host.withPrompt({binding:f.binding,signal:abort.signal},async()=>{calls++;return{accepted:true};}));await new Promise(done=>setImmediate(done));assert.equal(calls,0);await host.dispose();
});


test('original native input is durably flushed before its admission receipt is published',async()=>{
 const f=fixture(),host=create(f.options);let nativeFlushed=false,step;f.options.ctx.sessions.flush=async session=>{assert.equal(session,f.agent.session);nativeFlushed=true;return true;};const write=f.options.admissions.create;f.options.admissions.create=async(...args)=>{assert.equal(nativeFlushed,true,'receipt cannot certify an unflushed original native input');return write(...args);};await host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});step=f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:new AbortController().signal},async()=>({kind:'enter',messages:[f.message]}));return{accepted:true};});assert.equal((await step).kind,'enter');assert.equal(f.writes.length,1);await host.dispose();
});


test('an exclusive entry receipt precedes the final enter decision and is fenced by the original lease',async()=>{
 const f=fixture(),host=create(f.options);let reserved=false,step;f.options.admissions.reserveEntry=async(session,stamp,attempt)=>{assert.equal(session,f.agent.session);assert.equal(stamp.native_message_id,'native-a');assert.deepEqual(attempt.execution_lease,f.binding.executionLease);assert.match(attempt.observer_id,/^[a-zA-Z0-9-]+$/);reserved=true;};await host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});step=f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:new AbortController().signal},async()=>{assert.equal(reserved,false);return{kind:'enter',messages:[f.message]};});return{accepted:true};});assert.equal((await step).kind,'enter');assert.equal(reserved,true);await host.dispose();
});
test('a competing entry claim or lease loss during entry persistence cannot admit the step',async()=>{
 for(const mode of ['conflict','lease']){const f=fixture(),host=create(f.options);f.options.admissions.reserveEntry=async()=>{if(mode==='conflict')throw Error('ordinary_input_entry_reserved');f.authority.execution_lease={owner:'replacement',generation:2};};let step;await host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});step=f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:new AbortController().signal},async()=>({kind:'enter',messages:[f.message]}));return{accepted:true};}).catch(error=>assert.match(error.message,/ordinary_input/));assert.equal((await step).kind,'reject');assert.equal(f.agent.inbox.nextStep.length,1);assert.equal(f.agent.cancelled,true);await host.dispose();}
});


test('recovered pending input adopts its existing receipt and reserves a new fenced entry without prompt replay',async()=>{
 const f=fixture(),host=create(f.options);await host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});return{accepted:true};});f.agent.status='idle';f.agent.inbox.nextTurn.push(f.message);const binding={...f.binding,executionLease:{owner:'replacement',generation:2}};f.authority.execution_lease=binding.executionLease;let reserved=0;f.options.admissions.reserveEntry=async(_session,_stamp,attempt)=>{reserved++;assert.deepEqual(attempt.execution_lease,binding.executionLease);};const result=await host.adoptRecovered({agent:f.agent,binding});assert.deepEqual(result,{execution_authorized:false,message_ids:['native-a']});assert.equal(f.writes.length,1);f.agent.inbox.nextTurn=[];const decision=await f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:new AbortController().signal},async()=>({kind:'enter',messages:[f.message]}));assert.equal(decision.kind,'enter');assert.equal(reserved,1);assert.equal(f.writes.length,1);await host.dispose();
});
test('an already reserved original input cannot be adopted by a replacement attempt',async()=>{
 const f=fixture(),host=create(f.options);f.agent.status='idle';f.agent.inbox.nextTurn.push(f.message);f.options.admissions.readReplayCandidate=async()=>{throw Error('ordinary_input_entry_reserved');};await assert.rejects(host.adoptRecovered({agent:f.agent,binding:f.binding}),/entry_reserved/);assert.equal(f.writes.length,0);await host.dispose();
});


test('pending original input adoption refuses unavailable binary references before rebinding or wake',async()=>{
 const f=fixture(),host=create(f.options);await host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});return{accepted:true};});f.agent.status='idle';f.agent.inbox.nextTurn.push(f.message);f.options.ctx.attachments.readImage=async()=>{throw Error('private missing object path');};await assert.rejects(host.adoptRecovered({agent:f.agent,binding:f.binding}),e=>e.message==='ordinary_input_attachments_unconfirmed');assert.equal(f.writes.length,1);assert.equal(f.agent.inbox.nextTurn.length,1);await host.dispose();
});

test('context preparation precedes native entry and preserves the exact admitted message',async()=>{
 const f=fixture();let prepared=false,step;
 f.options.contextSelector=async({agent,binding,check,signal})=>{assert.equal(agent,f.agent);assert.deepEqual(binding,f.binding);assert.ok(signal instanceof AbortSignal);await check();prepared=true;return{startsRequestSeries:true};};
 f.options.admissions.reserveEntry=async()=>{assert.equal(prepared,true);};const host=create(f.options);
 const response=await host.withPrompt({binding:f.binding},async()=>{f.hooks.get('agent/inbox/inserted')({agent:f.agent,message:f.message});step=f.hooks.get('agent/pre-step')({agent:f.agent,messages:[f.message],signal:new AbortController().signal},async()=>({kind:'enter',messages:[f.message]}));return{accepted:true};});
 assert.equal(response.accepted,true);const decision=await step;assert.equal(decision.startsRequestSeries,true);assert.equal(decision.messages[0],f.message);await host.dispose();
});
