import {canonicalJson} from '../../src/db/canonical-json.ts';
import {prepareTaskPresentedFiles} from '../../src/persistent-tasks/completion-candidates.ts';
import {readIsolatedTaskFileVersion} from '../../src/persistent-tasks/isolated-output-source.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {workGrantFixture} from '../always-on/work-grant-fixture.mjs';
import {WorkGrants} from '../../src/always-on/work-grants.ts';
import {WorkAdmissionRecords} from '../../src/always-on/work-admission-records.ts';
import {WorkspaceJournal} from '../../src/always-on/workspace-journal.ts';
import {installIsolatedWorkFiles} from '../../src/always-on/isolated-work-file-schema.ts';
import {IsolatedWorkFiles} from '../../src/always-on/isolated-work-files.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {taskFileSource} from '../../src/persistent-tasks/task-file-source.ts';
import {configureTaskOutputReader,verifyTaskOutputContent} from '../../src/persistent-tasks/output-content.ts';
import {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../../src/db/database.ts';
const hash=s=>createHash('sha256').update(s).digest('hex');

test('trusted output reader rejects unknown and malformed namespaces before workspace fallback',()=>{
 const db=new DatabaseSync(':memory:');try{let reads=0;configureTaskOutputReader(db,()=>{reads++;return {path:'x',version:1,sha256:hash('x'),size:1,content:'x'};});
 for(const source of [{source:'weird'},{source:'isolated'},{source:'workspace',cycle_id:'bad'}])assert.throws(()=>verifyTaskOutputContent(db,{owner:'o',workspace:'w',project:'p',path:'x',version:1,runId:'r',source},{sha256:hash('x'),size:1}),/integrity/);
 assert.equal(reads,0);
 }finally{db.close();}
});

test('real isolated work write commits original proof and preserves historical scoped immutable bytes',async t=>{
 const f=await workGrantFixture(t),grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'isolated-output-grant');
 const admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>{grants.guard('owner',f.scope,grant.grant_id);return {activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:Date.now()};});
 const records=new WorkAdmissionRecords(f.db),identity={owner_id:'owner',...f.scope,cycle_id:grant.cycle_id,snapshot_id:grant.snapshot_id,run_id:admission.run_id,occurrence_id:admission.occurrence_id,call_id:'write-isolated'};
 installIsolatedWorkFiles(f.db);const proofs=new TaskExecutionEvidence(f.db);let proof;
 const service=new IsolatedWorkFiles({db:f.db,resolve:async()=>({workspace:f.prepared,record:new WorkspaceJournal(f.db).record('owner',f.scope,grant.cycle_id,grant.snapshot_id),binding:Object.fromEntries(Object.entries(identity).filter(([k])=>k!=='call_id')),guard:()=>records.guard('owner',admission.run_id)}),commitReceipt:(db,result)=>{proof=proofs.record(result.run_id,result.call_id,'files.write',result);const {operation,...args}=JSON.parse(db.prepare('SELECT i.operation_json FROM wb_isolated_file_intents i JOIN wb_isolated_file_results r ON r.call_key=i.call_key WHERE r.receipt_id=?').get(result.receipt_id).operation_json);db.prepare('INSERT INTO wb_tool_receipts VALUES(?,?,?,?,?)').run(result.run_id,result.call_id,hash(canonicalJson({operation,args})),JSON.stringify({...result,execution_receipt:proof}),new Date().toISOString());}});
 const result=await service.execute(identity,{operation:'files.write',path:'source.md',content:'Isolated first',expected_version:0});assert.ok(proof);assert.notEqual(proof.reference,result.receipt_id);
 const step=f.tasks.upsertSubtask('owner',admission.task_id,{title:'Write isolated',acceptance:'Exact output',status:'completed',evidence:[proof]},admission.run_id);
 const scope={owner_id:'owner',task_id:admission.task_id,occurrence_id:admission.occurrence_id,frozen_context:JSON.stringify(f.scope),steps:[{...step,evidence:[proof]}]};
 const source=taskFileSource(f.db,scope,proof.reference,admission.run_id);assert.equal(source.source,'isolated');assert.equal(source.isolated_receipt_id,result.receipt_id);
 const {readIsolatedTaskFileVersion}=await import('../../src/persistent-tasks/isolated-output-source.ts');
 assert.equal(readIsolatedTaskFileVersion(f.db,source).content,'Isolated first');
 const ledger=f.db.prepare('SELECT request_hash,response_json FROM wb_tool_receipts WHERE run_id=? AND call_id=?').get(identity.run_id,identity.call_id),response=JSON.parse(ledger.response_json);
 for(const changed of [{...ledger,request_hash:'0'.repeat(64)},{...ledger,response_json:JSON.stringify({...response,execution_receipt:{...response.execution_receipt,hash:'0'.repeat(64)}})},{...ledger,response_json:JSON.stringify({...response,run_id:'foreign-producer'})}]){
  f.db.prepare('UPDATE wb_tool_receipts SET request_hash=?,response_json=? WHERE run_id=? AND call_id=?').run(changed.request_hash,changed.response_json,identity.run_id,identity.call_id);
  assert.throws(()=>readIsolatedTaskFileVersion(f.db,source),/unverified/);assert.equal(taskFileSource(f.db,scope,proof.reference,admission.run_id),undefined);
  f.db.prepare('UPDATE wb_tool_receipts SET request_hash=?,response_json=? WHERE run_id=? AND call_id=?').run(ledger.request_hash,ledger.response_json,identity.run_id,identity.call_id);
 }
 assert.equal(readIsolatedTaskFileVersion(f.db,source).content,'Isolated first');
 for(const key of ['owner_id','workspace_id','project_id','task_id','occurrence_id','run_id','cycle_id','snapshot_id','isolated_receipt_id','receipt_id'])assert.throws(()=>readIsolatedTaskFileVersion(f.db,{...source,[key]:'foreign'}),/unverified|integrity/);
 for(const sql of ['DELETE FROM wb_task_execution_receipts','INSERT OR REPLACE INTO wb_task_execution_receipts SELECT * FROM wb_task_execution_receipts'])assert.throws(()=>f.db.exec(sql),/immutable/);
 const sourceInput={owner:source.owner_id,workspace:source.workspace_id,project:source.project_id,runId:'delivery-run',path:source.path,version:source.version,source};
 const tempDb=new DatabaseSync(':memory:');try{configureTaskOutputReader(tempDb,()=>({...readIsolatedTaskFileVersion(f.db,source),source:{source:'workspace'}}));assert.throws(()=>verifyTaskOutputContent(tempDb,sourceInput,source),/integrity/);}finally{tempDb.close();}
 for(const changed of [{...result,source:'weird'},{...result,cycle_id:'foreign'},{...result,receipt_id:'missing'},{...result,sha256:hash('wrong')}])assert.throws(()=>withImmediateTransaction(f.db,()=>proofs.record(admission.run_id,'different-call','files.write',changed)),/unverified/);
 assert.equal(taskFileSource(f.db,{...scope,occurrence_id:'foreign'},proof.reference,admission.run_id),undefined);
 assert.equal(taskFileSource(f.db,{...scope,steps:[]},proof.reference,admission.run_id),undefined);
 const shared=f.db.prepare('SELECT version,sha256 FROM wb_files WHERE path=?').get('source.md');assert.equal(shared.version,1);assert.notEqual(shared.sha256,result.sha256);
 const originalProof=proof;await service.execute({...identity,call_id:'write-next'},{operation:'files.write',path:'source.md',content:'Isolated second',expected_version:1});assert.equal(readIsolatedTaskFileVersion(f.db,source).content,'Isolated first');
 for(const sql of ['UPDATE wb_task_isolated_file_execution_receipts SET path=path','DELETE FROM wb_task_isolated_file_execution_receipts','INSERT OR REPLACE INTO wb_task_isolated_file_execution_receipts SELECT * FROM wb_task_isolated_file_execution_receipts'])assert.throws(()=>f.db.exec(sql),/immutable/);
 const beforeRollback=f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n;
 const broken=new IsolatedWorkFiles({db:f.db,resolve:async()=>({workspace:f.prepared,record:new WorkspaceJournal(f.db).record('owner',f.scope,grant.cycle_id,grant.snapshot_id),binding:Object.fromEntries(Object.entries(identity).filter(([k])=>k!=='call_id')),guard:()=>records.guard('owner',admission.run_id)}),commitReceipt:(db,r)=>{proofs.record(r.run_id,r.call_id,'files.write',r);throw Error('rollback-original-response');}});
 await assert.rejects(()=>broken.execute({...identity,call_id:'rollback-write'},{operation:'files.write',path:'source.md',content:'Uncommitted third',expected_version:2}),/rollback-original-response/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n,beforeRollback);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_isolated_file_results WHERE version=3').get().n,0);
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-isolated');assert.equal(readIsolatedTaskFileVersion(f.db,source).content,'Isolated first');assert.equal(taskFileSource(f.db,scope,originalProof.reference,admission.run_id).source,'isolated');
 const count=f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n;
 assert.throws(()=>withImmediateTransaction(f.db,()=>proofs.record(admission.run_id,'weird-source','files.write',{source:'weird',path:'source.md',...shared,size:15})),/unverified/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_execution_receipts').get().n,count);
});


