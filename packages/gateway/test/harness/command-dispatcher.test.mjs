import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {RunCommandService} from '../../src/runs/commands.ts';
import {SessionCommandDispatcher} from '../../src/harness/command-dispatcher.ts';
import {reserveOrdinarySteeringCustody} from '../../src/harness/ordinary-steering-custody.ts';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {SessionCommandDispatcher as LegacyDispatcher} from '../fixtures/command-dispatcher-v1/command-dispatcher.ts';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
function fixture(path=':memory:'){
 const db=openProductDatabase(path);const events=new EventStore(db);const runs=new RunRepository(db,events);
 db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('c','u','ws','t','{}',1,'now','now');
 const receipt=runs.enqueue('c','u',{client_message_id:'m',content:[{type:'text',text:'hello'}]});
 db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(receipt.run_id);
 db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('c','u','s','now','now');
 return {db,events,runs,receipt,commands:new RunCommandService(db,events)};
}

async function reserved(x){
 const {HarnessCoordinator}=await import('../../src/harness/coordinator.ts');
 const c=new HarnessCoordinator(x.db,x.runs,x.events),lease=c.claimNext('owned-worker',30000);c.start(lease);
 const command=x.commands.steer(x.receipt.run_id,'u',{text:'original supplement',client_message_id:'reserved-input',expected_run_version:x.runs.get(x.receipt.run_id,'u').version},'reserved-input');
 const proof=reserveOrdinarySteeringCustody(x.db,x.receipt.run_id,'s',command.command_id,{owner:lease.owner,generation:lease.generation});
 return {command,proof,lease};
}

test('pinned earlier dispatcher has unchanged methods and recorded MIT provenance',()=>{
 const base=new URL('../fixtures/command-dispatcher-v1/',import.meta.url),manifest=JSON.parse(readFileSync(new URL('provenance.json',base),'utf8'));
 const fixture=readFileSync(new URL('command-dispatcher.ts',base),'utf8').replace(/\r\n/g,'\n'),sha=s=>createHash('sha256').update(s).digest('hex');
 assert.equal(manifest.license,'MIT');assert.equal(sha(fixture),manifest.fixture_sha256);assert.ok(fixture.startsWith(manifest.header));
 let original=fixture.slice(manifest.header.length);for(const change of manifest.imports)original=original.replace("from '"+change.to+"'","from '"+change.from+"'");
 assert.equal(sha(original),manifest.source_sha256);
});

test('pinned legacy dispatcher reproduces fallback without custody and is refused with custody',async()=>{
 for(const protectedInput of [false,true]){
  const x=fixture();try{
   if(protectedInput)await reserved(x);else x.commands.steer(x.receipt.run_id,'u',{text:'original supplement',client_message_id:'reserved-input',expected_run_version:1},'reserved-input');
   x.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(x.receipt.run_id);
   const old=new LegacyDispatcher(x.db,x.events,{prompt:async()=>assert.fail('no native prompt'),cancel:async()=>({settled:true})},()=>false);
   if(protectedInput){await assert.rejects(old.processNext(),/ordinary_steering_fallback_forbidden/);assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'pending');}
   else{await old.processNext();assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'applied');}
   assert.equal(x.db.prepare('SELECT count(*) n FROM ga_runs').get().n,protectedInput?1:2);
  }finally{x.db.close();}
 }
});

test('reserved live steering cannot use unbound prompt after option rollback',async()=>{
 const x=fixture();try{const {lease}=await reserved(x);let calls=0;
  for(const option of [undefined,{currentExecutionFor:()=>({sessionRef:'s',ordinary:false,executionLease:{owner:lease.owner,generation:lease.generation}})}]){
   const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>{calls++;return{accepted:true};},cancel:async()=>({settled:true})},()=>true,undefined,option);
   assert.equal(await d.processNext(),false);assert.equal(calls,0);
   assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'pending');
  }
 }finally{x.db.close();}
});

