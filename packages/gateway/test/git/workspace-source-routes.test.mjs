import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep,dirname} from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildServer} from '../../src/server.ts';import {GitWorkbench} from '../../src/git/service.ts';import {GitMutationIntents} from '../../src/git/intents.ts';import {GitIndexExecutions} from '../../src/git/index-executions.ts';import {withImmediateTransaction} from '../../src/db/database.ts';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
import {createNativeWorkspaceSourceHost,inspectNativeWorkspaceSource} from '../../../session-adapter/native-workspace-source.js';
import * as nativeWorkspaceSource from '../../../session-adapter/native-workspace-source.js';
import {createNativeWorkspaceFactoryGate,createNativeWorkspaceAdmissionGate} from '../../../session-adapter/native-workspace-factory.js';
import {createNativeInvariantReplay} from '../../../session-adapter/native-invariant-replay.js';
import {prepareDshPreSetupRuntime} from '../../../session-adapter/scripts/prepare-dsh-pre-setup.mjs';
import {reserveWorkspaceOperation} from '../../src/workbench/workspace-coordination.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';
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
 return{scope,root,accepted,approved,get db(){return service.db},get current(){return current},inject:options=>service.app.inject(options),listen:()=>service.app.listen({host:'127.0.0.1',port:0}),request:(payload=scope,authorization='Bearer '+token)=>service.app.inject({method:'POST',url,headers:{authorization},payload}),nativeRequest:(session_ref,authorization='Bearer '+token)=>service.app.inject({method:'POST',url:'/internal/v1/workbench/native-workspace-admission',headers:{authorization},payload:{session_ref}}),async restart(){await service.app.close();service.db.close();service=await buildServer(config);current=connect();}};
}

test('reserved dispatch without the original native host remains unavailable and creates no producer',async t=>{
 const f=await fixture(t),index=await readFile(join(f.root,'.git/index'));
 assert.equal(typeof f.current.executions.performReserved,'function');
 await assert.rejects(f.current.executions.performReserved('owner','project',f.accepted.execution_id),/git_native_workspace_host_unavailable/);
 assert.deepEqual(await readFile(join(f.root,'.git/index')),index);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservations').get().n,0);
});
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

test('native admission observes the durable original family across restart and original approval revocation',async t=>{
 const f=await fixture(t);
 f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)').run('original-conversation','owner','ws','Synthetic','{}',1,'now','now','project');
 f.db.prepare('INSERT INTO ga_harness_session_bindings(owner_id,conversation_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('owner','original-conversation','original-session','now','now');
 const before=await f.nativeRequest('original-session');assert.equal(before.statusCode,200,before.body);assert.equal(before.json().execution_authorized,false);
 f.current.executions.reserveWorkspace('owner','project',f.accepted.execution_id);
 assert.equal((await f.nativeRequest('original-session')).statusCode,409);
 assert.equal((await f.nativeRequest('unknown-session')).statusCode,409,'unbound namespace cannot bypass a durable hold');
 await f.restart();assert.equal((await f.nativeRequest('original-session')).statusCode,409);
 await f.current.intents.control('owner','project',f.approved.intent_id,{request_id:'cancel-native-held',action:'cancel',expected_version:f.approved.version,review_sha256:f.approved.review_sha256});
 assert.equal((await f.nativeRequest('original-session')).statusCode,409,'approval revocation is not native producer drain');
 f.db.prepare("UPDATE ga_projects SET owner_id='replacement' WHERE id='project'").run();
 assert.equal((await f.nativeRequest('original-session')).statusCode,409,'ownership transfer must retain the original namespace fence');
 f.db.prepare("UPDATE ga_projects SET owner_id='owner' WHERE id='project'").run();
 f.current.executions.releaseUnstartedWorkspace('owner','project',f.accepted.execution_id);
 assert.equal((await f.nativeRequest('original-session')).statusCode,200);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);
});

