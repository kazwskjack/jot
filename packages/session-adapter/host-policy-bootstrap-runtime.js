import {createHostCredentialsOwnerRoute,validateHostCredentialRefs} from './host-credentials-owner-route.js';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {isAbsolute,join} from 'node:path';
import {createHostPolicyGrantAuthority,createHostSettingsPolicyFacade,HOST_POLICY_NAMESPACE} from './host-policy.js';
import {createHostPolicyBootstrapAuthority} from './host-policy-bootstrap.js';
import {createHostPolicyBootstrapOwnerRoute} from './host-policy-bootstrap-owner.js';
import {createHostReadinessPolicyFacade} from './host-readiness.js';
import {resolveOwnerBoundDshProfile,resolveOwnerBoundDshProfileContext} from './dsh-profile-binding.js';
import {createHostSettingsRuntimeProvider} from './host-settings-runtime-provider.js';
import {createHostSettingsReconciliationSource} from './host-settings-reconciliation-source.js';
import {createHostSettingsOwnerApprovalProducer} from './host-settings-owner-approval-route.js';

function componentAuthenticator(token,gatewayId){
  const expected=Buffer.from(`Bearer ${token}`);
  return authorization=>{
    if(typeof authorization!=='string')return undefined;
    const actual=Buffer.from(authorization);
    return actual.length===expected.length&&timingSafeEqual(actual,expected)?gatewayId:undefined;
  };
}

function service(ctx,name){
  try{const value=ctx?.get?.(name);if(value)return value;}catch{}
  return ctx?.[name];
}

function canonicalOrigin(value){
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash&&url.origin===value;}catch{return false;}
}

