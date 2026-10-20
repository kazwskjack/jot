import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {join} from 'node:path';
import {withImmediateTransaction} from '../../src/db/database.ts';import {indexResolutionFixture} from '../support/index-resolution-fixture.mjs';
function bind(f){f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)').run('conversation','owner','ws','Synthetic','{}',1,'now','now','project');f.db.prepare('INSERT INTO ga_harness_session_bindings(owner_id,conversation_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('owner','conversation','original-session','now','now')}
function confirm(f,id){const value={request_id:'original-confirmation',expected_state_sha256:f.current.executions.inspect('owner','project',id).state_sha256,acknowledge_unknown:true};return withImmediateTransaction(f.db,()=>f.current.executions.admitResolution('owner','project',id,value))}
async function cancel(f,approved){await f.current.intents.control('owner','project',approved.intent_id,{request_id:'cancel-original',action:'cancel',expected_version:approved.version,review_sha256:approved.review_sha256})}

test('original explicit control can read its sealed family after approval cancellation without restoring effects or writing',async t=>{
 const f=await indexResolutionFixture(t);bind(f);const{accepted,approved}=await f.admit(),id=accepted.execution_id;
 f.current.executions.reserveWorkspace('owner','project',id);const original=f.current.executions.workspaceFamily('owner','project',id),receipt=confirm(f,id),before=await readFile(join(f.repository,'.git/index'));await cancel(f,approved);f.reopen();
 assert.throws(()=>f.current.executions.workspaceFamily('owner','project',id),/git_execution_revoked/);
 const changes=f.db.prepare('SELECT total_changes() n').get().n;
 f.db.exec('PRAGMA query_only=ON');try{const view=f.current.executions.resolutionFamily('owner','project',id,receipt.request_id);assert.equal(view.family_sha256,original.family_sha256);assert.equal(view.reservation_id,original.reservation_id);const identity=members=>members.map(({session_ref,scopes})=>({session_ref,scopes}));assert.deepEqual(identity(view.members),identity(original.members));assert.deepEqual(view.members[0].source_kinds,['mode_binding','work_binding'],'startup may backfill the original Work alias without adding another Session');assert.equal(view.control_id,receipt.control_id);assert.equal(view.control_request_id,receipt.request_id);assert.equal(view.execution_authorized,false);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes)}finally{f.db.exec('PRAGMA query_only=OFF')}
 await assert.rejects(f.current.executions.perform('owner','project',id),/git_execution_control_pending/);assert.deepEqual(await readFile(join(f.repository,'.git/index')),before);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);
});

test('recovery family requires original UI control and reservation and cannot follow ownership transfer',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),id=accepted.execution_id;
 assert.throws(()=>f.current.executions.resolutionFamily('owner','project',id,'unadmitted'),/git_execution_control_not_found/);const receipt=confirm(f,id);
 assert.throws(()=>f.current.executions.resolutionFamily('owner','project',id,receipt.request_id),/workspace_reservation_not_found/);
 f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('replacement','project');assert.throws(()=>f.current.executions.resolutionFamily('owner','project',id,receipt.request_id),/project_not_found/);assert.throws(()=>f.current.executions.resolutionFamily('replacement','project',id,receipt.request_id),/git_execution_not_found/);
});

test('recovery inventory refuses new native membership rather than resealing an admitted family',async t=>{
 const f=await indexResolutionFixture(t);bind(f);const{accepted}=await f.admit(),id=accepted.execution_id;f.current.executions.reserveWorkspace('owner','project',id);const receipt=confirm(f,id);
 f.db.exec('SAVEPOINT synthetic_membership_drift');try{
  const triggers=f.db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='ga_conversation_mode_sessions'").all();for(const {name} of triggers)f.db.exec('DROP TRIGGER "'+name.replaceAll('"','""')+'"');
  f.db.prepare('INSERT INTO ga_conversation_mode_sessions(owner_id,conversation_id,mode,session_id,created_at) VALUES(?,?,?,?,?)').run('owner','conversation','chat','unsealed-session','now');
  assert.throws(()=>f.current.executions.resolutionFamily('owner','project',id,receipt.request_id),/workspace_namespace_unconfirmed/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_families').get().n,1);
 }finally{f.db.exec('ROLLBACK TO synthetic_membership_drift; RELEASE synthetic_membership_drift')}
});

test('recovery inventory rejects corrupt original family evidence and never repairs it',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit(),id=accepted.execution_id;f.current.executions.reserveWorkspace('owner','project',id);const receipt=confirm(f,id);
 f.db.exec('SAVEPOINT corrupt_family');try{f.db.exec('DROP TRIGGER wb_workspace_reservation_families_no_update');f.db.prepare('UPDATE wb_workspace_reservation_families SET record_sha256=?').run('0'.repeat(64));assert.throws(()=>f.current.executions.resolutionFamily('owner','project',id,receipt.request_id),/workspace_namespace_unconfirmed/)}finally{f.db.exec('ROLLBACK TO corrupt_family; RELEASE corrupt_family')}
});
