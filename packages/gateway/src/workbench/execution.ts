import {TaskReplyDrafts} from '../persistent-tasks/reply-drafts.ts';
import {TaskReplySemanticChecks} from '../persistent-tasks/reply-semantic.ts';
import type {ReplyJudgeClient} from '../persistent-tasks/reply-judge-client.ts';
import {createAuxiliaryRunGuard} from './auxiliary-run-guard.ts';
import {assertExecutionLease,normalizeExecutionLease} from './execution-lease.ts';
import {WebDecisionBudgetService} from './web-decision-budget.ts';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { withImmediateTransaction } from '../db/database.ts';
import type { WorkbenchService, AgentRunContext } from './service.ts';
import type { PersistentTaskService } from '../persistent-tasks/service.ts';
import { readPublicPage } from '../persistent-tasks/public-page.ts';
import { PersistentTaskAssessmentService } from '../persistent-tasks/assessments.ts';
import type { AssessmentObservations,SaveAssessmentInput } from '../persistent-tasks/assessments.ts';
import { TaskExecutionEvidence } from '../persistent-tasks/execution-evidence.ts';
import {assertTaskDependenciesReady,eligibleTaskOccurrence} from '../persistent-tasks/execution-eligibility.ts';
import {occurrenceSubtaskRows} from '../persistent-tasks/subtask-state.ts';
import type { ModelBudgetLedger, ModelBudgetRequest } from './model-budget.ts';
import type {TaskCollaborationService} from './task-collaboration.ts';
import {savedSessionCheckpoint} from '../harness/session-checkpoints.ts';
import {installTaskCompletionCandidates} from '../persistent-tasks/completion-candidates.ts';
import {installTaskBusinessReviews,currentTaskBusinessCertificate} from '../persistent-tasks/business-review.ts';
import {installTaskCompletionHandshake,preparedTaskCompletion,confirmTaskCompletion} from '../persistent-tasks/completion-handshake.ts';
import {installTaskFinalizations} from '../persistent-tasks/finalization.ts';

export const WORKBENCH_TOOL_IDS = ['universe_capabilities', 'universe_search'];

