import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {join} from 'node:path';import {spawn} from 'node:child_process';
import {acceptedWorkCycleFixture} from './work-cycle-fixture.mjs';import {WorkCycles} from '../../src/always-on/work-cycles.ts';import {canonicalJson} from '../../src/db/canonical-json.ts';import {workspaceManifestHash} from '../../src/always-on/workspace-provider.ts';
const WorkspaceJournal=(await import('../../src/always-on/workspace-journal.ts').catch(()=>({}))).WorkspaceJournal;
const sha=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
async function setup(t){const f=await acceptedWorkCycleFixture(t),cycles=new WorkCycles(f.db),cycle=cycles.create('owner',f.scope,{admission_id:f.admission.admission_id,report_sha256:f.report.sha256,plan_ids:f.history.detail('owner',f.scope,f.admission.admission_id).plans.map(plan=>plan.plan_id),expected_policy_version:2,expected_role_version:1,expected_role_epoch:1},'journal-cycle');return {...f,cycle,cycles,journal:new WorkspaceJournal(f.db)};}
const input=(cycle,change={})=>({expected_cycle_version:cycle.version,snapshot_id:'snapshot-owned',root_binding_sha256:sha({host_binding:'fixture-only'}),selection_sha256:sha(['source.md']),...change});
// Synthetic private metadata only; actual filesystem identities/bytes are checked
// by SnapshotCopyWorkspaceProvider.recover, not by this storage-only journal test.
function record(f,id='snapshot-owned'){
 const storage=join(f.root,'private-snapshots'),isolated=join(storage,id),manifest={protocol:1,provider:'snapshot-copy',paths:['source.md'],entries:[{path:'source.md',kind:'file',sha256:'a'.repeat(64),bytes:3,executable:false}]};
 return {protocol:1,provider:'snapshot-copy',snapshot_id:id,storage_root:{path:storage,canonical:storage,dev:'1',ino:'2'},isolated_root:{path:isolated,canonical:isolated,dev:'1',ino:'3'},manifest,receipt:{protocol:1,provider:'snapshot-copy',snapshot_id:id,manifest_sha256:workspaceManifestHash(manifest),file_count:1,directory_count:0,total_bytes:3,created_at:'2026-10-17T00:00:00.000Z',status:'ready',execution_authorized:false},selection:[{path:'source.md',kind:'file'}],limits:{max_entries:10,max_total_bytes:100,max_file_bytes:100,max_depth:10}};
}
test('journal constructor performs no schema or data writes',()=>{
 const db=new DatabaseSync(':memory:');try{assert.equal(typeof WorkspaceJournal,'function');const before=db.prepare('SELECT total_changes() n').get().n;new WorkspaceJournal(db);assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,0);assert.equal(db.prepare('SELECT total_changes() n').get().n,before);}finally{db.close();}
});
test('one exact preparation intent is immutable, CAS-bound and leaves a missing ready record unknown',async t=>{
 const f=await setup(t),before=['ga_runs','wb_task_occurrences','wb_model_budget_attempts','wb_budget_allocations'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n);
 assert.equal(f.journal.intent('owner',f.scope,f.cycle.cycle_id),null);assert.throws(()=>f.journal.begin('owner',f.scope,f.cycle.cycle_id,input(f.cycle,{expected_cycle_version:2})),/workspace_journal_version_conflict/);
 const intent=f.journal.begin('owner',f.scope,f.cycle.cycle_id,input(f.cycle));assert.equal(intent.snapshot_id,'snapshot-owned');assert.equal(intent.execution_authorized,false);assert.equal(intent.cycle_version,1);assert.equal(JSON.stringify(intent).includes(f.root),false);
 assert.deepEqual(f.journal.begin('owner',f.scope,f.cycle.cycle_id,input(f.cycle)),intent);assert.equal(f.journal.record('owner',f.scope,f.cycle.cycle_id,'snapshot-owned'),undefined);
 for(const changed of [{snapshot_id:'other'},{root_binding_sha256:'b'.repeat(64)},{selection_sha256:'c'.repeat(64)}])assert.throws(()=>f.journal.begin('owner',f.scope,f.cycle.cycle_id,input(f.cycle,changed)),/workspace_journal_conflict/);
 assert.deepEqual(['ga_runs','wb_task_occurrences','wb_model_budget_attempts','wb_budget_allocations'].map(table=>f.db.prepare(`SELECT count(*) n FROM ${table}`).get().n),before);
});
test('only original snapshot and selection can commit; same ready record is idempotent and never a public root receipt',async t=>{
 const f=await setup(t),value=record(f);assert.throws(()=>f.journal.commit('owner',f.scope,f.cycle.cycle_id,value),/workspace_journal_intent_required/);f.journal.begin('owner',f.scope,f.cycle.cycle_id,input(f.cycle));
 assert.throws(()=>f.journal.commit('owner',f.scope,f.cycle.cycle_id,record(f,'foreign-snapshot')),/workspace_journal_conflict/);
 const foreign=record(f);foreign.manifest.paths=['other.md'];foreign.manifest.entries[0].path='other.md';foreign.receipt.manifest_sha256=workspaceManifestHash(foreign.manifest);assert.throws(()=>f.journal.commit('owner',f.scope,f.cycle.cycle_id,foreign),/workspace_journal_conflict/);
 assert.equal(f.journal.commit('owner',f.scope,f.cycle.cycle_id,value),undefined);const changed=f.db.prepare('SELECT total_changes() n').get().n;f.journal.commit('owner',f.scope,f.cycle.cycle_id,value);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changed);assert.deepEqual(f.journal.record('owner',f.scope,f.cycle.cycle_id,value.snapshot_id),value);
 const different=record(f);different.storage_root.ino='99';assert.throws(()=>f.journal.commit('owner',f.scope,f.cycle.cycle_id,different),/workspace_journal_conflict/);
 assert.throws(()=>f.journal.record('owner',f.scope,f.cycle.cycle_id,'foreign-snapshot'),/workspace_journal_conflict/);
});
test('lost commit response is recovered read-only after a separate database reopen',async t=>{
 const f=await setup(t);f.journal.begin('owner',f.scope,f.cycle.cycle_id,input(f.cycle));f.journal.commit('owner',f.scope,f.cycle.cycle_id,record(f));
 const db=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});try{const before=db.prepare('SELECT total_changes() n').get().n,journal=new WorkspaceJournal(db);assert.deepEqual(journal.record('owner',f.scope,f.cycle.cycle_id,'snapshot-owned'),record(f));assert.equal(journal.intent('owner',f.scope,f.cycle.cycle_id).snapshot_id,'snapshot-owned');assert.equal(db.prepare('SELECT total_changes() n').get().n,before);}finally{db.close();}
});
test('foreign owner, close and policy revocation deny both preparation and recovery reads',async t=>{
 for(const drift of ['foreign','closed','revoked']){const f=await setup(t);f.journal.begin('owner',f.scope,f.cycle.cycle_id,input(f.cycle));f.journal.commit('owner',f.scope,f.cycle.cycle_id,record(f));
  if(drift==='closed')f.cycles.close('owner',f.scope,f.cycle.cycle_id,{expected_version:1},'close-cycle');if(drift==='revoked')f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-policy');const owner=drift==='foreign'?'foreign':'owner';
  for(const call of [()=>f.journal.intent(owner,f.scope,f.cycle.cycle_id),()=>f.journal.record(owner,f.scope,f.cycle.cycle_id,'snapshot-owned'),()=>f.journal.begin(owner,f.scope,f.cycle.cycle_id,input(f.cycle)),()=>f.journal.commit(owner,f.scope,f.cycle.cycle_id,record(f))])assert.throws(call,/work_cycle_(not_found|closed|authority_revoked)/,drift);
 }
});
test('immutable journal rows reject replacement, while private record corruption fails closed',async t=>{
 const f=await setup(t);f.journal.begin('owner',f.scope,f.cycle.cycle_id,input(f.cycle));f.journal.commit('owner',f.scope,f.cycle.cycle_id,record(f));
 for(const table of ['wb_discovery_workspace_intents','wb_discovery_workspace_records'])for(const action of [`UPDATE ${table} SET snapshot_id='changed'`,`DELETE FROM ${table}`])assert.throws(()=>f.db.exec(action),/workspace_journal_immutable/);
 f.db.exec('DROP TRIGGER wb_discovery_workspace_records_no_update');f.db.prepare("UPDATE wb_discovery_workspace_records SET record_json='{}'").run();assert.throws(()=>f.journal.record('owner',f.scope,f.cycle.cycle_id,'snapshot-owned'),/workspace_journal_corrupt/);
});
test('competing processes reserve one snapshot identity for the same original cycle',{timeout:30000},async t=>{
 const f=await setup(t),module=new URL('../../src/always-on/workspace-journal.ts',import.meta.url).href,workers=[];
 const source=`import {DatabaseSync} from 'node:sqlite';import {WorkspaceJournal} from ${JSON.stringify(module)};const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;');process.send({ready:true});process.once('message',()=>{try{const result=new WorkspaceJournal(db).begin('owner',JSON.parse(process.argv[2]),process.argv[3],JSON.parse(process.argv[4]));process.send({snapshot:result.snapshot_id});}catch(error){process.send({error:error.message});}finally{db.close();process.disconnect();}});`;
 t.after(async()=>{for(const worker of workers)if(worker.child.exitCode===null){worker.child.kill();await worker.done;}});
 for(const id of ['first-snapshot','second-snapshot']){const child=spawn(process.execPath,['--input-type=module','-e',source,join(f.root,'db.sqlite'),JSON.stringify(f.scope),f.cycle.cycle_id,JSON.stringify(input(f.cycle,{snapshot_id:id}))],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']}),messages=[];
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('fixture_process_failed')));});workers.push({child,messages,done});await new Promise((resolve,reject)=>{child.on('message',message=>{messages.push(message);if(message.ready)resolve();});child.once('error',reject);});}
 workers.forEach(worker=>worker.child.send('go'));await Promise.all(workers.map(worker=>worker.done));const results=workers.flatMap(worker=>worker.messages).filter(message=>!message.ready);assert.equal(results.filter(result=>result.snapshot).length,1);assert.deepEqual(results.filter(result=>result.error).map(result=>result.error),['workspace_journal_conflict']);
});
