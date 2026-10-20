import test from 'node:test';import assert from 'node:assert/strict';import {indexResolutionFixture} from '../support/index-resolution-fixture.mjs';import {withImmediateTransaction} from '../../src/db/database.ts';
async function close(f,row){const e=f.current.executions,id=row.accepted.execution_id,command={request_id:'history-close-'+id,expected_state_sha256:e.inspect('owner','project',id).state_sha256,acknowledge_unknown:true};withImmediateTransaction(f.db,()=>e.admitResolution('owner','project',id,command));await e.resolveReserved('owner','project',id,command)}
test('server history discovers only original UI acceptances and current status after reopening without local browser metadata',async t=>{
 const f=await indexResolutionFixture(t),first=await f.admit();await close(f,first);const second=await f.admit();await close(f,second);const internal=await f.review();f.current.workbench.indexEffects('owner','project').prepareIndex=async()=>{throw Error('synthetic_internal_failure')};await assert.rejects(f.current.executions.execute('owner','project',internal.approved.intent_id,internal.input),/synthetic_internal_failure/);
 f.reopen();const changes=f.db.prepare('SELECT total_changes() n').get().n;f.db.exec('PRAGMA query_only=ON');let page;try{page=f.current.executions.history('owner','project')}finally{f.db.exec('PRAGMA query_only=OFF')}
 assert.equal(page.project_id,'project');assert.equal(page.execution_authorized,false);assert.equal(page.next_cursor,null);assert.deepEqual(page.items.map(item=>item.acceptance.execution_id),[second.accepted.execution_id,first.accepted.execution_id]);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
 for(const item of page.items){assert.equal(item.acceptance.accepted,true);assert.equal(item.status.execution.execution_id,item.acceptance.execution_id);assert.equal(item.status.producer.state,'not_started');assert.equal(item.status.workspace_state,'not_reserved')}
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_executions').get().n,3);assert.equal(page.items.length,2);
});
test('history cursor and page bounds remain owned and do not repeat original acceptances',async t=>{
 const f=await indexResolutionFixture(t),rows=[],e=f.current.executions,seen=[];for(let n=0;n<3;n++){const row=await f.admit();rows.push(row);await close(f,row)}let cursor;
 do{const page=e.history('owner','project',cursor,1);assert.equal(page.items.length,1);seen.push(page.items[0].acceptance.execution_id);cursor=page.next_cursor}while(cursor);
 assert.deepEqual(seen,rows.map(row=>row.accepted.execution_id).reverse());assert.equal(new Set(seen).size,3);
 for(const limit of [0,-1,51,1.5,'1'])assert.throws(()=>e.history('owner','project',undefined,limit),/git_execution_invalid/);
 assert.throws(()=>e.history('owner','project','missing'),/git_execution_not_found/);f.db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('other','owner','Other',0,1,'now','now');assert.throws(()=>e.history('owner','other',rows[0].accepted.execution_id),/git_execution_not_found/);
 f.db.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('replacement','project');assert.throws(()=>e.history('owner','project'),/project_not_found/);assert.deepEqual(e.history('replacement','project').items,[]);
});
test('history validates the immutable admission rather than trusting a join or adopting a damaged receipt',async t=>{
 const f=await indexResolutionFixture(t),{accepted}=await f.admit();f.db.exec('SAVEPOINT corrupt_history_receipt');try{f.db.exec('DROP TRIGGER wb_git_index_admissions_no_update');f.db.prepare('UPDATE wb_git_index_admissions SET receipt_sha256=? WHERE execution_id=?').run('0'.repeat(64),accepted.execution_id);assert.throws(()=>f.current.executions.history('owner','project'),/git_admission_receipt_corrupt/)}finally{f.db.exec('ROLLBACK TO corrupt_history_receipt; RELEASE corrupt_history_receipt')}
});