export function validateHostPolicyBootstrapRuntimeConfig(config){
  const keys=Object.keys(config??{}).sort().join(',');
  const legacy=keys==='actorId,dshOrigin,gatewayId,jotOrigin,maxBindingLifetimeMs,namespaces';
  const gatewayOrigin=legacy?config.jotOrigin:config.gatewayOrigin;
  if(!legacy&&keys!=='actorId,dshOrigin,gatewayId,gatewayOrigin,jotOrigin,maxBindingLifetimeMs,namespaces'
    ||!canonicalOrigin(config.dshOrigin)||!canonicalOrigin(config.jotOrigin,true)||!canonicalOrigin(gatewayOrigin)
    ||config.dshOrigin===config.jotOrigin||config.dshOrigin===gatewayOrigin
    ||![config.gatewayId,config.actorId].every(value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    ||!Array.isArray(config.namespaces)||config.namespaces.length===0||config.namespaces.length>64
    ||config.namespaces.some(value=>typeof value!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(value)||value===HOST_POLICY_NAMESPACE)
    ||new Set(config.namespaces).size!==config.namespaces.length
    ||!Number.isSafeInteger(config.maxBindingLifetimeMs)||config.maxBindingLifetimeMs<60_000||config.maxBindingLifetimeMs>1_800_000)
    throw new TypeError('host_bootstrap_runtime_config_invalid');
}

/** Bind operator-provisioned policy identifiers and bounds to this Host's live origins. */
export function resolveHostPolicyBootstrapRuntimeConfig(config,{webServer,workbenchBridge}={}){
  validateHostPolicyBootstrapRuntimeConfig(config);
  let dshOrigin;
  try{dshOrigin=webServer?.getOrigin?.();}catch{}
  const gatewayOrigin=workbenchBridge?.origin,configuredGatewayOrigin=config.gatewayOrigin??config.jotOrigin;
  if(!canonicalOrigin(dshOrigin)||!canonicalOrigin(gatewayOrigin)||config.dshOrigin!==dshOrigin||configuredGatewayOrigin!==gatewayOrigin)
    throw new TypeError('host_bootstrap_runtime_config_invalid');
  return Object.freeze({...config,namespaces:Object.freeze([...config.namespaces])});
}

/** Build an opt-in DSH runtime using only its existing Gateway component Bearer,
 * SettingsController, Connection owner page and Typert Gateway owner Remote. */
export function createHostPolicyBootstrapRuntime({ctx,token,config,settingsOwnerRoutesEnabled=false,hostSettingsWriteEnabled=false,
 hostSettingsWriteNamespace,workbenchBridge,hostSettingsProductSchema,hostCredentialRefs=[],now=()=>Date.now()}={}){
  validateHostPolicyBootstrapRuntimeConfig(config);
  const credentialRefs=validateHostCredentialRefs(hostCredentialRefs);
  if(credentialRefs.length&&settingsOwnerRoutesEnabled!==true)throw TypeError('host_credentials_route_invalid');
  if(typeof settingsOwnerRoutesEnabled!=='boolean')throw new TypeError('host_bootstrap_owner_routes_flag_invalid');
  if(typeof hostSettingsWriteEnabled!=='boolean'||hostSettingsWriteEnabled&&(!settingsOwnerRoutesEnabled||hostSettingsWriteNamespace!=='jot-session-adapter'||!config.namespaces.includes(hostSettingsWriteNamespace)))
    throw new TypeError('host_settings_write_config_invalid');
  if(typeof token!=='string'||token.length<32)throw new TypeError('host_bootstrap_runtime_token_invalid');
  const connection=service(ctx,'connection'),typertGateway=service(ctx,'typertGateway'),settingsController=service(ctx,'settingsController');
  if(typeof settingsController?.describe!=='function'
    ||settingsOwnerRoutesEnabled&&(!connection?.admit||!connection.fetch?.register||typeof typertGateway?.invoke!=='function'))
    throw new TypeError('host_bootstrap_runtime_service_unavailable');
  const hostInstanceId=randomUUID(),actorContexts=new WeakMap(),authenticateComponent=componentAuthenticator(token,config.gatewayId);
  const readPolicySnapshot=()=>{
    try{
      const described=settingsController.describe();
      const descriptor=described?.namespaces?.find(item=>item?.ns===HOST_POLICY_NAMESPACE);
      if(!descriptor||!Number.isSafeInteger(descriptor.revision)||!Array.isArray(descriptor.value?.bindings))return undefined;
      return{revision:descriptor.revision,bindings:descriptor.value.bindings};
    }catch{return undefined;}
  };
  const resolveAuthenticatedActor=actorContext=>actorContexts.get(actorContext);
  const createActorContext=identity=>{
    if(identity?.gatewayId!==config.gatewayId||identity?.actorId!==config.actorId||identity?.hostInstanceId!==hostInstanceId)throw Error('host_actor_context_invalid');
    const context=Object.freeze(Object.create(null));actorContexts.set(context,config.actorId);return context;
  };
  const mutationActorContext=createActorContext({gatewayId:config.gatewayId,actorId:config.actorId,hostInstanceId});
  const readPluginMutationContext=()=>{
    const profile=resolveOwnerBoundDshProfileContext(service(ctx,'profileContext'));
    return {authorization:`Bearer ${token}`,actorContext:mutationActorContext,ownerId:profile.ownerId,profileId:profile.profileId};
  };
  const grantAuthority=createHostPolicyGrantAuthority({hostInstanceId,readPolicySnapshot,authenticateComponent,resolveAuthenticatedActor,readPluginMutationContext,now});
  const pluginMutationAuthority=Object.freeze({
    issuePluginMutationGrant:grantAuthority.issuePluginMutationGrant,
    authorizePluginMutationGrant:grantAuthority.authorizePluginMutationGrant
  });
  if(typeof ctx?.provide!=='function')throw new TypeError('host_bootstrap_runtime_context_provider_unavailable');
  ctx.provide('jotHostPluginMutationAuthority',pluginMutationAuthority);
  if(!settingsOwnerRoutesEnabled)return Object.freeze({hostInstanceId});
  const facade=createHostSettingsPolicyFacade({authority:grantAuthority,settingsController,namespaces:config.namespaces,now:()=>new Date(now())});
  const readinessFacade=createHostReadinessPolicyFacade({authority:grantAuthority,settingsController,llm:service(ctx,'llm'),namespaces:config.namespaces,now:()=>new Date(now())});
  const bootstrap=createHostPolicyBootstrapAuthority({
    gatewayId:config.gatewayId,actorId:config.actorId,hostInstanceId,namespaces:config.namespaces,
    readPolicySnapshot,authenticateComponent,resolveAuthenticatedActor,createActorContext,
    issueReadGrant:facade.issueReadGrant,readSettings:facade.readSettings,readReadiness:readinessFacade.readReadiness,now
  });
  const ownerRoute=createHostPolicyBootstrapOwnerRoute({connection,typertGateway,settingsController,authority:bootstrap,config:{
    dshOrigin:config.dshOrigin,jotOrigin:config.jotOrigin,gatewayId:config.gatewayId,actorId:config.actorId,
    hostInstanceId,namespaces:config.namespaces,maxBindingLifetimeMs:config.maxBindingLifetimeMs
  },now});
  const configEditor=service(ctx,'configEditor');
  const readSessionRefs=()=>{const sessions=service(ctx,'sessions');if(typeof sessions?.list!=='function')return null;return sessions.list().map(session=>session?.id);};
  const approvalSource=hostSettingsWriteEnabled&&hostSettingsProductSchema!==undefined&&typeof configEditor?.configuration==='function'
    ?createHostSettingsReconciliationSource({settingsController,configEditor,productSchema:hostSettingsProductSchema,workbenchBridge,
      readSessionRefs,
      readProfileContext:()=>service(ctx,'profileContext'),async readIdentity(request){
        const before=resolveOwnerBoundDshProfileContext(service(ctx,'profileContext'));
        const ticket=await bootstrap.resolveSettingsTicket({authorization:`Bearer ${token}`,ticket:request.ticket,namespace:hostSettingsWriteNamespace});
        const after=resolveOwnerBoundDshProfileContext(service(ctx,'profileContext'));
        if(ticket?.ok!==true||ticket.host_instance_id!==hostInstanceId||before.ownerId!==after.ownerId||before.profileId!==after.profileId)
          throw Error('host_settings_reconciliation_source_unavailable');
        return{owner_id:after.ownerId,actor_id:ticket.actor_id,profile_id:after.profileId,host_instance_id:hostInstanceId,policy_epoch:ticket.policy_epoch,namespace:hostSettingsWriteNamespace};
      }}):undefined;
  const approvalProducer=approvalSource?createHostSettingsOwnerApprovalProducer({connection,dshOrigin:config.dshOrigin,jotOrigin:config.jotOrigin,source:approvalSource,now}):undefined;
  const productReader=hostSettingsWriteEnabled?createHostSettingsRuntimeProvider({namespace:hostSettingsWriteNamespace,hostInstanceId,bootstrap,
    settingsController,readProfile:()=>{
      const directory=service(ctx,'profileContext')?.dir;
      if(typeof directory!=='string'||!isAbsolute(directory))throw Error('host_settings_selected_profile_missing');
      return resolveOwnerBoundDshProfile(join(directory,'package.json'));
    },readProfileContext:()=>service(ctx,'profileContext'),readSessionRefs,approvalProducer,typertGateway,componentAuthorization:`Bearer ${token}`,
    workbenchBridge,authenticateComponent,productSchema:hostSettingsProductSchema}):undefined;
  const productHandler=productReader?async input=>{
    if(input.path!=='/v1/host-admin/settings/approval/prepare')return productReader(input);
    if(input.method!=='POST')return{status:405,payload:{error:'method_not_allowed'}};
    if(authenticateComponent(input.authorization)!==config.gatewayId)return{status:401,payload:{error:'unauthorized'}};
    if(!approvalProducer)return{status:503,payload:{error:'host_settings_approval_source_unavailable'}};
    try{return{status:200,payload:{approval:await approvalProducer.prepare(input.body)}};}
    catch{return{status:503,payload:{error:'host_settings_approval_source_unavailable'}};}
  }:undefined;
  const credentialsOwnerRoute=credentialRefs.length?createHostCredentialsOwnerRoute({connection,typertGateway,dshOrigin:config.dshOrigin,
    references:credentialRefs,readIdentity:()=>resolveOwnerBoundDshProfileContext(service(ctx,'profileContext')),
    beforeChange:async()=>{
      const provider=service(ctx,'jotMcpRuntimeProvider');
      if(typeof provider?.invalidateCredentials!=='function')throw Error('host_credential_consumers_unavailable');
      await provider.invalidateCredentials();
    },now}):undefined;
  return Object.freeze({hostInstanceId,bootstrap,ownerRoute,...(credentialsOwnerRoute?{credentialsOwnerRoute}:{}),...(productHandler?{productHandler}:{}),
    ...(approvalProducer?{ownerApprovalRoute:approvalProducer.ownerRoute}:{})});
}
