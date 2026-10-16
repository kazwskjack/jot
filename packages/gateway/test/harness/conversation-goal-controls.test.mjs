import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {ConversationGoalControls} from '../../src/conversations/goal-controls.ts';
const view={goal:{id:'goal-fixture',revision:4,objective:'Continue the original task',phase:'paused',activation:'disarmed'}};
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jot-goal-intent-')),db=openProductDatabase(join(root,'test.sqlite')),events=new EventStore(db),runs=new RunRepository(db,events);
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const stamp=new Date().toISOString();db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('conv-a','owner-a','ws','Fixture','{}',1,stamp,stamp);
 db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('conv-a','owner-a','native-fixture',stamp,stamp);
 const original=runs.enqueue('conv-a','owner-a',{client_message_id:'original',content:[{type:'text',text:'Original input must never be replayed'}]});db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(original.run_id);
 const controls=new ConversationGoalControls(db,events,runs),request={ownerId:'owner-a',conversationId:'conv-a',sessionId:'native-fixture',idempotencyKey:'resume-original',ref:{id:'goal-fixture',revision:4}};
 return {db,events,runs,controls,request,original};
}
test('resume intent uses the original run queue and lineage without adding or resending a human message',t=>{
 const f=fixture(t),before=f.db.prepare('SELECT count(*) n FROM ga_messages').get().n,result=f.controls.enqueue(f.request,view);
 assert.equal(result.accepted,true);assert.equal(result.conversation_id,'conv-a');assert.ok(result.control_id);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_messages').get().n,before);
 const run=f.runs.get(result.run_id,'owner-a');assert.equal(run.status,'queued');assert.equal(run.continuation_of,f.original.run_id);assert.equal(run.input_message_id,null);assert.equal(run.goal_control_id,result.control_id);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_outbox WHERE aggregate_id=? AND event_type='run.queued'").get(result.run_id).n,1);
 assert.deepEqual(f.controls.enqueue(f.request,{goal:null}),result);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
 assert.throws(()=>f.controls.enqueue({...f.request,ref:{id:'goal-fixture',revision:5}},view),/goal_control_idempotency_conflict/);
});
test('admission preserves owner, Session, goal CAS, role scope and queued/running conflicts',t=>{
 const f=fixture(t);
 assert.throws(()=>f.controls.enqueue({...f.request,ownerId:'owner-b'},view),/conversation_not_found/);
 assert.throws(()=>f.controls.enqueue({...f.request,sessionId:'different'},view),/goal_control_session_changed/);
 for(const goal of [null,{...view.goal,revision:5},{...view.goal,phase:'complete'},{...view.goal,phase:'active',activation:'armed'}])assert.throws(()=>f.controls.enqueue(f.request,{goal}),/goal_control_(revision_changed|not_resumable)/);
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.original.run_id);assert.throws(()=>f.controls.enqueue(f.request,view),/goal_control_run_busy/);f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(f.original.run_id);
 f.db.exec('CREATE TABLE wb_agents(conversation_id TEXT,owner_id TEXT)');f.db.prepare('INSERT INTO wb_agents VALUES(?,?)').run('conv-a','owner-a');assert.throws(()=>f.controls.enqueue(f.request,view),/goal_control_scope_invalid/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
test('dispatch requires the live original lease and records one exact follower cursor',t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view),coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('worker-a',30000);coordinator.start(lease);
 assert.throws(()=>f.controls.begin(r.control_id,{owner:'wrong',generation:1},12,'observer-fixture'),/lease_revoked/);
 for(const cursor of [-1,1.5,'12'])assert.throws(()=>f.controls.begin(r.control_id,lease,cursor,'observer-fixture'),/goal_control_cursor_invalid/);
 const execution={owner:lease.owner,generation:lease.generation};assert.equal(f.controls.begin(r.control_id,execution,12,'observer-fixture').acquired,true);
 const duplicate=f.controls.begin(r.control_id,execution,12,'observer-fixture');assert.equal(duplicate.acquired,false);assert.equal(duplicate.state,'dispatching');
 assert.throws(()=>f.controls.begin(r.control_id,execution,13,'observer-fixture'),/goal_control_dispatch_unknown/);
 const applied={goal:{...view.goal,revision:5,phase:'active',activation:'armed'}};
 assert.throws(()=>f.controls.applied(r.control_id,execution,{goal:null},'observer-fixture'),/goal_control_receipt_invalid/);
 assert.deepEqual(f.controls.applied(r.control_id,execution,applied,'observer-fixture'),applied);
 assert.deepEqual(f.controls.applied(r.control_id,execution,applied,'observer-fixture'),applied);
 assert.throws(()=>f.controls.applied(r.control_id,execution,{goal:{...applied.goal,revision:6}},'observer-fixture'),/goal_control_receipt_conflict/);
 assert.throws(()=>f.db.prepare("UPDATE ga_conversation_goal_controls SET state='queued' WHERE control_id=?").run(r.control_id),/goal_control_receipt_immutable/);
 assert.throws(()=>f.db.prepare("UPDATE ga_conversation_goal_controls SET session_id='other' WHERE control_id=?").run(r.control_id),/goal_control_(identity|receipt)_immutable/);
 f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1 WHERE resource_id=?').run(r.run_id);assert.throws(()=>f.controls.inspect(r.control_id,execution),/lease_revoked/);
});
test('unconfirmed dispatch survives a new service and fences replacement attempts after run interruption',t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view),coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('worker-a',30000);coordinator.start(lease);const execution={owner:lease.owner,generation:lease.generation};
 f.controls.begin(r.control_id,execution,0,'observer-fixture');f.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(r.run_id);
 const recovered=new ConversationGoalControls(f.db,f.events,f.runs);assert.deepEqual(recovered.enqueue(f.request,view),r);
 assert.throws(()=>recovered.enqueue({...f.request,idempotencyKey:'different-intent'},view),/goal_control_dispatch_unknown/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
});
test('Session rebinding, cancellation and stale lease revoke a pending control before mutation',t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view),coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('worker-a',30000);coordinator.start(lease);const execution={owner:lease.owner,generation:lease.generation};
 f.db.prepare("UPDATE ga_harness_session_bindings SET session_id='replacement' WHERE conversation_id='conv-a'").run();assert.throws(()=>f.controls.begin(r.control_id,execution,1,'observer-fixture'),/goal_control_session_changed/);
 f.db.prepare("UPDATE ga_harness_session_bindings SET session_id='native-fixture' WHERE conversation_id='conv-a'").run();f.db.prepare("UPDATE ga_runs SET status='cancelling' WHERE id=?").run(r.run_id);assert.throws(()=>f.controls.begin(r.control_id,execution,1,'observer-fixture'),/goal_control_run_revoked/);
});
test('old workers refuse a Goal continuation instead of replaying original input',async t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view);let calls=0,stages=0;
 const worker=new HarnessWorker(f.db,new HarnessCoordinator(f.db,f.runs,f.events),{run:async()=>{calls++;throw Error('original prompt must not run');}},{workerId:'old-worker',leaseMs:30000,contextStager:{stageContext:async()=>{stages++;return{};}}});
 await worker.processNext();assert.equal(calls,0);assert.equal(stages,0);assert.equal(f.runs.get(r.run_id,'owner-a').error_code,'GOAL_CONTINUATION_UNAVAILABLE');
});
test('failure within the original event transaction rolls back both intent and run',t=>{
 const f=fixture(t);f.db.exec("CREATE TEMP TRIGGER fail_goal_event BEFORE INSERT ON ga_events BEGIN SELECT RAISE(ABORT,'fixture_failure'); END");
 assert.throws(()=>f.controls.enqueue(f.request,view),/fixture_failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls').get().n,0);
});

test('continuation Worker passes only a pinned control and uses original publication after its durable receipt',async t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view);let normalCalls=0,stages=0,resolutions=0;
 const worker=new HarnessWorker(f.db,new HarnessCoordinator(f.db,f.runs,f.events),{
  run:async()=>{normalCalls++;throw Error('no ordinary prompt');},
  resumeGoal:async input=>{
   assert.equal(input.message,'');assert.deepEqual(input.attachments,[]);assert.equal(input.sessionRef,'native-fixture');assert.equal(input.workbenchRunId,undefined);assert.equal(input.taskRequestId,r.run_id);
   assert.equal(Object.isFrozen(input.goalControl),true);assert.equal(Object.isFrozen(input.goalControl.ref),true);assert.equal(input.goalControl.controlId,r.control_id);
   const lease=input.goalControl.executionLease;assert.equal(f.controls.begin(r.control_id,lease,18,'observer-fixture').acquired,true);
   f.controls.applied(r.control_id,lease,{goal:{...view.goal,revision:5,phase:'active',activation:'armed'}},'observer-fixture');
   input.onReady();assert.equal(worker.isReady(r.run_id),true);
   return {observed:true,completed:true,reason_code:'SESSION_GOAL_COMPLETE',runtime_status:'not_required',final_text:'Verified continuation output'};
  }
 },{workerId:'resume-worker',leaseMs:30000,contextStager:{stageContext:async()=>{stages++;return{};}},sessionResolver:()=>{resolutions++;throw Error('must not rebind Session');}});
 await worker.processNext();assert.equal(normalCalls,0);assert.equal(stages,0);assert.equal(resolutions,0);assert.equal(f.runs.get(r.run_id,'owner-a').status,'succeeded');assert.equal(worker.isReady(r.run_id),false);
 const answer=f.db.prepare("SELECT run_id,content_json FROM ga_messages WHERE role='assistant'").get();assert.equal(answer.run_id,r.run_id);assert.equal(JSON.parse(answer.content_json).blocks[0].text,'Verified continuation output');
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='user'").get().n,1);
});
test('a continuation cannot publish or become ready without an applied control receipt',async t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view);
 const worker=new HarnessWorker(f.db,new HarnessCoordinator(f.db,f.runs,f.events),{run:async()=>{throw Error('no ordinary prompt');},resumeGoal:async input=>{
  assert.throws(()=>input.onReady(),/goal_control_receipt_required/);
  return {observed:true,completed:true,reason_code:'fixture_claim',runtime_status:'not_required',final_text:'Unproven output'};
 }},{workerId:'unconfirmed-worker',leaseMs:30000});
 await worker.processNext();assert.equal(f.runs.get(r.run_id,'owner-a').status,'interrupted');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});
