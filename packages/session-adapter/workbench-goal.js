import { createHash } from 'node:crypto';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const NATIVE_GOAL_TOOLS = new Set(['get_goal', 'create_goal', 'update_goal']);
const positive = value => Number.isSafeInteger(value) && value > 0;

// Cordis Agent contexts inherit the loop's required services, which do not
// include goals. Optional property access still throws on that native proxy.
// Context.get is the official active-service lookup; never fall back to an
// old property after it reports an unloaded service. Plain host facades retain
// their existing property contract.
export function nativeGoalsFor(agent) {
  const scope = agent?.ctx;
  return typeof scope?.get === 'function' ? scope.get('goals') : scope?.goals;
}

function trustedScope(context, binding) {
  if (!context || context.run_id !== binding.runId) throw new Error('workbench_goal_context_invalid');
  const task = context.task_binding;
  if (task === undefined || task === null) return null;
  if (!['owner_id', 'agent_id', 'workspace_id', 'project_id'].every(key => typeof context[key] === 'string' && ID.test(context[key]))
    || !positive(context.capability_epoch) || typeof task !== 'object' || Array.isArray(task)
    || !['task_id', 'occurrence_id'].every(key => typeof task[key] === 'string' && ID.test(task[key]))
    || !positive(task.task_version) || !positive(task.generation)
    || typeof task.objective !== 'string' || !task.objective.trim() || task.objective.length > 65536
    || typeof task.title !== 'string' || !task.title.trim() || task.title.length > 512) {
    throw new Error('workbench_goal_context_invalid');
  }
  const rootRun = task.root_run_id ?? binding.runId;
  if (typeof rootRun !== 'string' || !ID.test(rootRun)
    || (task.continuation_of != null && (typeof task.continuation_of !== 'string'
      || !ID.test(task.continuation_of) || task.continuation_of === binding.runId
      || !task.root_run_id || rootRun === binding.runId))) throw new Error('workbench_goal_context_invalid');
  // Only Gateway fields may determine the immutable parent/occurrence mapping.
  return Object.freeze({ owner_id: context.owner_id, agent_id: context.agent_id, workspace_id: context.workspace_id,
    project_id: context.project_id, capability_epoch: context.capability_epoch, run_id: rootRun,
    session_ref: binding.sessionRef, task_id: task.task_id, occurrence_id: task.occurrence_id,
    task_version: task.task_version, generation: task.generation, objective: task.objective.trim(), title: task.title });
}

function objectiveFor(scope) {
  // A deterministic opaque marker reconciles create-before-save crashes. Raw
  // owner, task, run and Session ids are never inserted into model-visible text.
  const marker = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  return `${scope.objective}\n\n[jot-occurrence:${marker}]`;
}

/** Trusted pre-publication identity checks; neither function arms a Goal. */
export function nativeTaskResumeScope(context,binding){
 const scope=trustedScope(context,binding);
 if(context?.kind!=='task'||context.task_binding?.root_run_id!==binding.runId||context.task_binding.continuation_of!==null||scope?.run_id!==binding.runId)throw Error('workbench_resume_scope_invalid');
 return scope;
}
export function verifyNativeTaskResumeGoal(agent,scope,mapping,projections){
 const saved=validMapping(mapping);if(!saved)throw Error('workbench_resume_goal_missing');
 // GoalService.get intentionally accepts only published Agents. Read its pure
 // durable projection here; do not invent a live Agent or activation authority.
 const state=projections?.stateOf?.(agent.session,'goal'),goal=state?.current?.goal;
 if(state?.failure!==null||!goal||goal.id!==saved.goal_id||!positive(goal.revision)||goal.revision<saved.goal_revision
   ||goal.objective!==objectiveFor(scope)||!positive(goal.maxGoalRounds))throw Error('workbench_resume_goal_invalid');
 if(goal.phase!=='active')throw Error('workbench_resume_goal_inactive');
 return Object.freeze({goal_id:goal.id,goal_revision:goal.revision});
}

function validMapping(value) {
  if (value === null) return null;
  if (!value || typeof value.goal_id !== 'string' || !ID.test(value.goal_id) || !positive(value.goal_revision)) {
    throw new Error('workbench_goal_binding_invalid');
  }
  return { goal_id: value.goal_id, goal_revision: value.goal_revision };
}