test('proof-only isolated results cannot become historical sources or verified file proposals',async t=>{
 const f=await workGrantFixture(t),grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'isolated-output-grant');
 const admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>{grants.guard('owner',f.scope,grant.grant_id);return {activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:Date.now()};});
 const records=new WorkAdmissionRecords(f.db),identity={owner_id:'owner',...f.scope,cycle_id:grant.cycle_id,snapshot_id:grant.snapshot_id,run_id:admission.run_id,occurrence_id:admission.occurrence_id,call_id:'write-isolated'};
 installIsolatedWorkFiles(f.db);const proofs=new TaskExecutionEvidence(f.db);let proof;
 const service=new IsolatedWorkFiles({db:f.db,resolve:async()=>({workspace:f.prepared,record:new WorkspaceJournal(f.db).record('owner',f.scope,grant.cycle_id,grant.snapshot_id),binding:Object.fromEntries(Object.entries(identity).filter(([k])=>k!=='call_id')),guard:()=>records.guard('owner',admission.run_id)}),commitReceipt:(db,result)=>{proof=proofs.record(result.run_id,result.call_id,'files.write',result);}});
 const result=await service.execute(identity,{operation:'files.write',path:'source.md',content:'Orphan proof bytes',expected_version:0});
 const row=f.db.prepare('SELECT * FROM wb_task_isolated_file_execution_receipts WHERE receipt_id=?').get(proof.reference),source={...row,source:'isolated',conversation_id:admission.conversation_id,native:false};
 assert.throws(()=>readIsolatedTaskFileVersion(f.db,source),/unverified/);
 const step=f.tasks.upsertSubtask('owner',admission.task_id,{title:'Orphan proof',acceptance:'Reject missing original response',status:'completed',evidence:[proof]},admission.run_id),scope={owner_id:'owner',task_id:admission.task_id,occurrence_id:admission.occurrence_id,frozen_context:JSON.stringify(f.scope),steps:[{...step,evidence:[proof]}]};
 assert.equal(taskFileSource(f.db,scope,proof.reference,admission.run_id),undefined);
 configureTaskOutputReader(f.db,input=>readIsolatedTaskFileVersion(f.db,input.source));
 assert.throws(()=>withImmediateTransaction(f.db,()=>prepareTaskPresentedFiles(f.db,scope,[{path:'source.md'}],admission.run_id)),/task_completion_evidence_required/);
 assert.equal(f.db.prepare('SELECT 1 FROM wb_tool_receipts WHERE run_id=? AND call_id=?').get(identity.run_id,identity.call_id),undefined);assert.ok(result.receipt_id);
});
import {spawnSync} from 'node:child_process';
test('synchronous output reader rejects Promise results without unhandled rejections',()=>{
 const moduleUrl=new URL('../../src/persistent-tasks/output-content.ts',import.meta.url).href;
 const script=`import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {configureTaskOutputReader,verifyTaskOutputContent} from ${JSON.stringify(moduleUrl)};
 const rejected=[];process.on('unhandledRejection',error=>rejected.push(error));
 for(const reader of [()=>Promise.resolve({}),()=>Promise.reject(Error('async-reader-failure'))]){const db=new DatabaseSync(':memory:');try{configureTaskOutputReader(db,reader);assert.throws(()=>verifyTaskOutputContent(db,{owner:'o',workspace:'w',project:'p',runId:'r',path:'x',version:1},{sha256:'0'.repeat(64),size:1}),/task_completion_output_integrity_failed/);}finally{db.close();}}
 await new Promise(resolve=>setImmediate(resolve));assert.equal(rejected.length,0,'reader rejection must be consumed without becoming an unhandledRejection');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',windowsHide:true,env:{...process.env,TEMP:process.env.JOT_TEST_TMP??process.env.TEMP,TMP:process.env.JOT_TEST_TMP??process.env.TMP}});
 assert.equal(child.status,0,child.stderr||child.stdout);
});
test('synchronous output reader refuses thenable content without invoking its continuation',()=>{
 const db=new DatabaseSync(':memory:');let continuations=0;try{configureTaskOutputReader(db,()=>({path:'x',version:1,sha256:hash('x'),size:1,content:'x',then(){continuations++;}}));
 assert.throws(()=>verifyTaskOutputContent(db,{owner:'o',workspace:'w',project:'p',runId:'r',path:'x',version:1},{sha256:hash('x'),size:1}),/task_completion_output_integrity_failed/);assert.equal(continuations,0);
 }finally{db.close();}
});

test('a callable thenable output cannot bypass synchronous reader validation',()=>{
 const db=new DatabaseSync(':memory:');let continuations=0;try{const result=Object.assign(()=>{}, {path:'x',version:1,sha256:hash('x'),size:1,content:'x',then(){continuations++;}});configureTaskOutputReader(db,()=>result);
 assert.throws(()=>verifyTaskOutputContent(db,{owner:'o',workspace:'w',project:'p',runId:'r',path:'x',version:1},{sha256:hash('x'),size:1}),/task_completion_output_integrity_failed/);assert.equal(continuations,0);
 }finally{db.close();}
});
