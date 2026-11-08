import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import { WorkbenchBridge } from '../workbench.js';
import {createAdapterHandler} from '../index.js';
import {nativeBudgetForExecution} from '../web-budget-context.js';
import {buildServer} from '../../gateway/src/server.ts';
import {createBrowserToolsPlugin} from '../../dsh-host/browser-tools.mjs';
import {SessionControllerClient} from '../../gateway/src/harness/session-controller-client.ts';
import {createBrowserDriverReadinessSource} from '../../gateway/src/events/runtime-readiness-composition.ts';

const browserIntegrationBase=resolve(fileURLToPath(new URL('../../.test-tmp/browser-gateway-integration/',import.meta.url)));
mkdirSync(browserIntegrationBase,{recursive:true});

const binding = { runId: 'run-1', sessionRef: 'session-1',executionLease:Object.freeze({owner:'worker-fixture',generation:1}) };
test('enabled web budget wraps the installed native tools event with original authority',async()=>{
  const h=host();h.agent.id=binding.sessionRef;const paths=[];
  const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',webBudgetEnabled:true,
    fetchImpl:async(url,init)=>{
      paths.push(new URL(url).pathname);
      const body=JSON.parse(init.body);assert.equal(body.run_id,binding.runId);assert.equal(body.session_ref,binding.sessionRef);
      if(url.endsWith('/web-budget-grant'))return Response.json({protocol:1,grant:'a'.repeat(64),expires_at:new Date(Date.now()+1000).toISOString()});
      if(url.endsWith('/web-budget-grant/close'))return Response.json({closed:true});
      return Response.json({context:{...context(),model_budget:{protocol:1,enforced:true}}});
    }});
  await bridge.attach(h.agent,binding);
  const exec={token:Symbol('native'),name:'universe_search',callId:'call-native',agent:h.agent,arguments:{query:'example'},signal:new AbortController().signal};
  const value=await [...h.middleware][0](exec,async()=>{assert.equal(nativeBudgetForExecution(exec),'a'.repeat(64));return 'native-result';});
  assert.equal(value,'native-result');
  assert.equal(paths.filter(path=>path.endsWith('/web-budget-grant')).length,1);
  assert.equal(paths.at(-1),'/internal/v1/workbench/web-budget-grant/close');
  assert.equal(nativeBudgetForExecution(exec),undefined);
  assert.throws(()=>new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',webBudgetEnabled:'true'}),/workbench_bridge_config_invalid/);
});
function context(runId = 'run-1', tools = ['universe_search']) {
  return { run_id: runId, owner_id: 'owner-a', agent_id: 'agent-a', workspace_id: 'workspace-a', project_id: 'project-a',
    capability_epoch: 1, name: 'Researcher', instructions: 'Cite sources', allowed_tools: tools,
    memories: [{ memory_id: 'memory-a', content: 'Unverified claim', verified: false }] };
}
// These are the scoped APIs in the installed DSH source: duplicate names throw,
// guards monotonically deny, and tools/execute middleware surrounds dispatch.
function host() {
  const sections = new Map(), guards = new Set(), middleware = new Set(), modelMiddleware = new Set(), stepMiddleware = new Set(), tools = new Map();
  const approvalHandlers=[];
  const globalTools=['universe_search','universe_capabilities','bash','pwsh','read','write','edit','read_image','exit_plan_mode','ask_user_question','web_fetch','web_search','glob','grep','job_kill','job_list','job_output','skill','create_goal','get_goal','update_goal','list_subagent_models','subagent','subagent_fork','interrupt_agent','list_agents','send_message','workflow','ralph','todo_write'];
  let registrationFailure = false;
  let presentation = 'code', scopedPresentation = false;
  const restrictions=[];
  const ctx = {
    systemPrompt: { section(section) {
      if (sections.has(section.name)) throw new Error('duplicate_prompt_section');
      sections.set(section.name, section); return () => sections.delete(section.name);
    } },
    tools: {
      presentAs(mode) {
        if (scopedPresentation) throw new Error('presentation_conflict');
        const prior = presentation; presentation = mode; scopedPresentation = true;
        return () => { presentation = prior; scopedPresentation = false; };
      },
      guard(guard) { guards.add(guard); return () => guards.delete(guard); },
      restrict(filter) { const mask=new Set(filter.allow);restrictions.push(mask);return()=>{const index=restrictions.indexOf(mask);if(index>=0)restrictions.splice(index,1);}; },
      schemas() { return (presentation==='code'?['run_code']:[...globalTools.filter(name=>name!=='run_code'),...tools.keys()]).filter(name=>restrictions.every(mask=>mask.has(name)||tools.has(name))).map(name=>({name})); },
      register(tool) {
        if (registrationFailure) throw new Error('registration_failed');
        if (tools.has(tool.name)) throw new Error('duplicate_tool');
        assert.equal(typeof tool.output.render, 'function');
        tools.set(tool.name, tool); return () => tools.delete(tool.name);
      },
    },
    on(event, handler, options={}) {
      assert.ok(['tools/execute','llm/stream','agent/pre-step','approval/request'].includes(event));
      if(event==='approval/request'){if(options.prepend)approvalHandlers.unshift(handler);else approvalHandlers.push(handler);return()=>{const index=approvalHandlers.indexOf(handler);if(index>=0)approvalHandlers.splice(index,1);};}
      const handlers=event==='tools/execute'?middleware:event==='llm/stream'?modelMiddleware:stepMiddleware;
      handlers.add(handler);return()=>handlers.delete(handler);
    },
  };
  const agent = { id:'session-1',ctx };
  return { agent, sections, guards, middleware, modelMiddleware, stepMiddleware, tools,
    async approve(request,native=async()=> 'native-approval'){const dispatch=i=>i===approvalHandlers.length?native():approvalHandlers[i](request,()=>dispatch(i+1));return dispatch(0);},approvalHandlers,
    preStep(payload,native){const handlers=[...stepMiddleware];const dispatch=i=>i===handlers.length?native():handlers[i](payload,()=>dispatch(i+1));return dispatch(0);},
    stream(options,native){const handlers=[...modelMiddleware];const dispatch=i=>i===handlers.length?native():handlers[i](options,()=>dispatch(i+1));return dispatch(0);},
    modelTools() { return presentation === 'code' ? ['run_code'] : [...new Set([...globalTools.filter(name=>restrictions.every(mask=>mask.has(name))), ...tools.keys()])]; },
    failRegistration() { registrationFailure = true; },
    async execute(name, args = {}, native = async () => 'native-result', signal = new AbortController().signal) {
      const exec = { name, callId: 'call-1', signal };
      for (const guard of guards) { const reason = guard(exec); if (reason) throw new Error(reason); }
      const handlers = [...middleware];
      const dispatch = index => index === handlers.length
        ? tools.has(name) ? tools.get(name).execute(args, exec) : native()
        : handlers[index](exec, () => dispatch(index + 1));
      return dispatch(0);
    },
  };
}
function fixture() {
  const requests = [];
  let responseContext = context(), error = null, status = 200,goalBinding=null;
  const bridge = new WorkbenchBridge({ origin: 'http://127.0.0.1:7654', token: 'test-token-32-characters-fixture',
    fetchImpl: async (url, init) => {
      if (error) throw error;
      requests.push({ url, init, body: JSON.parse(init.body) });
      if(url.endsWith('/model-budget')){const body=JSON.parse(init.body);return new Response(JSON.stringify({receipt:{attempt_id:body.request?.attempt_id??body.attempt_id,state:body.action==='reserve'?'reserved':body.action==='dispatch'?'in_flight':body.action==='settle'?'settled':'unknown',bound_exceeded:false}}),{status});}
      if(url.endsWith('/goal-binding')){const body=JSON.parse(init.body);if(body.action==='save')goalBinding={goal_id:body.goal_id,goal_revision:body.goal_revision};return new Response(JSON.stringify({binding:goalBinding}),{status});}
      return new Response(JSON.stringify(url.endsWith('/guard') ? { context: responseContext } : { items: ['real-gateway-response'] }), { status });
    } });
  return { bridge, requests, host: host(), setContext(value) { responseContext = value; },
    rejectNetwork() { error = new Error('network_unavailable'); }, rejectEpoch() { status = 403; } };
}

test('browser tool mounts only for a leased browser role and approval resumes through the exact Gateway run',async()=>{
 const h=host(),trusted={...context(),allowed_tools:['universe_search','browser_action']},requests=[],states=['pending','approved'];let mounts=0,scope;
 const registrar={protocol:1,mount({agent,scopeForAgent}){
  mounts++;assert.equal(agent,h.agent);scope=scopeForAgent(agent);assert.ok(Object.isFrozen(scope));
  const dispose=agent.ctx.tools.register({name:'browser_action',output:{render:()=>[]},execute:async()=> 'ran'});
  return dispose;
 }};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',browserRegistrar:registrar,
  fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);requests.push({url,body});
   if(url.endsWith('/guard'))return Response.json({context:trusted});
   assert.ok(url.endsWith('/browser-approval'));
   assert.equal(body.run_id,binding.runId);assert.equal(body.session_ref,binding.sessionRef);assert.deepEqual(body.execution_lease,binding.executionLease);
   assert.equal(Object.hasOwn(body,'owner_id'),false);assert.equal(Object.hasOwn(body,'agent_id'),false);
   if(body.action==='request')return Response.json({interaction:{interaction_id:'int-browser-1',run_id:binding.runId,tool_call_id:'browser-call-1',purpose:'browser_action',version:1,status:'pending',action_digest:browserDigest(binding,'browser-call-1',body.action_payload)}});
   return Response.json({state:states.shift()});
  }});
 await bridge.attach(h.agent,binding);
 assert.equal(mounts,1);assert.equal(h.tools.has('browser_action'),true);
 assert.deepEqual({protocol:scope.protocol,owner_id:scope.owner_id,run_id:scope.run_id,session_ref:scope.session_ref,execution_lease:scope.execution_lease},
  {protocol:1,owner_id:'owner-a',run_id:binding.runId,session_ref:binding.sessionRef,execution_lease:binding.executionLease});
 const payload={tool:'browser_action',operation_id:'operation-1',call_id:'browser-call-1',request_hash:'a'.repeat(64),url:'https://fixture.example/',action:'read'};
 let nextCalls=0;const outcome=await h.approve({agent:h.agent,toolName:'browser_action',callId:'browser-call-1',reason:'Browser read: https://fixture.example/',action_payload:payload,
  owner_id:'model-owner',run_id:'model-run',session_ref:'model-session',execution_lease:{owner:'model-worker',generation:9},signal:new AbortController().signal},async()=>{nextCalls++;return 'next';});
 assert.equal(outcome,'allowed-once');assert.equal(nextCalls,0);
 const approvalRequests=requests.filter(item=>item.url.endsWith('/browser-approval'));
 assert.deepEqual(approvalRequests.map(item=>item.body.action),['request','observe','observe']);
 assert.deepEqual(approvalRequests[0].body.action_payload,payload);assert.equal(approvalRequests[0].body.action_summary,'Browser read: https://fixture.example/');
 assert.deepEqual(Object.keys(approvalRequests[0].body).sort(),['action','action_payload','action_summary','call_id','execution_lease','run_id','session_ref'].sort());
 assert.equal(requests.filter(item=>item.url.endsWith('/guard')).length,3,'one pre-approval guard and one fresh guard before and after approval');
});