function validGoal(value, objective, mapping) {
  if (!value || typeof value.id !== 'string' || !ID.test(value.id) || !positive(value.revision)
    || value.objective !== objective || !['active', 'paused', 'blocked', 'complete'].includes(value.phase)
    || !positive(value.maxGoalRounds) || !Number.isSafeInteger(value.roundsStarted) || value.roundsStarted < 0
    || value.roundsStarted > value.maxGoalRounds || !['armed', 'disarmed'].includes(value.activation)
    || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt) || value.updatedAt < value.createdAt
    || (mapping && (mapping.goal_id !== value.id || mapping.goal_revision > value.revision))) {
    throw new Error('workbench_goal_identity_conflict');
  }
  return value;
}

function exactRecord(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
}
function validTaskFacts(task) {
  const invalid=()=>{throw new Error('workbench_task_state_invalid');};
  if(!exactRecord(task,['run_status','business_state','steps','budget'])
    || !['queued','starting','running','waiting_user','waiting_approval'].includes(task.run_status)
    || typeof task.business_state!=='string' || !/^[a-z_]{1,64}$/.test(task.business_state))invalid();
  const steps=task.steps,integer=value=>Number.isSafeInteger(value)&&value>=0;
  if(!exactRecord(steps,['total','completed','evidence_verified','all_completed','all_execution_evidence_verified'])
    || ![steps.total,steps.completed,steps.evidence_verified].every(integer)
    || steps.completed>steps.total || steps.evidence_verified>steps.completed
    || steps.all_completed!==(steps.total>0&&steps.completed===steps.total)
    || steps.all_execution_evidence_verified!==(steps.total>0&&steps.evidence_verified===steps.total))invalid();
  const budget=task.budget;
  if(!exactRecord(budget,['configured','balances','pending_unknown','pending_in_flight'])
    || typeof budget.configured!=='boolean' || !Array.isArray(budget.balances) || budget.balances.length>8)invalid();
  if(!budget.configured){
    if(budget.balances.length || budget.pending_unknown!==null || budget.pending_in_flight!==null)invalid();
  }else{
    if(!budget.balances.length || !integer(budget.pending_unknown) || !integer(budget.pending_in_flight))invalid();
    const ids=new Set();
    for(const balance of budget.balances){
      if(!exactRecord(balance,['scope_id','limits','used','held']) || typeof balance.scope_id!=='string'
        || !ID.test(balance.scope_id) || ids.has(balance.scope_id))invalid();
      ids.add(balance.scope_id);
      for(const key of ['limits','used','held']){
        const amounts=balance[key];
        if(!exactRecord(amounts,['tokens','nano_usd','model_calls'])
          || !Object.entries(amounts).every(([field,value])=>(key==='limits'&&field==='nano_usd'&&value===null)||typeof value==='string'&&/^(0|[1-9][0-9]{0,127})$/.test(value)))invalid();
      }
    }
  }
  return structuredClone(task);
}

/**
 * Trusted host-only lifecycle bridge. Goal state never schedules rounds and
 * never determines database task/subtask completion. No model Goal tools,
 * continuation driver or second planner are installed by this service.
 *
 * request(path, binding, payload?, signal?) is WorkbenchBridge.request bound to
 * its authenticated Gateway channel. An optional bindingStore implements
 * get(binding, signal) -> null | {goal_id,goal_revision} and
 * save(binding, mapping, signal) -> the accepted same immutable mapping.
 * The default store uses the internal goal-binding endpoint, never a tool.
 */
export class WorkbenchGoalBridge {
  constructor({ request, bindingStore, nativeContinuation = false } = {}) {
    if (typeof request !== 'function' || (bindingStore &&
      (typeof bindingStore.get !== 'function' || typeof bindingStore.save !== 'function')) || typeof nativeContinuation!=='boolean') {
      throw new Error('workbench_goal_config_invalid');
    }
    this.request = request;
    this.nativeContinuation = nativeContinuation;
    this.proposing = new WeakMap();
    this.bindingStore = bindingStore ?? {
      get: async (binding, signal) => (await request('goal-binding', binding, { action: 'get' }, signal)).binding,
      save: async (binding, mapping, signal) => (await request('goal-binding', binding,
        { action: 'save', ...mapping }, signal)).binding,
    };
    this.installed = new WeakMap();
    this.pending = new WeakMap();
    this.revoked = new WeakSet();
    this.revocationEpoch = new WeakMap();
  }

