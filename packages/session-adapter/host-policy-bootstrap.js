import {createHash,randomBytes} from 'node:crypto';
import {HOST_POLICY_NAMESPACE,HOST_POLICY_READ_OPERATION} from './host-policy-constants.js';

const BINDING_KEYS=['actor_id','epoch','expires_at','gateway_id','host_instance_id','namespace','operation'];
const deny=reason=>({ok:false,reason});
const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');
const randomToken=()=>randomBytes(32).toString('base64url');
const isToken=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{32,128}$/.test(value);

function validLifetime(value,maximum){
  return Number.isSafeInteger(value)&&value>0&&value<=maximum;
}

function normalizeBinding(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const keys=Object.keys(value).sort();
  if(keys.length!==BINDING_KEYS.length||keys.some((key,index)=>key!==BINDING_KEYS[index]))return undefined;
  if(!['gateway_id','actor_id','host_instance_id','operation','namespace'].every(key=>typeof value[key]==='string'&&value[key].length>0)
    ||!Number.isSafeInteger(value.epoch)||value.epoch<1
    ||!Number.isSafeInteger(value.expires_at)||value.expires_at<1)return undefined;
  return {
    gateway_id:value.gateway_id,
    actor_id:value.actor_id,
    host_instance_id:value.host_instance_id,
    operation:value.operation,
    namespace:value.namespace,
    epoch:value.epoch,
    expires_at:value.expires_at
  };
}

async function policySnapshot(readPolicySnapshot){
  try{
    const snapshot=await readPolicySnapshot();
    if(!snapshot||typeof snapshot!=='object')return {ok:false,reason:'policy_unavailable'};
    if(!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!Array.isArray(snapshot.bindings))return {ok:false,reason:'policy_malformed'};
    const bindings=snapshot.bindings.map(normalizeBinding);
    if(bindings.some(binding=>!binding))return {ok:false,reason:'policy_malformed'};
    return {ok:true,revision:snapshot.revision,bindings};
  }catch{return {ok:false,reason:'policy_unavailable'};}
}

function owner(peer){
  return peer?.principal?.kind==='owner';
}

/**
 * Build the Host-private, process-local state machine used by owner-approved
 * settings reads. Persistent policy changes remain the DSH owner's existing
 * settings Remote responsibility; this helper only validates that snapshot.
 */
