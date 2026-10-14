import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { createVoiceAdapterHandler } from './voice.js'
import {createBudgetModelSelector} from './budget-model-selection.js'
import {createNativeTaskDispatcher} from './native-task-dispatch.js'
import {createNativeRoleHost} from './native-role-host.js'
import {conversationGoal} from './conversation-goal.js'
import { WorkbenchBridge,normalizeHostExecutionLease } from './workbench.js'

export const name = 'jot-jot-session-adapter'
export const inject = ['sessionController', 'fileUploads', 'agents','sessions','sessionPersistence','llm']

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

const BINDING_FAILURE_CODES=new Set(['workbench_run_forbidden','workbench_goal_binding_changed','workbench_host_incompatible','workbench_goal_unavailable','workbench_goal_context_invalid','workbench_goal_identity_conflict','workbench_goal_stopped','workbench_context_invalid','workbench_binding_lease_required','workbench_model_host_incompatible','workbench_model_route_changed','workbench_budget_binding_required','workbench_binding_missing','workbench_binding_changed','workbench_goal_native_driver_unavailable']);
export function bindingFailureSummary(stage,error){
  return {stage:stage==='model-select'?'model-select':'attach',code:BINDING_FAILURE_CODES.has(error?.message)?error.message:'workbench_binding_failed'};
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

export function createAdapterHandler({ controller, fileUploads, agents, sessions, persistence, speechController, voiceEnabled = false, token, workbenchBridge,budgetModelSelector,nativeRoleHost }) {
  const voiceHandler = voiceEnabled ? createVoiceAdapterHandler({ speechController, token }) : null
  const workbenchSessions = new Set()
  const blockedWorkbenchSessions = new Set()
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
      const requestedPreset = body?.agent_preset
      if (requestedPreset !== undefined && !ALLOWED_AGENT_PRESETS.has(requestedPreset)) {
        return json(422, { error: 'agent_preset_not_allowed' })
      }
      const request = { sessionId, cwd }
      const workbenchRunId = body?.workbench_context?.run_id
      let workbenchExecutionLease
      if (body?.workbench_context !== undefined) {
        if (!ID.test(String(workbenchRunId ?? ''))) return json(422, { error: 'workbench_binding_invalid' })
        try{if(body.workbench_context.execution_lease!==undefined)workbenchExecutionLease=normalizeHostExecutionLease(body.workbench_context.execution_lease)}catch{return json(422,{error:'workbench_binding_invalid'})}
        if (!workbenchBridge?.attach || !agents?.get) return json(503, { error: 'workbench_bridge_unavailable' })
        workbenchSessions.add(sessionId)
        blockedWorkbenchSessions.add(sessionId)
      }
      if(requestedPreset==='jot-workbench-budgeted'&&(!workbenchRunId||!workbenchExecutionLease))return json(422,{error:'workbench_budget_binding_required'})
      if(requestedPreset==='jot-workbench-budgeted'&&(typeof budgetModelSelector!=='function'||typeof workbenchBridge?.guardBudget!=='function'))return json(503,{error:'workbench_model_unavailable'})
      if (requestedPreset !== undefined) request.agentPreset = requestedPreset
      const value = await controller.create(request)
      if (workbenchRunId !== undefined) {
        try { await workbenchBridge.attach(agents.get(sessionId), { runId: String(workbenchRunId), sessionRef: sessionId,...(workbenchExecutionLease?{executionLease:workbenchExecutionLease}:{}) },{sessions,persistence,signal}) }
        catch (error) { console.error('[jot-workbench-binding]',JSON.stringify(bindingFailureSummary('attach',error)));return json(503, { error: 'workbench_bridge_unavailable' }) }
        if(requestedPreset==='jot-workbench-budgeted'){
          try{const agent=agents.get(sessionId);await budgetModelSelector(agent,()=>workbenchBridge.guardBudget(agent,signal),signal)}
          catch(error){console.error('[jot-workbench-binding]',JSON.stringify(bindingFailureSummary('model-select',error)));return json(503,{error:'workbench_bridge_unavailable'})}
        }
        blockedWorkbenchSessions.delete(sessionId)
      }
      return json(201, value)
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
    const chatGoal=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/conversation-goal$/)
    if(chatGoal){
      const sessionId=decodeURIComponent(chatGoal[1]);
      if(!ID.test(sessionId)||workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId))return json(422,{error:'conversation_goal_scope_invalid'});
      try{return json(200,conversationGoal(agents?.get?.(sessionId),body))}
      catch(error){return json(409,{error:error.message==='goal_revision_changed'?'goal_revision_changed':'conversation_goal_unavailable'})}
    }
    const goalStatus=url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal-status$/)
    if(goalStatus){
      const sessionId=decodeURIComponent(goalStatus[1])
      if(!ID.test(sessionId)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return json(422,{error:'goal_status_input_invalid'})
      if(!workbenchSessions.has(sessionId)||blockedWorkbenchSessions.has(sessionId)||!workbenchBridge?.observe||!agents?.get)return json(503,{error:'goal_status_unavailable'})
      try{return json(200,{state:await workbenchBridge.observe(agents.get(sessionId),signal)})}
      catch{return json(409,{error:'goal_status_unavailable'})}
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
      const content = promptContent(body)
      const mode = body?.mode === 'steer' ? 'steer' : 'queue'
      if (!ID.test(sessionId) || !ID.test(requestId) || !content) return json(422, { error: 'prompt_input_invalid' })
      if (workbenchSessions.has(sessionId)) {
        if (blockedWorkbenchSessions.has(sessionId) || !workbenchBridge?.guard || !agents?.get) return json(503, { error: 'workbench_bridge_unavailable' })
        try { await workbenchBridge.guard(agents.get(sessionId), signal) }
        catch { return json(409, { error: 'workbench_run_forbidden' }) }
      }
      let value
      try {
        // Admission passes human content unchanged. Login operations are only
        // executed through explicit tools with trusted scope and consent checks.
        value = await controller.prompt({ requestId, sessionId, mode, content }, signal)
      } catch (error) {
        // Keep protocol-visible diagnostics stable and allow-listed. Remote error
        // messages/details may contain model, filesystem, or user-provided data.
        const hasImage = content.some(part => part.type === 'image')
        const reasonCode = hasImage && hasKnownSharpNativeImportFailure(error)
          ? 'DSH_IMAGE_PROCESSING_DEPENDENCY_FAILED' : promptFailureReasonCode(error)
        return json(422, { error: 'prompt_rejected', reason_code: reasonCode })
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
    || (config.nativeContinuation !== undefined && typeof config.nativeContinuation !== 'boolean')
    || (config.webBudgetEnabled !== undefined && typeof config.webBudgetEnabled !== 'boolean')
    || (config.nativeRoles !== undefined && typeof config.nativeRoles !== 'boolean')
    || (config.nativeRoleRecovery !== undefined && typeof config.nativeRoleRecovery !== 'boolean')
    || (config.reconcileOperations !== undefined && (typeof config.reconcileOperations !== 'function' || config.nativeRoles !== true))
    || (config.nativeOperationOrigin !== undefined && (typeof config.nativeOperationOrigin !== 'string' || config.nativeRoles !== true || config.reconcileOperations !== undefined))
    || (config.nativeRoleRecovery===true&&config.nativeRoles!==true)
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
  const nativeRoleHost=config.nativeRoles===true?createNativeRoleHost({ctx,bridge:workbenchBridge,selectModel:budgetModelSelector,
    sessions:ctx.sessions,persistence:ctx.sessionPersistence,automaticClosures:true,durableSpawns:true,nativeRecovery:config.nativeRoleRecovery===true,reconcileOperations:config.reconcileOperations,nativeOperationOrigin:config.nativeOperationOrigin}):undefined
  if(nativeRoleHost){nativeTaskDispatcher=createNativeTaskDispatcher({bridge:workbenchBridge,host:nativeRoleHost});ctx.effect(()=>()=>nativeRoleHost.dispose())}
  const handler = createAdapterHandler({ controller: ctx.sessionController, fileUploads: ctx.fileUploads, agents: ctx.agents,
    sessions:ctx.sessions,persistence:ctx.sessionPersistence,
    speechController, voiceEnabled, token, workbenchBridge,
    budgetModelSelector,nativeRoleHost })
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
