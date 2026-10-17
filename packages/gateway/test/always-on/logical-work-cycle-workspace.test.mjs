import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {acceptedWorkCycleFixture} from './work-cycle-fixture.mjs';
import {WorkCycles} from '../../src/always-on/work-cycles.ts';
import {WorkspaceJournal} from '../../src/always-on/workspace-journal.ts';
import {WorkCycleSources} from '../../src/always-on/work-cycle-sources.ts';
const Manager=(await import('../../src/always-on/logical-work-cycle-workspace.ts').catch(()=>({}))).LogicalWorkCycleWorkspaceManager;
const controls=()=>({signal:new AbortController().signal});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,options={}){
 const f=await acceptedWorkCycleFixture(t,options),cycles=new WorkCycles(f.db),cycle=cycles.create('owner',f.scope,{admission_id:f.admission.admission_id,report_sha256:f.report.sha256,plan_ids:f.history.detail('owner',f.scope,f.admission.admission_id).report.plan_ids,expected_policy_version:2,expected_role_version:1,expected_role_epoch:1},'logical-workspace');
 const storageRoot=join(f.root,'logical-snapshots');mkdirSync(storageRoot);return {...f,cycles,cycle,storageRoot,options:{db:f.db,workbench:f.workbench,storageRoot},counts:()=>['ga_runs','wb_task_occurrences','wb_model_budget_attempts','wb_budget_allocations'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n)};
}
const rewrite=(f,path,content,expected_version=0)=>f.workbench.writeFile('owner',f.scope.workspace_id,{project_id:f.scope.project_id,path,content,expected_version});
function binary(f,path,bytes){
 // Controlled immutable internal blob fixture; public workbench files remain text-only.
 const root=f.workbench.projectRoot('owner',f.scope.workspace_id,f.scope.project_id),blob='binary-fixture.txt',hash=sha(bytes);writeFileSync(join(root,'blobs',blob),bytes);
 f.db.prepare('INSERT INTO wb_file_versions VALUES(?,?,?,?,?,?,?,?,?)').run('owner',f.scope.workspace_id,f.scope.project_id,path,1,hash,bytes.length,blob,'now');f.db.prepare('INSERT INTO wb_files VALUES(?,?,?,?,?,?,?,?,?)').run('owner',f.scope.workspace_id,f.scope.project_id,path,1,hash,bytes.length,blob,'now');return join(root,'blobs',blob);
}
test('logical workspace manager is an internal service',()=>assert.equal(typeof Manager,'function'));

test('prepares logical current versions and binary bytes, pins source before intent and restores one artifact from a new DB connection',async t=>{
 const f=await fixture(t);rewrite(f,'source.md','current v2',1);rewrite(f,'docs/notes.md','Logical notes');const bytes=Buffer.from([0,255,17,128]),blob=binary(f,'assets/raw.bin',bytes),before=f.counts(),journal=new WorkspaceJournal(f.db),sources=new WorkCycleSources(f.db);
 const manager=new Manager({...f.options,journal:{intent:(...a)=>journal.intent(...a),record:(...a)=>journal.record(...a),commit:(...a)=>journal.commit(...a),begin:(...a)=>{assert.ok(sources.get('owner',f.scope,f.cycle.cycle_id));return journal.begin(...a);}}}),prepared=await manager.prepare('owner',f.scope,f.cycle.cycle_id,controls());
 assert.equal(prepared.execution_authorized,false);assert.deepEqual(prepared.plan_paths,['source.md']);assert.equal(readFileSync(join(prepared.snapshot.isolated_root,'source.md'),'utf8'),'current v2');assert.deepEqual(readFileSync(join(prepared.snapshot.isolated_root,'assets/raw.bin')),bytes);assert.equal(readdirSync(prepared.snapshot.isolated_root).includes('blobs'),false);assert.equal(prepared.source_manifest.files.find(file=>file.path==='source.md').version,2);
 writeFileSync(join(prepared.snapshot.isolated_root,'source.md'),'Isolated result');const db=new DatabaseSync(join(f.root,'db.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=75;');
 try{const other=new Manager({...f.options,db}),changes=db.prepare('SELECT total_changes() n').get().n,recovered=await other.prepare('owner',f.scope,f.cycle.cycle_id,controls()),inspected=await other.inspect('owner',f.scope,f.cycle.cycle_id,controls()),verified=await other.verifyBase('owner',f.scope,f.cycle.cycle_id,controls());
  assert.equal(recovered.snapshot.receipt.snapshot_id,prepared.snapshot.receipt.snapshot_id);assert.equal(recovered.snapshot.isolated_root,prepared.snapshot.isolated_root);assert.notEqual(inspected.result.manifest_sha256,prepared.snapshot.receipt.manifest_sha256);assert.equal(verified.file_count,3);assert.equal(verified.execution_authorized,false);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
 }finally{db.close();}
 assert.equal(readdirSync(f.storageRoot).length,1);assert.equal(readFileSync(blob).equals(bytes),true);assert.deepEqual(f.counts(),before);
});

test('verifyBase consumes actual immutable bytes and refuses blob corruption even when row metadata is unchanged',async t=>{
 const f=await fixture(t),blob=binary(f,'binary.dat',Buffer.from([0,1,255,7])),manager=new Manager(f.options);await manager.prepare('owner',f.scope,f.cycle.cycle_id,controls());writeFileSync(blob,Buffer.from([0,2,255,7]));
 const before=f.db.prepare('SELECT total_changes() n').get().n;await assert.rejects(()=>manager.verifyBase('owner',f.scope,f.cycle.cycle_id,controls()),/source_/);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);await assert.rejects(()=>new Manager(f.options).prepare('owner',f.scope,f.cycle.cycle_id,controls()),/source_/);assert.equal(readdirSync(f.storageRoot).length,1);
});

