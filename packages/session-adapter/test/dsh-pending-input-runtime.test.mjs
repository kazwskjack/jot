// Installed SDK with a Jot compatibility delta, synthetic local model only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,symlink,rm,realpath} from 'node:fs/promises';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareDshPreSetupRuntime} from '../scripts/prepare-dsh-pre-setup.mjs';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
test('installed native driver consumes the existing message once and honours cancellation behind maintenance',{skip:!runtime,timeout:30000},async()=>{
 const base=fileURLToPath(new URL('../../../.test-tmp/',import.meta.url));await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'pending-native-')),scoped=join(root,'node_modules','@deepseek-ai');let ctx,handles=[];
 try{
  await mkdir(scoped,{recursive:true});const output=join(scoped,'dsh-agent-loop');const prepared=prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),output,{pendingInputWake:true});assert.equal(prepared.pendingInputProtocol,1);
  for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.name!=='dsh-agent-loop'&&entry.isDirectory())await symlink(join(runtime,entry.name),join(scoped,entry.name),'junction');
  const upstreamModules=dirname(runtime);for(const name of ['zod'])await symlink(join(upstreamModules,name),join(root,'node_modules',name),'junction');
  const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop'],modules={};
  for(const name of names)modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
  ctx=new modules.cordis.Context();for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
  let calls=0;class LocalAdapter extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;yield{type:'text-delta',index:0,text:'Existing input consumed.'};yield{type:'usage',usage:{inputTokens:5,outputTokens:1,totalTokens:6}};yield{type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['local-pending'],new LocalAdapter());
  for(const cancelled of [false,true]){
   const handle=await ctx.agents.create({sessionId:cancelled?'cancelled-pending':'original-pending',agentOptions:{provider:'local-pending',model:'scripted'}});handles.push(handle);const agent=handle.agent;
   const original={id:cancelled?'cancelled-input':'original-input',role:'user',source:{kind:'user',rpcId:'original-run'},content:[{type:'text',text:'Use this original input exactly once.'}]};agent.send(original,'next-turn',false);await ctx.sessionPersistence.flush(agent.session);assert.equal(calls,cancelled?1:0);
   await agent.runMaintenance(async signal=>{
    const seq=agent.session.seq;assert.equal(agent.jotPendingInputProtocol,1);assert.deepEqual(agent.jotResumePending({requestId:'original-run',messageIds:[original.id],seq}),{accepted:true,messageIds:[original.id],seq});
    assert.equal(agent.session.seq,seq,'latching cannot append an inbox event or new user message');assert.deepEqual(agent.inbox.nextTurn,[original]);assert.equal(calls,cancelled?1:0);
    if(cancelled){agent.cancel({kind:'user'});assert.equal(signal.aborted,true);}
   });
   await agent.whenIdle();await ctx.sessionPersistence.flush(agent.session);const events=(await ctx.sessionQuery.readSession(agent.id)).events;
   assert.equal(events.filter(event=>event.type==='user/message'&&event.data.id===original.id).length,cancelled?0:1);assert.equal(events.filter(event=>event.type==='user/message').length,cancelled?0:1);
   assert.equal(calls,1);assert.equal(agent.inbox.hasPending,false);
  }
 }finally{
  for(const handle of handles)await handle.dispose();if(ctx)await ctx.fiber.dispose();
  const canonicalBase=await realpath(base),canonicalRoot=await realpath(root),rel=relative(canonicalBase,canonicalRoot);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));await rm(canonicalRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