function browserDigest(bound,callId,payload){
 const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value)??'null';
 return 'sha256:'+createHash('sha256').update(canonical({run_id:bound.runId,session_ref:bound.sessionRef,call_id:callId,action_payload:payload})).digest('hex');
}

test('browser registrar is resolved from the exact Agent context at attach time',async()=>{
 const h=host(),trusted={...context(),allowed_tools:['universe_search','browser_action']};let mounts=0;
 const registrar={protocol:1,mount({agent}){mounts++;assert.equal(agent,h.agent);return agent.ctx.tools.register({name:'browser_action',output:{render:()=>[]},execute:async()=> 'ran'});}};
 const presetRegistry={serviceFor(agent,name){assert.equal(agent,h.agent);assert.equal(name,'jotBrowserToolRegistrar');return registrar;}};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',
  browserRegistrarForAgent:agent=>presetRegistry.serviceFor(agent,'jotBrowserToolRegistrar'),fetchImpl:async()=>Response.json({context:trusted})});
 await bridge.attach(h.agent,binding);
 assert.equal(mounts,1);assert.equal(h.tools.has('browser_action'),true);
});
test('Gateway bridge revokes a profile through the current trusted owner and lease scope',async()=>{
 const h=host(),trusted={...context(),allowed_tools:['universe_search','browser_action']},calls=[];
 const registrar={protocol:1,mount({agent}){return agent.ctx.tools.register({name:'browser_action',output:{render:()=>[]},execute:async()=> 'ran'});},
  async revokeProfile({agent,scopeForAgent,expectedGeneration,signal}){signal.throwIfAborted();calls.push({scope:scopeForAgent(agent),expectedGeneration});return{generation:expectedGeneration+1,status:'revoked'};}};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',browserRegistrar:registrar,fetchImpl:async()=>Response.json({context:trusted})});
 await bridge.attach(h.agent,binding);
 assert.deepEqual(await bridge.revokeBrowserProfile(h.agent,8,new AbortController().signal),{generation:9,status:'revoked'});
 assert.equal(calls.length,1);assert.equal(calls[0].expectedGeneration,8);assert.equal(calls[0].scope.owner_id,'owner-a');
 assert.equal(calls[0].scope.run_id,binding.runId);assert.equal(calls[0].scope.session_ref,binding.sessionRef);assert.deepEqual(calls[0].scope.execution_lease,binding.executionLease);
});
test('browser tool stays unmounted without role permission or a current execution lease and is disposed when a lease disappears',async()=>{
 const h=host();let mounts=0,disposals=0,trusted={...context(),allowed_tools:['universe_search']};
 const registrar={protocol:1,mount({agent}){mounts++;const dispose=agent.ctx.tools.register({name:'browser_action',output:{render:()=>[]},execute:async()=> 'ran'});return()=>{disposals++;dispose();};}};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',browserRegistrar:registrar,
  fetchImpl:async()=>Response.json({context:trusted})});
 await bridge.attach(h.agent,binding);assert.equal(mounts,0);assert.equal(h.tools.has('browser_action'),false);
 trusted={...context('run-no-lease'),allowed_tools:['universe_search','browser_action']};
 await bridge.attach(h.agent,{runId:'run-no-lease',sessionRef:binding.sessionRef});assert.equal(mounts,0);assert.equal(h.tools.has('browser_action'),false);
 trusted={...context(),allowed_tools:['universe_search','browser_action']};await bridge.attach(h.agent,binding);assert.equal(mounts,1);assert.equal(h.tools.has('browser_action'),true);
 trusted={...context('run-removed-lease'),allowed_tools:['universe_search','browser_action']};
 await bridge.attach(h.agent,{runId:'run-removed-lease',sessionRef:binding.sessionRef});assert.equal(disposals,1);assert.equal(h.tools.has('browser_action'),false);
});

test('denial, changed lease, a mismatched interaction digest, and abort never allow a browser action',async()=>{
 const payload={tool:'browser_action',operation_id:'operation-1',call_id:'browser-call-1',request_hash:'a'.repeat(64),url:'https://fixture.example/',action:'read'};
 async function attempt({digest,observe,signal=new AbortController().signal}={}){
  const h=host(),trusted={...context(),allowed_tools:['universe_search','browser_action']},registrar={protocol:1,mount({agent}){return agent.ctx.tools.register({name:'browser_action',output:{render:()=>[]},execute:async()=>{}});}};
  const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',browserRegistrar:registrar,fetchImpl:async(url,init)=>{
   const body=JSON.parse(init.body);if(url.endsWith('/guard'))return Response.json({context:trusted});
   if(body.action==='request')return Response.json({interaction:{interaction_id:'int-browser-1',run_id:binding.runId,tool_call_id:body.call_id,purpose:'browser_action',version:1,status:'pending',action_digest:digest??browserDigest(binding,body.call_id,body.action_payload)}});
   return observe(body);
  }});
  await bridge.attach(h.agent,binding);
  const request={agent:h.agent,toolName:'browser_action',callId:'browser-call-1',reason:'Browser read',action_payload:payload,signal};
  return {run:()=>h.approve(request,async()=>{throw Error('unscoped_next_called');})};
 }
 const denied=await attempt({observe:()=>Response.json({state:'denied'})});assert.equal(await denied.run(),'rejected');
 const badDigest=await attempt({digest:'sha256:'+'f'.repeat(64),observe:()=>Response.json({state:'approved'})});await assert.rejects(badDigest.run(),/workbench_browser_approval_invalid/);
 const replacedLease=await attempt({observe:()=>new Response(JSON.stringify({error:{code:'WORKBENCH_EXECUTION_LEASE_REVOKED'}}),{status:409})});
 await assert.rejects(replacedLease.run(),/workbench_run_forbidden/);
 const controller=new AbortController(),aborted=await attempt({signal:controller.signal,observe:()=>{controller.abort(new Error('approval_cancelled'));return Response.json({state:'pending'});}});
 await assert.rejects(aborted.run(),/approval_cancelled/);
});

test('an authenticated dispatch cap is a recoverable task condition, not role revocation',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,binding);
 f.bridge.fetch=async url=>url.endsWith('/tool')?Response.json({error:{code:'TASK_COLLABORATION_EXHAUSTED'}},{status:429}):Response.json({context:context()});
 await assert.rejects(f.host.execute('jot_workspace',{operation:'tasks.delegate',arguments_json:JSON.stringify({subtask_id:'step',expected_subtask_version:1,recipient_agent_id:'member'})}),/^Error: task_collaboration_exhausted$/);
 await f.bridge.guard(f.host.agent);
 f.bridge.fetch=async()=>Response.json({error:{code:'TASK_COLLABORATION_EXHAUSTED'}},{status:403});
 await assert.rejects(f.host.execute('jot_workspace',{operation:'files.list',arguments_json:'{}'}),/^Error: workbench_run_forbidden$/);
});

test('assigned members receive their frozen assignment instead of instructions to edit the parent board',async()=>{
 const f=fixture();f.setContext({...context(),kind:'internal_mailbox',task_assignment:{subtask_id:'step',title:'检查来源',acceptance:'保存可核验来源',dependencies:[],lead_agent_id:'lead'}});
 await f.bridge.attach(f.host.agent,binding);
 const prompt=f.host.sections.get('jot:agent-role').text();
 assert.match(prompt,/检查来源/);assert.match(prompt,/保存可核验来源/);
 assert.match(prompt,/不得编辑父任务账本/);
 assert.doesNotMatch(prompt,/tasks.upsert 保存子任务/);
});

const browserDriverScope={run_id:binding.runId,owner_id:'owner-a',workspace_id:'workspace-a',session_id:binding.sessionRef,
 lease_owner:binding.executionLease.owner,lease_generation:binding.executionLease.generation};

test('browser driver bridge observes passively under the live run/session/lease without adding a browser tool',async()=>{
 const f=fixture();f.host.agent.id=binding.sessionRef;const calls=[];
 f.bridge.browserDriverObserverForAgent=agent=>agent===f.host.agent?{observeDriver:async request=>{
  calls.push(request);const scope=request.scopeForAgent(agent);await scope.assertCurrent(request.signal);
  return{protocol:1,scope:request.expected,status:'unknown',required:true,observed_at:new Date().toISOString(),
   reason:'driver_observation_unconfirmed',execution_authorized:false};
 }}:undefined;
 await f.bridge.attach(f.host.agent,binding);
 const value=await f.bridge.observeBrowserDriver(f.host.agent,browserDriverScope,new AbortController().signal);
 assert.equal(value.status,'unknown');assert.equal(value.execution_authorized,false);assert.equal(calls.length,1);
 assert.deepEqual(calls[0].expected,browserDriverScope);assert.equal(calls[0].scopeForAgent(f.host.agent).session_ref,binding.sessionRef);
 assert.equal(f.host.tools.has('browser_action'),false);assert.equal(f.host.modelTools().includes('browser_action'),false);
 const changed={...browserDriverScope,lease_generation:browserDriverScope.lease_generation+1};
 assert.equal((await f.bridge.observeBrowserDriver(f.host.agent,changed,new AbortController().signal)).status,'unknown');
 assert.equal(calls.length,1);
});

