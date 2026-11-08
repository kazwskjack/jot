import {normalizeHostSettingsWritePatch,projectHostSettingsWriteReceipt} from './host-settings-write-candidate.js';

const HASH=/^[a-f0-9]{64}$/,KEY=/^[A-Za-z0-9_-]{8,128}$/,NS=/^[a-z][a-z0-9._-]{0,127}$/,TOKEN=/^[A-Za-z0-9_-]{43}$/,UUID=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const held=reason=>({status:'held',reason_code:reason});
export function hostSettingsProductCommand(command){
 if(!exact(command,['expected_version','expected_schema_fingerprint','settings'])||!Number.isSafeInteger(command.expected_version)||command.expected_version<1||!HASH.test(command.expected_schema_fingerprint??''))throw Error('host_settings_command_invalid');
 return{expected_version:command.expected_version,expected_schema_fingerprint:command.expected_schema_fingerprint,settings:normalizeHostSettingsWritePatch(command.settings)};
}
function publicReceipt(receipt){
 const safe=projectHostSettingsWriteReceipt(receipt);if(!safe)return{status:'unknown_pending',reason_code:'host_settings_outcome_unknown'};
 return safe;
}

/** No store/authority is created here. Missing original facilities keep writes closed.
 * lookupOriginal must authenticate the original owner/Host binding independently
 * of current write approval and refuse a different key while that binding is unknown.
 * Every port must finish its local transaction before awaiting an external RPC.
 */
export function createHostSettingsProductService({namespace,originalReceipts,resolveOwnerWriteApproval,writer,readEditorSnapshot}={}){
 if(!NS.test(namespace??'')||namespace==='jot-host-policy')throw TypeError('host_settings_namespace_invalid');
 const valid=input=>record(input)&&Object.keys(input).every(key=>['authorization','ticket','namespace','idempotency_key','command','approval'].includes(key))&&input.namespace===namespace&&TOKEN.test(input.ticket??'')&&typeof input.authorization==='string';
 const lookup=async(input,command)=>{
  if(typeof originalReceipts?.lookupOriginal!=='function')return{kind:'unavailable'};
  try{return await originalReceipts.lookupOriginal({authorization:input.authorization,ticket:input.ticket,namespace,idempotency_key:input.idempotency_key,
   ...(command?{expected_version:command.expected_version,expected_schema_fingerprint:command.expected_schema_fingerprint,patch:command.settings}:{})});}catch{return{kind:'unavailable'};}
 };
 const recovered=row=>{
  if(row?.kind==='completed')return publicReceipt(row.receipt);
  if(row?.kind==='pending'||row?.kind==='blocked')return{status:'unknown_pending',reason_code:'host_settings_outcome_unknown'};
  if(row?.kind==='conflict')return{status:'conflict'};
  if(row?.kind==='unavailable')return held('host_settings_original_receipt_unavailable');
  return null;
 };
 return Object.freeze({
  async read(input){
   if(!valid(input))return held('host_settings_scope_unavailable');
   if(typeof readEditorSnapshot!=='function')return held('host_settings_editor_source_unavailable');
   let value;try{value=await readEditorSnapshot(input);}catch{return held('host_settings_editor_source_unavailable');}
   if(!record(value)||value.namespace!==namespace||!Number.isSafeInteger(value.settings_version)||value.settings_version<0||!Number.isSafeInteger(value.schema_version)||value.schema_version<1||!HASH.test(value.schema_fingerprint??'')||!HASH.test(value.write_scope??''))return held('host_settings_editor_source_unavailable');
   let settings;try{settings=normalizeHostSettingsWritePatch(value.settings);}catch{return held('host_settings_editor_source_unavailable');}
   if(Object.keys(settings).sort().join(',')!=='mode,model_id,plugin_selection,provider_id,workspace_id')return held('host_settings_editor_source_unavailable');
   return{namespace,settings_version:value.settings_version,schema_version:value.schema_version,schema_fingerprint:value.schema_fingerprint,write_scope:value.write_scope,settings:{...settings,credential_ref:null,voice_provider_id:null}};
  },
  async save(input,context){
   if(!valid(input)||!KEY.test(input.idempotency_key??''))return held('host_settings_scope_unavailable');
   let command;try{command=hostSettingsProductCommand(input.command);}catch{return{status:'rejected',reason_code:'host_settings_write_rejected'};}
   // Historical lookup precedes current schema, approval and current Host scope.
   const prior=await lookup(input,command),receipt=recovered(prior);if(receipt)return receipt;
   if(prior?.kind!=='absent')return held('host_settings_original_receipt_unavailable');
   const activityAdmissionId=context?.activityAdmissionId;
   if(!UUID.test(activityAdmissionId??''))return held('host_settings_activity_fence_unavailable');
   if(typeof resolveOwnerWriteApproval!=='function'||typeof writer?.save!=='function')return held('host_settings_write_origin_unavailable');
   let approval=input.approval;
   if(approval===undefined){try{approval=await resolveOwnerWriteApproval({...input,command,operation:'settings.update'});}catch{return held('host_settings_owner_approval_invalid');}}
   if(!exact(approval,['kind','token'])||approval.kind!=='owner_settings_write'||typeof approval.token!=='string')return held('host_settings_owner_approval_invalid');
   let result;try{result=await writer.save({namespace,operation:'settings.update',expected_version:command.expected_version,expected_schema_fingerprint:command.expected_schema_fingerprint,patch:command.settings,idempotency_key:input.idempotency_key,approval,activity_admission_id:activityAdmissionId,ticket:input.ticket});}catch{return{status:'unknown_pending',reason_code:'host_settings_outcome_unknown'};}
   return publicReceipt(result);
  },
  async query(input){
   if(!valid(input)||!KEY.test(input.idempotency_key??''))return held('host_settings_scope_unavailable');
   // Query can observe an evolving original receipt. It never invokes save/RPC.
   return recovered(await lookup(input))??held('host_settings_attempt_not_found');
  }
 });
}