test('invalid live identity creates no custody and a replacement Session cannot adopt existing custody',async()=>{
 const x=fixture();try{const {command,lease}=await reserved(x);
  x.db.prepare("UPDATE ga_harness_session_bindings SET session_id='replacement' WHERE conversation_id='c'").run();
  assert.throws(()=>reserveOrdinarySteeringCustody(x.db,x.receipt.run_id,'replacement',command.command_id,{owner:lease.owner,generation:lease.generation}),/ordinary_steering_custody_mismatch/);
  assert.equal(x.db.prepare('SELECT session_id FROM ga_ordinary_steering_custody').get().session_id,'s');
  const second=x.commands.steer(x.receipt.run_id,'u',{text:'other input',client_message_id:'other-input',expected_run_version:x.runs.get(x.receipt.run_id,'u').version},'other-input');
  assert.throws(()=>reserveOrdinarySteeringCustody(x.db,x.receipt.run_id,'replacement',second.command_id,{owner:'foreign-worker',generation:lease.generation}));
  assert.equal(x.db.prepare('SELECT count(*) n FROM ga_ordinary_steering_custody').get().n,1);
 }finally{x.db.close();}
});

test('database rejects the legacy fallback insert atomically but preserves unrelated conversations',async()=>{
 const x=fixture();try{await reserved(x);x.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(x.receipt.run_id);
  const before=x.db.prepare('SELECT count(*) n FROM ga_events').get().n;
  assert.throws(()=>x.runs.enqueue('c','u',{client_message_id:'reserved-input',content:[{type:'text',text:'original supplement'}]}),/ordinary_steering_fallback_forbidden/);
  assert.equal(x.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
  assert.equal(x.db.prepare('SELECT count(*) n FROM ga_events').get().n,before);
  x.db.prepare("INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES('other','other-owner','ws','t','{}',1,'now','now')").run();
  const other=x.runs.enqueue('other','other-owner',{client_message_id:'reserved-input',content:[{type:'text',text:'independent'}]});assert.notEqual(other.run_id,x.receipt.run_id);
 }finally{x.db.close();}
});

test('custody persists across reopen without certifying native acceptance',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'jot-steer-custody-')),path=join(dir,'gateway.sqlite');let x;
 try{x=fixture(path);await reserved(x);x.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(x.receipt.run_id);const run=x.receipt.run_id;x.db.close();x=null;
  const db=openProductDatabase(path);try{
   const d=new SessionCommandDispatcher(db,new EventStore(db),{prompt:async()=>assert.fail('no prompt'),cancel:async()=>({settled:true})},()=>false);
   assert.equal(await d.processNext(),false);assert.equal(db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
   assert.equal(db.prepare('SELECT run_id,status FROM ga_run_commands').get().run_id,run);assert.equal(db.prepare('SELECT status FROM ga_run_commands').get().status,'pending');
   assert.equal(db.prepare("SELECT count(*) n FROM ga_messages WHERE client_message_id='reserved-input'").get().n,0);
  }finally{db.close();}
 }finally{x?.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('custody cannot be edited, deleted, replaced or evaded by command mutation',async()=>{
 const x=fixture();try{const {command}=await reserved(x);
  for(const sql of ["UPDATE ga_ordinary_steering_custody SET owner_id='other'","DELETE FROM ga_ordinary_steering_custody","UPDATE ga_run_commands SET payload_json='{}'","DELETE FROM ga_run_commands","INSERT OR REPLACE INTO ga_run_commands SELECT * FROM ga_run_commands","INSERT OR REPLACE INTO ga_ordinary_steering_custody SELECT * FROM ga_ordinary_steering_custody"]){assert.throws(()=>x.db.exec(sql),/ordinary_steering_custody_immutable/,sql);}
  x.db.prepare("UPDATE ga_run_commands SET status='applied' WHERE id=?").run(command.command_id);
  assert.equal(x.db.prepare('SELECT count(*) n FROM ga_ordinary_steering_custody').get().n,1);
 }finally{x.db.close();}
});

test('original command publication remains usable and custody is idempotent',async()=>{
 const x=fixture();try{const {command,proof,lease}=await reserved(x);
  assert.deepEqual(reserveOrdinarySteeringCustody(x.db,x.receipt.run_id,'s',command.command_id,{owner:lease.owner,generation:lease.generation}),proof);
  const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>assert.fail('no prompt'),steerOriginal:async()=>({accepted:true}),cancel:async()=>({settled:true})},()=>true,undefined,{currentExecutionFor:()=>({sessionRef:'s',ordinary:true,executionLease:{owner:lease.owner,generation:lease.generation}})});
  assert.equal(await d.processNext(),true);assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'applied');
  const duplicate=x.runs.enqueue('c','u',{client_message_id:'reserved-input',content:[{type:'text',text:'original supplement'}]});assert.equal(duplicate.run_id,x.receipt.run_id);
  assert.equal(x.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 }finally{x.db.close();}
});

