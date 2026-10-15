import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import Fastify from 'fastify';
import {openProductDatabase} from '../../src/db/database.ts';
import {WorkbenchService} from '../../src/workbench/service.ts';
import {registerWorkbenchRoutes} from '../../src/workbench/routes.ts';
import {MemoryLifecycle} from '../../src/workbench/memory-lifecycle.ts';
import {buildServer} from '../../src/server.ts';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const templates=fileURLToPath(new URL('../../file-engine/templates/',import.meta.url));

function fixture(t){
 const base=resolve('.test-tmp/memory-restore');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),db=openProductDatabase(join(root,'db.sqlite')),options={workspaceIds:['ws','other'],root:join(root,'files')},service=new WorkbenchService(db,options),agent=service.createAgent('alice',{name:'Researcher'});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const save=fields=>service.saveMemory('alice','ws',{scope:'project',project_id:agent.project_id,content:'Source conclusion',...fields});
 return {db,service,agent,save,options};
}

test('restoring an owned revision creates an unverified new version without extending expiry',t=>{
 const f=fixture(t),first=f.save({verified:true,provenance:[{kind:'document',reference:'notes/source.md'}],source_revision:'source-1',expires_at:'2099-01-01T00:00:00Z'});
 const second=f.save({memory_id:first.memory_id,expected_version:1,content:'Corrected conclusion',source_revision:'source-2',expires_at:'2098-01-01T00:00:00Z'});
 const old=JSON.stringify(f.service.memoryHistory('alice','ws',first.memory_id).items);
 const restored=f.service.restoreMemory('alice','ws',first.memory_id,{expected_version:2,source_version:1});
 assert.equal(restored.version,3);assert.equal(restored.content,first.content);assert.equal(restored.verified,false);assert.equal(restored.verified_at,null);assert.equal(restored.expires_at,second.expires_at);assert.equal(restored.source_revision,'source-1');assert.deepEqual(restored.provenance,first.provenance);
 const history=f.service.memoryHistory('alice','ws',first.memory_id);assert.deepEqual(history.items.map(v=>v.version),[1,2,3]);assert.equal(history.items[2].restored_from_version,1);assert.equal(history.items[2].restored_over_version,2);assert.equal(JSON.stringify(history.items.slice(0,2)),old);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_restores').get().n,1);
 assert.equal(new MemoryLifecycle(f.db).claim('alice',first.memory_id,2),null);
 assert.equal(new WorkbenchService(f.db,f.options).memoryHistory('alice','ws',first.memory_id).items[2].restored_from_version,1);
});

test('restore is fenced by owner, workspace, exact revision and existing live history',t=>{
 const f=fixture(t),first=f.save({}),second=f.save({memory_id:first.memory_id,expected_version:1,content:'Current'});
 for(const [owner,workspace,input,pattern] of [['bob','ws',{expected_version:2,source_version:1},/memory_not_found/],['alice','other',{expected_version:2,source_version:1},/memory_not_found/],['alice','ws',{expected_version:1,source_version:1},/version_conflict/],['alice','ws',{expected_version:2,source_version:2},/invalid_memory_source_version/],['alice','ws',{expected_version:2,source_version:0},/invalid_memory_source_version/],['alice','ws',{expected_version:2,source_version:1,owner_id:'bob'},/invalid_memory_restore/]])assert.throws(()=>f.service.restoreMemory(owner,workspace,first.memory_id,input),pattern);
 assert.throws(()=>f.service.memoryHistory('bob','ws',first.memory_id),/memory_not_found/);
 assert.equal(f.service.memoryHistory('alice','ws',first.memory_id).items.length,2);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_restores').get().n,0);
 f.service.restoreMemory('alice','ws',first.memory_id,{expected_version:2,source_version:1});assert.throws(()=>f.service.restoreMemory('alice','ws',first.memory_id,{expected_version:2,source_version:1}),/version_conflict/);
});

