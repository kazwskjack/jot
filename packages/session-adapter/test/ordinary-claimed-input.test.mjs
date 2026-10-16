import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const create=(await import('../ordinary-claimed-input.js').catch(()=>({}))).createOrdinaryClaimedInputRecoverySetup;
const canonical=value=>JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
function fixture(){
 const binding={runId:'run-a',sessionRef:'session-a',executionLease:{owner:'worker-a',generation:2}},authority={protocol:1,run_id:'run-a',request_id:'run-a',input_message_id:'product-a',conversation_id:'conversation-a',owner_id:'owner-a',session_id:'session-a',execution_lease:binding.executionLease,input_sha256:'a'.repeat(64),execution_authorized:false};
 const message={id:'native-a',role:'user',source:{kind:'user',rpcId:'run-a'},content:[{type:'text',text:'Original synthetic input.'}]};
 const header={id:'session-a',createdAt:1234,agentPreset:'jot-general',isSeeded:false},events=[['agent/inbox/spliced',{target:'next-turn',start:0,inserted:[message]}],['turn/start',{turn:1}],['agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]}],['turn/end',{turn:1,reason:{kind:'interrupted'}}],['session/end-seed',{}]].map(([type,data],seq)=>({type,data,seq,surfaceOp:'append'}));
 const project=view=>{const inbox={'next-step':[],'next-turn':[]};for(const e of view.snapshotEvents())if(e.type==='agent/inbox/spliced')inbox[e.data.target].splice(e.data.start,e.data.removedCount??0,...e.data.inserted);return inbox;};
 const session={id:'session-a',header,inheritedEventCount:0,firstLiveSeq:4,get seq(){return events.length;},snapshotEvents:()=>events};
 const agent={id:'session-a',status:'idle',session,inbox:{get nextStep(){return project(session)['next-step'];},get nextTurn(){return project(session)['next-turn'];},splice:(target,start,removedCount,inserted)=>events.push({type:'agent/inbox/spliced',seq:events.length,data:{target,start,removedCount,inserted},surfaceOp:'append'})}};
 class Detached{static create(id,seed,meta){const log=[...seed];if(log.at(-1)?.type!=='session/end-seed')log.push({type:'session/end-seed',seq:log.length,data:{}});return new Detached(id,seed.length,log,meta);}constructor(id,firstLiveSeq,log,header){Object.assign(this,{id,firstLiveSeq,seq:log.length,header,snapshotEvents:()=>log});}}
 const profile={protocol:1,profile_id:'ordinary-profile',preset_id:'jot-general',audit_id:'original-audit',fingerprint:'b'.repeat(64)},admission={protocol:1,run_id:'run-a',input_message_id:'product-a',conversation_id:'conversation-a',owner_id:'owner-a',session_id:'session-a',session_created_at:1234,input_sha256:'a'.repeat(64),native_message_id:'native-a',native_message_sha256:createHash('sha256').update(canonical(message)).digest('hex'),profile_fingerprint:'b'.repeat(64)};
 let reads=0;
 const options={binding,bridge:{request:async(path,b,body)=>{assert.equal(path,'ordinary-input-binding');assert.deepEqual(b,binding);assert.deepEqual(body,{});reads++;return {binding:structuredClone(authority)};}},ordinaryPresets:new Set(['jot-general']),profile:{read:async()=>({...profile})},admissions:{read:async({session:subject,runId,messageId})=>{assert.equal(subject,session);assert.equal(runId,'run-a');assert.equal(messageId,'native-a');return structuredClone(admission);}},Session:Detached,agents:{get:()=>undefined},sessions:{get:()=>undefined},query:{readSession:async()=>({session:header,inheritedEventCount:0,events:events.slice(0,5)})},projections:{snapshot:view=>({asOfSeq:view.seq-1,values:{inbox:project(view)}})},validateLog:async()=>({validated:true}),signal:new AbortController().signal};
 return{options,agent,message,authority,profile,admission,events,reads:()=>reads};
}
test('ordinary claimed setup restores only the admitted original human message without execution',async()=>{
 assert.equal(typeof create,'function');const f=fixture(),setup=create(f.options);await setup({},f.agent);assert.deepEqual(f.agent.inbox.nextTurn,[f.message]);assert.deepEqual(setup.resultFor(f.agent),{state:'restored',restored:1,already_pending:0,goal_owned:0,execution_authorized:false});assert.ok(f.reads()>=2);assert.equal(f.events.filter(e=>e.type==='user/message').length,0);
});
for(const mutation of ['foreign-rpc','content','owner','input','incarnation','profile','missing-admission','lease','published','paused-goal'])test('ordinary claimed setup refuses '+mutation+' before inbox restoration',async()=>{
 const f=fixture();if(mutation==='foreign-rpc')f.message.source.rpcId='other-run';if(mutation==='content')f.message.content[0].text='Unadmitted content';if(mutation==='owner')f.admission.owner_id='other-owner';if(mutation==='input')f.admission.input_sha256='c'.repeat(64);if(mutation==='incarnation')f.admission.session_created_at=1235;if(mutation==='profile')f.profile.fingerprint='c'.repeat(64);if(mutation==='missing-admission')f.options.admissions.read=async()=>{throw Error('missing');};if(mutation==='lease'){const read=f.options.profile.read;f.options.profile.read=async()=>{f.authority.execution_lease={owner:'new-worker',generation:3};return read();};}if(mutation==='published')f.options.agents.get=()=>f.agent;if(mutation==='paused-goal')f.options.projections.snapshot=view=>({asOfSeq:view.seq-1,values:{inbox:{'next-step':[],'next-turn':[]},goal:{goal:{id:'goal-a',phase:'paused'}}}});
 const before=f.agent.session.seq;assert.equal(typeof create,'function');await assert.rejects(create(f.options)({},f.agent));assert.equal(f.agent.session.seq,before);assert.deepEqual(f.agent.inbox.nextTurn,[]);
});
test('ordinary claimed setup requires explicit trusted services and freezes original lease input',async()=>{
 const f=fixture();assert.equal(typeof create,'function');assert.throws(()=>create({...f.options,admissions:undefined}));const setup=create(f.options);f.options.binding.executionLease.generation=3;await assert.rejects(setup({},f.agent));assert.deepEqual(f.agent.inbox.nextTurn,[]);
});


test('a lease change during the final admission read refuses restoration',async()=>{
 const f=fixture(),read=f.options.admissions.read;let reads=0;
 f.options.admissions.read=async request=>{const value=await read(request);if(++reads===2)f.authority.execution_lease={owner:'replacement',generation:3};return value;};
 const before=f.agent.session.seq;await assert.rejects(create(f.options)({},f.agent));assert.equal(f.agent.session.seq,before);
});


test('a lease replacement during the final native history read refuses restoration',async()=>{
 const f=fixture(),read=f.options.query.readSession;let reads=0;
 f.options.query.readSession=async(...args)=>{const value=await read(...args);if(++reads===2)f.authority.execution_lease={owner:'replacement',generation:3};return value;};
 const before=f.agent.session.seq;await assert.rejects(create(f.options)({},f.agent));assert.equal(f.agent.session.seq,before);
});
