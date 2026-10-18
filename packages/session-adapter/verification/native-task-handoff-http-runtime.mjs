import {apply} from '../index.js';
import {createServer as portProbe} from 'node:http';
import {createNativeHandoffAdmission} from '../native-handoff-admission.js';
// Actual installed Team/Subagent/AgentLoop + isolated Gateway/SQLite.
// The LLM adapter is scripted locally: no external provider or production proof.
import test from 'node:test';import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';import {resolve,join,relative,isAbsolute} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
import {buildServer} from '../../gateway/src/server.ts';import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';import {SessionBindingRepository} from '../../gateway/src/harness/session-bindings.ts';
import {TaskCollaborationService} from '../../gateway/src/workbench/task-collaboration.ts';import {TaskDelegationService} from '../../gateway/src/workbench/task-delegation.ts';
import {WorkbenchBridge} from '../workbench.js';


test('formal HTTP handoff admits the exact member before its first model and returns original control',{timeout:60000,skip:!process.env.JOT_DSH_RUNTIME_MODULES},async t=>{
 const runtime=resolve(process.env.JOT_DSH_RUNTIME_MODULES);
 const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal','dsh-goal-round-driver','dsh-subagent','dsh-experimental-agent-team','dsh-typert-registry','dsh-fs','dsh-attachment','dsh-file-reference','dsh-agent-default-model'];
 const modules={};for(const name of names){const manifest=JSON.parse(readFileSync(join(runtime,name,'package.json'),'utf8'));if(name!=='cordis')assert.equal(manifest.version,'0.2.1-rc.2');modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')).href);}
 const base=resolve('.test-tmp/native-handoff-runtime');mkdirSync(base,{recursive:true});const root=mkdtempSync(join(base,'case-'));let service,ctx,leadHandle;const tokenEnv='JOT_HANDOFF_HTTP_TOKEN_'+process.pid,bridgeEnv='JOT_HANDOFF_HTTP_BRIDGE_'+process.pid;
 t.after(async()=>{if(ctx)await ctx.fiber.dispose();if(leadHandle)await leadHandle.dispose();delete process.env[tokenEnv];delete process.env[bridgeEnv];if(service){await service.app.close();service.db.close();}const child=relative(base,root);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const owner='native-role-fixture',token=randomBytes(32).toString('hex'),route={provider:'local-scripted',model:'scripted',revision:'fixture-rates',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}},limits={tokens:5000,nano_usd:50000,model_calls:50};
 service=await buildServer({databasePath:join(root,'gateway.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),internalChannelToken:token,modelBudgetPolicy:{revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limits]))}});
 const lead=service.workbench.createAgent(owner,{name:'Lead',workspace_id:'ws'}),member=service.workbench.createAgent(owner,{name:'Reviewer',instructions:'Use only shared material and save source notes.',workspace_id:'ws',project_id:lead.project_id});
 const team=service.workbench.createTeam(owner,{name:'Native role team',workspace_id:'ws',project_id:lead.project_id,member_ids:[lead.agent_id,member.agent_id]});
 const task=service.persistentTasks.create(owner,{title:'Native role runtime',objective:'Review material with a saved role',agent_id:lead.agent_id,trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}}),occurrence=service.persistentTasks.runNow(owner,task.task_id,'runtime');
 const coordinator=new HarnessCoordinator(service.db,service.runs,service.events),lease=coordinator.claimNext('native-worker',30000);assert.equal(lease.run_id,occurrence.run_id);coordinator.start(lease);
 new TaskCollaborationService(service.db,service.workbench,service.persistentTasks,new TaskDelegationService(service.db,service.workbench,service.persistentTasks)).save(owner,task.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:1,max_active:1});
 ctx=new modules.cordis.Context();for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:name==='dsh-agent-default-model'?{provider:route.provider,model:route.model}:{});
 class Uploads extends modules.cordis.Service{constructor(ctx){super(ctx,'fileUploads');}registerAgentResolver(){return()=>{};}bindPrompt(){return{commit(){},[Symbol.dispose](){}};}}
 class Workspace extends modules.cordis.Service{constructor(ctx){super(ctx,'workspaceRegistry');this.archivedSessionIds=[];}list(){return [];}}
 await ctx.plugin(Uploads);await ctx.plugin(Workspace);const controllerModule=await import(pathToFileURL(join(runtime,'dsh-api-session-controller/lib/index.js')).href);await ctx.plugin(controllerModule.default,{nativeOpen:false});
 const sessionRef=new SessionBindingRepository(service.db).getOrCreate(owner,occurrence.conversation_id).session_id;
 const requests=[];const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:18831',token,fetchImpl:async(url,init)=>{const response=await service.app.inject({method:'POST',url:new URL(url).pathname,headers:init.headers,payload:JSON.parse(init.body)});requests.push({path:new URL(url).pathname,status:response.statusCode,code:response.json()?.error?.code});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});}});
 const observedBindings=new Map();bridge.bindingFor=agent=>observedBindings.get(agent.id); // Probe view only; formal apply owns all actual guard installation.
 let leadStarted;const leadRequest=new Promise(done=>leadStarted=done);
 const calls={lead:0,child:0},seenSessions=[];
 class Scripted extends modules['dsh-llm'].LlmAdapter{
  async *stream(options){const phase=options.sessionId===sessionRef?'lead':'child',n=++calls[phase];assert.ok(n<=(phase==='lead'?1:2));seenSessions.push(options.sessionId);const agent=ctx.agents.get(options.sessionId);assert.ok(bridge.bindingFor(agent),'probe observes the original backend execution identity');assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=? AND state='in_flight'").get(bridge.bindingFor(agent).runId).n,1,'formal model dispatch has original budget authority');if(phase==='child'){assert.equal(admitted,agent.id,'handoff admission must precede first model request');const state=JSON.parse(service.db.prepare('SELECT state_json FROM wb_task_handoff_control WHERE root_run_id=?').get(occurrence.run_id).state_json);assert.equal(state.controller,member.agent_id);}assert.equal(service.workbench.contextForRun(bridge.bindingFor(agent).runId).agent_id,phase==='lead'?lead.agent_id:member.agent_id);
   if(phase==='lead')leadStarted();const tool=phase==='child'&&n===1;
   if(tool){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'native-role-write',name:'jot_workspace',arguments:JSON.stringify({operation:'files.write',arguments_json:JSON.stringify({path:'native-role-notes.md',content:'Shared local source notes; verification pending.',expected_version:0})})}};}
   else yield {type:'text-delta',index:0,text:phase==='lead'?'Reviewer material received; final verification is pending.':'Shared source notes saved; lead verification required.'};
   yield {type:'usage',usage:{inputTokens:5,outputTokens:5,totalTokens:10}};yield {type:'finish',reason:{kind:tool?'tool-calls':'stop'}};
  }
 }
 ctx.llm.registerAdapter([route.provider],new Scripted());
 leadHandle=await ctx.agents.create({sessionId:sessionRef,meta:{cwd:root},agentOptions:{provider:route.provider,model:route.model}});
 let closureDone;const closureReady=new Promise(done=>closureDone=done);service.app.addHook('onResponse',async(request,response)=>{if(request.url==='/internal/v1/workbench/native-child-close'&&response.statusCode===200)closureDone();});const gateway=await service.app.listen({host:'127.0.0.1',port:0});
 const probe=portProbe();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const port=probe.address().port;await new Promise(done=>probe.close(done));const adapterToken=randomBytes(32).toString('hex');process.env[tokenEnv]=adapterToken;process.env[bridgeEnv]=token;
 let ready;const listening=new Promise(done=>ready=done);ctx.on('jot-session-adapter/ready',()=>ready());
 const post=async(path,body,authorized=true)=>{const response=await fetch('http://127.0.0.1:'+port+path,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer '+adapterToken}:{})},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
 const leadBinding={runId:occurrence.run_id,sessionRef,executionLease:{owner:lease.owner,generation:lease.generation}};observedBindings.set(sessionRef,leadBinding);
 const step=service.persistentTasks.upsertSubtask(owner,task.task_id,{title:'Inspect local material',acceptance:'Save source notes for lead review'},occurrence.run_id);

 const controlRequest=(parentBinding,action,request,signal)=>bridge.request('handoff',parentBinding,{action,request,expected_policy_version:1,route:{provider:route.provider,model:route.model}},signal);
 let admitted;
 const admit=createNativeHandoffAdmission({bridge,registry:ctx.agents,persistence:ctx.sessionPersistence,projections:ctx.sessionProjections,policyVersion:1,maxHops:2,route:{provider:route.provider,model:route.model}});
 const handoffAdmission=async scope=>{assert.equal(calls.child,0);const receipt=await admit(scope);await assert.rejects(bridge.request('guard',scope.parentBinding,{tool_name:'jot_workspace'},scope.signal),/workbench_run_forbidden/);observedBindings.set(scope.child.id,scope.binding);admitted=scope.child.id;return receipt;};
 apply(ctx,{host:'127.0.0.1',port,tokenEnv,workbenchTokenEnv:bridgeEnv,workbenchOrigin:gateway,nativeContinuation:true,nativeRoles:true,nativeRoleRecovery:true,workbenchModel:{provider:route.provider,model:route.model},handoffAdmission});await listening;
 const created=await post('/v1/sessions',{session_id:sessionRef,cwd:root,workbench_context:{run_id:occurrence.run_id,execution_lease:leadBinding.executionLease}});assert.equal(created.status,201,JSON.stringify(created));
 await bridge.request('native-task-intent',leadBinding,{request_id:'native-role-runtime',subtask_id:step.subtask_id,expected_subtask_version:step.version,recipient_agent_id:member.agent_id});
 let publishedChild,childGoalAtPublication;ctx.on('agent/created',({agent})=>{if(agent.session.header.parentSession===leadHandle.agent.id){assert.equal(ctx.agents.isOwnedBy(agent.id,leadHandle.agent),true);childGoalAtPublication=ctx.goals.get(agent);publishedChild=agent;}});
 t.diagnostic(JSON.stringify({leadSeedTypes:Array.from({length:leadHandle.agent.session.seq},(_,i)=>leadHandle.agent.session.eventAt(i).type)}));
 const memberRequest={role_ref:member.agent_id,expected_policy_version:1,request_id:'native-role-runtime',name:'reviewer',description:'Review source material',text:'Save the shared source notes.'};
 const denied=await post('/v1/sessions/'+sessionRef+'/native-members',memberRequest,false);assert.equal(denied.status,401);assert.equal(calls.child,0);
 const foreign=await post('/v1/sessions/foreign-unbound/native-members',memberRequest);assert.equal(foreign.status,409);assert.equal(calls.child,0);
 const reply=await post('/v1/sessions/'+sessionRef+'/native-members',memberRequest);assert.equal(reply.status,201,JSON.stringify(reply));const spawned=reply.value;
 const child=publishedChild;assert.ok(child,'official registry published the child');assert.equal(child.id,spawned.member.id);await child.whenIdle();
 await leadHandle.agent.whenIdle();assert.equal(calls.child,2,JSON.stringify(requests));assert.ok(seenSessions.every(id=>id===child.id||id===sessionRef));assert.ok(ctx.agentTeams.listMembers(leadHandle.agent).some(row=>row.id===child.id&&row.role==='teammate'));assert.equal(child.session.header.parentSession,leadHandle.agent.id);assert.equal(childGoalAtPublication,undefined);
 const replay=await post('/v1/sessions/'+sessionRef+'/native-members',memberRequest);assert.equal(replay.status,201,JSON.stringify(replay));assert.equal(replay.value.member.id,child.id);const conflict=await post('/v1/sessions/'+sessionRef+'/native-members',{...memberRequest,text:'Changed material request'});assert.equal(conflict.status,409);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_native_execution_runs').get().n,1);assert.equal(calls.child,2);
 assert.equal(service.workbench.readFile(owner,'ws',lead.project_id,'native-role-notes.md').content,'Shared local source notes; verification pending.');

 const binding=bridge.bindingFor(child);await ctx.subagents.drainContinuableChildren(leadHandle.agent,[child.id]);await closureReady;assert.equal(service.db.prepare('SELECT count(*) n FROM wb_native_execution_closures WHERE run_id=?').get(binding.runId).n,1);
 // whenIdle observes the current activation; wait for the actual queued Lead model request first.
 await leadRequest;await leadHandle.agent.whenIdle();assert.equal(calls.lead,1,'official Team completion wakes the original lead');
 const returned=await controlRequest(bridge.bindingFor(leadHandle.agent),'transfer',{request_id:'handoff-return',expected_revision:2,from:member.agent_id,to:lead.agent_id,execution_run_id:occurrence.run_id,execution_session_ref:sessionRef});assert.equal(returned.state.phase,'returned');
 assert.ok((await bridge.request('guard',bridge.bindingFor(leadHandle.agent),{tool_name:'jot_workspace'})).context);
 assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE state IN ('in_flight','unknown')").get().n,0);
 assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_delegations').get().n,0);
 assert.equal(service.db.prepare("SELECT count(*) n FROM wb_task_execution_receipts WHERE run_id=? AND operation='files.write'").get(binding.runId).n,1);
 t.diagnostic(JSON.stringify({formalApply:true,actualHttp:true,actualSessionController:true,actualNativeTeam:true,actualAgentLoop:true,admittedBeforeFirstModel:true,originalLeadIdle:true,oldLeadToolDenied:true,guardedMemberFile:true,returnedLead:true,settledCalls:calls,legacyRuns:0,provider:'local scripted',production:false,externalEffectDiscovery:false}));
});
