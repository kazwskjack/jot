import test from 'node:test';import assert from 'node:assert/strict';
import {createNativeClaimedSessionComposer} from '../native-claimed-composer.js';
import {createAdapterHandler} from '../index.js';
import {createHash} from 'node:crypto';

function fixture(){
 const hooks=new Map(),events=[],binding={runId:'run',sessionRef:'session',executionLease:{owner:'worker',generation:1}},calls=[];
 const authority={binding,scope:{owner_id:'owner',agent_id:'role',workspace_id:'ws',project_id:'project',capability_epoch:1,run_id:'run',session_ref:'session',task_id:'task',occurrence_id:'occ',task_version:1,generation:1,objective:'Review sources',title:'Review'},mapping:null};
 const profile={protocol:1,profile_id:'profile',preset_id:null,audit_id:'audit',fingerprint:'a'.repeat(64)};
 const agent={id:'session',status:'idle',session:{id:'session',header:{id:'session',cwd:'/workspace'},seq:0,append:(type,data)=>{events.push({type,data});agent.session.seq++;}}};
 const options={ctx:{agentLoop:{jotPreSetupHookProtocol:1},on:(name,fn)=>{hooks.set(name,payload=>fn({bindAbortSignal:()=>{},...payload}));return()=>hooks.delete(name);},effect:()=>{}},bridge:{authorizeNativeResume:async()=>{calls.push('authorize');return structuredClone(authority);}},Session:{create:()=>{}},agents:{get:()=>undefined},sessions:{get:()=>undefined},query:{readSession:async()=>{throw Error('fresh must not read');}},projections:{snapshot:()=>{}},validateLog:async()=>({validated:true}),profile:{read:async()=>profile},provenance:{read:async()=>null,create:async(_session,stamp)=>events.push({type:'host/provenance',data:stamp})}};
 return {options,agent,binding,calls,authority,events,hooks,request:{sessionId:'session',cwd:'/workspace',binding}};
}

test('request authority precedes the original Controller and fresh provenance precedes its setup',async()=>{
 const f=fixture(),composer=createNativeClaimedSessionComposer(f.options);const result=await composer.withCreation(f.request,async()=>{f.calls.push('controller');await f.hooks.get('agent/before-setup')({agent:f.agent,source:'startup',signal:new AbortController().signal});f.calls.push('original-setup');assert.equal(f.events[0].type,'host/provenance');return {sessionId:'session'};});
 assert.equal(f.calls[0],'authorize');assert.ok(f.calls.indexOf('controller')<f.calls.indexOf('original-setup'));assert.deepEqual(result.recovery,{state:'fresh',execution_authorized:false});assert.equal(JSON.stringify(f.events).includes('owner'),false);await composer.dispose();
});

test('missing hook capability, revoked authority and changed target cannot publish a recovery',async()=>{
 const f=fixture();assert.throws(()=>createNativeClaimedSessionComposer({...f.options,ctx:{...f.options.ctx,agentLoop:{}}}));
 const composer=createNativeClaimedSessionComposer(f.options);await assert.rejects(composer.withCreation(f.request,async()=>({sessionId:'session'})),/hook_missing/);assert.equal(f.events.length,0);
 await assert.rejects(composer.withCreation(f.request,async()=>f.hooks.get('agent/before-setup')({agent:{...f.agent,id:'other'},source:'startup',signal:new AbortController().signal})),/scope_changed/);assert.equal(f.events.length,0);await composer.dispose();
});

test('an authorization change or caller cancellation before provenance prevents all writes',async()=>{
 for(const variant of ['authority','cancel']){const f=fixture(),abort=new AbortController();let count=0;f.options.bridge.authorizeNativeResume=async()=>{if(++count===2){if(variant==='authority')return {...f.authority,scope:{...f.authority.scope,owner_id:'other'}};abort.abort();}return f.authority;};const composer=createNativeClaimedSessionComposer(f.options);
  await assert.rejects(composer.withCreation({...f.request,signal:abort.signal},async()=>f.hooks.get('agent/before-setup')({agent:f.agent,source:'startup',signal:new AbortController().signal})));assert.equal(f.events.length,0);await composer.dispose();
 }
});