test('restoration cannot revive expired, deleted, superseded or removed-role memory',t=>{
 const f=fixture(t);
 const expired=f.save({expires_at:'2020-01-01T00:00:00Z'});f.save({memory_id:expired.memory_id,expected_version:1,content:'Still expired'});
 assert.throws(()=>f.service.restoreMemory('alice','ws',expired.memory_id,{expected_version:2,source_version:1}),/memory_restore_expired/);
 const targetExpired=f.save({expires_at:'2020-01-01T00:00:00Z'});f.save({memory_id:targetExpired.memory_id,expected_version:1,content:'Now valid',expires_at:null});assert.throws(()=>f.service.restoreMemory('alice','ws',targetExpired.memory_id,{expected_version:2,source_version:1}),/memory_restore_expired/);
 const deleted=f.save({});f.service.deleteMemory('alice','ws',deleted.memory_id,1);assert.throws(()=>f.service.restoreMemory('alice','ws',deleted.memory_id,{expected_version:2,source_version:1}),/memory_not_found/);assert.throws(()=>f.service.memoryHistory('alice','ws',deleted.memory_id),/memory_not_found/);
 const superseded=f.save({});f.save({supersedes:superseded.memory_id});assert.throws(()=>f.service.restoreMemory('alice','ws',superseded.memory_id,{expected_version:2,source_version:1}),/memory_not_found/);
 const privateMemory=f.service.saveMemory('alice','ws',{scope:'private',agent_id:f.agent.agent_id,content:'Private source'});f.db.prepare("UPDATE wb_agents SET status='deleted' WHERE agent_id=?").run(f.agent.agent_id);assert.throws(()=>f.service.memoryHistory('alice','ws',privateMemory.memory_id),/agent_capability_revoked/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_restores').get().n,0);
});

test('history and restore routes expose no owner identity and reject extra fields',async t=>{
 const f=fixture(t),first=f.save({});f.save({memory_id:first.memory_id,expected_version:1,content:'Updated'});const app=Fastify();t.after(()=>app.close());
 app.setErrorHandler((error,_request,reply)=>reply.code(error.message.endsWith('_not_found')?404:error.message==='version_conflict'?409:400).send({error:error.message}));registerWorkbenchRoutes(app,f.service,request=>String(request.headers['x-user-id']??''));
 const url='/v1/workspaces/ws/memory/'+first.memory_id,headers={'x-user-id':'alice'};
 const history=await app.inject({url:url+'/history',headers});assert.equal(history.statusCode,200,history.body);assert.equal(history.json().items.length,2);assert.equal(JSON.stringify(history.json()).includes('owner_id'),false);
 assert.equal((await app.inject({url:url+'/history',headers:{'x-user-id':'bob'}})).statusCode,404);
 const invalid=await app.inject({method:'POST',url:url+'/restore',headers,payload:{expected_version:2,source_version:1,run_id:'forged'}});assert.equal(invalid.statusCode,400);
 const restored=await app.inject({method:'POST',url:url+'/restore',headers,payload:{expected_version:2,source_version:1}});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().version,3);
 assert.equal((await app.inject({method:'POST',url:url+'/restore',headers,payload:{expected_version:2,source_version:1}})).statusCode,409);
});

test('audit write failure rolls back restored content, revisions and index state',t=>{
 const f=fixture(t),first=f.save({});f.save({memory_id:first.memory_id,expected_version:1,content:'Current'});
 f.db.exec("CREATE TRIGGER fixture_reject_restore BEFORE INSERT ON wb_memory_restores BEGIN SELECT RAISE(ABORT,'fixture_audit_unavailable'); END");
 assert.throws(()=>f.service.restoreMemory('alice','ws',first.memory_id,{expected_version:2,source_version:1}),/fixture_audit_unavailable/);
 assert.equal(f.service.memoryHistory('alice','ws',first.memory_id).current_version,2);assert.equal(f.service.memoryHistory('alice','ws',first.memory_id).items.length,2);
 assert.equal(f.db.prepare('SELECT revision FROM wb_memory_index_jobs WHERE memory_id=?').get(first.memory_id).revision,2);
});