test('native namespace observation is service-only and accepts no owner, root, member or permission selector',async t=>{
 const f=await fixture(t),nativeUrl='/internal/v1/workbench/native-workspace-admission';
 assert.equal((await f.nativeRequest('original-session','')).statusCode,401);
 for(const extra of [{owner_id:'owner'},{root:'untrusted'},{members:[]},{execution_authorized:true}]){
  const result=await f.inject({method:'POST',url:nativeUrl,headers:{authorization:'Bearer '+token},payload:{session_ref:'original-session',...extra}});assert.equal(result.statusCode,422);
 }
 assert.equal((await f.inject({method:'POST',url:nativeUrl+'?root=untrusted',headers:{authorization:'Bearer '+token},payload:{session_ref:'original-session'}})).statusCode,422);
});

test('known unrelated members retain admission and the sealed family is immutable',async t=>{
 const f=await fixture(t);
 f.db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('other-project','other-owner','Synthetic other',0,1,'now','now');
 f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)').run('other-conversation','other-owner','ws','Synthetic','{}',1,'now','now','other-project');
 f.db.prepare('INSERT INTO ga_harness_session_bindings(owner_id,conversation_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('other-owner','other-conversation','other-session','now','now');
 f.current.executions.reserveWorkspace('owner','project',f.accepted.execution_id);
 assert.equal((await f.nativeRequest('other-session')).statusCode,200);
 for(const sql of ['DELETE FROM wb_workspace_reservation_families','UPDATE wb_workspace_reservation_families SET family_json=\'{}\''])assert.throws(()=>f.db.exec(sql),/workspace_coordination_immutable/);
 assert.throws(()=>f.db.exec('INSERT OR REPLACE INTO wb_workspace_reservation_families SELECT * FROM wb_workspace_reservation_families'),/workspace_coordination_immutable/);
});

test('an unresolved older reservation without sealed membership fails closed after reopening',async t=>{
 const f=await fixture(t);
 withImmediateTransaction(f.db,()=>reserveWorkspaceOperation(f.db,{owner_id:'owner',project_id:'project',operation_kind:'git_index',operation_id:f.accepted.execution_id,binding_sha256:f.current.kernel.executionBinding('owner','project')}));
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_families').get().n,0);
 await f.restart();assert.equal((await f.nativeRequest('unbound-session')).statusCode,409);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_families').get().n,0,'observation cannot invent a legacy membership seal');
});

