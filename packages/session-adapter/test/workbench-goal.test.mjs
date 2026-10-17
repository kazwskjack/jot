import test from 'node:test';
import assert from 'node:assert/strict';

let WorkbenchGoalBridge;
try { ({ WorkbenchGoalBridge } = await import('../workbench-goal.js')); } catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const binding = { runId: 'run-1', sessionRef: 'session-1' };
test('native Goal preserves the exact original execution lease through attach reattach and checkpoint continuation',async()=>{
 const f=fixture(),observed=[],request=f.bridge.request;
 f.bridge.request=(path,scoped,...args)=>{observed.push(structuredClone(scoped));return request(path,scoped,...args);};
 const lease={owner:'original-worker',generation:2},leased={...binding,executionLease:lease};
 f.setBinding(leased);
 await f.bridge.attach(f.host.agent,leased);assert.ok(observed.length);assert.ok(observed.every(b=>assert.deepEqual(b.executionLease,lease)===undefined));
 observed.length=0;await f.bridge.attach(f.host.agent,leased);assert.ok(observed.every(b=>assert.deepEqual(b.executionLease,lease)===undefined));
 await f.bridge.revoke(f.host.agent);
 const next={...f.continueAs(),executionLease:{owner:'continuation-worker',generation:3}};f.setBinding(next);observed.length=0;
 await f.bridge.attach(f.host.agent,next);assert.ok(observed.length);assert.ok(observed.every(b=>assert.deepEqual(b.executionLease,next.executionLease)===undefined));assert.equal(f.host.creates,1);
});
test('native Goal rejects malformed execution leases before any original request',async()=>{
 for(const executionLease of [null,{}, {owner:'worker',generation:0},{owner:'worker',generation:1,extra:true},{owner:'../worker',generation:1}]){
  const f=fixture();await assert.rejects(f.bridge.attach(f.host.agent,{...binding,executionLease}),/workbench_binding_invalid/);assert.equal(f.requests.length,0);
 }
});
test('read-only stopped Goal observation keeps original Session identity after execution lease release',async()=>{
 const f=fixture(),leased={...binding,executionLease:{owner:'finished-worker',generation:1}};f.setBinding(leased);await f.bridge.attach(f.host.agent,leased);
 f.host.agent.session={id:binding.sessionRef};f.host.agent.status='idle';
 f.bridge.request=async(path,scoped)=>{assert.equal(path,'task-state');assert.deepEqual(scoped,binding);return {context:context(),task:{run_status:'waiting_user',business_state:'waiting_user',steps:{total:0,completed:0,evidence_verified:0,all_completed:false,all_execution_evidence_verified:false},budget:{configured:false,balances:[],pending_unknown:null,pending_in_flight:null}}};};
 assert.equal((await f.bridge.observe(f.host.agent)).host_status,'idle');
 f.bridge.request=async(path,scoped)=>{assert.equal(path,'guard');assert.deepEqual(scoped,leased);throw Error('workbench_execution_lease_revoked');};
 await assert.rejects(f.bridge.propose(f.host.agent,'stale-proposal',{intent:'complete',summary:'Cannot use released execution'}),/workbench_execution_lease_revoked/);
});
test('Goal observation preserves unlimited money limits but rejects null usage or non-money limits',async()=>{
 const f=fixture();f.host.agent.session={id:binding.sessionRef};f.host.agent.status='idle';await f.bridge.attach(f.host.agent,binding);
 const amounts={tokens:'100',nano_usd:'0',model_calls:'10'};
 const task={run_status:'running',business_state:'queued',steps:{total:0,completed:0,evidence_verified:0,all_completed:false,all_execution_evidence_verified:false},budget:{configured:true,balances:[{scope_id:'scope-fixture',limits:{...amounts,nano_usd:null},used:{...amounts},held:{...amounts}}],pending_unknown:0,pending_in_flight:0}};
 f.bridge.request=async()=>({context:context(),task});
 assert.equal((await f.bridge.observe(f.host.agent)).task.budget.balances[0].limits.nano_usd,null);
 for(const [section,field] of [['used','nano_usd'],['held','nano_usd'],['limits','tokens'],['limits','model_calls']]){const prior=task.budget.balances[0][section][field];task.budget.balances[0][section][field]=null;await assert.rejects(f.bridge.observe(f.host.agent),/workbench_task_state_invalid/);task.budget.balances[0][section][field]=prior;}
});
function context() {
  return { run_id: 'run-1', owner_id: 'owner-a', agent_id: 'agent-a', workspace_id: 'workspace-a', project_id: 'project-a',
    capability_epoch: 1, task_binding: { task_id: 'task-a', occurrence_id: 'occurrence-a', task_version: 3,
      generation: 2, title: 'Research', objective: 'Collect delivery evidence' } };
}
// API-shaped external host double. GoalService creates synchronously, emits a
// durable revision, returns a detached GoalView and requires exact CAS refs.
function host() {
  let goal, creates = 0, resumes = 0;
  const guards = new Set();
  const agent = { ctx: { tools: { guard(handler) { guards.add(handler); return () => guards.delete(handler); } } } };
  const live = value => { assert.equal(value, agent); };
  const ref = value => { assert.deepEqual(value, { id: goal.id, revision: goal.revision }); };
  agent.ctx.goals = {
    get(value) { live(value); return goal && structuredClone(goal); },
    create(value, request) {
      live(value); assert.deepEqual(Object.keys(request), ['objective']);
      if (goal && goal.phase !== 'complete') throw new Error('GOAL_ALREADY_EXISTS');
      creates++;
      goal = { id: `goal-synthetic-${creates}`, revision: 1, objective: request.objective, phase: 'active',
        maxGoalRounds: 256, roundsStarted: 0, createdAt: 123, updatedAt: 123, activation: 'armed' };
      return structuredClone(goal);
    },
    disarm(value) { live(value); if (goal) goal.activation = 'disarmed'; return goal && structuredClone(goal); },
    pause(value, expected) { live(value); ref(expected); assert.equal(goal.phase, 'active');
      goal = { ...goal, revision: goal.revision + 1, phase: 'paused', activation: 'disarmed', updatedAt: 124 };
      return structuredClone(goal);
    },
    resume(value, expected) { live(value); ref(expected); assert.notEqual(goal.phase, 'complete');
      assert.ok(goal.roundsStarted < goal.maxGoalRounds); resumes++;
      goal = { ...goal, revision: goal.revision + 1, phase: 'active', activation: 'armed', updatedAt: goal.updatedAt + 1 };
      return structuredClone(goal);
    },
  };
  return { agent, guards, get creates() { return creates; }, get resumes() { return resumes; }, get goal() { return structuredClone(goal); },
    replace(value) { goal = structuredClone(value); },
    execute(name) { for (const guard of guards) { const reason = guard({ name }); if (reason) throw new Error(reason); } return 'executed'; } };
}
function fixture(shared,options={}) {
  let trusted = context(), activeBinding = binding, unavailable = false, saveFailure = false;
  const durable = shared ?? { mapping: null };
  const requests = [];
  const bridge = new WorkbenchGoalBridge({ ...options,request: async (path, scoped, payload = {}, signal) => {
    signal?.throwIfAborted(); requests.push({ path, scoped: structuredClone(scoped), payload: structuredClone(payload) });
    if (unavailable) throw new Error('workbench_run_forbidden');
    assert.deepEqual(scoped, activeBinding);
    if (path === 'guard') return { context: structuredClone(trusted) };
    assert.equal(path, 'goal-binding');
    if (payload.action === 'save') {
      if (saveFailure) throw new Error('save_unavailable');
      if (durable.mapping && durable.mapping.goal_id !== payload.goal_id) throw new Error('goal_binding_conflict');
      durable.mapping = { goal_id: payload.goal_id, goal_revision: payload.goal_revision };
    } else assert.equal(payload.action, 'get');
    return { binding: structuredClone(durable.mapping) };
  } });
  return { bridge, durable, requests, host: host(), setContext(value) { trusted = value; },setBinding(value){activeBinding=value;},
    continueAs(runId = 'run-2', parent = 'run-1') { activeBinding = { ...binding, runId }; trusted = { ...context(), run_id: runId,
      task_binding: { ...context().task_binding, root_run_id: 'run-1', continuation_of: parent } }; return activeBinding; },
    reject() { unavailable = true; }, failSave(value = true) { saveFailure = value; } };
}

