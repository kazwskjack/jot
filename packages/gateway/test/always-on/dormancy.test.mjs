import test from 'node:test';import assert from 'node:assert/strict';
import {fixture} from './discovery-fixture.mjs';
import {discoveryPredecessorsAccepted,observeDiscoveryDormancy} from '../../src/always-on/dormancy.ts';

test('predecessor acceptance never treats an absent or foreign owned task as accepted',t=>{
 const f=fixture(t),taskId=f.tasks.list('owner').items[0].task_id;
 assert.equal(discoveryPredecessorsAccepted(f.db,'other-owner',taskId),false);
 assert.equal(discoveryPredecessorsAccepted(f.db,'owner','missing-task'),false);
});

test('dormancy observation creates no defaults, authority or task state',t=>{
 const f=fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.deepEqual(observeDiscoveryDormancy(f.db,'owner',f.enabled.policy_id),{protocol:1,state:'none',revision:null,execution_authorized:false});
 assert.equal(discoveryPredecessorsAccepted(f.db,'owner',f.tasks.list('owner').items[0].task_id),true);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('a legacy completed projection without canonical finalization cannot admit another source batch',async t=>{
 const f=fixture(t);f.file();const first=await f.controller().admit('owner',f.scope);assert.equal(first.admitted,true);
 const prior=f.db.prepare('SELECT * FROM wb_task_occurrences').get();
 // Deliberately incomplete legacy projection, not a business/native receipt.
 f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(prior.run_id);f.db.prepare("UPDATE wb_task_occurrences SET status='succeeded',business_state='completed' WHERE occurrence_id=?").run(prior.occurrence_id);
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(prior.conversation_id,'owner','synthetic-prior-session','now','now');
 f.workbench.writeFile('owner','ws',{project_id:f.agent.project_id,path:'source.md',content:'New source',expected_version:1});
 assert.equal(discoveryPredecessorsAccepted(f.db,'owner',prior.task_id),false);
 const next=await f.controller().admit('owner',f.scope);assert.equal(next.admitted,false);assert.equal(next.reason,'PREVIOUS_CYCLE_UNACCEPTED');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