test('original Gateway authority and real native custody remain joined through authenticated source observations',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),runtime=process.env.JOT_DSH_RUNTIME_MODULES,base=join(dirname(f.root),'native'),scoped=join(base,'node_modules','@deepseek-ai');let ctx,gate,handle,admissionGate;
 try{
  await mkdir(scoped,{recursive:true});prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),join(scoped,'dsh-agent-loop'),{nativeAdmission:true,pendingInputWake:true});
  for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.name!=='dsh-agent-loop'&&entry.isDirectory())await symlink(join(runtime,entry.name),join(scoped,entry.name),'junction');
  await symlink(join(dirname(runtime),'zod'),join(base,'node_modules','zod'),'junction');
  const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'],modules={};
  for(const name of [...names,'dsh-session-persistence'])modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
  ctx=new modules.cordis.Context();for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(base,'sessions'),compression:'none'}:{});
  let modelCalls=0;class Local extends modules['dsh-llm'].LlmAdapter{async *stream(){modelCalls++;assert.fail('custody must not invoke a model');}}
  ctx.llm.registerAdapter(['source-custody'],new Local());
  handle=await ctx.agents.create({sessionId:'original-session',meta:{agentPreset:'jot-general',cwd:base},agentOptions:{provider:'source-custody',model:'synthetic'}});
  f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)').run('original-conversation','owner','ws','Synthetic','{}',1,'now','now','project');
  f.db.prepare('INSERT INTO ga_harness_session_bindings(owner_id,conversation_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('owner','original-conversation','original-session','now','now');
  f.current.executions.reserveWorkspace('owner','project',f.accepted.execution_id);
  const original=f.current.executions.workspaceFamily('owner','project',f.accepted.execution_id),index=await readFile(join(f.root,'.git/index'));
  // Cordis may wrap each service access in a distinct proxy. Retain the same
  // original registry and Session references for both owning gate and host.
  const bridge=new WorkbenchBridge({origin:await f.listen(),token}),persistence=ctx.sessionPersistence,registry=ctx.agents,sessions=ctx.sessions;
  gate=createNativeWorkspaceFactoryGate({ctx,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,notFoundError:modules['dsh-session-persistence'].SessionPersistenceNotFoundError});
  const host=createNativeWorkspaceSourceHost({bridge,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,
   backendClass:modules['dsh-session-persistence'].SessionPersistence,allowedPresets:new Set(['jot-general']),validateLog:createNativeInvariantReplay({Session:modules['dsh-session'].Session}),projections:ctx.sessionProjections,factoryGate:gate});
  const controls={assertReservation:()=>{const current=f.current.executions.workspaceFamily('owner','project',f.accepted.execution_id);assert.equal(current.reservation_id,original.reservation_id);assert.equal(current.family_sha256,original.family_sha256);}};
  let heldContext;
  await host.withReservedFamily(f.scope,controls,async context=>{
   heldContext=context;const {source,proofs,check,recheck}=context;
   assert.equal(source.family_sha256,original.family_sha256);assert.deepEqual(proofs.map(p=>p.session_ref),['original-session']);check();await recheck();assert.equal(modelCalls,0);
   const observed=inspectNativeWorkspaceSource(context);assert.equal(observed.execution_authorized,false);
   assert.deepEqual(observed.workspaces.map(({session_ref,custody,cwd})=>({session_ref,custody,cwd})),[{session_ref:'original-session',custody:'resident',cwd:base}]);
   assert.notEqual(observed.workspaces[0].cwd,f.root,'an original family identity must not silently equate the native cwd and configured Git root');
  });
  assert.throws(()=>inspectNativeWorkspaceSource(heldContext),/native_workspace_source_context_invalid/);
  await assert.rejects(host.withReservedFamily(f.scope,controls,async()=>{
   await f.current.intents.control('owner','project',f.approved.intent_id,{request_id:'cancel-held',action:'cancel',expected_version:f.approved.version,review_sha256:f.approved.review_sha256});
  }),/git_execution_revoked/);
  await handle.agent.runMaintenance(async()=>{});
  await persistence.flush();const beforeRestart=await ctx.sessionQuery.readSession('original-session');
  await gate.dispose();gate=undefined;await handle.dispose();handle=undefined;await ctx.fiber.dispose();
  ctx=new modules.cordis.Context();for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(base,'sessions'),compression:'none'}:{});
  ctx.llm.registerAdapter(['source-custody'],new Local());
  admissionGate=createNativeWorkspaceAdmissionGate({ctx,bridge});
  const resume=()=>ctx.agents.resume({resumeSessionId:'original-session',agentOptions:{provider:'source-custody',model:'synthetic'}});
  await assert.rejects(resume(),/native_workspace_admission_unconfirmed/);
  assert.equal(ctx.agents.get('original-session'),undefined);
  assert.deepEqual((await ctx.sessionQuery.readSession('original-session')).events,beforeRestart.events,'denied resume must preserve original history');
  f.current.executions.releaseUnstartedWorkspace('owner','project',f.accepted.execution_id);
  handle=await resume();assert.equal(handle.agent.id,'original-session');assert.equal(handle.agent.jotPendingInputProtocol,1);assert.equal(typeof handle.agent.jotResumePendingInputs,'function');
  assert.equal(modelCalls,0);assert.deepEqual(await readFile(join(f.root,'.git/index')),index);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
 }finally{if(admissionGate)await admissionGate.dispose();if(gate)await gate.dispose();if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();}
});