test('exports a scoped native Goal binding service', () => { assert.equal(typeof WorkbenchGoalBridge, 'function'); });

test('a fresh completion binding adopts only the original paused or completed Goal without create/resume/save',async()=>{
 for(const phase of ['paused','complete']){
  const f=fixture();await f.bridge.attach(f.host.agent,binding);
  const original=f.host.goal,before={host_status:'idle',goal:{goal_id:original.id,goal_revision:original.revision,phase:'paused',activation:'disarmed',rounds_started:0,max_goal_rounds:256}};
  f.host.replace({...original,phase,revision:original.revision+(phase==='complete'?1:0),activation:'disarmed'});
  f.host.agent.status='idle';f.host.agent.session={id:binding.sessionRef};
  const intent={intent_id:'intent-1',session_ref:binding.sessionRef,before,checkpoint:{}};
  const resumed=fixture(f.durable),request=resumed.bridge.request;
  resumed.bridge.request=(path,...args)=>path==='completion-intent'?Promise.resolve({intent}):request(path,...args);
  const view=f.host.goal;
  await resumed.bridge.attach(f.host.agent,binding,{completionIntentId:'intent-1'});
  assert.deepEqual(f.host.goal,view);assert.equal(f.host.creates,1);assert.equal(f.host.resumes,0);
  assert.equal(resumed.requests.filter(r=>r.payload.action==='save').length,0);
  assert.throws(()=>f.host.execute('jot_workspace'),/WORKBENCH_GOAL_STOPPED/);
  await assert.rejects(resumed.bridge.guard(f.host.agent),/workbench_goal_stopped/);
 }
});

test('completion adoption rejects another Goal, newer revision, active lifecycle, armed state or changed round cap',async()=>{
 for(const fault of ['id','revision','active','armed','cap']){
  const f=fixture();await f.bridge.attach(f.host.agent,binding);const original=f.host.goal;
  f.host.agent.status='idle';f.host.agent.session={id:binding.sessionRef};
  const before={host_status:'idle',goal:{goal_id:original.id,goal_revision:original.revision,phase:'paused',activation:'disarmed',rounds_started:0,max_goal_rounds:256}};
  const view={...original,phase:'paused',activation:'disarmed'};
  if(fault==='id')view.id='foreign-goal';if(fault==='revision')view.revision+=2;if(fault==='active')view.phase='active';if(fault==='armed')view.activation='armed';if(fault==='cap')view.maxGoalRounds++;
  f.host.replace(view);const resumed=fixture(f.durable),request=resumed.bridge.request;
  resumed.bridge.request=(path,...args)=>path==='completion-intent'?Promise.resolve({intent:{intent_id:'intent-1',session_ref:binding.sessionRef,before,checkpoint:{}}}):request(path,...args);
  await assert.rejects(resumed.bridge.attach(f.host.agent,binding,{completionIntentId:'intent-1'}));
  assert.equal(f.host.creates,1);assert.equal(f.host.resumes,0);assert.equal(resumed.requests.filter(r=>r.payload.action==='save').length,0);
 }
});

