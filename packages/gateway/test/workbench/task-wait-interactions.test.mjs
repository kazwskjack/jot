import test from 'node:test';
import assert from 'node:assert/strict';
import {HarnessWorker} from '../../src/harness/worker.ts';
import {buildServer} from '../../src/server.ts';
import {fixture} from './task-wait-fixture.mjs';
test('confirmed task input creates one owned card and answering atomically resumes its saved occurrence with the user data',async t=>{
 const f=await fixture(t),items=await f.list();assert.equal(items.length,1);
 const card=items[0];assert.equal(card.kind,'question');assert.equal(card.purpose,'task_input');assert.equal(card.questions[0].prompt,'Which report format should I use?');
 assert.equal(JSON.stringify(card).includes('session-fixture'),false);assert.equal(JSON.stringify(card).includes('goal-fixture'),false);
 const parent=f.runs.get(f.runId,'alice');
 const bypass=await f.send(`/v1/runs/${f.runId}/resume`,{expected_run_version:parent.version,checkpoint_id:f.checkpointId});assert.equal(bypass.statusCode,409,bypass.body);
 const payload={expected_version:card.version,answers:[{question_id:card.questions[0].question_id,selected_option_ids:[],custom_text:'Use a Markdown report.'}]};
 const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,payload);assert.equal(response.statusCode,202,response.body);
 const leaf=f.persistentTasks.occurrences('alice',f.task.task_id).items[0];assert.notEqual(leaf.run_id,f.runId);assert.equal(leaf.occurrence_id,f.occurrence.occurrence_id);assert.equal(leaf.status,'queued');
 assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,0,'task input must not use the legacy command loop');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_wait_responses').get().n,1);
 const replay=await f.send(`/v1/interactions/${card.interaction_id}/response`,payload);assert.equal(replay.body,response.body);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
 let input;
 const worker=new HarnessWorker(f.db,f.coordinator,{run:async value=>{input=value;return {observed:true,completed:false,runtime_status:'not_required',reason_code:'SESSION_TURN_INTERRUPTED'};}},{workerId:'resume-worker',leaseMs:30000,executionGuard:f.workbench,sessionResolver:()=> 'session-fixture'});
 await worker.processNext();assert.match(input.message,/Use a Markdown report/);assert.equal(input.attachments.length,0);assert.equal(input.message.includes('Produce the authorized report'),false,'do not replay the original action request');
 const all=await f.app.inject({url:`/v1/conversations/${f.occurrence.conversation_id}/interactions?status=all`,headers:{'x-user-id':'alice'}});assert.equal(all.statusCode,200,all.body);assert.equal(all.json().items[0].status,'answered');
});

test('task review is a scoped continuation confirmation; denial leaves the Goal waiting and never publishes completion',async t=>{
 for(const decision of ['approve','deny']){
  const f=await fixture(t,'wait_approval'),items=await f.list();assert.equal(items.length,1);const card=items[0];assert.equal(card.purpose,'task_review');assert.equal(card.kind,'approval');
  const response=await f.send(`/v1/interactions/${card.interaction_id}/decision`,{expected_version:card.version,action_digest:card.action_digest,decision});assert.equal(response.statusCode,202,response.body);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,decision==='approve'?2:1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
  if(decision==='deny'){assert.equal(f.runs.get(f.runId,'alice').status,'waiting_approval');assert.equal(f.coordinator.claimNext('must-not-start',30000),null);}
 }
});

test('stale, foreign, empty, revoked and unknown-cost task responses cannot consume the card or create a continuation',async t=>{
 for(const condition of ['foreign','empty','version','revoked','unknown','checkpoint']){
  const f=await fixture(t),items=await f.list();assert.equal(items.length,1);const card=items[0];
  if(condition==='revoked')f.persistentTasks.pause('alice',f.task.task_id,1);
  if(condition==='unknown'){
   // Fault injection: a reconciler discovers an unrecorded attempt after the
   // wait was saved. Production admission correctly forbids dispatch while
   // paused; keep the original settled receipt immutable in this fixture.
   f.db.prepare(`INSERT INTO wb_model_budget_attempts
    SELECT run_id,'late-unknown',request_json,route_json,'unknown',held_tokens,held_nano_usd,NULL,NULL,NULL,0,'stream_incomplete',created_at,updated_at
    FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id='spent'`).run(f.runId);
  }
  if(condition==='checkpoint')f.db.prepare("UPDATE ga_runs SET checkpoint_id=NULL WHERE id=?").run(f.runId);
  const payload={expected_version:condition==='version'?card.version+1:card.version,answers:[{question_id:card.questions[0].question_id,selected_option_ids:[],custom_text:condition==='empty'?'   ':'Proceed with Markdown.'}]};
  const balances=f.modelBudgets.balancesForRun('alice',f.runId);
  const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,payload,condition==='foreign'?{'x-user-id':'bob'}:{});
  assert.equal(response.statusCode,condition==='foreign'?404:condition==='empty'?422:409,response.body);
  assert.equal(f.db.prepare('SELECT status FROM ga_interactions WHERE id=?').get(card.interaction_id).status,'pending',condition);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1,condition);
  assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),balances,condition);
 }
});