test('cancellation and parent deletion are not blocked by steering custody',async()=>{
 const x=fixture();try{await reserved(x);x.commands.cancel(x.receipt.run_id,'u',{expected_run_version:x.runs.get(x.receipt.run_id,'u').version},'cancel');
  const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>assert.fail('no prompt'),cancel:async()=>({settled:true})},()=>true);
  await d.processNext();assert.equal(x.runs.get(x.receipt.run_id,'u').status,'cancelled');
  x.db.prepare('DELETE FROM ga_runs WHERE id=?').run(x.receipt.run_id);assert.equal(x.db.prepare('SELECT count(*) n FROM ga_ordinary_steering_custody').get().n,0);
 }finally{x.db.close();}
});

test('a lost ordinary steering reply cannot become a fresh run after configuration rollback',async()=>{
 const x=fixture();try{
  const {HarnessCoordinator}=await import('../../src/harness/coordinator.ts');
  const coordinator=new HarnessCoordinator(x.db,x.runs,x.events),lease=coordinator.claimNext('owned-worker',30000);coordinator.start(lease);
  x.commands.steer(x.receipt.run_id,'u',{text:'keep this original supplement',client_message_id:'uncertain-rollback',expected_run_version:x.runs.get(x.receipt.run_id,'u').version},'uncertain-rollback');
  let calls=0;const client={prompt:async()=>assert.fail('no legacy prompt'),steerOriginal:async()=>{calls++;throw Error('reply_lost');},cancel:async()=>({settled:true})};
  const modern=new SessionCommandDispatcher(x.db,x.events,client,()=>true,undefined,{currentExecutionFor:()=>({sessionRef:'s',ordinary:true,executionLease:{owner:lease.owner,generation:lease.generation}})});
  await assert.rejects(modern.processNext(),/reply_lost/);
  x.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(x.receipt.run_id);
  const rolledBack=new SessionCommandDispatcher(x.db,x.events,client,()=>false);
  await rolledBack.processNext();await rolledBack.processNext();
  assert.equal(calls,1);assert.equal(x.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
  assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'pending');
 }finally{x.db.close();}
});
test('opt-in historical consumer observes the original terminal command and never creates a fallback run',async()=>{
 const x=fixture();try{x.commands.steer(x.receipt.run_id,'u',{text:'supplement',client_message_id:'history-consumer',expected_run_version:1},'history-consumer');x.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(x.receipt.run_id);const command=x.db.prepare('SELECT id FROM ga_run_commands').get().id;let calls=0;
 const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>assert.fail('no prompt'),cancel:async()=>({settled:true})},()=>false,undefined,{currentExecutionFor:()=>undefined,reconcileHistorical:async(...args)=>{calls++;assert.deepEqual(args,[x.receipt.run_id,'s',command]);return true;}});assert.equal(await d.processNext(),true);assert.equal(calls,1);assert.equal(x.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 x.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(x.receipt.run_id);assert.equal(await d.processNext(),false);assert.equal(calls,1);
 }finally{x.db.close();}
});
test('unconfirmed historical consumer stays pending without an automatic legacy fallback',async()=>{
 const x=fixture();try{x.commands.steer(x.receipt.run_id,'u',{text:'supplement',client_message_id:'history-unknown',expected_run_version:1},'history-unknown');x.db.prepare("UPDATE ga_runs SET status='interrupted' WHERE id=?").run(x.receipt.run_id);const d=new SessionCommandDispatcher(x.db,x.events,{prompt:async()=>assert.fail('no prompt'),cancel:async()=>({settled:true})},()=>false,undefined,{currentExecutionFor:()=>undefined,reconcileHistorical:async()=>false});assert.equal(await d.processNext(),false);assert.equal(x.db.prepare('SELECT status FROM ga_run_commands').get().status,'pending');assert.equal(x.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);}finally{x.db.close();}
});
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