/** Exact internal Adapter dispatcher. Register through the existing component
 * authenticator; this check is transport authentication, never write approval. */
export function createHostSettingsProductRequestHandler({service,authenticateComponent}={}){
 if(typeof authenticateComponent!=='function'||!['read','save','query'].every(name=>typeof service?.[name]==='function'))throw TypeError('host_settings_handler_dependency_invalid');
 const routes=new Map([
  ['/v1/host-admin/settings/editor/read',{method:'read',keys:['ticket','namespace']}],
  ['/v1/host-admin/settings/write',{method:'save',keys:['ticket','namespace','idempotency_key','command'],optional:['approval']}],
  ['/v1/host-admin/settings/attempt/read',{method:'query',keys:['ticket','namespace','idempotency_key']}]
 ]);
 return async({path,method,authorization,body,activityAdmissionId}={})=>{
  const route=routes.get(path);if(!route)return undefined;
  if(method!=='POST')return{status:405,payload:{error:'method_not_allowed'}};
  let component;try{component=await authenticateComponent(authorization);}catch{}
  if(typeof component!=='string'||component.length===0)return{status:401,payload:{reason_code:'HOST_SETTINGS_DENIED'}};
  const bodyKeys=record(body)?Object.keys(body):[];
  if(!record(body)||route.keys.some(key=>!Object.hasOwn(body,key))||bodyKeys.some(key=>!route.keys.includes(key)&&!route.optional?.includes(key))||route.optional?.some(key=>Object.hasOwn(body,key)&&!record(body[key]))
   ||!TOKEN.test(body.ticket??'')||!NS.test(body.namespace??'')||body.namespace==='jot-host-policy'||route.method!=='read'&&!KEY.test(body.idempotency_key??''))return{status:422,payload:{error:'invalid_host_settings_product_input'}};
  let result;try{result=await service[route.method]({...body,authorization},route.method==='save'?{activityAdmissionId}:undefined);}catch{return{status:503,payload:{reason_code:'HOST_SETTINGS_UNAVAILABLE'}};}
  if(route.method==='read')return result?.status==='held'?{status:503,payload:{reason_code:'HOST_SETTINGS_UNAVAILABLE'}}:{status:200,payload:{settings:result}};
  return{status:200,payload:{result}};
 };
}