test('full Gateway restore preserves CSRF, idempotent response and explicit expiry conflict',async t=>{
 const base=resolve('.test-tmp/memory-restore-http');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),csrf=randomBytes(32).toString('hex');
 const f=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:templates,csrfToken:csrf,allowedOrigins:['https://fixture.invalid']});
 t.after(async()=>{await f.app.close();f.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const agent=f.workbench.createAgent('alice',{name:'Reader'}),save=input=>f.workbench.saveMemory('alice','ws',{scope:'project',project_id:agent.project_id,content:'Original',...input}),first=save({});save({memory_id:first.memory_id,expected_version:1,content:'Current'});
 const headers={'x-user-id':'alice','x-csrf-token':csrf,origin:'https://fixture.invalid','idempotency-key':'memory-restore-fixture'},payload={expected_version:2,source_version:1},url='/v1/workspaces/ws/memory/'+first.memory_id+'/restore';
 assert.equal((await f.app.inject({method:'POST',url,headers:{...headers,'x-csrf-token':''},payload})).statusCode,403);
 const restored=await f.app.inject({method:'POST',url,headers,payload});assert.equal(restored.statusCode,200,restored.body);const replay=await f.app.inject({method:'POST',url,headers,payload});assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),restored.json());assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_restores').get().n,1);
 assert.equal((await f.app.inject({method:'POST',url,headers:{...headers,'idempotency-key':'different-restore-fixture'},payload})).statusCode,409);
 const expired=save({expires_at:'2020-01-01T00:00:00Z'});save({memory_id:expired.memory_id,expected_version:1,content:'Still expired'});
 const rejected=await f.app.inject({method:'POST',url:'/v1/workspaces/ws/memory/'+expired.memory_id+'/restore',headers:{...headers,'idempotency-key':'expired-restore-fixture'},payload});assert.equal(rejected.statusCode,409,rejected.body);assert.equal(rejected.json().error.code,'MEMORY_RESTORE_EXPIRED');
 const sourceConflict=await f.app.inject({method:'POST',url,headers:{...headers,'idempotency-key':'invalid-source-fixture'},payload:{expected_version:3,source_version:3}});assert.equal(sourceConflict.statusCode,422,sourceConflict.body);
 const cursorConflict=await f.app.inject({url:url.replace('/restore','/history?before_version=0'),headers:{'x-user-id':'alice'}});assert.equal(cursorConflict.statusCode,422,cursorConflict.body);
});