test('browser driver bridge reports exact-scope unknown when the Host has no passive observer',async()=>{
 const f=fixture();f.host.agent.id=binding.sessionRef;await f.bridge.attach(f.host.agent,binding);
 const value=await f.bridge.observeBrowserDriver(f.host.agent,browserDriverScope,new AbortController().signal);
 assert.equal(value.status,'unknown');assert.equal(value.execution_authorized,false);
 assert.deepEqual(value.scope,browserDriverScope);assert.equal(f.host.tools.has('browser_action'),false);
});

test('browser driver adapter route authenticates, validates the passive request and sanitizes responses',async()=>{
 const token='a'.repeat(32),agent={id:binding.sessionRef},calls=[];
 const bridge={observeBrowserDriver:async(target,scope,signal)=>{calls.push({target,scope,signal});return{
  protocol:1,scope,status:'unknown',required:true,observed_at:new Date().toISOString(),execution_authorized:false};}};
 const handler=createAdapterHandler({token,agents:{get:id=>id===agent.id?agent:undefined},workbenchBridge:bridge});
 const url=new URL(`http://127.0.0.1/v1/sessions/${binding.sessionRef}/browser-driver-observation`),body={protocol:1,scope:browserDriverScope};
 const invoke=(payload=body,auth=token,targetUrl=url)=>handler({method:'POST',url:targetUrl,headers:{authorization:`Bearer ${auth}`},body:payload});
 assert.equal((await invoke(body,'wrong')).status,401);
 assert.equal((await invoke({...body,extra:true})).status,422);
 assert.equal((await invoke({...body,scope:{...browserDriverScope,session_id:'other'}})).status,422);
 assert.equal((await invoke(body,token,new URL('http://127.0.0.1/v1/sessions/%ZZ/browser-driver-observation'))).status,422);
 const result=await invoke();assert.equal(result.status,200);assert.equal(result.value.status,'unknown');
 assert.equal(calls.length,1);assert.equal(calls[0].target,agent);assert.deepEqual(calls[0].scope,browserDriverScope);
 const absent=createAdapterHandler({token,agents:{get:()=>undefined},workbenchBridge:bridge});
 assert.equal((await absent({method:'POST',url,headers:{authorization:`Bearer ${token}`},body})).status,503);
 for(const invalid of [
  {protocol:1,scope:browserDriverScope,status:'ready',required:true,observed_at:new Date().toISOString(),execution_authorized:true},
  {protocol:1,scope:browserDriverScope,status:'ready',required:true,observed_at:'not-a-date',execution_authorized:false},
 ]){
  const rejecting=createAdapterHandler({token,agents:{get:()=>agent},workbenchBridge:{observeBrowserDriver:async()=>invalid}});
  const response=await rejecting({method:'POST',url,headers:{authorization:`Bearer ${token}`},body});
  assert.equal(response.status,409);assert.deepEqual(response.value,{error:'browser_driver_observation_unconfirmed'});
 }
});

test('task lifecycle proposals use the bound native Goal; model identity and ordinary chats cannot arm it',async()=>{
 const h=host();let trusted=context(),mapping=null,goal,proposals=0;
 h.agent.session={id:binding.sessionRef};h.agent.options={provider:'fixture',model:'bounded',maxTokens:20};
 h.agent.ctx.goals={get(){return goal&&structuredClone(goal);},
  create(_,{objective}){goal={id:'proposal-goal',revision:1,objective,phase:'active',activation:'armed',maxGoalRounds:3,roundsStarted:0,createdAt:1,updatedAt:1};return structuredClone(goal);},
  disarm(){if(goal)goal.activation='disarmed';return goal&&structuredClone(goal);},
  resume(_,ref){assert.deepEqual(ref,{id:goal.id,revision:goal.revision});goal={...goal,activation:'armed',revision:goal.revision+1};return structuredClone(goal);},
  pause(_,ref){assert.deepEqual(ref,{id:goal.id,revision:goal.revision});goal={...goal,phase:'paused',activation:'disarmed',revision:goal.revision+1};return structuredClone(goal);}};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',nativeContinuation:true,fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);
  if(url.endsWith('/goal-binding')){if(body.action==='save')mapping={goal_id:body.goal_id,goal_revision:body.goal_revision};return Response.json({binding:mapping});}
  if(url.endsWith('/step-admission'))return Response.json({context:trusted,admission:{protocol:1,allowed:true,route:{provider:body.route.provider,model:body.route.model,pricing_revision:'rates-v1',reserved:{tokens:'100',nano_usd:'1000',model_calls:'1'},queue_credit:{tokens:'0',nano_usd:'0',model_calls:'0'}}}});
  if(url.endsWith('/goal-proposal')){
   proposals++;assert.equal(body.goal_id,goal.id);assert.equal(body.goal_revision,goal.revision);
   assert.equal(body.run_id,binding.runId);assert.equal(body.session_ref,binding.sessionRef);
   if(body.intent==='continue')assert.deepEqual(body.route,{provider:'fixture',model:'bounded',max_tokens:20});
   return Response.json({context:trusted,proposal:{accepted:true,proposal_id:'proposal-1',intent:body.intent,action:body.intent==='continue'?'resume':'pause',goal_id:goal.id,goal_revision:goal.revision}});
  }
  assert.ok(url.endsWith('/guard'),'lifecycle proposals must not go through generic workspace operations');
  return Response.json({context:trusted});
 }});
 const execute=parameters=>h.execute('jot_workspace',{operation:'tasks.propose',arguments_json:JSON.stringify(parameters)});
 await bridge.attach(h.agent,binding);
 await assert.rejects(execute({intent:'continue',summary:'Continue'}),/checkpoint_task_required/);assert.equal(proposals,0);
 trusted={...context(),model_budget:{protocol:1,enforced:true},task_binding:{task_id:'task-a',occurrence_id:'occurrence-a',task_version:1,generation:1,title:'Task',objective:'Read sources'}};
 await bridge.attach(h.agent,binding);
 await assert.rejects(execute({intent:'continue',summary:'Continue',goal_id:'foreign'}),/workbench_arguments_invalid/);
 assert.equal(proposals,0);assert.equal(goal.activation,'disarmed');
 const continued=JSON.parse(await execute({intent:'continue',summary:'Continue collecting evidence'}));
 assert.deepEqual(continued,{accepted:true,proposal_id:'proposal-1',decision:'continue'});assert.equal(goal.activation,'armed');assert.equal(goal.roundsStarted,0);
 await bridge.guard(h.agent);assert.equal(goal.activation,'armed');
 const waiting=JSON.parse(await execute({intent:'wait_user',summary:'Which report format do you prefer?'}));
 assert.equal(waiting.decision,'waiting_user');assert.equal(goal.phase,'paused');assert.equal(goal.activation,'disarmed');assert.equal(proposals,2);
 assert.throws(()=>new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',nativeContinuation:'true'}),/workbench_bridge_config_invalid/);
});

test('native pre-step keeps ordinary Sessions and empty/rejected decisions intact; enforced tasks use the same scoped admission',async()=>{
 const h=host();let trusted=context(),mapping=null,goal,admissions=0,deny=false;
 h.agent.session={id:binding.sessionRef};h.agent.options={provider:'fixture',model:'bounded'};
 h.agent.ctx.goals={get(){return goal&&structuredClone(goal);},create(_,{objective}){goal={id:'step-goal',revision:1,objective,phase:'active',activation:'armed',maxGoalRounds:256,roundsStarted:0,createdAt:1,updatedAt:1};return structuredClone(goal);},
  disarm(){if(goal)goal.activation='disarmed';return goal&&structuredClone(goal);},pause(_,ref){assert.deepEqual(ref,{id:goal.id,revision:goal.revision});goal={...goal,phase:'paused',activation:'disarmed',revision:goal.revision+1};return structuredClone(goal);}};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);if(url.endsWith('/goal-binding')){if(body.action==='save')mapping={goal_id:body.goal_id,goal_revision:body.goal_revision};return Response.json({binding:mapping});}
  if(url.endsWith('/step-admission')){admissions++;assert.deepEqual(body.route,{provider:'fixture',model:'bounded'});
   if(deny)return Response.json({error:{code:'MODEL_BUDGET_EXHAUSTED'}},{status:429});
   return Response.json({context:trusted,admission:{protocol:1,allowed:true,route:{...body.route,pricing_revision:'rates-v1',reserved:{tokens:'100',nano_usd:'1000',model_calls:'1'},queue_credit:{tokens:'0',nano_usd:'0',model_calls:'0'}}}});
  }return Response.json({context:trusted});
 }});
 await bridge.attach(h.agent,binding);
 const payload={agent:h.agent,messages:[{id:'message-1',source:{kind:'user'},content:[{type:'text',text:'Continue'}]}],turn:1,step:1,signal:new AbortController().signal};
 const entered={kind:'enter',messages:payload.messages,startsRequestSeries:true};
 assert.equal(await h.preStep(payload,async()=>entered),entered);assert.equal(admissions,0);
 trusted={...context(),model_budget:{protocol:1,enforced:true},task_binding:{task_id:'task-a',occurrence_id:'occurrence-a',task_version:1,generation:1,title:'Task',objective:'Read sources'}};
 await bridge.attach(h.agent,binding);assert.equal(h.stepMiddleware.size,1);
 assert.equal(await h.preStep({...payload,agent:{ctx:h.agent.ctx}},async()=>entered),entered);assert.equal(admissions,0,'another Agent must not inherit the task guard');
 const rejected={kind:'reject'},empty={kind:'enter',messages:[]};
 assert.equal(await h.preStep({...payload,messages:[]},async()=>rejected),rejected);
 assert.equal(await h.preStep({...payload,messages:[]},async()=>empty),empty);assert.equal(admissions,0);
 assert.equal(await h.preStep(payload,async()=>entered),entered);assert.equal(admissions,2);
 let nextCalls=0;deny=true;
 assert.deepEqual(await h.preStep(payload,async()=>{nextCalls++;return entered;}),{kind:'reject'});
 assert.equal(nextCalls,0);assert.equal(goal.phase,'paused');assert.equal(goal.roundsStarted,0);
 await assert.rejects(h.execute('jot_workspace',{operation:'tasks.get',arguments_json:'{}'}),/WORKBENCH_GOAL_STOPPED/);
});

