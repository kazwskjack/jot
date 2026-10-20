import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,rename,mkdir,rmdir} from 'node:fs/promises';import {join} from 'node:path';
import {WorkPublicationExecutions} from '../../src/persistent-tasks/work-publication-executions.ts';
import {publicationNativeHostFixture as fixture} from '../support/publication-native-host-fixture.mjs';
import {DatabaseSync} from 'node:sqlite';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;

test('original installed Host holds the distinct publication family and exact isolated placement through an awaited source callback',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t),before=await readFile(join(f.rootTarget,'source.md'));let retained;
 const result=await f.executions.withReservedNativeSource('owner',f.scope.project_id,f.accepted.execution_id,async context=>{
  retained=context;const view=f.executions.inspectNativeSource(context);assert.equal(view.source.intent_id,f.review.intent_id);assert.equal(view.family.execution_id,f.accepted.execution_id);assert.equal(view.family.operation_kind,'work_publication');assert.equal(view.placement.session_ref,'work-test-session');
  assert.equal(view.placement.isolated_root.path,f.prepared.snapshot.isolated_root);assert.notEqual(view.placement.isolated_root.path,f.rootTarget);assert.equal(view.execution_authorized,false);
  assert.ok(Object.isFrozen(view.family)&&Object.isFrozen(view.family.members)&&view.family.members.every(member=>Object.isFrozen(member.scopes)),'the held original family must remain immutable through the callback');
  assert.throws(()=>view.family.members.push({session_ref:'injected'}),TypeError);
  assert.throws(()=>f.agent.runMaintenance(()=>{}),/already has active work/);assert.throws(()=>f.executions.inspectNativeSource({...context}),/work_publication_native_context_invalid/);
  await new Promise(resolve=>setTimeout(resolve,10));f.executions.assertNativeSource(context);return 'original-source-held';
 });
 assert.equal(result,'original-source-held');assert.throws(()=>f.executions.inspectNativeSource(retained),/work_publication_native_context_invalid/);assert.equal(f.calls,0);assert.deepEqual(await readFile(join(f.rootTarget,'source.md')),before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0,'source observation alone cannot settle the reservation');
 f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,f.accepted.execution_id);await f.agent.runMaintenance(async()=>{});await f.close();
});

test('original installed Host verifies completed checkpoint prefix while maintenance is held, including a later balanced native turn',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);try{
  assert.equal(typeof f.executions.verifyNativeSource,'function');
  f.agent.session.append('turn/start',{turn:2});f.agent.session.append('turn/end',{turn:2,reason:{kind:'completed'}});
  await f.executions.withReservedNativeSource('owner',f.scope.project_id,f.accepted.execution_id,async context=>{
   await f.executions.verifyNativeSource(context);f.executions.assertNativeSource(context);
  },AbortSignal.timeout(10000));
  assert.equal(f.calls,0);f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,f.accepted.execution_id);
 }finally{await f.close()}
});

test('original producer publishes the reviewed file under actual native custody, journals every effect and releases only after completion',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);try{
  assert.equal(typeof f.executions.executePublication,'function');const index=await readFile(join(f.rootTarget,'.git/index')),head=f.git('rev-parse','HEAD');
  const result=await f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id);
  assert.equal(result.state,'applied');assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),index);assert.equal(f.git('rev-parse','HEAD'),head);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,1);
  const events=f.db.prepare('SELECT kind FROM wb_work_publication_journal WHERE execution_id=? ORDER BY sequence').all(f.accepted.execution_id).map(row=>row.kind);
  assert.deepEqual(events,['start','prepared','intent','effect','intent','effect','applied','finish']);
  assert.deepEqual(await f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),result);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,events.length);assert.equal(f.calls,0);
 }finally{await f.close()}
});

test('original producer journals missing structural parents and publishes a nested new file without changing the source base',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t,{outputPath:'nested/deep/result.md'});try{
  const result=await f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id);assert.equal(result.state,'applied');
  assert.equal(await readFile(join(f.rootTarget,'nested/deep/result.md'),'utf8'),'Exact reviewed work content');assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);
  const phases=f.db.prepare("SELECT json_extract(record_json,'$.payload.phase') phase FROM wb_work_publication_journal WHERE execution_id=? AND kind='effect' ORDER BY sequence").all(f.accepted.execution_id).map(row=>row.phase);
  assert.deepEqual(phases,['directory','directory','stage','publish']);assert.deepEqual(result.files.map(file=>file.path),['nested/deep/result.md']);assert.equal(f.calls,0);
 }finally{await f.close()}
});

