// Actual installed Team/Subagent/AgentLoop + isolated Gateway/SQLite.
// The LLM adapter is scripted locally: no external provider or production proof.
import test from 'node:test';import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';import {resolve,join,relative,isAbsolute} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
import {buildServer} from '../../gateway/src/server.ts';import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';import {SessionBindingRepository} from '../../gateway/src/harness/session-bindings.ts';
import {TaskCollaborationService} from '../../gateway/src/workbench/task-collaboration.ts';import {TaskDelegationService} from '../../gateway/src/workbench/task-delegation.ts';
import {WorkbenchBridge} from '../workbench.js';import {createNativeRoleHost} from '../native-role-host.js';
import {captureNativeChildClosure} from '../native-child-closure.js';
import {apply} from '../index.js';
import {TaskExecutionEvidence} from '../../gateway/src/persistent-tasks/execution-evidence.ts';
import {createServer as portProbe} from 'node:http';
import {createBudgetModelSelector} from '../budget-model-selection.js';

test('actual native Goal stop blocks created members without refunding sent calls',{timeout:60000,skip:!process.env.JOT_DSH_RUNTIME_MODULES},async t=>{

 const runtime=resolve(process.env.JOT_DSH_RUNTIME_MODULES);
 const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal','dsh-goal-round-driver','dsh-subagent','dsh-experimental-agent-team','dsh-typert-registry','dsh-fs','dsh-attachment','dsh-file-reference','dsh-agent-default-model'];
 const modules={};for(const name of names){const manifest=JSON.parse(readFileSync(join(runtime,name,'package.json'),'utf8'));if(name!=='cordis')assert.equal(manifest.version,'0.2.0-rc.2');modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')).href);}
 const base=resolve('.test-tmp/native-task-runtime');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));let service,ctx,leadHandle,host;const tokenEnv='JOT_HTTP_ADAPTER_TEST_'+process.pid,bridgeEnv='JOT_HTTP_BRIDGE_TEST_'+process.pid;
 t.after(async()=>{if(host)await host.dispose();if(ctx)await ctx.fiber.dispose();if(leadHandle)await leadHandle.dispose();delete process.env[tokenEnv];delete process.env[bridgeEnv];if(service){await service.app.close();service.db.close();}const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const owner='native-role-fixture',token=randomBytes(32).toString('hex'),route={provider:'local-scripted',model:'scripted',revision:'fixture-rates',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}},limits={tokens:5000,nano_usd:50000,model_calls:50};
 service=await buildServer({databasePath:join(root,'gateway.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),internalChannelToken:token,modelBudgetPolicy:{revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limits]))}});
 const lead=service.workbench.createAgent(owner,{name:'Lead',workspace_id:'ws'}),member=service.workbench.createAgent(owner,{name:'Reviewer',instructions:'Use only shared material and save source notes.',workspace_id:'ws',project_id:lead.project_id});
 const team=service.workbench.createTeam(owner,{name:'Native role team',workspace_id:'ws',project_id:lead.project_id,member_ids:[lead.agent_id,member.agent_id]});
 const task=service.persistentTasks.create(owner,{title:'Native role runtime',objective:'Review material with a saved role',agent_id:lead.agent_id,trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}}),occurrence=service.persistentTasks.runNow(owner,task.task_id,'runtime');
 const coordinator=new HarnessCoordinator(service.db,service.runs,service.events),lease=coordinator.claimNext('native-worker',30000);assert.equal(lease.run_id,occurrence.run_id);coordinator.start(lease);
 new TaskCollaborationService(service.db,service.workbench,service.persistentTasks,new TaskDelegationService(service.db,service.workbench,service.persistentTasks)).save(owner,task.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:1,max_active:1});
 const step=service.persistentTasks.upsertSubtask(owner,task.task_id,{title:'Inspect local material',acceptance:'Save source notes for lead review'},occurrence.run_id);
 ctx=new modules.cordis.Context();for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:name==='dsh-agent-default-model'?{provider:route.provider,model:route.model}:{});
 // File upload and archive operations are outside this selector probe. These
 // leaf services provide inert lifecycle contracts, never model selection.
 class Uploads extends modules.cordis.Service{constructor(ctx){super(ctx,'fileUploads');}registerAgentResolver(){return()=>{};}bindPrompt(){return{commit(){},[Symbol.dispose](){}};}}
 class Workspace extends modules.cordis.Service{constructor(ctx){super(ctx,'workspaceRegistry');this.archivedSessionIds=[];}list(){return [];}}
 await ctx.plugin(Uploads);await ctx.plugin(Workspace);
 const controllerModule=await import(pathToFileURL(join(runtime,'dsh-api-session-controller/lib/index.js')).href);await ctx.plugin(controllerModule.default,{nativeOpen:false});assert.ok(ctx.sessionController,'actual SessionController is mounted');
 const sessionRef=new SessionBindingRepository(service.db).getOrCreate(owner,occurrence.conversation_id).session_id;
 const requests=[];
 const calls={lead:0,child:0};class Scripted extends modules['dsh-llm'].LlmAdapter{async *stream(options){const phase=options.sessionId===sessionRef?'lead':'child',n=++calls[phase];assert.ok(n<=(phase==='lead'?5:2));assert.equal(options.provider,route.provider);assert.equal(options.model,route.model);const runId=phase==='lead'?occurrence.run_id:service.db.prepare('SELECT run_id FROM wb_native_execution_runs WHERE child_session_ref=?').get(options.sessionId).run_id;assert.equal(service.workbench.contextForRun(runId).agent_id,phase==='lead'?lead.agent_id:member.agent_id);
 if(phase==='child'&&n===1){const goal=ctx.goals.get(leadHandle.agent);assert.equal(goal.phase,'active');const paused=ctx.goals.pause(leadHandle.agent,{id:goal.id,revision:goal.revision});ctx.goals.clear(leadHandle.agent,{id:paused.id,revision:paused.revision});}
 const tool=n===1;if(tool){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'http-write',name:'jot_workspace',arguments:JSON.stringify(phase==='lead'?{operation:'tasks.delegate',arguments_json:JSON.stringify({subtask_id:step.subtask_id,expected_subtask_version:step.version,recipient_agent_id:member.agent_id})}:{operation:'files.write',arguments_json:JSON.stringify({path:'http-notes.md',content:'Material produced through the actual HTTP adapter.',expected_version:0})})}};}else yield {type:'text-delta',index:0,text:'Saved material; lead verification pending.'};yield {type:'usage',usage:{inputTokens:5,outputTokens:5,totalTokens:10}};yield {type:'finish',reason:{kind:tool?'tool-calls':'stop'}};}}
 ctx.llm.registerAdapter([route.provider],new Scripted());leadHandle=await ctx.agents.create({sessionId:sessionRef,meta:{cwd:root},agentOptions:{provider:route.provider,model:route.model}});
 let closed;const closureReady=new Promise(resolve=>closed=resolve);service.app.addHook('onResponse',async(request,response)=>{requests.push({path:request.url,status:response.statusCode});if(request.url==='/internal/v1/workbench/native-child-close'&&response.statusCode===200)closed();});const gateway=await service.app.listen({host:'127.0.0.1',port:0});
 const probe=portProbe();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));assert.ok(port>=1024);
 const adapterToken=randomBytes(32).toString('hex');process.env[tokenEnv]=adapterToken;process.env[bridgeEnv]=token;
 let ready;const listening=new Promise(resolve=>ready=resolve);ctx.on('jot-session-adapter/ready',details=>{assert.equal(details.port,port);ready();});
 apply(ctx,{host:'127.0.0.1',port,tokenEnv,workbenchTokenEnv:bridgeEnv,workbenchOrigin:gateway,nativeContinuation:true,nativeRoles:true,nativeRoleRecovery:true,workbenchModel:{provider:route.provider,model:route.model}});await listening;
 const post=async(path,body,authorized=true)=>{const response=await fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer '+adapterToken}:{})},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
 const created=await post('/v1/sessions',{session_id:sessionRef,cwd:root,workbench_context:{run_id:occurrence.run_id,execution_lease:{owner:lease.owner,generation:lease.generation}}});assert.equal(created.status,201,JSON.stringify(created));
 let child;ctx.on('agent/created',({agent})=>{if(agent.session.header.parentSession===sessionRef)child=agent;});
 const prompted=await post('/v1/sessions/'+sessionRef+'/prompts',{request_id:'native-delegate-lead',text:'Delegate the existing source review step to the authorized Reviewer.'});assert.equal(prompted.status,202,JSON.stringify(prompted));
 await leadHandle.agent.whenIdle();assert.ok(child,JSON.stringify({calls,requests}));await closureReady;await child.whenIdle();

 assert.equal(calls.child,1,'no second member model may dispatch after parent pause');assert.equal(calls.lead,1,'paused lead cannot dispatch its next model');
 assert.equal(ctx.goals.get(leadHandle.agent),undefined);
 assert.throws(()=>service.workbench.readFile(owner,'ws',lead.project_id,'http-notes.md'));
 const childEvents=Array.from({length:child.session.seq},(_,i)=>child.session.eventAt(i));
 const rejected=childEvents.find(e=>e.type==='tool/result'&&e.data.message?.isError);assert.ok(rejected,'member tool must receive actual guard rejection');
 assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_file_execution_receipts').get().n,0);
 assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_delegations').get().n,0);
 const attempts=service.db.prepare('SELECT state,actual_tokens FROM wb_model_budget_attempts').all();const spent=attempts.filter(a=>a.state==='settled');assert.equal(spent.length,2);assert.ok(spent.every(a=>a.actual_tokens==='10'));assert.ok(attempts.every(a=>!['in_flight','unknown'].includes(a.state)),'known completed calls must remain settled; undispatched admission holds are not invented model calls');
 assert.equal(coordinator.claimNext('legacy-worker',30000),null);t.diagnostic(JSON.stringify({formalApply:true,actualHttp:true,actualSessionController:true,actualNativeTeam:true,nativeParentStopped:true,newMemberWriteDenied:true,dispatchedUsageRetained:true,legacyRuns:0,modelCalls:calls,provider:'local scripted',inertLeaves:['upload','workspace archive'],production:false}));
});