test('dependency denial reaches the model as a bounded repair reason without executing the tool or revoking ledger access',async()=>{
 const h=host();let denied=true,effects=0;
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);
  if(denied&&((url.endsWith('/guard')&&body.tool_name==='universe_search')||(url.endsWith('/tool')&&body.operation==='files.write')))
   return new Response(JSON.stringify({error:{code:'DEPENDENCY_NOT_COMPLETED',message:'sensitive internal details must stay hidden'}}),{status:409});
  if(url.endsWith('/tool')&&body.operation==='tasks.upsert')denied=false;
  return new Response(JSON.stringify(url.endsWith('/guard')?{context:context()}:{status:'blocked'}));
 }});
 await bridge.attach(h.agent,{...binding});
 await assert.rejects(h.execute('universe_search',{},async()=>{effects++;}),/^Error: dependency_not_completed$/);
 assert.equal(effects,0);
 await assert.rejects(h.execute('jot_workspace',{operation:'files.write',arguments_json:'{"path":"output.txt","content":"draft","expected_version":0}'}),/^Error: dependency_not_completed$/);
 assert.equal(JSON.parse(await h.execute('jot_workspace',{operation:'tasks.upsert',arguments_json:'{"status":"blocked","subtask_id":"step-a","expected_version":1}'})).status,'blocked');
 await h.execute('universe_search',{},async()=>{effects++;});assert.equal(effects,1);
});

test('only authenticated dependency conflict codes are surfaced; arbitrary errors and authority denials stay generic',async()=>{
 for(const [path,status,body,want] of [
  ['guard',409,{error:{code:'DEPENDENCY_EVIDENCE_UNVERIFIED'}},'dependency_evidence_unverified'],
  ['tool',409,{error:{code:'DEPENDENCY_CYCLE'}},'dependency_cycle'],
  ['guard',403,{error:{code:'DEPENDENCY_NOT_COMPLETED'}},'workbench_run_forbidden'],
  ['guard',409,{error:{code:'SECRET_VALUE'}},'workbench_run_forbidden'],
  ['guard',409,'not JSON','workbench_run_forbidden'],
  ['model-budget',409,{error:{code:'DEPENDENCY_NOT_COMPLETED'}},'workbench_run_forbidden'],
 ]){
  const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',fetchImpl:async()=>new Response(typeof body==='string'?body:JSON.stringify(body),{status})});
  await assert.rejects(bridge.request(path,binding),error=>error.message===want);
 }
});

test('discovery repair codes are bounded to tool or completion proposal conflicts and never expose details',async()=>{
 for(const [path,status,code,want] of [
  ['tool',409,'DISCOVERY_SOURCE_INTEGRITY_FAILED','discovery_source_integrity_failed'],
  ['tool',409,'DISCOVERY_SOURCE_UNAVAILABLE','discovery_source_unavailable'],
  ['tool',409,'DISCOVERY_REPORT_STEPS_INCOMPLETE','discovery_report_steps_incomplete'],
  ['goal-proposal',409,'DISCOVERY_REPORT_REQUIRED','discovery_report_required'],
  ['tool',403,'DISCOVERY_SOURCE_INTEGRITY_FAILED','workbench_run_forbidden'],
  ['guard',409,'DISCOVERY_SOURCE_INTEGRITY_FAILED','workbench_run_forbidden'],
  ['model-budget',409,'DISCOVERY_REPORT_REQUIRED','workbench_run_forbidden'],
  ['tool',409,'DISCOVERY_AUTHORITY_REVOKED','workbench_run_forbidden'],
  ['tool',409,'DISCOVERY_SOURCE_CHANGED','workbench_run_forbidden'],
  ['tool',409,'SECRET_VALUE','workbench_run_forbidden'],
 ]){
  const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',fetchImpl:async()=>new Response(JSON.stringify({error:{code,message:'Private file path and contents must never reach the model.'}}),{status})});
  await assert.rejects(bridge.request(path,binding),error=>error.message===want);
 }
});

test('budget-enforced scoped model streams reserve and settle before forwarding finish; ordinary roles retain their protocol',async()=>{
 const f=fixture();f.setContext({...context(),model_budget:{protocol:1,enforced:true}});await f.bridge.attach(f.host.agent,{...binding});
 assert.equal(f.host.modelMiddleware.size,1,'native llm/stream interceptor must be mounted once');
 let providers=0;const chunks=[{type:'text-delta',index:0,text:'Controlled answer'},{type:'usage',usage:{inputTokens:1,outputTokens:1,totalTokens:2}},{type:'finish',reason:'stop'}];
 const options=Object.freeze({provider:'fixture',model:'bounded',sessionId:'session-1',maxTokens:20,messages:Object.freeze([])});
 const native=()=>{providers++;return(async function*(){yield* chunks;})();};
 const received=[];for await(const c of f.host.stream(options,native)){if(c.type==='finish')assert.equal(f.requests.at(-1).body.action,'settle');received.push(c);}
 assert.deepEqual(received,chunks);assert.equal(providers,1);assert.equal(options.maxTokens,20);
 assert.deepEqual(f.requests.filter(x=>x.url.endsWith('/model-budget')).map(x=>x.body.action),['reserve','dispatch','settle']);
 await f.bridge.attach(f.host.agent,{...binding});assert.equal(f.host.modelMiddleware.size,1);
 f.setContext(context());const output=[];await assert.rejects((async()=>{for await(const c of f.host.stream(options,native))output.push(c);})(),/workbench_run_forbidden/);
 assert.equal(providers,1,'a trusted-context downgrade must not dispatch another provider');
 const g=fixture();await g.bridge.attach(g.host.agent,{...binding});const unbudgeted=[];for await(const c of g.host.stream(options,native))unbudgeted.push(c);
 assert.deepEqual(unbudgeted,chunks);assert.equal(g.requests.some(x=>x.url.endsWith('/model-budget')),false);
});

test('unknown budget protocols and malformed enforced flags cannot attach permissive model streams',async()=>{
 for(const budget of [{protocol:2,enforced:true},{protocol:1,enforced:'true'},{protocol:1,enforced:true,scope_id:'fake'},null]){
  const f=fixture();f.setContext({...context(),model_budget:budget});await assert.rejects(f.bridge.attach(f.host.agent,{...binding}),/workbench_context_invalid/);
  assert.equal(f.host.guards.size,0);assert.equal(f.host.modelMiddleware.size,0);
 }
});

test('global llm event routing leaves other Sessions untouched while accounting the exact attached Session',async()=>{
 const f=fixture();f.setContext({...context(),model_budget:{protocol:1,enforced:true}});await f.bridge.attach(f.host.agent,{...binding});
 const chunks=[{type:'usage',usage:{inputTokens:1,outputTokens:1,totalTokens:2}},{type:'finish',reason:{kind:'stop'}}];let providers=0;
 const native=()=>{providers++;return(async function*(){yield* chunks;})();};
 const output=[];for await(const c of f.host.stream({provider:'fixture',model:'bounded',sessionId:'another-session'},native))output.push(c);
 assert.deepEqual(output,chunks);assert.equal(providers,1);assert.equal(f.requests.some(x=>x.url.endsWith('/model-budget')),false);
 const own=[];for await(const c of f.host.stream({provider:'fixture',model:'bounded',sessionId:'session-1'},native))own.push(c);
 assert.deepEqual(own,chunks);assert.equal(providers,2);assert.equal(f.requests.filter(x=>x.url.endsWith('/model-budget')&&x.body.action==='settle').length,1);
});

test('combined role bridge mounts one native Goal per background occurrence and revokes on changed task identity',async()=>{
 const f=fixture();let goal,creates=0;
 const taskContext={...context(),task_binding:{task_id:'task-a',occurrence_id:'occurrence-a',task_version:1,generation:1,title:'Task',objective:'Read sources'}};
 f.setContext(taskContext);
 f.host.agent.ctx.goals={get(){return goal&&structuredClone(goal);},create(_agent,{objective}){creates++;goal={id:'goal-a',revision:1,objective,phase:'active',maxGoalRounds:256,roundsStarted:0,activation:'armed',createdAt:1,updatedAt:1};return structuredClone(goal);},disarm(){if(goal)goal.activation='disarmed';return goal&&structuredClone(goal);},pause(_agent,ref){assert.equal(ref.id,goal.id);goal={...goal,phase:'paused',revision:goal.revision+1};return structuredClone(goal);}};
 await f.bridge.attach(f.host.agent,{...binding});await f.bridge.attach(f.host.agent,{...binding});assert.equal(creates,1);assert.equal(goal.activation,'disarmed');
 await f.host.execute('jot_workspace',{operation:'tasks.get',arguments_json:'{}'});
 f.setContext({...taskContext,task_binding:{...taskContext.task_binding,generation:2}});
 await assert.rejects(f.host.execute('universe_search'),/workbench_goal_binding_changed/);
 assert.equal(goal.phase,'paused');
 await assert.rejects(f.host.execute('universe_search'),/WORKBENCH_GOAL_REVOKED/);
});
test('background attachment without native Goal service cannot enable any role tools',async()=>{
 const f=fixture();f.setContext({...context(),task_binding:{task_id:'task-a',occurrence_id:'occurrence-a',task_version:1,generation:1,title:'Task',objective:'Read sources'}});
 await assert.rejects(f.bridge.attach(f.host.agent,{...binding}),/workbench_goal_unavailable/);assert.equal(f.host.tools.size,0);
});