test('a lost publication acknowledgement retains original journal for restart without replay or releasing the workspace',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);try{
  assert.equal(typeof f.executions.executePublication,'function');const kernel=f.workbench.indexEffects('owner',f.scope.project_id),apply=kernel.applyPublication.bind(kernel);
  kernel.applyPublication=(plan,authority,signal)=>apply(plan,{...authority,apply(step,operation){const value=authority.apply(step,operation);if(step.phase==='publish')throw Error('synthetic_ack_lost');return value;}},signal);
  await assert.rejects(f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),/synthetic_ack_lost/);
  assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);
  const before=f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n;
  assert.equal(f.executions.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id).state,'unknown');
  await assert.rejects(f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),/work_publication_producer_closed/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,before);
  const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});try{
   const restarted=new WorkPublicationExecutions(db,f.workbench,f.service),changes=db.prepare('SELECT total_changes() n').get().n;
   assert.equal(restarted.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id).state,'unknown');assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);
  }finally{db.close()}
 }finally{await f.close()}
});

test('a physical write before its database receipt failure remains unknown and cannot use the unstarted release path',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);try{
  f.db.exec(`CREATE TRIGGER synthetic_publication_receipt_fault BEFORE INSERT ON wb_work_publication_journal
   WHEN NEW.kind='effect' AND json_extract(NEW.record_json,'$.payload.phase')='publish'
   BEGIN SELECT RAISE(ABORT,'synthetic_receipt_storage_failed'); END;`);
  await assert.rejects(f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),/synthetic_receipt_storage_failed/);
  assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');
  const status=f.executions.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id);assert.equal(status.state,'unknown');assert.equal(status.pending_path,'source.md');assert.deepEqual(status.files,[]);
  assert.throws(()=>f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,f.accepted.execution_id),/work_publication_producer_unconfirmed/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);
 }finally{await f.close()}
});

test('the completed original journal is immutable and a corrupted link cannot pass historical status or settlement',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);try{
  await f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id);
  assert.throws(()=>f.db.prepare('DELETE FROM wb_work_publication_journal WHERE execution_id=?').run(f.accepted.execution_id),/immutable/);
  assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO wb_work_publication_journal SELECT * FROM wb_work_publication_journal WHERE execution_id=? AND sequence=1').run(f.accepted.execution_id),/sequence_invalid/);
  f.db.exec('SAVEPOINT synthetic_journal_fault');try{
   f.db.exec('DROP TRIGGER wb_work_publication_journal_no_update');f.db.prepare("UPDATE wb_work_publication_journal SET record_sha256='broken' WHERE execution_id=? AND sequence=2").run(f.accepted.execution_id);
   assert.throws(()=>f.executions.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id),/work_publication_journal_corrupt/);
  }finally{f.db.exec('ROLLBACK TO synthetic_journal_fault;RELEASE synthetic_journal_fault')}
  assert.equal(f.executions.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id).state,'applied');
 }finally{await f.close()}
});

test('the owner can explicitly abandon an unknown original effect after review revocation without deleting or replaying files',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);try{
  assert.equal(typeof f.executions.settlePublication,'function');
  f.db.exec(`CREATE TRIGGER synthetic_publication_receipt_fault BEFORE INSERT ON wb_work_publication_journal WHEN NEW.kind='effect' AND json_extract(NEW.record_json,'$.payload.phase')='publish' BEGIN SELECT RAISE(ABORT,'synthetic_receipt_storage_failed'); END;`);
  await assert.rejects(f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),/synthetic_receipt_storage_failed/);
  await f.service.control('owner',f.scope.project_id,f.review.intent_id,{request_id:'cancel-original-review',action:'cancel',expected_version:2,review_sha256:f.review.review_sha256});
  const before=f.executions.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id),command={request_id:'ack-unknown',action:'abandon_unknown',expected_journal_sha256:before.journal_sha256,acknowledge_unknown:true};
  await assert.rejects(f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,{...command,acknowledge_unknown:false}),/invalid/);
  await assert.rejects(f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,{...command,request_id:123}),/invalid/);
  await assert.rejects(f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,{...command,root:f.rootTarget}),/invalid/);
  await assert.rejects(f.executions.settlePublication('foreign',f.scope.project_id,f.accepted.execution_id,command),/project_not_found/);
  await assert.rejects(f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,{...command,expected_journal_sha256:'0'.repeat(64)}),/conflict/);
  const result=await f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,command);assert.equal(result.state,'abandoned_unknown');
  assert.deepEqual(await f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,command),result);
  assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,1);assert.equal(f.calls,0);
  await assert.rejects(f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),/producer_closed/);
 }finally{await f.close()}
});

