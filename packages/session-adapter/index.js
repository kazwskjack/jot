import {createOrdinaryCompletionReader} from './ordinary-completion.js'
import {createOrdinaryRunCompletionReader} from './ordinary-run-completion.js'
import {createOrdinarySteeringObservationReader,normalizeOrdinaryHistoryScope} from './ordinary-steering-observation.js'
import {nativeGoalsFor} from './workbench-goal.js'
import {normalizeOrdinarySteeringExecution} from './ordinary-steering-authority.js'
import {createOrdinaryClaimedSessionComposer} from './ordinary-claimed-composer.js'
import {createOrdinaryInputAdmissionHost} from './ordinary-input-admission-host.js'
import { createServer } from 'node:http'
import {createRequire} from 'node:module'
import { timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { createVoiceAdapterHandler } from './voice.js'
import {createBudgetModelSelector} from './budget-model-selection.js'
import {createNativeTaskDispatcher} from './native-task-dispatch.js'
import {createNativeTaskScheduler} from './native-task-scheduler.js'
import {createNativeRoleHost} from './native-role-host.js'
import {createNativeHandoffLifecycle} from './native-handoff-lifecycle.js'
import {createNativeClaimedSessionComposer} from './native-claimed-composer.js'
import {readConversationGoal} from './conversation-goal.js'
import {readNativeIdleObservation} from './native-idle-observation.js'
import {createConversationGoalRunHost} from './conversation-goal-run-host.js'
import {createOrdinaryInputRunHost,normalizeOrdinaryInputExecution} from './ordinary-input-run-host.js'
import {createOptionalMemoryExtractionHost} from './optional-memory-extraction.js'
import { WorkbenchBridge,normalizeHostExecutionLease } from './workbench.js'

export const name = 'jot-jot-session-adapter'
export const inject = ['sessionController', 'fileUploads', 'agents','sessions','sessionPersistence','sessionProjections','llm']

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/
const ALLOWED_AGENT_PRESETS = new Set([
  'jot-workbench-budgeted',
  'jot-general',
  'jot-general-batch50',
  'jot-general-batch',
])
const IMAGE_FAILURE_CODES = Object.freeze({
  MODEL_DOES_NOT_SUPPORT_IMAGES: 'DSH_IMAGE_MODEL_UNSUPPORTED',
  INVALID_IMAGE: 'DSH_IMAGE_INVALID',
  IMAGE_TOO_MANY_PIXELS: 'DSH_IMAGE_TOO_MANY_PIXELS',
  IMAGE_DIMENSION_TOO_LARGE: 'DSH_IMAGE_DIMENSION_TOO_LARGE',
  ATTACHMENT_WRITE_FAILED: 'DSH_IMAGE_STORAGE_FAILED',
  INVALID_ATTACHMENT_REF: 'DSH_IMAGE_REFERENCE_INVALID',
  IMAGE_TYPE_MISMATCH: 'DSH_IMAGE_TYPE_MISMATCH',
  IMAGE_TOO_LARGE: 'DSH_IMAGE_TOO_LARGE',
  ATTACHMENT_CORRUPT: 'DSH_IMAGE_INTEGRITY_FAILED',
  ATTACHMENT_NOT_FOUND: 'DSH_IMAGE_NOT_FOUND',
  ATTACHMENT_READ_FAILED: 'DSH_IMAGE_READ_FAILED',
  TOO_MANY_IMAGES: 'DSH_TOO_MANY_IMAGES',
  IMAGES_TOO_LARGE: 'DSH_IMAGES_TOO_LARGE',
  UNSUPPORTED_IMAGE_TYPE: 'DSH_IMAGE_TYPE_UNSUPPORTED',
  ATTACHMENT_PROJECTION_UNSUPPORTED: 'DSH_IMAGE_PROJECTION_UNSUPPORTED',
})

function isTrustedNativeHandoffConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === 3 && keys.includes('policyVersion') && keys.includes('maxHops') && keys.includes('validateLog')
    && Number.isSafeInteger(value.policyVersion) && value.policyVersion >= 1
    && Number.isSafeInteger(value.maxHops) && value.maxHops >= 1 && value.maxHops <= 20
    && typeof value.validateLog === 'function'
}

function isTrustedNativeClaimedConfig(value) {
  if(!value||typeof value!=='object'||Array.isArray(value))return false
  const keys=Reflect.ownKeys(value)
  return keys.length===4&&keys.includes('Session')&&keys.includes('validateLog')&&keys.includes('profile')&&keys.includes('provenance')
    &&typeof value.Session?.create==='function'&&typeof value.validateLog==='function'&&typeof value.profile?.read==='function'&&typeof value.provenance?.read==='function'&&typeof value.provenance?.create==='function'
}

function promptFailureReasonCode(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const reason = typeof error?.details?.reason === 'string' ? error.details.reason : ''
  if (Object.hasOwn(IMAGE_FAILURE_CODES, reason)) return IMAGE_FAILURE_CODES[reason]
  if (code === 'session/model-unavailable') return 'DSH_MODEL_UNAVAILABLE'
  if (code === 'session/not-found') return 'DSH_SESSION_NOT_FOUND'
  return 'DSH_PROMPT_REJECTED'
}

