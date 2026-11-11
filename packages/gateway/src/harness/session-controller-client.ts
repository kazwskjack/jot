import type {StandaloneTerminalAdmission} from '../terminal/standalone-admissions.ts';
import {validateNativeSearchMembersRequest,validateNativeSearchMembers,validateNativeSearchMemberRangeRequest,validateNativeSearchMemberRange,type NativeSearchMembersRequest,type NativeSearchMembers,type NativeSearchMemberRangeRequest,type NativeSearchMemberRange} from './native-search-members.js';
import {validateHostSettingsProductCommand,validateHostSettingsProductResult,validateHostSettingsEditor,validateHostSettingsApprovalRequest,type HostSettingsProductCommand,type HostSettingsApprovalRequest} from '../host-admin/settings-product-contract.ts';
import {validateNativeFileRangeRequest,validateNativeFileRange,type NativeFileRangeRequest,type NativeFileRange} from './native-file-range.js';
import type {NativeSearchSourceRequest,NativeSearchSourceSearchRequest} from '../events/native-search-source.ts';
import type {PinnedByteSource} from '../artifacts/pinned-byte-source.ts';
import {normalizeExecutionLease,type ExecutionLease} from '../workbench/execution-lease.ts'
import {ordinaryRunCompletionSource,validateOrdinaryRunCompletion,normalizeOrdinaryRunHistoryScope,type OrdinaryRunHistoryScope} from './ordinary-run-completion.ts'
import {normalizeOrdinaryHistoryScope,validateOrdinarySteeringObservation,validateBoundOrdinarySteeringObservation,type OrdinaryHistoryScope} from './ordinary-steering-observation.ts'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
import {nativeIdleSessionId,validateNativeIdleObservation} from './native-idle-observation.ts'
import type {TaskmasterRuntimeVersionRequest} from '../../contracts/types.ts'
import {validateTaskmasterInstallation,validateTaskmasterRuntimeVersion} from '../persistent-tasks/taskmaster-installation.ts'

import {validateTerminalInventory,type TerminalInventory} from '../terminal/inventory.js'
import {validateTerminalOptions,validateTerminalCommand,validateTerminalReceipt,type TerminalOptions,type TerminalCommand,type TerminalReceipt} from '../terminal/control.js'
import {validateTerminalAttachment,validateTerminalInputPacket,validateTerminalAttached,validateTerminalQueued,type TerminalAttachment,type TerminalInputPacket,type TerminalQueued} from '../terminal/stream.js'

export type AdapterFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export type BrowserDriverScope=Readonly<{
  run_id:string;owner_id:string;workspace_id:string;session_id:string;lease_owner:string;lease_generation:number;
}>;
export type BrowserDriverObservation=Readonly<{
  protocol:1;scope:BrowserDriverScope;status:'ready'|'unknown'|'failed';required:true;observed_at:string;
  reason?:string;execution_authorized:false;
}>;
const DRIVER_SCOPE_KEYS='lease_generation,lease_owner,owner_id,run_id,session_id,workspace_id';
const DRIVER_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DRIVER_SAFE_REASON=/^[a-z][a-z0-9_]{0,63}$/;
export function normalizeBrowserDriverScope(value:unknown):BrowserDriverScope{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('driver_scope_invalid');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).sort().join(',')!==DRIVER_SCOPE_KEYS
    ||!['run_id','owner_id','workspace_id','session_id','lease_owner'].every(key=>typeof row[key]==='string'&&DRIVER_ID.test(row[key] as string))
    ||!Number.isSafeInteger(row.lease_generation)||Number(row.lease_generation)<1)throw Error('driver_scope_invalid');
  return Object.freeze({run_id:row.run_id as string,owner_id:row.owner_id as string,workspace_id:row.workspace_id as string,
    session_id:row.session_id as string,lease_owner:row.lease_owner as string,lease_generation:Number(row.lease_generation)});
}

export function validateBrowserDriverObservation(value:unknown,expected:BrowserDriverScope,now=Date.now()):BrowserDriverObservation{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('driver_observation_invalid');
  const row=value as Record<string,unknown>,keys=Object.keys(row).sort().join(',');
  if((keys!=='execution_authorized,observed_at,protocol,required,scope,status'
      &&keys!=='execution_authorized,observed_at,protocol,reason,required,scope,status')
    ||row.protocol!==1||row.execution_authorized!==false||row.required!==true
    ||!['ready','unknown','failed'].includes(String(row.status))||typeof row.observed_at!=='string'||row.observed_at.length>64
    ||row.reason!==undefined&&(typeof row.reason!=='string'||!DRIVER_SAFE_REASON.test(row.reason)))throw Error('driver_observation_invalid');
  const scope=normalizeBrowserDriverScope(row.scope);
  if(Object.keys(scope).some(key=>scope[key as keyof BrowserDriverScope]!==expected[key as keyof BrowserDriverScope]))
    throw Error('driver_scope_changed');
  const observedAt=/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(row.observed_at)?Date.parse(row.observed_at):NaN;
  if(!Number.isFinite(observedAt)||observedAt>now+5000||now-observedAt>60_000)throw Error('driver_observation_stale');
  return Object.freeze({...row,scope}) as BrowserDriverObservation;
}

export type OriginalInputExecution=Readonly<{run_id:string;execution_lease:ExecutionLease}>;
export function normalizeOriginalInputExecution(value:unknown):OriginalInputExecution{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('ordinary_input_binding_invalid');const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='execution_lease,run_id'||typeof row.run_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row.run_id))throw Error('ordinary_input_binding_invalid');
 return Object.freeze({run_id:row.run_id,execution_lease:normalizeExecutionLease(row.execution_lease)});
}
export type OrdinarySteeringExecution=Readonly<{run_id:string;command_id:string;execution_lease:ExecutionLease}>;
export type OrdinarySteeringAdmission=Readonly<{protocol:1;kind:'ordinary_steering_admission';run_id:string;command_id:string;session_id:string;source_sha256:string;state:'accepted'|'unproven';execution_authorized:false}>;
export function normalizeOrdinarySteeringExecution(value:unknown):OrdinarySteeringExecution{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('ordinary_steering_binding_invalid');const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='command_id,execution_lease,run_id'||typeof row.run_id!=='string'||typeof row.command_id!=='string'||![row.run_id,row.command_id].every(id=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id))||row.run_id===row.command_id)throw Error('ordinary_steering_binding_invalid');
 return Object.freeze({run_id:row.run_id,command_id:row.command_id,execution_lease:normalizeExecutionLease(row.execution_lease)});
}
export type ConversationGoalExecution=Readonly<{control_id:string;run_id:string;execution_lease:ExecutionLease}>;
export function normalizeGoalExecution(value:unknown):ConversationGoalExecution{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('goal_control_input_invalid');
  const row=value as Record<string,unknown>;
  if(Object.keys(row).sort().join(',')!=='control_id,execution_lease,run_id'||!['control_id','run_id'].every(key=>typeof row[key]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(row[key] as string)))throw Error('goal_control_input_invalid');
  return Object.freeze({control_id:row.control_id as string,run_id:row.run_id as string,execution_lease:normalizeExecutionLease(row.execution_lease)});
}
export type NativeMemberWakeReceipt=Readonly<{request_id:string;status:'accepted'|'unknown';execution_authorized:false}>;
export type NativeMemberView=Readonly<{id:string;name:string;role:'teammate';status:string}>;
export type NativeMemberRoster=Readonly<{members:readonly NativeMemberView[];execution_authorized:false}>;
export type NativeMemberInterruptReceipt=Readonly<{request_id:string;status:'accepted';quiescent:false;execution_authorized:false}>;

