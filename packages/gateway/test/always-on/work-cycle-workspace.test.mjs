import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {acceptedWorkCycleFixture} from './work-cycle-fixture.mjs';
import {WorkCycles} from '../../src/always-on/work-cycles.ts';
const Manager=(await import('../../src/always-on/work-cycle-workspace.ts').catch(()=>({}))).WorkCycleWorkspaceManager;
const Journal=(await import('../../src/always-on/workspace-journal.ts').catch(()=>({}))).WorkspaceJournal;
test('owned work-cycle workspace manager is available as an internal artifact integration',()=>{assert.equal(typeof Manager,'function');});
async function ready(t){
 const f=await acceptedWorkCycleFixture(t),cycles=new WorkCycles(f.db),cycle=cycles.create('owner',f.scope,{admission_id:f.admission.admission_id,report_sha256:f.report.sha256,plan_ids:f.history.detail('owner',f.scope,f.admission.admission_id).plans.map(plan=>plan.plan_id),expected_policy_version:2,expected_role_version:1,expected_role_epoch:1},'prepare-workspace');
 assert.equal(typeof Journal,'function');const journal=new Journal(f.db),sourceRoot=join(f.root,'synthetic-host-source'),storageRoot=join(f.root,'synthetic-host-snapshots');mkdirSync(join(sourceRoot,'context/empty'),{recursive:true});mkdirSync(storageRoot);writeFileSync(join(sourceRoot,'source.md'),'Original source selected by the accepted plan');writeFileSync(join(sourceRoot,'context/binary.bin'),Buffer.from([0,255,5,13]));writeFileSync(join(sourceRoot,'not-selected'),'not copied');
 const config={sourceRoot,storageRoot,paths:['source.md','context'],signal:new AbortController().signal},manager=new Manager({cycles,journal}),counts=()=>['ga_runs','wb_task_occurrences','wb_model_budget_attempts','wb_budget_allocations'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
 return {...f,cycles,cycle,journal,config,manager,counts};
}
const wrapper=(journal,override={})=>({intent:(...args)=>journal.intent(...args),begin:(...args)=>journal.begin(...args),commit:(...args)=>journal.commit(...args),record:(...args)=>journal.record(...args),...override});

test('accepted cycle prepares real binary context with frozen plan targets and reopens from a new DB connection without new work',async t=>{
 const f=await ready(t),before=f.counts(),first=await f.manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config);
 assert.equal(first.execution_authorized,false);assert.deepEqual(first.plan_paths,['source.md']);assert.deepEqual(first.copy_paths,['context','source.md']);assert.ok(Object.isFrozen(first.plan_paths));assert.deepEqual(readFileSync(join(first.snapshot.isolated_root,'context/binary.bin')),Buffer.from([0,255,5,13]));assert.equal(readdirSync(first.snapshot.isolated_root).includes('not-selected'),false);
 const id=first.snapshot.receipt.snapshot_id;assert.equal(f.journal.intent('owner',f.scope,f.cycle.cycle_id).snapshot_id,id);assert.equal(f.journal.record('owner',f.scope,f.cycle.cycle_id,id).receipt.manifest_sha256,first.snapshot.receipt.manifest_sha256);
 writeFileSync(join(first.snapshot.isolated_root,'source.md'),'Isolated edited result');const reopened=new DatabaseSync(join(f.root,'db.sqlite'));reopened.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=75;');
 try{const manager=new Manager({cycles:new WorkCycles(reopened),journal:new Journal(reopened)}),again=await manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config),observed=await manager.inspect('owner',f.scope,f.cycle.cycle_id,f.config);
  assert.equal(again.snapshot.receipt.snapshot_id,id);assert.equal(again.snapshot.isolated_root,first.snapshot.isolated_root);assert.equal(again.snapshot.receipt.manifest_sha256,first.snapshot.receipt.manifest_sha256);assert.notEqual(observed.result.manifest_sha256,first.snapshot.receipt.manifest_sha256);assert.equal(observed.execution_authorized,false);
 }finally{reopened.close();}
 assert.deepEqual(f.counts(),before);assert.equal(readdirSync(f.config.storageRoot).length,1);assert.equal(readFileSync(join(f.config.sourceRoot,'source.md'),'utf8'),'Original source selected by the accepted plan');
});

