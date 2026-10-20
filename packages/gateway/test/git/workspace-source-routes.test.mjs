import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';import {GitWorkbench} from '../../src/git/service.ts';import {GitMutationIntents} from '../../src/git/intents.ts';import {GitIndexExecutions} from '../../src/git/index-executions.ts';import {withImmediateTransaction} from '../../src/db/database.ts';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
const token='test-workspace-service-token',url='/internal/v1/workbench/git-workspace-source';
async function fixture(t){
 const parent=await mkdtemp(join(tmpdir(),'jot-git-workspace-source-')),root=join(parent,'repo');await mkdir(root);
 const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'before\n');git('add','.');git('commit','-m','Synthetic source fixture');await writeFile(join(root,'note.txt'),'after\n');
 const bindings=[{owner_id:'owner',project_id:'project',root}],config={databasePath:join(parent,'product.sqlite'),templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],internalChannelToken:token,csrfToken:'test-workspace-csrf-token',allowedOrigins:['http://127.0.0.1:3030'],gitRepositories:bindings};
 let service=await buildServer(config);service.db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('project','owner','Synthetic project',0,1,'now','now');
 const connect=()=>{const kernel=new GitWorkbench(service.projects,bindings),intents=new GitMutationIntents(service.db,service.projects,kernel),executions=new GitIndexExecutions(service.db,service.projects,kernel,intents);return{kernel,intents,executions};};let current=connect();
 const snapshot=await current.kernel.inspect('owner','project'),review=await current.intents.prepare('owner','project',{request_id:'prepare',action:'stage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),approved=await current.intents.control('owner','project',review.intent_id,{request_id:'approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 const accepted=withImmediateTransaction(service.db,()=>current.executions.admit('owner','project',approved.intent_id,{request_id:'execute',expected_version:approved.version,review_sha256:approved.review_sha256}));
 const scope={owner_id:'owner',project_id:'project',execution_id:accepted.execution_id};
 t.after(async()=>{await service.app.close();service.db.close();assert.ok(resolve(parent).startsWith(resolve(tmpdir())+sep));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return{scope,root,accepted,approved,get db(){return service.db},get current(){return current},inject:options=>service.app.inject(options),listen:()=>service.app.listen({host:'127.0.0.1',port:0}),request:(payload=scope,authorization='Bearer '+token)=>service.app.inject({method:'POST',url,headers:{authorization},payload}),async restart(){await service.app.close();service.db.close();service=await buildServer(config);current=connect();}};
}
test('original Gateway source requires service authentication even when a browser owner is present',async t=>{
 const f=await fixture(t);f.current.executions.reserveWorkspace('owner','project',f.accepted.execution_id);
 for(const authorization of ['','Bearer wrong','Bearer '+token+'extra']){const response=await f.request(f.scope,authorization);assert.equal(response.statusCode,401,response.body);assert.equal(response.body.includes(f.accepted.execution_id),false);}
 const response=await f.inject({method:'POST',url,headers:{'x-user-id':'owner',origin:'http://127.0.0.1:3030','x-csrf-token':'test-workspace-csrf-token'},payload:f.scope});assert.equal(response.statusCode,401,response.body);
});
test('source derives only original reserved membership and survives Gateway reopening without effects',async t=>{
 const f=await fixture(t);f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)').run('original-conversation','owner','ws','Synthetic','{}',1,'now','now','project');
 f.db.prepare('INSERT INTO ga_harness_session_bindings(owner_id,conversation_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('owner','original-conversation','original-session','now','now');
 assert.equal((await f.request()).statusCode,409);const reserved=f.current.executions.reserveWorkspace('owner','project',f.accepted.execution_id),index=await readFile(join(f.root,'.git/index'));
 const first=await f.request();assert.equal(first.statusCode,200,first.body);const source=first.json().source;assert.equal(source.reservation_id,reserved.reservation_id);assert.equal(source.execution_authorized,false);assert.deepEqual(source.members.map(m=>m.session_ref),['original-session']);assert.match(first.headers['cache-control'],/private, no-store/);assert.equal(first.body.includes(f.root),false);
 await f.restart();const reopened=(await f.request()).json().source;assert.equal(reopened.family_sha256,source.family_sha256);assert.deepEqual(reopened.members.map(({session_ref,scopes})=>({session_ref,scopes})),source.members.map(({session_ref,scopes})=>({session_ref,scopes})));
 assert.deepEqual(reopened.members[0].source_kinds,['mode_binding','work_binding'],'original startup may backfill a known Work alias without changing membership');assert.deepEqual(await readFile(join(f.root,'.git/index')),index);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_idempotency').get().n,0);
 f.current.executions.releaseUnstartedWorkspace('owner','project',f.accepted.execution_id);assert.equal((await f.request()).statusCode,409);
});
test('a valid service token cannot supply members, another owner, an unknown execution or a revoked project',async t=>{
 const f=await fixture(t);f.current.executions.reserveWorkspace('owner','project',f.accepted.execution_id);
 for(const extra of [{members:[]},{root:'untrusted'},{dispatch:true},{run_id:'fake'}])assert.equal((await f.request({...f.scope,...extra})).statusCode,422);
 for(const changed of [{owner_id:'foreign'},{project_id:'foreign'},{execution_id:'unknown'}])assert.equal((await f.request({...f.scope,...changed})).statusCode,409);
 assert.equal((await f.inject({method:'POST',url:url+'?root=fake',headers:{authorization:'Bearer '+token},payload:f.scope})).statusCode,422);
 f.db.prepare("UPDATE ga_projects SET owner_id='replacement' WHERE id='project'").run();assert.equal((await f.request()).statusCode,409);
});
test('original approval revocation blocks a fresh source read without rewriting historical acceptance',async t=>{
 const f=await fixture(t);f.current.executions.reserveWorkspace('owner','project',f.accepted.execution_id);assert.equal((await f.request()).statusCode,200);
 await f.current.intents.control('owner','project',f.approved.intent_id,{request_id:'cancel-original',action:'cancel',expected_version:f.approved.version,review_sha256:f.approved.review_sha256});
 assert.equal((await f.request()).statusCode,409);assert.deepEqual(f.current.executions.getAdmission('owner','project','execute'),f.accepted);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);
});
test('original adapter reads the reserved source over actual loopback HTTP and never caches revoked membership',async t=>{
 const f=await fixture(t);f.current.executions.reserveWorkspace('owner','project',f.accepted.execution_id);
 const origin=await f.listen(),bridge=new WorkbenchBridge({origin,token});
 const source=await bridge.workspaceFamily(f.scope);assert.deepEqual(source,f.current.executions.workspaceFamily('owner','project',f.accepted.execution_id));assert.equal(Object.isFrozen(source.members),true);
 await assert.rejects(new WorkbenchBridge({origin,token:'test-incorrect-service-token'}).workspaceFamily(f.scope),/native_workspace_source_unavailable/);
 f.current.executions.releaseUnstartedWorkspace('owner','project',f.accepted.execution_id);await assert.rejects(bridge.workspaceFamily(f.scope),/native_workspace_source_unavailable/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
});