test('a recorded application whose producer finish failed can be explicitly confirmed under fresh native custody',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);try{
  assert.equal(typeof f.executions.settlePublication,'function');
  f.db.exec(`CREATE TRIGGER synthetic_publication_finish_fault BEFORE INSERT ON wb_work_publication_journal WHEN NEW.kind='finish' BEGIN SELECT RAISE(ABORT,'synthetic_finish_storage_failed'); END;`);
  await assert.rejects(f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),/synthetic_finish_storage_failed/);
  const before=f.executions.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id);assert.equal(before.state,'applied_pending_settlement');
  const result=await f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,{request_id:'confirm-recorded',action:'confirm_recorded',expected_journal_sha256:before.journal_sha256,acknowledge_unknown:true});
  assert.equal(result.state,'applied');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM wb_work_publication_journal WHERE kind='start'").get().n,1);assert.equal(f.calls,0);
 }finally{await f.close()}
});

test('a consistent database receipt with the wrong actual native prefix cannot start the producer or write files',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t,{badCheckpoint:true});try{
  await assert.rejects(f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),/checkpoint_storage_conflict/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
  assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);assert.equal(f.calls,0);f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,f.accepted.execution_id);
 }finally{await f.close()}
});

test('lost owner-resolution acknowledgement resumes the exact recorded command under fresh custody and settles once',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);try{
  f.db.exec(`CREATE TRIGGER synthetic_publication_receipt_fault BEFORE INSERT ON wb_work_publication_journal WHEN NEW.kind='effect' AND json_extract(NEW.record_json,'$.payload.phase')='publish' BEGIN SELECT RAISE(ABORT,'synthetic_receipt_storage_failed'); END;`);
  await assert.rejects(f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),/synthetic_receipt_storage_failed/);
  const before=f.executions.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id),command={request_id:'ack-recovered',action:'abandon_unknown',expected_journal_sha256:before.journal_sha256,acknowledge_unknown:true};
  const family=f.executions.workspaceFamily.bind(f.executions);f.executions.workspaceFamily=(...args)=>{if(f.db.prepare("SELECT 1 FROM wb_work_publication_journal WHERE kind='disposition'").get())throw Error('synthetic_resolution_ack_lost');return family(...args)};
  await assert.rejects(f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,command),/synthetic_resolution_ack_lost/);f.executions.workspaceFamily=family;
  assert.equal(f.executions.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id).state,'abandon_pending_settlement');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);
  const result=await f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,command);assert.equal(result.state,'abandoned_unknown');
  assert.equal(f.db.prepare("SELECT count(*) n FROM wb_work_publication_journal WHERE kind='disposition'").get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,1);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');
 }finally{await f.close()}
});

test('a replacement original Worker lease fences publication and cannot be removed by the old producer or owner resolution',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);try{
  f.db.exec(`CREATE TRIGGER synthetic_replace_publisher AFTER INSERT ON wb_work_publication_journal WHEN NEW.kind='start'
   BEGIN UPDATE ga_worker_leases SET owner='synthetic-replacement',generation=generation+1
   WHERE resource_id='git-index-binding:'||(SELECT binding_sha256 FROM wb_work_publication_executions WHERE execution_id=NEW.execution_id); END;`);
  await assert.rejects(f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id),/workbench_execution_lease_revoked/);
  assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);assert.equal(f.db.prepare('SELECT owner FROM ga_worker_leases').get().owner,'synthetic-replacement');
  const status=f.executions.publicationStatus('owner',f.scope.project_id,f.accepted.execution_id);assert.equal(status.state,'interrupted');
  await assert.rejects(f.executions.settlePublication('owner',f.scope.project_id,f.accepted.execution_id,{request_id:'cannot-close-foreign-worker',action:'abandon_unknown',expected_journal_sha256:status.journal_sha256,acknowledge_unknown:true}),/producer_busy/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);assert.equal(f.calls,0);
 }finally{await f.close()}
});
for(const custody of ['resident','cold'])test('actual original producer retains both historical isolated native Sessions, including failed work: '+custody,{skip:!runtime,timeout:60000},async t=>{
 const f=await fixture(t,{additionalHistory:custody==='cold'?'cold':true});try{
  const before=f.executions.reserveWorkspace('owner',f.scope.project_id,f.accepted.execution_id);assert.equal(before.state,'reserved');
  const family=f.executions.workspaceFamily('owner',f.scope.project_id,f.accepted.execution_id);assert.ok(family.members.some(member=>member.session_ref===f.history.session));assert.ok(family.members.some(member=>member.session_ref==='work-test-session'));
  const result=await f.executions.executePublication('owner',f.scope.project_id,f.accepted.execution_id);assert.equal(result.state,'applied');
  assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');
  assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(f.history.admission.run_id).status,'failed');assert.equal(f.calls,0);
  assert.ok([...f.observations].some(view=>view.workspaces.some(member=>member.session_ref===f.history.session&&member.custody===custody)),'the original Host must actually observe the requested custody');
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,1);
 }finally{await f.close()}
});

