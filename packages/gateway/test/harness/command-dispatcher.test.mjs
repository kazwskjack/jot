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
