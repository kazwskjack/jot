import {createTerminalControl} from './terminal-control.js'
import {createNativeSearchSource} from './native-search-source.js'
import {createNativeWorkspaceFileReader} from './native-workspace-file-reader.js'
import {sessionHeaderIdentity} from './session-header-identity.js'
import {projectTerminalInventory} from '../gateway/src/terminal/inventory.js'
import {validateHostCredentialRefs} from './host-credentials-owner-route.js'
import {createHostPolicyBootstrapRuntime,resolveHostPolicyBootstrapRuntimeConfig,validateHostPolicyBootstrapRuntimeConfig} from './host-policy-bootstrap-runtime.js'
import {createChatCompactionManager} from './chat-compaction-manager.js'
import {createChatCheckpointRecovery} from './chat-checkpoint-recovery.js'
import {createChatPostAnswer} from './chat-post-answer.js'
import {createChatModeReadiness} from './chat-mode-readiness.js'
import {createOrdinaryCompletionReader} from './ordinary-completion.js'
import {createOrdinaryRunCompletionReader,createLiveChatRunCompletionReader} from './ordinary-run-completion.js'
import {createChatMaintenanceObserver} from './chat-maintenance-observation.js'
import {createOrdinarySteeringObservationReader,normalizeOrdinaryHistoryScope} from './ordinary-steering-observation.js'
import {nativeGoalsFor} from './workbench-goal.js'
import {normalizeOrdinarySteeringExecution} from './ordinary-steering-authority.js'
import {createOrdinaryClaimedSessionComposer} from './ordinary-claimed-composer.js'
import {createOrdinaryInputAdmissionHost} from './ordinary-input-admission-host.js'
import {once} from 'node:events'
import { createServer } from 'node:http'
import {createRequire} from 'node:module'
import { timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { createVoiceAdapterHandler } from './voice.js'
import {createBudgetModelSelector} from './budget-model-selection.js'
import {createOrdinaryModelSelector} from './ordinary-model-selection.js'
import {installNativeModelDispatchGuard} from './native-model-dispatch-guard.js'
import {createOrdinaryExecutionPolicyReader,normalizeChatExecutionPolicy} from './ordinary-execution-policy.js'
import {createOrdinaryContextSelector} from './chat-context.js'
import {createChatWebSelector} from './chat-web.js'
import {createModelCatalogReader} from './model-catalog.js'
import {createTrustedModelMetadataProducer} from './trusted-model-metadata.js'
import {createModelRouteHealth} from './model-route-health.js'
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
import { createSkillContentCommand, createSkillContentReader } from './skill-content-reader.js'
import {createNativeCommandQueryHost} from './native-command-query.js'
import {nativePlanModePolicy} from '../skills/plan-mode-command.js'
import { createSkillCatalogCommand, createSkillCatalogReader, createSkillResourceCommand, createSkillResourceReader } from './skill-catalog-reader.js'
import {createNativeWorkspaceAdmissionGate} from './native-workspace-factory.js'
import {createNativeGitHost,normalizeNativeGitHostConfig} from './native-git-host.js'
import {createMcpControlHost,createMcpControlRouteHandler} from './mcp-control-host.js'
import {createMcpDiscoveryScopeResolver} from './mcp-discovery-control.js'
import {createGatewayPluginProfileReceiptClient,createDshProfilePluginControl} from './dsh-profile-plugin-control.js'
import {createPluginProfileEvidence} from './plugin-profile-evidence.js'
import {createHooksConfiguration} from './hooks-config.js'
import {createHooksRuntime} from './hooks-runtime.js'
import {createAgentHooksBridge} from './hooks-agent-bridge.js'
import {createHookCallbackAuthority} from './hooks-callback-authority.js'
import {readHookStopPayload} from './hooks-stop-source.js'
import {resolveOwnerBoundDshProfileContext} from './dsh-profile-binding.js'
import {readTaskmasterInstallation,createTaskmasterRuntimeVersionReader} from './taskmaster-installation.js'

import {normalizeLeaseTakeoverRequest,settleLeaseTakeover} from './lease-takeover.js'
import {browserToolsConfigFromEnvironment,createBrowserToolsPlugin} from '../dsh-host/browser-tools.mjs'

export const name = 'jot-jot-session-adapter'
export const inject = ['sessionController', 'fileUploads', 'agents','sessions','sessionPersistence','sessionProjections','llm','agentPresets','jotMcpRuntimeProvider','profileContext','approval']

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

const DRIVER_SCOPE_KEYS='lease_generation,lease_owner,owner_id,run_id,session_id,workspace_id';
const DRIVER_SAFE_REASON=/^[a-z][a-z0-9_]{0,63}$/;
function normalizeBrowserDriverScope(value,sessionId){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==DRIVER_SCOPE_KEYS
    ||!['run_id','owner_id','workspace_id','session_id','lease_owner'].every(key=>typeof value[key]==='string'&&ID.test(value[key]))
    ||!Number.isSafeInteger(value.lease_generation)||value.lease_generation<1||value.session_id!==sessionId)throw Error('browser_driver_observation_invalid');
  return Object.freeze({run_id:value.run_id,owner_id:value.owner_id,workspace_id:value.workspace_id,session_id:value.session_id,
    lease_owner:value.lease_owner,lease_generation:value.lease_generation});
}
function validateBrowserDriverObservation(value,expected,now=Date.now()){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('browser_driver_observation_invalid');
  const keys=Object.keys(value).sort().join(',');
  if((keys!=='execution_authorized,observed_at,protocol,required,scope,status'
      &&keys!=='execution_authorized,observed_at,protocol,reason,required,scope,status')
    ||value.protocol!==1||value.execution_authorized!==false||value.required!==true
    ||!['ready','unknown','failed'].includes(value.status)||typeof value.observed_at!=='string'||value.observed_at.length>64
    ||value.reason!==undefined&&(typeof value.reason!=='string'||!DRIVER_SAFE_REASON.test(value.reason)))throw Error('browser_driver_observation_invalid');
  const scope=normalizeBrowserDriverScope(value.scope,expected.session_id);
  if(Object.keys(scope).some(key=>scope[key]!==expected[key]))throw Error('browser_driver_observation_invalid');
  const observedAt=/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value.observed_at)?Date.parse(value.observed_at):NaN;
  if(!Number.isFinite(observedAt)||observedAt>now+5000||now-observedAt>60_000)throw Error('browser_driver_observation_invalid');
  return Object.freeze({...value,scope});
}

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
  const identity=sessionHeaderIdentity
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

