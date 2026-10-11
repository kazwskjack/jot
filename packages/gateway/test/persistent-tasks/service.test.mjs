import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openProductDatabase } from '../../src/db/database.ts';
import { ConversationRepository } from '../../src/conversations/repository.ts';

const moduleUrl = new URL('../../src/persistent-tasks/service.ts', import.meta.url);
async function fixture(options = {}) {
  const { PersistentTaskService } = await import(moduleUrl);
  const base = resolve('.test-tmp'); mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'persistent-'));
  const db = openProductDatabase(join(directory, 'fixture.sqlite'));
  const conversations = new ConversationRepository(db);
  const conversation = conversations.create('alice', { workspace_id: 'ws', model: { provider: 'harness', model: 'automatic' } });
  const agent = { agent_id: 'agent-a', status: 'active', workspace_id: 'ws', project_id: conversation.project_id, conversation_id: conversation.conversation_id };
  const workbench = { getAgent(owner,id) { if (owner !== 'alice' || id !== agent.agent_id) throw new Error('agent_not_found'); return agent; }, bindRun(owner,id,runId) { this.getAgent(owner,id); db.prepare('INSERT INTO test_bindings VALUES(?,?)').run(id,runId); } };
  db.exec('CREATE TABLE test_bindings(agent_id TEXT,run_id TEXT UNIQUE)');
  let now = new Date('2026-10-01T00:00:00Z');
  const service = new PersistentTaskService(db, workbench, { now: () => now, projectionRoot: join(directory, 'projection'), ...options });
  return { directory, db, agent, workbench, service, setTime(value) { now = new Date(value); }, close() { db.close(); rmSync(directory,{ recursive:true,force:true,maxRetries:5,retryDelay:20 }); } };
}
const input = { title: 'Check', agent_id: 'agent-a', objective: 'Check public information', trigger: { kind: 'once' } };