test('formal adapter creation invokes the composer and refuses an unbound bypass',async()=>{
 const calls=[],token='a'.repeat(32),composer={withCreation:async(scope,operation)=>{assert.equal(scope.binding.sessionRef,'session');calls.push('authorize');return {value:await operation(),recovery:{state:'none',execution_authorized:false}};}},handler=createAdapterHandler({token,controller:{create:async()=>{calls.push('controller');return {sessionId:'session'};}},agents:{get:()=>({})},workbenchBridge:{attach:async()=>{calls.push('attach');}},nativeClaimedComposer:composer});
 const request=body=>handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions'),headers:{authorization:'Bearer '+token},body});
 const body={session_id:'session',cwd:'/workspace',workbench_context:{run_id:'run',execution_lease:{owner:'worker',generation:1}}};assert.equal((await request(body)).status,201);assert.deepEqual(calls,['authorize','controller','attach']);assert.equal((await request({session_id:'unbound',cwd:'/workspace'})).status,422);
});

test('caller cancellation and host disposal release a hanging authorization without entering the Controller',async()=>{
 for(const dispose of [false,true]){const f=fixture(),abort=new AbortController();let entered;const reached=new Promise(done=>entered=done);f.options.bridge.authorizeNativeResume=async()=>{entered();await new Promise(()=>{});};const composer=createNativeClaimedSessionComposer(f.options);const pending=composer.withCreation({...f.request,signal:abort.signal},async()=>assert.fail('Controller must not run'));const rejected=assert.rejects(pending);await reached;if(dispose)await composer.dispose();else abort.abort();await rejected;await composer.dispose();assert.equal(f.events.length,0);}
});

test('disposal keeps a rejection fence until a late original Controller operation settles',async()=>{
 const f=fixture(),composer=createNativeClaimedSessionComposer(f.options);let entered,release;const reached=new Promise(done=>entered=done),hold=new Promise(done=>release=done);
 const pending=composer.withCreation(f.request,async()=>{entered();await hold;await f.hooks.get('agent/before-setup')({agent:f.agent,source:'startup',signal:new AbortController().signal});});const rejected=assert.rejects(pending);await reached;await composer.dispose();await rejected;assert.ok(f.hooks.has('agent/before-setup'));release();await new Promise(done=>setImmediate(done));assert.equal(f.events.length,0);assert.equal(f.hooks.has('agent/before-setup'),false);
});

test('a hanging cold log read cannot block request cancellation or host disposal',async()=>{
 const f=fixture();let stamp,entered;const reading=new Promise(done=>entered=done);f.options.provenance.create=async(_session,value)=>{stamp=value;};f.options.provenance.read=async()=>stamp;
 const composer=createNativeClaimedSessionComposer(f.options),hook=source=>f.hooks.get('agent/before-setup')({agent:f.agent,source,signal:new AbortController().signal});
 await composer.withCreation(f.request,()=>hook('startup'));
 f.authority.mapping={goal_id:'goal',goal_revision:1};f.agent.session.header.isSeeded=false;f.agent.session.inheritedEventCount=0;f.agent.inbox={splice:()=>assert.fail('no restoration after abort')};
 const marker=createHash('sha256').update(JSON.stringify(f.authority.scope)).digest('hex');f.options.projections.stateOf=()=>({failure:null,current:{goal:{id:'goal',revision:1,phase:'active',maxGoalRounds:2,objective:f.authority.scope.objective+'\n\n[jot-occurrence:'+marker+']'}}});
 f.options.query.readSession=async()=>{entered();await new Promise(()=>{});};const abort=new AbortController(),pending=composer.withCreation({...f.request,signal:abort.signal},()=>hook('resume')),rejected=assert.rejects(pending);await reading;abort.abort();await rejected;await composer.dispose();assert.equal(f.events.length,0);
});
