// Actual installed Team/Subagent/AgentLoop + isolated Gateway/SQLite.
// The LLM adapter is scripted locally: no external provider or production proof.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {resolve,join,relative,isAbsolute} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {buildServer} from '../../gateway/src/server.ts';import {HarnessCoordinator} from '../../gateway/src/harness/coordinator.ts';import {SessionBindingRepository} from '../../gateway/src/harness/session-bindings.ts';
import {TaskCollaborationService} from '../../gateway/src/workbench/task-collaboration.ts';import {TaskDelegationService} from '../../gateway/src/workbench/task-delegation.ts';
import {WorkbenchBridge} from '../workbench.js';import {createNativeRoleHost} from '../native-role-host.js';
import {createNativeTaskDispatcher} from '../native-task-dispatch.js';
import {captureNativeChildClosure} from '../native-child-closure.js';

const root=resolve(process.argv[2]??''),stage=process.argv[3],base=resolve('.test-tmp/native-task-crash');const subpath=relative(base,root);assert.ok(subpath&&!subpath.startsWith('..')&&!isAbsolute(subpath));assert.ok(['prepare','resume'].includes(stage));
test('native process stage '+stage,{timeout:30000},async t=>{
 const runtime=resolve(process.env.JOT_DSH_RUNTIME_MODULES),names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal','dsh-goal-round-driver','dsh-subagent','dsh-experimental-agent-team'],modules={};
 for(const name of names){const manifest=JSON.parse(readFileSync(join(runtime,name,'package.json'),'utf8'));if(name!=='cordis')assert.equal(manifest.version,'0.2.0-rc.2');modules[name]=await import(pathToFileURL(join(runtime,name,'lib/index.js')).href);}
 let service,ctx,leadHandle,host;t.after(async()=>{if(host)await host.dispose();if(leadHandle)await leadHandle.dispose();if(ctx)await ctx.fiber.dispose();if(service){await service.app.close();service.db.close();}});
 const saved=stage==='resume'?JSON.parse(readFileSync(join(root,'state.json'),'utf8')):null,owner='restart-fixture',token=randomBytes(32).toString('hex'),route={provider:'local-scripted',model:'scripted',revision:'fixture-rates',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}},limits={tokens:5000,nano_usd:50000,model_calls:50};
 service=await buildServer({databasePath:join(root,'gateway.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot:join(root,'uploads'),templateRoot:fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url)),internalChannelToken:token,modelBudgetPolicy:{revision:1,admission_route:{provider:route.provider,model:route.model},routes:[route],limits:Object.fromEntries(['owner_daily','project_daily','agent_daily','task_total','occurrence','chat_root','mailbox_thread'].map(key=>[key,limits]))}});
 const lead=saved?.lead??service.workbench.createAgent(owner,{name:'Lead',workspace_id:'ws'}),member=saved?.member??service.workbench.createAgent(owner,{name:'Reviewer',workspace_id:'ws',project_id:lead.project_id}),team=saved?.team??service.workbench.createTeam(owner,{name:'Restart team',workspace_id:'ws',project_id:lead.project_id,member_ids:[lead.agent_id,member.agent_id]});
 const task=saved?.task??service.persistentTasks.create(owner,{title:'Restart test',objective:'Preserve verified notes across process restart',agent_id:lead.agent_id,trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}}),occurrence=saved?.occurrence??service.persistentTasks.runNow(owner,task.task_id,'restart');
 const coordinator=new HarnessCoordinator(service.db,service.runs,service.events),lease=saved?.lease??coordinator.claimNext('native-worker',30000);assert.equal(lease.run_id,occurrence.run_id);if(!saved){coordinator.start(lease);new TaskCollaborationService(service.db,service.workbench,service.persistentTasks,new TaskDelegationService(service.db,service.workbench,service.persistentTasks)).save(owner,task.task_id,{expected_version:0,enabled:true,team_id:team.team_id,member_ids:[member.agent_id],max_delegations:1,max_active:1});}
 const step=saved?.step??service.persistentTasks.upsertSubtask(owner,task.task_id,{title:'Verify sources',acceptance:'Save materials and limitations'},occurrence.run_id);
 if(saved){
  assert.notEqual(saved.pid,process.pid);const attempt=service.db.prepare("SELECT * FROM wb_model_budget_attempts WHERE run_id=? AND state='in_flight'").get(saved.childRun);assert.ok(attempt);
  const before=service.modelBudgets.balancesForRun(owner,saved.childRun);
  assert.throws(()=>service.workbench.reconcileNativeInterruptedCalls(owner,occurrence.run_id,{owner:lease.owner,generation:lease.generation}),/native_recovery_fence_live/);
  service.db.prepare('UPDATE ga_worker_leases SET generation=generation+1,expires_at=? WHERE resource_id=?').run(String(Date.now()+30000),occurrence.run_id);
  const nextLease={owner:lease.owner,generation:lease.generation+1};
  assert.deepEqual(service.workbench.reconcileNativeInterruptedCalls(owner,occurrence.run_id,nextLease),{marked_unknown:1});
  assert.deepEqual(service.workbench.reconcileNativeInterruptedCalls(owner,occurrence.run_id,nextLease),{marked_unknown:0});
  assert.deepEqual(service.modelBudgets.balancesForRun(owner,saved.childRun),before);
  assert.equal(service.db.prepare('SELECT state FROM wb_model_budget_attempts WHERE run_id=? AND attempt_id=?').get(saved.childRun,attempt.attempt_id).state,'unknown');
  assert.throws(()=>service.modelBudgets.reserve(owner,occurrence.run_id,{attempt_id:'after-crash',provider:route.provider,model:route.model}),/budget_usage_unknown/);
  assert.throws(()=>service.modelBudgets.releaseUndispatched(owner,saved.childRun,attempt.attempt_id),/budget_dispatch_conflict/);
  assert.equal(service.db.prepare('SELECT count(*) n FROM wb_native_child_reservations').get().n,1);assert.equal(service.db.prepare('SELECT count(*) n FROM wb_task_delegations').get().n,0);
  assert.equal(service.db.prepare('SELECT count(*) n FROM wb_native_execution_closures').get().n,0);
  assert.throws(()=>service.workbench.readFile(owner,'ws',lead.project_id,'restart-notes.md'));
  writeFileSync(join(root,'result.json'),JSON.stringify({abruptProcessExit:true,previousPid:saved.pid,pid:process.pid,unknownCalls:1,heldBudgetPreserved:true,sameFenceRejected:true,noNewDispatch:true,noLegacy:true,production:false}));return;
 }
 ctx=new modules.cordis.Context();for(const name of names.filter(name=>name!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
 const sessionRef=saved?.sessionRef??new SessionBindingRepository(service.db).getOrCreate(owner,occurrence.conversation_id).session_id,requests=[];
 let publicationUnavailable=false;
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:18831',token,fetchImpl:async(url,init)=>{if(new URL(url).pathname.endsWith('/native-child-published')&&publicationUnavailable){publicationUnavailable=false;throw new Error('fixture_publication_transport_unavailable');}const response=await service.app.inject({method:'POST',url:new URL(url).pathname,headers:init.headers,payload:JSON.parse(init.body)});requests.push({path:new URL(url).pathname,status:response.statusCode,code:response.json()?.error?.code});return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});}});
 const calls={lead:0,child:0};class Scripted extends modules['dsh-llm'].LlmAdapter{async *stream(options){const phase=options.sessionId===sessionRef?'lead':'child',n=++calls[phase];assert.ok(n<=(phase==='lead'?1:2));const agent=ctx.agents.get(options.sessionId);assert.ok(bridge.bindingFor(agent));assert.equal(service.workbench.contextForRun(bridge.bindingFor(agent).runId).agent_id,phase==='lead'?lead.agent_id:member.agent_id);
 if(phase==='child'&&n===1){const childRun=bridge.bindingFor(agent).runId;assert.equal(service.db.prepare("SELECT count(*) n FROM wb_model_budget_attempts WHERE run_id=? AND state='in_flight'").get(childRun).n,1);await ctx.sessionPersistence.flush();writeFileSync(join(root,'state.json'),JSON.stringify({pid:process.pid,lead,member,team,task,occurrence,lease,step,sessionRef,childId:agent.id,childRun}));process.exit(77);}
 const tool=phase==='child'&&n===1;if(tool){yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'block-end',index:0,block:{type:'tool-call',id:'restart-tool-'+stage,name:'jot_workspace',arguments:JSON.stringify({operation:stage==='prepare'?'files.write':'files.read',arguments_json:JSON.stringify(stage==='prepare'?{path:'restart-notes.md',content:'Verified source material survives restart.',expected_version:0}:{path:'restart-notes.md'})})}};}else yield {type:'text-delta',index:0,text:'Verified shared material; acceptance pending.'};yield {type:'usage',usage:{inputTokens:5,outputTokens:5,totalTokens:10}};yield {type:'finish',reason:{kind:tool?'tool-calls':'stop'}};}}
 ctx.llm.registerAdapter([route.provider],new Scripted());leadHandle=await (saved?ctx.agents.resume({resumeSessionId:sessionRef,agentOptions:{provider:route.provider,model:route.model}}):ctx.agents.create({sessionId:sessionRef,agentOptions:{provider:route.provider,model:route.model}}));
 await bridge.attach(leadHandle.agent,{runId:occurrence.run_id,sessionRef,executionLease:{owner:lease.owner,generation:lease.generation}},{sessions:ctx.sessions,persistence:ctx.sessionPersistence});
 host=createNativeRoleHost({ctx,bridge,automaticClosures:true,nativeRecovery:true,durableSpawns:true,sessions:ctx.sessions,persistence:ctx.sessionPersistence,selectModel:async(agent,check)=>{assert.equal(agent.options.provider,route.provider);await check();}});assert.equal(host.admission.accepted.size,0);
 let child;ctx.on('agent/created',({agent})=>{if(agent.session.header.parentSession===sessionRef){assert.equal(ctx.agents.isOwnedBy(agent.id,leadHandle.agent),true);assert.equal(ctx.goals.get(agent),undefined);child=agent;}});
 const dispatch=createNativeTaskDispatcher({bridge,host});
 const spawn=()=>dispatch(leadHandle.agent,bridge.bindingFor(leadHandle.agent),'restart-call',{subtask_id:step.subtask_id,expected_subtask_version:step.version,recipient_agent_id:member.agent_id},new AbortController().signal);
 await spawn();assert.fail('crash fixture must exit during member stream');
});