test('persistent task service is exported', async () => {
  const module = await import(moduleUrl).catch(() => ({}));
  assert.equal(typeof module.PersistentTaskService, 'function');
});
test('owner isolation and CAS updates reject stale writes and unsupported schedules', async () => {
  const f = await fixture(); try {
    const t = f.service.create('alice', input); assert.equal(t.version,1);
    assert.throws(() => f.service.get('bob',t.task_id), /task_not_found/);
    const updated = f.service.update('alice',t.task_id,{ expected_version:1,title:'Changed' }); assert.equal(updated.version,2);
    assert.throws(() => f.service.pause('alice',t.task_id,1), /version_conflict/);
    assert.throws(() => f.service.create('alice',{ ...input, trigger:{kind:'daily',timezone:'UTC'} }), /invalid_calendar_time/);
    assert.throws(() => f.service.create('alice',{ ...input, trigger:{kind:'interval',interval_seconds:1} }), /invalid_interval/);
  } finally { f.close(); }
});
test('once enqueue is atomic, deduplicated across restarts and separate from agent conversation', async () => {
  const f = await fixture(); try {
    const t = f.service.create('alice',input); await f.service.tick(); await f.service.tick();
    const [o] = f.service.occurrences('alice',t.task_id).items;
    assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
    assert.notEqual(o.conversation_id,f.agent.conversation_id);
    assert.equal(f.db.prepare('SELECT run_id FROM test_bindings').get().run_id,o.run_id);
    const { PersistentTaskService } = await import(moduleUrl); await new PersistentTaskService(f.db,f.workbench).tick();
    assert.equal(f.service.occurrences('alice',t.task_id).items.length,1);
  } finally { f.close(); }
});
test('binding failure rolls back run, outbox, conversation, occurrence and budget', async () => {
  const f = await fixture(); try {
    const t=f.service.create('alice',input); f.workbench.bindRun=()=>{throw new Error('binding_failed');};
    assert.throws(()=>f.service.runNow('alice',t.task_id,'key'), /binding_failed/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n,1);
    assert.equal(f.service.get('alice',t.task_id).runs_used,0);
    assert.equal(f.service.occurrences('alice',t.task_id).items.length,0);
  } finally { f.close(); }
});
test('pause cancels queued work and generation changes do not replay manual trigger keys', async () => {
  const f=await fixture(); try {
    let t=f.service.create('alice',input); const o=f.service.runNow('alice',t.task_id,'same');
    t=f.service.pause('alice',t.task_id,t.version); assert.equal(t.generation,2);
    assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(o.run_id).status,'cancelled');
    assert.throws(()=>f.service.assertRunActive(o.run_id),/task_generation_revoked/);
    t=f.service.resume('alice',t.task_id,t.version);
    assert.equal(f.service.runNow('alice',t.task_id,'same').run_id,o.run_id);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,1);
  } finally { f.close(); }
});
test('interval coalesces missed ticks, blocks overlap and exhausts durable budget', async () => {
  const f=await fixture(); try {
    const t=f.service.create('alice',{...input,trigger:{kind:'interval',interval_seconds:60},budget:{max_runs:2}});
    await f.service.tick(); f.setTime('2026-10-01T01:00:00Z'); await f.service.tick();
    assert.equal(f.service.occurrences('alice',t.task_id).items.length,1);
    f.db.prepare("UPDATE ga_runs SET status='succeeded'").run(); await f.service.tick();
    assert.equal(f.service.occurrences('alice',t.task_id).items.length,2);
    f.db.prepare("UPDATE ga_runs SET status='succeeded'").run(); f.setTime('2026-10-01T02:00:00Z'); await f.service.tick();
    assert.equal(f.service.get('alice',t.task_id).status,'budget_exhausted');
    assert.equal(f.service.get('alice',t.task_id).runs_used,2);
  } finally { f.close(); }
});
test('page baseline is silent, transitions are durable and unsafe URL is rejected', async () => {
  let text='A'; const f=await fixture({ pageReader:async()=>({text,url:'https://example.com/'}) }); try {
    const t=f.service.create('alice',{...input,trigger:{kind:'page_change',url:'https://example.com/'}});
    await f.service.tick(); assert.equal(f.service.occurrences('alice',t.task_id).items.length,0);
    text='B'; f.setTime('2026-10-01T00:05:00Z'); await f.service.tick();
    assert.equal(f.service.occurrences('alice',t.task_id).items.length,1);
    f.db.prepare("UPDATE ga_runs SET status='succeeded'").run(); text='A'; f.setTime('2026-10-01T00:10:00Z'); await f.service.tick();
    assert.equal(f.service.occurrences('alice',t.task_id).items.length,2);
    assert.throws(()=>f.service.create('alice',{...input,trigger:{kind:'page_change',url:'http://127.0.0.1/'}}),/unsafe_page_url/);
  } finally { f.close(); }
});
test('evidence and subtask ledger survive restart and projections expose authoritative state', async () => {
  const f=await fixture(); try {
    const t=f.service.create('alice',input); const o=f.service.runNow('alice',t.task_id,'ledger');
    const first=f.service.upsertSubtask('alice',t.task_id,{title:'Read',acceptance:'Evidence required'});
    assert.throws(()=>f.service.upsertSubtask('alice',t.task_id,{subtask_id:first.subtask_id,expected_version:1,status:'completed'}),/evidence_required/);
    const done=f.service.upsertSubtask('alice',t.task_id,{subtask_id:first.subtask_id,expected_version:1,status:'completed',evidence:[{kind:'source',reference:'https://example.com/'}]});
    assert.equal(done.status,'completed');
    f.service.recordEvidence('alice',t.task_id,o.occurrence_id,[{kind:'source',reference:'https://example.com/'}]);
    const { PersistentTaskService }=await import(moduleUrl); const restored=new PersistentTaskService(f.db,f.workbench);
    assert.equal(restored.subtasks('alice',t.task_id).items[0].status,'completed');
    assert.equal(restored.occurrences('alice',t.task_id).items[0].evidence.length,1);
    const p=f.service.project('alice',t.task_id); assert.match(readFileSync(join(p.directory,'TASKS.md'),'utf8'),/Read/);
    assert.equal(JSON.parse(readFileSync(join(p.directory,'STATE.json'),'utf8')).task.task_id,t.task_id);
  } finally { f.close(); }
});

