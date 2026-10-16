import test from 'node:test';import assert from 'node:assert/strict';
const prepare=(await import('../ordinary-input-resume.js').catch(()=>({}))).prepareOrdinaryInputResume;
function fixture(){
 const calls=[],message={id:'native-input',role:'user',source:{kind:'user',rpcId:'run-a'},content:[{type:'text',text:'Original input'}]},binding={runId:'run-a',sessionRef:'session-a',executionLease:{owner:'worker-a',generation:2}};
 const authority={protocol:1,run_id:'run-a',request_id:'run-a',input_message_id:'product-input',conversation_id:'conv-a',owner_id:'owner-a',session_id:'session-a',execution_lease:binding.executionLease,input_sha256:'a'.repeat(64),execution_authorized:false};
 const agent={id:'session-a',session:{id:'session-a',seq:4},status:'idle',inbox:{nextStep:[],nextTurn:[message]},jotPendingInputProtocol:1,jotPendingWakeRevocationProtocol:1,jotRevokePendingWake(){throw Error('preflight_must_not_revoke');},jotResumePending(){throw Error('preflight_must_not_wake');},runMaintenance(){throw Error('preflight_must_not_execute');}};
 let resident=undefined,allow=true,fingerprint='b'.repeat(64);const view={values:{agentPreset:'jot-general',goal:null,inbox:{'next-step':[],'next-turn':[message]}}},history={meta:{id:'session-a'},events:[{seq:0,type:'session/end-seed',data:{}}]};
 const options={binding,signal:new AbortController().signal,observer:{assertActive(){calls.push('observer');}},ordinaryPresets:new Set(['jot-general']),agents:{get(){return resident;}},controller:{projections:async()=>{calls.push('cold');return view;},inspect:async()=>history,resolveAgent:async()=>{calls.push('resolve');resident=agent;return{agent};}},bridge:{request:async(path,b,body)=>{calls.push('binding');assert.equal(path,'ordinary-input-binding');assert.deepEqual(b,binding);assert.deepEqual(body,{});if(!allow)throw Error('revoked');return{binding:structuredClone(authority)};}},verifyComposition:async({phase})=>{calls.push(phase+'-composition');return{verified:true,fingerprint};}};
 return{options,calls,view,history,agent,authority,revoke:()=>allow=false,changeProfile:()=>fingerprint='c'.repeat(64)};
}
test('ordinary resume preflight binds original RPC and composition before resolving, without waking',async()=>{
 const f=fixture();assert.equal(typeof prepare,'function');const p=await prepare(f.options);assert.deepEqual(p.request,{requestId:'run-a',messageIds:['native-input'],seq:4});assert.equal(p.authority.execution_authorized,false);assert.ok(f.calls.indexOf('cold')<f.calls.indexOf('resolve'));assert.ok(f.calls.indexOf('cold-composition')<f.calls.indexOf('resolve'));p.check();await p.recheck();f.revoke();await assert.rejects(()=>p.recheck(),/ordinary_input_/);
});
test('foreign or committed input and an unbalanced history refuse before Agent resolution',async()=>{
 for(const kind of ['foreign-rpc','empty','other-preset','entered','open-turn','paused-goal']){const f=fixture();if(kind==='foreign-rpc')f.view.values.inbox['next-turn'][0].source.rpcId='other-run';if(kind==='empty')f.view.values.inbox['next-turn']=[];if(kind==='other-preset')f.view.values.agentPreset='other';if(kind==='entered')f.history.events.push({seq:1,type:'user/message',data:{id:'native-input',source:{kind:'user',rpcId:'run-a'}}});if(kind==='open-turn')f.history.events.push({seq:1,type:'turn/start',data:{turn:1}});if(kind==='paused-goal')f.view.values.goal={goal:{phase:'paused'}};await assert.rejects(()=>prepare(f.options),/ordinary_input_/);assert.ok(!f.calls.includes('resolve'),kind);}
});
test('profile or product lineage changes cannot authorize the original pending input',async()=>{
 const f=fixture(),p=await prepare(f.options);f.changeProfile();await assert.rejects(()=>p.recheck(),/ordinary_input_/);const g=fixture(),q=await prepare(g.options);g.authority.input_sha256='c'.repeat(64);await assert.rejects(()=>q.recheck(),/ordinary_input_/);const h=fixture();h.authority.owner_id='';await assert.rejects(()=>prepare(h.options),/ordinary_input_/);assert.ok(!h.calls.includes('resolve'));
});
test('native pending changes and observer loss invalidate prepared input before execution',async()=>{
 const f=fixture(),p=await prepare(f.options);f.agent.session.seq++;assert.throws(()=>p.check(),/ordinary_input_/);const g=fixture(),q=await prepare(g.options);g.options.observer.assertActive=()=>{throw Error('observer_closed');};assert.throws(()=>q.check(),/ordinary_input_/);
});
test('a shared mutable projection cannot replace the verified original input during composition checks',async()=>{
 const f=fixture();f.options.verifyComposition=async()=>{f.agent.inbox.nextTurn[0].content[0].text='Changed after cold validation';return{verified:true,fingerprint:'b'.repeat(64)};};await assert.rejects(()=>prepare(f.options),/ordinary_input_/);
});


test('empty pending recovery uses the scoped original factory receipt instead of prompting',async()=>{
 const f=fixture(),message=structuredClone(f.agent.inbox.nextTurn[0]);f.view.values.inbox['next-turn']=[];f.agent.inbox.nextTurn=[];
 f.options.claimedComposer={withResolution:async(scope,operation)=>{assert.deepEqual(scope.binding,f.options.binding);f.calls.push('claimed-factory');const value=await operation();f.agent.inbox.nextTurn=[message];return {value,recovery:{state:'restored',restored:1,execution_authorized:false},pending:{'next-step':[],'next-turn':[message]}};}};
 const result=await prepare(f.options);assert.deepEqual(result.request.messageIds,['native-input']);assert.ok(f.calls.indexOf('cold-composition')<f.calls.indexOf('claimed-factory'));result.check();
});