async function nativeDispatchFixture(f,matching,{guarded=true}={}){
 const runtime=process.env.JOT_DSH_RUNTIME_MODULES,base=join(dirname(f.root),'native-dispatch'),scoped=join(base,'node_modules','@deepseek-ai');let ctx,gate,handle,admissionGate,closed=false;
 const close=async()=>{if(closed)return;closed=true;if(gate)await gate.dispose();if(handle)await handle.dispose();if(admissionGate)await admissionGate.dispose();if(ctx)await ctx.fiber.dispose();};
 try{
  await mkdir(scoped,{recursive:true});prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),join(scoped,'dsh-agent-loop'),{nativeAdmission:true,pendingInputWake:true});
  for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.name!=='dsh-agent-loop'&&entry.isDirectory())await symlink(join(runtime,entry.name),join(scoped,entry.name),'junction');
  await symlink(join(dirname(runtime),'zod'),join(base,'node_modules','zod'),'junction');
  const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'],modules={};
  for(const name of [...names,'dsh-session-persistence'])modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
  ctx=new modules.cordis.Context();for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(base,'sessions'),compression:'none'}:{});
  let modelCalls=0;class Local extends modules['dsh-llm'].LlmAdapter{async *stream(){modelCalls++;assert.fail('Git coordination must not invoke a model');}}
  ctx.llm.registerAdapter(['native-index'],new Local());const bridge=new WorkbenchBridge({origin:await f.listen(),token});if(guarded)admissionGate=createNativeWorkspaceAdmissionGate({ctx,bridge});
  handle=await ctx.agents.create({sessionId:'native-index-session',meta:{agentPreset:'jot-general',cwd:matching?f.root:base},agentOptions:{provider:'native-index',model:'synthetic'}});
  f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)').run('native-index-conversation','owner','ws','Synthetic','{}',1,'now','now','project');
  f.db.prepare('INSERT INTO ga_harness_session_bindings(owner_id,conversation_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('owner','native-index-conversation','native-index-session','now','now');
  const persistence=ctx.sessionPersistence,registry=ctx.agents,sessions=ctx.sessions;
  gate=createNativeWorkspaceFactoryGate({ctx,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,notFoundError:modules['dsh-session-persistence'].SessionPersistenceNotFoundError});
  const host=createNativeWorkspaceSourceHost({bridge,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,backendClass:modules['dsh-session-persistence'].SessionPersistence,
   allowedPresets:new Set(['jot-general']),validateLog:createNativeInvariantReplay({Session:modules['dsh-session'].Session}),projections:ctx.sessionProjections,factoryGate:gate,admissionGate});
  let entries=0;const originalHost={withReservedFamily:(scope,controls,operation)=>host.withReservedFamily(scope,controls,async context=>{entries++;assert.throws(()=>handle.agent.runMaintenance(()=>{}),/already has active work/);return operation(context);}),inspect:inspectNativeWorkspaceSource,assertAdmission:nativeWorkspaceSource.assertNativeWorkspaceSourceAdmission};
  const executions=new GitIndexExecutions(f.db,new ProjectRepository(f.db),f.current.kernel,f.current.intents,{nativeWorkspaceHost:originalHost});
  return{executions,close,nativeHost:originalHost,admissionGate,agent:handle.agent,get entries(){return entries;},get modelCalls(){return modelCalls;}};
 }catch(error){await close();throw error;}
}

test('the original reserved executor stages and unstages the configured tree under actual native custody and settles once',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),n=await nativeDispatchFixture(f,true);let result;
 try{
  n.executions.reserveWorkspace('owner','project',f.accepted.execution_id);
  await assert.rejects(f.current.executions.perform('owner','project',f.accepted.execution_id),/workspace_coordination_required/);
  result=await n.executions.performReserved('owner','project',f.accepted.execution_id);assert.equal(result.state,'applied');
  assert.equal(execFileSync('git',['show',':note.txt'],{cwd:f.root,encoding:'utf8'}),'after\n');assert.equal(n.modelCalls,0);assert.equal(n.entries,1);
  assert.equal(JSON.stringify(result).includes(f.root),false);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
  assert.deepEqual(await n.executions.performReserved('owner','project',f.accepted.execution_id),result);assert.equal(n.entries,1,'historical success must not reenter native custody or dispatch');
  const snapshot=await f.current.kernel.inspect('owner','project'),review=await f.current.intents.prepare('owner','project',{request_id:'unstage-review',action:'unstage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),approved=await f.current.intents.control('owner','project',review.intent_id,{request_id:'unstage-approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
  const unstage=withImmediateTransaction(f.db,()=>n.executions.admit('owner','project',approved.intent_id,{request_id:'unstage-execute',expected_version:approved.version,review_sha256:approved.review_sha256}));
  assert.equal((await n.executions.performReserved('owner','project',unstage.execution_id)).state,'applied');assert.equal(n.entries,2);
  assert.equal(execFileSync('git',['diff','--cached','--name-only'],{cwd:f.root,encoding:'utf8'}),'');assert.equal(await readFile(join(f.root,'note.txt'),'utf8'),'after\n');
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,2);
  for(const operation of ['DELETE FROM wb_workspace_reservation_settlements','UPDATE wb_workspace_reservation_settlements SET record_sha256=record_sha256','INSERT OR REPLACE INTO wb_workspace_reservation_settlements SELECT * FROM wb_workspace_reservation_settlements'])assert.throws(()=>f.db.exec(operation),/workspace_coordination_immutable/);
  await n.agent.runMaintenance(async()=>{});
 }finally{await n.close();}
 await f.restart();assert.deepEqual(f.current.executions.getAdmitted('owner','project',f.accepted.execution_id),result);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,2);
});