test('ordinary role chats cannot request a background task checkpoint',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,binding);
 await assert.rejects(f.bridge.checkpoint(f.host.agent,{afterSeq:2}),/checkpoint_task_required/);
});
test('task ledger operations stay bound to the trusted Gateway task and carry receipt identity',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,{...binding});
 await f.host.execute('jot_workspace',{operation:'tasks.get',arguments_json:'{}'});
 assert.equal(f.requests.at(-1).body.operation,'tasks.get');
 await f.host.execute('jot_workspace',{operation:'tasks.upsert',arguments_json:JSON.stringify({title:'Read controlled source',acceptance:'Source evidence'})});
 assert.equal(f.requests.at(-1).body.call_id,'call-1');
 assert.equal(f.requests.at(-1).body.run_id,'run-1');
 for(const operation of ['tasks.get','tasks.subtasks','tasks.evidence','tasks.upsert'])await assert.rejects(f.host.execute('jot_workspace',{operation,arguments_json:JSON.stringify({task_id:'victim'})}),/workbench_arguments_invalid/);
});
test('reply drafts use the existing workspace bridge and never accept model-selected targets or approvals',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,{...binding});const args={text:'Public update',evidence:[{kind:'tool_receipt',reference:'proof-test',hash:'a'.repeat(64)}]};await f.host.execute('jot_workspace',{operation:'tasks.reply_draft',arguments_json:JSON.stringify(args)});assert.equal(f.requests.at(-1).body.operation,'tasks.reply_draft');assert.deepEqual(f.requests.at(-1).body.arguments,args);assert.equal(f.requests.at(-1).body.run_id,binding.runId);
 await f.host.execute('jot_workspace',{operation:'tasks.reply_drafts',arguments_json:'{}'});
 for(const field of ['target','owner_id','policy','decision','approved'])await assert.rejects(f.host.execute('jot_workspace',{operation:'tasks.reply_draft',arguments_json:JSON.stringify({...args,[field]:'forged'})}),/workbench_arguments_invalid/);
});

test('public page reading goes through the authenticated safe Gateway rather than native browser dispatch', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, {...binding});
  const result = await f.host.execute('jot_workspace', {operation:'web.read',arguments_json:JSON.stringify({url:'https://example.org/article'})});
  assert.deepEqual(JSON.parse(result), {items:['real-gateway-response']});
  assert.equal(f.requests.at(-1).body.operation, 'web.read');
  assert.equal(f.requests.at(-1).body.run_id, binding.runId);
  assert.deepEqual(f.requests.at(-1).body.arguments, {url:'https://example.org/article'});
});

test('scoped host receives a frozen role prompt and denies all native filesystem/shell tools', async () => {
  const f = fixture();
  await f.bridge.attach(f.host.agent, { ...binding });
  const prompt = f.host.sections.get('jot:agent-role').text();
  assert.match(prompt, /Researcher/); assert.match(prompt, /Cite sources/); assert.match(prompt, /Unverified claim/);
  let effects = 0;
  for (const name of ['read_file', 'write_file', 'shell', 'bash', 'pwsh', 'read', 'write', 'edit', 'read_image', 'glob', 'grep', 'run_code', 'notebook_execute', 'exit_plan_mode', 'ask_user_question', 'web_fetch', 'web_search', 'todo_write', 'universe_execute', 'universe_file', 'universe_read_page', 'universe_research', 'universe_metric_query', 'universe_get_state', 'universe_cancel']) {
    await assert.rejects(f.host.execute(name, {}, async () => { effects++; }), /WORKBENCH_TOOL_FORBIDDEN/);
  }
  assert.equal(effects, 0);
  assert.equal(await f.host.execute('universe_search'), 'native-result');
  assert.equal(f.requests.at(-1).body.tool_name, 'universe_search');
});
test('Workbench schemas expose only frozen allowed global tools while retaining its scoped workspace tool',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,{...binding});
 const visible=f.host.modelTools();
 assert.deepEqual(visible,['universe_search','jot_workspace']);
 f.setContext(context('run-2',['universe_capabilities']));await f.bridge.attach(f.host.agent,{runId:'run-2',sessionRef:binding.sessionRef});
 assert.deepEqual(f.host.modelTools(),['universe_capabilities','jot_workspace']);
 f.setContext(context('run-3',[]));await f.bridge.attach(f.host.agent,{runId:'run-3',sessionRef:binding.sessionRef});
 assert.deepEqual(f.host.modelTools(),['jot_workspace']);
});
test('workspace tool dispatch uses Gateway result and frozen trusted run identity', async () => {
  const f = fixture(), mutable = { ...binding };
  await f.bridge.attach(f.host.agent, mutable);
  mutable.runId = 'run-victim'; mutable.sessionRef = 'session-victim';
  const output = await f.host.execute('jot_workspace', { operation: 'files.read', arguments_json: JSON.stringify({ path: 'notes/a.txt' }) });
  assert.deepEqual(JSON.parse(output), { items: ['real-gateway-response'] });
  assert.deepEqual(f.requests.at(-1).body, { operation: 'files.read', arguments: { path: 'notes/a.txt' }, call_id: 'call-1', run_id: 'run-1', session_ref: 'session-1',execution_lease:binding.executionLease });
  assert.equal(f.requests.at(-1).init.redirect, 'error');
  assert.ok(f.requests.at(-1).init.signal instanceof AbortSignal);
});
test('workspace arguments cannot forge identity or create new automatic processing authorization', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding });
  for (const injected of [{ owner_id: 'victim' }, { run_id: 'victim' }, { session_ref: 'victim' }, { agent_id: 'victim' }, { sender_agent_id: 'victim' }, { auto_reply: true }]) {
    const calls = f.requests.length;
    await assert.rejects(f.host.execute('jot_workspace', { operation: 'messages.send', arguments_json: JSON.stringify({ recipient_agent_id: 'agent-b', text: 'hello', client_message_id: 'hello', ...injected }) }), /workbench_arguments_invalid/);
    assert.equal(f.requests.length, calls + 1); // The monotonic pre-dispatch guard runs, but no tool request is sent.
  }
});
test('revoked memory is removed from future role prompts and a delayed guard cannot reintroduce it', async () => {
  const f=fixture();await f.bridge.attach(f.host.agent,{...binding});
  assert.match(f.host.sections.get('jot:agent-role').text(),/Unverified claim/);
  f.setContext({...context(),memories:[]});await f.bridge.guard(f.host.agent);
  assert.doesNotMatch(f.host.sections.get('jot:agent-role').text(),/Unverified claim/);
  f.setContext(context());await f.bridge.guard(f.host.agent);
  assert.doesNotMatch(f.host.sections.get('jot:agent-role').text(),/Unverified claim/);
  assert.match(f.host.sections.get('jot:agent-role').text(),/Cite sources/);
});

test('memory provenance and search query reach Gateway without permitting verification or expiry bypass', async () => {
  const f=fixture();await f.bridge.attach(f.host.agent,{...binding});
  await f.host.execute('jot_workspace',{operation:'memory.save',arguments_json:JSON.stringify({scope:'private',content:'Sourced proposal',provenance:[{kind:'web',reference:'https://example.com/source'}],source_revision:'fixture-v1',expires_at:'2099-01-01T00:00:00Z'})});
  assert.equal(f.requests.at(-1).body.operation,'memory.save');assert.equal(f.requests.at(-1).body.arguments.source_revision,'fixture-v1');
  await f.host.execute('jot_workspace',{operation:'memory.list',arguments_json:JSON.stringify({q:'controlled source'})});
  assert.deepEqual(f.requests.at(-1).body.arguments,{q:'controlled source'});
  for(const [operation,args] of [['memory.save',{scope:'private',content:'Forged',verified:true}],['memory.list',{include_expired:true}],['memory.list',{scope:'private',agent_id:'another-agent'}]]){
    await assert.rejects(f.host.execute('jot_workspace',{operation,arguments_json:JSON.stringify(args)}),/workbench_arguments_invalid/);
  }
});

test('actual prompt assembly sends a redacted delivery receipt before model dispatch',async()=>{
 const sourceRetrievalId='retrieval-source-123456789',memories=[{memory_id:'memory-a',version:7,content:'Sensitive memory body',verified:false}],contextValue={...context(),memory_retrieval_id:sourceRetrievalId,memories},requests=[];
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',fetchImpl:async(url,init)=>{
  const path=new URL(url).pathname,body=JSON.parse(init.body);requests.push({path,body});
  if(path.endsWith('/guard'))return Response.json({context:contextValue});
  if(path.endsWith('/context-delivery'))return Response.json({receipt:{retrieval_id:'retrieval-receipt',status:'delivered_to_session',source_retrieval_id:body.memory_retrieval_id,context_hash:body.context_hash,reference_count:body.references.length}});
  throw new Error('unexpected_workbench_request');
 }}),h=host();let dispatched=false;
 await bridge.attach(h.agent,binding);
 const prompt=h.sections.get('jot:agent-role').text();assert.match(prompt,/Sensitive memory body/);
 assert.equal(requests.some(request=>request.path.endsWith('/context-delivery')),false,'lazy assembly queues metadata; persistence is awaited at the stream boundary');
 const result=await h.stream({sessionId:binding.sessionRef},async()=>{assert.ok(requests.some(value=>value.path.endsWith('/context-delivery')));dispatched=true;return 'provider-dispatch';});
 assert.equal(result,'provider-dispatch');assert.equal(dispatched,true);
 const request=requests.find(value=>value.path.endsWith('/context-delivery'));
 assert.deepEqual(request.body,{memory_retrieval_id:sourceRetrievalId,context_hash:createHash('sha256').update(JSON.stringify(memories)).digest('hex'),references:[{memory_id:'memory-a',version:7}],run_id:binding.runId,session_ref:binding.sessionRef,execution_lease:binding.executionLease});
 assert.doesNotMatch(JSON.stringify(request.body),/Sensitive memory body/);
});

test('an invalid context delivery receipt blocks model dispatch',async()=>{
 const sourceRetrievalId='retrieval-source-123456789',memories=[{memory_id:'memory-a',version:7,content:'Sensitive memory body',verified:false}],contextValue={...context(),memory_retrieval_id:sourceRetrievalId,memories};let dispatched=false;
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',fetchImpl:async(url,init)=>{
  const path=new URL(url).pathname,body=JSON.parse(init.body);
  if(path.endsWith('/guard'))return Response.json({context:contextValue});
  if(path.endsWith('/context-delivery'))return Response.json({receipt:{retrieval_id:'retrieval-receipt',status:'delivered_to_session',source_retrieval_id:body.memory_retrieval_id,context_hash:'0'.repeat(64),reference_count:body.references.length}});
  throw new Error('unexpected_workbench_request');
 }}),h=host();
 await bridge.attach(h.agent,binding);h.sections.get('jot:agent-role').text();
 await assert.rejects(h.stream({sessionId:binding.sessionRef},async()=>{dispatched=true;}),/workbench_context_delivery_unconfirmed/);
 assert.equal(dispatched,false);
});