test('host configuration and original plan coverage cannot be replaced with browser claims or broader roots',async t=>{
 const f=await ready(t);
 await assert.rejects(()=>f.manager.prepare('owner',f.scope,f.cycle.cycle_id,{...f.config,paths:['context']}),/work_cycle_workspace_plan_uncovered/);assert.equal(f.journal.intent('owner',f.scope,f.cycle.cycle_id),null);
 await assert.rejects(()=>f.manager.prepare('owner',f.scope,f.cycle.cycle_id,{...f.config,configuration_sha256:'a'.repeat(64)}),/work_cycle_workspace_config_invalid/);
 await f.manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config);
 for(const change of [{paths:['source.md']},{limits:{max_entries:20}},{paths:['context','source.md','not-selected']}])await assert.rejects(()=>f.manager.prepare('owner',f.scope,f.cycle.cycle_id,{...f.config,...change}),/work_cycle_workspace_config_changed/);
 const alternate=join(f.root,'other-source');mkdirSync(join(alternate,'context'),{recursive:true});writeFileSync(join(alternate,'source.md'),'other');await assert.rejects(()=>f.manager.prepare('owner',f.scope,f.cycle.cycle_id,{...f.config,sourceRoot:alternate}),/work_cycle_workspace_config_changed/);assert.equal(readdirSync(f.config.storageRoot).length,1);
});

test('partial preparation stays uncertain and retry or inspect never allocates another snapshot',async t=>{
 const f=await ready(t),controller=new AbortController(),before=f.counts(),cycles={guard:(...args)=>{const value=f.cycles.guard(...args);if(readdirSync(f.config.storageRoot).length)controller.abort();return value;}},manager=new Manager({cycles,journal:f.journal});
 await assert.rejects(()=>manager.prepare('owner',f.scope,f.cycle.cycle_id,{...f.config,signal:controller.signal}),/workspace_cancelled|work_cycle_workspace_cancelled/);
 const intent=f.journal.intent('owner',f.scope,f.cycle.cycle_id);assert.ok(intent);assert.equal(f.journal.record('owner',f.scope,f.cycle.cycle_id,intent.snapshot_id),undefined);const roots=readdirSync(f.config.storageRoot);assert.equal(roots.length,1);
 await assert.rejects(()=>f.manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config),/work_cycle_workspace_preparation_uncertain/);await assert.rejects(()=>f.manager.inspect('owner',f.scope,f.cycle.cycle_id,f.config),/work_cycle_workspace_preparation_uncertain/);assert.deepEqual(readdirSync(f.config.storageRoot),roots);assert.deepEqual(f.counts(),before);
});

test('lost journal commit response recovers the same ready artifact without a second copy',async t=>{
 const f=await ready(t),manager=new Manager({cycles:f.cycles,journal:wrapper(f.journal,{commit:(...args)=>{f.journal.commit(...args);throw Error('synthetic response loss');}})});
 await assert.rejects(()=>manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config),/workspace_recovery_commit_unknown/);const id=f.journal.intent('owner',f.scope,f.cycle.cycle_id).snapshot_id,root=readdirSync(f.config.storageRoot);
 const recovered=await f.manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config);assert.equal(recovered.snapshot.receipt.snapshot_id,id);assert.deepEqual(readdirSync(f.config.storageRoot),root);
});

test('closed, foreign, revoked and cancelled cycles cannot access prepared workspaces',async t=>{
 for(const kind of ['foreign','closed','role','pause','cancel']){
  const f=await ready(t);await f.manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config);const roots=readdirSync(f.config.storageRoot),controller=new AbortController();let owner='owner';
  if(kind==='foreign')owner='foreign';if(kind==='closed')f.cycles.close('owner',f.scope,f.cycle.cycle_id,{expected_version:1},'close');if(kind==='role')f.db.prepare('UPDATE wb_agents SET version=version+1,capability_epoch=capability_epoch+1 WHERE agent_id=?').run(f.agent.agent_id);if(kind==='pause')f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause');if(kind==='cancel')controller.abort();
  await assert.rejects(()=>f.manager.inspect(owner,f.scope,f.cycle.cycle_id,{...f.config,signal:controller.signal}),/work_cycle_/);assert.deepEqual(readdirSync(f.config.storageRoot),roots);
 }
});