export function createHostPolicyBootstrapAuthority({
  gatewayId,
  actorId,
  hostInstanceId,
  namespaces,
  readPolicySnapshot,
  authenticateComponent,
  resolveAuthenticatedActor,
  createActorContext,
  issueReadGrant,
  readSettings,
  readReadiness,
  now=()=>Date.now(),
  ownerNonceLifetimeMs=90_000,
  codeLifetimeMs=60_000,
  contextLifetimeMs=300_000,
  maxPendingOwnerNonces=32,
  maxPendingApprovals=32,
  maxPendingCodes=64,
  maxContexts=64,
  maxPendingStates=128,
  stateLifetimeMs=90_000
}={}){
  if(![gatewayId,actorId,hostInstanceId].every(value=>typeof value==='string'&&value.length>0))throw new TypeError('host_bootstrap_identity_invalid');
  if(!Array.isArray(namespaces)||namespaces.length===0||namespaces.some(namespace=>typeof namespace!=='string'||!namespace||namespace===HOST_POLICY_NAMESPACE))throw new TypeError('host_bootstrap_namespaces_invalid');
  if(typeof readPolicySnapshot!=='function'||typeof authenticateComponent!=='function'||typeof resolveAuthenticatedActor!=='function'
    ||typeof createActorContext!=='function'||typeof issueReadGrant!=='function'||typeof readSettings!=='function')throw new TypeError('host_bootstrap_dependency_invalid');
  if(readReadiness!==undefined&&typeof readReadiness!=='function')throw new TypeError('host_bootstrap_dependency_invalid');
  if(!validLifetime(ownerNonceLifetimeMs,90_000)||!validLifetime(codeLifetimeMs,60_000)||!validLifetime(contextLifetimeMs,300_000)||!validLifetime(stateLifetimeMs,90_000))throw new TypeError('host_bootstrap_lifetime_invalid');
  if(![maxPendingOwnerNonces,maxPendingApprovals,maxPendingCodes,maxContexts,maxPendingStates].every(value=>Number.isSafeInteger(value)&&value>0&&value<=4096))throw new TypeError('host_bootstrap_capacity_invalid');

  const allowedNamespaces=new Set(namespaces);
  const ownerNonces=new Map();
  const approvals=new Map();
  const usedStates=new Map();
  const codes=new Map();
  const contexts=new Map();

  function currentTime(){
    try{const value=now();return Number.isSafeInteger(value)&&value>=0?value:undefined;}catch{return undefined;}
  }

  function reap(map,time){
    for(const [key,value] of map)if(value.expiresAt<=time)map.delete(key);
  }

  function purge(time){
    reap(ownerNonces,time);
    reap(approvals,time);
    reap(usedStates,time);
    reap(codes,time);
    reap(contexts,time);
  }

  function fixedComponent(authorization){
    try{return authenticateComponent(authorization)===gatewayId;}catch{return false;}
  }

  function namespaceList(value){
    if(!Array.isArray(value)||value.length===0)return undefined;
    const out=[];
    const seen=new Set();
    for(const namespace of value){
      if(typeof namespace!=='string'||!allowedNamespaces.has(namespace)||namespace===HOST_POLICY_NAMESPACE||seen.has(namespace))return undefined;
      seen.add(namespace);out.push(namespace);
    }
    return out;
  }

  function exactBindings(snapshot,requested,time){
    const selected=[];
    for(const namespace of requested){
      const rows=snapshot.bindings.filter(binding=>binding.gateway_id===gatewayId&&binding.actor_id===actorId
        &&binding.host_instance_id===hostInstanceId&&binding.operation===HOST_POLICY_READ_OPERATION
        &&binding.namespace===namespace&&binding.expires_at>time);
      if(rows.length!==1)return undefined;
      selected.push({namespace,epoch:rows[0].epoch,expiresAt:rows[0].expires_at});
    }
    return selected;
  }

  function snapshotMatches(context,snapshot,time,namespace){
    if(snapshot.revision!==context.policyRevision)return false;
    const expected=context.bindings.filter(binding=>namespace===undefined||binding.namespace===namespace);
    for(const binding of expected){
      const rows=snapshot.bindings.filter(row=>row.gateway_id===context.gatewayId&&row.actor_id===context.actorId
        &&row.host_instance_id===context.hostInstanceId&&row.operation===HOST_POLICY_READ_OPERATION
        &&row.namespace===binding.namespace&&row.epoch===binding.epoch&&row.expires_at===binding.expiresAt&&row.expires_at>time);
      if(rows.length!==1)return false;
    }
    return expected.length>0;
  }

  function createOwnerPageNonce(peer){
    if(!owner(peer))return deny('owner_required');
    const time=currentTime();if(time===undefined)return deny('clock_unavailable');
    purge(time);
    if(ownerNonces.size>=maxPendingOwnerNonces)return deny('owner_capacity');
    const nonce=randomToken(),key=digest(nonce),expiresAt=time+ownerNonceLifetimeMs;
    if(ownerNonces.has(key)||!Number.isSafeInteger(expiresAt))return deny('nonce_unavailable');
    ownerNonces.set(key,{expiresAt});
    return {ok:true,nonce,expires_at:expiresAt};
  }

  function beginOwnerApproval({peer,ownerPageNonce,state,namespaces:requestedNamespaces}={}){
    if(!owner(peer))return deny('owner_required');
    if(!isToken(ownerPageNonce)||!isToken(state))return deny('bootstrap_input_invalid');
    const requested=namespaceList(requestedNamespaces);
    if(!requested)return deny('namespace_forbidden');
    const time=currentTime();if(time===undefined)return deny('clock_unavailable');
    purge(time);
    const nonceKey=digest(ownerPageNonce),nonce=ownerNonces.get(nonceKey);
    if(!nonce)return deny('owner_nonce_invalid');
    const stateHash=digest(state);
    if(usedStates.has(stateHash))return deny('state_replayed');
    if(usedStates.size>=maxPendingStates)return deny('state_capacity');
    if(approvals.size>=maxPendingApprovals)return deny('approval_capacity');
    if(codes.size>=maxPendingCodes)return deny('code_capacity');
    const approvalId=randomToken(),approvalKey=digest(approvalId);
    if(approvals.has(approvalKey))return deny('approval_unavailable');
    const expiresAt=Math.min(nonce.expiresAt,time+stateLifetimeMs);
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=time)return deny('owner_nonce_invalid');
    // Consume the browser nonce and reserve the BFF state before the owner
    // Remote CAS starts. An unknown CAS outcome must require a fresh approval.
    ownerNonces.delete(nonceKey);
    usedStates.set(stateHash,{expiresAt});
    approvals.set(approvalKey,{stateHash,namespaces:requested,expiresAt});
    return {ok:true,approvalId,expires_at:expiresAt};
  }

  async function createOwnerCode({peer,approvalId}={}){
    if(!owner(peer))return deny('owner_required');
    if(!isToken(approvalId))return deny('bootstrap_input_invalid');
    const time=currentTime();if(time===undefined)return deny('clock_unavailable');
    purge(time);
    const approvalKey=digest(approvalId),approval=approvals.get(approvalKey);
    if(!approval)return deny('approval_invalid');
    if(codes.size>=maxPendingCodes)return deny('code_capacity');
    // Consume before the asynchronous policy read. If the result is unknown,
    // the browser must return to the owner approval page for a new code.
    approvals.delete(approvalKey);
    const snapshot=await policySnapshot(readPolicySnapshot);
    if(!snapshot.ok)return deny(snapshot.reason);
    const bindings=exactBindings(snapshot,approval.namespaces,currentTime()??time);
    if(!bindings)return deny('binding_not_approved');
    const freshTime=currentTime();if(freshTime===undefined)return deny('clock_unavailable');
    purge(freshTime);
    if(codes.size>=maxPendingCodes)return deny('code_capacity');
    const expiresAt=Math.min(freshTime+codeLifetimeMs,approval.expiresAt,...bindings.map(binding=>binding.expiresAt));
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=freshTime)return deny('binding_expired');
    const code=randomToken(),key=digest(code);
    if(codes.has(key))return deny('code_unavailable');
    codes.set(key,{
      stateHash:approval.stateHash,
      gatewayId,actorId,hostInstanceId,
      bindings,
      policyRevision:snapshot.revision,
      expiresAt
    });
    return {ok:true,code,expires_at:expiresAt};
  }

  async function redeemCode({authorization,state,code}={}){
    if(!fixedComponent(authorization))return deny('component_unauthenticated');
    if(!isToken(state)||!isToken(code))return deny('bootstrap_input_invalid');
    const time=currentTime();if(time===undefined)return deny('clock_unavailable');
    purge(time);
    const codeKey=digest(code),entry=codes.get(codeKey);
    if(!entry)return deny('code_invalid');
    if(entry.stateHash!==digest(state))return deny('code_invalid');
    // Consume before the asynchronous policy recheck and context creation.
    codes.delete(codeKey);
    const snapshot=await policySnapshot(readPolicySnapshot);
    if(!snapshot.ok)return deny(snapshot.reason);
    const freshTime=currentTime();if(freshTime===undefined)return deny('clock_unavailable');
    if(snapshot.revision!==entry.policyRevision)return deny('policy_revision_changed');
    const expectedContext={...entry,policyRevision:entry.policyRevision};
    if(!snapshotMatches(expectedContext,snapshot,freshTime))return deny('binding_changed');
    purge(freshTime);
    if(contexts.size>=maxContexts)return deny('context_capacity');
    let actorContext;
    try{actorContext=await createActorContext({gatewayId,actorId,hostInstanceId});}catch{return deny('actor_context_unavailable');}
    let resolvedActor;
    try{resolvedActor=resolveAuthenticatedActor(actorContext);}catch{return deny('actor_context_unavailable');}
    if(resolvedActor!==actorId)return deny('actor_context_unavailable');
    const ticket=randomToken(),ticketKey=digest(ticket);
    const expiresAt=Math.min(freshTime+contextLifetimeMs,...entry.bindings.map(binding=>binding.expiresAt));
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=freshTime)return deny('binding_expired');
    if(contexts.has(ticketKey))return deny('ticket_unavailable');
    contexts.set(ticketKey,{
      gatewayId,actorId,hostInstanceId,actorContext,
      bindings:entry.bindings.map(binding=>({...binding})),
      policyRevision:entry.policyRevision,
      expiresAt
    });
    return {ok:true,ticket,expires_at:expiresAt};
  }

  async function readForTicket({authorization,ticket,namespace}={},reader,unavailableReason){
    if(!fixedComponent(authorization))return deny('component_unauthenticated');
    if(typeof ticket!=='string'||ticket.length<32||ticket.length>128)return deny('ticket_invalid');
    if(typeof namespace!=='string'||!allowedNamespaces.has(namespace)||namespace===HOST_POLICY_NAMESPACE)return deny('namespace_forbidden');
    const time=currentTime();if(time===undefined)return deny('clock_unavailable');
    purge(time);
    const key=digest(ticket),context=contexts.get(key);
    if(!context)return deny('ticket_invalid');
    let resolvedActor;
    try{resolvedActor=resolveAuthenticatedActor(context.actorContext);}catch{return deny('actor_context_invalid');}
    if(resolvedActor!==context.actorId||context.gatewayId!==gatewayId||context.actorId!==actorId||context.hostInstanceId!==hostInstanceId)return deny('actor_context_invalid');
    if(!context.bindings.some(binding=>binding.namespace===namespace))return deny('namespace_forbidden');
    const snapshot=await policySnapshot(readPolicySnapshot);
    if(!snapshot.ok){contexts.delete(key);return deny(snapshot.reason);}
    const freshTime=currentTime();if(freshTime===undefined){contexts.delete(key);return deny('clock_unavailable');}
    if(snapshot.revision!==context.policyRevision){contexts.delete(key);return deny('policy_revision_changed');}
    if(!snapshotMatches(context,snapshot,freshTime,namespace)){contexts.delete(key);return deny('binding_changed');}
    let grant;
    try{grant=issueReadGrant({authorization,actorContext:context.actorContext,namespace});}catch{return deny('grant_unavailable');}
    if(!grant?.ok||typeof grant.grant!=='string')return deny(grant?.reason??'grant_unavailable');
    try{return await reader({authorization,actorContext:context.actorContext,namespace,grant:grant.grant});}
    catch{return deny(unavailableReason);}
  }
  const readSettingsForTicket=input=>readForTicket(input,readSettings,'settings_unavailable');
  const readReadinessForTicket=input=>typeof readReadiness==='function'
    ?readForTicket(input,readReadiness,'readiness_unavailable'):deny('readiness_unavailable');

  async function resolveSettingsTicket({authorization,ticket,namespace}={}){
    if(!fixedComponent(authorization))return deny('component_unauthenticated');
    if(typeof ticket!=='string'||ticket.length<32||ticket.length>128)return deny('ticket_invalid');
    if(typeof namespace!=='string'||!allowedNamespaces.has(namespace)||namespace===HOST_POLICY_NAMESPACE)return deny('namespace_forbidden');
    const time=currentTime();if(time===undefined)return deny('clock_unavailable');
    purge(time);
    const key=digest(ticket),context=contexts.get(key);
    if(!context)return deny('ticket_invalid');
    let resolvedActor;
    try{resolvedActor=resolveAuthenticatedActor(context.actorContext);}catch{return deny('actor_context_invalid');}
    if(resolvedActor!==context.actorId||context.gatewayId!==gatewayId||context.actorId!==actorId||context.hostInstanceId!==hostInstanceId)return deny('actor_context_invalid');
    const bindings=context.bindings.filter(binding=>binding.namespace===namespace);
    if(bindings.length!==1)return deny('namespace_forbidden');
    const snapshot=await policySnapshot(readPolicySnapshot);
    if(!snapshot.ok){contexts.delete(key);return deny(snapshot.reason);}
    const freshTime=currentTime();if(freshTime===undefined){contexts.delete(key);return deny('clock_unavailable');}
    if(snapshot.revision!==context.policyRevision){contexts.delete(key);return deny('policy_revision_changed');}
    if(!snapshotMatches(context,snapshot,freshTime,namespace)){contexts.delete(key);return deny('binding_changed');}
    return{ok:true,gateway_id:gatewayId,actor_id:context.actorId,host_instance_id:context.hostInstanceId,
      policy_epoch:bindings[0].epoch,policy_revision:context.policyRevision,expires_at:Math.min(context.expiresAt,bindings[0].expiresAt)};
  }

  return Object.freeze({
    createOwnerPageNonce,
    beginOwnerApproval,
    createOwnerCode,
    redeemCode,
    readSettings:readSettingsForTicket,
    readReadiness:readReadinessForTicket,
    resolveSettingsTicket
  });
}
