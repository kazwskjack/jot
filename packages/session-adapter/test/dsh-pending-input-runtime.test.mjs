// Installed SDK with a Jot compatibility delta, synthetic local model only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,symlink,rm,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {prepareDshPreSetupRuntime} from '../scripts/prepare-dsh-pre-setup.mjs';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
async function prepareFixture(root){
 const scoped=join(root,'node_modules','@deepseek-ai');await mkdir(scoped,{recursive:true});
 const prepared=prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),join(scoped,'dsh-agent-loop'),{pendingInputWake:true});assert.equal(prepared.pendingInputProtocol,1);assert.equal(prepared.pendingWakeRevocationProtocol,1);assert.equal(prepared.pendingInputBindingsProtocol,1);
 for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.name!=='dsh-agent-loop'&&entry.isDirectory())await symlink(join(runtime,entry.name),join(scoped,entry.name),'junction');
 await symlink(join(dirname(runtime),'zod'),join(root,'node_modules','zod'),'junction');
}

test('installed multi-RPC wake consumes only the exact ordered inputs and retains local token custody',{skip:!runtime,timeout:30000},async()=>{
 const base=fileURLToPath(new URL('../../../.test-tmp/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'pending-multi-')),scoped=join(root,'node_modules','@deepseek-ai');let ctx,handle;
 try{
  await prepareFixture(root);
  const manifest=JSON.parse(await readFile(join(scoped,'dsh-agent-loop/package.json'),'utf8'));assert.equal(manifest.jotCompatibilityPatch.pendingInputBindingsProtocol,1);
  const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop'],modules={};
  for(const name of names)modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
  ctx=new modules.cordis.Context();for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
  let calls=0;class LocalAdapter extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;yield{type:'text-delta',index:0,text:'Ordered inputs consumed.'};yield{type:'usage',usage:{inputTokens:5,outputTokens:1,totalTokens:6}};yield{type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['local-multi'],new LocalAdapter());handle=await ctx.agents.create({sessionId:'multi-pending',agentOptions:{provider:'local-multi',model:'scripted'}});const agent=handle.agent;
  const messages=['cmd-a','cmd-b'].map((rpcId,index)=>({id:'input-'+index,role:'user',source:{kind:'user',rpcId},content:[{type:'text',text:'Original synthetic '+index}]}));
  for(const message of messages)agent.send(message,'next-step',false);
  assert.equal(agent.jotPendingInputBindingsProtocol,1);let oldToken;
  const request=()=>({requestId:'parent-run',messageIds:messages.map(m=>m.id),seq:agent.session.seq,inputSources:messages.map(m=>({messageId:m.id,requestId:m.source.rpcId}))});
  await agent.runMaintenance(async()=>{const seq=agent.session.seq;assert.throws(()=>agent.jotResumePending({...request(),inputSources:undefined}));assert.throws(()=>agent.jotResumePendingInputs({...request(),inputSources:request().inputSources.toReversed()}));assert.equal(calls,0);const wake=agent.jotResumePendingInputs(request());oldToken=wake.wakeToken;assert.equal(agent.jotRevokePendingWake(Symbol('forged')),false);assert.equal(agent.jotRevokePendingWake(oldToken),true);assert.equal(agent.session.seq,seq);assert.deepEqual(agent.inbox.nextStep,messages);});
  await agent.whenIdle();assert.equal(calls,0);
  await agent.runMaintenance(async()=>{const seq=agent.session.seq,wake=agent.jotResumePendingInputs(request());assert.equal(agent.jotRevokePendingWake(oldToken),false);assert.equal(typeof wake.wakeToken,'symbol');assert.equal(agent.session.seq,seq);assert.deepEqual(agent.inbox.nextStep,messages);});
  await agent.whenIdle();await ctx.sessionPersistence.flush(agent.session);
  const events=(await ctx.sessionQuery.readSession(agent.id)).events,users=events.filter(e=>e.type==='user/message');assert.deepEqual(users.map(e=>e.data),messages);assert.equal(calls,1);assert.equal(agent.inbox.hasPending,false);
 }finally{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();await cleanupFixture(base,root);}
});
async function cleanupFixture(base,root){
 const canonicalBase=await realpath(base),canonicalRoot=await realpath(root),rel=relative(canonicalBase,canonicalRoot);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(canonicalRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20});
}
async function storedTree(root){
 const files=[];async function visit(path,prefix=''){for(const entry of await readdir(path,{withFileTypes:true})){const name=join(prefix,entry.name),full=join(path,entry.name);if(entry.isDirectory())await visit(full,name);else if(entry.isFile())files.push({name,sha256:createHash('sha256').update(await readFile(full)).digest('hex')});else assert.fail('unexpected native store link');}}await visit(root);return files.sort((a,b)=>a.name.localeCompare(b.name));
}

test('installed native driver consumes the existing message once and honours cancellation behind maintenance',{skip:!runtime,timeout:30000},async()=>{
 const base=fileURLToPath(new URL('../../../.test-tmp/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'pending-native-')),scoped=join(root,'node_modules','@deepseek-ai');let ctx,handles=[];
 try{
  await prepareFixture(root);
  const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop'],modules={};
  for(const name of names)modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
  ctx=new modules.cordis.Context();for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
  let calls=0;class LocalAdapter extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;yield{type:'text-delta',index:0,text:'Existing input consumed.'};yield{type:'usage',usage:{inputTokens:5,outputTokens:1,totalTokens:6}};yield{type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['local-pending'],new LocalAdapter());
  for(const cancelled of [false,true,'observer']){
   const handle=await ctx.agents.create({sessionId:cancelled==='observer'?'observer-pending':cancelled?'cancelled-pending':'original-pending',agentOptions:{provider:'local-pending',model:'scripted'}});handles.push(handle);const agent=handle.agent;
   const original={id:cancelled?'cancelled-input':'original-input',role:'user',source:{kind:'user',rpcId:'original-run'},content:[{type:'text',text:'Use this original input exactly once.'}]};agent.send(original,'next-turn',false);await ctx.sessionPersistence.flush(agent.session);assert.equal(calls,cancelled?1:0);let previousWakeToken;
   await agent.runMaintenance(async signal=>{
    const seq=agent.session.seq;assert.equal(agent.jotPendingInputProtocol,1);const wake=agent.jotResumePending({requestId:'original-run',messageIds:[original.id],seq});previousWakeToken=wake.wakeToken;assert.equal(typeof wake.wakeToken,'symbol');assert.ok(!JSON.stringify(wake).includes('wakeToken'));assert.deepEqual(wake,{accepted:true,messageIds:[original.id],seq});
    assert.equal(agent.session.seq,seq,'latching cannot append an inbox event or new user message');assert.deepEqual(agent.inbox.nextTurn,[original]);assert.equal(calls,cancelled?1:0);
    if(cancelled){if(cancelled==='observer'){assert.equal(agent.jotPendingWakeRevocationProtocol,1);assert.equal(agent.jotRevokePendingWake(Symbol('forged')),false);assert.equal(agent.jotRevokePendingWake({requestId:'original-run',messageIds:[original.id],seq}),false);assert.equal(agent.jotRevokePendingWake(wake.wakeToken),true);assert.equal(agent.jotRevokePendingWake(wake.wakeToken),false);}agent.cancel({kind:cancelled==='observer'?'parent':'user'},cancelled==='observer'?{keepInbox:true}:undefined);assert.equal(signal.aborted,true);}
   });
   await agent.whenIdle();await ctx.sessionPersistence.flush(agent.session);const events=(await ctx.sessionQuery.readSession(agent.id)).events;
   assert.equal(events.filter(event=>event.type==='user/message'&&event.data.id===original.id).length,cancelled?0:1);assert.equal(events.filter(event=>event.type==='user/message').length,cancelled?0:1);
   assert.equal(calls,1);assert.equal(agent.inbox.hasPending,cancelled==='observer');if(cancelled==='observer')await agent.runMaintenance(async()=>{const request={requestId:'original-run',messageIds:[original.id],seq:agent.session.seq};const wake=agent.jotResumePending(request);assert.equal(agent.jotRevokePendingWake(previousWakeToken),false,'an earlier maintenance attempt must not revoke a later identical request');assert.equal(agent.jotRevokePendingWake(wake.wakeToken),true);});
  }
  const other=await ctx.agents.create({sessionId:'competing-pending',agentOptions:{provider:'local-pending',model:'scripted'}});handles.push(other);const agent=other.agent,one={id:'first-owned',role:'user',source:{kind:'user',rpcId:'first-run'},content:[{type:'text',text:'First authorized synthetic input'}]},two={id:'second-owned',role:'user',source:{kind:'user',rpcId:'second-run'},content:[{type:'text',text:'Second independent synthetic input'}]};
  agent.send(one,'next-turn',false);await agent.runMaintenance(async()=>{const request={requestId:'first-run',messageIds:[one.id],seq:agent.session.seq};const wake=agent.jotResumePending(request);agent.followup(two);assert.equal(agent.jotRevokePendingWake(wake.wakeToken),false,'an old observer cannot revoke a subsequent independent native wake');});
  await agent.whenIdle();assert.equal(calls,3);const users=(await ctx.sessionQuery.readSession(agent.id)).events.filter(e=>e.type==='user/message');assert.deepEqual(users.map(e=>e.data.id),[one.id,two.id]);assert.equal(agent.jotRevokePendingWake({requestId:'first-run',messageIds:[one.id],seq:0}),false);

 }finally{
  for(const handle of handles)await handle.dispose();if(ctx)await ctx.fiber.dispose();
  await cleanupFixture(base,root);
 }
});


for(const outcome of ['execute','cancel'])test('cold original pending input survives owned process death without a new prompt: '+outcome,{skip:!runtime,timeout:60000},async()=>{
 const base=fileURLToPath(new URL('../../../.test-tmp/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'pending-process-')),records=[];
 const worker=fileURLToPath(new URL('../verification/pending-input-process-worker.mjs',import.meta.url));
 const env={...Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'].filter(key=>process.env[key]).map(key=>[key,process.env[key]])),JOT_DSH_RUNTIME_MODULES:runtime};
 function launch(stage){
  const child=spawn(process.execPath,[worker,root,stage,outcome],{cwd:root,env,stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});const record={child,terminal:false,stderr:''};records.push(record);
  record.ended=new Promise(resolve=>{child.once('exit',(code,signal)=>{record.terminal=true;resolve({code,signal});});child.once('error',error=>{record.terminal=true;resolve({error});});});
  child.stderr.on('data',chunk=>{record.stderr=(record.stderr+chunk).slice(-3000);});
  record.ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('pending_process_receipt_timeout')),30000);child.once('message',message=>{clearTimeout(timer);resolve(message);});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',()=>{clearTimeout(timer);reject(Error('pending_process_exited_before_receipt: '+record.stderr));});});
  return record;
 }
 try{
  await prepareFixture(root);const seeded=launch('seed'),receipt=await seeded.ready;assert.equal(receipt.kind,'seeded');assert.equal(receipt.calls,0);
  assert.equal(seeded.terminal,false);assert.equal(seeded.child.kill('SIGKILL'),true);const death=await seeded.ended;assert.equal(seeded.terminal,true);assert.ok(death.signal==='SIGKILL'||death.code!==0);
  const recovered=launch('recover'),result=await recovered.ready;assert.equal((await recovered.ended).code,0,recovered.stderr);assert.equal(result.kind,'recovered');assert.equal(result.inputId,receipt.inputId);assert.equal(result.sourceRpcId,receipt.sourceRpcId);assert.equal(result.calls,outcome==='execute'?1:0);assert.equal(result.users,result.calls);
  const beforeColdRead=await storedTree(join(root,'sessions')),inspected=launch('inspect'),cold=await inspected.ready;assert.equal((await inspected.ended).code,0,inspected.stderr);assert.deepEqual(cold,{kind:'inspected',calls:0,users:result.users,pending:0,attached:false});assert.deepEqual(await storedTree(join(root,'sessions')),beforeColdRead,'cold validation must not rewrite the native store');
 }finally{
  for(const record of records){if(!record.terminal)record.child.kill('SIGKILL');await record.ended;}
  await cleanupFixture(base,root);
 }
});