test('receipt and dispatch identity survive closing and reopening the original database',t=>{
 const root=mkdtempSync(join(tmpdir(),'jot-goal-reopen-')),file=join(root,'persisted.sqlite');let db=openProductDatabase(file);
 try{
  const events=new EventStore(db),runs=new RunRepository(db,events),stamp=new Date().toISOString();db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('conv-a','owner-a','ws','Fixture','{}',1,stamp,stamp);db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('conv-a','owner-a','native-fixture',stamp,stamp);
  const source=runs.enqueue('conv-a','owner-a',{client_message_id:'original',content:[{type:'text',text:'Original'}]});db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);
  const controls=new ConversationGoalControls(db,events,runs),request={ownerId:'owner-a',conversationId:'conv-a',sessionId:'native-fixture',idempotencyKey:'resume-durable',ref:{id:'goal-fixture',revision:4}},r=controls.enqueue(request,view),coordinator=new HarnessCoordinator(db,runs,events),lease=coordinator.claimNext('durable-worker',30000);coordinator.start(lease);const execution={owner:lease.owner,generation:lease.generation};controls.begin(r.control_id,execution,19,'observer-fixture');db.close();db=openProductDatabase(file);
  const recovered=new ConversationGoalControls(db,new EventStore(db),new RunRepository(db,new EventStore(db)));assert.deepEqual(recovered.enqueue(request,{goal:null}),r);assert.equal(recovered.inspect(r.control_id,execution).state,'dispatching');assert.equal(recovered.begin(r.control_id,execution,19,'observer-fixture').acquired,false);
  const receipt={goal:{...view.goal,revision:5,phase:'active',activation:'armed'}};recovered.applied(r.control_id,execution,receipt,'observer-fixture');db.close();db=openProductDatabase(file);
  const after=new ConversationGoalControls(db,new EventStore(db),new RunRepository(db,new EventStore(db)));assert.deepEqual(after.inspect(r.control_id,execution).receipt,receipt);
  db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),r.run_id);const next=new HarnessCoordinator(db,new RunRepository(db,new EventStore(db)),new EventStore(db)).claimNext('replacement-worker',30000);assert.ok(next);assert.throws(()=>after.inspect(r.control_id,{owner:next.owner,generation:next.generation}),/goal_control_dispatch_unknown/);
 }finally{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});

