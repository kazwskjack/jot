import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {RunCommandService} from '../../src/runs/commands.ts';
import {SessionCommandDispatcher} from '../../src/harness/command-dispatcher.ts';
function fixture(){
 const db=openProductDatabase(':memory:');const events=new EventStore(db);const runs=new RunRepository(db,events);
 db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('c','u','ws','t','{}',1,'now','now');
 const receipt=runs.enqueue('c','u',{client_message_id:'m',content:[{type:'text',text:'hello'}]});
 db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(receipt.run_id);
 db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('c','u','s','now','now');
 return {db,events,runs,receipt,commands:new RunCommandService(db,events)};
}
test('supplement is durable during startup and waits for the session delivery window',async()=>{
 const x=fixture();try{
  x.db.prepare("UPDATE ga_runs SET status='starting' WHERE id=?").run(x.receipt.run_id);
  x.commands.steer(x.receipt.run_id,'u',{text:'more',client_message_id:'startup',expected_run_version:1},'startup');
  let ready=false,calls=0;const dispatcher=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>{calls++;return {accepted:true}},cancel:async()=>({settled:true})},()=>ready);
  await dispatcher.processNext();assert.equal(calls,0);
  ready=true;await dispatcher.processNext();assert.equal(calls,1);assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'applied');
 }finally{x.db.close()}
});
test('steer reaches official prompt exactly once and is persisted as user message',async()=>{
 const x=fixture();try{const calls=[];x.commands.steer(x.receipt.run_id,'u',{text:'more',client_message_id:'more-1',expected_run_version:1},'key');
 const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async(...args)=>(calls.push(args),{accepted:true}),cancel:async()=>({accepted:true,settled:true})},()=>true);
 await d.processNext();await d.processNext();assert.equal(calls.length,1);assert.equal(calls[0][3],'steer');
 assert.equal(x.db.prepare("SELECT count(*) n FROM ga_messages WHERE client_message_id='more-1'").get().n,1);
 }finally{x.db.close()}
});
test('cancel stays cancelling until official idle confirmation, then emits cancelled',async()=>{
 const x=fixture();try{x.commands.cancel(x.receipt.run_id,'u',{expected_run_version:1},'key');
 let resolve;const settled=new Promise(r=>resolve=r);
 const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>({accepted:true}),cancel:()=>settled},()=>true);
 const pending=d.processNext();assert.equal(x.runs.get(x.receipt.run_id,'u').status,'cancelling');
 resolve({accepted:true,settled:true});await pending;assert.equal(x.runs.get(x.receipt.run_id,'u').status,'cancelled');
 }finally{x.db.close()}
});
test('a turn ending before steer dispatch queues one follow-up instead of losing input',async()=>{
 const x=fixture();try{x.commands.steer(x.receipt.run_id,'u',{text:'more',client_message_id:'late',expected_run_version:1},'late');
 x.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(x.receipt.run_id);
 const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>{throw Error('must not steer old turn')},cancel:async()=>({settled:true})},()=>false);
 await d.processNext();await d.processNext();assert.equal(x.db.prepare("SELECT count(*) n FROM ga_runs WHERE status='queued'").get().n,1);
 }finally{x.db.close()}
});
test('cancel transport failure cannot fabricate cancelled state',async()=>{
 const x=fixture();try{x.commands.cancel(x.receipt.run_id,'u',{expected_run_version:1},'fail');
 const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>({}),cancel:async()=>{throw Error('offline')}},()=>true);
 await assert.rejects(d.processNext(),/offline/);assert.equal(x.runs.get(x.receipt.run_id,'u').status,'cancelling');
 assert.equal(x.db.prepare("SELECT status FROM ga_run_commands").get().status,'pending');
 }finally{x.db.close()}
});


test('opted-in ordinary steering uses the ready execution lease and command proof without prompt fallback',async()=>{
 const x=fixture();try{const {HarnessCoordinator}=await import('../../src/harness/coordinator.ts'),lease=new HarnessCoordinator(x.db,x.runs,x.events).claimNext('owned-worker',30000);assert.ok(lease);new HarnessCoordinator(x.db,x.runs,x.events).start(lease);const row=x.runs.get(x.receipt.run_id,'u');const command=x.commands.steer(x.receipt.run_id,'u',{text:'supplement',client_message_id:'steer-owned',expected_run_version:row.version},'owned');let sent=0;
 const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>{throw Error('no unbound fallback');},steerOriginal:async(session,rpc,text,proof)=>{sent++;assert.equal(rpc,command.command_id);assert.equal(session,'s');assert.equal(proof.run_id,x.receipt.run_id);assert.equal(proof.command_id,command.command_id);assert.deepEqual(proof.execution_lease,{owner:lease.owner,generation:lease.generation});return{accepted:true};},cancel:async()=>({settled:true})},()=>true,undefined,{currentExecutionFor:()=>({sessionRef:'s',ordinary:true,executionLease:{owner:lease.owner,generation:lease.generation}})});await d.processNext();assert.equal(sent,1);assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'applied');
 }finally{x.db.close();}
});
test('steering cannot persist delivery after its owned lease is replaced during send',async()=>{
 const x=fixture();try{const {HarnessCoordinator}=await import('../../src/harness/coordinator.ts'),c=new HarnessCoordinator(x.db,x.runs,x.events),lease=c.claimNext('owned-worker',30000);c.start(lease);x.commands.steer(x.receipt.run_id,'u',{text:'supplement',client_message_id:'steer-race',expected_run_version:x.runs.get(x.receipt.run_id,'u').version},'race');const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>{throw Error('no fallback');},steerOriginal:async()=>{x.db.prepare("UPDATE ga_worker_leases SET owner='replacement',generation=generation+1 WHERE resource_id=?").run(x.receipt.run_id);return{accepted:true};},cancel:async()=>({settled:true})},()=>true,undefined,{currentExecutionFor:()=>({sessionRef:'s',ordinary:true,executionLease:{owner:lease.owner,generation:lease.generation}})});await assert.rejects(d.processNext());assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'pending');assert.equal(x.db.prepare("SELECT count(*) n FROM ga_messages WHERE client_message_id='steer-race'").get().n,0);
 }finally{x.db.close();}
});
test('opted-in terminal ordinary commands wait for reconciliation instead of duplicate fallback',async()=>{
 const x=fixture();try{x.commands.steer(x.receipt.run_id,'u',{text:'supplement',client_message_id:'steer-uncertain',expected_run_version:1},'uncertain');x.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(x.receipt.run_id);const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>assert.fail('no send'),cancel:async()=>({settled:true})},()=>false,undefined,{currentExecutionFor:()=>undefined});await d.processNext();assert.equal(x.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'pending');}finally{x.db.close();}
});
