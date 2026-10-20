import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
import {canonicalJson} from '../../src/db/canonical-json.ts';
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const counters=db=>({schema:db.prepare('PRAGMA schema_version').get().schema_version,changes:db.prepare('SELECT total_changes() n').get().n});

test('completed source retains its original private native placement without renewing execution or reading mutable files',async t=>{
 const f=await publicationReviewFixture(t),sources=new FinalizedWorkSources(f.db),before=counters(f.db);
 assert.equal(typeof sources.nativePlacement,'function');
 const placement=sources.nativePlacement('owner',f.admission.run_id,f.source.source_sha256);
 assert.equal(placement.session_ref,'work-test-session');assert.equal(placement.source_sha256,f.source.source_sha256);assert.equal(placement.snapshot_id,f.admission.snapshot_id);
 assert.equal(placement.isolated_root.path,f.prepared.snapshot.isolated_root);assert.equal(placement.execution_authorized,false);assert.ok(Object.isFrozen(placement.isolated_root));assert.deepEqual(counters(f.db),before);
 await writeFile(join(placement.isolated_root.path,'source.md'),'A later mutable edit');
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-after-placement');
 assert.deepEqual(sources.nativePlacement('owner',f.admission.run_id,f.source.source_sha256),placement);
 assert.ok(!JSON.stringify(sources.summary('owner',f.admission.run_id)).includes(placement.isolated_root.path),'public historical projection must not expose host paths');
});

test('rehashed replacement placement cannot replace the original grant-bound snapshot',async t=>{
 const f=await publicationReviewFixture(t),sources=new FinalizedWorkSources(f.db);
 assert.equal(typeof sources.nativePlacement,'function');
 const before=sources.nativePlacement('owner',f.admission.run_id,f.source.source_sha256),saved=f.db.prepare('SELECT * FROM wb_discovery_workspace_records WHERE cycle_id=?').get(f.admission.cycle_id);
 f.db.exec('SAVEPOINT placement_fault');try{
  const record=JSON.parse(saved.record_json);record.isolated_root.ino=String(BigInt(record.isolated_root.ino)+1n);
  f.db.exec('DROP TRIGGER wb_discovery_workspace_records_no_update');f.db.prepare('UPDATE wb_discovery_workspace_records SET record_json=?,record_sha256=? WHERE cycle_id=?').run(canonicalJson(record),hash(record),f.admission.cycle_id);
  assert.throws(()=>sources.nativePlacement('owner',f.admission.run_id,f.source.source_sha256),/completed_work_source_unavailable/);
 }finally{f.db.exec('ROLLBACK TO placement_fault; RELEASE placement_fault')}
 assert.deepEqual(sources.nativePlacement('owner',f.admission.run_id,f.source.source_sha256),before);
 assert.throws(()=>sources.nativePlacement('owner',f.admission.run_id,'0'.repeat(64)),/completed_work_source_conflict/);
 assert.throws(()=>sources.nativePlacement('foreign',f.admission.run_id,f.source.source_sha256),/completed_work_source_not_found/);
});

test('private placement reads work on the original read-only database without schema or data changes',async t=>{
 const f=await publicationReviewFixture(t),{DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});
 try{const before=counters(db),sources=new FinalizedWorkSources(db);assert.equal(typeof sources.nativePlacement,'function');assert.equal(sources.nativePlacement('owner',f.admission.run_id,f.source.source_sha256).session_ref,'work-test-session');assert.deepEqual(counters(db),before);}finally{db.close()}
});

test('configured target associates the producing native Session with the original isolated root, retaining both physical identities',async t=>{
 const f=await publicationReviewFixture(t),sources=new FinalizedWorkSources(f.db);assert.equal(typeof sources.nativePlacement,'function');
 const placement=sources.nativePlacement('owner',f.admission.run_id,f.source.source_sha256),kernel=f.workbench.indexEffects('owner',f.scope.project_id);
 assert.equal(typeof kernel.retainPublicationNativeWorkspaceRoots,'function');
 const input=[{session_ref:placement.session_ref,custody:'cold',cwd:placement.isolated_root.path,header_sha256:'a'.repeat(64)},{session_ref:'ordinary-target-session',custody:'resident',cwd:f.rootTarget,header_sha256:'b'.repeat(64)}];
 const check=kernel.retainPublicationNativeWorkspaceRoots(placement,input);check();
 input[0].cwd=f.rootTarget;check();
 const old=placement.isolated_root.path+'-retained';await rename(placement.isolated_root.path,old);await mkdir(placement.isolated_root.path);
 assert.throws(check,/git_publication_native_workspace_changed/);
});

test('a copied, missing, borrowed or relocated producing Session is not a publication source association',async t=>{
 const f=await publicationReviewFixture(t),sources=new FinalizedWorkSources(f.db);assert.equal(typeof sources.nativePlacement,'function');
 const placement=sources.nativePlacement('owner',f.admission.run_id,f.source.source_sha256),kernel=f.workbench.indexEffects('owner',f.scope.project_id);assert.equal(typeof kernel.retainPublicationNativeWorkspaceRoots,'function');
 const original={session_ref:placement.session_ref,custody:'resident',cwd:placement.isolated_root.path,header_sha256:'a'.repeat(64)};
 for(const observations of [[],[{...original,session_ref:'borrowed'}],[{...original,cwd:f.rootTarget}],[{...original,custody:'absent',cwd:null,header_sha256:null}],[original,{...original}],[{...original,header_sha256:null}]])assert.throws(()=>kernel.retainPublicationNativeWorkspaceRoots(placement,observations),/git_publication_native_workspace_association_required/);
});