test('certificate-only adoption permits only the saved paused or blocked Goal and cannot adopt an unconfirmed completion',async()=>{
 for(const phase of ['paused','blocked','complete','active']){
  const f=fixture();await f.bridge.attach(f.host.agent,binding);const original=f.host.goal;
  f.host.agent.status='idle';f.host.agent.session={id:binding.sessionRef};f.host.replace({...original,phase});
  const resumed=fixture(f.durable),request=resumed.bridge.request;
  resumed.bridge.request=(path,...args)=>path==='completion-recovery'?Promise.resolve({recovery:{certificate_id:'certificate-1',checkpoint:{session_ref:binding.sessionRef,goal_id:original.id,goal_revision:original.revision}}}):request(path,...args);
  if(['paused','blocked'].includes(phase)){
   await resumed.bridge.attach(f.host.agent,binding,{readOnlyCompletion:true});
   await assert.rejects(resumed.bridge.guard(f.host.agent),/workbench_goal_stopped/);
  }else await assert.rejects(resumed.bridge.attach(f.host.agent,binding,{readOnlyCompletion:true}));
  assert.equal(f.host.creates,1);assert.equal(f.host.resumes,0);
  assert.equal(resumed.requests.filter(r=>r.payload.action==='save').length,0);
 }
});

function stepFixture(nativeContinuation=false){
 const f=fixture(undefined,{nativeContinuation}),trusted={...context(),model_budget:{protocol:1,enforced:true}};
 f.setContext(trusted);f.host.agent.session={id:binding.sessionRef};
 const request=f.bridge.request;let effect=()=>{};
 f.bridge.request=async(path,...args)=>{
  if(path!=='step-admission')return request(path,...args);
  const [scoped,payload]=args;assert.deepEqual(scoped,binding);assert.deepEqual(payload,{route:{provider:'fixture',model:'bounded'}});
  const response={context:structuredClone(trusted),admission:{protocol:1,allowed:true,route:{provider:'fixture',model:'bounded',pricing_revision:'rates-v1',
   reserved:{tokens:'100',nano_usd:'1000',model_calls:'1'},queue_credit:{tokens:'100',nano_usd:'1000',model_calls:'1'}}}};
  await effect(response);return response;
 };
 return {...f,effect(value){effect=value;}};
}
test('pre-step admission preserves the exact native Goal and round counters on a read-only success',async()=>{
 const f=stepFixture();await f.bridge.attach(f.host.agent,binding);
 const before=f.host.goal;
 await f.bridge.prepareStep(f.host.agent,{provider:'fixture',model:'bounded'});
 assert.deepEqual(f.host.goal,before);assert.equal(f.host.creates,1);assert.equal(f.host.resumes,0);
 assert.equal(f.host.execute('jot_workspace'),'executed');
});
test('pre-step checks the native Goal identity rather than requiring Cordis service facade object equality',async()=>{
 const f=stepFixture(),service=f.host.agent.ctx.goals;
 f.host.agent.ctx.get=()=>({...service});await f.bridge.attach(f.host.agent,binding);
 await f.bridge.prepareStep(f.host.agent,{provider:'fixture',model:'bounded'});
 assert.equal(f.host.goal.phase,'active');assert.equal(f.host.goal.roundsStarted,0);
});
test('an unresolved route pauses the same Goal without guessing a provider or losing checkpoint observation',async()=>{
 const f=stepFixture();await f.bridge.attach(f.host.agent,binding);
 await assert.rejects(f.bridge.prepareStep(f.host.agent,{provider:undefined,model:undefined}),/budget_route_unavailable/);
 assert.equal(f.host.goal.phase,'paused');assert.equal(f.host.goal.roundsStarted,0);
 await assert.rejects(f.bridge.prepareStep(f.host.agent,{provider:'fixture',model:'bounded'}),/workbench_goal_stopped/);
 assert.throws(()=>f.host.execute('jot_workspace'),/WORKBENCH_GOAL_STOPPED/,'a repeat refusal must not revoke the checkpoint scope');
});

