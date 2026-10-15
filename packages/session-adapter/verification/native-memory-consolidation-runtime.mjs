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
test('actual DSH stages and proposes memory consolidation without applying reviewed facts',{timeout:20000,skip:!runtime},async t=>{
 const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop'],modules={};
 for(const name of names){const manifest=JSON.parse(readFileSync(join(runtime,name,'package.json'),'utf8'));if(name!=='cordis')assert.equal(manifest.version,'0.2.0-rc.2');modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')).href);}
 const base=resolve('.test-tmp/native-memory-consolidation');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));let service,ctx,handle;
 t.after(async()=>{if(handle)await handle.dispose();if(ctx)await ctx.fiber.dispose();if(service){await service.app.close();service.db.close();}const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const owner='native-memory-fixture',token=randomBytes(32).toString('hex'),route={provider:'local-scripted',model:'scripted',revision:'fixture-rates',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}},limits={tokens:5000,nano_usd:50000,model_calls:20};
 service=await buildServer({databasePath:join(root,'gateway.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),internalChannelToken:token,modelBudgetPolicy:{revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limits]))}});
 const role=service.workbench.createAgent(owner,{name:'Memory curator'}),note=service.workbench.saveMemory(owner,'ws',{scope:'private',agent_id:role.agent_id,content:'An original verified finding',verified:true});
 const chat=await service.app.inject({method:'POST',url:'/v1/conversations/'+role.conversation_id+'/messages',headers:{'x-user-id':owner,'idempotency-key':'native-memory-chat'},payload:{client_message_id:'native-memory-chat',content:[{type:'text',text:'Prepare a concise memory consolidation proposal for my review.'}]}});assert.equal(chat.statusCode,202,chat.body);
 const runId=chat.json().run_id,sessionRef=new SessionBindingRepository(service.db).getOrCreate(owner,role.conversation_id).session_id;
 const coordinator=new HarnessCoordinator(service.db,service.runs,service.events),lease=coordinator.claimNext('native-memory-worker',30000);assert.equal(lease.run_id,runId);coordinator.start(lease);
 const origin=await service.app.listen({host:'127.0.0.1',port:0});ctx=new modules.cordis.Context();
 for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
 let calls=0,started;const firstCall=new Promise(resolve=>started=resolve),runtimeErrors=[];ctx.on('agent/error',({error})=>runtimeErrors.push(String(error?.message??error)));
 class Scripted extends modules['dsh-llm'].LlmAdapter{async *stream(){const n=++calls;started();assert.ok(n<=3);
  if(n<=2){const stage=n===2?service.db.prepare('SELECT consolidation_id FROM wb_memory_consolidations WHERE run_id=?').get(runId):undefined;const operation=n===1?'memory.stage':'memory.propose',args=n===1?{scope:'private',memory_ids:[note.memory_id]}:{consolidation_id:stage.consolidation_id,expected_version:1,summary:'A concise verified-source proposal',changes:[{action:'rewrite',memory_id:note.memory_id,content:'A concise finding'}]};yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'memory-proposal-'+n,name:'jot_workspace',arguments:JSON.stringify({operation,arguments_json:JSON.stringify(args)})}};
  }else yield {type:'text-delta',index:0,text:'The proposal is ready for your review. No memory was changed.'};
  yield {type:'usage',usage:{inputTokens:5,outputTokens:5,totalTokens:10}};yield {type:'finish',reason:{kind:n<=2?'tool-calls':'stop'}};
 }}
 ctx.llm.registerAdapter([route.provider],new Scripted());handle=await ctx.agents.create({sessionId:sessionRef,meta:{cwd:root},agentOptions:{provider:route.provider,model:route.model}});
 const bridge=new WorkbenchBridge({origin,token});await bridge.attach(handle.agent,{runId,sessionRef,executionLease:{owner:lease.owner,generation:lease.generation}});
 handle.agent.followup(modules['dsh-llm'].createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Prepare the scoped memory proposal using the workspace tool.'}]}));
 await firstCall;await handle.agent.whenIdle();assert.equal(calls,3);assert.deepEqual(runtimeErrors,[]);
 const attempts=service.db.prepare('SELECT state,actual_tokens FROM wb_model_budget_attempts WHERE run_id=?').all(runId);t.diagnostic(JSON.stringify({budgetStates:attempts}));assert.equal(attempts.filter(row=>row.state==='settled').length,3);assert.equal(attempts.every(row=>['settled','released'].includes(row.state)),true);assert.equal(attempts.reduce((sum,row)=>sum+Number(row.actual_tokens),0),30);
 const batch=service.db.prepare('SELECT consolidation_id FROM wb_memory_consolidations WHERE run_id=?').get(runId);assert.ok(batch);
 const proposal=service.workbench.memoryConsolidations.get(owner,'ws',batch.consolidation_id);assert.equal(proposal.status,'proposed');assert.equal(proposal.source_kind,'agent');assert.equal(proposal.proposal.changes[0].content,'A concise finding');assert.equal(service.workbench.memoryHistory(owner,'ws',note.memory_id).current_version,1);
 service.workbench.memoryConsolidations.apply(owner,'ws',batch.consolidation_id,2);assert.equal(service.workbench.memoryHistory(owner,'ws',note.memory_id).current_version,2);assert.equal(service.workbench.listMemory(owner,'ws',{scope:'private',agent_id:role.agent_id}).items[0].verified,false);
});