test('network errors and revoked epochs prevent the native executor from running', async () => {
  for (const fail of ['rejectNetwork', 'rejectEpoch']) {
    const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding }); f[fail]();
    let effects = 0;
    await assert.rejects(f.host.execute('universe_search', {}, async () => { effects++; return 'must not happen'; }));
    assert.equal(effects, 0);
  }
});
test('direct workspace execution also fails closed if Gateway rejects the tool request', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding }); f.rejectEpoch();
  await assert.rejects(f.host.tools.get('jot_workspace').execute({ operation: 'files.list', arguments_json: '{}' }, { callId: 'call-1', signal: new AbortController().signal }), /workbench_run_forbidden/);
});
test('reattachment keeps the existing host registration even if new registrations would fail', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding });
  f.host.failRegistration(); f.setContext(context('run-2'));
  try { await f.bridge.attach(f.host.agent, { runId: 'run-2', sessionRef: 'session-1' }); } catch {}
  assert.equal(f.host.guards.size, 1); assert.equal(f.host.middleware.size, 1); assert.equal(f.host.tools.size, 1);
  assert.match(f.host.sections.get('jot:agent-role').text(), /Cite sources/);
  await assert.rejects(f.host.execute('shell'), /WORKBENCH_TOOL_FORBIDDEN/);
});
test('failed trusted context validation preserves the old prompt, binding and denial guards', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding });
  f.setContext({ ...context('run-2'), allowed_tools: ['shell'] });
  await assert.rejects(f.bridge.attach(f.host.agent, { runId: 'run-2', sessionRef: 'session-1' }), /workbench_context_invalid/);
  assert.equal(f.host.guards.size, 1); assert.equal(f.host.middleware.size, 1); assert.equal(f.host.tools.size, 1);
  assert.match(f.host.sections.get('jot:agent-role').text(), /Cite sources/);
  await assert.rejects(f.host.execute('shell'), /WORKBENCH_TOOL_FORBIDDEN/);
  f.setContext(context()); await f.bridge.guard(f.host.agent);
  assert.equal(f.requests.at(-1).body.run_id, 'run-1');
});
test('reattachment changes the trusted binding without duplicate host registrations', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding });
  f.setContext({ ...context('run-2', []), name: 'Editor', instructions: 'Review only' });
  await f.bridge.attach(f.host.agent, { runId: 'run-2', sessionRef: 'session-1' });
  assert.equal(f.host.guards.size, 1); assert.equal(f.host.middleware.size, 1); assert.equal(f.host.tools.size, 1);
  assert.match(f.host.sections.get('jot:agent-role').text(), /Editor/);
  await assert.rejects(f.host.execute('universe_search'), /WORKBENCH_TOOL_FORBIDDEN/);
  await f.host.execute('jot_workspace', { operation: 'files.list', arguments_json: '{}' });
  assert.equal(f.requests.at(-1).body.run_id, 'run-2');
});
test('malformed or identity mismatched trusted context never installs host permissions', async () => {
  for (const bad of [context('run-other'), { ...context(), allowed_tools: ['shell'] }, { ...context(), allowed_tools: [42] }, { ...context(), capability_epoch: -1 }, { ...context(), owner_id: '' }]) {
    const f = fixture(); f.setContext(bad);
    await assert.rejects(f.bridge.attach(f.host.agent, { ...binding }), /workbench_context_invalid/);
    assert.equal(f.host.guards.size, 0);
  }
});
test('prompt guard checks the attached run again and fails closed after epoch revocation', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding });
  await f.bridge.guard(f.host.agent);
  assert.equal(f.requests.at(-1).body.run_id, 'run-1');
  f.rejectEpoch(); await assert.rejects(f.bridge.guard(f.host.agent), /workbench_run_forbidden/);
  await assert.rejects(f.bridge.guard(host().agent), /workbench_binding_missing/);
});
test('successful HTTP guard with changed capability epoch still prevents native execution', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding });
  f.setContext({ ...context(), capability_epoch: 2 });
  let effects = 0;
  await assert.rejects(f.host.execute('universe_search', {}, async () => { effects++; }), /workbench_run_forbidden/);
  assert.equal(effects, 0);
});
test('aborted execution and malformed arguments send no workspace tool request', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding });
  const controller = new AbortController(); controller.abort();
  const calls = f.requests.length;
  await assert.rejects(f.host.execute('universe_search', {}, async () => 'bad', controller.signal));
  assert.equal(f.requests.length, calls);
  for (const args of [{ operation: 'files.read', arguments_json: '{' }, { operation: 'files.read', arguments_json: '[]' },
    { operation: 'files.read', arguments_json: 'null' }, { operation: 'not-supported', arguments_json: '{}' },
    { operation: 'files.read', arguments_json: '{}', run_id: 'victim' }]) {
    const prior = f.requests.length;
    await assert.rejects(f.host.execute('jot_workspace', args), /workbench_arguments_invalid/);
    assert.equal(f.requests.length, prior + 1);
  }
});
test('overlapping attaches cannot let an older response replace a newer run binding', async () => {
  const h = host(); const pending = new Map(), requests = [];
  const bridge = new WorkbenchBridge({ origin: 'http://127.0.0.1:7654', token: 'test-token-32-characters-fixture',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      return new Promise(resolve => pending.set(body.run_id, resolve));
    } });
  const older = bridge.attach(h.agent, { runId: 'run-old', sessionRef: 'session-1' });
  const newer = bridge.attach(h.agent, { runId: 'run-new', sessionRef: 'session-1' });
  pending.get('run-new')(new Response(JSON.stringify({ context: context('run-new') })));
  await newer;
  pending.get('run-old')(new Response(JSON.stringify({ context: context('run-old') })));
  await assert.rejects(older, /workbench_attach_superseded/);
  const checked = bridge.guard(h.agent);
  assert.equal(requests.at(-1).run_id, 'run-new');
  pending.get('run-new')(new Response(JSON.stringify({ context: context('run-new') })));
  await checked;
});
test('changing an attached binding during a native guard cannot execute the old call', async () => {
  const h = host(); let wait = null;
  const bridge = new WorkbenchBridge({ origin: 'http://127.0.0.1:7654', token: 'test-token-32-characters-fixture',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.tool_name) return new Promise(resolve => { wait = resolve; });
      return new Response(JSON.stringify({ context: context(body.run_id) }));
    } });
  await bridge.attach(h.agent, { ...binding });
  let effects = 0;
  const execution = h.execute('universe_search', {}, async () => { effects++; });
  await bridge.attach(h.agent, { runId: 'run-2', sessionRef: 'session-1' });
  wait(new Response(JSON.stringify({ context: context('run-1') })));
  await assert.rejects(execution, /workbench_binding_changed/);
  assert.equal(effects, 0);
});
test('scoped workspace forwards an occurrence only for read-only task history, never for task mutation',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,{...binding});
 await f.host.execute('jot_workspace',{operation:'tasks.subtasks',arguments_json:'{"occurrence_id":"occurrence-old"}'});
 assert.deepEqual(f.requests.at(-1).body,{run_id:'run-1',session_ref:'session-1',operation:'tasks.subtasks',arguments:{occurrence_id:'occurrence-old'},call_id:'call-1',execution_lease:binding.executionLease});
 const before=f.requests.filter(request=>request.url.endsWith('/tool')).length;
 await assert.rejects(f.host.execute('jot_workspace',{operation:'tasks.upsert',arguments_json:'{"occurrence_id":"occurrence-old","status":"running"}'}),/workbench_arguments_invalid/);
 assert.equal(f.requests.filter(request=>request.url.endsWith('/tool')).length,before);
});

test('model memory writes cannot claim owner verification', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, { ...binding });
  const before = f.requests.length;
  await assert.rejects(f.host.execute('jot_workspace', { operation: 'memory.save', arguments_json: JSON.stringify({ scope: 'project', content: 'model claim', verified: true }) }), /workbench_arguments_invalid/);
  assert.equal(f.requests.length, before + 1);
});
test('role selects native presentation in its own scope so the model can see the internal workspace tool', async () => {
  const f = fixture(), unrelated = host();
  await f.bridge.attach(f.host.agent, { ...binding });
  assert.ok(f.host.modelTools().includes('jot_workspace'));
  assert.ok(f.host.modelTools().includes('universe_search'));
  assert.ok(!f.host.modelTools().includes('run_code'));
  assert.deepEqual(unrelated.modelTools(), ['run_code']);
});
test('missing or conflicting native presentation support fails closed before a role starts', async () => {
  for (const missing of [true, false]) {
    const f = fixture();
    if (missing) delete f.host.agent.ctx.tools.presentAs;
    else f.host.agent.ctx.tools.presentAs('code');
    await assert.rejects(f.bridge.attach(f.host.agent, { ...binding }), missing ? /workbench_host_incompatible/ : /presentation_conflict/);
    assert.equal(f.host.tools.size, 0);
    await assert.rejects(f.bridge.guard(f.host.agent), /workbench_binding_missing/);
  }
});
test('existing scoped native registrations cannot execute their filesystem side effects under the role guard', async () => {
  const f = fixture(); let writes = 0;
  f.host.agent.ctx.tools.register({ name: 'write_file', parameters: { type: 'object' },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { writes++; return 'wrote outside workspace'; } });
  await f.bridge.attach(f.host.agent, { ...binding });
  await assert.rejects(f.host.execute('write_file', { path: '/etc/outside' }), /WORKBENCH_TOOL_FORBIDDEN/);
  assert.equal(writes, 0);
});
test('role allowlist never overrides an existing scoped permission denial', async () => {
  const f = fixture(); let calls = 0;
  f.host.agent.ctx.tools.guard(exec => exec.name === 'universe_search' ? 'HOST_PERMISSION_DENIED' : undefined);
  await f.bridge.attach(f.host.agent, { ...binding });
  await assert.rejects(f.host.execute('universe_search', {}, async () => { calls++; }), /HOST_PERMISSION_DENIED/);
  assert.equal(calls, 0);
});