function proposalFixture(enabled=false){
 const f=stepFixture(enabled),request=f.bridge.request;let accepted=true,effect=()=>{};
 f.bridge.request=async(path,...args)=>{
  if(path!=='goal-proposal')return request(path,...args);
  const [scoped,payload]=args;assert.deepEqual(scoped,binding);
  const before=f.host.goal;assert.equal(payload.goal_id,before.id);assert.equal(payload.goal_revision,before.revision);
  const response={context:{...context(),model_budget:{protocol:1,enforced:true}},proposal:accepted?{accepted:true,proposal_id:'goal-proposal-fixture',intent:payload.intent,
   action:payload.intent==='continue'?'resume':payload.intent==='wait_user'?'pause':'review',goal_id:payload.goal_id,goal_revision:payload.goal_revision}
   :{accepted:false,reason:'execution_evidence_required'}};
  await effect(response);return response;
 };
 return {...f,accept(value){accepted=value;},afterRequest(value){effect=value;}};
}
test('a complete proposal forwards logical output declarations without granting file identity or publication',async()=>{
 const f=proposalFixture();await f.bridge.attach(f.host.agent,binding);const request=f.bridge.request;let sent;
 f.bridge.request=async(path,binding,payload,...rest)=>{if(path==='goal-proposal')sent=payload;return request(path,binding,payload,...rest);};
 const files=[{path:'report.md',description:'Reviewed report'}];const result=await f.bridge.propose(f.host.agent,'file-proposal',{intent:'complete',summary:'Review the report',files});
 assert.deepEqual(sent.files,files);assert.equal(result.decision,'waiting_approval');assert.equal(f.host.goal.phase,'paused');
});
test('output declarations cannot accompany other intents or inject owner/version authority',async()=>{
 for(const input of [{intent:'continue',summary:'Continue',files:[{path:'report.md'}]},{intent:'wait_user',summary:'Wait',files:[{path:'report.md'}]},{intent:'complete',summary:'Review',files:[{path:'report.md',owner:'other'}]},{intent:'complete',summary:'Review',files:[{path:'report.md',version:1}]}]){
  const f=proposalFixture(true);await f.bridge.attach(f.host.agent,binding);const before=f.host.goal;await assert.rejects(f.bridge.propose(f.host.agent,'invalid-files',input),/workbench_goal_proposal_invalid/);assert.deepEqual(f.host.goal,before);
 }
});
test('automatic Goal continuation is unavailable by default and cannot be enabled by model proposal fields',async()=>{
 const f=proposalFixture();await f.bridge.attach(f.host.agent,binding);
 assert.deepEqual(await f.bridge.propose(f.host.agent,'call-1',{intent:'continue',summary:'Continue the original task'},{provider:'fixture',model:'bounded'}),{accepted:false,reason:'automatic_continuation_unavailable'});
 assert.equal(f.host.goal.activation,'disarmed');assert.equal(f.host.resumes,0);
 await assert.rejects(f.bridge.propose(f.host.agent,'call-2',{intent:'continue',summary:'Continue',nativeContinuation:true},{provider:'fixture',model:'bounded'}));
});
test('controlled continuation retains the same Goal and its accumulated rounds; only a trusted grant survives execution guard',async()=>{
 const f=proposalFixture(true);await f.bridge.attach(f.host.agent,binding);
 f.host.replace({...f.host.goal,roundsStarted:7});const before=f.host.goal;
 const result=await f.bridge.propose(f.host.agent,'continue-1',{intent:'continue',summary:'Continue the remaining steps'},{provider:'fixture',model:'bounded'});
 assert.equal(result.accepted,true);assert.equal(result.decision,'continue');assert.equal(result.goal_id,undefined);
 assert.equal(f.host.goal.id,before.id);assert.equal(f.host.goal.roundsStarted,7);assert.equal(f.host.goal.activation,'armed');assert.equal(f.host.resumes,1);
 await f.bridge.guard(f.host.agent);assert.equal(f.host.goal.activation,'armed');
 await f.bridge.propose(f.host.agent,'continue-2',{intent:'continue',summary:'Keep working'},{provider:'fixture',model:'bounded'});assert.equal(f.host.resumes,1);
 await f.bridge.revoke(f.host.agent);assert.equal(f.host.goal.activation,'disarmed');assert.equal(f.host.goal.phase,'paused');
});
test('a completion proposal requires execution proof and pauses for approval; it cannot call native complete or certify acceptance',async()=>{
 const f=proposalFixture();await f.bridge.attach(f.host.agent,binding);const before=f.host.goal;
 f.accept(false);assert.deepEqual(await f.bridge.propose(f.host.agent,'unproved',{intent:'complete',summary:'I think I finished'}),{accepted:false,reason:'execution_evidence_required'});
 assert.deepEqual(f.host.goal,before);
 f.accept(true);const result=await f.bridge.propose(f.host.agent,'proved',{intent:'complete',summary:'Please review the delivered result'});
 assert.equal(result.decision,'waiting_approval');assert.equal(f.host.goal.phase,'paused');assert.equal(f.host.goal.activation,'disarmed');assert.equal(f.host.goal.id,before.id);
 assert.equal(f.host.goal.roundsStarted,before.roundsStarted);assert.throws(()=>f.host.execute('jot_workspace'),/WORKBENCH_GOAL_STOPPED/);
});
test('late revocation, forged actions and failed binding persistence cannot leave a continuation armed',async()=>{
 for(const condition of ['revoke','action','save']){
  const f=proposalFixture(true);await f.bridge.attach(f.host.agent,binding);
  if(condition==='save')f.failSave(true);
  f.afterRequest(async response=>{if(condition==='revoke')await f.bridge.revoke(f.host.agent);if(condition==='action')response.proposal.action='create';});
  await assert.rejects(f.bridge.propose(f.host.agent,'continue-safe',{intent:'continue',summary:'Continue remaining work'},{provider:'fixture',model:'bounded'}));
  assert.equal(f.host.goal.activation,'disarmed');assert.equal(f.host.creates,1);assert.equal(f.host.goal.roundsStarted,0);
 }
});
test('pre-step lets the final already-admitted native round finish; the driver owns the next-round cap',async()=>{
 const f=stepFixture();await f.bridge.attach(f.host.agent,binding);f.host.replace({...f.host.goal,maxGoalRounds:1,roundsStarted:1});
 await f.bridge.prepareStep(f.host.agent,{provider:'fixture',model:'bounded'});assert.equal(f.host.goal.phase,'active');assert.equal(f.host.goal.roundsStarted,1);
});
test('budget denial fences pre-step execution without revoking read-only paused checkpoint observation',async()=>{
 for(const code of ['model_budget_exhausted','budget_usage_unknown','budget_usage_pending','budget_window_closed','budget_policy_stale']){
  const f=stepFixture();await f.bridge.attach(f.host.agent,binding);const before=f.host.goal;
  f.effect(()=>{throw new Error(code);});
  await assert.rejects(f.bridge.prepareStep(f.host.agent,{provider:'fixture',model:'bounded'}),error=>error.message===code);
  assert.equal(f.host.goal.phase,'paused');assert.equal(f.host.goal.activation,'disarmed');
  assert.equal(f.host.goal.id,before.id);assert.equal(f.host.goal.roundsStarted,before.roundsStarted);
  assert.throws(()=>f.host.execute('jot_workspace'),/WORKBENCH_GOAL_STOPPED/);
  const request=f.bridge.request;
  f.bridge.request=async(path,...args)=>path==='task-state'?{context:{...context(),model_budget:{protocol:1,enforced:true}},task:{run_status:'running',business_state:'queued',steps:{total:0,completed:0,evidence_verified:0,all_completed:false,all_execution_evidence_verified:false},
   budget:{configured:false,balances:[],pending_unknown:null,pending_in_flight:null}}}:request(path,...args);
  f.host.agent.status='idle';assert.equal((await f.bridge.observe(f.host.agent)).goal.phase,'paused');
  assert.equal(f.durable.mapping.goal_revision,f.host.goal.revision);
 }
});
test('pre-step admission rejects late revocation, changed native identity, malformed decisions and mismatched Session',async()=>{
 for(const variant of ['revoked','native','malformed','scope','session']){
  const f=stepFixture();await f.bridge.attach(f.host.agent,binding);
  if(variant==='session')f.host.agent.session.id='other-session';
  f.effect(async response=>{
   if(variant==='revoked')await f.bridge.revoke(f.host.agent);
   if(variant==='native')f.host.replace({...f.host.goal,revision:f.host.goal.revision+1});
   if(variant==='malformed')response.admission.route.queue_credit.tokens='-100';
   if(variant==='scope')response.context.task_binding.generation++;
  });
  await assert.rejects(f.bridge.prepareStep(f.host.agent,{provider:'fixture',model:'bounded'}));
  assert.equal(f.host.goal.activation,'disarmed');assert.equal(f.host.goal.roundsStarted,0);
  assert.throws(()=>f.host.execute('jot_workspace'),/WORKBENCH_GOAL_(REVOKED|STOPPED)/);
 }
});
test('native Context lookup resolves an active optional Goal service without touching an undeclared property', async()=>{
 const f=fixture(),service=f.host.agent.ctx.goals;
 Object.defineProperty(f.host.agent.ctx,'goals',{get(){throw new Error('cannot get property goals without inject');}});
 f.host.agent.ctx.get=name=>{assert.equal(name,'goals');return service;};
 await f.bridge.attach(f.host.agent,binding);
 await f.bridge.guard(f.host.agent);
 assert.equal(f.host.goal.activation,'disarmed');
 f.host.agent.ctx.get=()=>undefined;
 await assert.rejects(f.bridge.guard(f.host.agent),/workbench_goal_unavailable/);
 assert.throws(()=>f.host.execute('jot_workspace'),/WORKBENCH_GOAL_REVOKED/);
});
test('Goal service unloading while the authenticated guard is awaited denies the late response',async()=>{
 const f=fixture(),service=f.host.agent.ctx.goals;f.host.agent.ctx.get=()=>service;
 await f.bridge.attach(f.host.agent,binding);
 const request=f.bridge.request;
 f.bridge.request=async(...args)=>{const response=await request(...args);f.host.agent.ctx.get=()=>undefined;return response;};
 await assert.rejects(f.bridge.guard(f.host.agent),/workbench_goal_unavailable/);
 assert.throws(()=>f.host.execute('jot_workspace'),/WORKBENCH_GOAL_REVOKED/);
});
test('Goal observation reads stopped native phases and current task facts without rearming or deciding completion',async()=>{
 const f=fixture();f.host.agent.session={id:binding.sessionRef};f.host.agent.status='idle';
 await f.bridge.attach(f.host.agent,binding);
 const task={run_status:'running',business_state:'queued',steps:{total:1,completed:1,evidence_verified:1,all_completed:true,all_execution_evidence_verified:true},budget:{configured:false,balances:[],pending_unknown:null,pending_in_flight:null}};
 const request=f.bridge.request;f.bridge.request=async(path,...args)=>path==='task-state'?{context:context(),task:structuredClone(task)}:request(path,...args);
 for(const phase of ['active','paused','blocked','complete']){
  f.host.replace({...f.host.goal,phase,activation:phase==='active'?'armed':'disarmed'});
  const before=f.host.goal,observed=await f.bridge.observe(f.host.agent);
  assert.equal(observed.protocol,1);assert.equal(observed.goal.phase,phase);assert.equal(observed.host_status,'idle');assert.deepEqual(observed.task,task);
  assert.equal(observed.goal.goal_id,before.id);assert.equal(observed.goal.goal_revision,before.revision);
  assert.deepEqual(f.host.goal,before,'read-only observation must not call lifecycle operations');
  observed.task.steps.total=99;assert.equal(task.steps.total,1);
 }
 await f.bridge.revoke(f.host.agent);await assert.rejects(f.bridge.observe(f.host.agent),/workbench_goal_revoked/);
});
test('Goal observation rejects unbound sessions, changed scope and malformed authoritative task facts',async()=>{
 for(const variant of ['session','scope','count','completion','usage','balance']){
  const f=fixture();f.host.agent.session={id:binding.sessionRef};f.host.agent.status='idle';await f.bridge.attach(f.host.agent,binding);
  const task={run_status:'running',business_state:'queued',steps:{total:1,completed:0,evidence_verified:0,all_completed:false,all_execution_evidence_verified:false},budget:{configured:false,balances:[],pending_unknown:null,pending_in_flight:null}},trusted=context();
  if(variant==='session')f.host.agent.session.id='foreign-session';
  if(variant==='scope')trusted.task_binding.generation++;
  if(variant==='count')task.steps.evidence_verified=2;
  if(variant==='completion')task.completion_verified=true;
  if(variant==='usage')task.budget.pending_unknown=0;
  if(variant==='balance')task.budget.balances=[{scope_id:'foreign'}];
  const request=f.bridge.request;f.bridge.request=async(path,...args)=>path==='task-state'?{context:trusted,task}:request(path,...args);
  const before=f.host.goal;await assert.rejects(f.bridge.observe(f.host.agent));assert.deepEqual(f.host.goal,before);
 }
});
test('background occurrence creates one persistent native Goal and immediately disarms competing continuation', async () => {
  const f = fixture(); const result = await f.bridge.attach(f.host.agent, { ...binding, task_id: 'forged' });
  assert.deepEqual(result, { available: true, phase: 'active' });
  assert.equal(f.host.creates, 1); assert.equal(f.host.goal.activation, 'disarmed');
  assert.match(f.host.goal.objective, /^Collect delivery evidence\n\n\[jot-occurrence:[a-f0-9]{64}\]$/);
  assert.equal(f.durable.mapping.goal_id, 'goal-synthetic-1');
  assert.equal(JSON.stringify(result).includes('goal-synthetic'), false);
});

