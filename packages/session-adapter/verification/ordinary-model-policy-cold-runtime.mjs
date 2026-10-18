// A real Host process is force-terminated after a flushed, unentered input.
// Recovery uses the original observer/wake protocol, not another prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readdir,symlink,writeFile,rm} from 'node:fs/promises';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {buildServer} from '../../gateway/src/server.ts';
import {SessionBindingRepository} from '../../gateway/src/harness/session-bindings.ts';
import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';
import {EventStore} from '../../gateway/src/events/event-store.ts';
import {SessionControllerClient} from '../../gateway/src/harness/session-controller-client.ts';
import {prepareDshPreSetupRuntime} from '../scripts/prepare-dsh-pre-setup.mjs';

test('actual Host exit and replacement lease recover the same frozen model without another prompt',{
 timeout:45000,skip:!process.env.JOT_DSH_RUNTIME_MODULES,
},async()=>{
 const runtime=resolve(process.env.JOT_DSH_RUNTIME_MODULES),base=resolve('.test-tmp/model-policy-cold');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'case-'));
 const internalToken=randomBytes(32).toString('hex'),adapterToken=randomBytes(32).toString('hex');
 let service,host,follower,stream;
 const stop=async(signal='SIGTERM')=>{if(host&&!host.terminal){assert.equal(host.child.kill(signal),true);await host.ended;}};
 try{
  service=await buildServer({databasePath:join(root,'product.db'),workspaces:['ws'],internalChannelToken:internalToken,workbenchRoot:join(root,'workspaces'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url))});
  const owner='cold-model-owner',conversation=service.conversations.create(owner,{workspace_id:'ws',title:'Cold model fixture',model:{provider:'local-scripted',model:'chosen',reasoning_effort:'high'}});
  const session=new SessionBindingRepository(service.db).getOrCreate(owner,conversation.conversation_id);
  const source=service.runs.enqueue(conversation.conversation_id,owner,{client_message_id:'original-model-input',content:[{type:'text',text:'Synthetic original model input.'}]});
  const coordinator=new HarnessCoordinator(service.db,service.runs,new EventStore(service.db));
  const originalLease=coordinator.claimNext('original-model-worker',60000);coordinator.start(originalLease);
  const gateway=await service.app.listen({host:'127.0.0.1',port:0});
  const scoped=join(root,'compat/node_modules/@deepseek-ai');await mkdir(scoped,{recursive:true});
  const patched=join(scoped,'dsh-agent-loop');prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),patched,{pendingInputWake:true});
  for(const row of await readdir(runtime,{withFileTypes:true}))if(row.name!=='dsh-agent-loop'&&row.isDirectory())await symlink(join(runtime,row.name),join(scoped,row.name),'junction');
  await symlink(join(dirname(runtime),'zod'),join(root,'compat/node_modules/zod'),'junction');
  const start=async(create,available)=>{
   const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
   const config=join(root,create?'first-host.json':'replacement-host.json');await writeFile(config,JSON.stringify({runtime,root,patched,gateway,port,sessionId:session.session_id,runId:source.run_id,internalToken,adapterToken,create,available}),{mode:0o600});
   const child=spawn(process.execPath,[fileURLToPath(new URL('./ordinary-model-policy-worker.mjs',import.meta.url)),config],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])),DSH_TELEMETRY_DISABLED:'1'}});
   const state={child,terminal:false,messages:[],output:'',url:`http://127.0.0.1:${port}`};host=state;
   child.on('message',message=>state.messages.push(message));for(const output of [child.stdout,child.stderr])output.on('data',bytes=>state.output=(state.output+bytes).slice(-12000));
   state.ended=new Promise(resolve=>child.once('exit',(code,signal)=>{state.terminal=true;state.exit={code,signal};resolve();}));
   state.wait=predicate=>new Promise((resolve,reject)=>{
    const existing=state.messages.find(predicate);if(existing){resolve(existing);return;}
    const cleanup=()=>{clearTimeout(timer);child.removeListener('message',message);child.removeListener('exit',exit);};
    const message=value=>{if(predicate(value)){cleanup();resolve(value);}},exit=()=>{cleanup();reject(Error('fixture_host_exited: '+state.output));};
    const timer=setTimeout(()=>{cleanup();reject(Error('fixture_host_timeout: '+state.output));},12000);
    child.on('message',message);child.once('exit',exit);if(state.terminal)exit();
   });
   const ready=await state.wait(message=>message.type==='ready');assert.equal(ready.resident,create);return state;
  };
  const first=await start(true,false),input={run_id:source.run_id,execution_lease:{owner:originalLease.owner,generation:originalLease.generation}};
  const response=await fetch(first.url+`/v1/sessions/${session.session_id}/prompts`,{method:'POST',headers:{authorization:`Bearer ${adapterToken}`,'content-type':'application/json'},body:JSON.stringify({request_id:source.run_id,text:'Synthetic original model input.',ordinary_input:input})});
  assert.equal(response.status,202,JSON.stringify(await response.json()));
  const pending=await first.wait(message=>message.type==='idle'&&message.pending.some(item=>item.rpc===source.run_id));assert.equal(pending.requests,0);assert.equal(pending.pending.length,1);
  const originalId=pending.pending[0].id;await stop('SIGKILL');assert.notEqual(first.exit.code,0);
  service.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),source.run_id);
  const replacement=coordinator.claimNext('replacement-model-worker',60000);assert.equal(replacement.run_id,source.run_id);assert.equal(replacement.generation,2);coordinator.start(replacement);
  // Change mutable conversation defaults after the accepted snapshot and Host exit.
  service.db.prepare('UPDATE ga_conversations SET model=? WHERE id=?').run(JSON.stringify({provider:'local-scripted',model:'later',reasoning_effort:'low'}),conversation.conversation_id);
  service.db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('later-cold-native-fixture',conversation.conversation_id);
  const next=await start(false,true),client=new SessionControllerClient(next.url,adapterToken),scope={run_id:source.run_id,execution_lease:{owner:replacement.owner,generation:replacement.generation}};
  follower=new AbortController();stream=client.follow(session.session_id,follower.signal,undefined,scope)[Symbol.asyncIterator]();assert.equal((await stream.next()).value.type,'snapshot');
  let receipt;try{receipt=await client.recoverInput(session.session_id,scope,follower.signal);}catch(error){throw Error('fixture recovery diagnostics '+JSON.stringify(next.messages)+' '+next.output,{cause:error});}assert.equal(receipt.accepted,true);assert.deepEqual(receipt.native_message_ids,[originalId]);
  const request=await next.wait(message=>message.type==='request');assert.deepEqual(request,{type:'request',provider:'local-scripted',model:'chosen',effort:'high'});
  const idle=await next.wait(message=>message.type==='idle'&&message.requests===1);assert.deepEqual(idle.entered,[originalId]);assert.deepEqual(idle.pending,[]);
  assert.equal(next.messages.filter(message=>message.type==='request').length,1);assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 }finally{
  follower?.abort();await stream?.return?.().catch(()=>{});await stop();
  if(service){await service.app.close();service.db.close();}
  const child=relative(base,root);assert.ok(child&&!isAbsolute(child)&&!child.startsWith('..'));await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
