import test from 'node:test';import assert from 'node:assert/strict';
import {createAdapterHandler} from '../index.js';
const create=(await import('../ordinary-input-run-host.js').catch(()=>({}))).createOrdinaryInputRunHost;
const wire={run_id:'run-a',execution_lease:{owner:'worker-a',generation:2}};
function fixture(options={}){
 const calls=[],hooks=new Map(),message={id:'native-a',role:'user',source:{kind:'user',rpcId:'run-a'},content:[{type:'text',text:'Original'}]};let agent,allowed=true,hold=false,release;
 const candidate={id:'session-a',session:{id:'session-a',seq:4,snapshotEvents:()=>[]},status:'idle',inbox:{nextStep:[],nextTurn:[message],prepend:(_target,m)=>candidate.inbox.nextStep.unshift(m)},ctx:{get:()=>({disarm:()=>calls.push('disarm')}),on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);}},jotPendingInputProtocol:1,jotPendingWakeRevocationProtocol:1,jotResumePending:request=>{calls.push('wake');candidate.token=Symbol();return Object.defineProperty({accepted:true,messageIds:request.messageIds,seq:request.seq},'wakeToken',{value:candidate.token});},jotRevokePendingWake:token=>{assert.equal(token,candidate.token);calls.push('revoke-wake');return true;},cancel:()=>{calls.push('cancel');candidate.status='idle';},runMaintenance:async fn=>{calls.push('maintenance');const value=await fn(new AbortController().signal);if(hold)await new Promise(r=>release=r);return value;}};
 const controller={projections:async()=>({values:{agentPreset:'jot-general',goal:null,inbox:{'next-turn':[message],'next-step':[]}}}),inspect:async()=>({meta:{id:'session-a'},events:[{seq:0,type:'session/end-seed',data:{}}]}),resolveAgent:async()=>{calls.push('resolve');agent=candidate;return{agent};},async *follow(_body,signal){calls.push('follow');yield{type:'snapshot',cursor:3,records:[]};calls.push('advance');await new Promise(r=>{if(signal.aborted)r();else signal.addEventListener('abort',r,{once:true});});}};
 const bridge={request:async()=>{if(!allowed)throw Error('revoked');return{binding:{protocol:1,run_id:'run-a',request_id:'run-a',input_message_id:'product-a',conversation_id:'conv-a',owner_id:'owner-a',session_id:'session-a',execution_lease:wire.execution_lease,input_sha256:'a'.repeat(64),execution_authorized:false}};}};
 assert.equal(typeof create,'function');const host=create({controller,agents:{get:()=>agent},bridge,ordinaryPresets:new Set(['jot-general']),verifyComposition:async()=>({verified:true,fingerprint:'b'.repeat(64)}),inputAdmissionHost:{entryReservationProtocol:1,adoptRecovered:async()=>({execution_authorized:false,message_ids:['native-a']})},...options});
 return{host,controller,candidate,calls,hooks,revoke:()=>allowed=false,hold:()=>hold=true,release:()=>release?.(),abort:new AbortController()};
}
async function open(f){const stream=f.host.follow('session-a',wire,{address:{kind:'session',sessionId:'session-a'}},f.abort.signal);assert.equal((await stream.next()).value.type,'snapshot');return stream;}
test('original input HTTP resume requires its parked observer and invokes native wake without prompting',async()=>{
 const f=fixture();await assert.rejects(()=>f.host.resume('session-a',wire),/ordinary_input_/);const stream=await open(f);assert.ok(!f.calls.includes('advance'));assert.ok(!f.calls.includes('resolve'));const ack=await f.host.resume('session-a',wire);assert.equal(ack.accepted,true);assert.equal(ack.run_id,'run-a');assert.equal(ack.input_message_id,'product-a');assert.deepEqual(await f.host.resume('session-a',wire),ack);assert.equal(f.calls.filter(x=>x==='wake').length,1);f.abort.abort();await stream.return();assert.ok(f.calls.includes('revoke-wake'));await f.host.dispose();
});
test('lease loss rejects model and tool entry, cancels only its owned native work and retains original claim',async()=>{
 const f=fixture(),stream=await open(f);await f.host.resume('session-a',wire);f.candidate.status='running';f.candidate.inbox.nextTurn=[];f.revoke();
 const result=await f.hooks.get('agent/pre-step')({agent:f.candidate,signal:new AbortController().signal,messages:[{id:'native-a',role:'user',source:{kind:'user',rpcId:'run-a'},content:[{type:'text',text:'Original'}]}]},async()=>{throw Error('must not enter');});assert.deepEqual(result,{kind:'reject'});assert.equal(f.candidate.inbox.nextStep[0].id,'native-a');assert.ok(f.calls.includes('cancel'));f.abort.abort();await stream.return();await f.host.dispose();
});
test('a foreign later human after native idle releases the old observer instead of rejecting the new task',async()=>{
 const f=fixture(),stream=await open(f);await f.host.resume('session-a',wire);f.hooks.get('agent/status')({agent:f.candidate,status:'idle'});f.candidate.status='running';let entered=0;const result=await f.hooks.get('agent/pre-step')({agent:f.candidate,messages:[{id:'new-human',role:'user',source:{kind:'user',rpcId:'other-run'}}],signal:new AbortController().signal},async()=>{entered++;return{kind:'enter'};});assert.equal(result.kind,'enter');assert.equal(entered,1);assert.ok(!f.calls.includes('cancel'));await stream.return();await f.host.dispose();
});
test('HTTP recovery rejects disabled or mixed control paths without invoking the ordinary Controller',async()=>{
 const handler=createAdapterHandler({token:'t'.repeat(32),controller:{follow:()=>{throw Error('must not fall through');}}}),headers={authorization:'Bearer '+'t'.repeat(32)};
 assert.equal((await handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/session-a/input-resume'),headers,body:{ordinary_input:wire}})).status,503);
 assert.equal((await handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/session-a/follow'),headers,body:{ordinary_input:wire,goal_control:{}}})).status,422);
});


test('disconnect during native maintenance revokes its exact wake before cancelling and does not acknowledge execution',async()=>{
 const f=fixture(),stream=await open(f);f.hold();const pending=f.host.resume('session-a',wire),rejected=assert.rejects(pending,/ordinary_input_/);while(!f.calls.includes('wake'))await new Promise(r=>setImmediate(r));f.abort.abort();assert.ok(f.calls.indexOf('revoke-wake')<f.calls.indexOf('cancel'));f.release();await rejected;await stream.return();await f.host.dispose();
});

test('model/tool guards recheck authority and do not invoke a revoked provider',async()=>{
 const f=fixture(),stream=await open(f);await f.host.resume('session-a',wire);f.candidate.status='running';let calls=0;const tool=f.hooks.get('tools/execute'),llm=f.hooks.get('llm/stream');assert.equal(await tool({signal:new AbortController().signal},async()=>++calls),1);f.revoke();const model=llm({sessionId:'session-a',signal:new AbortController().signal},()=>{calls++;return(async function*(){yield{};})();});await assert.rejects(()=>model.next(),/ordinary_input_/);assert.equal(calls,1);f.abort.abort();await stream.return();await f.host.dispose();
});

test('a native wake that throws after latching cannot admit model execution',async()=>{
 const f=fixture(),stream=await open(f),wake=f.candidate.jotResumePending;let invoked=0,modelRejected;
 f.candidate.jotResumePending=request=>{wake(request);const model=f.hooks.get('llm/stream')({sessionId:'session-a',signal:new AbortController().signal},()=>{invoked++;return(async function*(){yield{};})();});modelRejected=assert.rejects(()=>model.next(),/ordinary_input_/);throw Error('synthetic_partial_native_wake');};
 await assert.rejects(()=>f.host.resume('session-a',wire),/synthetic_partial_native_wake/);await modelRejected;assert.equal(invoked,0);f.abort.abort();await stream.return();await f.host.dispose();
});
test('malformed HTTP execution metadata is rejected before opening a native stream',async()=>{
 const handler=createAdapterHandler({token:'t'.repeat(32),controller:{},ordinaryInputRunHost:{follow(){throw Error('must not open');},resume(){throw Error('must not resume');}}});
 for(const path of ['follow','input-resume'])for(const ordinary_input of [{...wire,owner_id:'forged'},{run_id:'run-a',execution_lease:{owner:'worker-a',generation:0}}])assert.equal((await handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/session-a/'+path),headers:{authorization:'Bearer '+'t'.repeat(32)},body:{ordinary_input}})).status,422);
});


test('original recovery adopts the existing admission before native wake and refuses unknown entry',async()=>{
 let adopted=0;const f=fixture({inputAdmissionHost:{entryReservationProtocol:1,adoptRecovered:async({agent,binding})=>{adopted++;assert.equal(agent.id,'session-a');assert.deepEqual(binding,{runId:'run-a',sessionRef:'session-a',executionLease:wire.execution_lease});return{execution_authorized:false,message_ids:['native-a']};}}});const stream=await open(f);await f.host.resume('session-a',wire);assert.equal(adopted,1);assert.equal(f.calls.filter(c=>c==='wake').length,1);f.abort.abort();await stream.return();await f.host.dispose();
 const g=fixture({inputAdmissionHost:{entryReservationProtocol:1,adoptRecovered:async()=>{throw Error('ordinary_input_entry_reserved');}}}),other=await open(g);await assert.rejects(()=>g.host.resume('session-a',wire),/entry_reserved/);assert.ok(!g.calls.includes('wake'));g.abort.abort();await other.return();await g.host.dispose();
});


test('original recovery cannot be constructed without the durable entry admission gate',()=>{
 assert.throws(()=>fixture({inputAdmissionHost:undefined}),/ordinary_input_host_unavailable/);
});