function stoppable(f) {
 const events=[{seq:0,type:'turn/start'},{seq:1,type:'turn/end'}];
 f.host.agent.session={id:binding.sessionRef,get seq(){return events.length;},eventAt:i=>events[i]};
 f.host.agent.status='idle';
 const request=f.bridge.request;
 f.bridge.request=async(path,...args)=>path==='task-state'?{context:context(),task:{run_status:'running',business_state:'queued',steps:{total:0,completed:0,evidence_verified:0,all_completed:false,all_execution_evidence_verified:false},budget:{configured:false,balances:[],pending_unknown:null,pending_in_flight:null}}}:request(path,...args);
 return events;
}

test('scoped suspension pauses before cancelling, fences execution and returns the actual latest idle boundary',async()=>{
 const f=fixture(),events=stoppable(f);await f.bridge.attach(f.host.agent,binding);
 f.host.replace({...f.host.goal,activation:'armed',roundsStarted:4});f.host.agent.status='running';
 let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});
 f.host.agent.cancel=cause=>{assert.deepEqual(cause,{kind:'user'});assert.equal(f.host.goal.phase,'paused');assert.equal(f.host.goal.activation,'disarmed');};
 f.host.agent.whenIdle=async()=>{entered();await new Promise(resolve=>{release=resolve;});events.push({seq:2,type:'turn/start'},{seq:3,type:'turn/end'});f.host.agent.status='idle';};
 const result=f.bridge.suspend(f.host.agent,{goal_id:f.host.goal.id,goal_revision:1});await waiting;
 assert.throws(()=>f.host.execute('universe_search'),/WORKBENCH_GOAL_STOPPED/);
 await assert.rejects(f.bridge.guard(f.host.agent),/workbench_goal_stopped/);
 release();const stopped=await result;assert.equal(stopped.turn_end_seq,3);assert.equal(stopped.state.goal.phase,'paused');
 assert.equal(stopped.state.goal.goal_revision,2);assert.equal(stopped.state.goal.rounds_started,4);assert.equal(stopped.state.host_status,'idle');
 assert.equal(f.durable.mapping.goal_revision,2);assert.equal(f.host.resumes,0);
 assert.equal((await f.bridge.observe(f.host.agent)).goal.phase,'paused');
 await assert.rejects(f.bridge.suspend(f.host.agent,{goal_id:f.host.goal.id,goal_revision:1}),/workbench_goal_ref_conflict/);
});