export type SessionPromptPart = { type: 'text'; text: string }
  | { type: 'image'; media_type: string; data: string; name?: string }
  | { type: 'file'; receipt_id: string }

export type ChatCheckpointRecoveryReceipt=Readonly<{
 protocol:1;status:'recovered'|'already_published';checkpoint:Readonly<{
  protocol:1;kind:'chat_compaction_checkpoint';checkpoint_id:string;checkpoint_sha256:string;run_id:string;session_id:string;
  source_sha256:string;summary_text_sha256:string;native_summary_sha256:string;parent_checkpoint_id:string|null;execution_authorized:false;
 }>;execution_authorized:false
}|{protocol:1;status:'unavailable';reason:'NO_ATTEMPT'|'NO_DISPATCHED_ATTEMPT'|'UNSUPPORTED_CONTEXT';checkpoint:null;execution_authorized:false}>;
const CHAT_RECOVERY_TIMEOUT_MS=1000;
function validateChatCheckpointRecovery(value:unknown,sessionId:string,scope:OrdinaryRunHistoryScope):ChatCheckpointRecoveryReceipt{
 const fail=():never=>{throw Error('chat_checkpoint_recovery_receipt_invalid');},row=value as Record<string,unknown>;
 if(!row||typeof row!=='object'||Array.isArray(row)||row.protocol!==1||row.execution_authorized!==false)return fail();
 if(row.status==='unavailable'){
  if(Object.keys(row).sort().join(',')!=='checkpoint,execution_authorized,protocol,reason,status'||row.checkpoint!==null||!['NO_ATTEMPT','NO_DISPATCHED_ATTEMPT','UNSUPPORTED_CONTEXT'].includes(String(row.reason)))return fail();
  return structuredClone(row) as ChatCheckpointRecoveryReceipt;
 }
 if(!['recovered','already_published'].includes(String(row.status))||Object.keys(row).sort().join(',')!=='checkpoint,execution_authorized,protocol,status')return fail();
 const cp=row.checkpoint as Record<string,unknown>;
 if(!cp||typeof cp!=='object'||Array.isArray(cp)||Object.keys(cp).sort().join(',')!=='checkpoint_id,checkpoint_sha256,execution_authorized,kind,native_summary_sha256,parent_checkpoint_id,protocol,run_id,session_id,source_sha256,summary_text_sha256'
  ||cp.protocol!==1||cp.kind!=='chat_compaction_checkpoint'||cp.execution_authorized!==false||cp.run_id!==scope.run_id||cp.session_id!==sessionId
  ||typeof cp.checkpoint_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(cp.checkpoint_id)
  ||cp.parent_checkpoint_id!==null&&(typeof cp.parent_checkpoint_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(cp.parent_checkpoint_id))
  ||!['checkpoint_sha256','source_sha256','summary_text_sha256','native_summary_sha256'].every(k=>typeof cp[k]==='string'&&/^[a-f0-9]{64}$/.test(cp[k] as string)))return fail();
 return structuredClone(row) as ChatCheckpointRecoveryReceipt;
}

export type LeaseTakeoverScope=Readonly<{protocol:1;kind:'lease_takeover';run_id:string;owner_id:string;workspace_id:string;session_id:string;lease_owner:string;lease_generation:number}>;
export type LeaseTakeoverObservation=Readonly<{protocol:1;kind:'lease_takeover';scope:LeaseTakeoverScope;status:'quiescent'|'outcome_unknown'|'unknown';settled:boolean;execution_authorized:false}>;
const LEASE_TAKEOVER_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export function normalizeLeaseTakeoverScope(value:unknown,sessionId?:string):LeaseTakeoverScope{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('lease_takeover_scope_invalid');const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='kind,lease_generation,lease_owner,owner_id,protocol,run_id,session_id,workspace_id'||row.protocol!==1||row.kind!=='lease_takeover'
  ||['run_id','owner_id','workspace_id','session_id','lease_owner'].some(key=>typeof row[key]!=='string'||!LEASE_TAKEOVER_ID.test(row[key] as string))
  ||!Number.isSafeInteger(row.lease_generation)||Number(row.lease_generation)<1||sessionId!==undefined&&row.session_id!==sessionId)throw Error('lease_takeover_scope_invalid');
 return Object.freeze({...row}) as LeaseTakeoverScope;
}

const SAFE_ADAPTER_REASON_CODES = new Set([
  'DSH_IMAGE_MODEL_UNSUPPORTED', 'DSH_IMAGE_INVALID', 'DSH_IMAGE_TOO_MANY_PIXELS',
  'DSH_IMAGE_DIMENSION_TOO_LARGE', 'DSH_IMAGE_STORAGE_FAILED', 'DSH_IMAGE_REFERENCE_INVALID',
  'DSH_IMAGE_TYPE_MISMATCH', 'DSH_IMAGE_TOO_LARGE', 'DSH_IMAGE_INTEGRITY_FAILED',
  'DSH_IMAGE_NOT_FOUND', 'DSH_IMAGE_READ_FAILED', 'DSH_TOO_MANY_IMAGES',
  'DSH_IMAGES_TOO_LARGE', 'DSH_IMAGE_TYPE_UNSUPPORTED', 'DSH_IMAGE_PROJECTION_UNSUPPORTED',
  'DSH_IMAGE_PROCESSING_DEPENDENCY_FAILED',
  'DSH_MODEL_UNAVAILABLE', 'DSH_SESSION_NOT_FOUND', 'DSH_PROMPT_REJECTED',
])

function hostOpaqueToken(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)}
export type HostNamespaceSettingsSnapshot=Readonly<{protocol:1;source:'dsh-settings-controller';as_of:string|null;state:'ready'|'partial'|'unknown'|'unavailable';writable:boolean|null;has_document:boolean|null;
 namespaces:readonly Readonly<{namespace:string;state:'ready'|'partial'|'unknown';auto_generate:boolean|null;revision:number|null;schema:unknown;value:unknown;applies:string;secrets:readonly Readonly<{path:readonly (string|number)[];set:boolean}>[]}>[]}>;