export function createAdapterHandler({ controller, fileUploads, agents, sessions, persistence, speechController, voiceEnabled = false, token, workbenchBridge,skillContentCommand,skillCatalogCommand,skillResourceCommand,nativeCommandQueryHost,nativePlanModeHost,budgetModelSelector,nativeRoleHost,nativeTaskScheduler,nativeHandoffRecovery,nativeClaimedComposer,memoryExtractionHost,conversationGoalRunHost,ordinaryInputRunHost,ordinaryInputAdmissionHost,ordinaryCompletionReader,ordinarySteeringObservationReader,ordinaryRunCompletionReader,chatMaintenanceObserver,chatCheckpointRecovery,chatPostAnswer,nativeIdleObservation=false,sessionNotFoundError,modelCatalogReader,trustedModelMetadataReader,trustedModelMetadataEnabled=false,requireOrdinaryModelPolicy=false,chatExecutionPolicy,chatModeReadiness,mcpControlRoute,pluginProfileControl,hostPolicyBootstrap,hostSettingsProductHandler,hostAdmissionGuard,taskmasterInstallationReader,taskmasterRuntimeVersionReader,terminalInventoryReader,terminalControl,nativeSearchSource,nativeWorkspaceFileReader }) {
  const allowedPresets=new Set(ALLOWED_AGENT_PRESETS)
  if(chatExecutionPolicy!==undefined){normalizeChatExecutionPolicy(chatExecutionPolicy);if(!requireOrdinaryModelPolicy||!ordinaryInputAdmissionHost)throw Error('ordinary_execution_policy_config_invalid');allowedPresets.add('jot-chat')}
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

  const dispatch=async ({ method, url, headers, body, signal = new AbortController().signal },activityAdmissionId) => {
    if (!authorized(headers.authorization, token)) return json(401, { error: 'unauthorized' })
    if(url.pathname === '/v1/taskmaster/installation') {
      if(method !== 'POST') return json(405, {error: 'method_not_allowed'})
      if(!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'owner_id'
        || typeof body.owner_id !== 'string' || !ID.test(body.owner_id) || url.search) return json(422, {error: 'taskmaster_installation_invalid'})
      if(typeof taskmasterInstallationReader !== 'function') return json(503, {error: 'taskmaster_installation_unavailable'})
      try { return json(200, await taskmasterInstallationReader(body.owner_id, signal)) }
      catch(error) { return json(error.message === 'taskmaster_profile_forbidden' ? 404 : 503, {error: 'taskmaster_installation_unavailable'}) }
    }
    if(url.pathname === '/v1/taskmaster/runtime-version') {
      if(method !== 'POST') return json(405, {error: 'method_not_allowed'})
      if(!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'cli_entry_sha256,manifest_sha256,owner_id,profile_id'
        || typeof body.owner_id !== 'string' || !ID.test(body.owner_id) || typeof body.profile_id !== 'string' || !/^dsh-profile-[a-f0-9]{48}$/.test(body.profile_id)
        || ![body.manifest_sha256,body.cli_entry_sha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)) || url.search) return json(422, {error: 'taskmaster_runtime_invalid'})
      if(typeof taskmasterRuntimeVersionReader !== 'function') return json(503, {error: 'taskmaster_runtime_unavailable'})
      try {return json(200, await taskmasterRuntimeVersionReader(body.owner_id, body, signal))}
      catch(error) {return json(error.message === 'taskmaster_runtime_busy' ? 409 : 503, {error: error.message === 'taskmaster_runtime_busy' ? 'taskmaster_runtime_busy' : 'taskmaster_runtime_unavailable'})}
    }
    if(url.pathname.startsWith('/v1/plugin-profile/')){
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      if(typeof pluginProfileControl?.handle!=='function')return json(503,{error:'plugin_profile_unavailable'});
      try{return json(200,await pluginProfileControl.handle({method,pathname:url.pathname,body,signal}));}
      catch(error){
        const code=String(error?.code??error?.message??'');
        if(code==='plugin_profile_scope_mismatch'||code==='plugin_operation_not_authorized')return json(403,{error:'plugin_operation_not_authorized'});
        if(['plugin_operation_unknown','plugin_profile_receipt_not_found','plugin_profile_receipt_state_conflict','plugin_profile_receipt_scope_mismatch'].includes(code))return json(409,{error:'plugin_operation_unknown'});
        if(['plugin_profile_request_invalid','plugin_operation_request_invalid','plugin_operation_id_invalid','plugin_install_spec_invalid','plugin_bundle_name_invalid'].includes(code))return json(422,{error:'plugin_profile_request_invalid'});
        return json(503,{error:'plugin_profile_unavailable'});
      }
    }
    if(hostSettingsProductHandler&&url.pathname.startsWith('/v1/host-admin/settings/')&&url.pathname!=='/v1/host-admin/settings/readiness'){
      const result=await hostSettingsProductHandler({path:url.pathname,method,authorization:headers.authorization,body,...(url.pathname==='/v1/host-admin/settings/write'&&typeof activityAdmissionId==='string'?{activityAdmissionId}:{})});
      if(result)return json(result.status,result.payload);
    }
    if(url.pathname==='/v1/host-admin/bootstrap/redeem'||url.pathname==='/v1/host-admin/settings/read'||url.pathname==='/v1/host-admin/settings/readiness'){
      if(!hostPolicyBootstrap)return json(404,{error:'not_found'});
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      const isRedeem=url.pathname==='/v1/host-admin/bootstrap/redeem';
      const isReadiness=url.pathname==='/v1/host-admin/settings/readiness';
      const expectedKeys=isRedeem?'code,state':'namespace,ticket';
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!==expectedKeys)return json(422,{error:'invalid_host_admin_input'});
      if(isRedeem&&![body.state,body.code].every(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value))
        ||!isRedeem&&(typeof body.ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.ticket)||typeof body.namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(body.namespace)))return json(422,{error:'invalid_host_admin_input'});
      if(!isRedeem&&body.namespace==='jot-host-policy')return json(403,{reason_code:url.pathname.endsWith('/readiness')?'HOST_READINESS_DENIED':'HOST_SETTINGS_DENIED'});
      let result;
      try{
        result=isRedeem
          ?await hostPolicyBootstrap.redeemCode({authorization:headers.authorization,state:body.state,code:body.code})
          :isReadiness
            ?await hostPolicyBootstrap.readReadiness({authorization:headers.authorization,ticket:body.ticket,namespace:body.namespace})
            :await hostPolicyBootstrap.readSettings({authorization:headers.authorization,ticket:body.ticket,namespace:body.namespace});
      }catch{return json(503,{reason_code:isRedeem?'HOST_BOOTSTRAP_DENIED':isReadiness?'HOST_READINESS_UNAVAILABLE':'HOST_SETTINGS_UNAVAILABLE'});}
      if(!result?.ok){
        const reason=String(result?.reason??'');
        const status=/unavailable|clock_unavailable|capacity/.test(reason)?503:
          /namespace_forbidden|component_unauthenticated|caller_unauthenticated/.test(reason)?403:
          /invalid/.test(reason)?422:409;
        return json(status,{reason_code:isRedeem?'HOST_BOOTSTRAP_DENIED':isReadiness?'HOST_READINESS_DENIED':'HOST_SETTINGS_DENIED'});
      }
      if(isRedeem){
        if(Object.keys(result).sort().join(',')!=='expires_at,ok,ticket'||typeof result.ticket!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.ticket)
          ||!Number.isSafeInteger(result.expires_at))return json(503,{reason_code:'HOST_BOOTSTRAP_DENIED'});
        return json(200,{ticket:result.ticket,expires_at:result.expires_at});
      }
      if(isReadiness){
        const readiness=result.readiness;
        if(Object.keys(result).sort().join(',')!=='ok,readiness'||!readiness||typeof readiness!=='object'||Array.isArray(readiness)
          ||readiness.protocol!==1||typeof readiness.as_of!=='string'||readiness.scope?.namespace!==body.namespace)
          return json(503,{reason_code:'HOST_READINESS_UNAVAILABLE'});
        return json(200,result);
      }
      const snapshot=result.settings;
      if(Object.keys(result).sort().join(',')!=='ok,settings'||!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot)
        ||Object.keys(snapshot).sort().join(',')!=='as_of,has_document,namespaces,protocol,source,state,writable'
        ||snapshot.protocol!==1||snapshot.source!=='dsh-settings-controller'||!Array.isArray(snapshot.namespaces)||snapshot.namespaces.length!==1
        ||snapshot.namespaces[0]?.namespace!==body.namespace)return json(503,{reason_code:'HOST_SETTINGS_UNAVAILABLE'});
      return json(200,{settings:snapshot});
    }
    if (url.pathname === '/internal/v1/mcp/reload' || url.pathname === '/internal/v1/mcp/cancel'
      || url.pathname === '/internal/v1/mcp/remove') {
      if (typeof mcpControlRoute !== 'function') return json(503, { error: 'mcp_control_unavailable' })
      return mcpControlRoute({ method, url: url.pathname, body, signal })
    }
    if(['/v1/commands/query','/v1/commands/query/reconcile','/v1/commands/plan-mode','/v1/commands/plan-mode/reconcile'].includes(url.pathname)){
      const reconcile=url.pathname.endsWith('/reconcile');
      const host=url.pathname.startsWith('/v1/commands/plan-mode')?nativePlanModeHost:nativeCommandQueryHost;
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!==(reconcile?'audit,request,scope':'grant_token,request,scope'))return json(422,{error:'native_command_query_invalid'});
      if(!host)return json(503,{error:'native_command_query_unavailable'});
      try{return json(200,await (reconcile?host.reconcile(body,signal):host.execute(body,signal)));}
      catch{return json(reconcile?503:422,{error:reconcile?'native_command_query_audit_unavailable':'native_command_query_invalid'});}
    }
    if (url.pathname === '/v1/skills/read') {
      if (method !== 'POST') return json(405, { error: 'method_not_allowed' })
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== (body.include_manifest===true
          ? (body.include_source_manifest===true?'include_manifest,include_source_manifest,name,protocol,scope':'include_manifest,name,protocol,scope')
          :'name,protocol,scope') || body.protocol !== 1
        || typeof body.name !== 'string' || !body.scope || typeof body.scope !== 'object' || Array.isArray(body.scope)) {
        return json(422, { error: 'skill_content_input_invalid' })
      }
      if (typeof skillContentCommand !== 'function') return json(503, { error: 'skill_content_unavailable' })
      try { return json(200, await skillContentCommand(body, { signal })) }
      catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (['skill_content_scope_forbidden','skill_catalog_scope_forbidden'].includes(code)) return json(404, { error: 'skill_content_not_found' })
        if (['skill_content_command_invalid', 'skill_name_invalid', 'skill_resource_provider_unsupported'].includes(code)) return json(422, { error: 'skill_content_input_invalid' })
        if (['skill_not_found', 'skill_not_user_invocable', 'skill_resource_path_unsafe'].includes(code)) return json(404, { error: 'skill_content_not_found' })
        if (['skill_content_too_large','skill_resource_too_large'].includes(code)) return json(413, { error: 'skill_content_too_large' })
        if (['skill_catalog_incomplete', 'skill_definition_changed', 'skill_content_scope_changed','skill_catalog_scope_changed','skill_resource_changed'].includes(code)) return json(409, { error: 'skill_content_changed' })
        return json(503, { error: 'skill_content_unavailable' })
      }
    }
    if (url.pathname === '/v1/skills/catalog' || url.pathname === '/v1/skills/resource') {
      const resource = url.pathname.endsWith('/resource')
      const expected = resource ? ['protocol','relative_path','scope','skill_name',...(body?.list_directory===true?['list_directory','after']:[])]
        : ['protocol','scope',...(body?.include_commands===true?['include_commands']:[])]
      if (method !== 'POST') return json(405, { error: 'method_not_allowed' })
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== expected.sort().join(',') || body.protocol !== 1
        || !body.scope || typeof body.scope !== 'object' || Array.isArray(body.scope)
        || resource && (typeof body.skill_name !== 'string' || typeof body.relative_path !== 'string')) {
        return json(422, { error: 'skill_catalog_input_invalid' })
      }
      const command = resource ? skillResourceCommand : skillCatalogCommand
      if (typeof command !== 'function') return json(503, { error: 'skill_catalog_unavailable' })
      try { return json(200, await command(body, { signal })) }
      catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (code === 'skill_catalog_scope_forbidden' || ['skill_not_found','skill_not_user_invocable'].includes(code)) return json(404, { error: 'skill_catalog_not_found' })
        if (['skill_catalog_command_invalid','skill_catalog_input_invalid','skill_name_invalid','skill_resource_path_invalid','skill_resource_provider_unsupported'].includes(code)) return json(422, { error: 'skill_catalog_input_invalid' })
        if (['skill_catalog_scope_changed','skill_catalog_changed','skill_resource_changed','skill_catalog_incomplete'].includes(code)) return json(409, { error: 'skill_catalog_changed' })
        if (code === 'skill_resource_too_large') return json(413, { error: 'skill_resource_too_large' })
        if (code === 'skill_resource_path_unsafe') return json(404, { error: 'skill_catalog_not_found' })
        return json(503, { error: 'skill_catalog_unavailable' })
      }
    }
    if(url.pathname==='/v1/conversation-modes/readiness'){
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'chat_mode_readiness_input_invalid'});
      return json(200,typeof chatModeReadiness==='function'?chatModeReadiness():{protocol:1,ready:false,policy:null});
    }
    if(url.pathname==='/v1/models/metadata'){
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='model,provider'
        ||typeof body.provider!=='string'||typeof body.model!=='string')return json(422,{error:'model_metadata_input_invalid'});
      return json(200,typeof trustedModelMetadataReader==='function'
        ?await trustedModelMetadataReader({provider:body.provider,model:body.model},signal)
        :{protocol:1,state:'unavailable',reason:'PRODUCER_UNAVAILABLE',execution_authorized:false});
    }
    if(url.pathname==='/v1/models/metadata/readiness'){
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'model_metadata_readiness_input_invalid'});
      return json(200,{protocol:1,enabled:trustedModelMetadataEnabled===true,execution_authorized:false});
    }
    if(url.pathname==='/v1/models'){
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'model_catalog_input_invalid'});
      return json(200,typeof modelCatalogReader==='function'?await modelCatalogReader(signal):{protocol:1,ready:false,models:[]});
    }
    if (method !== 'POST') return json(405, { error: 'method_not_allowed' })
    if (url.pathname.startsWith('/v1/voice/')) {
      if (!voiceHandler) return json(404, { error: 'not_found' })
      return voiceHandler({ method, url, headers, body, signal })
    }
    const forkSource=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/fork-source$/)
    if(forkSource){
      let sessionId;try{sessionId=decodeURIComponent(forkSource[1])}catch{return json(422,{error:'fork_source_input_invalid'})}
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'fork_source_input_invalid'})
      if(typeof persistence?.open!=='function')return json(503,{error:'fork_source_unavailable'})
      let handle,inspection,failed=false
      try{
        signal.throwIfAborted();handle=await persistence.open(sessionId,'read',{signal});
        const snapshot=await handle.read(0,undefined,{signal});signal.throwIfAborted()
        if(!handle.header||handle.header.id!==sessionId||!Number.isSafeInteger(handle.inheritedEventCount)||handle.inheritedEventCount<0||!Array.isArray(snapshot?.events))throw Error('fork_source_unconfirmed')
        inspection={meta:structuredClone(handle.header),inheritedEventCount:handle.inheritedEventCount,events:structuredClone(snapshot.events)}
      }catch{failed=true}
      try{await handle?.close()}catch{failed=true}
      if(failed)return json(409,{error:'fork_source_unconfirmed'})
      return json(200,{execution_authorized:false,inspection})
    }
    if (url.pathname === '/v1/sessions') {
      const sessionId = String(body?.session_id ?? '')
      const cwd = body?.cwd
      if (!ID.test(sessionId) || typeof cwd !== 'string' || cwd.includes('\u0000') || !isAbsolute(cwd)) return json(422, { error: 'session_input_invalid' })
      return admitInOrder(sessionId,signal,async retain=>{
      const requestedPreset = body?.agent_preset
      if (requestedPreset !== undefined && !allowedPresets.has(requestedPreset)) {
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
    const nativeFile=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/native-file\/range$/);
    if(nativeFile){
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      const sessionId=decodeURIComponent(nativeFile[1]);
      if(!ID.test(sessionId)||url.search||!body||typeof body!=='object'||Array.isArray(body)
        ||Object.keys(body).sort().join(',')!=='owner_id,range'||typeof body.owner_id!=='string'||!ID.test(body.owner_id))
        return json(422,{error:'native_file_range_invalid'});
      if(!nativeWorkspaceFileReader)return json(503,{error:'native_file_range_unavailable'});
      try{return json(200,await nativeWorkspaceFileReader.read(body.owner_id,sessionId,body.range,signal));}
      catch(error){const code=error?.message;
        return json(code==='native_file_range_unavailable'?503:code==='native_file_range_capacity'?429:code==='native_file_range_forbidden'?403:
          code==='native_file_range_invalid'?422:code==='native_file_range_session_not_found'||error?.code==='workspace-file/not-found'?404:409,
          {error:'native_file_range_unavailable'});
      }
    }
    const nativeSearch=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/native-search-source(?:\/search)?$/);
    if(nativeSearch){
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      const sessionId=decodeURIComponent(nativeSearch[1]);
      if(!ID.test(sessionId)||url.search||!body||typeof body!=='object'||Array.isArray(body)
        ||Object.keys(body).sort().join(',')!=='owner_id,source'||typeof body.owner_id!=='string'||!ID.test(body.owner_id))
        return json(422,{error:'native_search_source_invalid'});
      if(!nativeSearchSource)return json(503,{error:'native_search_source_unavailable'});
      try{return json(200,await nativeSearchSource[url.pathname.endsWith('/search')?'search':'read'](body.owner_id,sessionId,body.source,signal));}
      catch(error){
        const code=error?.message;
        return json(code==='native_search_source_capacity'?429:code==='native_search_source_forbidden'?403:code==='native_search_source_not_found'?404:
          code==='native_search_source_invalid'||code==='native_search_source_offset_invalid'?422:409,
          {error:'native_search_source_unavailable'});
      }
    }
    const terminalAttach=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/terminals\/([^/]+)\/attach$/);
    const terminalInput=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/terminals\/([^/]+)\/attachments\/([^/]+)\/input$/);
    if(terminalAttach||terminalInput){
      const match=terminalAttach??terminalInput,sessionId=decodeURIComponent(match[1]),terminalId=decodeURIComponent(match[2]);
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!ID.test(sessionId)||!/^[_A-Za-z0-9-]{1,128}$/.test(terminalId)||url.search||!body||typeof body!=='object'||Array.isArray(body)
        ||Object.keys(body).sort().join(',')!=='owner_id,packet'||typeof body.owner_id!=='string'||!ID.test(body.owner_id))return json(422,{error:'terminal_attachment_invalid'});
      if(!terminalControl)return json(503,{error:'terminal_attachment_unavailable'});
      try{
        if(terminalAttach)return {status:200,stream:await terminalControl.attach(body.owner_id,sessionId,terminalId,body.packet,signal)};
        return json(200,terminalControl.input(body.owner_id,sessionId,terminalId,decodeURIComponent(match[3]),body.packet,signal));
      }catch(error){
        const code=error?.message;
        return json(code==='terminal_input_capacity'||code==='terminal_attachment_capacity'?429:code==='terminal_input_invalid'?422:409,{error:'terminal_attachment_unavailable'});
      }
    }
    const terminalOperation=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/terminals\/(options|recover|commands|receipts)$/)
    if(terminalOperation){
      const sessionId=decodeURIComponent(terminalOperation[1]),operation=terminalOperation[2],write=['commands','receipts'].includes(operation);
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!ID.test(sessionId)||url.search||!body||typeof body!=='object'||Array.isArray(body)
        ||Object.keys(body).sort().join(',')!==(write?'command,owner_id':'owner_id')
        ||typeof body.owner_id!=='string'||!ID.test(body.owner_id))return json(422,{error:'terminal_control_input_invalid'});
      if(!terminalControl)return json(503,{error:'terminal_control_unavailable'});
      try{return json(200,await (operation==='commands'?terminalControl.command(body.owner_id,sessionId,body.command,signal):
        operation==='receipts'?terminalControl.receipt(body.owner_id,sessionId,body.command,signal):
        operation==='recover'?terminalControl.recover(body.owner_id,sessionId,signal):terminalControl.options(body.owner_id,sessionId,signal)));}
      catch(error){
        if(operation==='recover'){
          if(error?.message==='terminal_session_not_found')return json(404,{error:error.message});
          if(['terminal_session_changed','terminal_session_busy','terminal_recovery_capacity'].includes(error?.message))return json(409,{error:error.message});
        }
        if(['terminal_host_changed','terminal_command_conflict','terminal_receipt_capacity'].includes(error?.message))return json(409,{error:error.message});
        return json(503,{error:'terminal_control_unavailable'});
      }
    }
    const terminalList=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/terminals\/list$/)
    if(terminalList){
      const sessionId=decodeURIComponent(terminalList[1]);
      if(method!=='POST')return json(405,{error:'method_not_allowed'});
      if(!ID.test(sessionId)||url.search||!body||typeof body!=='object'||Array.isArray(body)
        ||Object.keys(body).join(',')!=='owner_id'||typeof body.owner_id!=='string'||!ID.test(body.owner_id))return json(422,{error:'terminal_inventory_input_invalid'});
      if(typeof terminalInventoryReader!=='function')return json(503,{error:'terminal_inventory_unavailable'});
      try{return json(200,await terminalInventoryReader(body.owner_id,sessionId,signal));}
      catch{return json(503,{error:'terminal_inventory_unavailable'});}
    }
    const nativeMemberList=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/native-members\/list$/)
    if(nativeMemberList){
      const sessionId=decodeURIComponent(nativeMemberList[1]);
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'native_member_roster_input_invalid'});
      if(typeof nativeRoleHost?.listMembers!=='function')return json(503,{error:'native_member_roster_unavailable'});
      const parent=agents?.get?.(sessionId),binding=parent&&workbenchBridge?.bindingFor?.(parent);
      if(parent?.id!==sessionId||blockedWorkbenchSessions.has(sessionId)||binding?.sessionRef!==sessionId)return json(409,{error:'native_member_parent_unavailable'});
      try{
        const members=await nativeRoleHost.listMembers(parent,{signal});
        if(!Array.isArray(members)||members.some(member=>!member||Object.keys(member).sort().join(',')!=='id,name,role,status'
          ||typeof member.id!=='string'||!ID.test(member.id)||typeof member.name!=='string'||!member.name.trim()||member.name.length>80
          ||member.role!=='teammate'||typeof member.status!=='string'||!member.status||member.status.length>64))return json(409,{error:'native_member_roster_invalid'});
        return json(200,{members,execution_authorized:false});
      }catch{return json(409,{error:'native_member_roster_unavailable'});}
    }
    const nativeMemberInterrupt=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/native-members\/([^/]+)\/interrupt$/)
    if(nativeMemberInterrupt){
      const sessionId=decodeURIComponent(nativeMemberInterrupt[1]),childSessionId=decodeURIComponent(nativeMemberInterrupt[2]);
      if(!ID.test(sessionId)||!ID.test(childSessionId)||!body||typeof body!=='object'||Array.isArray(body)
        ||Object.keys(body).join(',')!=='request_id'||typeof body.request_id!=='string'||!ID.test(body.request_id))return json(422,{error:'native_member_interrupt_input_invalid'});
      if(typeof nativeRoleHost?.interruptMember!=='function')return json(503,{error:'native_member_interrupt_unavailable'});
      const parent=agents?.get?.(sessionId),binding=parent&&workbenchBridge?.bindingFor?.(parent);
      if(parent?.id!==sessionId||blockedWorkbenchSessions.has(sessionId)||binding?.sessionRef!==sessionId)return json(409,{error:'native_member_parent_unavailable'});
      try{
        const receipt=await nativeRoleHost.interruptMember(parent,childSessionId,{requestId:body.request_id,signal});
        if(!receipt||Object.keys(receipt).sort().join(',')!=='execution_authorized,quiescent,request_id,status'||receipt.request_id!==body.request_id
          ||receipt.execution_authorized!==false||receipt.status!=='accepted'||receipt.quiescent!==false)return json(409,{error:'native_member_interrupt_receipt_invalid'});
        return json(200,receipt);
      }catch{return json(409,{error:'native_member_interrupt_unavailable'});}
    }
    const nativeMemberMessage=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/native-members\/([^/]+)\/messages$/)
    if(nativeMemberMessage){
      const sessionId=decodeURIComponent(nativeMemberMessage[1]),childSessionId=decodeURIComponent(nativeMemberMessage[2]);
      if(!ID.test(sessionId)||!ID.test(childSessionId)||!body||typeof body!=='object'||Array.isArray(body)
        ||Object.keys(body).sort().join(',')!=='request_id,text'||typeof body.request_id!=='string'||!ID.test(body.request_id)
        ||typeof body.text!=='string'||!body.text.trim()||Buffer.byteLength(body.text,'utf8')>32768)return json(422,{error:'native_member_wake_input_invalid'});
      if(typeof nativeRoleHost?.wakeMember!=='function')return json(503,{error:'native_member_wake_unavailable'});
      const parent=agents?.get?.(sessionId),binding=parent&&workbenchBridge?.bindingFor?.(parent);
      if(parent?.id!==sessionId||blockedWorkbenchSessions.has(sessionId)||binding?.sessionRef!==sessionId)return json(409,{error:'native_member_parent_unavailable'});
      try{
        const receipt=await nativeRoleHost.wakeMember(parent,childSessionId,{requestId:body.request_id,text:body.text,signal});
        if(!receipt||Object.keys(receipt).sort().join(',')!=='execution_authorized,request_id,status'||receipt.request_id!==body.request_id
          ||receipt.execution_authorized!==false||!['accepted','unknown'].includes(receipt.status))return json(409,{error:'native_member_wake_receipt_invalid'});
        return json(200,receipt);
      }catch{return json(409,{error:'native_member_wake_unavailable'});}
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
    const postAnswer=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/chat-post-answer$/)
    if(postAnswer){
      let sessionId;try{sessionId=decodeURIComponent(postAnswer[1]);}catch{return json(422,{error:'chat_post_answer_invalid'});}const history=body?.history;
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='history'||!history||typeof history!=='object'||Array.isArray(history)||Object.keys(history).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id'||!['owner_id','conversation_id','run_id'].every(k=>typeof history[k]==='string'&&ID.test(history[k]))||!Number.isSafeInteger(history.expected_run_version)||history.expected_run_version<1||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'chat_post_answer_invalid'});
      if(typeof chatPostAnswer?.notify!=='function')return json(503,{error:'chat_post_answer_unavailable'});
      try{return json(202,chatPostAnswer.notify({scope:{...history,session_ref:sessionId},signal}).receipt);}catch{return json(409,{error:'chat_post_answer_unconfirmed'})}
    }
    const checkpointRecovery=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/chat-checkpoint-recovery$/)
    if(checkpointRecovery){
      let sessionId;try{sessionId=decodeURIComponent(checkpointRecovery[1]);}catch{return json(422,{error:'chat_checkpoint_recovery_invalid'});}const history=body?.history;
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='history,intent_id'||typeof body.intent_id!=='string'||!ID.test(body.intent_id)||!history||typeof history!=='object'||Array.isArray(history)||Object.keys(history).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id'||!['owner_id','conversation_id','run_id'].every(k=>typeof history[k]==='string'&&ID.test(history[k]))||!Number.isSafeInteger(history.expected_run_version)||history.expected_run_version<1||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'chat_checkpoint_recovery_invalid'});
      if(typeof chatCheckpointRecovery!=='function')return json(503,{error:'chat_checkpoint_recovery_unavailable'});
      try{return json(200,await chatCheckpointRecovery({scope:{...history,session_ref:sessionId},intent_id:body.intent_id,signal}));}catch{return json(409,{error:'chat_checkpoint_recovery_unconfirmed'})}
    }
    const maintenanceObservation=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/chat-maintenance-observation$/)
    if(maintenanceObservation){
      const sessionId=decodeURIComponent(maintenanceObservation[1]),history=body?.history;
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='history,source_sha256'||typeof body.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(body.source_sha256)||!history||typeof history!=='object'||Array.isArray(history)||Object.keys(history).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id'||!['owner_id','conversation_id','run_id'].every(k=>typeof history[k]==='string'&&ID.test(history[k]))||!Number.isSafeInteger(history.expected_run_version)||history.expected_run_version<1||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'chat_maintenance_observation_invalid'});
      if(typeof chatMaintenanceObserver!=='function')return json(503,{error:'chat_maintenance_observation_unavailable'});
      try{return json(200,await chatMaintenanceObserver({scope:{...history,session_ref:sessionId},expectedSourceSha256:body.source_sha256,signal}));}catch{return json(409,{error:'chat_maintenance_observation_unconfirmed'})}
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
    if(url.pathname==='/v1/ordinary-steering-attachments/readiness'){
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'ordinary_steering_readiness_invalid'});
      const ready=ordinaryInputAdmissionHost?.steeringAttachmentAdmissionProtocol===1&&typeof ordinaryInputAdmissionHost.observeSteeringAdmission==='function'&&ordinaryInputRunHost?.steeringAttachmentAdmissionProtocol===1&&typeof ordinaryCompletionReader==='function'&&typeof ordinarySteeringObservationReader==='function'&&typeof ordinaryRunCompletionReader==='function';
      return json(200,{protocol:1,ready,execution_authorized:false});
    }
    const steeringAdmission=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/steering-admission$/)
    if(steeringAdmission){
      const sessionId=decodeURIComponent(steeringAdmission[1]);let binding;
      try{if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).join(',')!=='ordinary_steer'||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))throw Error();binding={...normalizeOrdinarySteeringExecution(body.ordinary_steer),sessionRef:sessionId};}catch{return json(422,{error:'ordinary_steering_binding_invalid'})}
      if(ordinaryInputAdmissionHost?.steeringAttachmentAdmissionProtocol!==1||typeof ordinaryInputAdmissionHost.observeSteeringAdmission!=='function')return json(503,{error:'ordinary_steering_admission_unavailable'});
      try{return json(200,await ordinaryInputAdmissionHost.observeSteeringAdmission({binding,signal}));}catch{return json(409,{error:'ordinary_steering_admission_unconfirmed'})}
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
      try{return json(200,await readNativeIdleObservation({agents,controller,sessionId,signal,allowedPresets}));}catch{return json(409,{error:'native_idle_observation_unconfirmed'});}
    }
    const browserDriverObservation=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/browser-driver-observation$/)
    if(browserDriverObservation){
      let sessionId,scope;
      try{sessionId=decodeURIComponent(browserDriverObservation[1]);scope=normalizeBrowserDriverScope(body?.scope,sessionId);}
      catch{return json(422,{error:'browser_driver_observation_invalid'});}
      if(method!=='POST'||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='protocol,scope'||body.protocol!==1)
        return json(422,{error:'browser_driver_observation_invalid'});
      const agent=agents?.get?.(sessionId);
      if(!agent||agent.id!==sessionId||typeof workbenchBridge?.observeBrowserDriver!=='function')return json(503,{error:'browser_driver_observation_unavailable'});
      try{return json(200,validateBrowserDriverObservation(await workbenchBridge.observeBrowserDriver(agent,scope,signal),scope));}
      catch{return json(409,{error:'browser_driver_observation_unconfirmed'});}
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
      if(body?.purpose==='lease_takeover'){
        let scope;try{scope=normalizeLeaseTakeoverRequest(body,sessionId)}catch{return json(422,{error:'lease_takeover_input_invalid'})}
        const agent=agents.get(sessionId),value=await settleLeaseTakeover({agent,agents,controller,bridge:workbenchBridge,scope,signal})
        return json(200,value)
      }
      if(body?.purpose!==undefined)return json(422,{error:'cancel_purpose_invalid'})
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
      if(requireOrdinaryModelPolicy&&!workbenchSessions.has(sessionId)&&body.ordinary_input===undefined&&body.ordinary_steer===undefined)return json(409,{error:'ordinary_model_policy_required',reason_code:'DSH_PROMPT_REJECTED'})
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
  };
  const quietPost=(request)=>request?.method==='POST'&&(['/v1/host-admin/bootstrap/redeem','/v1/host-admin/settings/read','/v1/host-admin/settings/editor/read','/v1/host-admin/settings/attempt/read','/v1/host-admin/settings/readiness','/v1/taskmaster/installation','/v1/models','/v1/models/metadata','/v1/models/metadata/readiness','/v1/conversation-modes/readiness'].includes(request?.url?.pathname)||/^\/v1\/sessions\/[^/]+\/(?:terminals\/(?:list|options|receipts)|native-search-source(?:\/search)?|native-file\/range)$/.test(request?.url?.pathname??''));
  return async request=>{
    if(!hostAdmissionGuard||quietPost(request)||!authorized(request?.headers?.authorization,token))return dispatch(request);
    let admission;
    try{admission=await hostAdmissionGuard.begin();}catch{return json(503,{reason_code:'HOST_SETTINGS_UNAVAILABLE'});}
    if(typeof admission!=='string'||!admission)return json(409,{reason_code:'HOST_SETTINGS_DENIED'});
    try{return await dispatch(request,request?.method==='POST'&&request?.url?.pathname==='/v1/host-admin/settings/write'?admission:undefined);}
    finally{try{await hostAdmissionGuard.end(admission);}catch{}}
  };
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
  let hooksConfiguration,hooksRuntime;
  if(config.hooks!==undefined){
    hooksConfiguration=createHooksConfiguration(config.hooks);
    ctx.provide('jotHooksConfiguration',hooksConfiguration);
    hooksRuntime=createHooksRuntime({configuration:hooksConfiguration,
      resolveExecutor:()=>ctx.get('jotHookExecutionAuthority',false)});
    ctx.provide('jotHooksRuntime',hooksRuntime);
    ctx.effect(()=>()=>hooksRuntime.close());
  }
  if(config.pluginProfileEnabled!==undefined&&typeof config.pluginProfileEnabled!=='boolean')throw Error('plugin_profile_config_invalid');
  if(config.pluginProfileEnabled===true&&config.hostSettingsBootstrap===undefined)throw Error('plugin_profile_bootstrap_required');
  if(config.hostCredentialRefs!==undefined&&validateHostCredentialRefs(config.hostCredentialRefs).length&&(!config.hostSettingsBootstrap||config.hostSettingsOwnerRoutesEnabled!==true))throw Error('host_credentials_route_invalid')
  if(config.hostSettingsBootstrap!==undefined)validateHostPolicyBootstrapRuntimeConfig(config.hostSettingsBootstrap)
  if(config.hostSettingsOwnerRoutesEnabled!==undefined&&typeof config.hostSettingsOwnerRoutesEnabled!=='boolean')throw Error('host_settings_owner_routes_config_invalid')
  if(config.hostSettingsOwnerRoutesEnabled===true&&config.hostSettingsBootstrap===undefined)throw Error('host_settings_owner_routes_config_invalid')
  if(config.hostSettingsWriteEnabled!==undefined&&typeof config.hostSettingsWriteEnabled!=='boolean')throw Error('host_settings_write_config_invalid')
  if(config.hostSettingsWriteEnabled===true&&(!config.hostSettingsBootstrap||config.hostSettingsOwnerRoutesEnabled!==true||config.hostSettingsWriteNamespace!=='jot-session-adapter'||!config.hostSettingsBootstrap.namespaces.includes(config.hostSettingsWriteNamespace)||String(process.env[config.workbenchTokenEnv||'GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN']||'').length<32))throw Error('host_settings_write_config_invalid')
  const mcpRuntimeProvider=config.mcpRuntimeProvider??ctx.get?.('jotMcpRuntimeProvider')
  if(mcpRuntimeProvider!==undefined&&(!mcpRuntimeProvider||typeof mcpRuntimeProvider.setup!=='function'||typeof mcpRuntimeProvider.attach!=='function'))throw Error('jot_session_adapter_config_invalid')
  const nativeGitConfig=config.nativeGit===undefined?undefined:normalizeNativeGitHostConfig(config.nativeGit)
  if(nativeGitConfig&&config.nativeWorkspaceAdmission!==true)throw Error('native_git_host_config_invalid')
  if(config.ordinaryModelSelection!==undefined&&typeof config.ordinaryModelSelection!=='boolean'||config.ordinaryModelSelection===true&&config.ordinaryInputAdmission===undefined)throw Error('ordinary_model_policy_config_invalid')
  let chatExecutionPolicy
  if(config.ordinaryExecutionPolicy!==undefined){
    try{if(config.ordinaryModelSelection!==true||!config.ordinaryInputAdmission)throw Error();chatExecutionPolicy=normalizeChatExecutionPolicy(config.ordinaryExecutionPolicy)}catch{throw Error('ordinary_execution_policy_config_invalid')}
  }
  if(config.ordinaryChatContext!==undefined&&typeof config.ordinaryChatContext!=='boolean'||config.ordinaryChatContext===true&&!chatExecutionPolicy)throw Error('chat_context_config_invalid')
  if(config.ordinaryChatWeb!==undefined&&typeof config.ordinaryChatWeb!=='boolean'||config.ordinaryChatWeb===true&&(!chatExecutionPolicy||config.ordinaryChatContext!==true))throw Error('chat_web_config_invalid')
  if(config.ordinaryChatCompaction!==undefined&&typeof config.ordinaryChatCompaction!=='boolean'||config.ordinaryChatCompaction===true&&(!config.ordinaryChatMaintenanceObservation||ctx.get?.('jotChatCompactionRuntime')?.protocol!==1))throw Error('chat_compaction_config_invalid')
  if(config.ordinaryChatCompactionRecovery!==undefined&&typeof config.ordinaryChatCompactionRecovery!=='boolean'||config.ordinaryChatCompactionRecovery===true&&(!config.ordinaryRunHistory||config.ordinaryChatContext!==true||!config.ordinaryInputAdmission))throw Error('chat_checkpoint_recovery_config_invalid')
  if(config.ordinaryChatCompactionAuto!==undefined&&typeof config.ordinaryChatCompactionAuto!=='boolean'||config.ordinaryChatCompactionAuto===true&&(config.ordinaryChatCompaction!==true||config.ordinaryChatCompactionRecovery!==true||config.ordinaryChatContext!==true))throw Error('chat_post_answer_config_invalid')
  const ordinaryPresets=new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted'))
  if(chatExecutionPolicy)ordinaryPresets.add('jot-chat')
  const host = config.host || '127.0.0.1'
  const port = Number(config.port || 18841)
  const token = String(process.env[config.tokenEnv || 'JOT_SESSION_ADAPTER_TOKEN'] || '')
  const voiceEnabled = config.voiceEnabled === true
  const workbenchToken = String(process.env[config.workbenchTokenEnv || 'GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN'] || '')
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || token.length < 32
    || (config.nativeWorkspaceAdmission!==undefined&&typeof config.nativeWorkspaceAdmission!=='boolean')
    || (config.nativeWorkspaceAdmission===true&&workbenchToken.length<16)
    || (config.conversationGoalResume!==undefined&&typeof config.conversationGoalResume!=='boolean')
    || (config.conversationGoalResume===true&&workbenchToken.length<16)
    || (config.ordinaryRunHistory!==undefined&&(!config.ordinaryRunHistory||typeof config.ordinaryRunHistory!=='object'||Array.isArray(config.ordinaryRunHistory)||Object.keys(config.ordinaryRunHistory).sort().join(',')!=='Session,validateLog'||typeof config.ordinaryRunHistory.Session?.create!=='function'||typeof config.ordinaryRunHistory.validateLog!=='function'||config.ordinaryInputAdmission?.admissions?.entryInspectionProtocol!==1||typeof config.ordinaryInputAdmission?.admissions?.read!=='function'||typeof config.ordinaryInputAdmission?.admissions?.inspectEntry!=='function'||typeof ctx.sessionProjections?.snapshot!=='function'||workbenchToken.length<16))
    || (config.ordinaryChatMaintenanceObservation!==undefined&&(!config.ordinaryChatMaintenanceObservation||typeof config.ordinaryChatMaintenanceObservation!=='object'||Array.isArray(config.ordinaryChatMaintenanceObservation)||Object.keys(config.ordinaryChatMaintenanceObservation).sort().join(',')!=='headroomTokens,thresholdRatio'||!Number.isFinite(config.ordinaryChatMaintenanceObservation.thresholdRatio)||config.ordinaryChatMaintenanceObservation.thresholdRatio<=0||config.ordinaryChatMaintenanceObservation.thresholdRatio>1||!Number.isSafeInteger(config.ordinaryChatMaintenanceObservation.headroomTokens)||config.ordinaryChatMaintenanceObservation.headroomTokens<0||config.ordinaryChatContext!==true||!config.ordinaryRunHistory||!chatExecutionPolicy||typeof ctx.get?.('tokenMeter')?.measure!=='function'))
    || (config.ordinaryInputHistory!==undefined&&(!config.ordinaryInputHistory||typeof config.ordinaryInputHistory!=='object'||Array.isArray(config.ordinaryInputHistory)||Object.keys(config.ordinaryInputHistory).sort().join(',')!=='Session,validateLog'||typeof config.ordinaryInputHistory.Session?.create!=='function'||typeof config.ordinaryInputHistory.validateLog!=='function'||config.ordinaryInputAdmission?.admissions?.entryInspectionProtocol!==1||typeof config.ordinaryInputAdmission?.admissions?.inspectEntry!=='function'||workbenchToken.length<16))
    || (config.ordinaryInputRecovery!==undefined&&(!config.ordinaryInputRecovery||typeof config.ordinaryInputRecovery!=='object'||Array.isArray(config.ordinaryInputRecovery)||!['verifyComposition','claimedInput,verifyComposition'].includes(Object.keys(config.ordinaryInputRecovery).sort().join(','))||config.ordinaryInputRecovery.claimedInput!==undefined&&(!config.ordinaryInputRecovery.claimedInput||Object.keys(config.ordinaryInputRecovery.claimedInput).sort().join(',')!=='Session,validateLog'||typeof config.ordinaryInputRecovery.claimedInput.Session?.create!=='function'||typeof config.ordinaryInputRecovery.claimedInput.validateLog!=='function')||typeof config.ordinaryInputRecovery.verifyComposition!=='function'||workbenchToken.length<16||config.ordinaryInputAdmission===undefined))
    || (config.ordinaryInputAdmission!==undefined&&(!config.ordinaryInputAdmission||typeof config.ordinaryInputAdmission!=='object'||!['admissions,profile','admissions,attachmentSteeringProtocol,profile'].includes(Object.keys(config.ordinaryInputAdmission).sort().join(','))||(config.ordinaryInputAdmission.attachmentSteeringProtocol!==undefined&&(config.ordinaryInputAdmission.attachmentSteeringProtocol!==1||config.ordinaryInputAdmission.admissions?.steeringAttachmentAdmissionProtocol!==1))||typeof config.ordinaryInputAdmission.profile?.read!=='function'||typeof config.ordinaryInputAdmission.admissions?.read!=='function'||typeof config.ordinaryInputAdmission.admissions?.create!=='function'||config.ordinaryInputAdmission.admissions.entryReservationProtocol!==1||typeof config.ordinaryInputAdmission.admissions.reserveEntry!=='function'||typeof config.ordinaryInputAdmission.admissions.readReplayCandidate!=='function'||workbenchToken.length<16))
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
  let scopeOf
  let browserConfig
  if(workbenchToken.length>=16){
    try { browserConfig=browserToolsConfigFromEnvironment() } catch {}
  }
  // Preserve synchronous setup and validation when no browser driver is configured.
  if(browserConfig)return createBrowserToolsPlugin({
    approvalForAgent:agent=>ctx.agentPresets?.serviceFor?.(agent,'approval'),
  }).apply(ctx,browserConfig).then(install,()=>install())
  return install()

  function install(browserRegistrar) {
    const scopeKeyForAgent=agent=>{
      scopeOf??=createRequire(ctx.get('profileContext').installAnchor)('@deepseek-ai/dsh-scope').scopeOf
      return scopeOf(agent.ctx)
    }
    const workbenchBridge = workbenchToken.length >= 16 ? new WorkbenchBridge({
      origin: config.workbenchOrigin || 'http://127.0.0.1:18831', token: workbenchToken,
      nativeDelegate:config.nativeRoles===true?(...args)=>{if(!nativeTaskDispatcher)throw new Error('native_task_dispatch_unavailable');return nativeTaskDispatcher(...args)}:undefined,
      webBudgetEnabled:config.webBudgetEnabled===true,
      nativeContinuation: config.nativeContinuation ?? false,
      browserRegistrarForAgent:agent=>ctx.agentPresets?.serviceFor?.(agent,'jotBrowserToolRegistrar'),
      browserRegistrar,
      scopeKeyForAgent,
      modelRouteFor:config.workbenchModel?agent=>ctx.sessionController.agents.selectionFor(agent).current:undefined,
      browserDriverObserverForAgent:agent=>ctx.agentPresets?.serviceFor?.(agent,'jotBrowserToolRegistrar'),
      mcpRuntimeProvider,
    }) : undefined
    if(hooksRuntime&&workbenchBridge){
      if(!ctx.get('jotHookExecutionAuthority',false)){
        const callbacks=createHookCallbackAuthority({runtime:hooksRuntime,bridge:workbenchBridge,
          readAgent:id=>ctx.agents.get(id),
          readIdentity:()=>resolveOwnerBoundDshProfileContext(ctx.get('profileContext')),
          approvalForAgent:agent=>ctx.agentPresets?.serviceFor?.(agent,'approval')??ctx.get('approval',false)});
        ctx.provide('jotHookExecutionAuthority',callbacks);
        ctx.provide('jotHookCallbacks',Object.freeze({register:callbacks.register}));
        ctx.effect(()=>()=>callbacks.close());
      }
      let createHookContextMessage;
      const hooksBridge=createAgentHooksBridge({runtime:hooksRuntime,configuration:hooksConfiguration,
        readStopPayload:(agent,turn,signal)=>readHookStopPayload({agent,turn,signal,
          sessions:ctx.sessions,persistence:ctx.sessionPersistence,readAgent:id=>ctx.agents.get(id)}),
        createUserMessage:input=>{
          createHookContextMessage??=createRequire(ctx.get('profileContext').installAnchor)('@deepseek-ai/dsh-llm').createUserMessage;
          return createHookContextMessage(input);
        },
        resolveSource:async(agent,signal)=>{
          if(ctx.agents.get(agent.id)!==agent)throw Error('hook_original_binding_changed');
          const source=await workbenchBridge.hooksSource(agent,signal);
          if(!source)return null;
          return Object.freeze({...source,assertCurrent:async requestSignal=>{
            if(ctx.agents.get(agent.id)!==agent)throw Error('hook_original_binding_changed');
            await source.assertCurrent(requestSignal);
            if(ctx.agents.get(agent.id)!==agent)throw Error('hook_original_binding_changed');
          }});
        }});
      ctx.on('agent/created',({agent})=>hooksBridge.setup(agent.ctx,agent));
      for(const agent of ctx.agents.list())hooksBridge.setup(agent.ctx,agent);
      ctx.effect(()=>()=>hooksBridge.close());
    }
    const hostPolicyBootstrapConfig=config.hostSettingsBootstrap===undefined?undefined:resolveHostPolicyBootstrapRuntimeConfig(config.hostSettingsBootstrap,{
      webServer:ctx.get?.('webServer')??ctx.webServer,workbenchBridge
    })
    const hostPolicyBootstrapRuntime=hostPolicyBootstrapConfig===undefined?undefined:createHostPolicyBootstrapRuntime({
      ctx,token,config:hostPolicyBootstrapConfig,settingsOwnerRoutesEnabled:config.hostSettingsOwnerRoutesEnabled===true,
      hostSettingsWriteEnabled:config.hostSettingsWriteEnabled===true,hostSettingsWriteNamespace:config.hostSettingsWriteNamespace,
      hostSettingsProductSchema:config.hostSettingsProductSchema,hostCredentialRefs:config.hostCredentialRefs,workbenchBridge
    })
    let pluginProfileControl;
    if(config.pluginProfileEnabled===true){
      if(!workbenchBridge||workbenchToken.length<16)throw Error('plugin_profile_host_unavailable');
      try{
        const profileContext=ctx.get('profileContext');
        const binding=resolveOwnerBoundDshProfileContext(profileContext);
        const nativeRequire=createRequire(profileContext.installAnchor);
        const {resolveBundleDir}=nativeRequire('@deepseek-ai/dsh-app-boot');
        const {parse:parseYaml}=nativeRequire('yaml');
        const evidence=createPluginProfileEvidence({binding,parseYaml,
          readIdentity:()=>resolveOwnerBoundDshProfileContext(ctx.get('profileContext')),
          resolveBundleDirectory:name=>resolveBundleDir('dsh',name,profileContext.installAnchor,binding.profileDirectory)});
        pluginProfileControl=createDshProfilePluginControl({binding,evidence,
          pluginManager:ctx.get('pluginManager'),
          policyAuthority:ctx.get('jotHostPluginMutationAuthority',false),
          gatewayReceiptExecutor:createGatewayPluginProfileReceiptClient({origin:workbenchBridge.origin,token:workbenchToken})
        });
      }catch(cause){throw Error('plugin_profile_host_unavailable',{cause});}
    }
    const hostAdmissionGuard=config.hostSettingsWriteEnabled===true?{
      begin:async()=>{const result=await workbenchBridge.requestHostSettings('admission/begin',{});return result?.kind==='admitted'?result.admission_id:undefined;},
      end:async admission_id=>workbenchBridge.requestHostSettings('admission/end',{admission_id})
    }:undefined
    const mcpControlHost=workbenchBridge&&typeof mcpRuntimeProvider?.resolveReloadScopes==='function'
      ?createMcpControlHost({resolveScopes:createMcpDiscoveryScopeResolver({agents:ctx.agents,provider:mcpRuntimeProvider,
          readState:(identity,signal,controlConfig)=>workbenchBridge.mcpControlState(identity,signal,controlConfig),
          readOwnerBinding:()=>resolveOwnerBoundDshProfileContext(ctx.get('profileContext'))}),
        assertCurrent:async(identity,_phase,signal,controlConfig)=>(await workbenchBridge.mcpControlState(identity,signal,controlConfig)).state})
      :undefined
    const mcpControlRoute=mcpControlHost?createMcpControlRouteHandler(mcpControlHost):undefined
    if(mcpControlHost)ctx.effect(()=>()=>mcpControlHost.dispose())
    let skillYamlParser;
    const skillContentCommand = workbenchBridge && typeof ctx.agents?.get === 'function' && typeof ctx.sessions?.get === 'function'
      ? createSkillContentCommand(createSkillContentReader({ agents: ctx.agents, sessions: ctx.sessions, bridge: workbenchBridge,ordinaryPresets,
        parseYaml:(text,options)=>{
          if(!skillYamlParser){
            const nativeRequire=createRequire(ctx.get('profileContext').installAnchor);
            const provider=nativeRequire.resolve('@deepseek-ai/dsh-skill-filesystem/package.json');
            skillYamlParser=createRequire(provider)('yaml').parse;
          }
          return skillYamlParser(text,options);
        }}))
      : undefined
    const skillCatalogCommand = workbenchBridge && typeof ctx.agents?.get === 'function' && typeof ctx.sessions?.get === 'function'
      ? createSkillCatalogCommand(createSkillCatalogReader({ agents: ctx.agents, sessions: ctx.sessions, bridge: workbenchBridge,ordinaryPresets }))
      : undefined
    const skillResourceCommand = workbenchBridge && typeof ctx.agents?.get === 'function' && typeof ctx.sessions?.get === 'function'
      ? createSkillResourceCommand(createSkillResourceReader({ agents: ctx.agents, sessions: ctx.sessions, bridge: workbenchBridge,ordinaryPresets }))
      : undefined
    const nativeCommandQueryHost=workbenchBridge?createNativeCommandQueryHost({agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,bridge:workbenchBridge,ordinaryPresets}):undefined
    if(nativeCommandQueryHost)ctx.effect(()=>()=>nativeCommandQueryHost.close())
    const nativePlanModeHost=workbenchBridge?createNativeCommandQueryHost({agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,bridge:workbenchBridge,ordinaryPresets,commandPolicy:nativePlanModePolicy}):undefined
    if(nativePlanModeHost)ctx.effect(()=>()=>nativePlanModeHost.close())
    let nativeWorkspaceAdmissionGate
    if(config.nativeWorkspaceAdmission===true){
      nativeWorkspaceAdmissionGate=createNativeWorkspaceAdmissionGate({ctx,bridge:workbenchBridge})
      ctx.effect(()=>()=>nativeWorkspaceAdmissionGate.dispose())
    }
    if(nativeGitConfig){
      let stopped=false,nativeGitHost,ready=false
      const prepared=createNativeGitHost({ctx,bridge:workbenchBridge,admissionGate:nativeWorkspaceAdmissionGate,allowedPresets:new Set(ALLOWED_AGENT_PRESETS),config:nativeGitConfig}).then(async host=>{
        nativeGitHost=host
        if(stopped){await host.dispose();return}
        ready=true;ctx.emit('jot/native-git-readiness',{ready:true})
      }).catch(()=>{if(!stopped)ctx.emit('jot/native-git-readiness',{ready:false,reason:'native_git_host_unavailable'})})
      ctx.provide('jotNativeGitHost',Object.freeze({async readiness(){await prepared;return{ready:ready&&!stopped}}}))
      ctx.effect(()=>async()=>{stopped=true;ready=false;await prepared;await nativeGitHost?.dispose()})
    }
    const modelRouteHealth=config.ordinaryModelSelection===true?createModelRouteHealth({ctx}):undefined
    const trustedModelMetadataReader=createTrustedModelMetadataProducer({llm:ctx.llm,enabled:config.ordinaryModelSelection===true})
    if(modelRouteHealth)ctx.effect(()=>()=>modelRouteHealth.dispose())
    const budgetModelSelector=createBudgetModelSelector({route:config.workbenchModel,llm:ctx.llm,agents:ctx.sessionController.agents,bridge:workbenchBridge,registry:ctx.agents,tokenMeter:config.workbenchModel===undefined?undefined:ctx.get('tokenMeter')})
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
      sessions:ctx.sessions,persistence:ctx.sessionPersistence,automaticClosures:true,publicActivities:true,durableSpawns:true,nativeRecovery:config.nativeRoleRecovery===true,reconcileOperations:config.reconcileOperations,nativeOperationOrigin:config.nativeOperationOrigin,handoffAdmission,onMemberClosed:handoffReturn}):undefined
    let nativeTaskScheduler
    if(nativeRoleHost){
      nativeTaskScheduler=config.nativeDeferredHandoff===true?createNativeTaskScheduler({ctx,bridge:workbenchBridge,host:nativeRoleHost}):undefined
      nativeTaskDispatcher=createNativeTaskDispatcher({bridge:workbenchBridge,host:nativeRoleHost,scheduler:nativeTaskScheduler})
      ctx.effect(()=>async()=>{await nativeTaskScheduler?.dispose();await nativeRoleHost.dispose()})
    }
    const conversationGoalRunHost=config.conversationGoalResume===true?createConversationGoalRunHost({controller:ctx.sessionController,agents:ctx.agents,persistence:ctx.sessionPersistence,bridge:workbenchBridge,ordinaryPresets:new Set([...ALLOWED_AGENT_PRESETS].filter(preset=>preset!=='jot-workbench-budgeted'))}):undefined
    if(conversationGoalRunHost)ctx.effect(()=>()=>conversationGoalRunHost.dispose())
    const executionPolicyReader=chatExecutionPolicy?createOrdinaryExecutionPolicyReader({bridge:workbenchBridge,chatPolicy:chatExecutionPolicy}):undefined
    const ordinaryModelSelector=config.ordinaryModelSelection===true?createOrdinaryModelSelector({bridge:workbenchBridge,llm:ctx.llm,agents:ctx.sessionController.agents,registry:ctx.agents,routeHealth:modelRouteHealth,readTrustedModelMetadata:trustedModelMetadataReader,ordinaryPresets,...(executionPolicyReader?{executionPolicyReader}:{})}):undefined
    let memoryExtractionHost
    if(ordinaryModelSelector||budgetModelSelector){
      const dispatchGuard=installNativeModelDispatchGuard({llm:ctx.llm,installAnchor:ctx.get('profileContext').installAnchor,
        prepareDispatch:options=>memoryExtractionHost?.prepareDispatch(options)??budgetModelSelector?.prepareDispatch(options)??ordinaryModelSelector?.prepareDispatch(options)})
      ctx.effect(()=>()=>dispatchGuard.dispose())
    }
    const contextOptions=config.ordinaryInputAdmission?{bridge:workbenchBridge,sessions:ctx.sessions,createUserMessage:createRequire(ctx.get('profileContext').installAnchor)('@deepseek-ai/dsh-llm').createUserMessage}:undefined
    const contextSelector=contextOptions?createOrdinaryContextSelector({...contextOptions,...(config.ordinaryChatContext===true?{chatPolicy:chatExecutionPolicy}:{})}):undefined
    const webSelector=config.ordinaryChatWeb===true?createChatWebSelector({bridge:workbenchBridge,sessions:ctx.sessions,chatPolicy:chatExecutionPolicy}):undefined
    if(webSelector){
      if(typeof ctx.agents.list!=='function')throw Error('chat_web_host_incompatible')
      ctx.on('agent/created',({agent})=>webSelector.prepareAgent(agent))
      for(const agent of ctx.agents.list())webSelector.prepareAgent(agent)
      ctx.effect(()=>()=>webSelector.dispose())
    }
    let chatCompactionManager
    const ordinaryInputAdmissionHost=config.ordinaryInputAdmission===undefined?undefined:createOrdinaryInputAdmissionHost({ctx,agents:ctx.agents,bridge:workbenchBridge,ordinaryPresets,...config.ordinaryInputAdmission,...(ordinaryModelSelector?{modelSelector:ordinaryModelSelector}:{}),...(contextSelector?{contextSelector}:{}),...(webSelector?{webSelector}:{}),...(config.ordinaryChatCompaction===true?{beforeInput:request=>{if(!chatCompactionManager)throw Error('chat_compaction_manager_unavailable');return chatCompactionManager.beforeInput(request)}}:{})})
    if(ordinaryInputAdmissionHost)ctx.effect(()=>()=>ordinaryInputAdmissionHost.dispose())
    const ordinaryCompletionReader=config.ordinaryInputAdmission===undefined?undefined:createOrdinaryCompletionReader({agents:ctx.agents,bridge:workbenchBridge,ordinaryPresets,readGoal:agent=>nativeGoalsFor(agent)?.get(agent),...config.ordinaryInputAdmission})
    const attachmentHistoryOptions=config.ordinaryInputAdmission?.attachmentSteeringProtocol===1?{attachmentSteeringProtocol:1}:{};
    const ordinarySteeringObservationReader=config.ordinaryInputHistory===undefined?undefined:createOrdinarySteeringObservationReader({agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,bridge:workbenchBridge,admissions:config.ordinaryInputAdmission.admissions,ordinaryPresets,...attachmentHistoryOptions,...config.ordinaryInputHistory})
    const ordinaryRunCompletionReader=config.ordinaryRunHistory===undefined?undefined:createOrdinaryRunCompletionReader({agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,bridge:workbenchBridge,admissions:config.ordinaryInputAdmission.admissions,projections:ctx.sessionProjections,ordinaryPresets,...attachmentHistoryOptions,...config.ordinaryRunHistory})
    const chatCheckpointRecovery=config.ordinaryChatCompactionRecovery===true?createChatCheckpointRecovery({agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,bridge:workbenchBridge,admissions:config.ordinaryInputAdmission.admissions,projections:ctx.sessionProjections,ordinaryPresets,...attachmentHistoryOptions,...config.ordinaryRunHistory}):undefined
    const chatMaintenanceObserver=config.ordinaryChatMaintenanceObservation===undefined?undefined:createChatMaintenanceObserver({bridge:workbenchBridge,agents:ctx.agents,tokenMeter:ctx.get('tokenMeter'),llm:ctx.llm,pressurePolicy:config.ordinaryChatMaintenanceObservation,completionReader:createLiveChatRunCompletionReader({agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,bridge:workbenchBridge,admissions:config.ordinaryInputAdmission.admissions,projections:ctx.sessionProjections,ordinaryPresets,...attachmentHistoryOptions,...config.ordinaryRunHistory})})
    if(config.ordinaryChatCompaction===true){
      chatCompactionManager=createChatCompactionManager({ctx,bridge:workbenchBridge,agents:ctx.agents,presets:ctx.get('agentPresets'),runtime:ctx.get('jotChatCompactionRuntime'),observe:chatMaintenanceObserver,tokenMeter:ctx.get('tokenMeter'),llm:ctx.llm,completionReader:createLiveChatRunCompletionReader({agents:ctx.agents,sessions:ctx.sessions,persistence:ctx.sessionPersistence,bridge:workbenchBridge,admissions:config.ordinaryInputAdmission.admissions,projections:ctx.sessionProjections,ordinaryPresets,...attachmentHistoryOptions,...config.ordinaryRunHistory})})
      ctx.provide('jotChatCompactionManager',chatCompactionManager)
      ctx.effect(()=>()=>chatCompactionManager.dispose())
    }
    const chatPostAnswer=config.ordinaryChatCompactionAuto===true?createChatPostAnswer({bridge:workbenchBridge,agents:ctx.agents,manager:chatCompactionManager,recover:chatCheckpointRecovery,...(typeof ctx.emit==='function'?{onSettled:value=>ctx.emit('jot/chat-post-answer-settled',value)}:{})}):undefined
    if(chatPostAnswer){ctx.provide('jotChatPostAnswer',chatPostAnswer);ctx.effect(()=>()=>chatPostAnswer.dispose())}
    const ordinaryClaimedComposer=config.ordinaryInputRecovery?.claimedInput===undefined?undefined:createOrdinaryClaimedSessionComposer({ctx,bridge:workbenchBridge,agents:ctx.agents,sessions:ctx.sessions,query:typeof ctx.get==='function'?ctx.get('sessionQuery'):ctx.sessionQuery,projections:ctx.sessionProjections,ordinaryPresets,...config.ordinaryInputAdmission,...config.ordinaryInputRecovery.claimedInput})
    if(ordinaryClaimedComposer)ctx.effect(()=>()=>ordinaryClaimedComposer.dispose())
    const ordinaryInputRunHost=config.ordinaryInputRecovery===undefined?undefined:createOrdinaryInputRunHost({controller:ctx.sessionController,agents:ctx.agents,bridge:workbenchBridge,ordinaryPresets,verifyComposition:config.ordinaryInputRecovery.verifyComposition,inputAdmissionHost:ordinaryInputAdmissionHost,claimedComposer:ordinaryClaimedComposer,...attachmentHistoryOptions})
    if(ordinaryInputRunHost)ctx.effect(()=>()=>ordinaryInputRunHost.dispose())
    memoryExtractionHost=createOptionalMemoryExtractionHost({config:config.memoryExtraction,bridge:workbenchBridge,llm:ctx.llm,route:config.workbenchModel})
    if(memoryExtractionHost)ctx.effect(()=>()=>memoryExtractionHost.dispose())
    let ApiSessionNotFound
    if(workbenchBridge||typeof ctx.sessionController.inspect==='function'&&typeof ctx.sessionController.resolveAgent==='function'){
      ({ApiSessionNotFound}=createRequire(ctx.get('profileContext').installAnchor)('@deepseek-ai/dsh-api-session-controller'))
      if(typeof ApiSessionNotFound!=='function'||!(ApiSessionNotFound.prototype instanceof Error))throw Error('jot_session_controller_incompatible')
    }
    const chatModeReadiness=createChatModeReadiness({enabled:config.ordinaryChatModeReadiness,policy:chatExecutionPolicy,mounted:ctx.get?.('jotChatPresetReady'),context:config.ordinaryChatContext,web:config.ordinaryChatWeb,modelSelection:config.ordinaryModelSelection,admission:!!ordinaryInputAdmissionHost});
    for(const ownerRoute of [hostPolicyBootstrapRuntime?.ownerRoute,hostPolicyBootstrapRuntime?.ownerApprovalRoute,hostPolicyBootstrapRuntime?.credentialsOwnerRoute].filter(Boolean)){
      const connection=ctx.get?.('connection')??ctx.connection;
      const dispose=connection.fetch.register(ownerRoute);
      ctx.effect(()=>()=>dispose());
    }
    const nativeSearchSource=createNativeSearchSource({readIdentity:()=>resolveOwnerBoundDshProfileContext(ctx.get('profileContext')),
      agents:ctx.agents,sessions:ctx.sessions,persistence:()=>ctx.sessionPersistence});
    ctx.provide('jotNativeSearchSourceObserver',nativeSearchSource);
    ctx.effect(()=>()=>nativeSearchSource.dispose());
    const nativeWorkspaceFileReader=createNativeWorkspaceFileReader({readIdentity:()=>resolveOwnerBoundDshProfileContext(ctx.get('profileContext')),
      readState:()=>({gateway:ctx.get('typertGateway',false),files:ctx.get('workspaceFiles',false),filesystem:ctx.get('fs',false),
        sessions:ctx.sessions,persistence:ctx.sessionPersistence}),createPeer:()=>{
        const connection=ctx.get('connection',false);
        if(typeof connection?.createPeer!=='function')throw Error('native_file_range_unavailable');
        return connection.createPeer({principal:{kind:'owner'},interactions:'none'});
      }});
    ctx.effect(()=>()=>nativeWorkspaceFileReader.dispose());
    const terminalControl=createTerminalControl({readIdentity:()=>resolveOwnerBoundDshProfileContext(ctx.get('profileContext')),
      terminalController:()=>ctx.get('terminalController',false),sessionController:()=>ctx.sessionController,sessionNotFoundError:ApiSessionNotFound,agents:ctx.agents,sessions:ctx.sessions,
      gateway:()=>ctx.get('typertGateway',false),createPeer:()=>{
        const connection=ctx.get('connection',false);
        if(typeof connection?.createPeer!=='function')throw Error('terminal_attachment_unavailable');
        return connection.createPeer({principal:{kind:'owner'},interactions:'none'});
      }});
    ctx.effect(()=>()=>terminalControl.dispose());
    const taskmasterRuntime=createTaskmasterRuntimeVersionReader({readIdentity:()=>resolveOwnerBoundDshProfileContext(ctx.get('profileContext'))});
    ctx.effect(()=>()=>taskmasterRuntime.close());
    const handler = createAdapterHandler({ controller: ctx.sessionController, fileUploads: ctx.fileUploads, agents: ctx.agents,
      sessions:ctx.sessions,persistence:ctx.sessionPersistence,sessionNotFoundError:ApiSessionNotFound,
      speechController, voiceEnabled, token, workbenchBridge, skillContentCommand, skillCatalogCommand, skillResourceCommand, nativeCommandQueryHost, nativePlanModeHost,
      terminalControl,nativeSearchSource,nativeWorkspaceFileReader,
      terminalInventoryReader:(ownerId,sessionId,signal)=>{
        signal?.throwIfAborted();
        const identity=resolveOwnerBoundDshProfileContext(ctx.get('profileContext'));
        if(identity.ownerId!==ownerId)throw Error('terminal_profile_forbidden');
        const terminals=ctx.get('terminalController',false);
        if(typeof terminals?.list!=='function')throw Error('terminal_inventory_unavailable');
        const inventory=projectTerminalInventory(sessionId,terminals.list(sessionId));
        signal?.throwIfAborted();
        return inventory;
      },
      taskmasterRuntimeVersionReader:(ownerId,expected,signal)=>taskmasterRuntime.read(ownerId,expected,signal),
      taskmasterInstallationReader:(ownerId,signal)=>readTaskmasterInstallation({ownerId,signal,readIdentity:()=>resolveOwnerBoundDshProfileContext(ctx.get('profileContext'))}),
      budgetModelSelector,nativeRoleHost,nativeTaskScheduler,nativeHandoffRecovery:handoffRecovery,nativeClaimedComposer,memoryExtractionHost,conversationGoalRunHost,ordinaryInputRunHost,ordinaryInputAdmissionHost,ordinaryCompletionReader,ordinarySteeringObservationReader,ordinaryRunCompletionReader,chatMaintenanceObserver,chatCheckpointRecovery,chatPostAnswer,nativeIdleObservation:config.nativeIdleObservation===true,
      chatModeReadiness,modelCatalogReader:createModelCatalogReader({llm:ctx.llm,enabled:config.ordinaryModelSelection===true,routeHealth:modelRouteHealth}),trustedModelMetadataReader,trustedModelMetadataEnabled:config.ordinaryModelSelection===true,requireOrdinaryModelPolicy:config.ordinaryModelSelection===true,...(chatExecutionPolicy?{chatExecutionPolicy}:{}),mcpControlRoute,pluginProfileControl,...(hostPolicyBootstrapRuntime?.bootstrap?{hostPolicyBootstrap:hostPolicyBootstrapRuntime.bootstrap}:{}),...(hostPolicyBootstrapRuntime?.productHandler?{hostSettingsProductHandler:hostPolicyBootstrapRuntime.productHandler}:{}),...(hostAdmissionGuard?{hostAdmissionGuard}:{}) })
    const server = createServer(async (req, res) => {
      const abort = new AbortController()
      req.once('aborted', () => abort.abort())
      res.once('close', () => { if (!res.writableEnded) abort.abort() })
      try {
        const url = new URL(req.url, `http://${host}:${port}`)
        const isFileUpload = /^\/v1\/sessions\/[^/]+\/files$/.test(url.pathname)
        const bodyLimit = url.pathname.startsWith('/v1/host-admin/') || /^\/v1\/sessions\/[^/]+\/native-search-source(?:\/search)?$/.test(url.pathname) ? 4096 : /^\/v1\/sessions\/[^/]+\/native-file\/range$/.test(url.pathname) ? 1024 * 1024 : url.pathname.startsWith('/v1/voice/') ? 4 * 1024 * 1024 : 32 * 1024 * 1024
        const result = await handler({ method: req.method, url, headers: req.headers,
          body: isFileUpload ? req : await readJson(req, bodyLimit), signal: abort.signal })
        if (result.stream) {
          res.writeHead(result.status, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
          for await (const frame of result.stream) {
            abort.signal.throwIfAborted();
            if(!res.write(`${JSON.stringify(frame)}\n`))await once(res,'drain',{signal:abort.signal});
          }
          return res.end()
        }
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(result.value))
      } catch (error) {
        const terminalTransport=/^\/v1\/sessions\/[^/]+\/terminals\/[^/]+\/(?:attach|attachments\/[^/]+\/input)$/.test(String(req.url??'').split('?')[0]);
        console.error('[jot-jot-session-adapter] request failed', JSON.stringify(terminalTransport?{code:'terminal_transport_failed'}:adapterErrorSummary(error)))
        if (res.headersSent) return res.destroy()
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: 'adapter_internal_error' }))
      }
    })
    server.once('listening',()=>ctx.emit('jot-session-adapter/ready',{host,port}))
    server.listen(port, host)
    ctx.effect(() => () => server.close())
  }
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
export {createNativeWorkspaceSourceHost} from './native-workspace-source.js'
