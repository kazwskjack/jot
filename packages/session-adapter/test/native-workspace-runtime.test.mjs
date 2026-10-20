// Installed official driver and Goal service. Synthetic in-process model only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,realpath,writeFile,readFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {withNativeWorkspaceBarrier} from '../native-workspace-barrier.js';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;

test('installed native maintenance holds all drivers; new input stays queued until the physical callback settles',
 {skip:!runtime,timeout:30000},async()=>{
 const base=fileURLToPath(new URL('../../../.test-tmp/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'workspace-maintenance-'));let ctx;const handles=[];
 try{
  const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'],modules={};
  for(const name of names)modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')).href);
  ctx=new modules.cordis.Context();
  for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
  let calls=0;class LocalModel extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;yield{type:'text-delta',index:0,text:'Synthetic input consumed.'};yield{type:'usage',usage:{inputTokens:5,outputTokens:1,totalTokens:6}};yield{type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['local-workspace'],new LocalModel());
  for(const id of ['lead','child'])handles.push(await ctx.agents.create({sessionId:id,agentOptions:{provider:'local-workspace',model:'scripted'}}));
  const members=handles.map(handle=>({agent:handle.agent,registry:ctx.agents,persistence:ctx.sessionPersistence,projections:ctx.sessionProjections}));
  const input={members,assertReservation:()=>{for(const {agent} of members)assert.equal(ctx.agents.get(agent.id),agent);}};
  await withNativeWorkspaceBarrier(input,async(proofs,check)=>{
   assert.deepEqual(proofs.map(proof=>proof.session_ref),['child','lead']);
   for(const {agent} of members)assert.throws(()=>agent.runMaintenance(()=>{}),/already has active work/);
   await writeFile(join(root,'physical-result.txt'),'original callback');check();assert.equal(calls,0);
  });
  assert.equal(await readFile(join(root,'physical-result.txt'),'utf8'),'original callback');
  const original=modules['dsh-llm'].createUserMessage({source:{kind:'user',rpcId:'original-input'},content:[{type:'text',text:'Synthetic queued followup.'}]});
  await assert.rejects(withNativeWorkspaceBarrier(input,async()=>{
   handles[0].agent.followup(original);await new Promise(done=>setImmediate(done));
   assert.equal(calls,0,'maintenance must latch the native wake');
   assert.equal(handles[0].agent.inbox.nextTurn[0].id,original.id);
  }),/native_handoff_changed/);
  await handles[0].agent.whenIdle();assert.equal(calls,1);
  const events=(await ctx.sessionQuery.readSession('lead')).events;
  assert.deepEqual(events.filter(event=>event.type==='user/message').map(event=>event.data.id),[original.id]);
  await withNativeWorkspaceBarrier(input,async(_proofs,check)=>{check();});
 }finally{
  for(const handle of handles)await handle.dispose();if(ctx)await ctx.fiber.dispose();
  const canonicalBase=await realpath(base),canonicalRoot=await realpath(root),rel=relative(canonicalBase,canonicalRoot);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));
  await rm(canonicalRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