test('recovery rejects changed private record hash or replaced root and never repairs the source',async t=>{
 const f=await ready(t),prepared=await f.manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config),journal=wrapper(f.journal,{record:(...args)=>{const r=structuredClone(f.journal.record(...args));r.receipt.manifest_sha256='0'.repeat(64);return r;}});
 await assert.rejects(()=>new Manager({cycles:f.cycles,journal}).prepare('owner',f.scope,f.cycle.cycle_id,f.config),/workspace_recovery_invalid/);
 renameSync(prepared.snapshot.isolated_root,prepared.snapshot.isolated_root+'-original');mkdirSync(prepared.snapshot.isolated_root);await assert.rejects(()=>f.manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config),/workspace_recovery_root_changed/);assert.deepEqual(readdirSync(prepared.snapshot.isolated_root),[]);assert.equal(readFileSync(join(f.config.sourceRoot,'source.md'),'utf8'),'Original source selected by the accepted plan');
});

test('source or storage replacement in the journal begin boundary cannot create a ready artifact under the old configuration',async t=>{
 for(const which of ['sourceRoot','storageRoot']){
  const f=await ready(t),originalBegin=f.journal.begin.bind(f.journal),journal=wrapper(f.journal,{begin:(...args)=>{
   const intent=originalBegin(...args),path=f.config[which];renameSync(path,path+'-original');mkdirSync(path);
   if(which==='sourceRoot'){mkdirSync(join(path,'context'));writeFileSync(join(path,'source.md'),'replacement root');}
   return intent;
  }});
  await assert.rejects(()=>new Manager({cycles:f.cycles,journal}).prepare('owner',f.scope,f.cycle.cycle_id,f.config),/work_cycle_workspace_root_changed|workspace_/);
  const intent=f.journal.intent('owner',f.scope,f.cycle.cycle_id);assert.ok(intent);assert.equal(f.journal.record('owner',f.scope,f.cycle.cycle_id,intent.snapshot_id),undefined);
  await assert.rejects(()=>f.manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config),/work_cycle_workspace_config_changed/);
 }
});

test('selection kind replacement after journal begin cannot commit a ready record under the original file scope',async t=>{
 const f=await ready(t),before=f.counts(),journal=wrapper(f.journal,{begin:(...args)=>{
  const intent=f.journal.begin(...args);renameSync(join(f.config.sourceRoot,'source.md'),join(f.config.sourceRoot,'original-source.md'));mkdirSync(join(f.config.sourceRoot,'source.md'));writeFileSync(join(f.config.sourceRoot,'source.md/child.bin'),Buffer.from([0,255,22]));return intent;
 }});
 await assert.rejects(()=>new Manager({cycles:f.cycles,journal}).prepare('owner',f.scope,f.cycle.cycle_id,f.config),/workspace_recovery_commit_unknown|work_cycle_workspace_selection_changed/);
 const intent=f.journal.intent('owner',f.scope,f.cycle.cycle_id);assert.ok(intent);assert.equal(f.journal.record('owner',f.scope,f.cycle.cycle_id,intent.snapshot_id),undefined);
 const roots=readdirSync(f.config.storageRoot);assert.equal(roots.length,1);assert.deepEqual(readFileSync(join(f.config.storageRoot,roots[0],'source.md/child.bin')),Buffer.from([0,255,22]),'completed copying cannot grant a ready identity for a changed selection kind');
 await assert.rejects(()=>f.manager.prepare('owner',f.scope,f.cycle.cycle_id,f.config),/work_cycle_workspace_config_changed/);assert.deepEqual(readdirSync(f.config.storageRoot),roots);assert.deepEqual(f.counts(),before);
});