test('the reserved executor refuses a real but unrelated native directory before acquiring any effect producer',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),n=await nativeDispatchFixture(f,false),index=await readFile(join(f.root,'.git/index'));
 try{
  await assert.rejects(n.executions.performReserved('owner','project',f.accepted.execution_id),/git_native_workspace_association_required/);
  assert.deepEqual(await readFile(join(f.root,'.git/index')),index);assert.equal(n.modelCalls,0);assert.equal(n.entries,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);
  n.executions.releaseUnstartedWorkspace('owner','project',f.accepted.execution_id);
 }finally{await n.close();}
});

test('native maintenance cancellation reaches original index preparation and retains unsettled reservation evidence',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),n=await nativeDispatchFixture(f,true),kernel=f.current.kernel.indexEffects('owner','project'),prepare=kernel.prepareIndex.bind(kernel),index=await readFile(join(f.root,'.git/index')),cause={kind:'user'};let sawNativeAbort=false;
 kernel.prepareIndex=async(witness,action,signal)=>{n.agent.cancel(cause,{keepInbox:true});sawNativeAbort=signal.aborted;return prepare(witness,action,signal);};
 try{
  await assert.rejects(n.executions.performReserved('owner','project',f.accepted.execution_id),error=>error===cause);
  assert.equal(sawNativeAbort,true,'the original preparation must receive the actual native cancellation signal');
  assert.deepEqual(await readFile(join(f.root,'.git/index')),index);assert.equal(n.executions.producer('owner','project',f.accepted.execution_id).state,'cancelled_before_preparation');
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
  await assert.rejects(n.executions.performReserved('owner','project',f.accepted.execution_id),/git_execution_producer_closed/);assert.equal(n.entries,1);
 }finally{await n.close();}
});

test('approval revocation during real preparation cannot inherit native custody as another execution grant',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),n=await nativeDispatchFixture(f,true),kernel=f.current.kernel.indexEffects('owner','project'),prepare=kernel.prepareIndex.bind(kernel),index=await readFile(join(f.root,'.git/index'));
 kernel.prepareIndex=async(...args)=>{const plan=await prepare(...args);await f.current.intents.control('owner','project',f.approved.intent_id,{request_id:'revoke-during-preparation',action:'cancel',expected_version:f.approved.version,review_sha256:f.approved.review_sha256});return plan;};
 try{
  await assert.rejects(n.executions.performReserved('owner','project',f.accepted.execution_id),/git_execution_revoked/);
  assert.deepEqual(await readFile(join(f.root,'.git/index')),index);assert.deepEqual(n.executions.getAdmission('owner','project','execute'),f.accepted);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_dispatches').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
 }finally{await n.close();}
});

