import test from 'node:test';
import assert from 'node:assert/strict';
import {withNativeWorkspaceBarrier} from '../native-workspace-barrier.js';

function fixture(ids=['lead','child']) {
 const held=new Set(),guards=new Map(),members=[],registry=new Map(),goals=new Map();
 let reservation=true;
 for(const id of ids){
  const events=[],header={delegationDepth:0},hooks=new Map();guards.set(id,hooks);goals.set(id,null);
  const agent={id,status:'idle',session:{id,header,seq:0,eventAt:i=>events[i]},whenIdle:()=>assert.fail('never wait for our own maintenance'),
   runMaintenance:async job=>{if(held.has(id))throw Error('already owned');held.add(id);try{return await job(new AbortController().signal);}finally{held.delete(id);}},
   ctx:{goals:{get:()=>goals.get(id)},tools:{guard:fn=>{hooks.set('tool',fn);return()=>hooks.delete('tool');}},on:(_name,fn)=>{hooks.set('model',fn);return()=>hooks.delete('model');}}};
  registry.set(id,agent);
  members.push({agent,registry,persistence:{flush:async()=>{},open:async()=>({id,access:'read',header,read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{}})},projections:{stateOf:()=>({'next-turn':[],'next-step':[]})}});
 }
 return {held,guards,members,registry,goals,input:{members,assertReservation:()=>{if(!reservation)throw Error('original_reservation_revoked');}},revoke:()=>{reservation=false;}};
}

test('all original family members are simultaneously frozen before the callback',async()=>{
 const f=fixture(['z-lead','a-child']);let called=0;
 const value=await withNativeWorkspaceBarrier(f.input,async(proofs,check,signal)=>{
  called++;assert.deepEqual([...f.held],['a-child','z-lead']);
  assert.deepEqual(proofs.map(proof=>proof.session_ref),['a-child','z-lead']);
  assert.equal(Object.isFrozen(proofs),true);assert.equal(Object.isFrozen(proofs[0]),true);
  assert.equal(signal.aborted,false);check();return 'prepared';
 });
 assert.equal(called,1);assert.equal(value,'prepared');assert.equal(f.held.size,0);
 for(const hooks of f.guards.values())assert.equal(hooks.size,0);
});

test('busy second member unwinds the first without starting a mutation',async()=>{
 const f=fixture(['a','b']);f.members[1].agent.status='running';
 await assert.rejects(withNativeWorkspaceBarrier(f.input,()=>assert.fail('no effect')),/native_handoff_not_idle/);
 assert.equal(f.held.size,0);for(const hooks of f.guards.values())assert.equal(hooks.size,0);
});

test('reservation membership or ownership must remain valid across awaited host reads',async()=>{
 const f=fixture();f.members[1].persistence.flush=async()=>{f.revoke();};
 await assert.rejects(withNativeWorkspaceBarrier(f.input,()=>assert.fail('no effect')),/original_reservation_revoked/);
 assert.equal(f.held.size,0);
});

test('one member changing while another is captured invalidates the entire family',async()=>{
 const f=fixture(['a','b']);f.members[1].persistence.flush=async()=>{f.members[0].agent.session.seq++;};
 await assert.rejects(withNativeWorkspaceBarrier(f.input,()=>assert.fail('no effect')),/native_handoff_changed/);
 assert.equal(f.held.size,0);
});

test('queued user input during a mutation is detected, never cleared or consumed',async()=>{
 const f=fixture(),pending=[];f.members[0].projections.stateOf=()=>({'next-turn':pending,'next-step':[]});
 await assert.rejects(withNativeWorkspaceBarrier(f.input,async(_proofs,check)=>{pending.push({id:'original-user-input'});check();}),/native_handoff_changed/);
 assert.equal(pending.length,1);assert.equal(f.held.size,0);
});

for(const goal of [{id:'g',revision:1,phase:'active',activation:'armed'},{id:'g',revision:1,phase:'invented',activation:'disarmed'},{revision:1,phase:'paused',activation:'disarmed'},{}])
 test('armed or unknown native Goal never grants workspace quiescence: '+JSON.stringify(goal),async()=>{
  const f=fixture();f.goals.set('lead',goal);
  await assert.rejects(withNativeWorkspaceBarrier(f.input,()=>assert.fail('no effect')),/native_workspace_goal/);
  assert.equal(f.held.size,0);
 });