test('source changes after first pin never silently rebase or allocate a new isolated root',async t=>{
 const f=await fixture(t),manager=new Manager(f.options),prepared=await manager.prepare('owner',f.scope,f.cycle.cycle_id,controls()),record=new WorkCycleSources(f.db).get('owner',f.scope,f.cycle.cycle_id);rewrite(f,'new.md','late source');
 for(const method of ['prepare','inspect','verifyBase'])await assert.rejects(()=>new Manager(f.options)[method]('owner',f.scope,f.cycle.cycle_id,controls()),/source_record_changed|source_changed/);
 assert.equal(new WorkCycleSources(f.db).get('owner',f.scope,f.cycle.cycle_id).sha256,record.sha256);assert.deepEqual(readdirSync(f.storageRoot),[prepared.snapshot.receipt.snapshot_id]);
});

test('base changes at the first intent boundary fail preparation without an automatic rebase',async t=>{
 const f=await fixture(t),journal=new WorkspaceJournal(f.db),sources=new WorkCycleSources(f.db),manager=new Manager({...f.options,journal:{intent:(...a)=>journal.intent(...a),record:(...a)=>journal.record(...a),commit:(...a)=>journal.commit(...a),begin:(...a)=>{const intent=journal.begin(...a);rewrite(f,'late.md','Added at intent');return intent;}}});
 await assert.rejects(()=>manager.prepare('owner',f.scope,f.cycle.cycle_id,controls()),/source_|workspace_guard_rejected/);assert.ok(sources.get('owner',f.scope,f.cycle.cycle_id));const intent=journal.intent('owner',f.scope,f.cycle.cycle_id);assert.ok(intent);assert.equal(journal.record('owner',f.scope,f.cycle.cycle_id,intent.snapshot_id),undefined);await assert.rejects(()=>new Manager(f.options).prepare('owner',f.scope,f.cycle.cycle_id,controls()),/source_record_changed|source_changed/);
});

test('cancelled, closed, foreign and revoked cycles do not prepare or create source checkpoints',async t=>{
 for(const mode of ['foreign','closed','role','pause','cancel']){const f=await fixture(t),manager=new Manager(f.options);let owner='owner';const controller=new AbortController();if(mode==='foreign')owner='foreign';if(mode==='closed')f.cycles.close('owner',f.scope,f.cycle.cycle_id,{expected_version:1},'close');if(mode==='role')f.db.prepare('UPDATE wb_agents SET version=version+1 WHERE agent_id=?').run(f.agent.agent_id);if(mode==='pause')f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause');if(mode==='cancel')controller.abort();
  await assert.rejects(()=>manager.prepare(owner,f.scope,f.cycle.cycle_id,{signal:controller.signal}),/work_cycle_|source_|logical_workspace_/);assert.deepEqual(readdirSync(f.storageRoot),[]);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_work_cycle_sources').get().n,0);
 }
});

