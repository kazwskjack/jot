import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {RunCommandService} from '../../src/runs/commands.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {SessionCommandDispatcher} from '../../src/harness/command-dispatcher.ts';
import {inspectOrdinaryInputBinding} from '../../src/conversations/ordinary-input-binding.ts';
import {inspectOrdinaryRunHistory} from '../../src/conversations/ordinary-run-history.ts';
import {pinRunNativeSession} from '../../src/harness/run-native-session.ts';

function fixture(t,{saved=true}={}){
 const db=openProductDatabase(':memory:');t.after(()=>db.close());
 const events=new EventStore(db),runs=new RunRepository(db,events),coordinator=new HarnessCoordinator(db,runs,events);
 db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('original-conversation','owner','ws','Fixture',JSON.stringify({provider:'local',model:'fixture'}),1,'now','now');
 if(saved)db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('original-conversation','owner','original-session','now','now');
 const input={client_message_id:'original-input',content:[{type:'text',text:'Synthetic input'}]},source=runs.enqueue('original-conversation','owner',input);
 const replace=()=>db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('later-session','original-conversation');
 return{db,events,runs,coordinator,source,input,replace};
}

test('acceptance snapshots the existing native identity and retries cannot follow a replaced conversation pointer',t=>{
 const f=fixture(t);f.replace();
 assert.equal(f.db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get(f.source.run_id).native_session_ref,'original-session');
 assert.equal(f.runs.enqueue('original-conversation','owner',f.input).run_id,f.source.run_id);
 assert.throws(()=>f.db.prepare('UPDATE ga_runs SET native_session_ref=? WHERE id=?').run('later-session',f.source.run_id),/run_native_session_immutable/);
 assert.throws(()=>f.db.prepare('UPDATE ga_runs SET native_session_ref=NULL WHERE id=?').run(f.source.run_id),/run_native_session_immutable/);
});

test('Worker dispatch and authority use the accepted native Session even after the conversation pointer changes',async t=>{
 const f=fixture(t);f.replace();let calls=0,resolved=0;
 const worker=new HarnessWorker(f.db,f.coordinator,{run:async input=>{calls++;assert.equal(input.sessionRef,'original-session');
  const lease=f.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(f.source.run_id);
  assert.equal(inspectOrdinaryInputBinding(f.db,f.source.run_id,input.sessionRef,lease).session_id,'original-session');
  assert.throws(()=>inspectOrdinaryInputBinding(f.db,f.source.run_id,'later-session',lease),/ordinary_input_binding_rejected/);
  return{observed:true,completed:false,reason_code:'DSH_CHAT_ANSWER',runtime_status:'not_required',tool_marker:false,final_text:'Synthetic original answer'};
 }},{workerId:'native-worker',leaseMs:30000,sessionResolver:()=>{resolved++;return'later-session';}});
 await worker.processNext();assert.equal(calls,1);assert.equal(resolved,0);
 assert.equal(f.runs.get(f.source.run_id,'owner').status,'succeeded');
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(f.source.run_id).n,1);
 const scope={run_id:f.source.run_id,owner_id:'owner',conversation_id:'original-conversation',session_ref:'original-session',expected_run_version:f.runs.get(f.source.run_id,'owner').version};
 assert.equal(inspectOrdinaryRunHistory(f.db,scope).session_id,'original-session');
 assert.throws(()=>inspectOrdinaryRunHistory(f.db,{...scope,session_ref:'later-session'}),/ordinary_run_history_rejected/);
});

test('first dispatch pins an initially absent native Session before invoking the runner',async t=>{
 const f=fixture(t,{saved:false});let calls=0;
 const worker=new HarnessWorker(f.db,f.coordinator,{run:async input=>{calls++;assert.equal(input.sessionRef,'first-session');
  assert.equal(f.db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get(f.source.run_id).native_session_ref,'first-session');
  return{observed:true,completed:false,runtime_status:'not_required',final_text:'Synthetic first answer',reason_code:'DSH_CHAT_ANSWER'};
 }},{workerId:'first-worker',leaseMs:30000,sessionResolver:()=>{f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('original-conversation','owner','first-session','now','now');return'first-session';}});
 await worker.processNext();assert.equal(calls,1);assert.equal(f.runs.get(f.source.run_id,'owner').status,'succeeded');
});