test('Workbench RPC retains the original deep-frozen Worker fence instead of caller mutations',async()=>{
 const h=host(),sent=[];const lease={owner:'worker-1',generation:3};const scoped={...binding,executionLease:lease};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',fetchImpl:async(url,init)=>{sent.push(JSON.parse(init.body));return Response.json({context:context()})}});
 await bridge.attach(h.agent,scoped);lease.generation=4;await bridge.check(bridge.installed.get(h.agent).current);
 assert.ok(sent.length>=2);for(const request of sent)assert.deepEqual(request.execution_lease,{owner:'worker-1',generation:3});
 assert.ok(Object.isFrozen(bridge.installed.get(h.agent).current.binding.executionLease));
});

test('a budget-enforced role cannot attach fresh execution without its Worker fence',async()=>{
 const h=host();const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',fetchImpl:async()=>Response.json({context:{...context(),model_budget:{protocol:1,enforced:true}}})});await assert.rejects(bridge.attach(h.agent,{runId:binding.runId,sessionRef:binding.sessionRef}),/workbench_binding_lease_required/);assert.equal(h.tools.size,0);
});

test('step admission reads official effective Session selection instead of stale Agent options',()=>{
 let selected={provider:'budget-fixture',model:'pinned-fixture'};const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',modelRouteFor:()=>selected});
 const agent={options:{provider:'ordinary-fixture',model:'ordinary',maxTokens:20}};
 assert.deepEqual(bridge.effectiveModelRoute(agent),{provider:'budget-fixture',model:'pinned-fixture',max_tokens:20});selected={provider:'budget-fixture',model:'next-pinned'};assert.equal(bridge.effectiveModelRoute(agent).model,'next-pinned');
 selected={};assert.throws(()=>bridge.effectiveModelRoute(agent),/workbench_model_host_incompatible/);
 assert.throws(()=>new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'test-token-32-characters-fixture',modelRouteFor:1}),/workbench_bridge_config_invalid/);
});

// The same model-visible tool must choose exactly one host-authorized dispatcher.
test('native delegate callback replaces the legacy tool request and failure never falls back',async()=>{
 const h=host(),requests=[];let fail=false,called=0;
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'a'.repeat(32),nativeDelegate:async(agent,exact,callId,args)=>{
  assert.equal(agent,h.agent);assert.equal(exact,bridge.bindingFor(h.agent));assert.equal(callId,'call-1');assert.equal(args.subtask_id,'step');called++;
  if(fail)throw Error('native_publication_pending');return {runtime:'native_team',member:{id:'child'}};
 },fetchImpl:async(url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({context:{...context(),kind:'task',task_binding:{task_id:'task',occurrence_id:'occurrence',root_run_id:'run-1',task_version:1,generation:1,title:'Task',objective:'Inspect sources'}}}),{status:200});}});
 // Routing-only fixture; Goal behavior is covered by the native lifecycle tests above.
 bridge.goals.attach=async()=>{};bridge.goals.guard=async()=>{};
 await bridge.attach(h.agent,binding);
 const args={operation:'tasks.delegate',arguments_json:JSON.stringify({subtask_id:'step',expected_subtask_version:1,recipient_agent_id:'member'})};
 assert.equal(JSON.parse(await h.execute('jot_workspace',args)).runtime,'native_team');
 fail=true;await assert.rejects(h.execute('jot_workspace',args),/native_publication_pending/);
 assert.equal(called,2);assert.equal(requests.some(r=>r.operation==='tasks.delegate'),false);
});
test('native task dispatcher cannot be invoked by a child or ordinary role conversation',async()=>{
 const h=host();let calls=0;
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token:'a'.repeat(32),nativeDelegate:async()=>{calls++;},fetchImpl:async()=>new Response(JSON.stringify({context:{...context(),kind:'native_team',task_assignment:{subtask_id:'step'}}}),{status:200})});
 await bridge.attach(h.agent,binding);
 await assert.rejects(h.execute('jot_workspace',{operation:'tasks.delegate',arguments_json:JSON.stringify({subtask_id:'step',expected_subtask_version:1,recipient_agent_id:'member'})}),/workbench_task_scope_forbidden/);
 assert.equal(calls,0);
});

test('native member boundaries recheck a host-owned parent guard before tools and model dispatch',async()=>{
 const f=fixture();f.setContext({...context(),kind:'native_team',model_budget:{protocol:1,enforced:true}});let paused=false,parentChecks=0;
 await f.bridge.attach(f.host.agent,binding,{parentGuard:async()=>{parentChecks++;if(paused)throw Error('parent_goal_paused');}});
 paused=true;
 await assert.rejects(f.host.execute('jot_workspace',{operation:'files.write',arguments_json:'{"path":"notes.txt","content":"No write after pause","expected_version":0}'}),/parent_goal_paused/);
 let invoked=0;const consume=async()=>{for await(const _ of f.host.stream({sessionId:binding.sessionRef,provider:'fixture',model:'bounded'},()=>{invoked++;return(async function*(){yield {type:'finish',reason:{kind:'stop'}};})()})){};};
 await assert.rejects(consume(),/parent_goal_paused/);
 assert.ok(parentChecks>=2);assert.equal(invoked,0);
 assert.equal(f.requests.some(r=>r.body.operation==='files.write'||r.url.endsWith('/model-budget')),false);
});

test('reattachment cannot drop a native parent guard and pause during gateway reads still denies effects',async()=>{
 const f=fixture();let paused=false;
 await f.bridge.attach(f.host.agent,binding,{parentGuard:async()=>{if(paused)throw Error('parent_paused');}});
 await f.bridge.attach(f.host.agent,binding);
 await assert.rejects(f.bridge.attach(f.host.agent,binding,{parentGuard:null}),/workbench_parent_guard_invalid/);
 const original=f.bridge.fetch;f.bridge.fetch=async(...args)=>{const response=await original(...args);paused=true;return response;};
 await assert.rejects(f.host.execute('jot_workspace',{operation:'files.write',arguments_json:'{"path":"denied.txt","content":"none","expected_version":0}'}),/parent_paused/);
 assert.equal(f.requests.some(r=>r.body.operation==='files.write'),false);
});

test('only enabled native delegation declares SDK concurrency safety; workspace writes remain exclusive',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,binding);
 const tool=f.host.tools.get('jot_workspace');
 assert.equal(typeof tool.isConcurrencySafe,'function');
 const delegate={operation:'tasks.delegate',arguments_json:'{"subtask_id":"step","expected_subtask_version":1,"recipient_agent_id":"role"}'};
 assert.equal(tool.isConcurrencySafe(delegate),false);
 f.bridge.nativeDelegate=async()=>{};
 assert.equal(tool.isConcurrencySafe(delegate),true);
 for(const operation of ['files.write','memory.save','messages.send','tasks.upsert','tasks.propose'])assert.equal(tool.isConcurrencySafe({operation,arguments_json:'{}'}),false);
 assert.equal(tool.isConcurrencySafe(null),false);
});

test('the installed native workspace tool exposes staged memory proposals without apply or identity arguments',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,binding);
 for(const [operation,args] of [['memory.stage',{scope:'private',memory_ids:['memory-a']}],['memory.propose',{consolidation_id:'consolidation-a',expected_version:1,summary:'Combine repeated findings',changes:[]}],['memory.consolidation',{consolidation_id:'consolidation-a'}]]){
  await f.host.execute('jot_workspace',{operation,arguments_json:JSON.stringify(args)});assert.equal(f.requests.at(-1).body.operation,operation);assert.deepEqual(f.requests.at(-1).body.arguments,args);
 }
 for(const operation of ['memory.apply','memory.rollback'])await assert.rejects(f.host.execute('jot_workspace',{operation,arguments_json:'{}'}),/workbench_arguments_invalid/);
 for(const key of ['owner_id','project_id','agent_id','run_id'])await assert.rejects(f.host.execute('jot_workspace',{operation:'memory.stage',arguments_json:JSON.stringify({scope:'private',memory_ids:['memory-a'],[key]:'forged'})}),/workbench_arguments_invalid/);
});

test('capture tools expose only pending source reads and grounded proposals',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,binding);
 for(const [operation,args] of [['memory.capture.pending',{}],['memory.capture.read',{capture_id:'capture-a'}],['memory.capture.propose',{capture_id:'capture-a',expected_version:2,summary:'Preference',notes:[{content:'Concise answers',source_ids:['source-a']}]}]]){
  await f.host.execute('jot_workspace',{operation,arguments_json:JSON.stringify(args)});assert.equal(f.requests.at(-1).body.operation,operation);assert.deepEqual(f.requests.at(-1).body.arguments,args);
 }
 for(const operation of ['memory.capture.apply','memory.capture.policy'])await assert.rejects(f.host.execute('jot_workspace',{operation,arguments_json:'{}'}),/workbench_arguments_invalid/);
 for(const key of ['owner_id','project_id','agent_id','verified'])await assert.rejects(f.host.execute('jot_workspace',{operation:'memory.capture.read',arguments_json:JSON.stringify({capture_id:'capture-a',[key]:'forged'})}),/workbench_arguments_invalid/);
 assert.equal(f.host.tools.get('jot_workspace').isConcurrencySafe({operation:'memory.capture.propose',arguments_json:'{}'}),false);
});

test('discovery planning operations reuse the original tool and refuse caller identity fields',async()=>{
 const f=fixture();await f.bridge.attach(f.host.agent,binding);
 for(const [operation,args] of [['discovery.context',{}],['discovery.source',{revision:1,offset:0}],['discovery.plan',{summary:'Proposal',rationale:'Observed source',changes:[],evidence:[]}],['discovery.report',{outcome:'no_plan',summary:'Nothing supported',limitations:[],plan_ids:[],evidence:[]}]]){
  await f.host.execute('jot_workspace',{operation,arguments_json:JSON.stringify(args)});assert.equal(f.requests.at(-1).body.operation,operation);assert.deepEqual(f.requests.at(-1).body.arguments,args);
 }
 for(const key of ['owner_id','project_id','run_id','accepted'])await assert.rejects(f.host.execute('jot_workspace',{operation:'discovery.context',arguments_json:JSON.stringify({[key]:'forged'})}),/workbench_arguments_invalid/);
 for(const operation of ['discovery.apply','discovery.accept'])await assert.rejects(f.host.execute('jot_workspace',{operation,arguments_json:'{}'}),/workbench_arguments_invalid/);
});

