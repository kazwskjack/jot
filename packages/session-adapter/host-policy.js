import {createHash, randomBytes} from 'node:crypto';
import {HOST_POLICY_NAMESPACE,HOST_POLICY_READ_OPERATION} from './host-policy-constants.js';
import {createHostSettingsReadAdapter} from './host-settings-read.js';

export {HOST_POLICY_NAMESPACE,HOST_POLICY_READ_OPERATION};
export {createHostPolicyConfig} from './host-policy-config.js';

const POLICY_BINDING_KEYS=['actor_id','epoch','expires_at','gateway_id','host_instance_id','namespace','operation'];
const PLUGIN_MUTATION_OPERATIONS=new Set(['plugin.bundle.install','plugin.bundle.enable','plugin.bundle.remove']);
const PLUGIN_MUTATION_SCOPE_KEYS=['actionSha256','impactScope','operation','operationId','ownerId','profileId'];
const PLUGIN_MUTATION_AUTH_KEYS=['actionSha256','authorizationRef','impactScope','operation','operationId','ownerId','profileId'];
const PLUGIN_MUTATION_ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLUGIN_MUTATION_HASH=/^[a-f0-9]{64}$/;
const PLUGIN_MUTATION_REF=/^[A-Za-z0-9_-]{43}$/;
const PLUGIN_MUTATION_IMPACT='all_agent_sessions';
const PLUGIN_MUTATION_GRANT_LIFETIME_MS=30_000;

function denied(reason){
  return {ok:false,reason};
}

function normalizePolicyBinding(binding){
  if(!binding||typeof binding!=='object'||Array.isArray(binding))return undefined;
  const keys=Object.keys(binding).sort();
  if(keys.length!==POLICY_BINDING_KEYS.length||keys.some((key,index)=>key!==POLICY_BINDING_KEYS[index]))return undefined;
  const normalized={
    gateway_id:binding.gateway_id,
    actor_id:binding.actor_id,
    host_instance_id:binding.host_instance_id,
    operation:binding.operation,
    namespace:binding.namespace,
    epoch:binding.epoch,
    expires_at:binding.expires_at
  };
  if(!['gateway_id','actor_id','host_instance_id','operation','namespace'].every(key=>typeof normalized[key]==='string'&&normalized[key].length>0)
    ||!Number.isSafeInteger(normalized.epoch)||normalized.epoch<1
    ||!Number.isSafeInteger(normalized.expires_at)||normalized.expires_at<1)return undefined;
  return normalized;
}

function readSnapshot(reader){
  try{
    const snapshot=reader();
    if(!snapshot||typeof snapshot!=='object')return {ok:false,reason:'policy_unavailable'};
    if(!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!Array.isArray(snapshot.bindings))return {ok:false,reason:'policy_malformed'};
    const bindings=snapshot.bindings.map(normalizePolicyBinding);
    if(bindings.some(binding=>!binding))return {ok:false,reason:'policy_malformed'};
    return {ok:true,revision:snapshot.revision,bindings};
  }catch{
    return {ok:false,reason:'policy_unavailable'};
  }
}

function isBindingFor(binding,{gatewayId,actorId,hostInstanceId,namespace,now}){
  return !!binding&&typeof binding==='object'
    &&binding.gateway_id===gatewayId
    &&binding.actor_id===actorId
    &&binding.host_instance_id===hostInstanceId
    &&binding.operation===HOST_POLICY_READ_OPERATION
    &&binding.namespace===namespace
    &&Number.isSafeInteger(binding.epoch)&&binding.epoch>0
    &&Number.isSafeInteger(binding.expires_at)&&binding.expires_at>now;
}

function digestGrant(grant){
  return createHash('sha256').update(grant,'utf8').digest('hex');
}