test('task wait replies cannot change authority or consume an expired card; valid duplicates still require the exact same payload',async t=>{
 const f=await fixture(t),card=(await f.list())[0];
 const url=`/v1/interactions/${card.interaction_id}/response`,payload={expected_version:card.version,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Markdown.'}]};
 const override=await f.send(url,{...payload,purpose:'task_completion_review',session_id:'forged'});assert.equal(override.statusCode,400,override.body);
 const response=await f.send(url,payload);assert.equal(response.statusCode,202,response.body);
 const altered=await f.send(url,{...payload,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Different response.'}]});assert.equal(altered.statusCode,409,altered.body);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
 const expired=await fixture(t,'wait_approval'),approval=(await expired.list())[0];
 expired.db.prepare('UPDATE ga_interactions SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z',approval.interaction_id);
 const denial=await expired.send(`/v1/interactions/${approval.interaction_id}/decision`,{expected_version:1,action_digest:approval.action_digest,decision:'approve'});assert.equal(denial.statusCode,409,denial.body);
 assert.equal(expired.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal((await expired.list())[0].status,'pending');
});

test('another Gateway connection can answer the durable wait and retry its exact receipt without forking the occurrence',async t=>{
 const f=await fixture(t),other=await buildServer(f.fixtureConfig);
 try{
  const cards=await other.app.inject({url:`/v1/conversations/${f.occurrence.conversation_id}/interactions`,headers:{'x-user-id':'alice'}});assert.equal(cards.statusCode,200,cards.body);const card=cards.json().items[0];
  const request={method:'POST',url:`/v1/interactions/${card.interaction_id}/response`,headers:f.headers,payload:{expected_version:card.version,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Markdown from another connection.'}]}};
  const reply=await other.app.inject(request);assert.equal(reply.statusCode,202,reply.body);
  const replay=await f.app.inject(request);assert.equal(replay.body,reply.body);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);assert.equal((await f.list()).length,0);assert.equal(f.persistentTasks.get('alice',f.task.task_id).runs_used,1);
  assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].occurrence_id,f.occurrence.occurrence_id);
 }finally{await other.app.close();other.db.close();}
});

test('saving the task supplement fails atomically after lineage and budget inheritance, leaving the card and checkpoint usable',async t=>{
 const f=await fixture(t),card=(await f.list())[0];
 const tables=['ga_runs','ga_outbox','ga_events','wb_task_run_occurrences','wb_task_wait_responses','wb_model_budget_bindings','wb_model_budget_attempts','wb_model_budget_events'];
 const counts=()=>Object.fromEntries(tables.map(name=>[name,f.db.prepare(`SELECT count(*) n FROM ${name}`).get().n]));
 const before=counts(),balances=f.modelBudgets.balancesForRun('alice',f.runId),parent=f.runs.get(f.runId,'alice');
 f.db.exec("CREATE TRIGGER fixture_task_supplement_failure BEFORE INSERT ON wb_task_wait_responses BEGIN SELECT RAISE(ABORT,'fixture_supplement_failure'); END");
 const url=`/v1/interactions/${card.interaction_id}/response`,payload={expected_version:card.version,answers:[{question_id:'task-input',selected_option_ids:[],custom_text:'Markdown.'}]};
 const failed=await f.send(url,payload);assert.equal(failed.statusCode,500,failed.body);
 assert.deepEqual(counts(),before);assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),balances);assert.deepEqual(f.runs.get(f.runId,'alice'),parent);assert.equal((await f.list())[0].status,'pending');
 f.db.exec('DROP TRIGGER fixture_task_supplement_failure');
 const recovered=await f.send(url,payload,{'idempotency-key':'after-failed-storage'});assert.equal(recovered.statusCode,202,recovered.body);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,2);
});