function hasKnownSharpNativeImportFailure(error) {
  const pending = [error]
  const seen = new Set()
  while (pending.length && seen.size < 12) {
    const value = pending.shift()
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue
    seen.add(value)
    if (value.name === 'TypeError'
      && /Cannot read properties of undefined \(reading ['"]output['"]\)/i.test(String(value.message ?? ''))) return true
    if (value.cause) pending.push(value.cause)
    if (Array.isArray(value.errors)) pending.push(...value.errors)
  }
  return false
}

function authorized(actual, expected) {
  const prefix = 'Bearer '
  if (typeof actual !== 'string' || !actual.startsWith(prefix) || expected.length < 32) return false
  const candidate = Buffer.from(actual.slice(prefix.length))
  const wanted = Buffer.from(expected)
  return candidate.length === wanted.length && timingSafeEqual(candidate, wanted)
}

function json(status, value) { return { status, value } }

const BINDING_FAILURE_CODES=new Set(['workbench_run_forbidden','workbench_goal_binding_changed','workbench_host_incompatible','workbench_goal_unavailable','workbench_goal_context_invalid','workbench_goal_identity_conflict','workbench_goal_stopped','workbench_context_invalid','workbench_binding_lease_required','workbench_model_host_incompatible','workbench_model_route_changed','workbench_budget_binding_required','workbench_binding_missing','workbench_binding_changed','workbench_goal_native_driver_unavailable','workbench_task_state_invalid','workbench_goal_host_state_invalid','workbench_goal_binding_missing','workbench_goal_revoked']);
export function bindingFailureSummary(stage,error){
  return {stage:['model-select','goal-status'].includes(stage)?stage:'attach',code:BINDING_FAILURE_CODES.has(error?.message)?error.message:'workbench_binding_failed'};
}

export function adapterErrorSummary(error) {
  const messages = []
  const seen = new Set()
  const visit = value => {
    if (!value || seen.has(value) || messages.length >= 12) return
    seen.add(value)
    const name = typeof value.name === 'string' && value.name ? value.name : 'Error'
    const message = typeof value.message === 'string' && value.message ? value.message : String(value)
    messages.push(`${name}: ${message}`)
    visit(value.cause)
    if (Array.isArray(value.errors)) for (const nested of value.errors) visit(nested)
  }
  visit(error)
  return { messages }
}

function promptContent(body) {
  if (!Array.isArray(body?.content)) {
    const text = String(body?.text ?? '').trim()
    return text ? [{ type: 'text', text }] : null
  }
  if (body.content.length < 1 || body.content.length > 11) return null
  const values = []
  let attachments = 0
  for (const raw of body.content) {
    if (!raw || typeof raw !== 'object') return null
    if (raw.type === 'text') {
      const text = String(raw.text ?? '').trim(); if (!text) return null
      values.push({ type: 'text', text }); continue
    }
    attachments += 1
    if (attachments > 10) return null
    if (raw.type === 'image') {
      const mediaType = String(raw.media_type ?? '')
      const data = String(raw.data ?? '')
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > 28 * 1024 * 1024) return null
      const value = { type: 'image', mediaType, data }
      if (typeof raw.name === 'string' && raw.name) value.name = raw.name.slice(0, 255)
      values.push(value); continue
    }
    if (raw.type === 'file') {
      const receiptId = String(raw.receipt_id ?? '')
      if (!ID.test(receiptId)) return null
      values.push({ type: 'file', receiptId }); continue
    }
    return null
  }
  return values.length ? values : null
}

function decodeFilename(headers) {
  const encoded = typeof headers['x-file-name-b64'] === 'string' ? headers['x-file-name-b64'] : ''
  if (!encoded || !/^[A-Za-z0-9_-]{1,1024}$/.test(encoded)) return null
  const value = Buffer.from(encoded, 'base64url').toString('utf8')
  return value && Buffer.byteLength(value, 'utf8') <= 255 && !/[\u0000\/\\]/.test(value) ? value : null
}

class SessionBindingConflict extends Error {}

// Conversation creation may mint a new id for a nonblank Session. The adapter's
// endpoint instead names one durable identity: inspect before activation, resume
// that exact identity, and create only when the official absence contract proves
// there is no saved Session. Keep this inside the claimed composer's scope.
async function createOrResumeSession({controller,request,agents,sessions,sessionNotFoundError,signal,beforeAdmission}) {
  if(typeof controller.inspect!=='function'||typeof controller.resolveAgent!=='function')return controller.create(request)
  const {sessionId,cwd,agentPreset}=request
  const identity=header=>JSON.stringify([header?.id,header?.cwd,header?.agentPreset,header?.createdAt,header?.parentSession,header?.origin,header?.delegationDepth,header?.isSeeded])
  const checkHeader=header=>{
    if(header?.id!==sessionId||header.cwd!==cwd||agentPreset!==undefined&&header.agentPreset!==agentPreset)throw new SessionBindingConflict()
  }
  signal?.throwIfAborted()
  let saved,absent=false
  try{saved=await controller.inspect(sessionId,signal)}catch(error){
    if(error?.code!=='session/not-found'&&!(typeof sessionNotFoundError==='function'&&error instanceof sessionNotFoundError))throw error
    if(agents?.get?.(sessionId)||sessions?.get?.(sessionId))throw new SessionBindingConflict()
    absent=true
  }
  signal?.throwIfAborted()
  if(!absent){
    // Missing/malformed inspection is unavailable history, never native absence.
    if(!saved?.meta)throw Error('session_inspection_unavailable')
    checkHeader(saved.meta)
    const expected=identity(saved.meta),resident=agents?.get?.(sessionId),cached=sessions?.get?.(sessionId)
    if(resident&&(resident.id!==sessionId||resident.session?.id!==sessionId||identity(resident.session.header)!==expected)
      ||cached&&(cached.id!==sessionId||identity(cached.header)!==expected))throw new SessionBindingConflict()
    await beforeAdmission?.();signal?.throwIfAborted()
    const result=await controller.resolveAgent(sessionId)
    signal?.throwIfAborted()
    // A failed exact resume must never be repaired with conversation creation.
    if(result?.error)throw result.error
    const agent=result?.agent
    if(agent?.id!==sessionId||agent.session?.id!==sessionId||identity(agent.session.header)!==expected
      ||typeof agents?.get==='function'&&agents.get(sessionId)!==agent
      ||typeof sessions?.get==='function'&&sessions.get(sessionId)!==agent.session)throw new SessionBindingConflict()
    return{sessionId,...(agent.session.header.agentPreset===undefined?{}:{agentPreset:agent.session.header.agentPreset})}
  }
  await beforeAdmission?.();signal?.throwIfAborted()
  if(agents?.get?.(sessionId)||sessions?.get?.(sessionId))throw new SessionBindingConflict()
  const value=await controller.create(request)
  signal?.throwIfAborted()
  if(value?.sessionId!==sessionId)throw new SessionBindingConflict()
  const agent=agents?.get?.(sessionId)
  if(typeof agents?.get==='function'&&!agent)throw new SessionBindingConflict()
  if(agent){if(agent.id!==sessionId||agent.session?.id!==sessionId)throw new SessionBindingConflict();checkHeader(agent.session.header)
    if(typeof sessions?.get==='function'&&sessions.get(sessionId)!==agent.session)throw new SessionBindingConflict()}
  return value
}

export function createAdapterHandler({ controller, fileUploads, agents, sessions, persistence, speechController, voiceEnabled = false, token, workbenchBridge,budgetModelSelector,nativeRoleHost,nativeTaskScheduler,nativeHandoffRecovery,nativeClaimedComposer,memoryExtractionHost,conversationGoalRunHost,ordinaryInputRunHost,ordinaryInputAdmissionHost,ordinaryCompletionReader,ordinarySteeringObservationReader,ordinaryRunCompletionReader,nativeIdleObservation=false,sessionNotFoundError }) {
  const voiceHandler = voiceEnabled ? createVoiceAdapterHandler({ speechController, token }) : null
  const workbenchSessions = new Set()
  const blockedWorkbenchSessions = new Set()
  const sessionAdmissions = new Map()
  const admitInOrder=(sessionId,signal,operation)=>{
    const previous=sessionAdmissions.get(sessionId)??Promise.resolve()
    const retained=[]
    const retain=promise=>{retained.push(Promise.resolve(promise).then(()=>{},()=>{}));return promise}
    const pending=previous.then(()=>{signal.throwIfAborted();return operation(retain)})
    // A composer may time out before its dispatched native operation settles.
    // The response can finish immediately; ownership covers every retained
    // operation. Install rejection handlers at dispatch, never after a timeout.
    const settled=pending.then(()=>{},()=>{}).then(async()=>{
      for(let index=0;index<retained.length;index++)await retained[index]
    })
    sessionAdmissions.set(sessionId,settled)
    settled.then(()=>{if(sessionAdmissions.get(sessionId)===settled)sessionAdmissions.delete(sessionId)})
    return new Promise((resolve,reject)=>{
      const cleanup=()=>signal.removeEventListener('abort',onAbort)
      const onAbort=()=>{cleanup();reject(signal.reason)}
      signal.addEventListener('abort',onAbort,{once:true})
      pending.then(value=>{cleanup();resolve(value)},error=>{cleanup();reject(error)})
      if(signal.aborted)onAbort()
    })
  }

  return async ({ method, url, headers, body, signal = new AbortController().signal }) => {
    if (!authorized(headers.authorization, token)) return json(401, { error: 'unauthorized' })
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' })
    if (url.pathname.startsWith('/v1/voice/')) {
      if (!voiceHandler) return json(404, { error: 'not_found' })
      return voiceHandler({ method, url, headers, body, signal })
    }
    if (url.pathname === '/v1/sessions') {
      const sessionId = String(body?.session_id ?? '')
      const cwd = body?.cwd
      if (!ID.test(sessionId) || typeof cwd !== 'string' || cwd.includes('\u0000') || !isAbsolute(cwd)) return json(422, { error: 'session_input_invalid' })
      return admitInOrder(sessionId,signal,async retain=>{
      const requestedPreset = body?.agent_preset
      if (requestedPreset !== undefined && !ALLOWED_AGENT_PRESETS.has(requestedPreset)) {
        return json(422, { error: 'agent_preset_not_allowed' })
      }
      const request = { sessionId, cwd }
      const workbenchRunId = body?.workbench_context?.run_id
      const isolatedWork=body?.workbench_context?.work_workspace
      if(isolatedWork!==undefined&&(!isolatedWork||typeof isolatedWork!=='object'||Array.isArray(isolatedWork)||Object.keys(isolatedWork).join(',')!=='protocol'||isolatedWork.protocol!==1))return json(422,{error:'work_workspace_binding_invalid'})
      if(isolatedWork!==undefined&&requestedPreset!=='jot-workbench-budgeted')return json(409,{error:'work_workspace_binding_invalid'})
      let workbenchExecutionLease
      if (body?.workbench_context !== undefined) {
        if (!ID.test(String(workbenchRunId ?? ''))) return json(422, { error: 'workbench_binding_invalid' })
        try{if(body.workbench_context.execution_lease!==undefined)workbenchExecutionLease=normalizeHostExecutionLease(body.workbench_context.execution_lease)}catch{return json(422,{error:'workbench_binding_invalid'})}
        if (!workbenchBridge?.attach || !agents?.get) return json(503, { error: 'workbench_bridge_unavailable' })
        workbenchSessions.add(sessionId)
        blockedWorkbenchSessions.add(sessionId)
      }
      if(requestedPreset==='jot-workbench-budgeted'&&(!workbenchRunId||!workbenchExecutionLease))return json(422,{error:'workbench_budget_binding_required'})
      if(nativeClaimedComposer&&(!workbenchRunId||!workbenchExecutionLease))return json(422,{error:'native_input_recovery_binding_required'})
      if(requestedPreset==='jot-workbench-budgeted'&&(typeof budgetModelSelector!=='function'||typeof workbenchBridge?.guardBudget!=='function'))return json(503,{error:'workbench_model_unavailable'})
      let initialWorkbenchContext
      if(workbenchRunId!==undefined){
        try{
          if(typeof workbenchBridge?.request!=='function')throw Error('workbench_guard_unavailable')
          initialWorkbenchContext=(await workbenchBridge.request('guard',{runId:String(workbenchRunId),sessionRef:sessionId,executionLease:workbenchExecutionLease},{},signal))?.context
          if(!initialWorkbenchContext||typeof initialWorkbenchContext!=='object'||Array.isArray(initialWorkbenchContext))throw Error('workbench_guard_unavailable')
          signal?.throwIfAborted()
        }catch{return json(503,{error:'workbench_bridge_unavailable'})}
        // Server authority determines whether this is work. Omitting the wire
        // protocol cannot turn a bound work run into an ordinary global-cwd run.
        if(isolatedWork===undefined&&(initialWorkbenchContext.work_binding!==undefined||initialWorkbenchContext.native_workspace!==undefined))return json(409,{error:'work_workspace_binding_invalid'})
      }
      let workWorkspaceAuthority
      const checkWorkWorkspace=async()=>{
        signal?.throwIfAborted()
        if(!workbenchExecutionLease||typeof workbenchBridge?.request!=='function')throw Error('work_workspace_binding_invalid')
        const context=(await workbenchBridge.request('guard',{runId:String(workbenchRunId),sessionRef:sessionId,executionLease:workbenchExecutionLease},{},signal))?.context
        const workspace=context?.native_workspace,binding=context?.work_binding,task=context?.task_binding
        if(workspace?.protocol!==1||workspace.cwd!==cwd||binding?.kind!=='isolated_work'
          ||context.model_budget?.protocol!==1||context.model_budget.enforced!==true
          ||!ID.test(binding.original_run_id??'')||!ID.test(binding.occurrence_id??'')
          ||task?.root_run_id!==binding.original_run_id||task?.occurrence_id!==binding.occurrence_id
          ||typeof task.objective!=='string'||!task.objective.trim())throw Error('work_workspace_binding_invalid')
        const authority=JSON.stringify({workspace,binding,task,model_budget:context.model_budget})
        if(workWorkspaceAuthority!==undefined&&workWorkspaceAuthority!==authority)throw Error('work_workspace_binding_changed')
        workWorkspaceAuthority=authority;signal?.throwIfAborted();return context
      }
      if(isolatedWork!==undefined){
        try{
          await checkWorkWorkspace()
          if(typeof controller.inspect!=='function'||typeof sessions?.get!=='function')throw Error('work_workspace_history_unavailable')
          const resident=agents.get(sessionId),cached=sessions.get(sessionId)
          const check=()=>{signal?.throwIfAborted();if(agents.get(sessionId)!==resident||sessions.get(sessionId)!==cached
            ||resident&&(resident.id!==sessionId||resident.session?.id!==sessionId||resident.session.header?.cwd!==cwd||resident.session.header?.agentPreset!==requestedPreset)
            ||cached&&(cached.id!==sessionId||cached.header?.cwd!==cwd||cached.header?.agentPreset!==requestedPreset))throw Error('work_workspace_binding_changed')}
          check()
          let history
          try{history=await controller.inspect(sessionId,signal)}catch(error){
            // The direct official Controller throws its exported native class;
            // the remote transport separately maps that class to this code.
            // Names/messages are never missing-Session evidence.
            if(error?.code!=='session/not-found'&&!(typeof sessionNotFoundError==='function'&&error instanceof sessionNotFoundError))throw error
            history=null
          }
          check()
          if(history!==null&&(history?.meta?.id!==sessionId||history.meta.cwd!==cwd||history.meta.agentPreset!==requestedPreset))throw Error('work_workspace_history_invalid')
          if(history===null&&(resident||cached))throw Error('work_workspace_history_invalid')
          if(history===null){
            // Missing native history permits only the first original work
            // entry. A continuation or saved Goal cannot be repaired by create,
            // even when the optional claimed-session composer is disabled.
            const fresh=await checkWorkWorkspace();check()
            if(fresh.task_binding.continuation_of!==null||fresh.task_binding.root_run_id!==String(workbenchRunId))throw Error('work_workspace_history_invalid')
            const saved=await workbenchBridge.request('goal-binding',{runId:String(workbenchRunId),sessionRef:sessionId,executionLease:workbenchExecutionLease},{action:'get'},signal)
            signal?.throwIfAborted();check()
            if(!saved||typeof saved!=='object'||Array.isArray(saved)||!Object.hasOwn(saved,'binding')||saved.binding!==null)throw Error('work_workspace_history_invalid')
          }
          await checkWorkWorkspace();check()
        }catch{return json(409,{error:'work_workspace_binding_invalid'})}
      }
      let memoryPurpose=false
      if(workbenchRunId&&memoryExtractionHost){
        try{
          memoryPurpose=initialWorkbenchContext?.kind==='memory_capture'
          if(memoryPurpose&&(requestedPreset!=='jot-workbench-budgeted'||!workbenchExecutionLease||(await memoryExtractionHost.readiness()).ready!==true))return json(503,{error:'memory_extraction_unavailable'})
        }catch{return json(503,{error:'workbench_bridge_unavailable'})}
      }
      if (requestedPreset !== undefined) request.agentPreset = requestedPreset
      const admitSession=()=>retain(createOrResumeSession({controller,request,agents,sessions,sessionNotFoundError,signal,beforeAdmission:isolatedWork===undefined?undefined:checkWorkWorkspace}))
      let value,inputRecovery
      if(nativeClaimedComposer&&!memoryPurpose){
        try{
          const created=await nativeClaimedComposer.withCreation({sessionId,cwd,presetId:requestedPreset??null,
            binding:{runId:String(workbenchRunId),sessionRef:sessionId,executionLease:workbenchExecutionLease},signal},admitSession)
          value=created.value;inputRecovery=created.recovery
        }catch(error){
          const code=/^(?:native_claim_composer|native_claim_recovery|native_replay_profile)_[a-z_]+$/.test(error?.message??'')?error.message:'native_input_recovery_failed'
          console.error('[jot-native-input-recovery]',JSON.stringify({code}))
          return json(503,{error:'native_input_recovery_unavailable'})
        }
      }else{
        try{value=await admitSession()}catch(error){return json(error instanceof SessionBindingConflict?409:503,{error:error instanceof SessionBindingConflict?'session_binding_invalid':'session_admission_unavailable'})}
      }
      if(isolatedWork!==undefined){
        try{
          await checkWorkWorkspace()
          const agent=agents.get(sessionId)
          if(agent?.id!==sessionId||agent.session?.id!==sessionId||agent.session.header?.cwd!==cwd||agent.session.header?.agentPreset!==requestedPreset||sessions.get(sessionId)!==agent.session)throw Error('work_workspace_binding_changed')
        }catch{return json(409,{error:'work_workspace_binding_invalid'})}
      }
      let nativeRecovery,handoffRecovery
      if (workbenchRunId !== undefined) {
        try { await workbenchBridge.attach(agents.get(sessionId), { runId: String(workbenchRunId), sessionRef: sessionId,...(workbenchExecutionLease?{executionLease:workbenchExecutionLease}:{}) },{sessions,persistence,signal}) }
        catch (error) { console.error('[jot-workbench-binding]',JSON.stringify(bindingFailureSummary('attach',error)));return json(503, { error: 'workbench_bridge_unavailable' }) }
        if(requestedPreset==='jot-workbench-budgeted'){
          try{const agent=agents.get(sessionId);await budgetModelSelector(agent,()=>workbenchBridge.guardBudget(agent,signal),signal)}
          catch(error){console.error('[jot-workbench-binding]',JSON.stringify(bindingFailureSummary('model-select',error)));return json(503,{error:'workbench_bridge_unavailable'})}
        }
        const taskRoot=workbenchBridge.taskRootBindingFor?.(agents.get(sessionId))
        if(nativeHandoffRecovery&&taskRoot){
          try{const recovered=await nativeHandoffRecovery({parent:agents.get(sessionId),parentBinding:taskRoot,signal});
            if(!['none','blocked','returned'].includes(recovered?.state)||recovered.state==='returned'&&(typeof recovered.request_id!=='string'||!ID.test(recovered.request_id)||!Number.isSafeInteger(recovered.revision)||recovered.revision<3))throw Error('native_handoff_recovery_invalid');
            handoffRecovery=recovered.state==='returned'?{state:'returned',request_id:recovered.request_id,revision:recovered.revision}:{state:recovered.state};
          }catch{handoffRecovery={state:'blocked'}}
        }
        if(nativeTaskScheduler&&taskRoot&&handoffRecovery?.state!=='blocked'){
          try{nativeRecovery=await nativeTaskScheduler.restore(agents.get(sessionId),taskRoot,signal)}
          catch{nativeRecovery={state:'blocked'}}
        }
        if(handoffRecovery?.state!=='blocked')blockedWorkbenchSessions.delete(sessionId)
      }
      return json(201,{...value,...(inputRecovery?{native_input_recovery:inputRecovery}:{}),...(nativeRecovery?{native_dispatch_recovery:nativeRecovery}:{}),...(handoffRecovery?{native_handoff_recovery:handoffRecovery}:{})})
      })
    }
    if(url.pathname==='/v1/memory-extraction/readiness'){
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'memory_extraction_input_invalid'});
      return json(200,memoryExtractionHost?await memoryExtractionHost.readiness():{ready:false,reason:'memory_extraction_disabled'});
    }
    const memoryExtraction=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/memory-extraction$/)
    if(memoryExtraction){
      const sessionId=decodeURIComponent(memoryExtraction[1]);
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='run_id')||typeof body.run_id!=='string'||!ID.test(body.run_id))return json(422,{error:'memory_extraction_input_invalid'});
      if(typeof memoryExtractionHost?.run!=='function')return json(503,{error:'memory_extraction_unavailable'});
      const agent=agents?.get?.(sessionId),binding=agent&&workbenchBridge?.bindingFor?.(agent);
      if(agent?.id!==sessionId||blockedWorkbenchSessions.has(sessionId)||binding?.sessionRef!==sessionId||binding?.runId!==body.run_id)return json(409,{error:'memory_extraction_binding_invalid'});
      try{return json(200,await memoryExtractionHost.run(agent,{signal}));}
      catch{return json(409,{error:'memory_extraction_not_completed'});}
    }
    const nativeMembers=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/native-members$/)
    if(nativeMembers){
      const sessionId=decodeURIComponent(nativeMembers[1]),keys=['role_ref','expected_policy_version','request_id','name','description','text'];
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!keys.includes(key))
        ||typeof body.role_ref!=='string'||!ID.test(body.role_ref)||typeof body.request_id!=='string'||!ID.test(body.request_id)||!Number.isSafeInteger(body.expected_policy_version)||body.expected_policy_version<1
        ||typeof body.name!=='string'||!body.name.trim()||body.name.length>80||typeof body.description!=='string'||!body.description.trim()||body.description.length>2000
        ||typeof body.text!=='string'||!body.text.trim()||body.text.length>32000)return json(422,{error:'native_member_input_invalid'});
      if(!nativeRoleHost?.spawn)return json(503,{error:'native_member_unavailable'});
      const parent=agents?.get?.(sessionId);
      if(parent?.id!==sessionId||blockedWorkbenchSessions.has(sessionId)||workbenchBridge?.bindingFor?.(parent)?.sessionRef!==sessionId)return json(409,{error:'native_member_parent_unavailable'});
      try{
        await workbenchBridge.guardBudget(parent,signal);
        const result=await nativeRoleHost.spawn(parent,{roleRef:body.role_ref,policyVersion:body.expected_policy_version,requestId:body.request_id},
          {name:body.name,description:body.description,prompt:[{type:'text',text:body.text}],context:'fresh',signal});
        return json(201,result);
      }catch{return json(409,{error:'native_member_unavailable'});}
    }
    if(url.pathname==='/v1/conversation-goal-resume/readiness'){
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'goal_control_input_invalid'});
      return json(200,{ready:!!conversationGoalRunHost});
    }
    const goalResume=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal-resume$/)
    if(goalResume){
      const sessionId=decodeURIComponent(goalResume[1]);
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='goal_control'||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'goal_control_input_invalid'});
      if(!conversationGoalRunHost)return json(503,{error:'goal_resume_unavailable'});
      try{return json(200,await conversationGoalRunHost.resume(sessionId,body.goal_control));}
      catch(error){return json(409,{error:['goal_revision_changed','goal_cold_input_pending','goal_control_dispatch_unknown','goal_observer_required'].includes(error?.message)?error.message:'goal_resume_unavailable'});}
    }
    if(url.pathname==='/v1/ordinary-run-history/readiness'){
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'ordinary_run_history_input_invalid'});
      return json(200,{ready:typeof ordinaryRunCompletionReader==='function',protocol:1,execution_authorized:false});
    }
    const runHistoryCompletion=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/run-history-completion$/)
    if(runHistoryCompletion){
      const sessionId=decodeURIComponent(runHistoryCompletion[1]),history=body?.history;
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='history,source_sha256'||typeof body.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.source_sha256)||!history||typeof history!=='object'||Array.isArray(history)||Object.keys(history).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id'||!['owner_id','conversation_id','run_id'].every(k=>typeof history[k]==='string'&&ID.test(history[k]))||!Number.isSafeInteger(history.expected_run_version)||history.expected_run_version<1||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'ordinary_run_history_input_invalid'});
      if(typeof ordinaryRunCompletionReader!=='function')return json(503,{error:'ordinary_run_history_unavailable'});
      try{return json(200,await ordinaryRunCompletionReader({scope:{...history,session_ref:sessionId},expectedSourceSha256:body.source_sha256,signal}));}catch{return json(409,{error:'ordinary_run_completion_unconfirmed'})}
    }
    if(url.pathname==='/v1/ordinary-input-history/readiness'){
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'ordinary_history_input_invalid'});
      return json(200,{ready:typeof ordinarySteeringObservationReader==='function',protocol:1,execution_authorized:false});
    }
    const historyObservation=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/(steering-history|steering-history-v2)$/)
    if(historyObservation){
      const sessionId=decodeURIComponent(historyObservation[1]),bound=historyObservation[2]==='steering-history-v2';let scope;
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!==(bound?'history,source_sha256':'history')||bound&&(typeof body.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.source_sha256))||!body.history||typeof body.history!=='object'||Array.isArray(body.history)||Object.keys(body.history).sort().join(',')!=='command_id,conversation_id,expected_run_version,owner_id,run_id'||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'ordinary_history_input_invalid'});
      try{scope=normalizeOrdinaryHistoryScope({...body.history,session_ref:sessionId});}catch{return json(422,{error:'ordinary_history_input_invalid'})}
      if(typeof ordinarySteeringObservationReader!=='function')return json(503,{error:'ordinary_history_unavailable'});
      try{return json(200,await ordinarySteeringObservationReader({scope,signal,...(bound?{protocol:2,expectedSourceSha256:body.source_sha256}:{})}));}catch{return json(409,{error:'ordinary_steering_observation_unconfirmed'})}
    }
    const inputCompletion=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/input-completion$/)
    if(inputCompletion){
      const sessionId=decodeURIComponent(inputCompletion[1]);let execution;
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='command_ids,ordinary_input'||!Array.isArray(body.command_ids)||body.command_ids.some(id=>typeof id!=='string'||!ID.test(id))||new Set(body.command_ids).size!==body.command_ids.length||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'ordinary_completion_input_invalid'});
      try{execution=normalizeOrdinaryInputExecution(body.ordinary_input);}catch{return json(422,{error:'ordinary_completion_input_invalid'})}
      if(typeof ordinaryCompletionReader!=='function')return json(503,{error:'ordinary_completion_unavailable'});
      try{return json(200,await ordinaryCompletionReader({binding:{...execution,sessionRef:sessionId},commandIds:body.command_ids,signal}));}catch{return json(409,{error:'ordinary_completion_unconfirmed'})}
    }
    const inputResume=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/input-resume$/)
    if(inputResume){
      const sessionId=decodeURIComponent(inputResume[1]);
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='ordinary_input'||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'ordinary_input_binding_invalid'});
      if(!ordinaryInputRunHost)return json(503,{error:'ordinary_input_resume_unavailable'});
        try{normalizeOrdinaryInputExecution(body.ordinary_input);}catch{return json(422,{error:'ordinary_input_binding_invalid'});}
      try{return json(200,await ordinaryInputRunHost.resume(sessionId,body.ordinary_input));}catch{return json(409,{error:'ordinary_input_resume_unavailable'});}
    }
    if(url.pathname==='/v1/native-idle-observation/readiness'){
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'native_idle_observation_input_invalid'});
      return json(200,{protocol:1,ready:nativeIdleObservation===true&&typeof agents?.get==='function'&&typeof controller?.projections==='function',execution_authorized:false});
    }
    const idleObservation=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/idle-observation$/)
    if(idleObservation){
      let sessionId;try{sessionId=decodeURIComponent(idleObservation[1]);}catch{return json(422,{error:'native_idle_observation_input_invalid'});}
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='protocol'||body.protocol!==1)return json(422,{error:'native_idle_observation_input_invalid'});
      if(nativeIdleObservation!==true||typeof agents?.get!=='function'||typeof controller?.projections!=='function')return json(503,{error:'native_idle_observation_unavailable'});
      try{return json(200,await readNativeIdleObservation({agents,controller,sessionId,signal,allowedPresets:ALLOWED_AGENT_PRESETS}));}catch{return json(409,{error:'native_idle_observation_unconfirmed'});}
    }
    const chatGoal=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/conversation-goal$/)
    if(chatGoal){
      const sessionId=decodeURIComponent(chatGoal[1]);
      if(!ID.test(sessionId)||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'conversation_goal_scope_invalid'});
      try{return json(200,await readConversationGoal({agent:agents?.get?.(sessionId),agents,persistence,controller,sessionId,body,signal,ordinaryPresets:new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted'))}))}
      catch(error){return json(409,{error:['goal_revision_changed','goal_cold_input_pending'].includes(error?.message)?error.message:'conversation_goal_unavailable'})}
    }
    const goalStatus=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal-status$/)
    if(goalStatus){
      const sessionId=decodeURIComponent(goalStatus[1])
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'goal_status_input_invalid'})
      if(!workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId)||!workbenchBridge?.observe||!agents?.get)return json(503,{error:'goal_status_unavailable'})
      try{return json(200,{state:await workbenchBridge.observe(agents.get(sessionId),signal)})}
      catch(error){console.error('[jot-goal-status]',JSON.stringify(bindingFailureSummary('goal-status',error)));return json(409,{error:'goal_status_unavailable'})}
    }
    const goalStop=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal-stop$/)
    if(goalStop){
      const sessionId=decodeURIComponent(goalStop[1])
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)
        ||Object.keys(body).length!==2||typeof body.goal_id!=='string'||!ID.test(body.goal_id)
        ||!Number.isSafeInteger(body.goal_revision)||body.goal_revision<1)return json(422,{error:'goal_stop_input_invalid'})
      if(!workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId)||!workbenchBridge?.suspend||!agents?.get)return json(503,{error:'goal_stop_unavailable'})
      try{return json(200,await workbenchBridge.suspend(agents.get(sessionId),body,signal))}
      catch{return json(409,{error:'goal_stop_unavailable'})}
    }
    const goalRestore=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal-restore$/)
    if(goalRestore){
      const sessionId=decodeURIComponent(goalRestore[1])
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)
        ||typeof body.run_id!=='string'||!ID.test(body.run_id)
        ||(Object.hasOwn(body,'intent_id')&&(typeof body.intent_id!=='string'||!ID.test(body.intent_id)))
        ||!Object.keys(body).every(key=>['run_id','intent_id'].includes(key)))return json(422,{error:'goal_restore_input_invalid'})
      if(!workbenchBridge?.restoreCompletion||!agents?.get)return json(503,{error:'goal_restore_unavailable'})
      blockedWorkbenchSessions.add(sessionId)
      try{
        const result=await workbenchBridge.restoreCompletion({runId:body.run_id,sessionRef:sessionId,...(body.intent_id===undefined?{}:{intentId:body.intent_id})},{agents,sessions,persistence,signal})
        workbenchSessions.add(sessionId);blockedWorkbenchSessions.delete(sessionId)
        return json(200,result)
      }catch{return json(409,{error:'goal_restore_unconfirmed'})}
    }
    const goalComplete=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal-complete$/)
    if(goalComplete){
      const sessionId=decodeURIComponent(goalComplete[1])
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1
        ||typeof body.intent_id!=='string'||!ID.test(body.intent_id))return json(422,{error:'goal_complete_input_invalid'})
      if(!workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId)||!workbenchBridge?.complete||!agents?.get)return json(503,{error:'goal_complete_unavailable'})
      try{return json(200,await workbenchBridge.complete(agents.get(sessionId),{intentId:body.intent_id,sessions,persistence,signal}))}
      catch{return json(409,{error:'goal_complete_unconfirmed'})}
    }
    const checkpoint=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/checkpoint$/)
    if(checkpoint){
      const sessionId=decodeURIComponent(checkpoint[1])
      if(!ID.test(sessionId)||!body||Object.keys(body).some(k=>k!=='after_seq')||!Number.isSafeInteger(body.after_seq)||body.after_seq<0)return json(422,{error:'checkpoint_input_invalid'})
      if(!workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId)||!workbenchBridge?.checkpoint||!agents?.get)return json(503,{error:'checkpoint_unavailable'})
      try{return json(200,{checkpoint:await workbenchBridge.checkpoint(agents.get(sessionId),{afterSeq:body.after_seq,sessions,persistence,signal})})}
      catch{return json(409,{error:'checkpoint_unavailable'})}
    }
    const cancel = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/)
    if (cancel) {
      const sessionId = decodeURIComponent(cancel[1])
      if (!ID.test(sessionId)) return json(422, { error: 'session_id_invalid' })
      if (!agents?.get) return json(503, { error: 'agent_registry_unavailable' })
      const agent = agents.get(sessionId)
      // No attached driver exists after a Host restart; there is no live turn to stop.
      if (!agent) return json(202, { accepted: true, settled: true, attached: false })
      if(workbenchSessions.has(sessionId))await workbenchBridge?.revoke?.(agent)
      const value = await controller.cancel({ sessionId })
      await agent.whenIdle()
      return json(202, { ...value, settled: true, attached: true })
    }
    const prompt = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/prompts$/)
    if (prompt) {
      const sessionId = decodeURIComponent(prompt[1])
      const requestId = String(body?.request_id ?? '')
      if(workbenchBridge?.memoryCaptureBindingFor?.(agents?.get?.(sessionId)))return json(409,{error:'memory_extraction_prompt_forbidden'})
      const content = promptContent(body)
      const mode = body?.mode === 'steer' ? 'steer' : 'queue'
      if (!ID.test(sessionId) || !ID.test(requestId) || !content) return json(422, { error: 'prompt_input_invalid' })
      if (workbenchSessions.has(sessionId)) {
        if (blockedWorkbenchSessions.has(sessionId) || !workbenchBridge?.guard || !agents?.get) return json(503, { error: 'workbench_bridge_unavailable' })
        try { await workbenchBridge.guard(agents.get(sessionId), signal) }
        catch { return json(409, { error: 'workbench_run_forbidden' }) }
      }
      let steeringBinding
      if(body.ordinary_steer!==undefined){try{const value=normalizeOrdinarySteeringExecution(body.ordinary_steer);if(body.ordinary_input!==undefined||value.commandId!==requestId||mode!=='steer'||workbenchSessions.has(sessionId))throw Error();steeringBinding={...value,sessionRef:sessionId};}catch{return json(422,{error:'ordinary_steering_binding_invalid'})}if(typeof ordinaryInputAdmissionHost?.withSteer!=='function')return json(503,{error:'ordinary_input_admission_unavailable'})}
      let ordinaryBinding
      if(body.ordinary_input!==undefined){try{const value=normalizeOrdinaryInputExecution(body.ordinary_input);if(value.runId!==requestId||workbenchSessions.has(sessionId))throw Error();ordinaryBinding={...value,sessionRef:sessionId};}catch{return json(422,{error:'ordinary_input_binding_invalid'})}if(!ordinaryInputAdmissionHost)return json(503,{error:'ordinary_input_admission_unavailable'})}
      let value
      try {
        // Admission passes human content unchanged. Login operations are only
        // executed through explicit tools with trusted scope and consent checks.
        value = steeringBinding?await ordinaryInputAdmissionHost.withSteer({binding:steeringBinding,content,signal},()=>controller.prompt({requestId,sessionId,mode,content},signal)):ordinaryBinding?await ordinaryInputAdmissionHost.withPrompt({binding:ordinaryBinding,signal},()=>controller.prompt({requestId,sessionId,mode,content},signal)):await controller.prompt({ requestId, sessionId, mode, content }, signal)
      } catch (error) {
        // Keep protocol-visible diagnostics stable and allow-listed. Remote error
        // messages/details may contain model, filesystem, or user-provided data.
        const hasImage = content.some(part => part.type === 'image')
        const reasonCode = hasImage && hasKnownSharpNativeImportFailure(error)
          ? 'DSH_IMAGE_PROCESSING_DEPENDENCY_FAILED' : promptFailureReasonCode(error)
        return json(ordinaryBinding||steeringBinding?409:422, { error: ordinaryBinding||steeringBinding?'ordinary_input_admission_unconfirmed':'prompt_rejected', reason_code: reasonCode })
      }
      return json(202, value)
    }
    const file = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/files$/)
    if (file) {
      const sessionId = decodeURIComponent(file[1]); const name = decodeFilename(headers)
      if (!ID.test(sessionId) || !name || !body?.[Symbol.asyncIterator]) return json(422, { error: 'file_input_invalid' })
      if (!fileUploads?.uploadStream) return json(503, { error: 'file_uploads_unavailable' })
      const value = await fileUploads.uploadStream({ sessionId, data: body, signal, name })
      return json(201, { receipt_id: value.receiptId, file: value.file })
    }
    const follow = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/follow$/)
    if (follow) {
      const sessionId = decodeURIComponent(follow[1])
      if (!ID.test(sessionId)) return json(422, { error: 'session_id_invalid' })
      const maxMessages = Math.min(200, Math.max(1, Number(body?.max_messages ?? 50)))
      const request = { address: { kind: 'session', sessionId }, maxMessages }
      if (body?.assistant_stream === true) request.assistantStream = true
      if(body?.goal_control!==undefined&&body?.ordinary_input!==undefined)return json(422,{error:'ordinary_input_binding_invalid'});
      if(body?.ordinary_input!==undefined){
        if(!ordinaryInputRunHost)return json(503,{error:'ordinary_input_resume_unavailable'});
        try{normalizeOrdinaryInputExecution(body.ordinary_input);}catch{return json(422,{error:'ordinary_input_binding_invalid'});}
        if(workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'ordinary_input_binding_invalid'});
        return {status:200,stream:ordinaryInputRunHost.follow(sessionId,body.ordinary_input,request,signal)};
      }
      if(body?.goal_control!==undefined){
        if(!conversationGoalRunHost)return json(503,{error:'goal_resume_unavailable'});
        if(workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'goal_control_input_invalid'});
        return {status:200,stream:conversationGoalRunHost.follow(sessionId,body.goal_control,request,signal)};
      }
      return { status: 200, stream: controller.follow(request, signal) }
    }
    return json(404, { error: 'not_found' })
  }
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body_too_large')
    chunks.push(chunk)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