function normalizePluginMutationScope(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const keys=Object.keys(value).sort();
  if(keys.length!==PLUGIN_MUTATION_SCOPE_KEYS.length||keys.some((key,index)=>key!==PLUGIN_MUTATION_SCOPE_KEYS[index]))return undefined;
  if(!PLUGIN_MUTATION_ID.test(value.ownerId??'')||!PLUGIN_MUTATION_ID.test(value.profileId??'')
    ||!PLUGIN_MUTATION_OPERATIONS.has(value.operation)||!PLUGIN_MUTATION_ID.test(value.operationId??'')
    ||!PLUGIN_MUTATION_HASH.test(value.actionSha256??'')||value.impactScope!==PLUGIN_MUTATION_IMPACT)return undefined;
  return Object.freeze({ownerId:value.ownerId,profileId:value.profileId,operation:value.operation,
    operationId:value.operationId,actionSha256:value.actionSha256,impactScope:value.impactScope});
}

function samePluginMutationScope(left,right){
  return !!left&&!!right&&PLUGIN_MUTATION_SCOPE_KEYS.every(key=>left[key]===right[key]);
}

function exactPluginMutationAuthorization(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const keys=Object.keys(value).sort();
  return keys.length===PLUGIN_MUTATION_AUTH_KEYS.length
    &&keys.every((key,index)=>key===PLUGIN_MUTATION_AUTH_KEYS[index]);
}

/**
 * Create the process-local authority used by a Host facade. The injected
 * resolvers must consume the existing component Bearer and already-authenticated
 * Gateway actor context; this module never parses request headers itself.
 */
