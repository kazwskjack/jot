import test from 'node:test';import assert from 'node:assert/strict';
import {acceptedWorkCycleFixture} from './work-cycle-fixture.mjs';
import {fixture} from './discovery-fixture.mjs';
import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';import {spawn} from 'node:child_process';
const WorkCycles=(await import('../../src/always-on/work-cycles.ts').catch(()=>({}))).WorkCycles;
const input=f=>({admission_id:f.admission.admission_id,report_sha256:f.report.sha256,plan_ids:f.history.detail('owner',f.scope,f.admission.admission_id).plans.map(plan=>plan.plan_id),expected_policy_version:2,expected_role_version:1,expected_role_epoch:1});
test('constructing and reading owned work cycles never creates defaults or writes',t=>{
 const f=fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n;assert.equal(typeof WorkCycles,'function');const store=new WorkCycles(f.db);
 assert.deepEqual(store.list('owner',f.scope),{items:[],next_before_id:null,execution_authorized:false});
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.throws(()=>store.list('foreign',f.scope),/work_cycle_not_found/);
});
test('an accepted report with more than twenty plans freezes the full selection and can select a second-page plan alone',async t=>{
 const f=await acceptedWorkCycleFixture(t,{count:23}),store=new WorkCycles(f.db),first=f.history.detail('owner',f.scope,f.admission.admission_id),second=f.history.detail('owner',f.scope,f.admission.admission_id,first.next_after_plan_id);
 assert.equal(first.plans.length,20);assert.equal(second.plans.length,3);assert.equal(first.report.plan_ids.length,23);
 const request={...input(f),plan_ids:[...first.report.plan_ids]},cycle=store.create('owner',f.scope,request,'all-plans');
 assert.equal(cycle.plans.length,23);assert.deepEqual(cycle.plans.map(plan=>plan.plan_id),[...request.plan_ids].sort());
 const original=new Map([...first.plans,...second.plans].map(plan=>[plan.plan_id,plan]));for(const frozen of cycle.plans){assert.equal(frozen.sha256,original.get(frozen.plan_id).sha256);assert.deepEqual(frozen.paths,['source.md']);}
 assert.deepEqual(store.guard('owner',f.scope,cycle.cycle_id),cycle);store.close('owner',f.scope,cycle.cycle_id,{expected_version:1},'close-all');
 const later=second.plans[1],selected=store.create('owner',f.scope,{...request,plan_ids:[later.plan_id]},'second-page-only');assert.deepEqual(selected.plans,[{plan_id:later.plan_id,sha256:later.sha256,paths:['source.md']}]);assert.deepEqual(store.guard('owner',f.scope,selected.cycle_id),selected);
});
test('guard reopens a genuinely read-only SQLite connection and validates accepted native proof without mutation',async t=>{
 const f=await acceptedWorkCycleFixture(t),cycle=new WorkCycles(f.db).create('owner',f.scope,input(f),'create'),readonly=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});
 try{const before=readonly.prepare('SELECT total_changes() n').get().n,store=new WorkCycles(readonly);assert.deepEqual(store.guard('owner',f.scope,cycle.cycle_id),cycle);assert.equal(readonly.prepare('SELECT total_changes() n').get().n,before);assert.equal(readonly.isTransaction,false);assert.equal(store.get('owner',f.scope,cycle.cycle_id).execution_authorized,false);}
 finally{readonly.close();}
});
test('guard retains the exact original task-total scope identity even if a damaged ledger is rebound consistently',async t=>{
 const f=await acceptedWorkCycleFixture(t),store=new WorkCycles(f.db),cycle=store.create('owner',f.scope,input(f),'create'),allocation=JSON.parse(f.db.prepare('SELECT allocation_json FROM wb_budget_allocations WHERE run_id=?').get(cycle.root_run_id).allocation_json),bound=JSON.parse(f.db.prepare('SELECT scopes_json FROM wb_model_budget_bindings WHERE run_id=?').get(cycle.root_run_id).scopes_json),original=allocation.scopes.find(scope=>scope.key.startsWith('task-total:')).scope_id,replacement=original+'-rebound';
 f.db.exec('DROP TRIGGER wb_budget_scope_config_immutable;DROP TRIGGER wb_budget_allocation_immutable;DROP TRIGGER wb_budget_binding_immutable;');
 // Deliberate test-only damaged historical ledger: the current allocation and
 // ledger agree on a replacement scope, but the artifact pinned the original.
 f.db.prepare('UPDATE wb_model_budget_scopes SET scope_id=? WHERE owner_id=? AND scope_id=?').run(replacement,'owner',original);
 allocation.scopes.find(scope=>scope.scope_id===original).scope_id=replacement;f.db.prepare('UPDATE wb_budget_allocations SET allocation_json=? WHERE run_id=?').run(JSON.stringify(allocation),cycle.root_run_id);f.db.prepare('UPDATE wb_model_budget_bindings SET scopes_json=? WHERE run_id=?').run(JSON.stringify(bound.map(id=>id===original?replacement:id)),cycle.root_run_id);
 assert.throws(()=>store.guard('owner',f.scope,cycle.cycle_id),error=>error.message==='work_cycle_budget_binding_unconfirmed');assert.deepEqual(store.get('owner',f.scope,cycle.cycle_id),cycle);
});
test('unaccepted, no-plan, stale versions, foreign IDs and self-supplied plan fields cannot create resource authority',async t=>{
 const f=await acceptedWorkCycleFixture(t),store=new WorkCycles(f.db),request=input(f);
 for(const invalid of [{...request,report_sha256:'f'.repeat(64)},{...request,plan_ids:['not-a-recorded-plan']},{...request,plan_ids:[request.plan_ids[0],request.plan_ids[0]]},{...request,plans:[{path:'private'}]},{...request,expected_policy_version:1},{...request,expected_role_version:2},{...request,expected_role_epoch:2}])assert.throws(()=>store.create('owner',f.scope,invalid,'rejected'),/work_cycle_/);
 assert.equal(store.list('owner',f.scope).items.length,0);
 const pending=await acceptedWorkCycleFixture(t,{publish:false});assert.throws(()=>new WorkCycles(pending.db).create('owner',pending.scope,input(pending),'pending'),/work_cycle_report_unaccepted/);
 const noPlan=await acceptedWorkCycleFixture(t,{count:0});assert.throws(()=>new WorkCycles(noPlan.db).create('owner',noPlan.scope,{...input(noPlan),plan_ids:['unknown']},'no-plan'),/work_cycle_report_unaccepted/);
});
test('guard rejects pause, stop, role, task, source and original budget drift; historical read and explicit close remain possible',async t=>{
 for(const drift of ['pause','stop','role','disabled','source','task','generation','budget']){
  const f=await acceptedWorkCycleFixture(t),store=new WorkCycles(f.db),cycle=store.create('owner',f.scope,input(f),'create');
  if(drift==='pause'||drift==='stop')f.policies.control('owner',f.scope,{action:drift,expected_version:2},'policy-drift');
  if(drift==='role')f.db.prepare('UPDATE wb_agents SET version=version+1,capability_epoch=capability_epoch+1 WHERE agent_id=?').run(f.agent.agent_id);
  if(drift==='disabled')f.db.prepare("UPDATE wb_agents SET status='disabled' WHERE agent_id=?").run(f.agent.agent_id);
  if(drift==='source')f.policies.recordSignal('owner',f.scope,{kind:'external_update',source_id:'new-version',source_version:1,source_sha256:'b'.repeat(64),origin:'external'});
  // Managed discovery tasks intentionally reject generic pause. Exercise a
  // changed original task identity directly without weakening that gate.
  if(drift==='task')f.db.prepare('UPDATE wb_persistent_tasks SET version=version+1 WHERE task_id=?').run(cycle.task_id);
  if(drift==='generation')f.db.prepare('UPDATE wb_persistent_tasks SET generation=generation+1 WHERE task_id=?').run(cycle.task_id);
  if(drift==='budget'){f.db.exec('DROP TRIGGER wb_budget_allocation_no_delete');f.db.prepare('DELETE FROM wb_budget_allocations WHERE run_id=?').run(cycle.root_run_id);}
  assert.throws(()=>store.guard('owner',f.scope,cycle.cycle_id),/work_cycle_(authority_revoked|budget_binding_unconfirmed)/,drift);
  assert.deepEqual(store.get('owner',f.scope,cycle.cycle_id),cycle);assert.equal(store.close('owner',f.scope,cycle.cycle_id,{expected_version:1},'close').state,'closed');
 }
});
test('cycle identity, plan manifest and command receipts are immutable; close uses exact CAS and lost-reply identity',async t=>{
 const f=await acceptedWorkCycleFixture(t),store=new WorkCycles(f.db),cycle=store.create('owner',f.scope,input(f),'create');
 for(const sql of ["UPDATE wb_discovery_work_cycles SET plans_json='[]'","UPDATE wb_discovery_work_cycles SET root_run_id='changed'",'DELETE FROM wb_discovery_work_cycles',"UPDATE wb_discovery_work_cycle_commands SET receipt_json='{}'",'DELETE FROM wb_discovery_work_cycle_commands'])assert.throws(()=>f.db.exec(sql),/work_cycle_(identity|command)_immutable/);
 assert.throws(()=>store.close('owner',f.scope,cycle.cycle_id,{expected_version:2},'close'),/work_cycle_version_conflict/);assert.equal(store.get('owner',f.scope,cycle.cycle_id).state,'open');
 const closed=store.close('owner',f.scope,cycle.cycle_id,{expected_version:1},'close');assert.deepEqual(new WorkCycles(f.db).close('owner',f.scope,cycle.cycle_id,{expected_version:1},'close'),closed);
 assert.deepEqual(new WorkCycles(f.db).create('owner',f.scope,input(f),'create'),cycle,'historical receipt recovery is not renewed authority');
 assert.throws(()=>store.close('owner',f.scope,cycle.cycle_id,{expected_version:2},'close'),/idempotency_conflict/);
 const replacement=store.create('owner',f.scope,input(f),'replacement');assert.notEqual(replacement.cycle_id,cycle.cycle_id);assert.equal(replacement.state,'open');
 assert.equal(store.list('owner',f.scope).items.length,2);assert.throws(()=>store.list('owner',f.scope,{before_id:'foreign-cycle'}),/invalid_work_cycle_cursor/);
 const readonly=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});try{const before=readonly.prepare('SELECT total_changes() n').get().n;assert.equal(new WorkCycles(readonly).get('owner',f.scope,cycle.cycle_id).state,'closed');assert.equal(new WorkCycles(readonly).list('owner',f.scope).items.length,2);assert.equal(readonly.prepare('SELECT total_changes() n').get().n,before);}finally{readonly.close();}
});
test('two independent processes compete for one owned workspace artifact slot without creating duplicate resources',{timeout:30000},async t=>{
 const f=await acceptedWorkCycleFixture(t),module=new URL('../../src/always-on/work-cycles.ts',import.meta.url).href,workers=[];
 const source=`import {DatabaseSync} from 'node:sqlite';import {WorkCycles} from ${JSON.stringify(module)};const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;');process.send({ready:true});process.once('message',()=>{try{const result=new WorkCycles(db).create('owner',JSON.parse(process.argv[2]),JSON.parse(process.argv[3]),process.argv[4]);process.send({created:result.cycle_id});}catch(error){process.send({error:error.message});}finally{db.close();process.disconnect();}});`;
 t.after(async()=>{for(const worker of workers)if(worker.child.exitCode===null){worker.child.kill();await worker.done;}});
 for(const key of ['race-one','race-two']){const child=spawn(process.execPath,['--input-type=module','-e',source,join(f.root,'db.sqlite'),JSON.stringify(f.scope),JSON.stringify(input(f)),key],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),messages=[];
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('fixture_process_failed')));});workers.push({child,messages,done});await new Promise((resolve,reject)=>{child.on('message',message=>{messages.push(message);if(message.ready)resolve();});child.once('error',reject);});}
 workers.forEach(worker=>worker.child.send('go'));await Promise.all(workers.map(worker=>worker.done));
 const results=workers.flatMap(worker=>worker.messages).filter(message=>!message.ready);assert.equal(results.filter(result=>result.created).length,1);assert.deepEqual(results.filter(result=>result.error).map(result=>result.error),['work_cycle_slot_occupied']);assert.equal(new WorkCycles(f.db).list('owner',f.scope).items.length,1);
});
test('accepted proposals create a single immutable owned artifact resource without new task/model/run accounting',async t=>{
 const f=await acceptedWorkCycleFixture(t),store=new WorkCycles(f.db),request=input(f),counts=()=>['ga_runs','wb_task_occurrences','wb_model_budget_attempts','wb_budget_allocations'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n),before=counts();
 const cycle=store.create('owner',f.scope,request,'create-original');assert.equal(cycle.state,'open');assert.equal(cycle.version,1);assert.equal(cycle.execution_authorized,false);assert.equal(cycle.plans.length,2);assert.deepEqual(counts(),before);
 assert.ok(Object.isFrozen(cycle));assert.ok(Object.isFrozen(cycle.plans));assert.equal(JSON.stringify(cycle).includes(f.root),false);
 assert.deepEqual(store.create('owner',f.scope,request,'create-original'),cycle);assert.deepEqual(store.get('owner',f.scope,cycle.cycle_id),cycle);assert.deepEqual(store.guard('owner',f.scope,cycle.cycle_id),cycle);
 assert.throws(()=>store.create('owner',f.scope,{...request,plan_ids:[request.plan_ids[0]]},'create-original'),/idempotency_conflict/);
 assert.throws(()=>store.create('owner',f.scope,request,'another-create'),/work_cycle_slot_occupied/);
 assert.throws(()=>store.get('foreign',f.scope,cycle.cycle_id),/work_cycle_not_found/);
 const closed=store.close('owner',f.scope,cycle.cycle_id,{expected_version:1},'close-original');assert.equal(closed.state,'closed');assert.equal(closed.version,2);assert.ok(closed.closed_at);
 assert.deepEqual(store.close('owner',f.scope,cycle.cycle_id,{expected_version:1},'close-original'),closed);assert.throws(()=>store.guard('owner',f.scope,cycle.cycle_id),/work_cycle_closed/);assert.deepEqual(counts(),before);
});
