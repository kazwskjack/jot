import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,relative,isAbsolute} from 'node:path';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';import {fork,execFileSync} from 'node:child_process';
import {buildServer} from '../../src/server.ts';import {GitWorkbench} from '../../src/git/service.ts';import {GitMutationIntents} from '../../src/git/intents.ts';import {GitIndexExecutions} from '../../src/git/index-executions.ts';import {withImmediateTransaction} from '../../src/db/database.ts';
import {callNativeGitTransport} from '../../../session-adapter/native-git-transport.js';

test('separate original native Host executes reviewed Git and sees parent revocation in the same physical DB',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:60000},async()=>{
 const privateRoot=await mkdtemp(join(tmpdir(),'jot-native-git-')),root=join(privateRoot,'repo'),database=join(privateRoot,'product.sqlite');
 const bs=String.fromCharCode(92),socket=process.platform==='win32'?[bs,bs,'.',bs,'pipe',bs,'jot-git-test-',randomUUID()].join(''):join(privateRoot,'native.sock');
 const channelToken='test-original-git-service-token',transportToken='test-original-git-transport-token-0001';let service,peer;
 const pending=[],messages=[];let childFailure;
 const take=type=>{if(childFailure)return Promise.reject(childFailure);const at=messages.findIndex(m=>m.type===type);if(at>=0)return Promise.resolve(messages.splice(at,1)[0]);return new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('native_git_peer_timeout:'+type)),20000);pending.push({type,done:v=>{clearTimeout(timer);done(v);},reject:e=>{clearTimeout(timer);reject(e);}});});};
 try{
  await mkdir(root);const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'before\n');git('add','.');git('commit','-m','Synthetic original native Git fixture');await writeFile(join(root,'note.txt'),'after\n');
  service=await buildServer({databasePath:database,templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],internalChannelToken:channelToken,gitRepositories:[{owner_id:'owner',project_id:'project',root}]});
  service.db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('project','owner','Synthetic project',0,1,'now','now');
  service.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at,project_id) VALUES(?,?,?,?,?,?,?,?,?)').run('conversation','owner','ws','Synthetic','{}',1,'now','now','project');
  service.db.prepare('INSERT INTO ga_harness_session_bindings(owner_id,conversation_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run('owner','conversation','ipc-native-session','now','now');
  const origin=await service.app.listen({host:'127.0.0.1',port:0}),kernel=new GitWorkbench(service.projects,[{owner_id:'owner',project_id:'project',root}]),intents=new GitMutationIntents(service.db,service.projects,kernel),executions=new GitIndexExecutions(service.db,service.projects,kernel,intents);
  const prepare=async(action,id)=>{const snapshot=await kernel.inspect('owner','project'),review=await intents.prepare('owner','project',{request_id:id+'-review',action,paths:['note.txt'],snapshot_id:snapshot.snapshot_id}),approved=await intents.control('owner','project',review.intent_id,{request_id:id+'-approve',action:'approve',expected_version:1,review_sha256:review.review_sha256}),accepted=withImmediateTransaction(service.db,()=>executions.admit('owner','project',approved.intent_id,{request_id:id+'-execute',expected_version:approved.version,review_sha256:approved.review_sha256}));return{approved,scope:{owner_id:'owner',project_id:'project',execution_id:accepted.execution_id}};};
  const first=await prepare('stage','first');
  peer=fork(fileURLToPath(new URL('./fixtures/native-git-peer.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});let diagnostic='';peer.stderr.on('data',c=>{diagnostic=(diagnostic+c).slice(-4096);});
  peer.on('message',value=>{if(value.type==='failed'){childFailure=Error(value.code+':'+value.diagnostic);for(const item of pending.splice(0))item.reject(childFailure);return;}const at=pending.findIndex(item=>item.type===value.type);if(at>=0)pending.splice(at,1)[0].done(value);else messages.push(value);});
  peer.on('exit',code=>{if(code){childFailure=Error('native_git_peer_exit:'+code+':'+diagnostic);for(const item of pending.splice(0))item.reject(childFailure);}});
  peer.send({type:'start',config:{root,database,privateRoot,socket,origin,channelToken,transportToken,runtime:resolve(process.env.JOT_DSH_RUNTIME_MODULES)}});
  assert.equal((await take('ready')).modelCalls,0);
  const schemaBefore=service.db.prepare('PRAGMA schema_version').get().schema_version;
  assert.equal(service.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wb_work_publication_journal'").get(),undefined);
  await assert.rejects(callNativeGitTransport({socket,token:transportToken},{...first.scope,operation_kind:'work_publication'}),/native_git_transport_rejected/);
  assert.equal(service.db.prepare('PRAGMA schema_version').get().schema_version,schemaBefore,'publication requests cannot install or upgrade an index-only deployment');
  assert.equal(service.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wb_work_publication_journal'").get(),undefined);
  const applied=await callNativeGitTransport({socket,token:transportToken},first.scope);assert.equal(applied.state,'applied');assert.equal(git('show',':note.txt'),'after\n');assert.equal(service.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,1);
  const second=await prepare('unstage','second'),index=await readFile(join(root,'.git/index'));peer.send({type:'pause-next'});await take('pause-armed');const operation=callNativeGitTransport({socket,token:transportToken},second.scope);operation.catch(()=>{});await take('prepared');
  await intents.control('owner','project',second.approved.intent_id,{request_id:'cancel-second',action:'cancel',expected_version:second.approved.version,review_sha256:second.approved.review_sha256});peer.send({type:'continue'});
  await assert.rejects(operation,/native_git_transport_rejected/);assert.deepEqual(await readFile(join(root,'.git/index')),index);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
 }finally{
  for(const item of pending.splice(0))item.reject(Error('fixture_closed'));
  if(peer&&peer.exitCode===null){peer.send({type:'stop'});await Promise.race([new Promise(r=>peer.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(peer.exitCode===null){peer.kill();await new Promise(r=>peer.once('exit',r));}}
  if(service){await service.app.close();service.db.close();}const rel=relative(resolve(tmpdir()),resolve(privateRoot));assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(privateRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
