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
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),stage=process.argv[3];
assert.ok(['prepare','resume','deny-lease','deny-profile','cancel-factory'].includes(stage));
const root=resolve(config.root),base=resolve('.test-tmp/native-claimed-controller'),sub=relative(base,root);assert.ok(sub&&!sub.startsWith('..')&&!isAbsolute(sub));
const runtime=resolve(process.env.JOT_DSH_RUNTIME_MODULES),names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal','dsh-goal-round-driver','dsh-typert-registry','dsh-fs','dsh-attachment-local','dsh-file-reference','dsh-agent-default-model'];
const modules={},artifactPaths=[];for(const name of names){const path=join(name==='dsh-agent-loop'?config.patched:join(runtime,name),'lib/index.js');modules[name]=await import(pathToFileURL(path).href);artifactPaths.push({id:name,path});}
const controllerPath=join(runtime,'dsh-api-session-controller/lib/index.js'),controller=await import(pathToFileURL(controllerPath).href);artifactPaths.push({id:'controller',path:controllerPath});
for(const file of ['index.js','native-claimed-composer.js','native-claimed-input.js','native-invariant-replay.js','native-replay-profile.js','native-replay-provenance.js','workbench.js','workbench-goal.js'])artifactPaths.push({id:'adapter-'+file.replaceAll('.','-'),path:fileURLToPath(new URL('../'+file,import.meta.url))});
const ctx=new modules.cordis.Context();let calls=0;
class LocalModel extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;yield {type:'text-delta',index:0,text:'Local verified continuation.'};yield {type:'usage',usage:{inputTokens:5,outputTokens:5,totalTokens:10}};yield {type:'finish',reason:{kind:'stop'}};}}
for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:name==='dsh-attachment-local'?{dshHome:join(root,'home')}:name==='dsh-agent-default-model'?{provider:'local-scripted',model:'scripted'}:{});
ctx.llm.registerAdapter(['local-scripted'],new LocalModel());
class Uploads extends modules.cordis.Service{constructor(c){super(c,'fileUploads');}registerAgentResolver(){return()=>{};}bindPrompt(){return {commit(){},[Symbol.dispose](){}};}}
class Workspace extends modules.cordis.Service{constructor(c){super(c,'workspaceRegistry');this.archivedSessionIds=[];}list(){return [];}}
await ctx.plugin(Uploads);await ctx.plugin(Workspace);await ctx.plugin(controller.default,{nativeOpen:false});
const originalController=ctx.sessionController;
const invariants=await import(pathToFileURL(join(runtime,'dsh-invariants/lib/index.js')).href),sessionInvariant=await import(pathToFileURL(join(runtime,'dsh-session/lib/invariant.js')).href);
artifactPaths.push({id:'invariants',path:join(runtime,'dsh-invariants/lib/index.js')},{id:'session-invariant',path:join(runtime,'dsh-session/lib/invariant.js')},{id:'fixture-composition',path:fileURLToPath(import.meta.url)});
const validateLog=createNativeInvariantReplay({Context:modules.cordis.Context,Service:modules.cordis.Service,InvariantRegistry:invariants.InvariantRegistry,sessionInvariant});
if(stage==='cancel-factory'){
 const abort=new AbortController();ctx.on('agent/before-setup',({bindAbortSignal})=>bindAbortSignal(abort.signal));let reached=false;
 await assert.rejects(ctx.agents.create({sessionId:'isolated-cancelled-setup',meta:{cwd:root},setup:async()=>{reached=true;queueMicrotask(()=>abort.abort(Error('fixture cancelled')));await new Promise(()=>{});}}));
 assert.equal(reached,true);assert.equal(ctx.agents.get('isolated-cancelled-setup'),undefined);assert.equal(ctx.sessions.get('isolated-cancelled-setup'),undefined);assert.equal(calls,0);await ctx.fiber.dispose();await new Promise((done,reject)=>process.send({kind:'cancelled',published:false,calls},error=>error?reject(error):done()));process.disconnect();
}else{
const profile=createNativeReplayProfile({id:'isolated-controller',auditId:stage==='deny-profile'?'core-local-fixture-v2':'core-local-fixture-v1',artifacts:artifactPaths.map(item=>({...item,sha256:createHash('sha256').update(readFileSync(item.path)).digest('hex')})),verifyComposition:async()=>({verified:ctx.get('sessionController') instanceof controller.SessionController&&ctx.get('agentLoop').jotPreSetupHookProtocol===1})});
const provenance=createNativeReplayProvenance({root:join(root,'host-provenance')});
const probe=createServer();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));
process.env.JOT_CONTROLLER_FIXTURE_TOKEN=config.adapterToken;process.env.JOT_CONTROLLER_FIXTURE_BRIDGE=config.gatewayToken;
let ready;const listening=new Promise(done=>ready=done);ctx.on('jot-session-adapter/ready',ready);
apply(ctx,{port,tokenEnv:'JOT_CONTROLLER_FIXTURE_TOKEN',workbenchTokenEnv:'JOT_CONTROLLER_FIXTURE_BRIDGE',workbenchOrigin:config.gateway,nativeContinuation:true,workbenchModel:{provider:'local-scripted',model:'scripted'},nativeClaimedInputRecovery:{Session:modules['dsh-session'].Session,validateLog,profile,provenance}});await listening;
const post=async(path,body)=>{const response=await fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{authorization:'Bearer '+config.adapterToken,'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
const send=message=>new Promise((done,reject)=>process.send(message,error=>error?reject(error):done()));
const events=async()=> (await ctx.sessionQuery.readSession(config.sessionId)).events;
let publication;ctx.on('agent/created',async({agent})=>{assert.equal(agent.id,config.sessionId);assert.equal(calls,0);const rows=await events();publication={profileVerified:!!(await provenance.read(agent.session)).fingerprint,pending:ctx.sessionProjections.stateOf(agent.session,'inbox')['next-turn'].map(m=>({id:m.id,source:m.source}))};});
let setups=0;ctx.on('agent/before-setup',()=>{setups++;});
const created=await post('/v1/sessions',{session_id:config.sessionId,cwd:root,workbench_context:{run_id:config.runId,execution_lease:stage==='deny-lease'?{...config.lease,generation:config.lease.generation+1}:config.lease}});
if(stage.startsWith('deny-')){
 assert.equal(created.status,503);assert.equal(ctx.agents.get(config.sessionId),undefined);assert.equal(ctx.sessions.get(config.sessionId),undefined);assert.equal(calls,0);if(stage==='deny-lease')assert.equal(setups,0);
 await ctx.fiber.dispose();await send({kind:'denied',stage,calls,setups,published:false});process.disconnect();
}else{
assert.equal(created.status,201,JSON.stringify(created));
const agent=ctx.agents.get(config.sessionId);assert.ok(agent);assert.ok(ctx.get('sessionController') instanceof controller.SessionController);assert.equal(ctx.sessionController.agents.selectionFor(agent).current.provider,'local-scripted');
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
 assert.equal(created.value.native_input_recovery.state,'restored');assert.equal(created.value.native_input_recovery.restored,1);assert.equal(calls,0);assert.equal(ctx.goals.get(agent).activation,'disarmed');
 const before=await events();assert.equal(before.filter(e=>e.type==='user/message').length,0);assert.equal(publication.pending.length,1);assert.equal(publication.pending[0].source.rpcId,'original-rpc');
 let continuationCommitted;const committed=new Promise(done=>continuationCommitted=done),removeCommit=ctx.on('session/event',(session,event)=>{if(session.id===agent.id&&event.type==='user/message'&&event.data.source?.rpcId==='continue-rpc')continuationCommitted();});
 const prompt=await post('/v1/sessions/'+config.sessionId+'/prompts',{request_id:'continue-rpc',text:'Continue after verifying restored input.'});assert.equal(prompt.status,202,JSON.stringify(prompt));await committed;removeCommit();await agent.whenIdle();
 const after=await events(),original=after.filter(e=>e.type==='user/message'&&e.data.source?.rpcId==='original-rpc');assert.equal(original.length,1);assert.equal(original[0].data.id,publication.pending[0].id);assert.equal(calls,2);assert.equal(after.filter(e=>e.type==='user/message'&&e.data.source?.rpcId==='continue-rpc').length,1);
 const result={kind:'result',pid:process.pid,recovery:created.value.native_input_recovery,publication,calls,originalCommits:original.length,originalId:original[0].data.id,goalActivation:ctx.goals.get(agent).activation};
 await ctx.fiber.dispose();await send(result);process.disconnect();
}
}
}