test('empty logical projects and nested new plan targets create no fake source files or placeholder bytes',async t=>{
 for(const planPath of ['source.md','future/deep/new.md']){
  const f=await fixture(t,{planPath});f.db.prepare('DELETE FROM wb_files WHERE owner_id=? AND project_id=?').run('owner',f.scope.project_id);const before=f.counts(),manager=new Manager(f.options),prepared=await manager.prepare('owner',f.scope,f.cycle.cycle_id,controls());
  assert.equal(prepared.source_manifest.files.length,0);assert.deepEqual(prepared.snapshot.manifest.entries,[]);assert.deepEqual(readdirSync(prepared.snapshot.isolated_root),[]);assert.deepEqual(prepared.plan_paths,[planPath]);assert.deepEqual(prepared.copy_paths,[planPath.split('/')[0]]);
  if(planPath.includes('/'))mkdirSync(join(prepared.snapshot.isolated_root,'future/deep'),{recursive:true});writeFileSync(join(prepared.snapshot.isolated_root,planPath),'New isolated result');const inspected=await manager.inspect('owner',f.scope,f.cycle.cycle_id,controls());assert.equal(inspected.result.manifest.entries.find(e=>e.path===planPath).sha256,sha('New isolated result'));assert.equal(f.db.prepare('SELECT count(*) n FROM wb_files WHERE owner_id=? AND project_id=?').get('owner',f.scope.project_id).n,0);assert.deepEqual(f.counts(),before);
 }
});

test('a planned nested target cannot replace an existing base file ancestor',async t=>{
 const f=await fixture(t,{planPath:'source.md/new.md'}),manager=new Manager(f.options);await assert.rejects(()=>manager.prepare('owner',f.scope,f.cycle.cycle_id,controls()),/logical_workspace_plan_ancestor_file/);assert.deepEqual(readdirSync(f.storageRoot),[]);assert.equal(new WorkspaceJournal(f.db).intent('owner',f.scope,f.cycle.cycle_id),null);
});

test('materialization consumes all 501 logical files beyond the public listing window',{timeout:180000},async t=>{
 const f=await fixture(t);for(let index=0;index<500;index++)rewrite(f,'bulk/file-'+String(index).padStart(3,'0')+'.txt','Value '+index);
 assert.equal(f.workbench.listFiles('owner',f.scope.workspace_id,f.scope.project_id).items.length,200);const before=f.counts(),manager=new Manager(f.options),prepared=await manager.prepare('owner',f.scope,f.cycle.cycle_id,controls());
 assert.equal(prepared.source_manifest.files.length,501);assert.equal(prepared.snapshot.receipt.file_count,501);assert.equal(readFileSync(join(prepared.snapshot.isolated_root,'bulk/file-499.txt'),'utf8'),'Value 499');assert.deepEqual(f.counts(),before);
});

test('source additions during real copying refuse ready and keep the original pinned base',async t=>{
 const f=await fixture(t),observe=f.workbench.projectSourceRoot.bind(f.workbench);let changed=false;
 f.workbench.projectSourceRoot=(...args)=>{const root=observe(...args),directories=readdirSync(f.storageRoot);if(!changed&&directories.some(dir=>readdirSync(join(f.storageRoot,dir)).includes('source.md'))){changed=true;rewrite(f,'during-copy.md','Changed during copy');}return root;};
 await assert.rejects(()=>new Manager(f.options).prepare('owner',f.scope,f.cycle.cycle_id,controls()),/source_|workspace_/);assert.equal(changed,true);const journal=new WorkspaceJournal(f.db),intent=journal.intent('owner',f.scope,f.cycle.cycle_id);assert.ok(intent);assert.equal(journal.record('owner',f.scope,f.cycle.cycle_id,intent.snapshot_id),undefined);const count=readdirSync(f.storageRoot).length;await assert.rejects(()=>new Manager(f.options).prepare('owner',f.scope,f.cycle.cycle_id,controls()),/source_record_changed|source_changed/);assert.equal(readdirSync(f.storageRoot).length,count);
});