  attach(agent, binding, {completionIntentId,readOnlyCompletion=false}={}) {
    if (!agent || typeof agent !== 'object' || !binding || typeof binding.runId !== 'string' || !ID.test(binding.runId)
      || typeof binding.sessionRef !== 'string' || !ID.test(binding.sessionRef)) {
      return Promise.reject(new Error('workbench_goal_binding_invalid'));
    }
    if(completionIntentId!==undefined&&(typeof completionIntentId!=='string'||!ID.test(completionIntentId)))return Promise.reject(new Error('workbench_goal_completion_invalid'));
    if(typeof readOnlyCompletion!=='boolean'||readOnlyCompletion&&completionIntentId!==undefined)return Promise.reject(new Error('workbench_goal_completion_invalid'));
    const trustedBinding = Object.freeze({ runId: binding.runId, sessionRef: binding.sessionRef });
    const epoch = this.revocationEpoch.get(agent) ?? 0;
    // Serialize create/get/save on one exact live Agent. There is no awaited
    // boundary between get/create/disarm in the synchronous native service.
    const previous = this.pending.get(agent) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.attachOne(agent, trustedBinding, epoch,completionIntentId,readOnlyCompletion));
    this.pending.set(agent, operation);
    return operation;
  }

  async attachOne(agent, binding, epoch,completionIntentId,readOnlyCompletion=false) {
    const prior = this.installed.get(agent);
    let goals;
    let ownedGoalId;
    const checkRevocation = () => { if ((this.revocationEpoch.get(agent) ?? 0) !== epoch) throw new Error('workbench_goal_revoked'); };
    try {
      checkRevocation();
      const response = await this.request('guard', binding);
      checkRevocation();
      const scope = trustedScope(response.context, binding);
      if (scope === null) {
        if (prior) throw new Error('workbench_goal_binding_changed');
        return { available: false, required: false };
      }
      const parent = response.context.task_binding.continuation_of;
      const recovery = typeof parent === 'string';
      if (this.revoked.has(agent) && !recovery) throw new Error('workbench_goal_revoked');
      goals = nativeGoalsFor(agent);
      if (!['get', 'create', 'disarm', 'pause'].every(name => typeof goals?.[name] === 'function')
        || typeof agent.ctx?.tools?.guard !== 'function') throw new Error('workbench_goal_unavailable');
      if (prior && (JSON.stringify(prior.scope) !== JSON.stringify(scope)
        || (prior.binding.runId !== binding.runId && (!recovery || parent !== prior.binding.runId))
        || (prior.revoked && prior.binding.runId === binding.runId))) {
        throw new Error(prior.revoked && prior.binding.runId === binding.runId ? 'workbench_goal_revoked' : 'workbench_goal_binding_changed');
      }
      const mapping = validMapping(await this.bindingStore.get(binding));
      checkRevocation();
      if(completionIntentId!==undefined||readOnlyCompletion){
        const intent=readOnlyCompletion?null:(await this.request('completion-intent',binding,{intent_id:completionIntentId})).intent;
        const authorization=readOnlyCompletion?(await this.request('completion-recovery',binding)).recovery:null;
        checkRevocation();
        const before=intent?.before,g=before?.goal,objective=objectiveFor(scope);
        if(!readOnlyCompletion&&(!mapping||intent?.intent_id!==completionIntentId||intent.session_ref!==binding.sessionRef
          ||!exactRecord(before,['host_status','goal'])||before.host_status!=='idle'
          ||!exactRecord(g,['goal_id','goal_revision','phase','activation','rounds_started','max_goal_rounds'])
          ||mapping.goal_id!==g.goal_id||mapping.goal_revision!==g.goal_revision
          ||!['paused','blocked'].includes(g.phase)||g.activation!=='disarmed'))throw new Error('workbench_goal_completion_invalid');
        if(readOnlyCompletion&&(!mapping||typeof authorization?.certificate_id!=='string'||!ID.test(authorization.certificate_id)
          ||authorization.checkpoint?.session_ref!==binding.sessionRef||authorization.checkpoint.goal_id!==mapping.goal_id
          ||authorization.checkpoint.goal_revision!==mapping.goal_revision))throw new Error('workbench_goal_completion_invalid');
        const view=validGoal(goals.get(agent),objective,mapping);
        if(agent.session?.id!==binding.sessionRef||agent.status!=='idle'||view.activation!=='disarmed'
          ||(readOnlyCompletion?(!['paused','blocked'].includes(view.phase)||view.revision!==mapping.goal_revision)
            :(view.roundsStarted!==g.rounds_started||view.maxGoalRounds!==g.max_goal_rounds
             ||!((view.phase===g.phase&&view.revision===g.goal_revision)
              ||(view.phase==='complete'&&view.revision===g.goal_revision+1)))))throw new Error('workbench_goal_identity_conflict');
        const state={binding,scope,objective,goalId:view.id,revision:view.revision,goals,revoked:false,suspended:true,driverGranted:false};
        if(prior)Object.assign(prior,state);
        else{
          agent.ctx.tools.guard(exec=>state.revoked?'WORKBENCH_GOAL_REVOKED':state.suspended?'WORKBENCH_GOAL_STOPPED'
            :NATIVE_GOAL_TOOLS.has(exec.name)?'WORKBENCH_GOAL_TOOL_FORBIDDEN':undefined);
          this.installed.set(agent,state);
        }
        return {available:true,phase:view.phase,completionOnly:true};
      }
      let view = goals.get(agent);
      const objective = objectiveFor(scope);
      if (!recovery && view === undefined && mapping === null) view = goals.create(agent, { objective });
      // Even an unrelated armed Goal is disarmed before rejecting adoption.
      goals.disarm(agent);
      validGoal(view, objective, mapping);
      ownedGoalId = view.id;
      if (recovery) {
        if (!mapping) throw new Error('workbench_goal_identity_conflict');
        if (view.phase === 'complete' || view.roundsStarted >= view.maxGoalRounds) throw new Error('workbench_goal_stopped');
        if (view.phase !== 'active') {
          if (typeof goals.resume !== 'function') throw new Error('workbench_goal_unavailable');
          view = goals.resume(agent, { id: view.id, revision: view.revision });
          // Native resume arms its driver synchronously. Disarm before any
          // awaited boundary; only the existing Gateway queue owns execution.
          goals.disarm(agent);
          validGoal(view, objective, mapping);
        }
      }
      if (view.phase !== 'active') throw new Error('workbench_goal_stopped');
      const saved = validMapping(await this.bindingStore.save(binding, { goal_id: view.id, goal_revision: view.revision }));
      checkRevocation();
      if (!saved || saved.goal_id !== view.id || saved.goal_revision !== view.revision) throw new Error('workbench_goal_binding_invalid');
      // Save awaits network; reread current native identity before activation.
      const fresh = validGoal(goals.get(agent), objective, saved);
      goals.disarm(agent);
      if (fresh.phase !== 'active') throw new Error('workbench_goal_stopped');
      if (!prior) {
        const state = { binding, scope, objective, goalId: fresh.id, revision: fresh.revision, goals, revoked: false, suspended: false, driverGranted:false };
        agent.ctx.tools.guard(exec => state.revoked ? 'WORKBENCH_GOAL_REVOKED'
          : state.suspended ? 'WORKBENCH_GOAL_STOPPED'
          : NATIVE_GOAL_TOOLS.has(exec.name) ? 'WORKBENCH_GOAL_TOOL_FORBIDDEN' : undefined);
        this.installed.set(agent, state);
      } else Object.assign(prior, { binding, scope, objective, goalId: fresh.id, revision: fresh.revision, goals, revoked: false, suspended: false,driverGranted:false });
      this.revoked.delete(agent);
      return { available: true, phase: fresh.phase };
    } catch (error) {
      if (prior) this.stop(agent, prior);
      else {
        try {
          const view = goals?.disarm?.(agent);
          if (this.revoked.has(agent) && ownedGoalId && view?.id === ownedGoalId && view.phase === 'active') {
            goals.pause(agent, { id: view.id, revision: view.revision });
          }
        } catch { /* Failed binding stays unavailable. */ }
      }
      throw error;
    }
  }

  async guard(agent, signal) {
    const state = this.installed.get(agent);
    if (!state) throw new Error('workbench_goal_binding_missing');
    if (state.revoked) throw new Error('workbench_goal_revoked');
    if (state.suspended) throw new Error('workbench_goal_stopped');
    const binding = state.binding;
    try {
      signal?.throwIfAborted();
      if (!nativeGoalsFor(agent)) throw new Error('workbench_goal_unavailable');
      const response = await this.request('guard', binding, {}, signal);
      let scope;
      try { scope = trustedScope(response.context, binding); } catch { throw new Error('workbench_goal_binding_changed'); }
      if (state.binding !== binding) throw new Error('workbench_goal_binding_changed');
      if (JSON.stringify(scope) !== JSON.stringify(state.scope) || state.revoked) throw new Error('workbench_goal_binding_changed');
      if (!nativeGoalsFor(agent)) throw new Error('workbench_goal_unavailable');
      const view = validGoal(state.goals.get(agent), state.objective, { goal_id: state.goalId, goal_revision: state.revision });
      if(!state.driverGranted)state.goals.disarm(agent);
      if (view.phase !== 'active') throw new Error('workbench_goal_stopped');
      state.revision = view.revision;
      return { available: true, phase: view.phase };
    } catch (error) { if (state.binding === binding) this.stop(agent, state); throw error; }
  }

  propose(agent,callId,input,route,signal) {
    if(typeof callId!=='string'||!ID.test(callId)||!exactRecord(input,['intent','summary'])
      ||!['continue','wait_user','wait_approval','complete'].includes(input.intent)
      ||typeof input.summary!=='string'||!input.summary.trim()||input.summary.length>2000)
      return Promise.reject(new Error('workbench_goal_proposal_invalid'));
    const previous=this.proposing.get(agent)??Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>this.proposeOne(agent,callId,structuredClone(input),route,signal));
    this.proposing.set(agent,operation);return operation;
  }

  async proposeOne(agent,callId,input,route,signal) {
    const state=this.installed.get(agent);
    if(!state)throw new Error('workbench_goal_binding_missing');
    const binding=state.binding;
    await this.guard(agent,signal);
    if(agent.session?.id!==binding.sessionRef)throw new Error('workbench_goal_identity_conflict');
    if(input.intent==='continue'&&!this.nativeContinuation)return {accepted:false,reason:'automatic_continuation_unavailable'};
    const before=validGoal(state.goals.get(agent),state.objective,{goal_id:state.goalId,goal_revision:state.revision});
    if(input.intent==='continue'&&before.roundsStarted>=before.maxGoalRounds)return {accepted:false,reason:'round_limit'};
    if(input.intent==='continue')await this.prepareStep(agent,route,signal);
    try{
      const response=await this.request('goal-proposal',binding,{call_id:callId,intent:input.intent,summary:input.summary,
        goal_id:before.id,goal_revision:before.revision,...(input.intent==='continue'?{route}:{})},signal);
      await this.guard(agent,signal);
      if(state.binding!==binding||JSON.stringify(trustedScope(response.context,binding))!==JSON.stringify(state.scope))throw new Error('workbench_goal_binding_changed');
      const proposal=response.proposal;
      if(exactRecord(proposal,['accepted','reason'])&&proposal.accepted===false&&proposal.reason==='execution_evidence_required')return structuredClone(proposal);
      const action=input.intent==='continue'?'resume':input.intent==='wait_user'?'pause':'review';
      if(!exactRecord(proposal,['accepted','proposal_id','intent','action','goal_id','goal_revision'])||proposal.accepted!==true
        ||typeof proposal.proposal_id!=='string'||!ID.test(proposal.proposal_id)||proposal.intent!==input.intent||proposal.action!==action
        ||proposal.goal_id!==before.id||proposal.goal_revision!==before.revision)throw new Error('workbench_goal_proposal_invalid');
      const goals=nativeGoalsFor(agent),live=validGoal(goals?.get(agent),state.objective,{goal_id:before.id,goal_revision:before.revision});
      if(live.phase!=='active'||live.revision!==before.revision||live.roundsStarted!==before.roundsStarted)throw new Error('workbench_goal_ref_conflict');
      let applied;
      if(action==='resume'){
        if(!state.driverGranted||live.activation!=='armed'){
          if(typeof goals.resume!=='function')throw new Error('workbench_goal_unavailable');
          applied=goals.resume(agent,{id:live.id,revision:live.revision});
        }else applied=live;
        state.driverGranted=true;
      }else{
        state.driverGranted=false;state.suspended=true;
        applied=goals.pause(agent,{id:live.id,revision:live.revision});goals.disarm(agent);
      }
      state.goals=goals;state.revision=applied.revision;
      const saved=validMapping(await this.bindingStore.save(binding,{goal_id:applied.id,goal_revision:applied.revision},signal));
      if(state.binding!==binding||state.revoked||!saved||saved.goal_id!==applied.id||saved.goal_revision!==applied.revision)throw new Error('workbench_goal_binding_changed');
      const confirmed=validGoal(nativeGoalsFor(agent)?.get(agent),state.objective,saved);
      if(confirmed.revision!==applied.revision||confirmed.roundsStarted!==live.roundsStarted
        ||confirmed.phase!==(action==='resume'?'active':'paused')||confirmed.activation!==(action==='resume'?'armed':'disarmed'))throw new Error('workbench_goal_ref_conflict');
      return {accepted:true,proposal_id:proposal.proposal_id,decision:action==='resume'?'continue':action==='pause'?'waiting_user':'waiting_approval'};
    }catch(error){if(state.binding===binding)this.stop(agent,state);throw error;}
  }

  /** Preliminary native step admission. Actual model routing may change after
   * assembly; llm/stream still reserves/dispatches that exact route. This hook
   * neither arms a driver nor admits/counts its round reservation. */
  async prepareStep(agent,route,signal) {
    const state=this.installed.get(agent);
    if(!state)throw new Error('workbench_goal_binding_missing');
    if(state.revoked)throw new Error('workbench_goal_revoked');
    if(state.suspended)throw new Error('workbench_goal_stopped');
    const binding=state.binding;
    try{
      const live=()=>{
        signal?.throwIfAborted();
        if(state.revoked)throw new Error('workbench_goal_revoked');
        if(state.suspended)throw new Error('workbench_goal_stopped');
        if(state.binding!==binding)throw new Error('workbench_goal_binding_changed');
        if(agent.session?.id!==binding.sessionRef)throw new Error('workbench_goal_identity_conflict');
        // Cordis returns scoped service facades, not stable object identities.
        // Resolve the live service on every boundary and compare durable Goal
        // identity/revision, rather than retaining authority in an old facade.
        const goals=nativeGoalsFor(agent);
        if(!goals||typeof goals.get!=='function')throw new Error('workbench_goal_unavailable');
        const view=validGoal(goals.get(agent),state.objective,{goal_id:state.goalId,goal_revision:state.revision});
        state.goals=goals;
        if(view.phase!=='active')throw new Error('workbench_goal_stopped');
        return view;
      };
      const before=live();
      if(!route||![route.provider,route.model].every(value=>typeof value==='string'&&/^[^\s\p{Cc}]{1,256}$/u.test(value)))
        throw new Error('budget_route_unavailable');
      const response=await this.request('step-admission',binding,{route},signal);
      const after=live();
      if(after.revision!==before.revision||after.roundsStarted!==before.roundsStarted||after.activation!==before.activation)
        throw new Error('workbench_goal_identity_conflict');
      if(JSON.stringify(trustedScope(response.context,binding))!==JSON.stringify(state.scope)
        || !exactRecord(response.context.model_budget,['protocol','enforced'])
        || response.context.model_budget.protocol!==1||response.context.model_budget.enforced!==true)
        throw new Error('workbench_goal_binding_changed');
      const decision=response.admission,preview=decision?.route;
      if(!exactRecord(decision,['protocol','allowed','route'])||decision.protocol!==1||decision.allowed!==true
        || !exactRecord(preview,['provider','model','pricing_revision','reserved','queue_credit'])
        || preview.provider!==route?.provider||preview.model!==route?.model
        || typeof preview.pricing_revision!=='string'||!ID.test(preview.pricing_revision))throw new Error('workbench_step_admission_invalid');
      for(const amounts of [preview.reserved,preview.queue_credit]){
        if(!exactRecord(amounts,['tokens','nano_usd','model_calls'])
          || !Object.values(amounts).every(value=>typeof value==='string'&&/^(0|[1-9][0-9]{0,127})$/.test(value)))
          throw new Error('workbench_step_admission_invalid');
      }
      state.revision=after.revision;
    }catch(error){
      if(state.binding===binding){
        if(!state.revoked&&!state.suspended&&['model_budget_exhausted','budget_usage_unknown','budget_usage_pending','budget_window_closed','budget_policy_stale','budget_route_unavailable','budget_service_unavailable'].includes(error.message)){
          // Inside pre-step the Agent is not idle. Fence and pause synchronously;
          // waiting for whenIdle here would deadlock the very step being denied.
          state.suspended=true;state.driverGranted=false;
          try{
            const goals=nativeGoalsFor(agent);
            if(!goals||typeof goals.get!=='function')throw new Error('workbench_goal_unavailable');
            let view=validGoal(goals.get(agent),state.objective,{goal_id:state.goalId,goal_revision:state.revision});
            state.goals=goals;
            if(view.phase==='active')view=goals.pause(agent,{id:view.id,revision:view.revision});
            goals.disarm(agent);state.revision=view.revision;
            const saved=validMapping(await this.bindingStore.save(binding,{goal_id:view.id,goal_revision:view.revision}));
            if(state.binding!==binding||state.revoked||!saved||saved.goal_id!==view.id||saved.goal_revision!==view.revision)
              throw new Error('workbench_goal_binding_changed');
          }catch(failure){this.stop(agent,state);throw failure;}
        }else if(error.message==='workbench_goal_stopped'&&!state.revoked){
          state.suspended=true;state.driverGranted=false;state.goals.disarm(agent);
        }else this.stop(agent,state);
      }
      throw error;
    }
  }

  /** Read facts only. No lifecycle mutation, continuation admission or business
   * certification is implied by the native phase or tool execution receipts. */
  async observe(agent,signal) {
    const state=this.installed.get(agent);
    if(!state)throw new Error('workbench_goal_binding_missing');
    if(state.revoked)throw new Error('workbench_goal_revoked');
    const binding=state.binding;
    signal?.throwIfAborted();
    if(agent.session?.id!==binding.sessionRef)throw new Error('workbench_goal_identity_conflict');
    const response=await this.request('task-state',binding,{},signal);
    signal?.throwIfAborted();
    if(state.binding!==binding || state.revoked || JSON.stringify(trustedScope(response.context,binding))!==JSON.stringify(state.scope))throw new Error('workbench_goal_binding_changed');
    const goals=nativeGoalsFor(agent);
    if(typeof goals?.get!=='function')throw new Error('workbench_goal_unavailable');
    const goal=validGoal(goals.get(agent),state.objective,{goal_id:state.goalId,goal_revision:state.revision});
    if(!['idle','running'].includes(agent.status))throw new Error('workbench_goal_host_state_invalid');
    return {protocol:1,host_status:agent.status,goal:{goal_id:goal.id,goal_revision:goal.revision,phase:goal.phase,
      activation:goal.activation,rounds_started:goal.roundsStarted,max_goal_rounds:goal.maxGoalRounds},task:validTaskFacts(response.task)};
  }

  /** Host-only CAS stop, not a lifecycle proposal or business completion. */
  async suspend(agent,ref,signal) {
    if(!exactRecord(ref,['goal_id','goal_revision']) || typeof ref.goal_id!=='string' || !ID.test(ref.goal_id)
      || !positive(ref.goal_revision))throw new Error('workbench_goal_ref_invalid');
    const state=this.installed.get(agent),binding=state?.binding;
    const before=await this.observe(agent,signal);
    if(before.goal.goal_id!==ref.goal_id || before.goal.goal_revision!==ref.goal_revision)throw new Error('workbench_goal_ref_conflict');
    const goals=nativeGoalsFor(agent);
    if(typeof agent.cancel!=='function'||typeof agent.whenIdle!=='function'||typeof goals?.pause!=='function'
      ||typeof goals?.disarm!=='function')throw new Error('workbench_goal_stop_unavailable');
    signal?.throwIfAborted();
    if(state.binding!==binding || state.revoked)throw new Error('workbench_goal_revoked');
    const live=validGoal(goals.get(agent),state.objective,{goal_id:state.goalId,goal_revision:state.revision});
    if(live.id!==ref.goal_id||live.revision!==ref.goal_revision)throw new Error('workbench_goal_ref_conflict');
    // Synchronous fencing precedes lifecycle changes and cancel. Tools and the
    // budgeted model boundary cannot slip another dispatch through idle waits.
    state.suspended=true;
    state.driverGranted=false;
    if(live.phase==='active')goals.pause(agent,{id:live.id,revision:live.revision});
    else goals.disarm(agent);
    agent.cancel({kind:'user'});
    let removeAbort=()=>{};
    try{
      const idle=agent.whenIdle();
      if(signal){
        const aborted=new Promise((_,reject)=>{
          const onAbort=()=>reject(signal.reason??new Error('workbench_goal_stop_aborted'));
          signal.addEventListener('abort',onAbort,{once:true});removeAbort=()=>signal.removeEventListener('abort',onAbort);
          if(signal.aborted)onAbort();
        });
        await Promise.race([idle,aborted]);
      }else await idle;
    }finally{removeAbort();}
    const stopped=await this.observe(agent,signal);
    if(stopped.host_status!=='idle'||stopped.goal.activation!=='disarmed'||stopped.goal.phase==='active')throw new Error('workbench_goal_stop_unconfirmed');
    const saved=validMapping(await this.bindingStore.save(binding,{goal_id:stopped.goal.goal_id,goal_revision:stopped.goal.goal_revision},signal));
    if(!saved||saved.goal_id!==stopped.goal.goal_id||saved.goal_revision!==stopped.goal.goal_revision)throw new Error('workbench_goal_binding_invalid');
    const confirmed=await this.observe(agent,signal);
    if(state.binding!==binding||confirmed.host_status!=='idle'||confirmed.goal.activation!=='disarmed'
      ||confirmed.goal.phase==='active'||confirmed.goal.goal_revision!==stopped.goal.goal_revision)throw new Error('workbench_goal_stop_unconfirmed');
    const session=agent.session;
    if(!Number.isSafeInteger(session?.seq)||session.seq<1||typeof session.eventAt!=='function')throw new Error('checkpoint_boundary_invalid');
    let lastEnd=-1;
    for(let seq=session.seq-1;seq>=0;seq--)if(session.eventAt(seq)?.type==='turn/end'){lastEnd=seq;break;}
    if(lastEnd<0)throw new Error('checkpoint_boundary_invalid');
    state.revision=confirmed.goal.goal_revision;
    return {state:confirmed,turn_end_seq:lastEnd};
  }

  /** Host-only completion. The authenticated Gateway must authorize the exact
   * persisted intent on every call; neither a model ref nor a completed label
   * is sufficient. Synchronous native CAS follows the final authority await. */
  async complete(agent,intentId,signal){
    const state=this.installed.get(agent),binding=state?.binding;
    if(!state||state.revoked||typeof intentId!=='string'||!ID.test(intentId))throw new Error('workbench_goal_completion_forbidden');
    const response=await this.request('completion-intent',binding,{intent_id:intentId},signal),intent=response?.intent;
    signal?.throwIfAborted();
    if(state.revoked||state.binding!==binding||agent.session?.id!==binding.sessionRef)throw new Error('workbench_goal_revoked');
    const before=intent?.before,expected=before?.goal;
    if(!exactRecord(intent,['intent_id','session_ref','before','checkpoint'])||intent.intent_id!==intentId||intent.session_ref!==binding.sessionRef
      ||!exactRecord(before,['host_status','goal'])||before.host_status!=='idle'
      ||!exactRecord(expected,['goal_id','goal_revision','phase','activation','rounds_started','max_goal_rounds'])
      ||!ID.test(expected.goal_id)||!positive(expected.goal_revision)||!positive(expected.max_goal_rounds)
      ||!Number.isSafeInteger(expected.rounds_started)||expected.rounds_started<0||expected.rounds_started>expected.max_goal_rounds
      ||!['paused','blocked'].includes(expected.phase)||expected.activation!=='disarmed')throw new Error('workbench_goal_completion_invalid');
    const goals=nativeGoalsFor(agent);
    let goal=validGoal(goals?.get?.(agent),state.objective,{goal_id:state.goalId,goal_revision:state.revision});
    if(agent.status!=='idle'||goal.activation!=='disarmed'||goal.id!==expected.goal_id
      ||goal.roundsStarted!==expected.rounds_started||goal.maxGoalRounds!==expected.max_goal_rounds)throw new Error('workbench_goal_ref_conflict');
    state.suspended=true;state.driverGranted=false;
    if(goal.revision===expected.goal_revision&&goal.phase===expected.phase){
      if(typeof goals.complete!=='function')throw new Error('workbench_goal_completion_unavailable');
      goal=goals.complete(agent,{id:goal.id,revision:goal.revision});
    }else if(goal.revision!==expected.goal_revision+1||goal.phase!=='complete')throw new Error('workbench_goal_ref_conflict');
    validGoal(goal,state.objective,{goal_id:state.goalId,goal_revision:expected.goal_revision+1});
    if(goal.revision!==expected.goal_revision+1||goal.phase!=='complete'||goal.activation!=='disarmed'
      ||goal.roundsStarted!==expected.rounds_started||goal.maxGoalRounds!==expected.max_goal_rounds||agent.status!=='idle')throw new Error('workbench_goal_ref_conflict');
    state.revision=goal.revision;
    return {intent,state:{host_status:'idle',goal:{goal_id:goal.id,goal_revision:goal.revision,phase:goal.phase,
      activation:goal.activation,rounds_started:goal.roundsStarted,max_goal_rounds:goal.maxGoalRounds}}};
  }

  stop(agent, state) {
    // Revocation is monotonic even when the host projection itself is damaged.
    state.revoked = true;
    state.driverGranted = false;
    try {
      const view = state.goals.disarm(agent);
      if (view?.id === state.goalId && view.phase === 'active') {
        state.goals.pause(agent, { id: view.id, revision: view.revision });
      }
    } catch { /* Gateway and tool guard continue to deny execution. */ }
  }

  async revoke(agent) {
    this.revocationEpoch.set(agent, (this.revocationEpoch.get(agent) ?? 0) + 1);
    const state = this.installed.get(agent);
    if (state || this.pending.has(agent)) this.revoked.add(agent);
    if (state) this.stop(agent, state);
  }
}