test('DSH browser tool approval traverses the trusted bridge and Gateway before its original receipt',async t=>{
 const root=mkdtempSync(join(browserIntegrationBase,'case-')),gatewayOrigin='https://browser-bridge.fixture.invalid',csrf='browser-bridge-csrf-fixture',owner='browser-bridge-owner';
 const templateRoot=resolve(fileURLToPath(new URL('../../gateway/file-engine/templates/',import.meta.url))),token=randomBytes(32).toString('hex');
 let service,pluginContext,pluginCleanup,localDb;const h=host(),sessionRef=h.agent.id;
 const anchor=join(root,'runtime','package.json'),moduleRoot=join(root,'runtime','node_modules','@deepseek-ai','dsh-tools');
 mkdirSync(moduleRoot,{recursive:true});writeFileSync(anchor,JSON.stringify({type:'module'}));
 writeFileSync(join(moduleRoot,'package.json'),JSON.stringify({name:'@deepseek-ai/dsh-tools',type:'module',exports:'./index.mjs'}));
 writeFileSync(join(moduleRoot,'index.mjs'),'export function defineTool(value){return value;}\n');
 let navigations=0,factoryCalls=0;
 const currentUrl={value:'about:blank'},page={url:()=>currentUrl.value,async goto(url){navigations++;currentUrl.value=url;},async evaluate(_fn,arg){if(arg!==undefined)return;return{url:currentUrl.value,title:'Bridge fixture',text:'Gateway approved browser read',controls:[]};}};
 let connected=true,onContextClose;const browser={isConnected:()=>connected};
 const persistentContext={browser:()=>browser,on(event,handler){if(event==='close')onContextClose=handler;},async close(){connected=false;onContextClose?.();},async route(){},pages:()=>[],async newPage(){return page;}};
 let resolveRequested;const requested=new Promise(resolveRequest=>{resolveRequested=resolveRequest;});
 const cleanup=async()=>{
  if(pluginCleanup)await pluginCleanup();
  if(service){await service.app.close();service.db.close();}
  if(localDb)localDb.close();
  const child=relative(browserIntegrationBase,resolve(root));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));
  rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});
 };
 t.after(cleanup);
 service=await buildServer({databasePath:':memory:',workspaces:['main'],workbenchRoot:join(root,'shared'),uploadRoot:join(root,'uploads'),templateRoot,
  internalChannelToken:token,csrfToken:csrf,allowedOrigins:[gatewayOrigin]});
 const gatewayAgent=service.workbench.createAgent(owner,{name:'Browser bridge fixture',instructions:'Use a browser action only after owner approval.',allowed_tools:['browser_action']});
 const admitted=await service.app.inject({method:'POST',url:`/v1/conversations/${gatewayAgent.conversation_id}/messages`,headers:{'x-user-id':owner,origin:gatewayOrigin,'x-csrf-token':csrf,'idempotency-key':'browser-bridge-input'},payload:{client_message_id:'browser-bridge-input',content:[{type:'text',text:'Read the approved fixture page.'}]}});
 assert.equal(admitted.statusCode,202,admitted.body);
 const runId=String(service.db.prepare('SELECT id FROM ga_runs WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1').get(gatewayAgent.conversation_id).id);
 service.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(runId);
 const lease=Object.freeze({owner:'browser-bridge-worker',generation:1}),now=new Date().toISOString();
 service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(gatewayAgent.conversation_id,owner,sessionRef,now,now);
 service.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(runId,lease.owner,lease.generation,String(Date.now()+60000),now);
 const fetchImpl=async(url,init)=>{
  const target=new URL(url),body=JSON.parse(init.body),response=await service.app.inject({method:init.method??'POST',url:target.pathname+target.search,
   headers:Object.fromEntries(new Headers(init.headers)),payload:init.body});
  if(target.pathname.endsWith('/browser-approval')&&body.action==='request')resolveRequested({statusCode:response.statusCode,body:response.body,interaction:response.statusCode===200?response.json().interaction:undefined});
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 };
 const services=new Map([['profileContext',{installAnchor:anchor}]]),effects=[];
 pluginContext={get:name=>services.get(name),provide:(name,value)=>services.set(name,value),effect:callback=>effects.push(callback()),approval:{request:request=>h.approve(request)},
  agentPresets:{serviceFor(agent,name){assert.equal(agent,h.agent);assert.equal(name,'jotBrowserToolRegistrar');return services.get(name);}}};
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token,browserRegistrarForAgent:agent=>pluginContext.agentPresets.serviceFor(agent,'jotBrowserToolRegistrar'),fetchImpl});
 const plugin=createBrowserToolsPlugin({browserFactory:async()=>{factoryCalls++;return{persistentContext};}});
 await plugin.apply(pluginContext,{dataRoot:join(root,'browser-data'),profileRoot:join(root,'browser-profiles'),ownerId:'ignored-static-owner',origins:['https://browser-bridge.fixture.invalid']});
 pluginCleanup=effects[0];
 await bridge.attach(h.agent,{runId,sessionRef,executionLease:lease});
 const observationScope={run_id:runId,owner_id:owner,workspace_id:gatewayAgent.workspace_id,session_id:sessionRef,lease_owner:lease.owner,lease_generation:lease.generation};
 assert.equal((await bridge.observeBrowserDriver(h.agent,observationScope,new AbortController().signal)).status,'unknown');
 assert.equal(factoryCalls,0);assert.equal(navigations,0);
 assert.ok(h.tools.has('browser_action'));assert.ok(h.modelTools().includes('browser_action'));
 const tool=h.tools.get('browser_action'),callId='browser-bridge-call',resultPromise=tool.execute({url:'https://browser-bridge.fixture.invalid/',action:'read'},
  {agent:h.agent,callId,rootCallId:'browser-bridge-root',signal:new AbortController().signal});
 const request=await requested;assert.equal(request.statusCode,200,request.body);
 const card=request.interaction;assert.equal(card.purpose,'browser_action');assert.equal(card.run_id,runId);assert.equal(card.tool_call_id,callId);assert.equal(card.status,'pending');
 const decision=await service.app.inject({method:'POST',url:`/v1/interactions/${card.interaction_id}/decision`,headers:{'x-user-id':owner,origin:gatewayOrigin,'x-csrf-token':csrf,'idempotency-key':'browser-bridge-decision'},
  payload:{expected_version:card.version,action_digest:card.action_digest,decision:'approve'}});
 assert.equal(decision.statusCode,202,decision.body);
 const result=await resultPromise;assert.equal(result.text,'Gateway approved browser read');
 assert.equal(result.browser_receipt.kind,'browser_operation_receipt');assert.equal(result.browser_receipt.status,'succeeded');
 assert.equal(result.browser_receipt.run_id,runId);assert.equal(result.browser_receipt.call_id,callId);
 const driverObservation=await bridge.observeBrowserDriver(h.agent,observationScope,new AbortController().signal);
 assert.equal(driverObservation.status,'ready');assert.deepEqual(driverObservation.scope,observationScope);assert.equal(driverObservation.execution_authorized,false);
 const ingressToken='driver-observation-ingress-token-32-characters';
 const handler=createAdapterHandler({controller:{},agents:{get:id=>id===sessionRef?h.agent:undefined},token:ingressToken,workbenchBridge:bridge});
 const transport=async(url,init)=>{const response=await handler({method:init.method,url:new URL(url),headers:init.headers,body:JSON.parse(init.body),signal:init.signal});return Response.json(response.value,{status:response.status});};
 const client=new SessionControllerClient('http://127.0.0.1:18791',ingressToken,transport);
const source=createBrowserDriverReadinessSource(service.db,client),bound={run_id:runId,owner_id:owner,workspace_id:gatewayAgent.workspace_id};
assert.equal((await source(bound,new AbortController().signal)).status,'ready');
 assert.deepEqual(await bridge.revokeBrowserProfile(h.agent,1,new AbortController().signal),{generation:2,status:'revoked'});
 assert.equal((await bridge.observeBrowserDriver(h.agent,observationScope,new AbortController().signal)).status,'unknown','a revoked owner generation cannot remain driver-ready');
 const unauthenticated=new SessionControllerClient('http://127.0.0.1:18791',token,transport);
 await assert.rejects(unauthenticated.observeBrowserDriver(sessionRef,observationScope,new AbortController().signal));
 assert.equal(factoryCalls,1);assert.equal(navigations,1,'readiness must not start browser or navigate');
 await assert.rejects(tool.execute({url:'https://browser-bridge.fixture.invalid/',action:'read'},
  {agent:h.agent,callId,rootCallId:'browser-bridge-root',signal:new AbortController().signal}),/browser_profile_revoked/);
 assert.equal(factoryCalls,1);assert.equal(navigations,1,'revoked generations cannot replay or reopen the preserved profile');
 connected=false;assert.equal((await bridge.observeBrowserDriver(h.agent,observationScope,new AbortController().signal)).status,'unknown');connected=true;
 assert.equal((await bridge.observeBrowserDriver(h.agent,{...observationScope,lease_generation:2},new AbortController().signal)).status,'unknown');
 await assert.rejects(bridge.observeBrowserDriver(h.agent,observationScope,AbortSignal.abort()),{name:'AbortError'});
 onContextClose();assert.equal((await bridge.observeBrowserDriver(h.agent,observationScope,new AbortController().signal)).status,'unknown');
 assert.equal(factoryCalls,1);assert.equal(navigations,1);
 const interaction=service.db.prepare('SELECT status FROM ga_interactions WHERE id=?').get(card.interaction_id);assert.equal(interaction.status,'answered');
 assert.equal(service.db.prepare("SELECT count(*) n FROM ga_run_commands WHERE run_id=? AND kind='interaction_decision'").get(runId).n,1);
 await pluginCleanup();pluginCleanup=undefined;
 localDb=new DatabaseSync(join(root,'browser-data','browser-operations.sqlite'),{readOnly:true});
 const receiptRow=localDb.prepare("SELECT data FROM events WHERE type='browser.operation.succeeded'").get();assert.ok(receiptRow);
 const saved=JSON.parse(receiptRow.data);assert.equal(saved.run_id,runId);assert.equal(saved.call_id,callId);assert.equal(saved.browser_receipt.status,'succeeded');
});
