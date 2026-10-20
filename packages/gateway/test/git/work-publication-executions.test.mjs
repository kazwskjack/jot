import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {upgradeWorkspacePublicationCoordination} from '../../src/workbench/workspace-coordination-upgrade.ts';
async function fixture(t){
 const f=await publicationReviewFixture(t),review=await f.service.prepare('owner',f.scope.project_id,f.input),approved=await f.service.control('owner',f.scope.project_id,review.intent_id,{request_id:'approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 upgradeWorkspacePublicationCoordination(f.db);const module=await import('../../src/persistent-tasks/work-publication-executions.ts');module.installWorkPublicationExecutions(f.db);
 const executions=new module.WorkPublicationExecutions(f.db,f.workbench,f.service),input={request_id:'publication-execution',expected_version:approved.version,review_sha256:approved.review_sha256};return{...f,review,approved,executions,executionModule:module,executionInput:input};
}
const counts=db=>['ga_runs','ga_events','ga_worker_leases','wb_model_budget_attempts'].map(table=>db.prepare('SELECT count(*) n FROM '+table).get().n);

test('original approved publication admission is immutable, idempotent and creates no file, run or Worker',async t=>{
 const f=await fixture(t),before=counts(f.db),index=await readFile(join(f.rootTarget,'.git/index'));
 const receipt=withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput));
 assert.equal(receipt.state,'accepted');assert.equal(receipt.operation_kind,'work_publication');assert.equal(receipt.execution_authorized,false);assert.equal(receipt.intent_id,f.review.intent_id);
 assert.deepEqual(withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput)),receipt);assert.deepEqual(counts(f.db),before);assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),index);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);
 assert.throws(()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput),/work_publication_transaction_required/);
});

test('an admitted publication derives its original family and holds the existing workspace write barrier',async t=>{
 const f=await fixture(t),receipt=withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput)),held=f.executions.reserveWorkspace('owner',f.scope.project_id,receipt.execution_id);
 assert.equal(held.state,'reserved');assert.equal(held.execution_authorized,false);assert.equal(f.executions.workspaceFamily('owner',f.scope.project_id,receipt.execution_id).reservation_id,held.reservation_id);
 assert.throws(()=>f.logicalWorkbench.writeFile('owner','ws',{project_id:f.scope.project_id,path:'source.md',content:'blocked',expected_version:1}),/workspace_coordination_required/);
 assert.equal(f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,receipt.execution_id).state,'released_unstarted');
});


test('revoked review cannot dispatch a historical accepted request or silently release its existing hold',async t=>{
 const f=await fixture(t),receipt=withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput)),held=f.executions.reserveWorkspace('owner',f.scope.project_id,receipt.execution_id);
 await f.service.control('owner',f.scope.project_id,f.review.intent_id,{request_id:'cancel-original-review',action:'cancel',expected_version:2,review_sha256:f.review.review_sha256});
 assert.deepEqual(f.executions.getAdmission('owner',f.scope.project_id,f.executionInput.request_id),receipt);
 assert.deepEqual(withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput)),receipt);
 assert.throws(()=>f.executions.reserveWorkspace('owner',f.scope.project_id,receipt.execution_id),/work_publication_review_changed/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases WHERE reservation_id=?').get(held.reservation_id).n,0);
 assert.equal(f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,receipt.execution_id).state,'released_unstarted');
});

test('pending review, wrong version, caller executor fields and foreign identities cannot admit publication',async t=>{
 const f=await fixture(t),pending=await f.service.prepare('owner',f.scope.project_id,{...f.input,request_id:'another-prepared-review'});
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,pending.intent_id,{...f.executionInput,request_id:'pending',expected_version:1,review_sha256:pending.review_sha256})),/work_publication_review_changed/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,{...f.executionInput,expected_version:1})),/work_publication_review_changed/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,{...f.executionInput,executor:'caller-choice'})),/work_publication_execution_invalid/);
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.executions.admit('foreign',f.scope.project_id,f.review.intent_id,f.executionInput)),/project_not_found/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_executions').get().n,0);
});

test('acceptance and original family hold roll back together without effect, quota or Worker allocation',async t=>{
 const f=await fixture(t),before=counts(f.db);assert.throws(()=>withImmediateTransaction(f.db,()=>{const accepted=f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput);f.executions.reserveWorkspace('owner',f.scope.project_id,accepted.execution_id);throw Error('Controlled original transaction failure')}),/Controlled original transaction failure/);
 for(const table of ['wb_work_publication_executions','wb_work_publication_admissions','wb_workspace_reservations'])assert.equal(f.db.prepare('SELECT count(*) n FROM '+table).get().n,0);
 assert.deepEqual(counts(f.db),before);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);
});

test('unknown future producer storage cannot be interpreted as no execution or a lease timeout release',async t=>{
 const f=await fixture(t),receipt=withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput)),held=f.executions.reserveWorkspace('owner',f.scope.project_id,receipt.execution_id);
 f.db.exec('CREATE TABLE wb_work_publication_future_producers(execution_id TEXT PRIMARY KEY)');
 assert.throws(()=>f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,receipt.execution_id),/work_publication_producer_unconfirmed/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases WHERE reservation_id=?').get(held.reservation_id).n,0);
});

test('original read-only acceptance recovery installs no schema or lifecycle records after restart',async t=>{
 const f=await fixture(t),receipt=withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput)),{DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(f.root,'db.sqlite'),{readOnly:true});
 try{const version=db.prepare('PRAGMA schema_version').get().schema_version,changes=db.prepare('SELECT total_changes() n').get().n,reader=new f.executionModule.WorkPublicationExecutions(db,f.workbench,f.service);assert.deepEqual(reader.getAdmission('owner',f.scope.project_id,f.executionInput.request_id),receipt);assert.equal(db.prepare('PRAGMA schema_version').get().schema_version,version);assert.equal(db.prepare('SELECT total_changes() n').get().n,changes);}finally{db.close()}
});


test('the original Worker skips admitted publication custody and claims the same queued user input after explicit release',async t=>{
 const f=await fixture(t),receipt=withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput));
 const input=f.runs.enqueue(f.admission.conversation_id,'owner',{client_message_id:'queued-after-publication-admission',content:[{type:'text',text:'Synthetic queued user input'}]});
 f.executions.reserveWorkspace('owner',f.scope.project_id,receipt.execution_id);assert.equal(f.coordinator.claimNext('synthetic-worker',5000),null);
 f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,receipt.execution_id);assert.equal(f.coordinator.claimNext('synthetic-worker',5000).run_id,input.run_id);
});


test('copied acceptance rows or an approval service from another physical DB cannot become new authority',async t=>{
 const f=await fixture(t),accepted=withImmediateTransaction(f.db,()=>f.executions.admit('owner',f.scope.project_id,f.review.intent_id,f.executionInput)),copy=join(f.root,'copied-publication.sqlite'),{DatabaseSync}=await import('node:sqlite');f.db.exec("VACUUM INTO '"+copy.replaceAll("'","''")+"'");const db=new DatabaseSync(copy);db.exec('PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON');
 try{const other=new f.executionModule.WorkPublicationExecutions(db,f.workbench,f.service);assert.throws(()=>other.getAdmission('owner',f.scope.project_id,f.executionInput.request_id),/work_publication_execution_source_changed/);
  assert.throws(()=>other.reserveWorkspace('owner',f.scope.project_id,accepted.execution_id),/work_publication_execution_source_changed/);
 }finally{db.close()}
 assert.deepEqual(f.executions.getAdmission('owner',f.scope.project_id,f.executionInput.request_id),accepted);
});