export function createHostPolicyGrantAuthority({
  hostInstanceId,
  readPolicySnapshot,
  authenticateComponent,
  resolveAuthenticatedActor,
  readPluginMutationContext,
  now=()=>Date.now(),
  maxGrantLifetimeMs=30_000,
  maxPluginMutationGrants=64
}={}){
  if(typeof hostInstanceId!=='string'||hostInstanceId.length===0)throw new TypeError('host_policy_host_id_invalid');
  if(typeof readPolicySnapshot!=='function'||typeof authenticateComponent!=='function'||typeof resolveAuthenticatedActor!=='function')throw new TypeError('host_policy_resolver_invalid');
  if(!Number.isSafeInteger(maxGrantLifetimeMs)||maxGrantLifetimeMs<1)throw new TypeError('host_policy_grant_lifetime_invalid');
  if(readPluginMutationContext!==undefined&&typeof readPluginMutationContext!=='function')throw new TypeError('host_plugin_mutation_context_invalid');
  if(!Number.isSafeInteger(maxPluginMutationGrants)||maxPluginMutationGrants<1||maxPluginMutationGrants>512)throw new TypeError('host_plugin_mutation_grant_capacity_invalid');
  const grants=new Map();

  function identity(input){
    try{
      const gatewayId=authenticateComponent(input?.authorization);
      const actorId=resolveAuthenticatedActor(input?.actorContext);
      if(typeof gatewayId!=='string'||gatewayId.length===0||typeof actorId!=='string'||actorId.length===0)return undefined;
      return {gatewayId,actorId};
    }catch{
      return undefined;
    }
  }

  function currentTime(){
    try{
      const value=now();
      return Number.isSafeInteger(value)?value:undefined;
    }catch{
      return undefined;
    }
  }

  function policyFor({gatewayId,actorId,namespace},time){
    const snapshot=readSnapshot(readPolicySnapshot);
    if(!snapshot.ok)return {reason:snapshot.reason};
    const matches=snapshot.bindings.filter(binding=>isBindingFor(binding,{
      gatewayId,actorId,hostInstanceId,namespace,now:time
    }));
    if(matches.length===0)return {reason:'no_matching_binding'};
    if(matches.length!==1)return {reason:'policy_ambiguous'};
    return {snapshot,binding:matches[0]};
  }

  async function pluginMutationIdentity(){
    if(typeof readPluginMutationContext!=='function')return undefined;
    let context;
    try{context=await readPluginMutationContext();}catch{return undefined;}
    if(!context||typeof context!=='object'||Array.isArray(context))return undefined;
    const keys=Object.keys(context).sort();
    if(keys.join(',')!=='actorContext,authorization,ownerId,profileId')return undefined;
    const ownerId=context.ownerId,profileId=context.profileId;
    if(!PLUGIN_MUTATION_ID.test(ownerId??'')||!PLUGIN_MUTATION_ID.test(profileId??''))return undefined;
    const caller=identity(context);
    return caller?{...caller,ownerId,profileId}:undefined;
  }

  async function issuePluginMutationGrant(input={}){
    const requested=normalizePluginMutationScope(input);
    if(!requested)return denied('mutation_scope_invalid');
    const caller=await pluginMutationIdentity();
    if(!caller)return denied('mutation_context_unavailable');
    if(requested.ownerId!==caller.ownerId||requested.profileId!==caller.profileId)return denied('mutation_profile_mismatch');
    const time=currentTime();
    if(time===undefined)return denied('clock_unavailable');
    const expiresAt=time+PLUGIN_MUTATION_GRANT_LIFETIME_MS;
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=time)return denied('clock_unavailable');
    const snapshot=readSnapshot(readPolicySnapshot);
    if(!snapshot.ok)return denied(snapshot.reason);
    for(const [key,grant] of grants)if(grant.expiresAt<=time)grants.delete(key);
    let mutationGrantCount=0;
    for(const grant of grants.values())if(grant.kind==='plugin-mutation')mutationGrantCount++;
    if(mutationGrantCount>=maxPluginMutationGrants)return denied('mutation_grant_capacity');
    let token,key;
    for(let attempt=0;attempt<3;attempt++){
      token=randomBytes(32).toString('base64url');
      key=digestGrant(token);
      if(!grants.has(key))break;
      token=undefined;
    }
    if(!token||!key)return denied('grant_unavailable');
    grants.set(key,{
      kind:'plugin-mutation',gatewayId:caller.gatewayId,actorId:caller.actorId,hostInstanceId,
      scope:requested,policyRevision:snapshot.revision,expiresAt
    });
    return {ok:true,authorizationRef:token};
  }

  async function authorizePluginMutationGrant(input={}){
    if(!exactPluginMutationAuthorization(input))return denied('mutation_scope_invalid');
    const {authorizationRef}=input;
    const scopeInput={...input};
    delete scopeInput.authorizationRef;
    const requested=normalizePluginMutationScope(scopeInput);
    if(!requested||!PLUGIN_MUTATION_REF.test(authorizationRef??''))return denied('mutation_scope_invalid');
    const caller=await pluginMutationIdentity();
    if(!caller)return denied('mutation_context_unavailable');
    if(requested.ownerId!==caller.ownerId||requested.profileId!==caller.profileId)return denied('mutation_profile_mismatch');
    const key=digestGrant(authorizationRef);
    const grant=grants.get(key);
    if(!grant||grant.kind!=='plugin-mutation')return denied('grant_unknown');
    if(grant.gatewayId!==caller.gatewayId||grant.actorId!==caller.actorId||grant.hostInstanceId!==hostInstanceId
      ||!samePluginMutationScope(grant.scope,requested))return denied('grant_scope_mismatch');

    // Consume before the policy recheck so concurrent calls or an unknown result cannot replay it.
    grants.delete(key);
    const time=currentTime();
    if(time===undefined)return denied('clock_unavailable');
    if(grant.expiresAt<=time)return denied('grant_expired');
    const snapshot=readSnapshot(readPolicySnapshot);
    if(!snapshot.ok)return denied(snapshot.reason);
    if(snapshot.revision!==grant.policyRevision)return denied('policy_revision_changed');
    return {ok:true};
  }

  function issueGrant(input={}){
    const {operation,namespace}=input;
    if(operation!==HOST_POLICY_READ_OPERATION)return denied('operation_forbidden');
    if(typeof namespace!=='string'||namespace.length===0)return denied('namespace_invalid');
    if(namespace===HOST_POLICY_NAMESPACE)return denied('policy_namespace_forbidden');
    const caller=identity(input);
    if(!caller)return denied('caller_unauthenticated');
    const time=currentTime();
    if(time===undefined)return denied('clock_unavailable');
    const matched=policyFor({...caller,namespace},time);
    if(!matched.snapshot)return denied(matched.reason);
    const requestedLifetime=input.lifetimeMs===undefined?maxGrantLifetimeMs:input.lifetimeMs;
    if(!Number.isSafeInteger(requestedLifetime)||requestedLifetime<1)return denied('grant_lifetime_invalid');
    const expiresAt=Math.min(time+Math.min(requestedLifetime,maxGrantLifetimeMs),matched.binding.expires_at);
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=time)return denied('binding_expired');

    for(const [key,grant] of grants)if(grant.expiresAt<=time)grants.delete(key);
    let token;
    let key;
    for(let attempt=0;attempt<3;attempt++){
      token=randomBytes(32).toString('base64url');
      key=digestGrant(token);
      if(!grants.has(key))break;
      token=undefined;
    }
    if(!token||!key)return denied('grant_unavailable');
    grants.set(key,{
      gatewayId:caller.gatewayId,
      actorId:caller.actorId,
      hostInstanceId,
      operation,
      namespace,
      epoch:matched.binding.epoch,
      policyRevision:matched.snapshot.revision,
      expiresAt
    });
    return {ok:true,grant:token,expires_at:expiresAt};
  }

  function authorize(input={}){
    const {operation,namespace,grant:token}=input;
    if(operation!==HOST_POLICY_READ_OPERATION)return denied('operation_forbidden');
    if(typeof namespace!=='string'||namespace.length===0)return denied('namespace_invalid');
    if(namespace===HOST_POLICY_NAMESPACE)return denied('policy_namespace_forbidden');
    if(typeof token!=='string'||token.length<40||token.length>256)return denied('grant_unknown');
    const caller=identity(input);
    if(!caller)return denied('caller_unauthenticated');
    const time=currentTime();
    if(time===undefined)return denied('clock_unavailable');
    const key=digestGrant(token);
    const grant=grants.get(key);
    if(!grant)return denied('grant_unknown');
    if(grant.gatewayId!==caller.gatewayId||grant.actorId!==caller.actorId||grant.hostInstanceId!==hostInstanceId
      ||grant.operation!==operation||grant.namespace!==namespace)return denied('grant_scope_mismatch');
    if(grant.expiresAt<=time){grants.delete(key);return denied('grant_expired');}
    const snapshot=readSnapshot(readPolicySnapshot);
    if(!snapshot.ok)return denied(snapshot.reason);
    if(snapshot.revision!==grant.policyRevision){grants.delete(key);return denied('policy_revision_changed');}
    const matched=snapshot.bindings.filter(binding=>isBindingFor(binding,{
      gatewayId:caller.gatewayId,actorId:caller.actorId,hostInstanceId,namespace,now:time
    }));
    if(matched.length!==1){grants.delete(key);return denied(matched.length===0?'binding_revoked':'policy_ambiguous');}
    const binding=matched[0];
    if(binding.epoch!==grant.epoch||binding.expires_at<grant.expiresAt){grants.delete(key);return denied('binding_changed');}
    return {ok:true};
  }

  return Object.freeze({issueGrant,authorize,issuePluginMutationGrant,authorizePluginMutationGrant});
}

/** Read one ordinary settings namespace after a narrow in-memory grant check. */
export function createHostSettingsPolicyFacade({authority,settingsController,namespaces=[],now}={}){
  if(!authority||typeof authority.issueGrant!=='function'||typeof authority.authorize!=='function')throw new TypeError('host_policy_authority_invalid');
  const allowedNamespaces=new Set((Array.isArray(namespaces)?namespaces:[])
    .filter(namespace=>typeof namespace==='string'&&namespace.length>0&&namespace!==HOST_POLICY_NAMESPACE));
  const issueReadGrant=input=>{
    if(!allowedNamespaces.has(input?.namespace))return denied('namespace_forbidden');
    return authority.issueGrant({...input,operation:HOST_POLICY_READ_OPERATION});
  };
  const readSettings=async input=>{
    const namespace=input?.namespace;
    if(!allowedNamespaces.has(namespace))return denied('namespace_forbidden');
    const decision=authority.authorize({...input,operation:HOST_POLICY_READ_OPERATION,namespace});
    if(!decision.ok)return decision;
    const read=createHostSettingsReadAdapter({settingsController,namespaces:[namespace],now});
    return {ok:true,settings:await read()};
  };
  return Object.freeze({issueReadGrant,readSettings});
}
