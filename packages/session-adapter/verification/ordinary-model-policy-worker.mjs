// Isolated SDK test Host. All routes and responses are synthetic and local.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {apply} from '../index.js';
import {createOrdinaryInputAdmissions} from '../ordinary-input-admissions.js';
import {createNativeInvariantReplay} from '../native-invariant-replay.js';
const fixture=JSON.parse(await readFile(process.argv[2],'utf8'));
const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal','dsh-goal-round-driver','dsh-typert-registry','dsh-fs','dsh-attachment-local','dsh-file-reference','dsh-agent-default-model','dsh-api-remote-access','dsh-agent-preset-registry'];
const modules={};
for(const name of names){
 const manifest=JSON.parse(await readFile(join(fixture.runtime,name,'package.json'),'utf8'));if(name!=='cordis')assert.equal(manifest.version,'0.2.1-rc.2');
 modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?fixture.patched:join(fixture.runtime,name),'lib/index.js')));
}
const ctx=new modules.cordis.Context();
ctx.provide('profileContext',{installAnchor:join(fixture.runtime,'dsh/package.json')});
for(const name of names.filter(name=>!['cordis','dsh-agent-preset-registry'].includes(name)))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(fixture.root,'sessions'),compression:'none'}:name==='dsh-attachment-local'?{dshHome:join(fixture.root,'attachment-home')}:name==='dsh-agent-default-model'?{provider:'local-scripted',model:'default'}:{});
// The fixture mounts no preset plugins. Use the official preset projector;
// Loader/preset composition and its production audit are outside this probe.
ctx.sessionProjections.register(modules['dsh-agent-preset-registry'].agentPresetProjectionDefinition);
class Uploads extends modules.cordis.Service{constructor(ctx){super(ctx,'fileUploads');}registerAgentResolver(){return()=>{};}bindPrompt(){return{commit(){},[Symbol.dispose](){}};}}
class Workspace extends modules.cordis.Service{constructor(ctx){super(ctx,'workspaceRegistry');this.archivedSessionIds=[];}list(){return [];}}
await ctx.plugin(Uploads);await ctx.plugin(Workspace);
const controller=await import(pathToFileURL(join(fixture.runtime,'dsh-api-session-controller/lib/index.js')));await ctx.plugin(controller.default,{nativeOpen:false});
let requests=0;
class Scripted extends modules['dsh-llm'].LlmAdapter{
 async listModels(provider){return[{provider,id:'chosen',name:'Chosen'}];}
 async resolveModel(provider,model){if(!fixture.available&&model==='chosen')throw Error('fixture_model_unavailable');return{provider,id:model,name:model,reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort:'low'}};}
 async *stream(options){requests++;process.send?.({type:'request',provider:options.provider,model:options.model,effort:options.reasoningEffort});yield{type:'text-delta',index:0,text:'Synthetic restored response.'};yield{type:'finish',reason:{kind:'stop'}};}
}
ctx.llm.registerAdapter(['local-scripted'],new Scripted());
ctx.on('agent/status',async({agent,status})=>{
 if(agent.id!==fixture.sessionId||status!=='idle')return;
 await ctx.sessions.flush(agent.session);await ctx.sessionPersistence.flush();
 process.send?.({type:'idle',requests,pending:[...agent.inbox.nextStep,...agent.inbox.nextTurn].map(message=>({id:message.id,rpc:message.source?.rpcId})),entered:agent.session.snapshotEvents(0).filter(event=>event.type==='user/message'&&event.data.source?.rpcId===fixture.runId).map(event=>event.data.id)});
});
if(fixture.create)await ctx.agents.create({sessionId:fixture.sessionId,meta:{cwd:fixture.root,agentPreset:'jot-general'},agentOptions:{provider:'local-scripted',model:'default'}});
process.env.JOT_MODEL_FIXTURE_TOKEN=fixture.adapterToken;process.env.JOT_MODEL_FIXTURE_BRIDGE=fixture.internalToken;
ctx.on('jot-session-adapter/ready',()=>process.send?.({type:'ready',resident:ctx.agents.get(fixture.sessionId)!==undefined}));
apply(ctx,{host:'127.0.0.1',port:fixture.port,tokenEnv:'JOT_MODEL_FIXTURE_TOKEN',workbenchTokenEnv:'JOT_MODEL_FIXTURE_BRIDGE',workbenchOrigin:fixture.gateway,ordinaryModelSelection:true,
 ordinaryInputAdmission:{admissions:createOrdinaryInputAdmissions({root:join(fixture.root,'admissions')}),profile:{read:async()=>({protocol:1,profile_id:'model-fixture',preset_id:'jot-general',audit_id:'scripted-audit',fingerprint:'a'.repeat(64)})}},
 ordinaryInputRecovery:{claimedInput:{Session:modules['dsh-session'].Session,validateLog:createNativeInvariantReplay({Session:modules['dsh-session'].Session})},verifyComposition:async({agent,projection,authority})=>{return{verified:authority.run_id===fixture.runId&&projection.values.agentPreset==='jot-general'&&(!agent||agent.id===fixture.sessionId&&agent.jotPendingWakeRevocationProtocol===1),fingerprint:'b'.repeat(64)};}},
});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,async()=>{await ctx.fiber.dispose();process.exit(0);});
