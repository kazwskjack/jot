// Installed official driver and Goal service. Synthetic in-process model only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,realpath,writeFile,readFile} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {withNativeWorkspaceBarrier} from '../native-workspace-barrier.js';
import {createNativeInvariantReplay} from '../native-invariant-replay.js';
import {spawnSync} from 'node:child_process';
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
  for(const id of ['lead','child'])handles.push(await ctx.agents.create({sessionId:id,meta:{cwd:root,agentPreset:'jot-general'},agentOptions:{provider:'local-workspace',model:'scripted'}}));
  const members=handles.map(handle=>({agent:handle.agent,registry:ctx.agents,persistence:ctx.sessionPersistence,projections:ctx.sessionProjections}));
  const input={members,assertReservation:()=>{for(const {agent} of members)assert.equal(ctx.agents.get(agent.id),agent);}};
  await withNativeWorkspaceBarrier(input,async(proofs,check,_signal,_recheck,workspaces)=>{
   assert.deepEqual(proofs.map(proof=>proof.session_ref),['child','lead']);
   assert.deepEqual(workspaces.map(({session_ref,custody,cwd})=>({session_ref,custody,cwd})),['child','lead'].map(session_ref=>({session_ref,custody:'resident',cwd:root})));
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

test('installed JSONL ownership excludes both native resume and another process while a cold member is held',
 {skip:!runtime,timeout:45000},async()=>{
 const base=fileURLToPath(new URL('../../../.test-tmp/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'workspace-cold-native-')),store=join(root,'sessions');let ctx;const handles=[];
 try{
  const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'],modules={};
  for(const name of [...names,'dsh-session-persistence'])modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')).href);
  ctx=new modules.cordis.Context();for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:store,compression:'none'}:{});
  let calls=0;class LocalModel extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;yield{type:'text-delta',index:0,text:'Synthetic completed input.'};yield{type:'usage',usage:{inputTokens:5,outputTokens:1,totalTokens:6}};yield{type:'finish',reason:{kind:'stop'}};}}
  ctx.llm.registerAdapter(['local-cold'],new LocalModel());const options={provider:'local-cold',model:'scripted'};
  const cold=await ctx.agents.create({sessionId:'cold',meta:{cwd:root,agentPreset:'jot-general'},agentOptions:options});handles.push(cold);
  cold.agent.followup(modules['dsh-llm'].createUserMessage({source:{kind:'user',rpcId:'cold-input'},content:[{type:'text',text:'PRIVATE-SYNTHETIC-BODY'}]}));
  await cold.agent.whenIdle();await ctx.sessionPersistence.flush();await cold.dispose();
  assert.equal(ctx.agents.get('cold'),undefined);assert.equal(ctx.sessions.get('cold'),undefined);assert.equal(calls,1);
  const before=await ctx.sessionQuery.readSession('cold'),lead=await ctx.agents.create({sessionId:'lead',meta:{cwd:root,agentPreset:'jot-general'},agentOptions:options});handles.push(lead);
  const persistence=ctx.sessionPersistence,source={sessionRef:'cold',registry:ctx.agents,sessions:ctx.sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,
   backendClass:modules['dsh-session-persistence'].SessionPersistence,allowedPresets:new Set(['jot-general']),validateLog:createNativeInvariantReplay({Session:modules['dsh-session'].Session}),projections:ctx.sessionProjections};
  const members=[source,{agent:lead.agent,registry:ctx.agents,persistence,projections:ctx.sessionProjections}];
  await withNativeWorkspaceBarrier({members,assertReservation:()=>{}},async(proofs,check,_signal,recheck,workspaces)=>{
   assert.equal(proofs[0].session_ref,'cold');assert.equal(proofs[0].storage_owned,true);assert.equal(proofs[0].seq_exclusive,before.events.length);
   assert.deepEqual(workspaces.map(({session_ref,custody,cwd})=>({session_ref,custody,cwd})),[{session_ref:'cold',custody:'cold',cwd:root},{session_ref:'lead',custody:'resident',cwd:root}]);
   assert.equal(JSON.stringify(proofs).includes('PRIVATE-SYNTHETIC-BODY'),false);assert.equal(JSON.stringify(proofs).includes(root),false);
   await assert.rejects(ctx.agents.resume({resumeSessionId:'cold',agentOptions:options}),{name:'SessionAlreadyOwnedError'});
   const readable=await persistence.open('cold','read');try{assert.equal((await readable.read()).events.length,before.events.length);}finally{await readable.close();}
   const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
   Object.assign(env,{JOT_DSH_RUNTIME_MODULES:runtime,JOT_TEST_TMP:base});
   const peer=spawnSync(process.execPath,[fileURLToPath(new URL('./support/workspace-write-probe.mjs',import.meta.url)),store,'cold'],{env,encoding:'utf8',windowsHide:true,timeout:20000});
   assert.equal(peer.status,0,peer.stderr);assert.deepEqual(JSON.parse(peer.stdout.trim()),{owned:false,error:'SessionAlreadyOwnedError'});check();await recheck();assert.equal(calls,1);
  });
  assert.deepEqual((await ctx.sessionQuery.readSession('cold')).events,before.events,'holding ownership never replays or appends native events');
  const resumed=await ctx.agents.resume({resumeSessionId:'cold',agentOptions:options});handles.push(resumed);assert.equal(ctx.agents.get('cold'),resumed.agent);assert.equal(calls,1);
 }finally{
  for(const handle of handles)await handle.dispose();if(ctx)await ctx.fiber.dispose();
  const canonicalBase=await realpath(base),canonicalRoot=await realpath(root),rel=relative(canonicalBase,canonicalRoot);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));
  await rm(canonicalRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
