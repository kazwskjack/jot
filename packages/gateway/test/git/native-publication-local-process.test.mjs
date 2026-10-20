import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {publicationNativeHostFixture} from '../support/publication-native-host-fixture.mjs';
import {buildServer} from '../../src/server.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {callNativeGitTransport} from '../../../session-adapter/native-git-transport.js';

function peer(){
 const child=fork(fileURLToPath(new URL('./fixtures/native-publication-peer.mjs',import.meta.url)),[],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']}),messages=[],waiters=[];let failure,diagnostic='';
 child.stderr.on('data',bytes=>{diagnostic=(diagnostic+bytes).slice(-4096)});
 const reject=error=>{failure=error;for(const item of waiters.splice(0)){clearTimeout(item.timer);item.reject(error)}};
 child.on('message',message=>{if(message.type==='failed'){reject(Error('synthetic_native_peer_failed:'+message.diagnostic));return;}const i=waiters.findIndex(w=>w.type===message.type);if(i<0)messages.push(message);else{const waiter=waiters.splice(i,1)[0];clearTimeout(waiter.timer);waiter.done(message)}});
 const exited=new Promise(done=>child.once('exit',code=>{if(code!==0&&code!==73)reject(Error('synthetic_native_peer_exit:'+code+':'+diagnostic));done(code)}));
 const take=type=>{if(failure)return Promise.reject(failure);const i=messages.findIndex(m=>m.type===type);if(i>=0)return Promise.resolve(messages.splice(i,1)[0]);return new Promise((done,reject)=>{const waiter={type,done,reject};waiter.timer=setTimeout(()=>reject(Error('synthetic_native_peer_timeout:'+type)),30000);waiters.push(waiter)})};
 return{child,take,exited,send:(type,value={})=>child.send({type,...value}),async close(){
  if(child.exitCode===null){if(child.connected)child.send({type:'stop'});let timer;await Promise.race([exited,new Promise(done=>{timer=setTimeout(done,5000)})]);clearTimeout(timer);if(child.exitCode===null){child.kill();await exited}}
  for(const waiter of waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(Error('synthetic_peer_closed'))}
 }};
}

test('separate original native Host publishes original completed source, observes revocation and recovers a recorded effect after process loss',
 {skip:!process.env.JOT_DSH_RUNTIME_MODULES,timeout:180000},async t=>{
 const peers=[];let app,gateway;try{
  const f=await publicationNativeHostFixture(t);await f.close();assert.equal(f.calls,0);
  const token='test-original-publication-source-token',transportToken='test-original-publication-wire-token-0001';
  gateway=await buildServer({databasePath:join(f.root,'db.sqlite'),templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],internalChannelToken:token,gitRepositories:[{owner_id:'owner',project_id:f.scope.project_id,root:f.rootTarget}]});app=gateway.app;
  const origin=await app.listen({host:'127.0.0.1',port:0}),database=join(f.root,'db.sqlite'),bs=String.fromCharCode(92),socket=process.platform==='win32'?[bs,bs,'.',bs,'pipe',bs,'jot-git-publication-',randomUUID()].join(''):join(f.root,'publication.sock');
  const config={privateRoot:f.root,persistenceRoot:join(f.root,'original-native-host','sessions'),runtime:resolve(process.env.JOT_DSH_RUNTIME_MODULES),origin,channelToken:token,transportToken,database,project:f.scope.project_id,root:f.rootTarget,socket};
  const open=async()=>{const p=peer();peers.push(p);p.send('initialize',{config});assert.equal((await p.take('initialized')).modelCalls,0);p.send('mount',{config});assert.equal((await p.take('mounted')).modelCalls,0);return p};
  const schema=f.db.prepare('PRAGMA schema_version').get().schema_version;let p=await open();assert.equal(f.db.prepare('PRAGMA schema_version').get().schema_version,schema);
  const request={owner_id:'owner',project_id:f.scope.project_id,execution_id:f.accepted.execution_id,operation_kind:'work_publication'},wire={socket,token:transportToken};
  await assert.rejects(callNativeGitTransport(wire,{owner_id:'owner',project_id:f.scope.project_id,execution_id:f.accepted.execution_id}),/native_git_transport_rejected/);
  await assert.rejects(callNativeGitTransport(wire,{...request,owner_id:'foreign'}),/native_git_transport_rejected/);
  assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,0);
  assert.equal((await callNativeGitTransport(wire,request)).state,'applied');assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');
  const prepare=async id=>{const review=await f.service.prepare('owner',f.scope.project_id,{...f.input,request_id:id+'-review'}),approved=await f.service.control('owner',f.scope.project_id,review.intent_id,{request_id:id+'-approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
   const accepted=withImmediateTransaction(f.db,()=>f.plain.admit('owner',f.scope.project_id,review.intent_id,{request_id:id+'-execute',expected_version:approved.version,review_sha256:approved.review_sha256}));return{review,approved,request:{...request,execution_id:accepted.execution_id}}};
  // A deliberate synthetic local edit creates another explicit target review;
  // accepting the original task or replaying its admission cannot do this.
  await writeFile(join(f.rootTarget,'source.md'),f.base);const second=await prepare('second');p.send('pause-next');await p.take('pause-armed');
  const pending=callNativeGitTransport(wire,second.request);pending.catch(()=>{});await p.take('prepared');
  await f.service.control('owner',f.scope.project_id,second.approved.intent_id,{request_id:'revoke-second',action:'cancel',expected_version:second.approved.version,review_sha256:second.approved.review_sha256});p.send('continue');await assert.rejects(pending,/native_git_transport_rejected/);
  assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),f.base);const stopped=f.plain.publicationStatus('owner',f.scope.project_id,second.request.execution_id);
  assert.equal((await callNativeGitTransport(wire,{...second.request,command:{request_id:'ack-second',action:'abandon_unknown',expected_journal_sha256:stopped.journal_sha256,acknowledge_unknown:true}})).state,'abandoned_unknown');
  const third=await prepare('third');p.send('exit-after-apply');await p.take('exit-armed');const lost=callNativeGitTransport(wire,third.request);lost.catch(()=>{});assert.equal(await p.exited,73);await assert.rejects(lost,/native_git_transport_rejected/);
  const before=await lstat(join(f.rootTarget,'source.md'),{bigint:true}),recorded=f.plain.publicationStatus('owner',f.scope.project_id,third.request.execution_id);assert.equal(recorded.state,'applied_pending_settlement');
  // The dead synthetic process is confirmed above. Simulate expiry of only its
  // exact original lease; the shipped owner command still performs the fence.
  const resource='git-index-binding:'+f.workbench.executionBinding('owner',f.scope.project_id),lease=f.db.prepare('SELECT owner,generation FROM ga_worker_leases WHERE resource_id=?').get(resource);assert.ok(lease);
  assert.equal(f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=? AND owner=? AND generation=?').run(String(Date.now()-1),resource,lease.owner,lease.generation).changes,1);
  p=await open();const command={request_id:'confirm-third',action:'confirm_recorded',expected_journal_sha256:recorded.journal_sha256,acknowledge_unknown:true};
  const settled=await callNativeGitTransport(wire,{...third.request,command});assert.equal(settled.state,'applied');const count=f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n;
  assert.deepEqual(await callNativeGitTransport(wire,{...third.request,command}),settled);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,count);
  const after=await lstat(join(f.rootTarget,'source.md'),{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),'Exact reviewed work content');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);p.send('status');assert.equal((await p.take('status')).modelCalls,0);
 }finally{for(const p of peers.reverse())await p.close();await app?.close();gateway?.db.close()}
});
