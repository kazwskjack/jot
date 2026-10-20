import test from 'node:test';import assert from 'node:assert/strict';
import {withColdWorkspaceSession} from '../native-child-closure.js';
import {createNativeWorkspaceFactoryGate} from '../native-workspace-factory.js';

function fixture(){
 const events=[['turn/start',{turn:1}],['step/start',{turn:1,step:1}],['step/end',{turn:1,step:1}],['turn/end',{turn:1}]].map(([type,data],seq)=>({seq,type,data,surfaceOp:'append'}));
 const header={id:'cold',version:4,createdAt:123,agentPreset:'jot-general',cwd:'private-fixture-directory',isSeeded:false};
 let closed=0,owned=false,resident,liveSession,valid=true,projectedGoal=null,revision='revision-1',pending=[];
 class Backend{
  identity=Symbol('persistence-instance');
  async stat(){return {header:structuredClone(header),formatStatus:'current',revision,eventCount:events.length};}
  async open(id,access){assert.equal(id,'cold');assert.equal(access,'write','cold ownership is not an idle/read snapshot');assert.equal(owned,false);owned=true;
   return {id,access,header:structuredClone(header),inheritedEventCount:0,read:async(offset,count)=>({events:structuredClone(events.slice(offset,offset+count))}),append:()=>assert.fail('never append'),flush:()=>assert.fail('never mutate'),close:async()=>{closed++;owned=false;}};
  }
 }
 const persistence=new Backend();let current=persistence;
 return {events,header,Backend,persistence,input:{sessionRef:'cold',registry:{get:()=>resident},sessions:{get:()=>liveSession},persistence,currentPersistence:()=>current,backendClass:Backend,
  assertReservation:()=>{if(!valid)throw Error('original_reservation_lost');},allowedPresets:new Set(['jot-general']),validateLog:async()=>({validated:true}),
  projections:{snapshot:view=>({asOfSeq:view.seq-1,values:{inbox:{'next-turn':pending,'next-step':[]},goal:projectedGoal}})}},
  counts:()=>({closed,owned}),setResident:()=>{resident={id:'cold'};},setSession:()=>{liveSession={id:'cold'};},revoke:()=>{valid=false;},replace:()=>{current=new Backend();},changeRevision:()=>{revision='revision-2';},goal:value=>{projectedGoal=value;},pending:value=>{pending=value;}};
}
test('cold original storage ownership lasts through the callback without an Agent or a log append',async()=>{
 const f=fixture(),before=JSON.stringify(f.events);
 const result=await withColdWorkspaceSession(f.input,async({proof,header,check,recheck})=>{
  assert.equal(f.counts().owned,true);assert.equal(proof.driver_nonresident,true);assert.equal(proof.execution_authorized,false);assert.equal(proof.seq_exclusive,4);assert.equal(proof.turn_end_seq,3);assert.match(proof.log_sha256,/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(proof).includes('private-fixture-directory'),false);assert.equal(Object.isFrozen(proof),true);assert.notEqual(header,f.header);check();await recheck();return 'held';
 });assert.equal(result,'held');assert.equal(JSON.stringify(f.events),before);assert.deepEqual(f.counts(),{closed:1,owned:false});
});
for(const mutate of [f=>f.setResident(),f=>f.setSession(),f=>f.revoke()])test('resident or revoked original scope never opens a cold writer',async()=>{
 const f=fixture();mutate(f);await assert.rejects(withColdWorkspaceSession(f.input,()=>assert.fail('no effect')));assert.deepEqual(f.counts(),{closed:0,owned:false});
});
test('pending inbox and active persisted Goals are not cold quiescence',async()=>{
 for(const mutate of [f=>f.pending([{id:'pending'}]),f=>f.goal({goal:{id:'goal',revision:1,phase:'active'}}),f=>f.goal(undefined)]){
  const f=fixture();mutate(f);await assert.rejects(withColdWorkspaceSession(f.input,()=>assert.fail('no effect')));assert.deepEqual(f.counts(),{closed:1,owned:false});
 }
});
test('unclosed native turn, pending tool and unknown result all keep the physical callback closed',async()=>{
 for(const mutate of [f=>f.events.pop(),f=>{f.events.splice(2,0,{type:'tool/call',data:{callId:'pending',name:'tool'}});},f=>{f.events.splice(2,0,{type:'tool/result',data:{error:{code:'TOOL_OUTCOME_UNKNOWN'}}});}]){
  const f=fixture();mutate(f);f.events.forEach((event,seq)=>event.seq=seq);await assert.rejects(withColdWorkspaceSession(f.input,()=>assert.fail('no effect')));assert.equal(f.counts().closed,1);
 }
});
test('a previously returned batch still needs original terminal operation reconciliation',async()=>{
 const f=fixture();f.events.splice(2,0,{type:'tool/call',data:{callId:'batch',name:'universe_read_page',arguments:{urls:['https://example.com']}}},{type:'tool/result',data:{message:{source:{callId:'batch'}}}});f.events.forEach((event,seq)=>event.seq=seq);
 await assert.rejects(withColdWorkspaceSession(f.input,()=>assert.fail('no effect')),/native_workspace_remote_unresolved/);
 assert.equal(f.counts().closed,1);
});
test('changed storage revision, replaced service or a newly resident Session invalidates the held callback',async()=>{
 for(const mutate of [f=>f.changeRevision(),f=>f.replace(),f=>f.setResident()]){
  const f=fixture();await assert.rejects(withColdWorkspaceSession(f.input,async({recheck})=>{mutate(f);await recheck();}));assert.deepEqual(f.counts(),{closed:1,owned:false});
 }
});
test('failure and cancellation always release original storage ownership',async()=>{
 const f=fixture();await assert.rejects(withColdWorkspaceSession(f.input,async()=>{throw Error('original_callback_failed');}),/original_callback_failed/);assert.equal(f.counts().closed,1);
 const g=fixture(),abort=new AbortController();await assert.rejects(withColdWorkspaceSession({...g.input,signal:abort.signal},async({recheck})=>{abort.abort();await recheck();}),{name:'AbortError'});assert.equal(g.counts().closed,1);
});
test('missing, migration-required or wrong-profile storage is not an absent safe Session',async()=>{
 for(const mutate of [f=>{f.persistence.stat=async()=>undefined;},f=>{f.persistence.stat=async()=>({header:f.header,revision:'r',formatStatus:'migration-required'});},f=>{f.header.agentPreset='foreign-preset';}]){
  const f=fixture();mutate(f);await assert.rejects(withColdWorkspaceSession(f.input,()=>assert.fail('no effect')));assert.equal(f.counts().closed,0);
 }
});
test('an asynchronous reservation check cannot pretend to be the owning synchronous fence',async()=>{
 const f=fixture();await assert.rejects(withColdWorkspaceSession({...f.input,assertReservation:async()=>{}},()=>assert.fail('no effect')),/native_workspace_reservation_invalid/);assert.equal(f.counts().closed,0);
});