test('suspension rejects forged refs or revoked scope without mutating the Goal or cancelling work',async()=>{
 for(const variant of ['id','revision','type','extra','revoked']){
  const f=fixture();stoppable(f);await f.bridge.attach(f.host.agent,binding);let cancels=0;
  f.host.agent.cancel=()=>{cancels++;};f.host.agent.whenIdle=async()=>{};
  const ref={goal_id:f.host.goal.id,goal_revision:1};
  if(variant==='id')ref.goal_id='foreign-goal';if(variant==='revision')ref.goal_revision=2;if(variant==='type')ref.goal_revision='1';if(variant==='extra')ref.objective='Forged';
  if(variant==='revoked')await f.bridge.revoke(f.host.agent);
  const before=f.host.goal;await assert.rejects(f.bridge.suspend(f.host.agent,ref));assert.deepEqual(f.host.goal,before);assert.equal(cancels,0);
 }
});

test('revocation during idle confirmation cannot produce a successful suspension acknowledgement',async()=>{
 const f=fixture();stoppable(f);await f.bridge.attach(f.host.agent,binding);
 let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});
 f.host.agent.cancel=()=>{};f.host.agent.whenIdle=async()=>{entered();await new Promise(resolve=>{release=resolve;});};
 const result=f.bridge.suspend(f.host.agent,{goal_id:f.host.goal.id,goal_revision:1});await waiting;await f.bridge.revoke(f.host.agent);release();
 await assert.rejects(result,/workbench_goal_revoked/);assert.throws(()=>f.host.execute('universe_search'),/WORKBENCH_GOAL_REVOKED/);
});

test('authorized checkpoint continuation resumes one Goal without resetting history or installing a second guard', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding);
  f.host.replace({ ...f.host.goal, revision: 9, roundsStarted: 7 });
  const objective = f.host.goal.objective;
  await f.bridge.revoke(f.host.agent);
  await f.bridge.attach(f.host.agent, f.continueAs());
  assert.equal(f.host.goal.phase, 'active'); assert.equal(f.host.goal.activation, 'disarmed');
  assert.equal(f.host.goal.objective, objective); assert.equal(f.host.creates, 1); assert.equal(f.host.resumes, 1);
  assert.equal(f.host.goal.roundsStarted, 7); assert.equal(f.host.goal.maxGoalRounds, 256);
  assert.equal(f.durable.mapping.goal_revision, 11); assert.equal(f.host.guards.size, 1);
  assert.equal(f.host.execute('jot_workspace'), 'executed'); await f.bridge.guard(f.host.agent);
  assert.throws(() => f.host.execute('create_goal'), /WORKBENCH_GOAL_TOOL_FORBIDDEN/);
  await f.bridge.revoke(f.host.agent); await f.bridge.attach(f.host.agent, f.continueAs('run-3', 'run-2'));
  assert.equal(f.host.resumes, 2); assert.equal(f.host.goal.roundsStarted, 7); assert.equal(f.host.guards.size, 1);
});