test('cancel reaches the original run Session rather than the current conversation Session',async t=>{
 const f=fixture(t);f.replace();f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.source.run_id);
 new RunCommandService(f.db,f.events).cancel(f.source.run_id,'owner',{expected_run_version:f.runs.get(f.source.run_id,'owner').version},'fixture-cancel');const calls=[];
 const dispatcher=new SessionCommandDispatcher(f.db,f.events,{cancel:async session=>{calls.push(session);return{settled:true};},prompt:async()=>{throw Error('unexpected_prompt');}},()=>false);
 assert.equal(await dispatcher.processNext(),true);assert.deepEqual(calls,['original-session']);assert.equal(f.runs.get(f.source.run_id,'owner').status,'cancelled');
});

test('pinning requires the live original lease and unchanged owner/conversation lineage',t=>{
 const f=fixture(t),lease=f.coordinator.claimNext('pin-worker',30000);f.coordinator.start(lease);
 const proof={owner:lease.owner,generation:lease.generation};
 assert.equal(pinRunNativeSession(f.db,f.source.run_id,proof,'original-session'),'original-session');
 assert.throws(()=>pinRunNativeSession(f.db,f.source.run_id,{...proof,generation:proof.generation+1},'original-session'));
 assert.throws(()=>pinRunNativeSession(f.db,f.source.run_id,proof,'later-session'),/run_native_session_conflict/);
 f.db.prepare("UPDATE ga_conversations SET owner_id='other' WHERE id='original-conversation'").run();
 assert.equal(f.db.prepare('SELECT * FROM ga_run_native_sessions WHERE run_id=?').get(f.source.run_id),undefined);
 assert.throws(()=>pinRunNativeSession(f.db,f.source.run_id,proof,'original-session'),/run_native_session_conflict/);
});

test('unbound dispatch cannot borrow another owner native Session',t=>{
 const f=fixture(t,{saved:false}),lease=f.coordinator.claimNext('pin-worker',30000);f.coordinator.start(lease);
 f.db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES('foreign-conversation','foreign-owner','ws','Fixture','{}','now','now')").run();
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('foreign-conversation','foreign-owner','foreign-session','now','now');
 assert.throws(()=>pinRunNativeSession(f.db,f.source.run_id,{owner:lease.owner,generation:lease.generation},'foreign-session'),/run_native_session_conflict/);
 assert.equal(f.db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get(f.source.run_id).native_session_ref,null);
});

test('an interrupted legacy input without a frozen identity cannot recover through today pointer',async t=>{
 const f=fixture(t,{saved:false});
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('original-conversation','owner','later-session','now','now');
 const first=f.coordinator.claimNext('old-worker',30000);f.coordinator.start(first);
 f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),f.source.run_id);
 let calls=0;const worker=new HarnessWorker(f.db,f.coordinator,{run:async()=>{calls++;throw Error('no replay');},recoverInput:async()=>{calls++;return{observed:false,completed:false,runtime_status:'not_required',reason_code:'fixture_unconfirmed'};}},{workerId:'replacement-worker',leaseMs:30000,ordinaryInputRecoveryEnabled:true});
 await worker.processNext();assert.equal(calls,0);
 assert.equal(f.db.prepare('SELECT native_session_ref FROM ga_runs WHERE id=?').get(f.source.run_id).native_session_ref,null);
 assert.equal(f.runs.get(f.source.run_id,'owner').error_code,'ORIGINAL_INPUT_RECOVERY_UNAVAILABLE');
});

test('a frozen original input recovers after the next-input pointer is removed without resending a prompt',async t=>{
 const f=fixture(t),first=f.coordinator.claimNext('first-native-worker',30000);f.coordinator.start(first);
 f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),f.source.run_id);
 f.db.prepare('DELETE FROM ga_harness_session_bindings WHERE conversation_id=?').run('original-conversation');
 let recovered=0;const worker=new HarnessWorker(f.db,f.coordinator,{run:async()=>{throw Error('original_prompt_must_not_repeat');},recoverInput:async input=>{
  recovered++;assert.equal(input.sessionRef,'original-session');assert.equal(input.message,'');assert.deepEqual(input.attachments,[]);
  return{observed:true,completed:true,runtime_status:'not_required',reason_code:'SESSION_TURN_COMPLETED',final_text:'Synthetic original recovery'};
 }},{workerId:'recovery-native-worker',leaseMs:30000,ordinaryInputRecoveryEnabled:true});
 await worker.processNext();assert.equal(recovered,1);assert.equal(f.runs.get(f.source.run_id,'owner').status,'succeeded');
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='user'").get().n,1);
});
