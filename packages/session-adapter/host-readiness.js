import {HOST_POLICY_NAMESPACE,HOST_POLICY_READ_OPERATION} from './host-policy-constants.js';
import {createHostSettingsReadAdapter} from './host-settings-read.js';

const MODEL_SELECTION_NAMESPACE='agent-default-model';
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NAMESPACE=/^[a-z][a-z0-9._-]{0,127}$/;
const AUTHORITY_REASONS=new Set([
  'operation_forbidden','namespace_invalid','policy_namespace_forbidden','caller_unauthenticated','clock_unavailable',
  'no_matching_binding','policy_ambiguous','grant_lifetime_invalid','binding_expired','grant_unavailable','grant_unknown',
  'grant_scope_mismatch','grant_expired','policy_unavailable','policy_malformed','policy_revision_changed','binding_revoked','binding_changed'
]);
function denied(reason){return {ok:false,reason};}
function isRecord(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function identifier(value){return typeof value==='string'&&IDENTIFIER.test(value)?value:null;}
function safeState(value){return ['ready','partial','unknown','unavailable'].includes(value)?value:'unknown';}
function safeRevision(value){return Number.isSafeInteger(value)&&value>=0?value:null;}
function unsupported(reason){return {state:'unsupported',reason_codes:[reason]};}

/**
 * Project one currently authorized Host settings namespace into a deliberately
 * incomplete readiness view. Registry membership is descriptive only and can
 * never establish provider readiness; provider success requires a separate,
 * approved durable test receipt which this slice does not read.
 */
export function createHostReadinessPolicyFacade({authority,settingsController,llm,namespaces=[],now}={}){
  if(!authority||typeof authority.authorize!=='function')throw new TypeError('host_policy_authority_invalid');
  const allowedNamespaces=new Set((Array.isArray(namespaces)?namespaces:[])
    .filter(namespace=>typeof namespace==='string'&&NAMESPACE.test(namespace)&&namespace!==HOST_POLICY_NAMESPACE));

  const readReadiness=async input=>{
    const namespace=input?.namespace;
    if(!allowedNamespaces.has(namespace))return denied('namespace_forbidden');
    const decision=authority.authorize({
      authorization:input?.authorization,actorContext:input?.actorContext,grant:input?.grant,
      operation:HOST_POLICY_READ_OPERATION,namespace
    });
    if(!decision?.ok)return denied(AUTHORITY_REASONS.has(decision?.reason)?decision.reason:'authorization_denied');

    const read=createHostSettingsReadAdapter({settingsController,namespaces:[namespace],now});
    const settings=await read();
    const entry=settings.namespaces.find(item=>item.namespace===namespace);
    const scope={namespace,state:safeState(entry?.state),revision:safeRevision(entry?.revision)};
    const providers=await projectProviderSelection({namespace,entry,llm});
    return {
      ok:true,
      readiness:{
        protocol:1,
        as_of:settings.as_of,
        scope,
        state:'unsupported',
        mode:{current:null,default_conversation:null,...unsupported('mode_source_unavailable')},
        workspace:{selected_id:null,items:[],reason_codes:['workspace_permission_source_unavailable']},
        host:unsupported('host_readiness_source_unavailable'),
        worker:unsupported('worker_readiness_source_unavailable'),
        providers,
        voice:unsupported('voice_source_unavailable'),
        plugins:[{plugin_id:null,...unsupported('plugin_roster_source_unavailable')}],
        network_policy:{
          browser:unsupported('network_policy_source_unavailable'),
          mcp:unsupported('network_policy_source_unavailable')
        }
      }
    };
  };
  return Object.freeze({readReadiness});
}

async function projectProviderSelection({namespace,entry,llm}){
  if(namespace!==MODEL_SELECTION_NAMESPACE||entry?.state!=='ready'||!isRecord(entry.value)){
    return [{provider_id:null,selected_model_id:null,model_ids:[],credential_ref_present:null,...unsupported('model_selection_source_unavailable')}];
  }
  const hasProvider=Object.hasOwn(entry.value,'provider');
  const hasModel=Object.hasOwn(entry.value,'model');
  const rawProvider=entry.value.provider,rawModel=entry.value.model;
  if(hasProvider&&hasModel&&rawProvider===''&&rawModel===''){
    return [{provider_id:null,selected_model_id:null,model_ids:[],credential_ref_present:null,state:'not_configured',reason_codes:['provider_selection_empty']}];
  }
  const providerId=identifier(rawProvider),modelId=identifier(rawModel);
  if(!hasProvider||!hasModel||!providerId||!modelId){
    return [{provider_id:providerId,selected_model_id:modelId,model_ids:[],credential_ref_present:null,...unsupported('model_selection_incomplete')}];
  }
  if(!llm||typeof llm.listProviders!=='function'||typeof llm.listConfigurableProviders!=='function'){
    return [{provider_id:providerId,selected_model_id:modelId,model_ids:[],credential_ref_present:null,...unsupported('provider_registry_source_unavailable')}];
  }
  let registeredRows,configurableRows;
  try{
    [registeredRows,configurableRows]=await Promise.all([llm.listProviders(),llm.listConfigurableProviders()]);
    if(!Array.isArray(registeredRows)||!Array.isArray(configurableRows))throw new Error('provider_registry_invalid');
  }catch{
    return [{provider_id:providerId,selected_model_id:modelId,model_ids:[],credential_ref_present:null,state:'fault',reason_codes:['provider_registry_fault']}];
  }
  const configurable=configurableRows.find(row=>isRecord(row)&&row.provider===providerId);
  if(configurable&&Object.hasOwn(configurable,'error')&&configurable.error!==null&&configurable.error!==false&&configurable.error!==''){
    return [{provider_id:providerId,selected_model_id:modelId,model_ids:[],credential_ref_present:null,state:'fault',reason_codes:['provider_configuration_fault']}];
  }
  const registered=registeredRows.some(row=>isRecord(row)&&row.id===providerId);
  if(!registered){
    return [{provider_id:providerId,selected_model_id:modelId,model_ids:[],credential_ref_present:null,state:'not_configured',reason_codes:['provider_not_registered']}];
  }
  return [{provider_id:providerId,selected_model_id:modelId,model_ids:[],credential_ref_present:null,...unsupported('provider_test_required')}];
}

export {MODEL_SELECTION_NAMESPACE};