test('a Goal continuation carries no replayable input message and exposes its explicit control identity',t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view),run=f.runs.get(r.run_id,'owner-a');assert.equal(run.input_message_id,null);assert.equal(run.goal_control_id,r.control_id);assert.equal(run.continuation_of,f.original.run_id);
 const legacyInput=f.db.prepare('SELECT m.content_json FROM ga_runs r JOIN ga_messages m ON m.id=r.input_message_id WHERE r.id=?').get(r.run_id);assert.equal(legacyInput,undefined);
 const coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('worker-a',30000);assert.equal(lease.input_message_id,null);coordinator.start(lease);
 assert.equal(JSON.parse(f.db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='run.state' ORDER BY seq DESC LIMIT 1").get(r.run_id).payload_json).goal_control_id,r.control_id);
});

test('a confirmed pre-native refusal is immutable and does not masquerade as applied or unknown dispatch',t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view),coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('worker-a',30000);coordinator.start(lease);const execution={owner:lease.owner,generation:lease.generation};
 const receipt=f.controls.rejectBeforeNative(r.control_id,execution,'GOAL_CONTEXT_RECOVERY_REQUIRED','observer-fixture');assert.deepEqual(receipt,{rejected:true,mutation:'not_called',reason_code:'GOAL_CONTEXT_RECOVERY_REQUIRED'});assert.equal(f.controls.inspect(r.control_id,execution).state,'rejected');assert.equal(f.controls.inspect(r.control_id,execution).native_cursor,null);
 assert.deepEqual(f.controls.rejectBeforeNative(r.control_id,execution,'GOAL_CONTEXT_RECOVERY_REQUIRED','observer-fixture'),receipt);assert.throws(()=>f.controls.rejectBeforeNative(r.control_id,execution,'GOAL_RESUME_NOT_APPLIED','observer-fixture'),/goal_control_receipt_conflict/);assert.throws(()=>f.controls.applied(r.control_id,execution,{goal:{...view.goal,revision:5,phase:'active',activation:'armed'}},'observer-fixture'),/goal_control_receipt_invalid/);
 coordinator.interruptWithoutRuntime(lease,'GOAL_CONTEXT_RECOVERY_REQUIRED');assert.deepEqual(f.controls.enqueue(f.request,view),r);assert.notEqual(f.controls.enqueue({...f.request,idempotencyKey:'new-explicit-resume'},view).run_id,r.run_id);
});