test('physical replacement of an older failed native workspace during retained source custody refuses before publication',{skip:!runtime,timeout:60000},async t=>{
 const f=await fixture(t,{additionalHistory:true});try{
  await assert.rejects(f.executions.withReservedNativeSource('owner',f.scope.project_id,f.accepted.execution_id,async context=>{
   const root=f.history.prepared.snapshot.isolated_root;await rename(root,root+'-original');await mkdir(root);
   try{f.executions.assertNativeSource(context)}finally{await rmdir(root);await rename(root+'-original',root)}
  }),/git_publication_native_workspace_changed/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,0);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);assert.equal(f.calls,0);
  f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,f.accepted.execution_id);
 }finally{await f.close()}
});

test('unchanged original database reuses only historical placement derivation while own and external commits invalidate it',{skip:!runtime,timeout:60000},async t=>{
 const f=await fixture(t,{additionalHistory:true}),prepare=f.db.prepare;let scans=0;
 f.db.prepare=function(sql,...args){if(sql.includes('SELECT DISTINCT r.id FROM ga_runs r'))scans++;return prepare.call(this,sql,...args)};
 try{
  await f.executions.withReservedNativeSource('owner',f.scope.project_id,f.accepted.execution_id,async context=>{
   const before=scans;for(let i=0;i<4;i++)f.executions.assertNativeSource(context);
   assert.equal(scans,before,'unchanged original evidence must not be fully rederived for every synchronous native guard');
   f.db.prepare('UPDATE ga_projects SET title=title WHERE id=?').run(f.scope.project_id);f.executions.assertNativeSource(context);assert.ok(scans>before,'same-connection writes must invalidate');const own=scans;
   const other=new DatabaseSync(join(f.root,'db.sqlite'));try{other.prepare("UPDATE ga_projects SET title=title||' ' WHERE id=?").run(f.scope.project_id)}finally{other.close()}
   f.executions.assertNativeSource(context);assert.ok(scans>own,'a different original DB connection must invalidate');const external=scans;
   f.db.exec('CREATE TABLE synthetic_placement_cache_marker(value TEXT)');f.executions.assertNativeSource(context);assert.ok(scans>external,'schema changes must invalidate');f.db.exec('DROP TABLE synthetic_placement_cache_marker');
   f.executions.assertNativeSource(context);const beforeRollback=scans;f.db.exec('SAVEPOINT synthetic_cache_rollback');f.db.prepare('UPDATE ga_projects SET title=title WHERE id=?').run(f.scope.project_id);f.db.exec('ROLLBACK TO synthetic_cache_rollback; RELEASE synthetic_cache_rollback');
   f.executions.assertNativeSource(context);assert.ok(scans>beforeRollback,'rolled-back own writes must not restore a stale cache stamp');
  });
  assert.equal(f.calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,0);f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,f.accepted.execution_id);
 }finally{f.db.prepare=prepare;await f.close()}
});

test('original review revocation during held native source invalidates it and leaves custody unresolved',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);
 await assert.rejects(f.executions.withReservedNativeSource('owner',f.scope.project_id,f.accepted.execution_id,async context=>{
  await f.service.control('owner',f.scope.project_id,f.review.intent_id,{request_id:'cancel-held',action:'cancel',expected_version:2,review_sha256:f.review.review_sha256});f.executions.assertNativeSource(context);
 }),/work_publication_review_changed/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);assert.equal(f.calls,0);f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,f.accepted.execution_id);await f.close();
});