test('new occurrences reset execution progress and retain immutable per-occurrence steps across reconnects',async()=>{
 const f=await fixture();let secondDb;try{
  const task=f.service.create('alice',input),definition=f.service.upsertSubtask('alice',task.task_id,{title:'Read source',acceptance:'Reviewed source',priority:70,status:'completed',evidence:[{kind:'source',reference:'owner:definition-note'}]});
  const first=f.service.runNow('alice',task.task_id,'first');
  const initial=f.service.subtasks('alice',task.task_id).items[0];
  assert.equal(initial.status,'pending','an unexecuted definition label cannot complete a new occurrence');assert.deepEqual(initial.evidence,[]);assert.ok(initial.version>definition.version);
  const done=f.service.upsertSubtask('alice',task.task_id,{subtask_id:initial.subtask_id,expected_version:initial.version,status:'completed',evidence:[{kind:'source',reference:'owner:first-result'}]});
  f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first.run_id);
  f.setTime('2026-10-01T00:05:00Z');const second=f.service.runNow('alice',task.task_id,'second');
  const current=f.service.subtasks('alice',task.task_id).items[0];
  assert.equal(current.status,'pending');assert.deepEqual(current.evidence,[]);assert.equal(current.subtask_id,done.subtask_id);assert.equal(current.acceptance,done.acceptance);assert.equal(current.priority,70);assert.ok(current.version>done.version);assert.equal(current.created_at,'2026-10-01T00:05:00.000Z');
  assert.deepEqual(f.service.subtasks('alice',task.task_id,first.occurrence_id).items,[done]);
  assert.throws(()=>f.service.upsertSubtask('alice',task.task_id,{subtask_id:done.subtask_id,expected_version:done.version,status:'blocked'}),/version_conflict/);
  const blocked=f.service.upsertSubtask('alice',task.task_id,{subtask_id:current.subtask_id,expected_version:current.version,status:'blocked'});
  assert.equal(f.service.runNow('alice',task.task_id,'second').occurrence_id,second.occurrence_id);assert.equal(f.service.runNow('alice',task.task_id,'first').occurrence_id,first.occurrence_id);
  assert.deepEqual(f.service.subtasks('alice',task.task_id).items,[blocked]);
  const {PersistentTaskService}=await import(moduleUrl);secondDb=openProductDatabase(join(f.directory,'fixture.sqlite'));const reopened=new PersistentTaskService(secondDb,f.workbench);
  assert.deepEqual(reopened.subtasks('alice',task.task_id,first.occurrence_id).items,[done]);assert.deepEqual(reopened.subtasks('alice',task.task_id,second.occurrence_id).items,[blocked]);
  assert.throws(()=>reopened.subtasks('bob',task.task_id,first.occurrence_id),/task_not_found/);
  assert.throws(()=>reopened.subtasks('alice',task.task_id,'occurrence-missing'),/occurrence_not_found/);
  assert.throws(()=>f.db.prepare("UPDATE wb_task_subtask_states SET snapshot_json='{}' WHERE occurrence_id=?").run(first.occurrence_id),/subtask_state_immutable/);
  assert.throws(()=>f.db.prepare('DELETE FROM wb_task_subtask_states WHERE occurrence_id=?').run(first.occurrence_id),/subtask_state_immutable/);
  const projection=f.service.project('alice',task.task_id),state=JSON.parse(readFileSync(join(projection.directory,'STATE.json'),'utf8'));assert.equal(state.subtask_occurrence_id,second.occurrence_id);assert.deepEqual(state.subtasks,[blocked]);
 }finally{secondDb?.close();f.close();}
});