test('host restart checkpoint recovery reuses the persisted Goal and refuses absent native history', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding); await f.bridge.revoke(f.host.agent);
  const restored = fixture(f.durable); await restored.bridge.attach(f.host.agent, restored.continueAs());
  assert.equal(f.host.creates, 1); assert.equal(f.host.resumes, 1); assert.equal(f.host.goal.activation, 'disarmed');
  const absent = fixture(); await assert.rejects(absent.bridge.attach(absent.host.agent, absent.continueAs()), /workbench_goal_identity_conflict/);
  assert.equal(absent.host.creates, 0);
});

test('checkpoint continuation cannot resume completed or exhausted Goals or reparent a live binding', async () => {
  for (const condition of ['complete', 'exhausted', 'parent', 'root', 'resume_unavailable']) {
    const f = fixture(); await f.bridge.attach(f.host.agent, binding); await f.bridge.revoke(f.host.agent);
    const next = f.continueAs('run-2', condition === 'parent' ? 'foreign-run' : 'run-1');
    if (condition === 'complete') f.host.replace({ ...f.host.goal, phase: 'complete' });
    if (condition === 'exhausted') f.host.replace({ ...f.host.goal, roundsStarted: 256 });
    if (condition === 'root') f.setContext({ ...context(), run_id: 'run-2', task_binding: { ...context().task_binding, continuation_of: 'run-1' } });
    if (condition === 'resume_unavailable') delete f.host.agent.ctx.goals.resume;
    await assert.rejects(f.bridge.attach(f.host.agent, next));
    assert.equal(f.host.resumes, 0, condition); assert.equal(f.host.creates, 1); assert.equal(f.host.goal.activation, 'disarmed');
  }
});

test('revocation during checkpoint save prevents a late reactivation', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding); await f.bridge.revoke(f.host.agent);
  const next = f.continueAs(); const originalSave = f.bridge.bindingStore.save; let release, entered;
  const saving = new Promise(resolve => { entered = resolve; });
  f.bridge.bindingStore.save = async (...args) => { entered(); await new Promise(resolve => { release = resolve; }); return originalSave(...args); };
  const attached = f.bridge.attach(f.host.agent, next); await saving; await f.bridge.revoke(f.host.agent); release();
  await assert.rejects(attached, /workbench_goal_revoked/); assert.equal(f.host.goal.phase, 'paused');
  assert.equal(f.host.goal.activation, 'disarmed'); assert.throws(() => f.host.execute('jot_workspace'), /WORKBENCH_GOAL_REVOKED/);
});

