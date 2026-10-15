// Isolated official Controller + explicit compatibility-copy probe. No provider.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {apply} from '../index.js';
import {createNativeInvariantReplay} from '../native-invariant-replay.js';
import {createNativeReplayProfile} from '../native-replay-profile.js';
import {createNativeReplayProvenance} from '../native-replay-provenance.js';
import {mountReviewedPresetFixture,PRESET_MARKER} from './native-reviewed-preset-fixture.mjs';
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),stage=process.argv[3];
assert.ok(['prepare','resume','deny-lease','deny-profile','deny-bound','cancel-factory','cancel-flush','cancel-flush-inflight'].includes(stage));
const root=resolve(config.root),base=resolve('.test-tmp/native-claimed-controller'),sub=relative(base,root);assert.ok(sub&&!sub.startsWith('..')&&!isAbsolute(sub));
const runtime=resolve(process.env.JOT_DSH_RUNTIME_MODULES),names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal','dsh-goal-round-driver','dsh-typert-registry','dsh-fs','dsh-attachment-local','dsh-file-reference','dsh-agent-default-model'];
const modules={},artifactPaths=[];for(const name of names){const packageRoot=name==='dsh-agent-loop'?config.patched:join(runtime,name),manifest=JSON.parse(readFileSync(join(packageRoot,'package.json'),'utf8'));if(name!=='cordis')assert.equal(manifest.version,'0.2.0-rc.2',name+' fixture version');if(name==='dsh-agent-loop')assert.equal(manifest.jotCompatibilityPatch.protocol,2);const path=join(packageRoot,'lib/index.js');modules[name]=await import(pathToFileURL(path).href);artifactPaths.push({id:name,path});}
const controllerPath=join(runtime,'dsh-api-session-controller/lib/index.js'),controller=await import(pathToFileURL(controllerPath).href);artifactPaths.push({id:'controller',path:controllerPath});
for(const file of ['index.js','native-claimed-composer.js','native-claimed-input.js','native-invariant-replay.js','native-replay-profile.js','native-replay-provenance.js','workbench.js','workbench-goal.js'])artifactPaths.push({id:'adapter-'+file.replaceAll('.','-'),path:fileURLToPath(new URL('../'+file,import.meta.url))});
const ctx=new modules.cordis.Context();let calls=0,presetFixture;
const flushAbort=new AbortController();let cancelOnFlush=false,flushObserved=false,durableSuffixRetained=false,retryPublished=false;
class CancelFlushPersistence extends modules['dsh-session-persistence-jsonl'].default{
 async open(...args){const handle=await super.open(...args);return new Proxy(handle,{get(target,key){const value=Reflect.get(target,key,target);if(key==='append')return async(...values)=>{const targeted=cancelOnFlush&&values[0].some(event=>event.type==='session/title'&&event.data.title==='Synthetic cancellation flush'),writing=value.apply(target,values);if(targeted&&stage==='cancel-flush-inflight'){flushObserved=true;flushAbort.abort(Error('fixture cancelled during durable suffix'));}const result=await writing;if(targeted&&!flushObserved){flushObserved=true;flushAbort.abort(Error('fixture cancelled during durable suffix'));}return result;};return typeof value==='function'?value.bind(target):value;}});}
}
class LocalModel extends modules['dsh-llm'].LlmAdapter{async *stream(options){calls++;if(config.presetId){assert.ok(options.tools?.some(tool=>tool.name==='universe_search'));assert.ok(JSON.stringify(options.messages.filter(message=>message.role==='system')).includes(PRESET_MARKER));}const useTools=!!config.presetId&&calls===1;if(useTools){for(const [index,query] of ['checked','deny'].entries()){yield {type:'block-start',index,blockType:'tool-call'};yield {type:'block-end',index,block:{type:'tool-call',id:'preset-query-'+index,name:'universe_search',arguments:JSON.stringify({query})}};}}else yield {type:'text-delta',index:0,text:'Local verified continuation.'};yield {type:'usage',usage:{inputTokens:5,outputTokens:5,totalTokens:10}};yield {type:'finish',reason:{kind:useTools?'tool-calls':'stop'}};}}
for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(name==='dsh-session-persistence-jsonl'&&stage.startsWith('cancel-flush')?CancelFlushPersistence:modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:name==='dsh-attachment-local'?{dshHome:join(root,'home')}:name==='dsh-agent-default-model'?{provider:'local-scripted',model:'scripted'}:{});
ctx.llm.registerAdapter(['local-scripted'],new LocalModel());
if(config.presetId)presetFixture=await mountReviewedPresetFixture(ctx,{runtime,presetId:config.presetId,artifactPaths});
class Uploads extends modules.cordis.Service{constructor(c){super(c,'fileUploads');}registerAgentResolver(){return()=>{};}bindPrompt(){return {commit(){},[Symbol.dispose](){}};}}
class Workspace extends modules.cordis.Service{constructor(c){super(c,'workspaceRegistry');this.archivedSessionIds=[];}list(){return [];}}
await ctx.plugin(Uploads);await ctx.plugin(Workspace);await ctx.plugin(controller.default,{nativeOpen:false});
const originalController=ctx.sessionController;
const invariants=await import(pathToFileURL(join(runtime,'dsh-invariants/lib/index.js')).href),sessionInvariant=await import(pathToFileURL(join(runtime,'dsh-session/lib/invariant.js')).href);
artifactPaths.push({id:'invariants',path:join(runtime,'dsh-invariants/lib/index.js')},{id:'session-invariant',path:join(runtime,'dsh-session/lib/invariant.js')},{id:'fixture-composition',path:fileURLToPath(import.meta.url)});
const validateLog=createNativeInvariantReplay({Context:modules.cordis.Context,Service:modules.cordis.Service,InvariantRegistry:invariants.InvariantRegistry,sessionInvariant});
if(stage==='cancel-factory'||stage.startsWith('cancel-flush')){
 if(stage.startsWith('cancel-flush')){
  const id='isolated-'+stage,initial=await ctx.agents.create({sessionId:id,meta:{cwd:root},setup:(_scope,agent)=>{agent.session.append('session/title',{title:'Original local fixture',messageSeqs:[],source:{kind:'user'}});}});await ctx.sessions.flush(initial.agent.session);await initial.dispose();
  const removeAbort=ctx.on('agent/before-setup',({bindAbortSignal})=>bindAbortSignal(flushAbort.signal));cancelOnFlush=true;
  await assert.rejects(ctx.agents.resume({resumeSessionId:id,setup:(_scope,agent)=>{agent.session.append('session/title',{title:'Synthetic cancellation flush',messageSeqs:[],source:{kind:'user'}});}}),/fixture cancelled during durable suffix/);
  assert.equal(flushObserved,true);assert.equal(ctx.agents.get(id),undefined);assert.equal(ctx.sessions.get(id),undefined);assert.equal(calls,0);
  const readStored=async()=>{const handle=await ctx.sessionPersistence.open(id,'read');try{return (await handle.read(0)).events;}finally{await handle.close();}};
  const beforeRetry=await readStored();assert.equal(beforeRetry.filter(event=>event.type==='session/title'&&event.data.title==='Synthetic cancellation flush').length,1);durableSuffixRetained=true;
  removeAbort();cancelOnFlush=false;const retried=await ctx.agents.resume({resumeSessionId:id});assert.equal(retried.agent.id,id);assert.equal(ctx.agents.get(id),retried.agent);const afterRetry=await readStored();assert.deepEqual(afterRetry.slice(0,beforeRetry.length),beforeRetry);assert.equal(afterRetry.filter(event=>event.type==='session/title'&&event.data.title==='Synthetic cancellation flush').length,1);assert.equal(calls,0);retryPublished=true;await retried.dispose();
 }else{
 const abort=new AbortController();ctx.on('agent/before-setup',({bindAbortSignal})=>bindAbortSignal(abort.signal));let reached=false;
 await assert.rejects(ctx.agents.create({sessionId:'isolated-cancelled-setup',meta:{cwd:root},setup:async()=>{reached=true;queueMicrotask(()=>abort.abort(Error('fixture cancelled')));await new Promise(()=>{});}}));
 assert.equal(reached,true);assert.equal(ctx.agents.get('isolated-cancelled-setup'),undefined);assert.equal(ctx.sessions.get('isolated-cancelled-setup'),undefined);assert.equal(calls,0);
 }
 await ctx.fiber.dispose();await new Promise((done,reject)=>process.send({kind:'cancelled',published:false,calls,flushObserved,durableSuffixRetained,retryPublished},error=>error?reject(error):done()));process.disconnect();
}else{
const profile=createNativeReplayProfile({id:'isolated-controller',presetId:config.presetId??null,auditId:stage==='deny-profile'?'core-local-fixture-v2':'core-local-fixture-v1',artifacts:artifactPaths.map(item=>({...item,sha256:createHash('sha256').update(readFileSync(item.path)).digest('hex')})),verifyComposition:async request=>({verified:ctx.get('sessionController') instanceof controller.SessionController&&ctx.get('agentLoop').jotPreSetupHookProtocol===2&&(!presetFixture||await presetFixture.verify(request))})});
const provenance=createNativeReplayProvenance({root:join(root,'host-provenance')});
const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
process.env.JOT_CONTROLLER_FIXTURE_TOKEN=config.adapterToken;process.env.JOT_CONTROLLER_FIXTURE_BRIDGE=config.gatewayToken;
let ready;const listening=new Promise(done=>ready=done);ctx.on('jot-session-adapter/ready',ready);
apply(ctx,{port,tokenEnv:'JOT_CONTROLLER_FIXTURE_TOKEN',workbenchTokenEnv:'JOT_CONTROLLER_FIXTURE_BRIDGE',workbenchOrigin:config.gateway,nativeContinuation:true,workbenchModel:{provider:'local-scripted',model:'scripted'},nativeClaimedInputRecovery:{Session:modules['dsh-session'].Session,validateLog,profile,provenance}});await listening;
if(stage==='deny-bound'){assert.ok(presetFixture);ctx.on('agent/after-setup',()=>presetFixture.replaceGeneration(),{prepend:true});}
const post=async(path,body)=>{const response=await fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{authorization:'Bearer '+config.adapterToken,'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
const send=message=>new Promise((done,reject)=>process.send(message,error=>error?reject(error):done()));
const events=async()=> (await ctx.sessionQuery.readSession(config.sessionId)).events;
let publication;ctx.on('agent/created',async({agent})=>{assert.equal(agent.id,config.sessionId);assert.equal(calls,0);const rows=await events();publication={profileVerified:!!(await provenance.read(agent.session)).fingerprint,pending:ctx.sessionProjections.stateOf(agent.session,'inbox')['next-turn'].map(m=>({id:m.id,source:m.source})),...(presetFixture?{presetId:config.presetId,preset:presetFixture.readback(agent)}:{})};});
let setups=0;ctx.on('agent/before-setup',()=>{setups++;});
const created=await post('/v1/sessions',{session_id:config.sessionId,cwd:root,...(config.presetId?{agent_preset:config.presetId}:{}),workbench_context:{run_id:config.runId,execution_lease:stage==='deny-lease'?{...config.lease,generation:config.lease.generation+1}:config.lease}});
if(stage.startsWith('deny-')){
 assert.equal(created.status,503);assert.equal(ctx.agents.get(config.sessionId),undefined);assert.equal(ctx.sessions.get(config.sessionId),undefined);assert.equal(calls,0);if(stage==='deny-lease')assert.equal(setups,0);
 await ctx.fiber.dispose();await send({kind:'denied',stage,calls,setups,published:false});process.disconnect();
}else{
assert.equal(created.status,201,JSON.stringify(created));
const agent=ctx.agents.get(config.sessionId);assert.ok(agent);assert.ok(ctx.get('sessionController') instanceof controller.SessionController);assert.equal(ctx.sessionController.agents.selectionFor(agent).current.provider,'local-scripted');
const setupCount=setups,adopted=await post('/v1/sessions',{session_id:config.sessionId,cwd:root,...(config.presetId?{agent_preset:config.presetId}:{}),workbench_context:{run_id:config.runId,execution_lease:config.lease}});assert.equal(adopted.status,201,JSON.stringify(adopted));assert.equal(ctx.agents.get(config.sessionId),agent);assert.equal(setups,setupCount);assert.equal(calls,0);
if(stage==='prepare'){
 assert.equal(created.value.native_input_recovery.state,'fresh');
 ctx.on('agent/pre-step',async({agent:subject,messages},next)=>{
  if(subject.id!==agent.id)return next();const message=messages.find(m=>m.source.kind==='user');assert.ok(message);assert.equal(message.source.rpcId,'original-rpc');assert.equal(calls,0);
  assert.equal(await ctx.sessions.flush(agent.session),true);await ctx.sessionPersistence.flush();const rows=await events();assert.equal(rows.some(e=>e.type==='step/start'),false);
  const stored=await ctx.sessionPersistence.open(agent.id,'read');try{assert.deepEqual((await stored.read(0,agent.session.seq)).events,rows);assert.equal((await stored.read(agent.session.seq,1)).events.length,0);}finally{await stored.close();}
  await send({kind:'ready',pid:process.pid,message:{id:message.id,source:message.source},calls,publication});await new Promise(()=>{});
 });
 const prompt=await post('/v1/sessions/'+config.sessionId+'/prompts',{request_id:'original-rpc',text:'Review the original local task.'});assert.equal(prompt.status,202,JSON.stringify(prompt));
 await new Promise(()=>{});
}else{
 assert.ok(['restored','none'].includes(created.value.native_input_recovery.state));assert.equal(created.value.native_input_recovery.restored+created.value.native_input_recovery.already_pending,1);assert.equal(calls,0);assert.equal(ctx.goals.get(agent).activation,'disarmed');
 const before=await events();assert.equal(before.filter(e=>e.type==='user/message').length,0);assert.equal(publication.pending.length,1);assert.equal(publication.pending[0].source.rpcId,'original-rpc');
 let continuationCommitted;const committed=new Promise(done=>continuationCommitted=done),removeCommit=ctx.on('session/event',(session,event)=>{if(session.id===agent.id&&event.type==='user/message'&&event.data.source?.rpcId==='continue-rpc')continuationCommitted();});
 const prompt=await post('/v1/sessions/'+config.sessionId+'/prompts',{request_id:'continue-rpc',text:'Continue after verifying restored input.'});assert.equal(prompt.status,202,JSON.stringify(prompt));await committed;removeCommit();await agent.whenIdle();
 const after=await events(),original=after.filter(e=>e.type==='user/message'&&e.data.source?.rpcId==='original-rpc');assert.equal(original.length,1);assert.equal(original[0].data.id,publication.pending[0].id);assert.equal(calls,config.presetId?3:2);assert.equal(after.filter(e=>e.type==='user/message'&&e.data.source?.rpcId==='continue-rpc').length,1);
 if(presetFixture){const results=after.filter(e=>e.type==='tool/result').map(e=>e.data.message);assert.equal(results.filter(message=>message.toolCallId==='preset-query-0'&&!message.isError).length,1);assert.equal(results.filter(message=>message.toolCallId==='preset-query-1'&&message.isError).length,1);assert.equal(presetFixture.state.executions,1);assert.equal(presetFixture.state.rejections,1);}
 const result={kind:'result',pid:process.pid,recovery:created.value.native_input_recovery,publication,calls,originalCommits:original.length,originalId:original[0].data.id,goalActivation:ctx.goals.get(agent).activation,...(presetFixture?{preset:presetFixture.readback(agent)}:{})};
 await ctx.fiber.dispose();await send(result);process.disconnect();
}
}
}