test('lost commit replies recover the same original base and partial preparation cannot be recopied',async t=>{
 const f=await fixture(t),journal=new WorkspaceJournal(f.db),manager=new Manager({...f.options,journal:{intent:(...a)=>journal.intent(...a),record:(...a)=>journal.record(...a),begin:(...a)=>journal.begin(...a),commit:(...a)=>{journal.commit(...a);throw Error('synthetic reply loss');}}});
 await assert.rejects(()=>manager.prepare('owner',f.scope,f.cycle.cycle_id,controls()),/workspace_recovery_commit_unknown/);const intent=journal.intent('owner',f.scope,f.cycle.cycle_id),before=f.counts(),recovered=await new Manager(f.options).prepare('owner',f.scope,f.cycle.cycle_id,controls());assert.equal(recovered.snapshot.receipt.snapshot_id,intent.snapshot_id);assert.equal(readdirSync(f.storageRoot).length,1);assert.deepEqual(f.counts(),before);
 const partial=await fixture(t),observe=partial.workbench.projectSourceRoot.bind(partial.workbench),controller=new AbortController();partial.workbench.projectSourceRoot=(...args)=>{const root=observe(...args);if(readdirSync(partial.storageRoot).length)controller.abort();return root;};
 await assert.rejects(()=>new Manager(partial.options).prepare('owner',partial.scope,partial.cycle.cycle_id,{signal:controller.signal}),/cancelled|workspace_/);partial.workbench.projectSourceRoot=observe;const roots=readdirSync(partial.storageRoot);await assert.rejects(()=>new Manager(partial.options).prepare('owner',partial.scope,partial.cycle.cycle_id,controls()),/logical_workspace_preparation_uncertain/);assert.deepEqual(readdirSync(partial.storageRoot),roots);
});

test('replacement of the configured storage root and snapshot roots cannot be repaired by logical recovery',async t=>{
 const f=await fixture(t),manager=new Manager(f.options),prepared=await manager.prepare('owner',f.scope,f.cycle.cycle_id,controls());renameSync(prepared.snapshot.isolated_root,prepared.snapshot.isolated_root+'-original');mkdirSync(prepared.snapshot.isolated_root);await assert.rejects(()=>new Manager(f.options).prepare('owner',f.scope,f.cycle.cycle_id,controls()),/workspace_recovery_root_changed/);
 renameSync(f.storageRoot,f.storageRoot+'-original');mkdirSync(f.storageRoot);await assert.rejects(()=>manager.prepare('owner',f.scope,f.cycle.cycle_id,controls()),/logical_workspace_storage_changed/);await assert.rejects(()=>new Manager(f.options).prepare('owner',f.scope,f.cycle.cycle_id,controls()),/logical_workspace_configuration_changed/);assert.deepEqual(readdirSync(f.storageRoot),[]);
});

test('verifyBase never creates a checkpoint and corrupt persisted source facts cannot be used for recovery',async t=>{
 const f=await fixture(t),manager=new Manager(f.options),changes=f.db.prepare('SELECT total_changes() n').get().n;await assert.rejects(()=>manager.verifyBase('owner',f.scope,f.cycle.cycle_id,controls()),/logical_workspace_source_not_prepared/);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 await manager.prepare('owner',f.scope,f.cycle.cycle_id,controls());f.db.exec('DROP TRIGGER wb_discovery_work_cycle_sources_no_update');f.db.prepare("UPDATE wb_discovery_work_cycle_sources SET record_sha256=? WHERE cycle_id=?").run('0'.repeat(64),f.cycle.cycle_id);const before=f.counts();
 for(const method of ['prepare','inspect','verifyBase'])await assert.rejects(()=>new Manager(f.options)[method]('owner',f.scope,f.cycle.cycle_id,controls()),/work_cycle_source_corrupt/);assert.equal(readdirSync(f.storageRoot).length,1);assert.deepEqual(f.counts(),before);
});

test('source changes at publication cannot return ready or silently rebase a committed artifact identity',async t=>{
 const f=await fixture(t),journal=new WorkspaceJournal(f.db),before=f.counts(),manager=new Manager({...f.options,journal:{intent:(...a)=>journal.intent(...a),record:(...a)=>journal.record(...a),begin:(...a)=>journal.begin(...a),commit:(...a)=>{rewrite(f,'publication.md','Source changed at publication');journal.commit(...a);}}});
 await assert.rejects(()=>manager.prepare('owner',f.scope,f.cycle.cycle_id,controls()),/source_changed|workspace_guard_rejected/);const pinned=new WorkCycleSources(f.db).get('owner',f.scope,f.cycle.cycle_id),roots=readdirSync(f.storageRoot);assert.ok(pinned);assert.equal(roots.length,1);
 // A committed artifact record attests old prepared bytes, never renewed source
 // authority. Restore must reject this changed base instead of preparing again.
 await assert.rejects(()=>new Manager(f.options).prepare('owner',f.scope,f.cycle.cycle_id,controls()),/source_record_changed|source_changed/);assert.equal(new WorkCycleSources(f.db).get('owner',f.scope,f.cycle.cycle_id).sha256,pinned.sha256);assert.deepEqual(readdirSync(f.storageRoot),roots);assert.deepEqual(f.counts(),before);
});
