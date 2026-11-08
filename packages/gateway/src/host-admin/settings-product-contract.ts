const record=(value:unknown):value is Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:unknown,keys:string[])=>record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const revision=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const reason=(value:unknown)=>typeof value==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(value);
const fail=():never=>{throw Error('host_settings_product_invalid');};
export type HostSettingsProductCommand={expected_version:number;expected_schema_fingerprint:string;settings:Record<string,unknown>};
export type HostSettingsApprovalRequest={purpose:'settings.update'|'settings.reconcile';command:(HostSettingsProductCommand&{idempotency_key:string})|null};
export function validateHostSettingsApprovalRequest(value:unknown):HostSettingsApprovalRequest{
 if(!exact(value,['purpose','command'])||!record(value))return fail();
 if(value.purpose==='settings.reconcile'){if(value.command!==null)return fail();}
 else if(value.purpose==='settings.update'){
  if(!exact(value.command,['expected_version','expected_schema_fingerprint','settings','idempotency_key'])||!record(value.command)
   ||typeof value.command.idempotency_key!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(value.command.idempotency_key))return fail();
  const{idempotency_key,...command}=value.command;validateHostSettingsProductCommand(command);
 }else return fail();
 return value as HostSettingsApprovalRequest;
}
function settings(value:unknown){
 if(!record(value)||Object.keys(value).length===0||Object.keys(value).some(key=>!['mode','workspace_id','provider_id','model_id','plugin_selection'].includes(key)))return false;
 return Object.entries(value).every(([key,item])=>key==='mode'?['agent','demo'].includes(item):key==='plugin_selection'?Array.isArray(item)&&item.length<=128&&item.every(id=>typeof id==='string'&&id.length>0&&id.length<=256)&&new Set(item).size===item.length:typeof item==='string'&&item.length>0&&item.length<=512&&!/[\u0000-\u001f\u007f]/.test(item));
}
export function validateHostSettingsProductCommand(value:unknown):HostSettingsProductCommand{
 if(!record(value)||!exact(value,['expected_version','expected_schema_fingerprint','settings'])||!Number.isSafeInteger(value.expected_version)||Number(value.expected_version)<1||!hash(value.expected_schema_fingerprint)||!settings(value.settings))fail();
 return value as HostSettingsProductCommand;
}
function migration(value:unknown){return exact(value,['state'])&&record(value)&&value.state==='unknown'||record(value)&&exact(value,['state','from_schema_version','to_schema_version'])&&['not_required','migrated'].includes(value.state)&&(value.from_schema_version===null||revision(value.from_schema_version))&&Number.isSafeInteger(value.to_schema_version)&&value.to_schema_version>0;}
function activeImpact(value:unknown){
 if(!exact(value,['state','active_runs','active_sessions','current_sessions_restarted'])||!record(value)||!['known','unknown'].includes(value.state)
  ||![value.active_runs,value.active_sessions].every(item=>item===null||revision(item))||value.current_sessions_restarted!==null)return false;
 return value.state==='known'?revision(value.active_runs)&&revision(value.active_sessions):value.active_runs===null&&value.active_sessions===null;
}
export function validateHostSettingsProductResult(value:unknown,namespace:string):Record<string,any>{
 if(!record(value))return fail();
 if(value.status==='saved'){
  if(!exact(value,['status','namespace','settings_version','settings','activation','active_run_impact','migration','safe_boundary'])||value.namespace!==namespace||!revision(value.settings_version)||value.settings_version<1||!settings(value.settings)
   ||!exact(value.activation,['state'])||!['live','unknown'].includes(value.activation.state)||!exact(value.safe_boundary,['state'])||value.safe_boundary.state!=='unknown'||!migration(value.migration))return fail();
  if(!activeImpact(value.active_run_impact))return fail();
 }else if(value.status==='conflict'){
  if(!exact(value,Object.hasOwn(value,'current_version')?['status','current_version']:['status'])||Object.hasOwn(value,'current_version')&&!revision(value.current_version))return fail();
 }else if(value.status==='held'){
  const keys=['status','reason_code',...(Object.hasOwn(value,'migration')?['migration']:[]),...(Object.hasOwn(value,'active_run_impact')?['active_run_impact']:[])];
  if(!exact(value,keys)||!reason(value.reason_code)||Object.hasOwn(value,'migration')&&!migration(value.migration)
   ||Object.hasOwn(value,'active_run_impact')&&!activeImpact(value.active_run_impact))return fail();
 }else if(['rejected','unknown_pending','stale_scope'].includes(value.status)){
  if(!exact(value,Object.hasOwn(value,'migration')?['status','reason_code','migration']:['status','reason_code'])||!reason(value.reason_code)||Object.hasOwn(value,'migration')&&!migration(value.migration))return fail();
 }else return fail();
 return value;
}
export function validateHostSettingsEditor(value:unknown,namespace:string):Record<string,any>{
 if(!record(value)||!exact(value,['namespace','settings_version','schema_version','schema_fingerprint','write_scope','settings'])||value.namespace!==namespace||!revision(value.settings_version)||!Number.isSafeInteger(value.schema_version)||value.schema_version<1||!hash(value.schema_fingerprint)||!hash(value.write_scope))return fail();
 const values=value.settings;
 if(!record(values)||!exact(values,['mode','workspace_id','provider_id','model_id','plugin_selection','credential_ref','voice_provider_id'])||values.credential_ref!==null||values.voice_provider_id!==null)return fail();
 const{credential_ref,voice_provider_id,...writable}=values;if(!settings(writable))return fail();
 return value;
}