test('a rolled-back restore can retry its original atomic receipt after a temporary audit failure',async t=>{
 const base=resolve('.test-tmp/memory-restore-recovery');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-')),csrf=randomBytes(32).toString('hex');
 const config={databasePath:join(root,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:templates,csrfToken:csrf,allowedOrigins:['https://fixture.invalid']};let f=await buildServer(config);t.after(async()=>{await f.app.close();f.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const agent=f.workbench.createAgent('alice',{name:'Reader'}),first=f.workbench.saveMemory('alice','ws',{scope:'project',project_id:agent.project_id,content:'Original'});f.workbench.saveMemory('alice','ws',{scope:'project',project_id:agent.project_id,memory_id:first.memory_id,expected_version:1,content:'Current'});
 const options={method:'POST',url:'/v1/workspaces/ws/memory/'+first.memory_id+'/restore',headers:{'x-user-id':'alice','x-csrf-token':csrf,origin:'https://fixture.invalid','idempotency-key':'atomic-restore-fixture'},payload:{expected_version:2,source_version:1}};
 f.db.exec("CREATE TRIGGER fixture_restore_unavailable BEFORE INSERT ON wb_memory_restores BEGIN SELECT RAISE(ABORT,'fixture_audit_unavailable'); END");assert.equal((await f.app.inject(options)).statusCode,500);assert.equal(f.workbench.memoryHistory('alice','ws',first.memory_id).current_version,2);
 const pending=f.db.prepare('SELECT response_status,receipt_protocol FROM ga_idempotency WHERE idempotency_key=?').get(options.headers['idempotency-key']);assert.equal(pending.response_status,null);assert.equal(pending.receipt_protocol,'memory-restore-atomic-v1');
 f.db.exec('DROP TRIGGER fixture_restore_unavailable');const retry=await f.app.inject(options);assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().version,3);assert.deepEqual((await f.app.inject(options)).json(),retry.json());assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_restores').get().n,1);
 await f.app.close();f.db.close();f=await buildServer(config);assert.deepEqual((await f.app.inject(options)).json(),retry.json());assert.equal(f.workbench.memoryHistory('alice','ws',first.memory_id).current_version,3);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_restores').get().n,1);
});

test('revision snapshots and restore audits reject database-level rewrites and broken predecessor links',t=>{
 const f=fixture(t),first=f.save({});f.save({memory_id:first.memory_id,expected_version:1,content:'Current'});f.service.restoreMemory('alice','ws',first.memory_id,{expected_version:2,source_version:1});
 for(const sql of ["UPDATE wb_memory_revisions SET snapshot_json='{}' WHERE memory_id=? AND version=2",'DELETE FROM wb_memory_revisions WHERE memory_id=? AND version=2','UPDATE wb_memory_restores SET source_version=2 WHERE memory_id=?','DELETE FROM wb_memory_restores WHERE memory_id=?'])assert.throws(()=>f.db.prepare(sql).run(first.memory_id),/memory_(revision|restore)_immutable/);
 const revisionBefore=f.db.prepare('SELECT * FROM wb_memory_revisions WHERE memory_id=? AND version=2').get(first.memory_id);
 const auditBefore=f.db.prepare('SELECT * FROM wb_memory_restores WHERE memory_id=?').get(first.memory_id);
 assert.throws(()=>f.db.prepare(`INSERT OR REPLACE INTO wb_memory_revisions SELECT memory_id,version,owner_id,'{}',created_at FROM wb_memory_revisions WHERE memory_id=? AND version=2`).run(first.memory_id),/memory_revision_immutable/);
 assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO wb_memory_restores SELECT memory_id,owner_id,from_version,2,result_version,created_at FROM wb_memory_restores WHERE memory_id=?').run(first.memory_id),/memory_restore_immutable/);
 assert.deepEqual(f.db.prepare('SELECT * FROM wb_memory_revisions WHERE memory_id=? AND version=2').get(first.memory_id),revisionBefore);
 assert.deepEqual(f.db.prepare('SELECT * FROM wb_memory_restores WHERE memory_id=?').get(first.memory_id),auditBefore);
 assert.throws(()=>f.db.prepare('INSERT INTO wb_memory_restores VALUES(?,?,?,?,?,?)').run(first.memory_id,'alice',999,1,2,new Date().toISOString()),/FOREIGN KEY/);
 assert.equal(f.service.memoryHistory('alice','ws',first.memory_id).items.length,3);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_restores').get().n,1);
});

test('history reads bounded newest pages without skipping older versions when a new revision arrives',t=>{
 const f=fixture(t),first=f.save({});for(let version=2;version<=105;version++)f.save({memory_id:first.memory_id,expected_version:version-1,content:'Revision '+version});
 const newest=f.service.memoryHistory('alice','ws',first.memory_id);assert.equal(newest.items.length,50);assert.equal(newest.items[0].version,56);assert.equal(newest.items.at(-1).version,105);assert.equal(newest.next_before_version,56);
 f.save({memory_id:first.memory_id,expected_version:105,content:'New concurrent revision'});
 const middle=f.service.memoryHistory('alice','ws',first.memory_id,newest.next_before_version);assert.equal(middle.current_version,106);assert.deepEqual(middle.items.map(item=>item.version),Array.from({length:50},(_,index)=>index+6));assert.equal(middle.next_before_version,6);
 const oldest=f.service.memoryHistory('alice','ws',first.memory_id,middle.next_before_version);assert.deepEqual(oldest.items.map(item=>item.version),[1,2,3,4,5]);assert.equal(oldest.next_before_version,null);
 assert.equal(new Set([...newest.items,...middle.items,...oldest.items].map(item=>item.version)).size,105);
 for(const value of [0,-1,1.5,'56',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>f.service.memoryHistory('alice','ws',first.memory_id,value),/invalid_memory_history_cursor/);
 assert.throws(()=>f.service.memoryHistory('bob','ws',first.memory_id,56),/memory_not_found/);
 assert.equal(f.service.exportMemory('alice','ws',{project_id:f.agent.project_id}).items[0].history.length,106);
});

test('an unreleased preview audit schema without the predecessor FK fails closed at startup',t=>{
 const f=fixture(t);f.db.exec(`DROP TRIGGER wb_memory_restores_no_delete;DROP TABLE wb_memory_restores;
  CREATE TABLE wb_memory_restores(memory_id TEXT NOT NULL,owner_id TEXT NOT NULL,from_version INTEGER NOT NULL,source_version INTEGER NOT NULL,result_version INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(memory_id,result_version),
    FOREIGN KEY(memory_id,source_version) REFERENCES wb_memory_revisions(memory_id,version),FOREIGN KEY(memory_id,result_version) REFERENCES wb_memory_revisions(memory_id,version));`);
 assert.throws(()=>new WorkbenchService(f.db,f.options),/memory_restore_schema_migration_required/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_memory_restores').get().n,0);
});
