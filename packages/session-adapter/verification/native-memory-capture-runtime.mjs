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
import {SessionBindingRepository} from '../../gateway/src/harness/session-bindings.ts';
import {WorkbenchBridge} from '../workbench.js';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;
test('actual DSH lists and reads captured sources then proposes through the original budgeted tool',{timeout:20000,skip:!runtime},async t=>{
 const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop'],modules={};
 for(const name of names){const manifest=JSON.parse(readFileSync(join(runtime,name,'package.json'),'utf8'));if(name!=='cordis')assert.equal(manifest.version,'0.2.1-rc.2');modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')).href);}
 const base=resolve('.test-tmp/native-memory-capture');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));let service,ctx,handle;
 t.after(async()=>{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();if(service){await service.app.close();service.db.close();}const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const owner='native-capture-fixture',token=randomBytes(32).toString('hex'),route={provider:'local-scripted',model:'scripted',revision:'fixture-rates',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}},limits={tokens:5000,nano_usd:50000,model_calls:20};
 service=await buildServer({databasePath:join(root,'gateway.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),internalChannelToken:token,modelBudgetPolicy:{revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limits]))}});
 const role=service.workbench.createAgent(owner,{name:'Memory curator'});service.workbench.memoryCapture.setPolicy(owner,role.agent_id,{expected_version:0,mode:'suggest'});
 const source=service.workbench.enqueueAgentMessage(owner,role.agent_id,{text:'I prefer concise answers with citations.',client_message_id:'source-message'});service.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);service.workbench.collectMemoryCaptures();
 const capture=service.workbench.memoryCapture.get(owner,role.agent_id,service.workbench.memoryCapture.list(owner,role.agent_id).items[0].capture_id);
 const chat=await service.app.inject({method:'POST',url:'/v1/conversations/'+role.conversation_id+'/messages',headers:{'x-user-id':owner,'idempotency-key':'native-memory-chat'},payload:{client_message_id:'native-memory-chat',content:[{type:'text',text:'Find my park and lake notes.'}]}});assert.equal(chat.statusCode,202,chat.body);
 const runId=chat.json().run_id,sessionRef=new SessionBindingRepository(service.db).getOrCreate(owner,role.conversation_id).session_id;
 const coordinator=new HarnessCoordinator(service.db,service.runs,service.events),lease=coordinator.claimNext('native-memory-worker',30000);assert.equal(lease.run_id,runId);coordinator.start(lease);
 const origin=await service.app.listen({host:'127.0.0.1',port:0});ctx=new modules.cordis.Context();
 for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
 let calls=0,started;const firstCall=new Promise(resolve=>started=resolve),runtimeErrors=[];ctx.on('agent/error',({error})=>runtimeErrors.push(String(error?.message??error)));
 class Scripted extends modules['dsh-llm'].LlmAdapter{async *stream(options){const n=++calls;started();assert.ok(n<=4);
  if(n<=3){if(n===3)assert.match(JSON.stringify(options),/I prefer concise answers with citations/);
   const operation=['memory.capture.pending','memory.capture.read','memory.capture.propose'][n-1],args=n===1?{}:n===2?{capture_id:capture.capture_id}:{capture_id:capture.capture_id,expected_version:2,summary:'Durable response preference',notes:[{content:'Prefers concise answers with citations.',source_ids:[capture.sources[0].source_id]}]};
   yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'capture-call-'+n,name:'jot_workspace',arguments:JSON.stringify({operation,arguments_json:JSON.stringify(args)})}};
  }else yield {type:'text-delta',index:0,text:'Memory candidates are ready for owner review, not applied.'};
  yield {type:'usage',usage:{inputTokens:5,outputTokens:5,totalTokens:10}};yield {type:'finish',reason:{kind:n<=3?'tool-calls':'stop'}};
 }}
 ctx.llm.registerAdapter([route.provider],new Scripted());handle=await ctx.agents.create({sessionId:sessionRef,meta:{cwd:root},agentOptions:{provider:route.provider,model:route.model}});
 const bridge=new WorkbenchBridge({origin,token});await bridge.attach(handle.agent,{runId,sessionRef,executionLease:{owner:lease.owner,generation:lease.generation}});
 handle.agent.followup(modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Read the pending source batch and propose a source-backed memory candidate.'}]}));
 await firstCall;await handle.agent.whenIdle();assert.equal(calls,4);assert.deepEqual(runtimeErrors,[]);
 const attempts=service.db.prepare('SELECT state,actual_tokens FROM wb_model_budget_attempts WHERE run_id=?').all(runId);t.diagnostic(JSON.stringify({budgetStates:attempts}));assert.equal(attempts.filter(row=>row.state==='settled').length,4);assert.equal(attempts.every(row=>['settled','released'].includes(row.state)),true);assert.equal(attempts.reduce((sum,row)=>sum+Number(row.actual_tokens),0),40);
 const proposed=service.workbench.memoryCapture.get(owner,role.agent_id,capture.capture_id);assert.equal(proposed.status,'proposed');assert.equal(proposed.proposal.notes[0].content,'Prefers concise answers with citations.');
 assert.equal(service.workbench.listMemory(owner,'ws',{agent_id:role.agent_id}).items.length,0);
 const applied=service.workbench.memoryCapture.apply(owner,role.agent_id,capture.capture_id,3);assert.equal(applied.status,'applied');const notes=service.workbench.listMemory(owner,'ws',{agent_id:role.agent_id}).items;assert.equal(notes.length,1);assert.equal(notes[0].verified,false);assert.equal(notes[0].provenance[0].kind,'conversation_block');
});