test('official no-current-Goal is undefined; missing Goal service is unavailable',async()=>{
 const f=fixture(['a']);f.goals.set('a',undefined);
 await withNativeWorkspaceBarrier(f.input,async()=>{});
 delete f.members[0].agent.ctx.goals;
 await assert.rejects(withNativeWorkspaceBarrier(f.input,()=>assert.fail('no effect')),/native_workspace_goal_unavailable/);
});

test('Goal revision changes invalidate a held family without disarming it',async()=>{
 const f=fixture(),goal={id:'g',revision:1,phase:'paused',activation:'disarmed'};f.goals.set('lead',goal);
 await assert.rejects(withNativeWorkspaceBarrier(f.input,async(_proofs,check)=>{goal.revision++;check();}),/native_workspace_goal_changed/);
 assert.equal(goal.activation,'disarmed');assert.equal(f.held.size,0);
});

test('native cancellation of any member reaches the one physical callback',async()=>{
 const f=fixture(),abort=new AbortController();
 f.members[1].agent.runMaintenance=async job=>{f.held.add('child');try{return await job(abort.signal);}finally{f.held.delete('child');}};
 await assert.rejects(withNativeWorkspaceBarrier(f.input,async(_proofs,_check,signal)=>{abort.abort();signal.throwIfAborted();}),{name:'AbortError'});
 assert.equal(f.held.size,0);
});

test('outer native cancellation also reaches an inner member storage read',async()=>{
 const f=fixture(['a','b']),abort=new AbortController();
 f.members[0].agent.runMaintenance=job=>job(abort.signal);
 const original=f.members[1].persistence.open;
 f.members[1].persistence.open=async(...args)=>{abort.abort();assert.equal(args[2].signal.aborted,true,'all acquired native signals reach inner capture');return original(...args);};
 await assert.rejects(withNativeWorkspaceBarrier(f.input,()=>assert.fail('no effect')),{name:'AbortError'});
 assert.equal(f.held.size,0);
});

test('unknown background tool effects cannot be hidden by an idle driver',async()=>{
 const f=fixture(['a']);const events=[{seq:0,type:'turn/start'},{seq:1,type:'tool/call',data:{callId:'batch',name:'universe_read_page',arguments:{urls:['https://example.com']}}},{seq:2,type:'tool/result',data:{message:{source:{callId:'batch'}}}},{seq:3,type:'turn/end'}];
 f.members[0].agent.session.seq=4;f.members[0].agent.session.eventAt=i=>events[i];
 f.members[0].persistence.open=async()=>({id:'a',access:'read',header:{delegationDepth:0},read:async(offset,count)=>({events:events.slice(offset,offset+count)}),close:async()=>{}});
 await assert.rejects(withNativeWorkspaceBarrier(f.input,()=>assert.fail('no effect')),/native_child_remote_effects_unresolved/);
 assert.equal(f.held.size,0);
});

test('operation failure releases every native maintenance handle and preserves the error',async()=>{
 const f=fixture();await assert.rejects(withNativeWorkspaceBarrier(f.input,async()=>{throw Error('original_dispatch_failed');}),/original_dispatch_failed/);
 assert.equal(f.held.size,0);for(const hooks of f.guards.values())assert.equal(hooks.size,0);
});

test('membership descriptors are snapshotted and duplicates or asynchronous reservation checks are rejected',async()=>{
 const f=fixture();await assert.rejects(withNativeWorkspaceBarrier({...f.input,members:[f.members[0],f.members[0]]},()=>{}),/native_workspace_members_invalid/);
 await assert.rejects(withNativeWorkspaceBarrier({...f.input,assertReservation:async()=>{}},()=>assert.fail('no effect')),/native_workspace_reservation_invalid/);
 await assert.rejects(withNativeWorkspaceBarrier({members:f.members},()=>assert.fail('no effect')),/native_workspace_reservation_invalid/);
 await withNativeWorkspaceBarrier(f.input,async(proofs,check)=>{f.input.members.splice(0);assert.equal(proofs.length,2);check();});
});

test('an authoritatively empty family still checks the owning reservation and cancellation',async()=>{
 const f=fixture([]);let checks=0;f.input.assertReservation=()=>{checks++;};
 assert.equal(await withNativeWorkspaceBarrier(f.input,async(proofs,check)=>{assert.deepEqual(proofs,[]);check();return 42;}),42);assert.ok(checks>=3);
 const abort=new AbortController();abort.abort();await assert.rejects(withNativeWorkspaceBarrier({...f.input,signal:abort.signal},()=>assert.fail('no effect')),{name:'AbortError'});
});