test('pre-native refusal requires the same live dispatch lease and never overwrites an applied receipt',t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view),coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('worker-a',30000);coordinator.start(lease);const execution={owner:lease.owner,generation:lease.generation};
 assert.throws(()=>f.controls.rejectBeforeNative(r.control_id,{owner:'foreign',generation:1},'GOAL_RESUME_NOT_APPLIED','observer-fixture'),/lease_revoked/);assert.throws(()=>f.controls.rejectBeforeNative(r.control_id,execution,'PRIVATE_ERROR','observer-fixture'),/goal_control_rejection_invalid/);
 f.controls.begin(r.control_id,execution,5,'observer-fixture');assert.deepEqual(f.controls.rejectBeforeNative(r.control_id,execution,'GOAL_REVISION_CHANGED','observer-fixture'),{rejected:true,mutation:'not_called',reason_code:'GOAL_REVISION_CHANGED'});assert.equal(f.controls.inspect(r.control_id,execution).native_cursor,5);
 const other=fixture(t),accepted=other.controls.enqueue(other.request,view),c=new HarnessCoordinator(other.db,other.runs,other.events),l=c.claimNext('worker-b',30000);c.start(l);const e={owner:l.owner,generation:l.generation};other.controls.begin(accepted.control_id,e,9,'observer-fixture');other.controls.applied(accepted.control_id,e,{goal:{...view.goal,revision:5,phase:'active',activation:'armed'}},'observer-fixture');assert.throws(()=>other.controls.rejectBeforeNative(accepted.control_id,e,'GOAL_RESUME_NOT_APPLIED','observer-fixture'),/goal_control_receipt_conflict/);
});

test('Worker reports the committed pre-native refusal without replay, publication or a fabricated runtime outcome',async t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view);const worker=new HarnessWorker(f.db,new HarnessCoordinator(f.db,f.runs,f.events),{run:async()=>{throw Error('must not prompt')},resumeGoal:async input=>{f.controls.rejectBeforeNative(r.control_id,input.goalControl.executionLease,'GOAL_CONTEXT_RECOVERY_REQUIRED','observer-fixture');throw Error('opaque adapter failure');}},{workerId:'worker-a',leaseMs:30000});await worker.processNext();assert.equal(f.runs.get(r.run_id,'owner-a').error_code,'GOAL_CONTEXT_RECOVERY_REQUIRED');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);assert.equal(f.db.prepare('SELECT state FROM ga_conversation_goal_controls').get().state,'rejected');
});

test('a stale observer on the same lease cannot reject or apply a replacement observer dispatch',t=>{
 const f=fixture(t),r=f.controls.enqueue(f.request,view),coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('worker-a',30000);coordinator.start(lease);const execution={owner:lease.owner,generation:lease.generation};f.controls.begin(r.control_id,execution,9,'observer-new');
 assert.throws(()=>f.controls.rejectBeforeNative(r.control_id,execution,'GOAL_RESUME_NOT_APPLIED','observer-old'),/goal_control_observer_changed/);assert.throws(()=>f.controls.applied(r.control_id,execution,{goal:{...view.goal,revision:5,phase:'active',activation:'armed'}},'observer-old'),/goal_control_observer_changed/);assert.equal(f.controls.inspect(r.control_id,execution).state,'dispatching');assert.equal(f.controls.inspect(r.control_id,execution).observer_id,'observer-new');
 assert.throws(()=>f.db.prepare("UPDATE ga_conversation_goal_controls SET dispatch_observer_id='observer-old' WHERE control_id=?").run(r.control_id),/goal_control_observer_immutable/);
});
