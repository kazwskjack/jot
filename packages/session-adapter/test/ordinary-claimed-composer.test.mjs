import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const create=(await import('../ordinary-claimed-composer.js').catch(()=>({}))).createOrdinaryClaimedSessionComposer;
const canonical=value=>JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
function fixture(){
 const binding={runId:'run-a',sessionRef:'session-a',executionLease:{owner:'worker-a',generation:2}},authority={protocol:1,run_id:'run-a',request_id:'run-a',input_message_id:'product-a',conversation_id:'conversation-a',owner_id:'owner-a',session_id:'session-a',execution_lease:binding.executionLease,input_sha256:'a'.repeat(64),execution_authorized:false};
 const message={id:'native-a',role:'user',source:{kind:'user',rpcId:'run-a'},content:[{type:'text',text:'Original synthetic input.'}]};
 const header={id:'session-a',createdAt:1234,agentPreset:'jot-general',isSeeded:false},events=[['agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]}],['turn/start',{turn:1}],['agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]}],['turn/end',{turn:1,reason:{kind:'interrupted'}}],['session/end-seed',{}]].map(([type,data],seq)=>({type,data,seq,surfaceOp:'append'}));
 const project=view=>{const inbox={'next-step':[],'next-turn':[]};for(const e of view.snapshotEvents())if(e.type==='agent/inbox/spliced')inbox[e.data.target].splice(e.data.start,e.data.removedCount??0,...e.data.inserted);return inbox;};
 const session={id:'session-a',header,inheritedEventCount:0,firstLiveSeq:4,get seq(){return events.length;},snapshotEvents:()=>events};
 const agent={id:'session-a',status:'idle',session,inbox:{get nextStep(){return project(session)['next-step'];},get nextTurn(){return project(session)['next-turn'];},splice:(target,start,removedCount,inserted)=>events.push({type:'agent/inbox/spliced',seq:events.length,data:{target,start,removedCount,inserted},surfaceOp:'append'})}};
 class Detached{static create(id,seed,meta){const log=[...seed];if(log.at(-1)?.type!=='session/end-seed')log.push({type:'session/end-seed',seq:log.length,data:{}});return new Detached(id,seed.length,log,meta);}constructor(id,firstLiveSeq,log,header){Object.assign(this,{id,firstLiveSeq,seq:log.length,header,snapshotEvents:()=>log});}}
 const profile={protocol:1,profile_id:'ordinary-profile',preset_id:'jot-general',audit_id:'original-audit',fingerprint:'b'.repeat(64)},admission={protocol:2,run_id:'run-a',input_message_id:'product-a',conversation_id:'conversation-a',owner_id:'owner-a',session_id:'session-a',session_created_at:1234,input_sha256:'a'.repeat(64),native_message_id:'native-a',native_message_sha256:createHash('sha256').update(canonical(message)).digest('hex'),profile_fingerprint:'b'.repeat(64)};
 let reads=0;
 const options={binding,bridge:{request:async(path,b,body)=>{assert.equal(path,'ordinary-input-binding');assert.deepEqual(b,binding);assert.deepEqual(body,{});reads++;return {binding:structuredClone(authority)};}},ordinaryPresets:new Set(['jot-general']),profile:{read:async()=>({...profile})},admissions:{entryReservationProtocol:1,readReplayCandidate:async({session:subject,runId,messageId})=>{assert.equal(subject,session);assert.equal(runId,'run-a');assert.equal(messageId,'native-a');return structuredClone(admission);}},Session:Detached,agents:{get:()=>undefined},sessions:{get:()=>undefined},query:{readSession:async()=>({session:header,inheritedEventCount:0,events:events.slice(0,5)})},projections:{snapshot:view=>({asOfSeq:view.seq-1,values:{inbox:project(view)}})},validateLog:async()=>({validated:true}),signal:new AbortController().signal};
 return{options,agent,message,authority,profile,admission,events,reads:()=>reads};
}
function composition(){
 const f=fixture(),hooks=new Map();let resident;
 f.options.ctx={agentLoop:{jotPreSetupHookProtocol:2},on:(name,fn)=>{hooks.set(name,fn);return()=>hooks.delete(name);}};
 f.options.agents.get=()=>resident;f.options.sessions.get=()=>resident?.session;
 const resolve=async(middle=()=>{})=>{const payload={agent:f.agent,source:'resume',signal:new AbortController().signal,bindAbortSignal(){}};await hooks.get('agent/before-setup')(payload);await middle();await hooks.get('agent/after-setup')(payload);resident=f.agent;return{agent:f.agent};};
 return{...f,hooks,resolve};
}
test('scoped ordinary factory restores through original before/after setup without execution',async()=>{
 assert.equal(typeof create,'function');const f=composition(),composer=create(f.options);
 const result=await composer.withResolution({binding:f.options.binding,signal:f.options.signal},()=>f.resolve());
 assert.equal(result.value.agent,f.agent);assert.equal(result.recovery.execution_authorized,false);assert.equal(result.recovery.restored,1);assert.deepEqual(result.pending,{'next-step':[],'next-turn':[f.message]});assert.deepEqual(f.agent.inbox.nextTurn,[f.message]);assert.equal(f.events.some(e=>e.type==='user/message'),false);await composer.dispose();
});
test('ordinary factory refuses startup, reserved entries and post-setup changes before publication',async()=>{
 for(const kind of ['startup','reserved','profile','message','lease','missing-after']){const f=composition(),composer=create(f.options);
 if(kind==='reserved')f.options.admissions.readReplayCandidate=async()=>{throw Error('ordinary_input_entry_reserved');};
 const operation=async()=>{if(kind==='startup'){await f.hooks.get('agent/before-setup')({agent:f.agent,source:'startup',signal:f.options.signal,bindAbortSignal(){}});return;}
 if(kind==='missing-after'){await f.hooks.get('agent/before-setup')({agent:f.agent,source:'resume',signal:f.options.signal,bindAbortSignal(){}});return{agent:f.agent};}
 return f.resolve(()=>{if(kind==='profile')f.profile.fingerprint='c'.repeat(64);if(kind==='message')f.message.content[0].text='changed';if(kind==='lease')f.authority.execution_lease={owner:'replacement',generation:3};});};
 await assert.rejects(composer.withResolution({binding:f.options.binding,signal:f.options.signal},operation),undefined,kind);assert.equal(f.options.agents.get('session-a'),undefined);await composer.dispose();}
});
test('factory cancellation releases caller and keeps a fence on late original setup',async()=>{
 const f=composition(),composer=create(f.options),abort=new AbortController();let release,entered;const hold=new Promise(r=>release=r),reached=new Promise(r=>entered=r);
 const work=composer.withResolution({binding:f.options.binding,signal:abort.signal},async()=>{entered();await hold;return f.resolve();});const rejected=assert.rejects(work);await reached;abort.abort();await rejected;assert.ok(f.hooks.has('agent/before-setup'));release();await new Promise(r=>setImmediate(r));assert.deepEqual(f.agent.inbox.nextTurn,[]);await composer.dispose();assert.equal(f.hooks.size,0);
});


test('original setup cannot replace the restored Session instance or its header before publication',async()=>{
 for(const kind of ['session','header']){const f=composition(),composer=create(f.options);await assert.rejects(composer.withResolution({binding:f.options.binding,signal:f.options.signal},()=>f.resolve(()=>{if(kind==='session')f.agent.session={...f.agent.session};else f.agent.session.header.createdAt++;})),undefined,kind);assert.equal(f.options.agents.get('session-a'),undefined);await composer.dispose();}
});