function validateHostSettingsSnapshot(value:unknown,namespace:string):HostNamespaceSettingsSnapshot{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('host_settings_snapshot_invalid');const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='as_of,has_document,namespaces,protocol,source,state,writable'||row.protocol!==1||row.source!=='dsh-settings-controller'
  ||row.as_of!==null&&typeof row.as_of!=='string'||row.writable!==null&&typeof row.writable!=='boolean'||row.has_document!==null&&typeof row.has_document!=='boolean'
  ||!['ready','partial','unknown','unavailable'].includes(String(row.state))||!Array.isArray(row.namespaces)||row.namespaces.length!==1)throw Error('host_settings_snapshot_invalid');
 const item=row.namespaces[0] as Record<string,unknown>|undefined;
 if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='applies,auto_generate,namespace,revision,schema,secrets,state,value'
  ||item.namespace!==namespace||namespace==='jot-host-policy'||!['ready','partial','unknown'].includes(String(item.state))
  ||item.auto_generate!==null&&typeof item.auto_generate!=='boolean'||item.revision!==null&&!Number.isSafeInteger(item.revision)
  ||typeof item.applies!=='string'||!Array.isArray(item.secrets))throw Error('host_settings_snapshot_invalid');
 for(const secret of item.secrets){if(!secret||typeof secret!=='object'||Array.isArray(secret)||Object.keys(secret).sort().join(',')!=='path,set'||typeof secret.set!=='boolean'||!Array.isArray(secret.path)||secret.path.some((part:unknown)=>typeof part!=='string'&&!Number.isInteger(part)))throw Error('host_settings_snapshot_invalid');}
 return value as HostNamespaceSettingsSnapshot;
}

export class SessionAdapterError extends Error {
  readonly reasonCode: string
  readonly status:number
  readonly protocolCode:string|undefined
  constructor(status: number, reasonCode: string,protocolCode?:string) {
    super(`session_adapter_http_${status}`)
    this.name = 'SessionAdapterError'
    this.reasonCode = reasonCode
    this.status=status
    this.protocolCode=protocolCode
  }
}

function endpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('adapter_endpoint_not_loopback')
  }
  return url.toString().replace(/\/$/, '')
}

function nativeEndpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)
    || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('native_endpoint_not_loopback')
  }
  return `${url.toString().replace(/\/$/, '')}/v2/native/tool`
}

export class SessionControllerClient {
  private readonly baseUrl: string
  private readonly nativeUrl: string
  private readonly token: string
  private readonly fetchImpl: AdapterFetch
  constructor(baseUrl: string, token: string, fetchImpl: AdapterFetch = globalThis.fetch,
    nativeBaseUrl = 'http://127.0.0.1:18792') {
    this.baseUrl = endpoint(baseUrl)
    this.nativeUrl = nativeEndpoint(nativeBaseUrl)
    this.token = token
    this.fetchImpl = fetchImpl
    if (token.length < 32) throw new Error('adapter_token_invalid')
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    const value = await response.json() as Record<string, unknown>
    if (!response.ok) {
      const reasonCode = typeof value.reason_code === 'string' && SAFE_ADAPTER_REASON_CODES.has(value.reason_code)
        ? value.reason_code : 'DSH_NO_RUNTIME_OUTCOME'
      throw new SessionAdapterError(response.status, reasonCode,typeof value.error==='string'&&['goal_revision_changed','goal_cold_input_pending','terminal_host_changed','terminal_command_conflict','terminal_receipt_capacity'].includes(value.error)?value.error:undefined)
    }
    return value
  }