test('a legacy ledger is never invented as history and only new observed edits gain an occurrence record',async()=>{
 const f=await fixture();try{
  const task=f.service.create('alice',input),first=f.service.runNow('alice',task.task_id,'legacy'),step=f.service.upsertSubtask('alice',task.task_id,{title:'Legacy step',status:'blocked'});
  f.db.exec('DROP TABLE wb_task_subtask_states; DROP TABLE wb_task_subtask_scope;');
  const {PersistentTaskService}=await import(moduleUrl),upgraded=new PersistentTaskService(f.db,f.workbench);
  assert.deepEqual(upgraded.subtasks('alice',task.task_id).items,[step]);assert.deepEqual(upgraded.subtasks('alice',task.task_id,first.occurrence_id).items,[]);
  const changed=upgraded.upsertSubtask('alice',task.task_id,{subtask_id:step.subtask_id,expected_version:step.version,status:'pending'});
  assert.deepEqual(upgraded.subtasks('alice',task.task_id,first.occurrence_id).items,[changed]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_subtask_states').get().n,1,'do not reconstruct unobserved prior revisions');
 }finally{f.close();}
});

test('failed new occurrence admission leaves the current step state and history unchanged',async()=>{
 const f=await fixture();try{
  const task=f.service.create('alice',input),first=f.service.runNow('alice',task.task_id,'first'),step=f.service.upsertSubtask('alice',task.task_id,{title:'Retained',status:'blocked'});
  f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first.run_id);
  const states=f.db.prepare('SELECT count(*) n FROM wb_task_subtask_states').get().n;
  f.workbench.bindRun=()=>{throw new Error('binding_failed');};
  assert.throws(()=>f.service.runNow('alice',task.task_id,'failed-second'),/binding_failed/);
  assert.deepEqual(f.service.subtasks('alice',task.task_id).items,[step]);assert.deepEqual(f.service.subtasks('alice',task.task_id,first.occurrence_id).items,[step]);
  assert.equal(f.service.occurrences('alice',task.task_id).items.length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_subtask_states').get().n,states);
  assert.equal(f.db.prepare('SELECT occurrence_id FROM wb_task_subtask_scope WHERE task_id=?').get(task.task_id).occurrence_id,first.occurrence_id);
 }finally{f.close();}
});

test('create idempotency rejects changed input and does not consume another budget',async()=>{
  const f=await fixture();try{
    const t=f.service.create('alice',input,'create-key');const duplicate=f.service.create('alice',input,'create-key');
    assert.equal(duplicate.task_id,t.task_id);assert.equal(f.service.list('alice').items.length,1);
    assert.throws(()=>f.service.create('alice',{...input,title:'Other'},'create-key'),/idempotency_conflict/);
  }finally{f.close();}
});
test('unknown effects block future triggers until explicit reconciliation',async()=>{
  const f=await fixture();try{
    const t=f.service.create('alice',{...input,trigger:{kind:'interval',interval_seconds:60}});await f.service.tick();
    f.db.prepare("UPDATE ga_runs SET status='failed',reason_code='OUTCOME_UNKNOWN'").run();f.setTime('2026-10-01T01:00:00Z');await f.service.tick();
    assert.equal(f.service.occurrences('alice',t.task_id).items.length,1);
    assert.equal(f.service.occurrences('alice',t.task_id).items[0].business_state,'waiting_review');
    assert.throws(()=>f.service.runNow('alice',t.task_id,'new'),/task_active_occurrence/);
  }finally{f.close();}
});
test('failed admission retries original scheduled time rather than inventing another trigger',async()=>{
  const f=await fixture();try{
    const t=f.service.create('alice',input);const bind=f.workbench.bindRun;f.workbench.bindRun=()=>{throw new Error('binding_failed');};
    await f.service.tick();assert.equal(f.service.get('alice',t.task_id).next_due_at,'2026-10-01T00:00:00.000Z');
    f.workbench.bindRun=bind;f.setTime('2026-10-01T00:01:00Z');await f.service.tick();
    assert.equal(f.service.occurrences('alice',t.task_id).items[0].trigger_key,'schedule:1:2026-10-01T00:00:00.000Z');
  }finally{f.close();}
});
test('runtime completion marks projection pending and tick repairs state files',async()=>{
  const f=await fixture();try{
    const t=f.service.create('alice',input);await f.service.tick();const before=f.service.project('alice',t.task_id);
    f.db.prepare("UPDATE ga_runs SET status='succeeded'").run();await f.service.tick();
    const state=JSON.parse(readFileSync(join(before.directory,'STATE.json'),'utf8'));
    assert.equal(state.occurrences[0].status,'succeeded');assert.equal(state.occurrences[0].business_state,'waiting_evidence');
  }finally{f.close();}
});
test('cancelling one occurrence fences that run and keeps the recurring definition active',async()=>{
  const f=await fixture();try{
    const t=f.service.create('alice',{...input,trigger:{kind:'interval',interval_seconds:60}});await f.service.tick();
    const o=f.service.occurrences('alice',t.task_id).items[0];
    const cancelled=f.service.cancelOccurrence('alice',t.task_id,o.occurrence_id,1,'cancel-key');
    assert.equal(cancelled.status,'cancelled');assert.equal(f.service.get('alice',t.task_id).status,'active');
    assert.throws(()=>f.service.assertRunActive(o.run_id),/task_generation_revoked/);
    f.setTime('2026-10-01T00:01:00Z');await f.service.tick();assert.equal(f.service.occurrences('alice',t.task_id).items.length,2);
  }finally{f.close();}
});
test('pause during asynchronous page read invalidates the pending detection',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});
  const f=await fixture({pageReader:async()=>{await pending;return{text:'A',url:'https://example.com/'};}});try{
    const t=f.service.create('alice',{...input,trigger:{kind:'page_change',url:'https://example.com/'}});const running=f.service.tick();
    f.service.pause('alice',t.task_id,1);finish();await running;
    assert.equal(f.db.prepare('SELECT baseline_hash FROM wb_persistent_tasks WHERE task_id=?').get(t.task_id).baseline_hash,null);
    assert.equal(f.service.occurrences('alice',t.task_id).items.length,0);
  }finally{finish();f.close();}
});
test('repeat cancellation with same idempotency key returns original cancellation',async()=>{
  const f=await fixture();try{
    const t=f.service.create('alice',input);const o=f.service.runNow('alice',t.task_id,'run');
    const first=f.service.cancelOccurrence('alice',t.task_id,o.occurrence_id,1,'cancel');
    const again=f.service.cancelOccurrence('alice',t.task_id,o.occurrence_id,1,'cancel');
    assert.equal(again.run_id,first.run_id);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_commands').get().n,1);
  }finally{f.close();}
});
test('projection root rejects symbolic-link traversal',async()=>{
  const f=await fixture();try{
    const t=f.service.create('alice',input);
    const {symlinkSync}=await import('node:fs');
    const outside=join(f.directory,'outside');mkdirSync(outside);
    const root=join(f.directory,'projection');symlinkSync(outside,root,'junction');
    assert.throws(()=>f.service.project('alice',t.task_id),/projection_path_escape/);
    assert.equal(f.service.get('alice',t.task_id).projection_pending,true);
  }finally{f.close();}
});
test('database reopen preserves run budget and real workbench binding without replay',async()=>{
  const {WorkbenchService}=await import('../../src/workbench/service.ts');const {PersistentTaskService}=await import(moduleUrl);
  const base='.test-tmp';mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'persistent-reopen-'));
  const path=join(directory,'fixture.sqlite');const options={workspaceIds:['ws'],root:join(directory,'workspace')};
  let db=openProductDatabase(path);
  try{
    let workbench=new WorkbenchService(db,options);const agent=workbench.createAgent('alice',{name:'Reader',instructions:'Read the source'});
    let service=new PersistentTaskService(db,workbench);const t=service.create('alice',{...input,agent_id:agent.agent_id,budget:{max_runs:1}});
    await service.tick();const original=service.occurrences('alice',t.task_id).items[0];
    assert.equal(workbench.contextForRun(original.run_id).instructions,'Read the source');db.close();
    db=openProductDatabase(path);workbench=new WorkbenchService(db,options);service=new PersistentTaskService(db,workbench);
    await service.tick();assert.equal(service.occurrences('alice',t.task_id).items.length,1);assert.equal(service.get('alice',t.task_id).runs_used,1);
    assert.equal(workbench.contextForRun(original.run_id).agent_id,agent.agent_id);
  }finally{db.close();rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
});
test('busy high priority definitions are filtered before the tick batch limit',async()=>{
  const f=await fixture();try{
    for(let i=0;i<25;i++){const t=f.service.create('alice',{...input,title:`Busy ${i}`,priority:100});f.service.runNow('alice',t.task_id,`busy-${i}`);}
    const eligible=f.service.create('alice',{...input,title:'Eligible',priority:0});const tick=await f.service.tick();
    assert.equal(tick.dispatched,1);assert.equal(f.service.occurrences('alice',eligible.task_id).items.length,1);
  }finally{f.close();}
});