test('an absent original member needs an authentic factory hold and typed missing writer result',async()=>{
 const f=fixture();class Missing extends Error{constructor(id){super('missing');this.sessionId=id;}}
 const gate=createNativeWorkspaceFactoryGate({ctx:{get:()=>({jotPreSetupHookProtocol:2}),on:()=>()=>{}},...f.input,notFoundError:Missing});
 let opens=0;f.persistence.stat=async()=>undefined;f.persistence.open=async id=>{opens++;throw new Missing(id);};
 const lease=gate.claim(['cold']);
 try{
  await withColdWorkspaceSession({...f.input,factoryHold:lease.token},async({proof,header,recheck})=>{
   assert.equal(proof.storage_absent,true);assert.equal(proof.factory_fenced,true);assert.equal(proof.storage_owned,false);assert.equal(proof.execution_authorized,false);
   assert.equal(proof.seq_exclusive,null);assert.equal(proof.log_sha256,null);assert.equal(header,null);await recheck();
  });assert.ok(opens>=2);
  for(const wrong of [new Error('missing'),new Missing('foreign')]){
   f.persistence.open=async()=>{throw wrong;};await assert.rejects(withColdWorkspaceSession({...f.input,factoryHold:lease.token},()=>assert.fail('no effect')));
  }
  await assert.rejects(withColdWorkspaceSession({...f.input,factoryHold:{}},()=>assert.fail('no effect')),/native_workspace_factory_hold_invalid/);
 }finally{lease.release();await gate.dispose();}
});

test('a factory-fenced absent member cannot materialize during the held operation',async()=>{
 const f=fixture();class Missing extends Error{constructor(id){super('missing');this.sessionId=id;}}
 const gate=createNativeWorkspaceFactoryGate({ctx:{get:()=>({jotPreSetupHookProtocol:2}),on:()=>()=>{}},...f.input,notFoundError:Missing}),lease=gate.claim(['cold']);
 f.persistence.stat=async()=>undefined;f.persistence.open=async id=>{throw new Missing(id);};
 try{await assert.rejects(withColdWorkspaceSession({...f.input,factoryHold:lease.token},async()=>{f.persistence.stat=async()=>({header:f.header,formatStatus:'current',revision:'new'});}),/native_workspace_cold_changed/);}
 finally{lease.release();await gate.dispose();}
});

test('mutating the caller descriptor cannot detach the original absent-member factory hold',async()=>{
 const f=fixture();class Missing extends Error{constructor(id){super('missing');this.sessionId=id;}}
 const gate=createNativeWorkspaceFactoryGate({ctx:{get:()=>({jotPreSetupHookProtocol:2}),on:()=>()=>{}},...f.input,notFoundError:Missing}),lease=gate.claim(['cold']);
 f.persistence.stat=async()=>undefined;f.persistence.open=async id=>{throw new Missing(id);};const input={...f.input,factoryHold:lease.token};
 try{await assert.rejects(withColdWorkspaceSession(input,async()=>{delete input.factoryHold;lease.release();}),/native_workspace_factory_hold_invalid/);}
 finally{lease.release();await gate.dispose();}
});
