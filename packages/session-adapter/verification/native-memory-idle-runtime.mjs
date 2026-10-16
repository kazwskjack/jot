// Actual installed DSH Session/AgentLoop and Gateway. Model output is scripted locally;
// this proves SDK/tool wiring, not real-provider reasoning or production readiness.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {buildServer} from '../../gateway/src/server.ts';
import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';
import {MemoryExtractionPump} from '../../gateway/src/harness/memory-extraction-pump.ts';
import {runWorkerPool} from '../../gateway/src/harness/worker-pool.ts';
import {SessionBindingRepository} from '../../gateway/src/harness/session-bindings.ts';
import {WorkbenchBridge} from '../workbench.js';
import {createMemoryExtractionHost} from '../memory-extraction-host.js';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
for(const revoke of [false,true])test(`idle original worker pool extracts through the actual SDK${revoke?' and settles after source revocation':''}`,{timeout:20000,skip:!runtime},async t=>{
 const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop'],modules={};
 for(const name of names){const manifest=JSON.parse(readFileSync(join(runtime,name,'package.json'),'utf8'));if(name!=='cordis')assert.equal(manifest.version,'0.2.0-rc.2');modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')).href);}
 const base=resolve('.test-tmp/native-memory-plugin');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));let service,ctx,handle;
 t.after(async()=>{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();if(service){await service.app.close();service.db.close();}const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const owner='native-plugin-fixture',token=randomBytes(32).toString('hex'),route={provider:'local-scripted',model:'scripted',revision:'fixture-rates',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}},limits={tokens:5000,nano_usd:50000,model_calls:20};
 service=await buildServer({databasePath:join(root,'gateway.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),internalChannelToken:token,modelBudgetPolicy:{revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limits]))}});
 const role=service.workbench.createAgent(owner,{name:'Memory curator'});service.workbench.memoryCapture.setPolicy(owner,role.agent_id,{expected_version:0,mode:'suggest'});
 const source=service.workbench.enqueueAgentMessage(owner,role.agent_id,{text:'I prefer concise answers with citations.',client_message_id:'source-message'});service.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);service.workbench.collectMemoryCaptures();
 const capture=service.workbench.memoryCapture.get(owner,role.agent_id,service.workbench.memoryCapture.list(owner,role.agent_id).items[0].capture_id);
 let runId,sessionRef;
 const coordinator=new HarnessCoordinator(service.db,service.runs,service.events),sessions=new SessionBindingRepository(service.db);

 const origin=await service.app.listen({host:'127.0.0.1',port:0});ctx=new modules.cordis.Context();
 for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
 let calls=0;const runtimeErrors=[];ctx.on('agent/error',({error})=>runtimeErrors.push(String(error?.message??error)));
 class Scripted extends modules['dsh-llm'].LlmAdapter{async resolveModel(provider,model){return {provider,id:model,name:model,reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}};}async *stream(options){calls++;assert.equal(calls,1);assert.equal(options.reasoningEffort,'high');assert.equal(options.sessionId,sessionRef);assert.match(JSON.stringify(options.messages),/I prefer concise answers with citations/);
 yield {type:'text-delta',index:0,text:JSON.stringify({summary:'Durable response preference',notes:[{content:'Prefers concise answers with citations.',source_ids:[capture.sources[0].source_id]}]})};if(revoke)service.workbench.memoryCapture.setPolicy(owner,role.agent_id,{expected_version:1,mode:'off'});yield {type:'usage',usage:{inputTokens:5,outputTokens:5,totalTokens:10}};yield {type:'finish',reason:{kind:'stop'}};
 }}
 ctx.llm.registerAdapter([route.provider],new Scripted());const bridge=new WorkbenchBridge({origin,token}),plugin=await import(pathToFileURL(join(runtime,'../@dsh-external/dsh-memory/lib/index.js')).href);
 const host=createMemoryExtractionHost({runtime:{Context:modules.cordis.Context,...modules['dsh-llm'],plugin},root:join(root,'plugin-scratch'),bridge,llm:ctx.llm,route:{provider:route.provider,model:route.model,max_output_tokens:route.max_output_tokens}});t.after(()=>host.dispose());
 const client={memoryExtractionReadiness:async()=>({ready:true}),create:async(session,cwd,preset,signal,id,lease)=>{runId=id;sessionRef=session;assert.equal(preset,'jot-workbench-budgeted');handle=await ctx.agents.create({sessionId:sessionRef,meta:{cwd},agentOptions:{provider:route.provider,model:route.model}});await bridge.attach(handle.agent,{runId,sessionRef,executionLease:lease});},extractMemory:async()=>host.run(handle.agent,{signal:t.signal})};
 const pump=new MemoryExtractionPump(service.db,service.workbench,coordinator,client,{enabled:true,workerId:'original-idle-slot',leaseMs:30000,cwd:root,sessionResolver:id=>sessions.getOrCreateForConversation(id).session_id});let stopped=false,result;
 await runWorkerPool({concurrency:1,pollMs:1,shouldStop:()=>stopped,processNext:async()=>{assert.equal(coordinator.claimNext('ordinary-worker',30000),null);result=await pump.processNext(t.signal);stopped=true;return result;}});
 assert.equal(result.runtime_status,revoke?'memory_reconciliation_required':'memory_proposed');assert.equal(calls,1);assert.deepEqual(runtimeErrors,[]);assert.equal(await pump.processNext(t.signal),null);assert.equal(calls,1);
 const attempts=service.db.prepare('SELECT state,actual_tokens FROM wb_model_budget_attempts WHERE run_id=?').all(runId);t.diagnostic(JSON.stringify({budgetStates:attempts}));assert.equal(attempts.filter(row=>row.state==='settled').length,1);assert.equal(attempts.every(row=>['settled','released'].includes(row.state)),true);assert.equal(attempts.reduce((sum,row)=>sum+Number(row.actual_tokens),0),10);
 if(revoke){assert.equal(service.db.prepare('SELECT status FROM wb_memory_captures WHERE capture_id=?').get(capture.capture_id).status,'ready');assert.equal(service.workbench.listMemory(owner,'ws',{agent_id:role.agent_id}).items.length,0);return;}
 const proposed=service.workbench.memoryCapture.get(owner,role.agent_id,capture.capture_id);assert.equal(proposed.status,'proposed');assert.equal(proposed.proposal.notes[0].content,'Prefers concise answers with citations.');
 assert.equal(service.workbench.listMemory(owner,'ws',{agent_id:role.agent_id}).items.length,0);
 const applied=service.workbench.memoryCapture.apply(owner,role.agent_id,capture.capture_id,3);assert.equal(applied.status,'applied');const notes=service.workbench.listMemory(owner,'ws',{agent_id:role.agent_id}).items;assert.equal(notes.length,1);assert.equal(notes[0].verified,false);assert.equal(notes[0].provenance[0].kind,'conversation_block');
});
