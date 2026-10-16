// Isolated native factory fixture. No production preset or external provider.
import assert from 'node:assert/strict';
import {readFileSync,openSync,writeFileSync,fsyncSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createOrdinaryClaimedInputRecoverySetup} from '../ordinary-claimed-input.js';
import {createNativeInvariantReplay} from '../native-invariant-replay.js';
import {createNativeReplayProfile} from '../native-replay-profile.js';
import {WorkbenchBridge} from '../workbench.js';
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),stage=process.argv[3],runtime=process.env.JOT_DSH_RUNTIME_MODULES;
assert.ok(['prepare','recover','recover-hold','deny-admission','deny-profile','deny-lease'].includes(stage));
const root=resolve(config.root),base=resolve('.test-tmp'),rel=relative(base,root);assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));
const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal','dsh-goal-round-driver'];
const modules={},artifacts=[];for(const name of names){const path=join(runtime,name,'lib/index.js');modules[name]=await import(pathToFileURL(path).href);artifacts.push({id:name,path});}
for(const file of ['ordinary-claimed-input.js','ordinary-input-resume.js','native-claimed-input.js','native-invariant-replay.js','native-replay-profile.js'])artifacts.push({id:'adapter-'+file.replaceAll('.','-'),path:fileURLToPath(new URL('../'+file,import.meta.url))});
artifacts.push({id:'fixture',path:fileURLToPath(import.meta.url)});
const ctx=new modules.cordis.Context();let calls=0,publication,publicationDone;const published=new Promise(done=>publicationDone=done);
class LocalModel extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;throw Error('setup must not call a model');}}
for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
ctx.llm.registerAdapter(['local-scripted'],new LocalModel());
const bridge=new WorkbenchBridge({origin:config.gateway,token:process.env.JOT_CLAIM_FIXTURE_TOKEN}),binding=config.binding,sessionId=binding.sessionRef;
const profile=createNativeReplayProfile({id:'ordinary-factory-fixture',presetId:'jot-general',auditId:stage==='deny-profile'?'changed-fixture':'original-fixture',artifacts:artifacts.map(item=>({...item,sha256:createHash('sha256').update(readFileSync(item.path)).digest('hex')})),verifyComposition:async()=>({verified:ctx.agents instanceof modules['dsh-agent'].AgentRegistry&&ctx.sessions instanceof modules['dsh-session'].SessionStore})});
const canonical=value=>JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const notify=value=>new Promise((done,reject)=>process.send(value,error=>error?reject(error):done()));
if(stage==='prepare'){
 const handle=await ctx.agents.create({sessionId,meta:{cwd:root,agentPreset:'jot-general'},agentOptions:{provider:'local-scripted',model:'scripted'}}),agent=handle.agent;
 const original=modules['dsh-llm'].createUserMessage({source:{kind:'user',rpcId:binding.runId},content:[{type:'text',text:'Original admitted synthetic task.'}]}),authority=(await bridge.request('ordinary-input-binding',binding,{})).binding,current=await profile.read({presetId:'jot-general',agent});
 const stamp={protocol:1,run_id:authority.run_id,input_message_id:authority.input_message_id,conversation_id:authority.conversation_id,owner_id:authority.owner_id,session_id:authority.session_id,session_created_at:agent.session.header.createdAt,input_sha256:authority.input_sha256,native_message_id:original.id,native_message_sha256:createHash('sha256').update(canonical(original)).digest('hex'),profile_fingerprint:current.fingerprint};
 const descriptor=openSync(join(root,'admission.json'),'wx',0o600);try{writeFileSync(descriptor,JSON.stringify(stamp));fsyncSync(descriptor);}finally{closeSync(descriptor);}
 ctx.on('agent/pre-step',async({agent:subject,messages},next)=>{if(subject!==agent||!messages.some(m=>m.id===original.id))return next();await ctx.sessions.flush(agent.session);await ctx.sessionPersistence.flush();assert.equal(calls,0);const log=await ctx.sessionQuery.readSession(sessionId);assert.ok(!log.events.some(e=>e.type==='step/start'||e.type==='user/message'));assert.deepEqual(ctx.sessionProjections.stateOf(agent.session,'inbox'),{'next-step':[],'next-turn':[]});await notify({kind:'ready',messageId:original.id,seq:agent.session.seq,calls});setInterval(()=>{},60000);await new Promise(()=>{});});
 agent.followup(original);await new Promise(()=>{});
}else{
 const invariants=await import(pathToFileURL(join(runtime,'dsh-invariants/lib/index.js')).href),sessionInvariant=await import(pathToFileURL(join(runtime,'dsh-session/lib/invariant.js')).href);
 const setup=createOrdinaryClaimedInputRecoverySetup({binding,bridge,ordinaryPresets:new Set(['jot-general']),profile,admissions:{read:async()=>{const stamp=JSON.parse(readFileSync(join(root,'admission.json'),'utf8'));return stage==='deny-admission'?{...stamp,native_message_sha256:'0'.repeat(64)}:stamp;}},Session:modules['dsh-session'].Session,agents:ctx.agents,sessions:ctx.sessions,query:ctx.sessionQuery,projections:ctx.sessionProjections,validateLog:createNativeInvariantReplay({Context:modules.cordis.Context,Service:modules.cordis.Service,InvariantRegistry:invariants.InvariantRegistry,sessionInvariant})});
 ctx.on('agent/created',async({agent})=>{if(agent.id!==sessionId)return;const stored=await ctx.sessionPersistence.open(sessionId,'read');try{const log=await stored.read(0);publication={pending:ctx.sessionProjections.stateOf(agent.session,'inbox')['next-turn'].map(m=>m.id),durableRestore:log.events.some(e=>e.type==='agent/inbox/spliced'&&e.data.inserted.some(m=>m.id===config.messageId)),calls};publicationDone();}finally{await stored.close();}});
 if(stage.startsWith('deny-')){await assert.rejects(ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'local-scripted',model:'scripted'},setup}));assert.equal(ctx.agents.get(sessionId),undefined);assert.equal(ctx.sessions.get(sessionId),undefined);assert.equal(publication,undefined);assert.equal(calls,0);await ctx.fiber.dispose();await notify({kind:'result',denied:true,published:false,calls});}
 else{const handle=await ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'local-scripted',model:'scripted'},setup});await handle.agent.whenIdle();await published;await ctx.sessionPersistence.flush();assert.equal(calls,0);assert.deepEqual(publication.pending,[config.messageId]);assert.equal(publication.durableRestore,true);const report=setup.resultFor(handle.agent);if(stage==='recover-hold'){await notify({kind:'result',report,publication,calls});setInterval(()=>{},60000);await new Promise(()=>{});}await handle.dispose();await ctx.fiber.dispose();await notify({kind:'result',report,publication,calls});}
}
process.disconnect?.();