  /** Profile identity is Host-selected; only the Gateway-derived owner and original request key cross this channel. */
  async pluginProfileBundles(ownerId: string, signal?: AbortSignal) {
    if (typeof ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId)) throw Error('plugin_profile_request_invalid')
    return this.post('/v1/plugin-profile/bundles/list', {owner_id: ownerId}, signal)
  }

  async installPluginProfileBundle(input: {ownerId: string; operationId: string; spec: string; enabled: boolean}, signal?: AbortSignal) {
    if (!input || typeof input.ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.ownerId)
      || typeof input.operationId !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(input.operationId)
      || typeof input.spec !== 'string' || !input.spec.trim() || input.spec.length > 512 || typeof input.enabled !== 'boolean') throw Error('plugin_profile_request_invalid')
    return this.post('/v1/plugin-profile/bundles/install', {
      owner_id: input.ownerId, operation_id: input.operationId, spec: input.spec, enabled: input.enabled,
    }, signal)
  }

  async enablePluginProfileBundle(input: {ownerId: string; operationId: string; name: string; enabled: boolean}, signal?: AbortSignal) {
    if (!input || typeof input.ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.ownerId)
      || typeof input.operationId !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(input.operationId)
      || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 192 || typeof input.enabled !== 'boolean') throw Error('plugin_profile_request_invalid')
    return this.post('/v1/plugin-profile/bundles/enable', {
      owner_id: input.ownerId, operation_id: input.operationId, name: input.name, enabled: input.enabled,
    }, signal)
  }

  async removePluginProfileBundle(input: {ownerId: string; operationId: string; name: string}, signal?: AbortSignal) {
    if (!input || typeof input.ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.ownerId)
      || typeof input.operationId !== 'string' || !/^[\x21-\x7e]{8,128}$/.test(input.operationId)
      || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 192) throw Error('plugin_profile_request_invalid')
    return this.post('/v1/plugin-profile/bundles/remove', {
      owner_id: input.ownerId, operation_id: input.operationId, name: input.name,
    }, signal)
  }

  async observeTaskmasterRuntimeVersion(ownerId:string,expected:TaskmasterRuntimeVersionRequest,signal?:AbortSignal){
    if(typeof ownerId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId))throw Error('taskmaster_runtime_invalid')
    const deadline=AbortSignal.timeout(25000)
    const value=await this.post('/v1/taskmaster/runtime-version',{owner_id:ownerId,...expected},signal?AbortSignal.any([signal,deadline]):deadline)
    return validateTaskmasterRuntimeVersion(value,ownerId,expected)
  }

  async observeTaskmasterInstallation(ownerId: string, signal?: AbortSignal) {
    if (typeof ownerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId)) throw Error('taskmaster_installation_invalid')
    const deadline = AbortSignal.timeout(5000)
    const value = await this.post('/v1/taskmaster/installation', {owner_id: ownerId}, signal ? AbortSignal.any([signal, deadline]) : deadline)
    return validateTaskmasterInstallation(value, ownerId)
  }

  async create(sessionId: string, cwd: string, agentPreset: string, signal?: AbortSignal, workbenchRunId?: string, workbenchExecutionLease?: ExecutionLease,workWorkspace?:Readonly<{protocol:1}>) {
    return await this.post('/v1/sessions', {
      session_id: sessionId, cwd, agent_preset: agentPreset,
      ...(workbenchRunId ? { workbench_context: { run_id: workbenchRunId, ...(workbenchExecutionLease?{execution_lease:normalizeExecutionLease(workbenchExecutionLease)}:{}),...(workWorkspace?{work_workspace:workWorkspace}:{}) } } : {}),
    }, signal)
  }

  private async standaloneTerminalPost(path:string,body:Record<string,unknown>,signal:AbortSignal){
    signal.throwIfAborted();
    const response=await this.fetchImpl(this.baseUrl+path,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:JSON.stringify(body),signal});
    signal.throwIfAborted();const reader=response.body?.getReader();if(!reader)throw Error('standalone_terminal_source_unconfirmed');
    const chunks:Uint8Array[]=[];let size=0,done=false;
    try{for(;;){const part=await reader.read();signal.throwIfAborted();if(part.done){done=true;break;}size+=part.value.byteLength;if(size>65536)throw Error('standalone_terminal_source_unconfirmed');chunks.push(part.value);}}
    finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!response.ok)throw Error('standalone_terminal_source_unconfirmed');
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  readAuthority(owner:string,workspace:string,signal:AbortSignal){
    return this.standaloneTerminalPost('/v1/standalone-terminals/authority',{owner_id:owner,workspace_id:workspace},signal);
  }
  createSession(admission:StandaloneTerminalAdmission,signal:AbortSignal){
    return this.standaloneTerminalPost('/v1/standalone-terminals/create',admission,signal);
  }
  attachStandaloneTerminal(admission:StandaloneTerminalAdmission,terminal:string,input:TerminalAttachment,signal:AbortSignal){
    if(!/^[_A-Za-z0-9-]{1,128}$/.test(terminal))throw Error('terminal_attachment_invalid');
    const packet=validateTerminalAttachment(input);
    return this.attachTerminalSource('/v1/standalone-terminals/attach',{admission,terminal_id:terminal,packet},admission.session_id,terminal,packet,signal,'error');
  }
  standaloneTerminalInput(admission:StandaloneTerminalAdmission,terminal:string,attachment:string,input:TerminalInputPacket,signal:AbortSignal){
    if(!/^[_A-Za-z0-9-]{1,128}$/.test(terminal))throw Error('terminal_input_invalid');
    const packet=validateTerminalInputPacket(input);validateTerminalAttachment({host_instance:packet.host_instance,attachment_id:attachment});
    return this.standaloneTerminalPost('/v1/standalone-terminals/input',{admission,terminal_id:terminal,attachment_id:attachment,packet},signal);
  }
  standaloneTerminalCommand(admission:StandaloneTerminalAdmission,command:TerminalCommand,signal:AbortSignal){
    return this.standaloneTerminalPost('/v1/standalone-terminals/commands',{admission,command},signal);
  }
  standaloneTerminalReceipt(admission:StandaloneTerminalAdmission,command:TerminalCommand,signal:AbortSignal){
    return this.standaloneTerminalPost('/v1/standalone-terminals/receipts',{admission,command},signal);
  }
  standaloneTerminalOptions(admission:StandaloneTerminalAdmission,signal:AbortSignal){
    return this.standaloneTerminalPost('/v1/standalone-terminals/options',admission,signal);
  }
  recoverStandaloneTerminal(admission:StandaloneTerminalAdmission,signal:AbortSignal){
    return this.standaloneTerminalPost('/v1/standalone-terminals/recover',admission,signal);
  }
  readInventory(admission:StandaloneTerminalAdmission,signal:AbortSignal){
    return this.standaloneTerminalPost('/v1/standalone-terminals/inventory',admission,signal);
  }
  observeSession(admission:StandaloneTerminalAdmission,signal:AbortSignal){
    return this.standaloneTerminalPost('/v1/standalone-terminals/observe',admission,signal);
  }

  async modelCatalog(signal:AbortSignal){return this.post('/v1/models',{},signal);}
  async trustedModelMetadata(route:{provider:string;model:string},signal:AbortSignal){return this.post('/v1/models/metadata',route,signal);}
  async trustedModelMetadataReadiness(signal:AbortSignal){return this.post('/v1/models/metadata/readiness',{},signal);}
  async inspectConversationForkSource(sessionId:string,signal?:AbortSignal):Promise<unknown>{
    try{nativeIdleSessionId(sessionId);}catch{throw Error('fork_native_source_invalid');}
    const value=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/fork-source`,{},signal);
    if(Object.keys(value).sort().join(',')!=='execution_authorized,inspection'||value.execution_authorized!==false||!value.inspection||typeof value.inspection!=='object')throw Error('fork_native_source_invalid');
    return value.inspection;
  }
  async conversationModeReadiness(signal:AbortSignal){return this.post('/v1/conversation-modes/readiness',{},signal);}
  async recoverChatCheckpoint(sessionId:string,input:OrdinaryRunHistoryScope,intentId:string,signal?:AbortSignal):Promise<ChatCheckpointRecoveryReceipt>{
    let scope:OrdinaryRunHistoryScope;try{scope=normalizeOrdinaryRunHistoryScope(sessionId,input);}catch{throw Error('chat_checkpoint_recovery_scope_invalid');}
    if(typeof intentId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(intentId))throw Error('chat_checkpoint_recovery_scope_invalid');
    signal?.throwIfAborted();const deadline=AbortSignal.timeout(CHAT_RECOVERY_TIMEOUT_MS),active=signal?AbortSignal.any([signal,deadline]):deadline;
    const value=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/chat-checkpoint-recovery`,{history:scope,intent_id:intentId},active);
    return validateChatCheckpointRecovery(value,sessionId,scope);
  }

  async redeemHostBootstrap(state:string,code:string,signal?:AbortSignal){
    if(!hostOpaqueToken(state)||!hostOpaqueToken(code))throw Error('host_bootstrap_input_invalid');
    const value=await this.post('/v1/host-admin/bootstrap/redeem',{state,code},signal);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='expires_at,ticket'
      ||!hostOpaqueToken(value.ticket)||!Number.isSafeInteger(value.expires_at))throw Error('host_bootstrap_receipt_invalid');
    return{ticket:value.ticket as string,expires_at:value.expires_at as number};
  }

  async readHostSettings(ticket:string,namespace:string,signal?:AbortSignal):Promise<HostNamespaceSettingsSnapshot>{
    if(!hostOpaqueToken(ticket))throw Error('host_bootstrap_ticket_invalid');
    if(typeof namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(namespace)||namespace==='jot-host-policy')throw Error('host_settings_namespace_invalid');
    const value=await this.post('/v1/host-admin/settings/read',{ticket,namespace},signal);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).join(',')!=='settings')throw Error('host_settings_snapshot_invalid');
    return validateHostSettingsSnapshot(value.settings,namespace);
  }

  async readHostReadiness(ticket:string,namespace:string,signal?:AbortSignal):Promise<Readonly<Record<string,unknown>>>{
    if(!hostOpaqueToken(ticket))throw Error('host_bootstrap_ticket_invalid');
    if(typeof namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(namespace)||namespace==='jot-host-policy')throw Error('host_readiness_namespace_invalid');
    const value=await this.post('/v1/host-admin/settings/readiness',{ticket,namespace},signal);
    const readiness=value?.readiness as Record<string,unknown>|undefined;
    const scope=readiness?.scope as Record<string,unknown>|undefined;
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='ok,readiness'||value.ok!==true
      ||!readiness||typeof readiness!=='object'||Array.isArray(readiness)||readiness.protocol!==1
      ||readiness.as_of!==null&&typeof readiness.as_of!=='string'
      ||!scope||typeof scope!=='object'||Array.isArray(scope)||scope.namespace!==namespace
      ||!['ready','partial','unknown','unavailable'].includes(String(scope.state))
      ||scope.revision!==null&&!Number.isSafeInteger(scope.revision))throw Error('host_readiness_snapshot_invalid');
    return readiness;
  }

  private hostSettingsProductScope(ticket:string,namespace:string,key?:string){
    if(!hostOpaqueToken(ticket)||typeof namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(namespace)||namespace==='jot-host-policy'||key!==undefined&&!/^[A-Za-z0-9_-]{8,128}$/.test(key))throw Error('host_settings_product_scope_invalid');
  }
  async readHostSettingsEditor(ticket:string,namespace:string,signal?:AbortSignal){
    this.hostSettingsProductScope(ticket,namespace);
    const value=await this.post('/v1/host-admin/settings/editor/read',{ticket,namespace},signal);
    if(!value||Object.keys(value).join(',')!=='settings')throw Error('host_settings_product_invalid');
    return validateHostSettingsEditor(value.settings,namespace);
  }
  async saveHostSettings(ticket:string,namespace:string,command:HostSettingsProductCommand,key:string,signal?:AbortSignal){
    this.hostSettingsProductScope(ticket,namespace,key);validateHostSettingsProductCommand(command);
    const value=await this.post('/v1/host-admin/settings/write',{ticket,namespace,idempotency_key:key,command},signal);
    if(!value||Object.keys(value).join(',')!=='result')throw Error('host_settings_product_invalid');
    return validateHostSettingsProductResult(value.result,namespace);
  }
  async queryHostSettingsAttempt(ticket:string,namespace:string,key:string,signal?:AbortSignal){
    this.hostSettingsProductScope(ticket,namespace,key);
    const value=await this.post('/v1/host-admin/settings/attempt/read',{ticket,namespace,idempotency_key:key},signal);
    if(!value||Object.keys(value).join(',')!=='result')throw Error('host_settings_product_invalid');
    return validateHostSettingsProductResult(value.result,namespace);
  }
  async prepareHostSettingsApproval(ticket:string,namespace:string,actorId:string,input:HostSettingsApprovalRequest,signal?:AbortSignal){
    this.hostSettingsProductScope(ticket,namespace);validateHostSettingsApprovalRequest(input);
    if(typeof actorId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(actorId))throw Error('host_settings_approval_actor_invalid');
    const value=await this.post('/v1/host-admin/settings/approval/prepare',{ticket,namespace,authenticated_actor_id:actorId,...input},signal);
    const rawApproval=value?.approval;
    if(!rawApproval||typeof rawApproval!=='object'||Array.isArray(rawApproval))throw Error('host_settings_approval_invalid');
    const approval=rawApproval as Record<string,unknown>;
    if(!value||Object.keys(value).join(',')!=='approval'||!approval||Object.keys(approval).sort().join(',')!=='challenge_id,expires_at,owner_approval_url,purpose,review_sha256'
      ||approval.purpose!==input.purpose||typeof approval.challenge_id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(approval.challenge_id)
      ||typeof approval.review_sha256!=='string'||!/^[a-f0-9]{64}$/.test(approval.review_sha256)
      ||typeof approval.expires_at!=='number'||!Number.isSafeInteger(approval.expires_at)||approval.expires_at<=Date.now()
      ||typeof approval.owner_approval_url!=='string')throw Error('host_settings_approval_invalid');
    const url=new URL(approval.owner_approval_url);
    if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.hash
      ||url.pathname!=='/api/jot-host-settings/approval'||url.searchParams.size!==1||url.searchParams.get('challenge_id')!==approval.challenge_id)
      throw Error('host_settings_approval_invalid');
    return approval as Record<string,unknown>;
  }

  async prompt(sessionId: string, requestId: string, content: string | SessionPromptPart[],
    mode: 'queue' | 'steer' = 'queue', signal?: AbortSignal, original?:OriginalInputExecution) {
    const admission=original===undefined?undefined:normalizeOriginalInputExecution(original);if(admission&&admission.run_id!==requestId)throw Error('ordinary_input_binding_invalid');
    return await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      request_id: requestId, ...(typeof content === 'string' ? { text: content } : { content }), mode,...(admission?{ordinary_input:admission}:{}),
    }, signal)
  }

  async inputCompletion(sessionId:string,execution:OriginalInputExecution,commandIds:readonly string[],signal?:AbortSignal){
    const scope=normalizeOriginalInputExecution(execution);if(!Array.isArray(commandIds)||commandIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id)||id===scope.run_id)||new Set(commandIds).size!==commandIds.length)throw Error('ordinary_completion_input_invalid');
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/input-completion`,{ordinary_input:scope,command_ids:[...commandIds]},signal);
  }

  /** Private read-only history; acceptance facts never authorize another prompt. */
  async observeSteeringHistory(sessionId:string,input:OrdinaryHistoryScope,signal?:AbortSignal){
    const scope=normalizeOrdinaryHistoryScope(sessionId,input);
    return validateOrdinarySteeringObservation(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/steering-history`,{history:scope},signal),sessionId,scope);
  }
  async observeBoundSteeringHistory(sessionId:string,input:OrdinaryHistoryScope,sourceHash:string,signal?:AbortSignal){
    const scope=normalizeOrdinaryHistoryScope(sessionId,input);if(typeof sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(sourceHash))throw Error('ordinary_history_contract_invalid');
    return validateBoundOrdinarySteeringObservation(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/steering-history-v2`,{history:scope,source_sha256:sourceHash},signal),sessionId,scope,sourceHash);
  }
  async observeRunCompletion(sessionId:string,input:OrdinaryRunHistoryScope,source:unknown,signal?:AbortSignal){
    const expected=ordinaryRunCompletionSource(sessionId,input,source);
    return validateOrdinaryRunCompletion(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/run-history-completion`,{history:expected.scope,source_sha256:expected.source_sha256},signal),sessionId,expected.scope,source);
  }
  async ordinaryRunHistoryReadiness(signal?:AbortSignal){
    const deadline=AbortSignal.timeout(15000),value=await this.post('/v1/ordinary-run-history/readiness',{},signal?AbortSignal.any([signal,deadline]):deadline);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='execution_authorized,protocol,ready'||typeof value.ready!=='boolean'||value.protocol!==1||value.execution_authorized!==false)throw Error('ordinary_run_history_readiness_invalid');
    return{ready:value.ready,protocol:1 as const,execution_authorized:false as const};
  }

  /** Trusted post-publication notification. Acceptance is not inference or a
   * checkpoint receipt; the original Host revalidates all source authority. */
  async notifyChatPostAnswer(sessionId:string,input:OrdinaryRunHistoryScope,signal?:AbortSignal){
    const scope=normalizeOrdinaryRunHistoryScope(sessionId,input),value=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/chat-post-answer`,{history:scope},signal);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='execution_authorized,kind,protocol,run_id,run_version,session_id,status'||value.protocol!==1||value.kind!=='chat_post_answer'||value.status!=='accepted'||value.run_id!==scope.run_id||value.session_id!==sessionId||value.run_version!==scope.expected_run_version||value.execution_authorized!==false)throw Error('chat_post_answer_receipt_invalid');
    return value;
  }

  async steerOriginal(sessionId:string,requestId:string,text:string,execution:OrdinarySteeringExecution,signal?:AbortSignal){
    const proof=normalizeOrdinarySteeringExecution(execution);if(proof.command_id!==requestId)throw Error('ordinary_steering_binding_invalid');
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,{request_id:requestId,text,mode:'steer',ordinary_steer:proof},signal);
  }

  async steerOriginalContent(sessionId:string,requestId:string,content:SessionPromptPart[],execution:OrdinarySteeringExecution,signal?:AbortSignal){
    const proof=normalizeOrdinarySteeringExecution(execution);if(proof.command_id!==requestId)throw Error('ordinary_steering_binding_invalid');
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,{request_id:requestId,content,mode:'steer',ordinary_steer:proof},signal);
  }

  async wakeNativeMember(sessionId:string,childSessionId:string,requestId:string,text:string,signal?:AbortSignal):Promise<NativeMemberWakeReceipt>{
    const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    if(![sessionId,childSessionId,requestId].every(value=>typeof value==='string'&&id.test(value))||sessionId===childSessionId
      ||typeof text!=='string'||!text.trim()||Buffer.byteLength(text,'utf8')>32768)throw Error('native_member_wake_invalid');
    const value=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/native-members/${encodeURIComponent(childSessionId)}/messages`,{request_id:requestId,text},signal);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='execution_authorized,request_id,status'
      ||value.execution_authorized!==false||value.request_id!==requestId||!['accepted','unknown'].includes(String(value.status)))throw Error('native_member_wake_receipt_invalid');
    return Object.freeze(value as NativeMemberWakeReceipt);
  }

  async terminalReceipt(ownerId:string,sessionId:string,input:TerminalCommand,signal?:AbortSignal):Promise<TerminalReceipt>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value)))throw Error('terminal_control_input_invalid');
    const command=validateTerminalCommand(input);
    const receipt=validateTerminalReceipt(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/terminals/receipts`,{owner_id:ownerId,command},signal),command,sessionId);
    if(!['pending','completed','unknown'].includes(receipt.state))throw Error('terminal_receipt_invalid');
    return receipt;
  }

  async attachTerminal(ownerId:string,sessionId:string,terminalId:string,input:TerminalAttachment,signal?:AbortSignal):Promise<Readable>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value))||!/^[_A-Za-z0-9-]{1,128}$/.test(terminalId))throw Error('terminal_attachment_invalid');
    const packet=validateTerminalAttachment(input);
    return this.attachTerminalSource(`/v1/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/attach`,{owner_id:ownerId,packet},sessionId,terminalId,packet,signal);
  }

  private async attachTerminalSource(path:string,body:Record<string,unknown>,sessionId:string,terminalId:string,packet:TerminalAttachment,signal?:AbortSignal,redirect?:'error'):Promise<Readable>{
    const controller=new AbortController();
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,stream:Readable|undefined,cleanupPromise:Promise<void>|undefined;
    const abort=()=>{controller.abort();stream?.destroy();};
    const timer=setTimeout(abort,30000);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    const cleanup=()=>cleanupPromise??=Promise.resolve().then(async()=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();
      if(reader){try{await reader.cancel();}catch{}finally{reader.releaseLock();}}
    });
    try {
      const response=await this.fetchImpl(this.baseUrl+path,{
        ...(redirect?{redirect}:{}),method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},
        body:JSON.stringify(body),signal:controller.signal});
      controller.signal.throwIfAborted();
      if(response.body)reader=response.body.getReader();
      if(!response.ok||!reader||!response.headers.get('content-type')?.startsWith('application/x-ndjson'))throw Error('terminal_attachment_unavailable');
      const fragments:Buffer[]=[];let size=0,tail:Uint8Array=new Uint8Array(0);
      while(true){
        const next=await reader.read();if(next.done)throw Error('terminal_attachment_unavailable');
        const newline=next.value.indexOf(10),prefix=newline<0?next.value:next.value.subarray(0,newline);
        size+=prefix.length;if(size>4096)throw Error('terminal_attachment_invalid');
        fragments.push(Buffer.from(prefix));
        if(newline>=0){tail=next.value.subarray(newline+1);break;}
      }
      const opening=Buffer.concat(fragments);
      validateTerminalAttached(JSON.parse(opening.toString('utf8')),{...packet,session_id:sessionId,terminal_id:terminalId});
      controller.signal.throwIfAborted();clearTimeout(timer);
      const source=reader;
      stream=Readable.from((async function*(){
        try{yield Buffer.concat([opening,Buffer.from('\n')]);if(tail.length)yield tail;while(true){const next=await source.read();if(next.done)return;yield next.value;}}
        finally{await cleanup();}
      })(),{objectMode:false});
      // A caller can disconnect between admission and the stream being piped.
      stream.on('error',()=>{});
      stream.once('close',()=>{void cleanup().catch(()=>{});});
      return stream;
    }catch(error){await cleanup();throw error;}
  }

  async terminalInput(ownerId:string,sessionId:string,terminalId:string,attachmentId:string,input:TerminalInputPacket,signal?:AbortSignal):Promise<TerminalQueued>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value))||!/^[_A-Za-z0-9-]{1,128}$/.test(terminalId))throw Error('terminal_input_invalid');
    const packet=validateTerminalInputPacket(input);
    validateTerminalAttachment({host_instance:packet.host_instance,attachment_id:attachmentId});
    const value=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/terminals/${encodeURIComponent(terminalId)}/attachments/${encodeURIComponent(attachmentId)}/input`,{owner_id:ownerId,packet},signal);
    return validateTerminalQueued(value,attachmentId,packet.command.sequence);
  }

  async readNativeFileRange(ownerId:string,sessionId:string,input:NativeFileRangeRequest,signal?:AbortSignal):Promise<NativeFileRange>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value)))throw Error('native_file_range_invalid');
    const range=validateNativeFileRangeRequest(input);
    return validateNativeFileRange(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/native-file/range`,
      {owner_id:ownerId,range},signal),sessionId,range);
  }

  async readNativeSearchMembers(ownerId:string,sessionId:string,input:NativeSearchMembersRequest,signal?:AbortSignal):Promise<NativeSearchMembers>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value)))throw Error('native_search_source_invalid');
    const source=validateNativeSearchMembersRequest(input);
    return validateNativeSearchMembers(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/native-search-source/members`,
      {owner_id:ownerId,source},signal),sessionId,source);
  }

  async readNativeSearchMemberFileRange(ownerId:string,sessionId:string,input:NativeSearchMemberRangeRequest,signal?:AbortSignal):Promise<NativeSearchMemberRange>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value)))throw Error('native_search_source_invalid');
    const source=validateNativeSearchMemberRangeRequest(input);
    return validateNativeSearchMemberRange(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/native-search-source/file-range`,
      {owner_id:ownerId,source},signal),sessionId,source);
  }

  async readNativeSearchSource(ownerId:string,sessionId:string,input:NativeSearchSourceRequest,signal?:AbortSignal):Promise<unknown>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value))
      ||!Number.isSafeInteger(input.call_seq)||input.call_seq<0||!['glob','grep'].includes(input.tool_name)
      ||!Number.isSafeInteger(input.offset_chars)||input.offset_chars<0||input.offset_chars>33554432
      ||input.source_sha256!==undefined&&!/^[a-f0-9]{64}$/.test(input.source_sha256))throw Error('invalid_activity_tool_result_query');
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/native-search-source`,{owner_id:ownerId,source:input},signal);
  }

  async searchNativeSearchSource(ownerId:string,sessionId:string,input:NativeSearchSourceSearchRequest,signal?:AbortSignal):Promise<unknown>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value))
      ||!Number.isSafeInteger(input.call_seq)||input.call_seq<0||!['glob','grep'].includes(input.tool_name)
      ||typeof input.q!=='string'||!input.q||input.q!==input.q.trim()||input.q.length>200)throw Error('invalid_activity_tool_result_query');
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/native-search-source/search`,{owner_id:ownerId,source:input},signal);
  }

  async terminalOptions(ownerId:string,sessionId:string,signal?:AbortSignal):Promise<TerminalOptions>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value)))throw Error('terminal_control_input_invalid');
    return validateTerminalOptions(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/terminals/options`,{owner_id:ownerId},signal),sessionId);
  }

  async terminalCommand(ownerId:string,sessionId:string,input:TerminalCommand,signal?:AbortSignal):Promise<TerminalInventory>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value)))throw Error('terminal_control_input_invalid');
    const command=validateTerminalCommand(input);
    return validateTerminalInventory(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/terminals/commands`,{owner_id:ownerId,command},signal),sessionId);
  }

  async recoverTerminal(ownerId:string,sessionId:string,signal?:AbortSignal):Promise<TerminalOptions>{
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&DRIVER_ID.test(value)))throw Error('terminal_control_input_invalid');
    return validateTerminalOptions(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/terminals/recover`,{owner_id:ownerId},signal),sessionId);
  }

  async listTerminals(ownerId:string,sessionId:string,signal?:AbortSignal):Promise<TerminalInventory>{
    const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    if(![ownerId,sessionId].every(value=>typeof value==='string'&&id.test(value)))throw Error('terminal_inventory_input_invalid');
    return validateTerminalInventory(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/terminals/list`,{owner_id:ownerId},signal),sessionId);
  }

  async listNativeMembers(sessionId:string,signal?:AbortSignal):Promise<NativeMemberRoster>{
    const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    if(typeof sessionId!=='string'||!id.test(sessionId))throw Error('native_member_roster_input_invalid');
    const value=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/native-members/list`,{},signal);
    if(!value||Object.keys(value).sort().join(',')!=='execution_authorized,members'||value.execution_authorized!==false||!Array.isArray(value.members))throw Error('native_member_roster_invalid');
    const seen=new Set<string>(),members=value.members.map((item:unknown)=>{
      const row=item as Record<string,unknown>;
      if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='id,name,role,status'
        ||typeof row.id!=='string'||!id.test(row.id)||typeof row.name!=='string'||!row.name.trim()||row.name.length>80||row.role!=='teammate'
        ||typeof row.status!=='string'||!row.status||row.status.length>64||seen.has(row.id))throw Error('native_member_roster_invalid');
      seen.add(row.id);return Object.freeze({id:row.id,name:row.name,role:'teammate' as const,status:row.status});
    });
    return Object.freeze({members:Object.freeze(members),execution_authorized:false});
  }

  async interruptNativeMember(sessionId:string,childSessionId:string,requestId:string,signal?:AbortSignal):Promise<NativeMemberInterruptReceipt>{
    const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
    if(![sessionId,childSessionId,requestId].every(value=>typeof value==='string'&&id.test(value))||sessionId===childSessionId)throw Error('native_member_interrupt_input_invalid');
    const value=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/native-members/${encodeURIComponent(childSessionId)}/interrupt`,{request_id:requestId},signal);
    if(!value||Object.keys(value).sort().join(',')!=='execution_authorized,quiescent,request_id,status'||value.execution_authorized!==false
      ||value.request_id!==requestId||value.status!=='accepted'||value.quiescent!==false)throw Error('native_member_interrupt_receipt_invalid');
    return Object.freeze(value as NativeMemberInterruptReceipt);
  }

  async observeOriginalSteeringAdmission(sessionId:string,execution:OrdinarySteeringExecution,sourceHash:string,signal?:AbortSignal):Promise<OrdinarySteeringAdmission>{
    nativeIdleSessionId(sessionId);const scope=normalizeOrdinarySteeringExecution(execution);if(!/^[a-f0-9]{64}$/.test(sourceHash))throw Error('ordinary_steering_admission_unconfirmed');
    const deadline=AbortSignal.timeout(5000),value=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/steering-admission`,{ordinary_steer:scope},signal?AbortSignal.any([signal,deadline]):deadline);
    if(!value||Object.keys(value).sort().join(',')!=='command_id,execution_authorized,kind,protocol,run_id,session_id,source_sha256,state'||value.protocol!==1||value.kind!=='ordinary_steering_admission'||value.execution_authorized!==false||value.run_id!==scope.run_id||value.command_id!==scope.command_id||value.session_id!==sessionId||value.source_sha256!==sourceHash||!['accepted','unproven'].includes(String(value.state)))throw Error('ordinary_steering_admission_unconfirmed');
    return Object.freeze(value as unknown as OrdinarySteeringAdmission);
  }

  async steeringAttachmentsReadiness(signal?:AbortSignal){
    const deadline=AbortSignal.timeout(5000),value=await this.post('/v1/ordinary-steering-attachments/readiness',{},signal?AbortSignal.any([signal,deadline]):deadline);
    if(!value||Object.keys(value).sort().join(',')!=='execution_authorized,protocol,ready'||value.protocol!==1||typeof value.ready!=='boolean'||value.execution_authorized!==false)throw Error('ordinary_attachment_readiness_unconfirmed');
    return Object.freeze({protocol:1 as const,ready:value.ready,execution_authorized:false as const});
  }

  /**
   * Call the loopback DSH leaf bridge's native Universe route for internal
   * durable batch-event polling and timing metadata. The model never receives
   * this method as a tool; the bridge still performs its normal typed dispatch.
   */
  async nativeTool(tool: string, args: Record<string, unknown>, execution: Record<string, string>, signal?: AbortSignal) {
    const response = await this.fetchImpl(this.nativeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ tool, arguments: args, execution }),
      ...(signal ? { signal } : {}),
    })
    const value = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(`native_tool_http_${response.status}`)
    return value
  }

  async stageFile(sessionId: string, path: string, displayName: string, signal?: AbortSignal) {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/octet-stream',
        'x-file-name-b64': Buffer.from(displayName, 'utf8').toString('base64url') },
      body: Readable.toWeb(createReadStream(path)) as BodyInit,
      ...(signal ? { signal } : {}),
      ...({ duplex: 'half' } as Record<string, unknown>),
    })
    const value = await response.json() as Record<string, unknown>
    if (!response.ok) throw new SessionAdapterError(response.status, 'DSH_NO_RUNTIME_OUTCOME')
    return value as { receipt_id: string; file?: Record<string, unknown> }
  }

  /** Upload exact anonymous snapshot bytes; no path reopen or native prompt.
   * A confirmed staged file is not command admission or model understanding. */
  async stageVerifiedFile(sessionId:string,source:PinnedByteSource,displayName:string,signal?:AbortSignal){
    if(typeof sessionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(sessionId)||typeof displayName!=='string'||!displayName||displayName.length>255||!source||typeof source.stream!=='function'||!Number.isSafeInteger(source.sizeBytes)||source.sizeBytes<0||typeof source.sha256!=='string'||!/^[a-f0-9]{64}$/.test(source.sha256))throw Error('session_file_source_invalid');
    const response=await this.fetchImpl(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/files`,{
      method:'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/octet-stream','x-file-name-b64':Buffer.from(displayName,'utf8').toString('base64url')},
      body:Readable.toWeb(Readable.from(source.stream(signal))) as BodyInit,...(signal?{signal}:{}),...({duplex:'half'} as Record<string,unknown>),
    });
    if(!response.ok)throw new SessionAdapterError(response.status,'DSH_NO_RUNTIME_OUTCOME');
    let value:Record<string,unknown>;try{value=await response.json() as Record<string,unknown>;}catch{throw Error('session_file_receipt_unconfirmed');}
    const file=value?.file as Record<string,unknown>|undefined;
    if(!value||Object.keys(value).sort().join(',')!=='file,receipt_id'||typeof value.receipt_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value.receipt_id)||!file||Object.keys(file).sort().join(',')!=='attachmentId,bytes,name'||file.attachmentId!=='sha256:'+source.sha256||file.bytes!==source.sizeBytes||typeof file.name!=='string'||!file.name||file.name.length>255||['.','..'].includes(file.name)||/[\\/\0\r\n]/.test(file.name))throw Error('session_file_receipt_unconfirmed');
    return Object.freeze({receipt_id:value.receipt_id,file:Object.freeze({attachmentId:String(file.attachmentId),bytes:source.sizeBytes,name:file.name})});
  }

  async memoryExtractionReadiness(signal:AbortSignal){
    return this.post('/v1/memory-extraction/readiness',{},signal);
  }
  async nativeIdleObservationReadiness(signal?:AbortSignal){
    const deadline=AbortSignal.timeout(5000),value=await this.post('/v1/native-idle-observation/readiness',{},signal?AbortSignal.any([signal,deadline]):deadline);
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='execution_authorized,protocol,ready'||value.protocol!==1||typeof value.ready!=='boolean'||value.execution_authorized!==false)throw Error('native_idle_readiness_invalid');
    return Object.freeze({protocol:1 as const,ready:value.ready,execution_authorized:false as const});
  }
  async observeNativeIdle(sessionId:string,signal?:AbortSignal){
    nativeIdleSessionId(sessionId);const deadline=AbortSignal.timeout(20_000);
    return validateNativeIdleObservation(await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/idle-observation`,{protocol:1},signal?AbortSignal.any([signal,deadline]):deadline),sessionId);
  }
  async observeBrowserDriver(sessionId:string,scope:BrowserDriverScope,signal:AbortSignal){
    const bound=normalizeBrowserDriverScope(scope);
    if(sessionId!==bound.session_id)throw Error('driver_scope_invalid');
    signal.throwIfAborted();
    const value=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/browser-driver-observation`,
      {protocol:1,scope:bound},AbortSignal.any([signal,AbortSignal.timeout(5000)]));
    signal.throwIfAborted();
    return validateBrowserDriverObservation(value,bound);
  }
  async conversationGoal(sessionId:string,body:Record<string,unknown>={},signal?:AbortSignal){
    const deadline=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/conversation-goal`,body,signal?AbortSignal.any([signal,deadline]):deadline);
  }
  async recoverInput(sessionId:string,execution:OriginalInputExecution,signal?:AbortSignal){
    const deadline=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/input-resume`,{ordinary_input:normalizeOriginalInputExecution(execution)},signal?AbortSignal.any([signal,deadline]):deadline);
  }
  async resumeGoal(sessionId:string,control:ConversationGoalExecution,signal?:AbortSignal){
    const deadline=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-resume`,{goal_control:normalizeGoalExecution(control)},signal?AbortSignal.any([signal,deadline]):deadline);
  }
  async conversationGoalResumeReadiness(signal?:AbortSignal){
    const deadline=AbortSignal.timeout(5000);
    return this.post('/v1/conversation-goal-resume/readiness',{},signal?AbortSignal.any([signal,deadline]):deadline);
  }

  async extractMemory(sessionId:string,runId:string,signal:AbortSignal){
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/memory-extraction`,{run_id:runId},signal);
  }

  async cancel(sessionId: string) {
    return await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, {}, AbortSignal.timeout(20_000))
  }

  async leaseTakeover(sessionId:string,value:LeaseTakeoverScope):Promise<LeaseTakeoverObservation>{
    const scope=normalizeLeaseTakeoverScope(value,sessionId),deadline=AbortSignal.timeout(30_000);
    const result=await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/cancel`,{purpose:'lease_takeover',...scope},deadline);
    if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).sort().join(',')!=='execution_authorized,kind,protocol,scope,settled,status'
      ||result.protocol!==1||result.kind!=='lease_takeover'||result.execution_authorized!==false||typeof result.settled!=='boolean'
      ||!['quiescent','outcome_unknown','unknown'].includes(String(result.status)))throw Error('lease_takeover_observation_invalid');
    const observed=normalizeLeaseTakeoverScope(result.scope,sessionId);
    if(Object.keys(scope).some(key=>observed[key as keyof LeaseTakeoverScope]!==scope[key as keyof LeaseTakeoverScope]))throw Error('lease_takeover_scope_changed');
    if(result.status==='quiescent'&&result.settled!==true||result.status==='outcome_unknown'&&result.settled!==true||result.status==='unknown'&&result.settled!==false)throw Error('lease_takeover_observation_invalid');
    return Object.freeze({...result,scope:observed}) as LeaseTakeoverObservation;
  }

  async checkpoint(sessionId:string,afterSeq:number,signal?:AbortSignal){
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/checkpoint`,{after_seq:afterSeq},signal);
  }
  /** Private host observation only; not a model tool or public conversation API. */
  async goalStatus(sessionId:string,signal?:AbortSignal){
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-status`,{},signal);
  }
  async goalStop(sessionId:string,ref:{goal_id:string;goal_revision:number},signal?:AbortSignal){
    const timeout=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-stop`,ref,signal?AbortSignal.any([signal,timeout]):timeout);
  }
  async goalComplete(sessionId:string,intentId:string,signal?:AbortSignal){
    const timeout=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-complete`,{intent_id:intentId},signal?AbortSignal.any([signal,timeout]):timeout);
  }
  async goalRestore(sessionId:string,runId:string,intentId?:string,signal?:AbortSignal){
    const timeout=AbortSignal.timeout(20_000);
    return this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/goal-restore`,{run_id:runId,...(intentId===undefined?{}:{intent_id:intentId})},signal?AbortSignal.any([signal,timeout]):timeout);
  }

  async *follow(sessionId: string, signal?: AbortSignal,goalControl?:ConversationGoalExecution,ordinaryInput?:OriginalInputExecution): AsyncGenerator<Record<string, unknown>> {
    if(goalControl&&ordinaryInput)throw Error('ordinary_input_binding_invalid');
    const response = await this.fetchImpl(`${this.baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/follow`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ max_messages: 100, assistant_stream: true,...(goalControl?{goal_control:normalizeGoalExecution(goalControl)}:{}),...(ordinaryInput?{ordinary_input:normalizeOriginalInputExecution(ordinaryInput)}:{}) }),
      ...(signal ? { signal } : {}),
    })
    if (!response.ok || !response.body) throw new Error(`session_adapter_follow_http_${response.status}`)
    const decoder = new TextDecoder()
    let pending = ''
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line) yield JSON.parse(line) as Record<string, unknown>
        newline = pending.indexOf('\n')
      }
    }
    pending += decoder.decode()
    if (pending.trim()) yield JSON.parse(pending) as Record<string, unknown>
  }
}