test('a late guard failure from the old run cannot pause the recovered run', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding);
  const request = f.bridge.request; let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.bridge.request = async (...args) => {
    if (args[0] === 'guard' && args[1].runId === 'run-1') {
      entered(); await new Promise(resolve => { release = resolve; }); throw new Error('old_run_terminal');
    }
    return request(...args);
  };
  const oldGuard = f.bridge.guard(f.host.agent); await waiting;
  await f.bridge.revoke(f.host.agent); await f.bridge.attach(f.host.agent, f.continueAs()); release();
  await assert.rejects(oldGuard, /old_run_terminal/); assert.equal(f.host.goal.phase, 'active');
  assert.equal(f.host.execute('jot_workspace'), 'executed'); await f.bridge.guard(f.host.agent);
});
test('ordinary role chats do not need or create a native Goal', async () => {
  const f = fixture(); delete f.host.agent.ctx.goals;
  f.setContext({ ...context(), task_binding: null });
  assert.deepEqual(await f.bridge.attach(f.host.agent, binding), { available: false, required: false });
  assert.equal(f.host.guards.size, 0); assert.equal(f.durable.mapping, null);
});
test('a task with missing host Goal API explicitly fails before durable binding or model execution', async () => {
  const f = fixture(); delete f.host.agent.ctx.goals;
  await assert.rejects(f.bridge.attach(f.host.agent, binding), /workbench_goal_unavailable/);
  assert.equal(f.durable.mapping, null);
  await assert.rejects(f.bridge.guard(f.host.agent), /workbench_goal_binding_missing/);
});
test('concurrent attachment and reattachment preserve one Goal identity and one native denial guard', async () => {
  const f = fixture(); await Promise.all([f.bridge.attach(f.host.agent, binding), f.bridge.attach(f.host.agent, binding)]);
  await f.bridge.attach(f.host.agent, binding);
  assert.equal(f.host.creates, 1); assert.equal(f.host.guards.size, 1);
  assert.equal(f.durable.mapping.goal_id, 'goal-synthetic-1');
});
test('host restart reuses the existing session Goal without resetting rounds or revision', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding);
  f.host.replace({ ...f.host.goal, revision: 9, roundsStarted: 7 });
  const restored = fixture(f.durable);
  await restored.bridge.attach(f.host.agent, binding);
  assert.equal(f.host.creates, 1); assert.equal(f.host.goal.revision, 9); assert.equal(f.host.goal.roundsStarted, 7);
  assert.equal(f.durable.mapping.goal_revision, 9);
});
test('create before binding save interruption recovers only the exact immutable occurrence marker', async () => {
  const f = fixture(); f.failSave();
  await assert.rejects(f.bridge.attach(f.host.agent, binding), /save_unavailable/);
  assert.equal(f.host.goal.activation, 'disarmed');
  f.failSave(false); await f.bridge.attach(f.host.agent, binding);
  assert.equal(f.host.creates, 1); assert.equal(f.durable.mapping.goal_id, 'goal-synthetic-1');
});
test('unbound unrelated Goal is never adopted cleared or replaced even with same human objective', async () => {
  const f = fixture(); f.host.agent.ctx.goals.create(f.host.agent, { objective: 'Collect delivery evidence' });
  await assert.rejects(f.bridge.attach(f.host.agent, binding), /workbench_goal_identity_conflict/);
  assert.equal(f.host.creates, 1); assert.equal(f.durable.mapping, null); assert.equal(f.host.goal.activation, 'disarmed');
});
test('cleared or replaced mapped Goal cannot be silently recreated on resume', async () => {
  for (const replacement of [undefined, { id: 'goal-foreign', revision: 1 }]) {
    const f = fixture(); await f.bridge.attach(f.host.agent, binding);
    f.host.replace(replacement ? { ...f.host.goal, ...replacement } : undefined);
    await assert.rejects(f.bridge.attach(f.host.agent, binding), /workbench_goal_identity_conflict/);
    assert.equal(f.host.creates, 1);
  }
});
test('native model Goal tools are denied but ordinary authorized workspace tools are unaffected', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding);
  for (const name of ['get_goal', 'create_goal', 'update_goal']) assert.throws(() => f.host.execute(name), /WORKBENCH_GOAL_TOOL_FORBIDDEN/);
  assert.equal(f.host.execute('jot_workspace'), 'executed');
});
test('paused cancelled deleted or unavailable Gateway revocation pauses and disarms the Goal', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding); f.reject();
  await assert.rejects(f.bridge.guard(f.host.agent), /workbench_run_forbidden/);
  assert.equal(f.host.goal.phase, 'paused'); assert.equal(f.host.goal.activation, 'disarmed');
  await assert.rejects(f.bridge.guard(f.host.agent), /workbench_goal_revoked/);
});
test('changing trusted owner task occurrence generation or frozen objective fails closed', async () => {
  for (const change of [ { owner_id: 'owner-b' }, { run_id: 'run-b' },
    { task_binding: { ...context().task_binding, task_id: 'task-b' } },
    { task_binding: { ...context().task_binding, occurrence_id: 'occurrence-b' } },
    { task_binding: { ...context().task_binding, generation: 3 } },
    { task_binding: { ...context().task_binding, objective: 'Changed objective' } } ]) {
    const f = fixture(); await f.bridge.attach(f.host.agent, binding); f.setContext({ ...context(), ...change });
    await assert.rejects(f.bridge.guard(f.host.agent), /workbench_goal_binding_changed/);
    assert.equal(f.host.goal.activation, 'disarmed'); assert.equal(f.host.goal.phase, 'paused');
  }
});
test('a locally edited native objective cannot change the durable parent task mapping', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding);
  f.host.replace({ ...f.host.goal, objective: 'New planner objective', revision: 2 });
  await assert.rejects(f.bridge.guard(f.host.agent), /workbench_goal_identity_conflict/);
  assert.equal(f.durable.mapping.goal_id, 'goal-synthetic-1');
});
test('native completion remains advisory and never writes parent or child task completion', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding);
  f.host.replace({ ...f.host.goal, phase: 'complete', revision: 2, activation: 'disarmed' });
  await assert.rejects(f.bridge.guard(f.host.agent), /workbench_goal_stopped/);
  assert.equal(f.requests.some(value => value.path === 'tool'), false);
  assert.equal(f.requests.some(value => Object.hasOwn(value.payload, 'status')), false);
});
test('explicit host revocation is idempotent and preserves the task Goal history', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding);
  await f.bridge.revoke(f.host.agent); await f.bridge.revoke(f.host.agent);
  assert.equal(f.host.goal.id, 'goal-synthetic-1'); assert.equal(f.host.goal.phase, 'paused'); assert.equal(f.host.goal.revision, 2);
  await assert.rejects(f.bridge.guard(f.host.agent), /workbench_goal_revoked/);
});
test('malformed trusted task scope cannot create a Goal or persist a mapping', async () => {
  for (const patch of [{task_id:''}, {task_version:0}, {generation:0}, {objective:''}, {occurrence_id:'bad/id'}]) {
    const f = fixture(); f.setContext({ ...context(), task_binding: { ...context().task_binding, ...patch } });
    await assert.rejects(f.bridge.attach(f.host.agent, binding), /workbench_goal_context_invalid/);
    assert.equal(f.host.creates, 0); assert.equal(f.durable.mapping, null);
  }
});
test('stale stored Goal revision fails closed rather than allowing reset of native history', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding);
  f.durable.mapping.goal_revision = 10;
  await assert.rejects(f.bridge.attach(f.host.agent, binding), /workbench_goal_identity_conflict/);
  assert.equal(f.host.creates, 1); assert.equal(f.host.goal.activation, 'disarmed');
});
test('stopped native Goal is never resumed or replaced by reattachment', async () => {
  for (const phase of ['paused', 'blocked', 'complete']) {
    const f = fixture(); await f.bridge.attach(f.host.agent, binding);
    f.host.replace({ ...f.host.goal, phase, revision: 2, activation: 'disarmed' });
    await assert.rejects(f.bridge.attach(f.host.agent, binding), /workbench_goal_stopped/);
    assert.equal(f.host.creates, 1); assert.equal(f.host.goal.phase, phase);
  }
});
test('revocation during pending attachment cannot admit a late Goal binding', async () => {
  const h = host(); let release;
  const bridge = new WorkbenchGoalBridge({ request: async (path) => {
    if (path === 'guard') return new Promise(resolve => { release = resolve; });
    return { binding: null };
  } });
  const attached = bridge.attach(h.agent, binding);
  await Promise.resolve(); await Promise.resolve();
  await bridge.revoke(h.agent);
  release({ context: context() });
  await assert.rejects(attached, /workbench_goal_revoked/);
  assert.equal(h.creates, 0);
});
test('revoked scoped model tools remain denied after an unavailable native pause', async () => {
  const f = fixture(); await f.bridge.attach(f.host.agent, binding);
  f.host.agent.ctx.goals.pause = () => { throw new Error('projection_unavailable'); };
  await f.bridge.revoke(f.host.agent);
  assert.equal(f.host.goal.activation, 'disarmed');
  assert.throws(() => f.host.execute('jot_workspace'), /WORKBENCH_GOAL_REVOKED/);
});