export function apply(ctx, config = {}) {
  const host = config.host || '127.0.0.1'
  const port = Number(config.port || 18841)
  const token = String(process.env[config.tokenEnv || 'JOT_SESSION_ADAPTER_TOKEN'] || '')
  const voiceEnabled = config.voiceEnabled === true
  const workbenchToken = String(process.env[config.workbenchTokenEnv || 'GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN'] || '')
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || token.length < 32
    || (config.conversationGoalResume!==undefined&&typeof config.conversationGoalResume!=='boolean')
    || (config.conversationGoalResume===true&&workbenchToken.length<16)
    || (config.ordinaryRunHistory!==undefined&&(!config.ordinaryRunHistory||typeof config.ordinaryRunHistory!=='object'||Array.isArray(config.ordinaryRunHistory)||Object.keys(config.ordinaryRunHistory).sort().join(',')!=='Session,validateLog'||typeof config.ordinaryRunHistory.Session?.create!=='function'||typeof config.ordinaryRunHistory.validateLog!=='function'||config.ordinaryInputAdmission?.admissions?.entryInspectionProtocol!==1||typeof config.ordinaryInputAdmission?.admissions?.read!=='function'||typeof config.ordinaryInputAdmission?.admissions?.inspectEntry!=='function'||typeof ctx.sessionProjections?.snapshot!=='function'||workbenchToken.length<16))
    || (config.ordinaryInputHistory!==undefined&&(!config.ordinaryInputHistory||typeof config.ordinaryInputHistory!=='object'||Array.isArray(config.ordinaryInputHistory)||Object.keys(config.ordinaryInputHistory).sort().join(',')!=='Session,validateLog'||typeof config.ordinaryInputHistory.Session?.create!=='function'||typeof config.ordinaryInputHistory.validateLog!=='function'||config.ordinaryInputAdmission?.admissions?.entryInspectionProtocol!==1||typeof config.ordinaryInputAdmission?.admissions?.inspectEntry!=='function'||workbenchToken.length<16))
    || (config.ordinaryInputRecovery!==undefined&&(!config.ordinaryInputRecovery||typeof config.ordinaryInputRecovery!=='object'||Array.isArray(config.ordinaryInputRecovery)||!['verifyComposition','claimedInput,verifyComposition'].includes(Object.keys(config.ordinaryInputRecovery).sort().join(','))||config.ordinaryInputRecovery.claimedInput!==undefined&&(!config.ordinaryInputRecovery.claimedInput||Object.keys(config.ordinaryInputRecovery.claimedInput).sort().join(',')!=='Session,validateLog'||typeof config.ordinaryInputRecovery.claimedInput.Session?.create!=='function'||typeof config.ordinaryInputRecovery.claimedInput.validateLog!=='function')||typeof config.ordinaryInputRecovery.verifyComposition!=='function'||workbenchToken.length<16||config.ordinaryInputAdmission===undefined))
    || (config.ordinaryInputAdmission!==undefined&&(!config.ordinaryInputAdmission||typeof config.ordinaryInputAdmission!=='object'||Object.keys(config.ordinaryInputAdmission).sort().join(',')!=='admissions,profile'||typeof config.ordinaryInputAdmission.profile?.read!=='function'||typeof config.ordinaryInputAdmission.admissions?.read!=='function'||typeof config.ordinaryInputAdmission.admissions?.create!=='function'||config.ordinaryInputAdmission.admissions.entryReservationProtocol!==1||typeof config.ordinaryInputAdmission.admissions.reserveEntry!=='function'||typeof config.ordinaryInputAdmission.admissions.readReplayCandidate!=='function'||workbenchToken.length<16))
    || (config.nativeContinuation !== undefined && typeof config.nativeContinuation !== 'boolean')
    || (config.webBudgetEnabled !== undefined && typeof config.webBudgetEnabled !== 'boolean')
    || (config.nativeRoles !== undefined && typeof config.nativeRoles !== 'boolean')
    || (config.nativeRoleRecovery !== undefined && typeof config.nativeRoleRecovery !== 'boolean')
    || (config.reconcileOperations !== undefined && (typeof config.reconcileOperations !== 'function' || config.nativeRoles !== true))
    || (config.nativeOperationOrigin !== undefined && (typeof config.nativeOperationOrigin !== 'string' || config.nativeRoles !== true || config.reconcileOperations !== undefined))
    || (config.handoffAdmission !== undefined && (typeof config.handoffAdmission !== 'function' || config.nativeRoles !== true))
    || (config.handoffReturn !== undefined && (typeof config.handoffReturn !== 'function' || config.nativeRoles !== true || typeof config.handoffAdmission !== 'function'))
    || (config.handoffRecovery !== undefined && (typeof config.handoffRecovery !== 'function' || config.nativeRoles !== true || typeof config.handoffAdmission !== 'function'))
    || (config.nativeHandoff !== undefined && (!isTrustedNativeHandoffConfig(config.nativeHandoff) || config.nativeRoles !== true))
    || (config.nativeHandoff !== undefined && (config.handoffAdmission !== undefined || config.handoffReturn !== undefined || config.handoffRecovery !== undefined))
    || (config.nativeDeferredHandoff !== undefined && typeof config.nativeDeferredHandoff !== 'boolean')
    || (config.nativeDeferredHandoff === true && (config.nativeRoles !== true
      || config.nativeHandoff === undefined && typeof config.handoffAdmission !== 'function'))
    || (config.nativeRoleRecovery===true&&config.nativeRoles!==true)
    || (config.nativeClaimedInputRecovery!==undefined&&(!isTrustedNativeClaimedConfig(config.nativeClaimedInputRecovery)
      ||config.nativeContinuation!==true||config.workbenchModel===undefined||workbenchToken.length<16))
    || (config.nativeRoles===true&&(config.nativeContinuation!==true||config.workbenchModel===undefined))
    || ((config.nativeContinuation === true || config.webBudgetEnabled === true || config.nativeRoles===true) && workbenchToken.length < 16)) {
    throw new Error('jot_session_adapter_config_invalid')
  }
  const speechController = voiceEnabled ? ctx.speechController : undefined
  if (voiceEnabled && !speechController) throw new Error('jot_voice_speech_service_unavailable')
  let nativeTaskDispatcher
  const workbenchBridge = workbenchToken.length >= 16 ? new WorkbenchBridge({
    origin: config.workbenchOrigin || 'http://127.0.0.1:18831', token: workbenchToken,
    nativeDelegate:config.nativeRoles===true?(...args)=>{if(!nativeTaskDispatcher)throw new Error('native_task_dispatch_unavailable');return nativeTaskDispatcher(...args)}:undefined,
    webBudgetEnabled:config.webBudgetEnabled===true,
    nativeContinuation: config.nativeContinuation ?? false,
    modelRouteFor:config.workbenchModel?agent=>ctx.sessionController.agents.selectionFor(agent).current:undefined,
  }) : undefined
  const budgetModelSelector=createBudgetModelSelector({route:config.workbenchModel,llm:ctx.llm,agents:ctx.sessionController.agents})
  const nativeClaimedComposer=config.nativeClaimedInputRecovery===undefined?undefined:createNativeClaimedSessionComposer({
    ctx,bridge:workbenchBridge,agents:ctx.agents,sessions:ctx.sessions,
    query:typeof ctx.get==='function'?ctx.get('sessionQuery'):ctx.sessionQuery,projections:ctx.sessionProjections,
    ...config.nativeClaimedInputRecovery,
  })
  const nativeHandoffLifecycle=config.nativeHandoff===undefined?undefined:createNativeHandoffLifecycle({
    ctx,bridge:workbenchBridge,registry:ctx.agents,sessions:ctx.sessions,
    persistence:ctx.sessionPersistence,projections:ctx.sessionProjections,
    route:config.workbenchModel,reconcileOperations:config.reconcileOperations,
    policyVersion:config.nativeHandoff.policyVersion,
    maxHops:config.nativeHandoff.maxHops,
    validateLog:config.nativeHandoff.validateLog,
  })
  const handoffAdmission=nativeHandoffLifecycle?.handoffAdmission??config.handoffAdmission
  const handoffReturn=nativeHandoffLifecycle?.handoffReturn??config.handoffReturn
  const handoffRecovery=nativeHandoffLifecycle?.handoffRecovery??config.handoffRecovery
  const nativeRoleHost=config.nativeRoles===true?createNativeRoleHost({ctx,bridge:workbenchBridge,selectModel:budgetModelSelector,
    sessions:ctx.sessions,persistence:ctx.sessionPersistence,automaticClosures:true,durableSpawns:true,nativeRecovery:config.nativeRoleRecovery===true,reconcileOperations:config.reconcileOperations,nativeOperationOrigin:config.nativeOperationOrigin,handoffAdmission,onMemberClosed:handoffReturn}):undefined
  let nativeTaskScheduler
  if(nativeRoleHost){
    nativeTaskScheduler=config.nativeDeferredHandoff===true?createNativeTaskScheduler({ctx,bridge:workbenchBridge,host:nativeRoleHost}):undefined
    nativeTaskDispatcher=createNativeTaskDispatcher({bridge:workbenchBridge,host:nativeRoleHost,scheduler:nativeTaskScheduler})
    ctx.effect(()=>async()=>{await nativeTaskScheduler?.dispose();await nativeRoleHost.dispose()})
  }
  const conversationGoalRunHost=config.conversationGoalResume===true?createConversationGoalRunHost({controller:ctx.sessionController,agents:ctx.agents,persistence:ctx.sessionPersistence,bridge:workbenchBridge,ordinaryPresets:new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted'))}):undefined
  if(conversationGoalRunHost)ctx.effect(()=>()=>conversationGoalRunHost.dispose())
  const ordinaryInputAdmissionHost=config.ordinaryInputAdmission===undefined?undefined:createOrdinaryInputAdmissionHost({ctx,agents:ctx.agents,bridge:workbenchBridge,ordinaryPresets:new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted')),...config.ordinaryInputAdmission})
  if(ordinaryInputAdmissionHost)ctx.effect(()=>()=>ordinaryInputAdmissionHost.dispose())
  const ordinaryCompletionReader=config.ordinaryInputAdmission===undefined?undefined:createOrdinaryCompletionReader({agents:ctx.agents,bridge:workbenchBridge,ordinaryPresets:new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted')),readGoal:agent=>nativeGoalsFor(agent)?.get(agent),...config.ordinaryInputAdmission})
  const ordinarySteeringObservationReader=config.ordinaryInputHistory===undefined?undefined:createOrdinarySteeringObservationReader({agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,bridge:workbenchBridge,admissions:config.ordinaryInputAdmission.admissions,ordinaryPresets:new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted')),...config.ordinaryInputHistory})
  const ordinaryRunCompletionReader=config.ordinaryRunHistory===undefined?undefined:createOrdinaryRunCompletionReader({agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,bridge:workbenchBridge,admissions:config.ordinaryInputAdmission.admissions,projections:ctx.sessionProjections,ordinaryPresets:new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted')),...config.ordinaryRunHistory})
  const ordinaryClaimedComposer=config.ordinaryInputRecovery?.claimedInput===undefined?undefined:createOrdinaryClaimedSessionComposer({ctx,bridge:workbenchBridge,agents:ctx.agents,sessions:ctx.sessions,query:typeof ctx.get==='function'?ctx.get('sessionQuery'):ctx.sessionQuery,projections:ctx.sessionProjections,ordinaryPresets:new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted')),...config.ordinaryInputAdmission,...config.ordinaryInputRecovery.claimedInput})
  if(ordinaryClaimedComposer)ctx.effect(()=>()=>ordinaryClaimedComposer.dispose())
  const ordinaryInputRunHost=config.ordinaryInputRecovery===undefined?undefined:createOrdinaryInputRunHost({controller:ctx.sessionController,agents:ctx.agents,bridge:workbenchBridge,ordinaryPresets:new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted')),verifyComposition:config.ordinaryInputRecovery.verifyComposition,inputAdmissionHost:ordinaryInputAdmissionHost,claimedComposer:ordinaryClaimedComposer})
  if(ordinaryInputRunHost)ctx.effect(()=>()=>ordinaryInputRunHost.dispose())
  const memoryExtractionHost=createOptionalMemoryExtractionHost({config:config.memoryExtraction,bridge:workbenchBridge,llm:ctx.llm,route:config.workbenchModel})
  if(memoryExtractionHost)ctx.effect(()=>()=>memoryExtractionHost.dispose())
  let ApiSessionNotFound
  if(workbenchBridge||typeof ctx.sessionController.inspect==='function'&&typeof ctx.sessionController.resolveAgent==='function'){
    ({ApiSessionNotFound}=createRequire(ctx.get('profileContext').installAnchor)('@deepseek-ai/dsh-api-session-controller'))
    if(typeof ApiSessionNotFound!=='function'||!(ApiSessionNotFound.prototype instanceof Error))throw Error('jot_session_controller_incompatible')
  }
  const handler = createAdapterHandler({ controller: ctx.sessionController, fileUploads: ctx.fileUploads, agents: ctx.agents,
    sessions:ctx.sessions,persistence:ctx.sessionPersistence,sessionNotFoundError:ApiSessionNotFound,
    speechController, voiceEnabled, token, workbenchBridge,
    budgetModelSelector,nativeRoleHost,nativeTaskScheduler,nativeHandoffRecovery:handoffRecovery,nativeClaimedComposer,memoryExtractionHost,conversationGoalRunHost,ordinaryInputRunHost,ordinaryInputAdmissionHost,ordinaryCompletionReader,ordinarySteeringObservationReader,ordinaryRunCompletionReader,nativeIdleObservation:config.nativeIdleObservation===true })
  const server = createServer(async (req, res) => {
    const abort = new AbortController()
    req.once('aborted', () => abort.abort())
    res.once('close', () => { if (!res.writableEnded) abort.abort() })
    try {
      const url = new URL(req.url, `http://${host}:${port}`)
      const isFileUpload = /^\/v1\/sessions\/[^/]+\/files$/.test(url.pathname)
      const bodyLimit = url.pathname.startsWith('/v1/voice/') ? 4 * 1024 * 1024 : 32 * 1024 * 1024
      const result = await handler({ method: req.method, url, headers: req.headers,
        body: isFileUpload ? req : await readJson(req, bodyLimit), signal: abort.signal })
      if (result.stream) {
        res.writeHead(result.status, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
        for await (const frame of result.stream) res.write(`${JSON.stringify(frame)}\n`)
        return res.end()
      }
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(result.value))
    } catch (error) {
      console.error('[jot-jot-session-adapter] request failed', JSON.stringify(adapterErrorSummary(error)))
      if (res.headersSent) return res.destroy()
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'adapter_internal_error' }))
    }
  })
  server.once('listening',()=>ctx.emit('jot-session-adapter/ready',{host,port}))
  server.listen(port, host)
  ctx.effect(() => () => server.close())
}

export { createNativeHandoffLifecycle }
export {createNativeClaimedInputRecoverySetup} from './native-claimed-input.js'
export {createNativeClaimedSessionComposer}
export {createNativeReplayProfile} from './native-replay-profile.js'
export {createNativeReplayProvenance} from './native-replay-provenance.js'
export {prepareOrdinaryInputResume} from './ordinary-input-resume.js'

export {createOrdinaryInputRunHost}

export {createOrdinaryClaimedInputRecoverySetup} from './ordinary-claimed-input.js'

export {createOrdinaryInputAdmissionHost}
export {createOrdinaryInputAdmissions} from './ordinary-input-admissions.js'

export {createOrdinaryClaimedSessionComposer}
