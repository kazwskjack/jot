import test from 'node:test';import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';
import {createAuxiliaryRunGuard} from '../../src/workbench/auxiliary-run-guard.ts';
async function fixture(){
 const s=await buildServer({databasePath:':memory:',workspaces:['main'],workbenchRoot:'.test-tmp/aux-run-guard',workbenchExecutionReady:true});
 const a=s.workbench.createAgent('alice',{name:'Fixture role'});
 const task=s.persistentTasks.create('alice',{title:'Fixture task',agent_id:a.agent_id,objective:'Controlled task',trigger:{kind:'once'}});
 const run=s.persistentTasks.runNow('alice',task.task_id,crypto.randomUUID());
 s.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 s.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(run.run_id,'fixture-worker',1,String(Date.now()+60000),new Date().toISOString());
 return {...s,task,run,guard:()=>createAuxiliaryRunGuard(s.db,s.workbench,s.persistentTasks,'alice',run.run_id).guard};
}
test('real task guards reject pause, unknown outcome and malformed leases without changing state',async()=>{
 const f=await fixture();try{
  f.guard()();
  f.db.prepare("UPDATE ga_runs SET reason_code='OUTCOME_UNKNOWN' WHERE id=?").run(f.run.run_id);
  assert.throws(f.guard(),/budget_run_inactive/);
  f.db.prepare('UPDATE ga_runs SET reason_code=NULL WHERE id=?').run(f.run.run_id);
  f.db.prepare("UPDATE ga_worker_leases SET expires_at='not-a-time' WHERE resource_id=?").run(f.run.run_id);
  assert.throws(f.guard(),/auxiliary_lease_revoked/);
  f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()+60000),f.run.run_id);
  f.persistentTasks.pause('alice',f.task.task_id,f.task.version);
  assert.throws(f.guard(),/task_generation_revoked|run_capability_revoked/);
 }finally{await f.app.close();f.db.close();}
});
test('a new immutable continuation prevents an older root from regaining auxiliary authority',async()=>{
 const f=await fixture();try{
  f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(f.run.run_id);
  const next=f.runs.enqueue(f.run.conversation_id,'alice',{client_message_id:crypto.randomUUID(),content:[{type:'text',text:'Fixture child'}]});
  f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(next.run_id);
  const occurrence=f.db.prepare('SELECT occurrence_id FROM wb_task_run_occurrences WHERE run_id=?').get(f.run.run_id);
  f.db.prepare('INSERT INTO wb_task_continuations VALUES(?,?,?,?)').run(next.run_id,occurrence.occurrence_id,f.run.run_id,new Date().toISOString());
  // A stale writer restoring only the old status must not restore authority.
  f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.run.run_id);
  assert.throws(f.guard(),/task_generation_revoked/);
 }finally{await f.app.close();f.db.close();}
});