type Input = Record<string, unknown>;
type TaskBinding = {task_id:string;occurrence_id:string;task_version:number;generation:number;title:string;objective:string;root_run_id:string;continuation_of:string|null};
function object(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_workbench_request');
  return value as Input;
}
function fields(input: Input, keys: string[]) {
  if (Object.keys(input).some(key => key!=='execution_lease'&&!keys.includes(key))) throw new Error('workbench_identity_forbidden');
  if(input.execution_lease!==undefined)normalizeExecutionLease(input.execution_lease);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Input;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Only the local authenticated DSH host may resolve a product run's identity. */
export function registerWorkbenchExecution(app: FastifyInstance, db: DatabaseSync,
  workbench: WorkbenchService, tasks: PersistentTaskService, token: string | undefined, modelBudgets?: ModelBudgetLedger,collaboration?:TaskCollaborationService,replyJudge?:ReplyJudgeClient) {
  db.exec(`CREATE TABLE IF NOT EXISTS wb_tool_receipts (
    run_id TEXT NOT NULL REFERENCES ga_runs(id), call_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(run_id,call_id));
    CREATE TABLE IF NOT EXISTS wb_native_goal_bindings (
      run_id TEXT PRIMARY KEY REFERENCES ga_runs(id),occurrence_id TEXT NOT NULL UNIQUE,
      goal_id TEXT NOT NULL,goal_revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  const assessments=new PersistentTaskAssessmentService(db);
  const executionEvidence = new TaskExecutionEvidence(db);
  const replyDrafts=new TaskReplyDrafts(db);
  const replyChecks=replyJudge?new TaskReplySemanticChecks(db):undefined;
  if(replyJudge&&!modelBudgets)throw new Error('reply_judge_budget_required');
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_goal_proposals (
    proposal_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES ga_runs(id),occurrence_id TEXT NOT NULL,
    call_id TEXT NOT NULL,goal_id TEXT NOT NULL,goal_revision INTEGER NOT NULL,
    intent TEXT NOT NULL,summary TEXT NOT NULL,action TEXT NOT NULL,snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL,UNIQUE(run_id,call_id));
    CREATE TRIGGER IF NOT EXISTS wb_goal_proposal_no_update BEFORE UPDATE ON wb_task_goal_proposals
      BEGIN SELECT RAISE(ABORT,'goal_proposal_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS wb_goal_proposal_no_delete BEFORE DELETE ON wb_task_goal_proposals
      BEGIN SELECT RAISE(ABORT,'goal_proposal_immutable'); END;`);
  installTaskCompletionCandidates(db);
  installTaskBusinessReviews(db);
  installTaskCompletionHandshake(db);
  installTaskFinalizations(db);
  app.post('/internal/v1/workbench/completion-recovery',async request=>{
    authorized(request.headers.authorization);
    const input=object(request.body);fields(input,['run_id','session_ref']);
    return withImmediateTransaction(db,()=>{
      const identity=context(input),certificate=currentTaskBusinessCertificate(db,identity.owner_id,identity.run_id);
      if(db.prepare('SELECT 1 FROM wb_task_completion_intents WHERE run_id=?').get(identity.run_id))throw new Error('task_completion_handshake_conflict');
      const checkpoint=savedSessionCheckpoint(db,identity.run_id);
      if(!checkpoint||checkpoint.session_ref!==input.session_ref)throw new Error('task_completion_handshake_conflict');
      return {recovery:{certificate_id:certificate.certificate_id,checkpoint}};
    });
  });
  app.post('/internal/v1/workbench/completion-intent',async request=>{
    authorized(request.headers.authorization);
    const input=object(request.body);fields(input,['run_id','session_ref','intent_id']);
    return withImmediateTransaction(db,()=>{
      const identity=context(input),intent=preparedTaskCompletion(db,identity.owner_id,identity.run_id);
      if(intent.intent_id!==input.intent_id||intent.session_ref!==input.session_ref)throw new Error('task_completion_handshake_conflict');
      return {intent};
    });
  });
  app.post('/internal/v1/workbench/completion-confirm',async request=>{
    authorized(request.headers.authorization);
    const input=object(request.body);fields(input,['run_id','session_ref','intent_id','proof']);
    if(typeof input.intent_id!=='string')throw new Error('task_completion_handshake_invalid');
    return withImmediateTransaction(db,()=>confirmTaskCompletion(db,accountingOwner(input),String(input.run_id),input.intent_id as string,input.proof));
  });
  function validCallId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
  }
  function savedCall(runId: string, callId: string, digest: string): unknown | undefined {
    const prior = db.prepare('SELECT request_hash,response_json FROM wb_tool_receipts WHERE run_id=? AND call_id=?')
      .get(runId, callId) as {request_hash: string; response_json: string} | undefined;
    if (!prior) return undefined;
    if (prior.request_hash !== digest) throw new Error('idempotency_conflict');
    return JSON.parse(prior.response_json);
  }
  function saveCall(runId: string, callId: string, digest: string, result: unknown) {
    db.prepare('INSERT INTO wb_tool_receipts VALUES(?,?,?,?,?)').run(runId, callId, digest, JSON.stringify(result), new Date().toISOString());
  }
  function authorized(header: unknown) {
    const expected = Buffer.from(`Bearer ${token ?? ''}`), actual = Buffer.from(String(header ?? ''));
    if (!token || token.length < 16 || expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('unauthorized');
  }
  function taskBinding(runId:string,owner:string):TaskBinding|undefined {
    const row=db.prepare(`SELECT t.task_id,t.title,t.objective,t.version AS task_version,o.occurrence_id,o.generation,o.root_run_id,o.parent_run_id AS continuation_of
      FROM wb_task_run_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id
      WHERE o.run_id=? AND t.owner_id=?`).get(runId,owner) as TaskBinding|undefined;
    return row ? {...row} : undefined;
  }
  function requireTask(identity:AgentRunContext):TaskBinding {
    const task=taskBinding(identity.run_id,identity.owner_id);
    if(!task)throw new Error('workbench_task_scope_forbidden');
    return task;
  }
  function accountingOwner(input: Input): string {
    if (typeof input.run_id !== 'string' || typeof input.session_ref !== 'string') throw new Error('workbench_identity_forbidden');
    const binding = db.prepare(`SELECT s.owner_id FROM ga_harness_session_bindings s
      JOIN ga_runs r ON r.conversation_id=s.conversation_id JOIN ga_conversations c ON c.id=r.conversation_id
      JOIN wb_run_bindings w ON w.run_id=r.id AND w.owner_id=s.owner_id
      WHERE s.session_id=? AND r.id=? AND c.owner_id=s.owner_id`).get(input.session_ref,input.run_id) as {owner_id:string}|undefined;
    if (!binding) throw new Error('workbench_identity_forbidden');
    // Already-dispatched usage remains chargeable after role/task revocation.
    // This identity lookup confers no model/tool execution authority.
    return binding.owner_id;
  }
  function budgetContext(owner: string, runId: string): {model_budget?:{protocol:1;enforced:true}} {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_model_budget_bindings'").get();
    const bound = exists && db.prepare('SELECT 1 FROM wb_model_budget_bindings WHERE owner_id=? AND run_id=?').get(owner,runId);
    if (!bound) return {};
    if (!modelBudgets) throw new Error('budget_service_unavailable');
    return {model_budget:{protocol:1,enforced:true}};
  }
  function context(input: Input): AgentRunContext & {task_binding?:TaskBinding;model_budget?:{protocol:1;enforced:true}} {
    if (typeof input.run_id !== 'string' || typeof input.session_ref !== 'string') throw new Error('workbench_identity_forbidden');
    const binding = db.prepare(`SELECT b.owner_id,b.conversation_id FROM ga_harness_session_bindings b
      JOIN ga_runs r ON r.conversation_id=b.conversation_id WHERE b.session_id=? AND r.id=?`)
      .get(input.session_ref, input.run_id) as {owner_id: string; conversation_id: string} | undefined;
    if (!binding) throw new Error('workbench_identity_forbidden');
    if(input.execution_lease!==undefined)assertExecutionLease(db,input.run_id,input.execution_lease);
    workbench.assertRunActive(input.run_id); tasks.assertRunActive(input.run_id);
    const saved = workbench.contextForRun(input.run_id);
    const resolved = saved ? {...saved, allowed_tools: saved.allowed_tools.filter(tool => WORKBENCH_TOOL_IDS.includes(tool))} : null;
    if (!resolved || resolved.owner_id !== binding.owner_id) throw new Error('workbench_identity_forbidden');
    if (input.tool_name !== undefined && (typeof input.tool_name !== 'string'
      || !(resolved.allowed_tools.includes(input.tool_name) || input.tool_name === 'jot_workspace'))) throw new Error('workbench_tool_forbidden');
    if(resolved.kind==='task'&&input.tool_name!==undefined&&input.tool_name!=='jot_workspace')
      assertTaskDependenciesReady(db,executionEvidence,resolved.owner_id,requireTask(resolved).task_id,resolved.run_id);
    return {...resolved,...(resolved.kind==='task'?{task_binding:requireTask(resolved)}:{}),...budgetContext(resolved.owner_id,resolved.run_id)};
  }
  function assertTaskModelAccounting(task:TaskBinding) {
    const unresolved=db.prepare(`SELECT a.state,a.bound_exceeded FROM wb_model_budget_attempts a
      JOIN wb_task_run_occurrences o ON o.run_id=a.run_id
      WHERE o.occurrence_id=? AND (a.state IN ('unknown','in_flight') OR a.bound_exceeded=1)
      ORDER BY CASE a.state WHEN 'unknown' THEN 0 WHEN 'in_flight' THEN 1 ELSE 2 END LIMIT 1`).get(task.occurrence_id) as {state:string;bound_exceeded:number}|undefined;
    if(unresolved)throw new Error(unresolved.state==='unknown'?'budget_usage_unknown':unresolved.state==='in_flight'?'budget_usage_pending':'model_budget_exhausted');
  }
  const webBudgets=modelBudgets&&token&&token.length>=16?new WebDecisionBudgetService(db,{ledger:modelBudgets,secret:token,guard:(owner,run)=>createAuxiliaryRunGuard(db,workbench,tasks,owner,run)}):undefined;
  app.post('/internal/v1/workbench/web-budget-grant',async request=>{
    authorized(request.headers.authorization);const input=object(request.body);fields(input,['run_id','session_ref','call_id','tool_name','request_hash']);if(typeof input.call_id!=='string'||typeof input.request_hash!=='string')throw new Error('invalid_web_budget_request');if(!webBudgets)throw new Error('budget_service_unavailable');
    return withImmediateTransaction(db,()=>{assertExecutionLease(db,String(input.run_id),input.execution_lease);const identity=context(input);if(!identity.model_budget||typeof input.tool_name!=='string'||!identity.allowed_tools.includes(input.tool_name))throw new Error('workbench_tool_forbidden');if(identity.task_binding)assertTaskModelAccounting(identity.task_binding);return webBudgets.mint(identity.owner_id,identity.run_id,String(input.session_ref),String(input.call_id),input.tool_name,String(input.request_hash));});
  });
  app.post('/internal/v1/workbench/web-budget-grant/close',async request=>{
    authorized(request.headers.authorization);const input=object(request.body);fields(input,['run_id','session_ref','call_id']);if(typeof input.call_id!=='string')throw new Error('invalid_web_budget_request');if(!webBudgets)throw new Error('budget_service_unavailable');return webBudgets.close(accountingOwner(input),String(input.run_id),input.call_id);
  });
  app.post('/internal/v1/workbench/web-model-budget',async request=>{
    if(!webBudgets)throw new Error('budget_service_unavailable');const header=String(request.headers.authorization??'');if(!header.startsWith('Bearer '))throw new Error('unauthorized');return webBudgets.command(header.slice(7),object(request.body));
  });
  app.post('/internal/v1/workbench/model-budget',async request=>{
    authorized(request.headers.authorization);
    const input=object(request.body);
    const allowed:Record<string,string[]>={reserve:['request'],dispatch:['attempt_id'],settle:['attempt_id','usage'],unknown:['attempt_id','reason'],release:['attempt_id']};
    const action=String(input.action??'');if(!allowed[action])throw new Error('budget_request_invalid');
    fields(input,['run_id','session_ref','action',...allowed[action]!]);
    if(!modelBudgets)throw new Error('budget_service_unavailable');
    return withImmediateTransaction(db,()=>{
      const owner=accountingOwner(input),runId=String(input.run_id);
      if(action==='reserve'||action==='dispatch'){
        assertExecutionLease(db,runId,input.execution_lease);
        const identity=context(input);
        if(identity.task_binding)assertTaskModelAccounting(identity.task_binding);
      }
      if(action==='reserve')return {receipt:modelBudgets.reserve(owner,runId,input.request as ModelBudgetRequest)};
      if(!validCallId(input.attempt_id))throw new Error('budget_request_invalid');
      const attemptId=String(input.attempt_id);
      if(action==='dispatch')return {receipt:modelBudgets.dispatch(owner,runId,attemptId)};
      if(action==='settle')return {receipt:modelBudgets.settle(owner,runId,attemptId,input.usage)};
      if(action==='unknown')return {receipt:modelBudgets.markUnknown(owner,runId,attemptId,String(input.reason??''))};
      return {receipt:modelBudgets.releaseUndispatched(owner,runId,attemptId)};
    });
  });
  app.post('/internal/v1/workbench/guard', async request => {
    authorized(request.headers.authorization);
    const input = object(request.body); fields(input, ['run_id', 'session_ref', 'tool_name']);
    return { context: context(input) };
  });
  app.post('/internal/v1/workbench/task-state',async request=>{
    authorized(request.headers.authorization);
    const input=object(request.body);fields(input,['run_id','session_ref']);
    return withImmediateTransaction(db,()=>{
      const identity=context(input),task=requireTask(identity);
      if(!eligibleTaskOccurrence(db,identity.owner_id,task.task_id,identity.run_id))throw new Error('task_execution_revoked');
      const current=db.prepare(`SELECT o.business_state,r.status AS run_status FROM wb_task_current_occurrences o
        JOIN ga_runs r ON r.id=o.run_id WHERE o.run_id=? AND o.occurrence_id=?`).get(identity.run_id,task.occurrence_id) as {business_state:string;run_status:string}|undefined;
      if(!current)throw new Error('task_execution_revoked');
      const steps=occurrenceSubtaskRows(db,task.task_id,task.occurrence_id);
      const completed=steps.filter(step=>step.status==='completed');
      const verified=completed.filter(step=>executionEvidence.completionVerified(identity.owner_id,task.task_id,JSON.parse(step.evidence_json),task.occurrence_id));
      const unresolved=identity.model_budget?db.prepare(`SELECT
        SUM(CASE WHEN a.state='unknown' THEN 1 ELSE 0 END) AS pending_unknown,
        SUM(CASE WHEN a.state='in_flight' THEN 1 ELSE 0 END) AS pending_in_flight
        FROM wb_model_budget_attempts a JOIN wb_task_run_occurrences o ON o.run_id=a.run_id
        WHERE o.occurrence_id=?`).get(task.occurrence_id) as {pending_unknown:number|null;pending_in_flight:number|null}:null;
      return {context:identity,task:{...current,steps:{total:steps.length,completed:completed.length,evidence_verified:verified.length,
        all_completed:steps.length>0&&completed.length===steps.length,
        all_execution_evidence_verified:steps.length>0&&verified.length===steps.length},
        budget:identity.model_budget?{configured:true,balances:modelBudgets!.balancesForRun(identity.owner_id,identity.run_id),
          pending_unknown:Number(unresolved?.pending_unknown??0),pending_in_flight:Number(unresolved?.pending_in_flight??0)}
          :{configured:false,balances:[],pending_unknown:null,pending_in_flight:null}}};
    });
  });
  app.post('/internal/v1/workbench/step-admission',async request=>{
    authorized(request.headers.authorization);
    const input=object(request.body);fields(input,['run_id','session_ref','route']);
    return withImmediateTransaction(db,()=>{
      const identity=context(input),task=requireTask(identity);
      if(!eligibleTaskOccurrence(db,identity.owner_id,task.task_id,identity.run_id))throw new Error('task_execution_revoked');
      const run=db.prepare('SELECT status FROM ga_runs WHERE id=?').get(identity.run_id) as {status:string}|undefined;
      if(!run||!['starting','running'].includes(run.status))throw new Error('budget_run_inactive');
      if(!identity.model_budget||!modelBudgets)throw new Error('budget_service_unavailable');
      // Check the whole continuation lineage, not just the current leaf. A
      // checkpoint or child run cannot erase an unresolved parent's spend.
      assertTaskModelAccounting(task);
      const route=modelBudgets.previewCall(identity.owner_id,identity.run_id,input.route as {provider:string;model:string;max_tokens?:number});
      return {context:identity,admission:{protocol:1,allowed:true,route}};
    });
  });
  app.post('/internal/v1/workbench/checkpoint',async request=>{
    authorized(request.headers.authorization);
    const input=object(request.body);fields(input,['run_id','session_ref']);
    context(input);
    const checkpoint=savedSessionCheckpoint(db,String(input.run_id),String(input.session_ref));
    if(!checkpoint)throw new Error('task_checkpoint_unavailable');
    return {checkpoint};
  });
  app.post('/internal/v1/workbench/goal-binding',async request=>{
    authorized(request.headers.authorization);
    const input=object(request.body);fields(input,['run_id','session_ref','action','goal_id','goal_revision']);
    return withImmediateTransaction(db,()=>{
      const identity=context(input),task=requireTask(identity);
      const prior=db.prepare('SELECT goal_id,goal_revision FROM wb_native_goal_bindings WHERE run_id=? AND occurrence_id=?').get(task.root_run_id,task.occurrence_id) as {goal_id:string;goal_revision:number}|undefined;
      if(input.action==='get'){
        if(input.goal_id!==undefined||input.goal_revision!==undefined)throw new Error('invalid_goal_binding');
        return {binding:prior??null};
      }
      if(input.action!=='save'||typeof input.goal_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(input.goal_id)||!Number.isSafeInteger(input.goal_revision)||Number(input.goal_revision)<1)throw new Error('invalid_goal_binding');
      if(prior&&(prior.goal_id!==input.goal_id||prior.goal_revision>Number(input.goal_revision)))throw new Error('goal_binding_state_conflict');
      const now=new Date().toISOString();
      db.prepare(`INSERT INTO wb_native_goal_bindings VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET goal_revision=excluded.goal_revision,updated_at=excluded.updated_at`)
        .run(task.root_run_id,task.occurrence_id,input.goal_id,Number(input.goal_revision),now,now);
      return {binding:{goal_id:input.goal_id,goal_revision:input.goal_revision}};
    });
  });
  app.post('/internal/v1/workbench/goal-proposal',async request=>{
    authorized(request.headers.authorization);
    const input=object(request.body);fields(input,['run_id','session_ref','call_id','goal_id','goal_revision','intent','summary','route']);
    if(!validCallId(input.call_id)||!validCallId(input.goal_id)||!Number.isSafeInteger(input.goal_revision)||Number(input.goal_revision)<1
      || typeof input.intent!=='string'||!['continue','wait_user','wait_approval','complete'].includes(input.intent)
      || typeof input.summary!=='string'||!input.summary.trim()||input.summary.length>2000
      || (input.intent!=='continue'&&input.route!==undefined))throw new Error('invalid_goal_proposal');
    const summary=input.summary.trim();
    return withImmediateTransaction(db,()=>{
      const identity=context(input),task=requireTask(identity);
      if(!eligibleTaskOccurrence(db,identity.owner_id,task.task_id,identity.run_id))throw new Error('task_execution_revoked');
      const status=db.prepare('SELECT status FROM ga_runs WHERE id=?').get(identity.run_id) as {status:string}|undefined;
      if(!status||!['starting','running'].includes(status.status))throw new Error('budget_run_inactive');
      const digest=createHash('sha256').update(canonical({operation:'goal-proposal',input})).digest('hex');
      const cached=savedCall(identity.run_id,String(input.call_id),digest);if(cached!==undefined)return cached;
      const native=db.prepare('SELECT goal_id,goal_revision FROM wb_native_goal_bindings WHERE run_id=? AND occurrence_id=?').get(task.root_run_id,task.occurrence_id) as {goal_id:string;goal_revision:number}|undefined;
      if(!native||native.goal_id!==input.goal_id||native.goal_revision!==input.goal_revision)throw new Error('goal_binding_state_conflict');
      if(!identity.model_budget||!modelBudgets)throw new Error('budget_service_unavailable');
      assertTaskModelAccounting(task);
      if(input.intent==='continue')modelBudgets.previewCall(identity.owner_id,identity.run_id,input.route as {provider:string;model:string;max_tokens?:number});
      const steps=occurrenceSubtaskRows(db,task.task_id,task.occurrence_id);
      if(input.intent==='complete'&&(!steps.length||steps.some(step=>step.status!=='completed'
        ||!executionEvidence.completionVerified(identity.owner_id,task.task_id,JSON.parse(step.evidence_json),task.occurrence_id)))){
        const result={context:identity,proposal:{accepted:false,reason:'execution_evidence_required'}};
        saveCall(identity.run_id,String(input.call_id),digest,result);return result;
      }
      const action=input.intent==='continue'?'resume':input.intent==='wait_user'?'pause':'review';
      const proposalId=`goal-proposal-${randomUUID()}`;
      const snapshot={objective:task.objective,task_version:task.task_version,generation:task.generation,
        steps:steps.map(step=>({subtask_id:step.subtask_id,version:step.version,acceptance:step.acceptance,status:step.status,evidence:JSON.parse(step.evidence_json)}))};
      db.prepare('INSERT INTO wb_task_goal_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(proposalId,identity.run_id,task.occurrence_id,String(input.call_id),String(input.goal_id),Number(input.goal_revision),String(input.intent),summary,action,JSON.stringify(snapshot),new Date().toISOString());
      if(action!=='resume'){
        // This is a request for input/review, not proof of a stopped Agent or
        // business completion. The existing stop/checkpoint/worker handshake
        // must confirm quiescence before it releases the execution lease.
        db.prepare('UPDATE wb_task_occurrences SET business_state=? WHERE occurrence_id=?').run(action==='review'?'approval_requested':'input_requested',task.occurrence_id);
        db.prepare('UPDATE wb_persistent_tasks SET projection_pending=1 WHERE task_id=?').run(task.task_id);
      }else{
        db.prepare("UPDATE wb_task_occurrences SET business_state='running' WHERE occurrence_id=? AND business_state IN ('input_requested','approval_requested')").run(task.occurrence_id);
      }
      const result={context:identity,proposal:{accepted:true,proposal_id:proposalId,intent:input.intent,action,goal_id:input.goal_id,goal_revision:input.goal_revision}};
      saveCall(identity.run_id,String(input.call_id),digest,result);return result;
    });
  });
  app.post('/internal/v1/workbench/tool', async request => {
    authorized(request.headers.authorization);
    const input = object(request.body); fields(input, ['run_id', 'session_ref', 'operation', 'arguments', 'call_id']);
    if (input.operation === 'web.read') {
      const identity = context({...input, tool_name: 'jot_workspace'});
      const args = object(input.arguments); fields(args, ['url']);
      if (typeof args.url !== 'string' || args.url.length > 2048) throw new Error('invalid_page_url');
      const task = identity.task_binding;
      if (task && !validCallId(input.call_id)) throw new Error('invalid_call_id');
      const digest = createHash('sha256').update(canonical({operation: 'web.read', args})).digest('hex');
      if (task) {
        const prior = savedCall(identity.run_id, String(input.call_id), digest);
        if (prior !== undefined) return prior;
        assertTaskDependenciesReady(db,executionEvidence,identity.owner_id,task.task_id,identity.run_id);
      }
      // This HTTP reader pins a public address at every redirect. It never
      // inherits browser cookies, private network access or script execution.
      const page = await readPublicPage(args.url);
      return withImmediateTransaction(db, () => {
        context({...input, tool_name: 'jot_workspace'});
        const result = {url: page.url, text: page.text.slice(0, 12000), truncated: page.text.length > 12000,
          mode: 'public_http', trusted: false};
        if (!task) return result;
        const prior = savedCall(identity.run_id, String(input.call_id), digest);
        if (prior !== undefined) return prior;
        assertTaskDependenciesReady(db,executionEvidence,identity.owner_id,task.task_id,identity.run_id);
        const response = {...result, execution_receipt: executionEvidence.record(identity.run_id, String(input.call_id), 'web.read', result)};
        saveCall(identity.run_id, String(input.call_id), digest, response);
        return response;
      });
    }
    const toolResult=withImmediateTransaction(db, () => {
      const identity = context({...input, tool_name: 'jot_workspace'});
      const args = object(input.arguments), operation = String(input.operation ?? '');
      const { owner_id: owner, workspace_id: workspace, project_id: project, run_id: runId } = identity;
      const keys: Record<string, string[]> = {
        'agents.list': [], 'messages.list': [],
        'messages.send': ['recipient_agent_id', 'text', 'client_message_id'],
        'memory.list': ['q'], 'memory.save': ['scope', 'content', 'memory_id', 'expected_version', 'provenance', 'source_revision', 'expires_at', 'supersedes'],
        'files.list': [], 'files.read': ['path'], 'files.write': ['path', 'content', 'expected_version'],
        'tasks.get': [],'tasks.subtasks': ['occurrence_id'],
        'tasks.upsert': ['subtask_id','expected_version','title','acceptance','priority','status','dependencies','evidence'],
        'tasks.delegate':['subtask_id','expected_subtask_version','recipient_agent_id'],
        'tasks.evidence': ['evidence'],
        'tasks.assessment': ['subtask_id','observations'],
        'tasks.observe': ['subtask_id','observations'],
        'tasks.assess': ['subtask_id','expected_task_version','expected_subtask_version','expected_assessment_revision','expected_observation_revision','observations','expires_at'],
        'tasks.next': [],'tasks.reply_draft':['text','evidence'],'tasks.reply_drafts':[],
      };
      if (!keys[operation]) throw new Error('invalid_workspace_operation');
      fields(args, keys[operation]!);
      const mutating = ['messages.send', 'memory.save', 'files.write','tasks.upsert','tasks.evidence','tasks.assess','tasks.delegate','tasks.reply_draft'].includes(operation);
      const attested = !!identity.task_binding && !operation.startsWith('tasks.');
      const receipted = mutating || attested;
      const callId = input.call_id;
      if (receipted && !validCallId(callId)) throw new Error('invalid_call_id');
      const digest = createHash('sha256').update(canonical({operation, args})).digest('hex');
      if (receipted) {
        const prior = savedCall(runId, String(callId), digest);
        if (prior !== undefined && operation!=='tasks.delegate') return prior;
      }
      if(identity.task_binding&&!operation.startsWith('tasks.'))
        assertTaskDependenciesReady(db,executionEvidence,owner,identity.task_binding.task_id,runId);
      let result: unknown;
      switch (operation) {
        case 'agents.list': result = {items: workbench.listAgents(owner).items.filter(agent => agent.workspace_id === workspace && agent.project_id === project && agent.status === 'active')}; break;
        case 'messages.list': result = workbench.listMessages(owner, workspace, runId); break;
        case 'messages.send': result = workbench.sendMessage(owner, workspace,
          {...args, client_message_id: `tool-${createHash('sha256').update(`${runId}\0${String(callId)}`).digest('hex')}`}, runId); break;
        case 'memory.list': result = workbench.listMemory(owner, workspace, args, runId); break;
        case 'memory.save': result = workbench.saveMemory(owner, workspace, {...args, project_id: project, verified: false}, runId); break;
        case 'files.list': result = workbench.listFiles(owner, workspace, project, runId); break;
        case 'files.read':
          if (typeof args.path !== 'string') throw new Error('invalid_file_path');
          result = workbench.readFile(owner, workspace, project, args.path, runId); break;
        case 'files.write': result = workbench.writeFile(owner, workspace, {...args, project_id: project}, runId); break;
        case 'tasks.get': {
          const task=requireTask(identity);result={task:tasks.get(owner,task.task_id),occurrence:tasks.occurrences(owner,task.task_id).items.find(item=>item.occurrence_id===task.occurrence_id),collaboration:collaboration?.get(owner,task.task_id)??{enabled:false}};break;
        }
        case 'tasks.delegate': {
          requireTask(identity);if(!collaboration)throw new Error('task_collaboration_forbidden');
          result=collaboration.delegateByLead(owner,runId,{...args,client_message_id:`dsh-${createHash('sha256').update(`${runId}\0${String(callId)}`).digest('hex')}`} as Parameters<TaskCollaborationService['delegateByLead']>[2]);break;
        }
        case 'tasks.subtasks': {
          if(args.occurrence_id!==undefined&&(typeof args.occurrence_id!=='string'||!args.occurrence_id.length||args.occurrence_id.length>200))throw new Error('invalid_occurrence_id');
          result=tasks.subtasks(owner,requireTask(identity).task_id,args.occurrence_id as string|undefined);break;
        }
        case 'tasks.upsert': {
          const task = requireTask(identity);
          const existing = args.subtask_id ? tasks.subtasks(owner, task.task_id).items.find(item => item.subtask_id === args.subtask_id) : undefined;
          if ((args.status ?? existing?.status) === 'completed') {
            const refs = args.evidence ?? existing?.evidence ?? [];
            if (!Array.isArray(refs) || !refs.length) throw new Error('evidence_required');
            const verified = (ref: unknown) => !!ref && typeof ref === 'object'
              && executionEvidence.verified(owner, task.task_id, ref as {kind:string;reference:string;hash?:string}, task.occurrence_id);
            if (!refs.some(verified) || refs.some(ref => ref?.kind === 'tool_receipt' && !verified(ref))) throw new Error('invalid_completion_evidence');
          }
          result=tasks.upsertSubtask(owner,task.task_id,args,runId);break;
        }
        case 'tasks.evidence': {
          const task=requireTask(identity);result=tasks.recordEvidence(owner,task.task_id,task.occurrence_id,args.evidence);break;
        }
        case 'tasks.assessment': result=assessments.assessment(owner,requireTask(identity).task_id,args.subtask_id as string|undefined,args.observations as AssessmentObservations|undefined);break;
        case 'tasks.observe': {
          const task=requireTask(identity),subtaskId=args.subtask_id as string|undefined;
          const view=assessments.assessment(owner,task.task_id,subtaskId);
          const subtask=subtaskId?tasks.subtasks(owner,task.task_id).items.find(item=>item.subtask_id===subtaskId):undefined;
          result={expected_task_version:task.task_version,...(subtask?{expected_subtask_version:subtask.version}:{}),expected_assessment_revision:view.latest?.revision??0,
            expected_observation_revision:assessments.observationRevision(owner,task.task_id,subtaskId,args.observations as AssessmentObservations)};break;
        }
        case 'tasks.assess': result=assessments.saveAssessment(owner,requireTask(identity).task_id,args as SaveAssessmentInput);break;
        case 'tasks.reply_draft': {
          requireTask(identity);assertTaskDependenciesReady(db,executionEvidence,owner,identity.task_binding!.task_id,runId);
          const draft=replyDrafts.propose(owner,runId,String(callId),args);result={draft,...(draft.mode==='review'?{review:replyDrafts.requestReview(owner,draft.draft_id)}:{})};break;
        }
        case 'tasks.reply_drafts': requireTask(identity);result=replyDrafts.list(owner,runId);break;
        case 'tasks.next': result=assessments.nextActions(owner,requireTask(identity).task_id,undefined,runId);break;
      }
      if (attested) result = {...object(result), execution_receipt: executionEvidence.record(runId, String(callId), operation, result)};
      if (receipted && savedCall(runId, String(callId), digest) === undefined) saveCall(runId, String(callId), digest, result);
      return result;
    });
    if(input.operation==='tasks.reply_draft'&&replyJudge&&replyChecks){
      const result=object(toolResult),draft=object(result.draft);
      if(draft.mode==='bounded_auto_reply'){
        const identity=context({...input,tool_name:'jot_workspace'}),fence=createAuxiliaryRunGuard(db,workbench,tasks,identity.owner_id,identity.run_id);
        const guard=()=>{fence.guard();context({...input,tool_name:'jot_workspace'});};
        try{
          const reply_check=await replyChecks.verify(identity.owner_id,String(draft.draft_id),{ledger:modelBudgets!,route:replyJudge.route,guard,preflight:replyJudge.preflight,invoke:replyJudge.invoke});
          return {...result,reply_check};
        }catch(error){
          const code=error instanceof Error?error.message:'';
          const expected=['reply_judge_input_too_large','reply_semantic_check_pending','auxiliary_usage_unknown','auxiliary_provider_failed','budget_usage_unknown','budget_usage_pending','model_budget_exhausted','budget_window_closed','budget_route_unavailable'];
          if(!expected.includes(code))throw error;
          const pending=['reply_semantic_check_pending','auxiliary_usage_unknown','auxiliary_provider_failed','budget_usage_unknown','budget_usage_pending'].includes(code);
          return {...result,reply_check:{draft_id:draft.draft_id,payload_sha256:draft.payload_sha256,verdict:pending?'pending':'unavailable',reason_code:code.toUpperCase()}};
        }
      }
    }
    return toolResult;
  });
}
