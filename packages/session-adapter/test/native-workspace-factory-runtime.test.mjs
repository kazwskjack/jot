// Real installed storage/registry plus the existing reviewed Jot protocol-2
// compatibility delta. No external model, credentials or production Session.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readdir,symlink,rm,realpath} from 'node:fs/promises';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {prepareDshPreSetupRuntime} from '../scripts/prepare-dsh-pre-setup.mjs';
import {createNativeWorkspaceFactoryGate} from '../native-workspace-factory.js';
import {withNativeWorkspaceBarrier} from '../native-workspace-barrier.js';
import {createNativeInvariantReplay} from '../native-invariant-replay.js';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
test('installed original factory cannot create held absent members; an already preparing writer blocks maintenance',
 {skip:!runtime,timeout:30000},async()=>{
 const base=fileURLToPath(new URL('../../../.test-tmp/',import.meta.url));await mkdir(base,{recursive:true});
 const root=await mkdtemp(join(base,'workspace-factory-native-')),scoped=join(root,'node_modules','@deepseek-ai');let ctx,gate,unblock,pending;const handles=[];
 try{
  await mkdir(scoped,{recursive:true});prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),join(scoped,'dsh-agent-loop'));
  for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.name!=='dsh-agent-loop'&&entry.isDirectory())await symlink(join(runtime,entry.name),join(scoped,entry.name),'junction');
  await symlink(join(dirname(runtime),'zod'),join(root,'node_modules','zod'),'junction');
  const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'],modules={};
  for(const name of [...names,'dsh-session-persistence'])modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
  ctx=new modules.cordis.Context();for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
  let calls=0;class Local extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;assert.fail('maintenance must not call a model');}}
  ctx.llm.registerAdapter(['local-factory'],new Local());const agentOptions={provider:'local-factory',model:'synthetic'},persistence=ctx.sessionPersistence;
  assert.equal(ctx.get('agentLoop')?.jotPreSetupHookProtocol,2);assert.equal(ctx.sessionPersistence.identity,persistence.identity,'Cordis proxies retain the original storage epoch');
  const registry=ctx.agents,sessions=ctx.sessions;
  gate=createNativeWorkspaceFactoryGate({ctx,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,notFoundError:modules['dsh-session-persistence'].SessionPersistenceNotFoundError});
  const source=id=>({sessionRef:id,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,backendClass:modules['dsh-session-persistence'].SessionPersistence,
   allowedPresets:new Set(['jot-general']),validateLog:createNativeInvariantReplay({Session:modules['dsh-session'].Session}),projections:ctx.sessionProjections});
  let setups=0;const removeCount=ctx.on('agent/after-setup',({agent})=>{if(agent.id==='absent')setups++;});
  await withNativeWorkspaceBarrier({factoryGate:gate,members:[source('absent')],assertReservation:()=>{}},async(proofs,_check,signal,recheck)=>{
   assert.equal(proofs[0].storage_absent,true);assert.equal(proofs[0].storage_owned,false);assert.equal(signal.aborted,false);
   await assert.rejects(ctx.agents.create({sessionId:'absent',meta:{agentPreset:'jot-general',cwd:root},agentOptions}),/native_workspace_factory_fenced/);
   await assert.rejects(ctx.agents.resume({resumeSessionId:'absent',agentOptions}));
   assert.equal(setups,0);assert.equal(calls,0);assert.equal(ctx.agents.get('absent'),undefined);assert.equal(await persistence.stat('absent'),undefined);await recheck();
  });
  const created=await ctx.agents.create({sessionId:'absent',meta:{agentPreset:'jot-general',cwd:root},agentOptions});handles.push(created);assert.equal(setups,1);removeCount();
  let entered;const arrived=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{unblock=resolve;});
  const removeWait=ctx.on('agent/before-setup',async({agent})=>{if(agent.id==='pending'){entered();await wait;}});
  pending=ctx.agents.create({sessionId:'pending',meta:{agentPreset:'jot-general',cwd:root},agentOptions});pending.catch(()=>{});await arrived;
  const pendingStat=await persistence.stat('pending');assert.equal(pendingStat.header.id,'pending');assert.equal(pendingStat.formatStatus,undefined,'official pending storage is not a current materialized log');
  await assert.rejects(persistence.open('pending','write'),{name:'SessionAlreadyOwnedError'});
  await assert.rejects(withNativeWorkspaceBarrier({factoryGate:gate,members:[source('pending')],assertReservation:()=>{}},()=>assert.fail('pending writer must exclude effects')),/native_workspace_cold_unavailable/);
  unblock();const prepared=await pending;handles.push(prepared);removeWait();assert.equal(calls,0);
 }finally{
  unblock?.();if(pending)await pending.catch(()=>{});if(gate)await gate.dispose();for(const handle of handles)await handle.dispose();if(ctx)await ctx.fiber.dispose();
  const canonicalBase=await realpath(base),canonicalRoot=await realpath(root),rel=relative(canonicalBase,canonicalRoot);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));
  await rm(canonicalRoot,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 }
});