for(const failure of ['host_ack','settlement_write','release_write'])test('known publication retains original reservation on incomplete native settlement: '+failure,
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),n=await nativeDispatchFixture(f,true);let executions=n.executions;
 try{
  if(failure==='host_ack'){
   const original=n.nativeHost;
   executions=new GitIndexExecutions(f.db,new ProjectRepository(f.db),f.current.kernel,f.current.intents,{nativeWorkspaceHost:{inspect:original.inspect,assertAdmission:original.assertAdmission,async withReservedFamily(...args){await original.withReservedFamily(...args);throw Error('synthetic_native_ack_lost');}}});
  }else f.db.exec('CREATE TRIGGER synthetic_settlement_failure BEFORE INSERT ON '+(failure==='settlement_write'?'wb_workspace_reservation_settlements':'wb_workspace_reservation_releases')+" BEGIN SELECT RAISE(ABORT,'synthetic_settlement_write_failure'); END");
  await assert.rejects(executions.performReserved('owner','project',f.accepted.execution_id),/synthetic_native_ack_lost|synthetic_settlement_write_failure/);
  assert.equal(execFileSync('git',['show',':note.txt'],{cwd:f.root,encoding:'utf8'}),'after\n');const bytes=await readFile(join(f.root,'.git/index'));
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(executions.producer('owner','project',f.accepted.execution_id).state,'applied');
  assert.equal((await executions.performReserved('owner','project',f.accepted.execution_id)).state,'applied');assert.equal(n.entries,1);assert.deepEqual(await readFile(join(f.root,'.git/index')),bytes);
  assert.throws(()=>executions.releaseUnstartedWorkspace('owner','project',f.accepted.execution_id),/workspace_reservation_producer_unsettled/);
 }finally{await n.close();}
});

test('actual native maintenance without original startup admission cannot authorize reserved effects',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),n=await nativeDispatchFixture(f,true,{guarded:false}),index=await readFile(join(f.root,'.git/index'));
 try{
  await assert.rejects(n.executions.performReserved('owner','project',f.accepted.execution_id),/native_workspace_admission_unavailable/);
  assert.deepEqual(await readFile(join(f.root,'.git/index')),index);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);
  n.executions.releaseUnstartedWorkspace('owner','project',f.accepted.execution_id);
 }finally{await n.close();}
});

test('disposing original startup admission during preparation revokes the held effect authority',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),n=await nativeDispatchFixture(f,true),kernel=f.current.kernel.indexEffects('owner','project'),prepare=kernel.prepareIndex.bind(kernel),index=await readFile(join(f.root,'.git/index'));
 kernel.prepareIndex=async(...args)=>{const plan=await prepare(...args);await n.admissionGate.dispose();return plan;};
 try{
  await assert.rejects(n.executions.performReserved('owner','project',f.accepted.execution_id),/native_workspace_admission_unavailable/);
  assert.deepEqual(await readFile(join(f.root,'.git/index')),index);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_dispatches').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);
 }finally{await n.close();}
});

test('an async startup-admission callback cannot replace the original synchronous physical check',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),n=await nativeDispatchFixture(f,true),index=await readFile(join(f.root,'.git/index'));
 const executions=new GitIndexExecutions(f.db,new ProjectRepository(f.db),f.current.kernel,f.current.intents,{nativeWorkspaceHost:{...n.nativeHost,assertAdmission:()=>Promise.resolve()}});
 try{
  await assert.rejects(executions.performReserved('owner','project',f.accepted.execution_id),/git_native_workspace_host_unavailable/);
  assert.deepEqual(await readFile(join(f.root,'.git/index')),index);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);
  executions.releaseUnstartedWorkspace('owner','project',f.accepted.execution_id);
 }finally{await n.close();}
});

test('native custody cannot publish or clean up through a replaced original Worker lease',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:45000},async t=>{
 const f=await fixture(t),n=await nativeDispatchFixture(f,true),kernel=f.current.kernel.indexEffects('owner','project'),prepare=kernel.prepareIndex.bind(kernel),index=await readFile(join(f.root,'.git/index'));
 kernel.prepareIndex=async(...args)=>{const plan=await prepare(...args);f.db.prepare("UPDATE ga_worker_leases SET owner='replacement-worker',generation=generation+1 WHERE resource_id LIKE 'git-index-binding:%'").run();return plan;};
 try{
  await assert.rejects(n.executions.performReserved('owner','project',f.accepted.execution_id),/workbench_execution_lease_revoked/);
  assert.deepEqual(await readFile(join(f.root,'.git/index')),index);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_dispatches').get().n,0);
  assert.equal(f.db.prepare('SELECT owner FROM ga_worker_leases').get().owner,'replacement-worker');assert.equal(n.executions.producer('owner','project',f.accepted.execution_id).state,'interrupted');
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);
  await assert.rejects(n.executions.performReserved('owner','project',f.accepted.execution_id),/git_execution_producer_unsettled/);assert.equal(n.entries,1);
 }finally{await n.close();}
});
