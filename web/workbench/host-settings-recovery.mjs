const HASH=/^[a-f0-9]{64}$/,KEY=/^[A-Za-z0-9_-]{8,128}$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>record(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const positive=value=>Number.isSafeInteger(value)&&value>0;
function valid(row,taskScope,writeScope){
 const scope=row?.scope,command=row?.command,settings=command?.settings;
 return exact(row,['scope','command','key'])&&KEY.test(row.key??'')
  &&exact(scope,['task_scope','write_scope','namespace','settings_version','schema_version'])&&scope.task_scope===taskScope&&scope.write_scope===writeScope
  &&typeof scope.namespace==='string'&&/^[a-z][a-z0-9._-]{0,127}$/.test(scope.namespace)&&scope.namespace!=='jot-host-policy'
  &&Number.isSafeInteger(scope.settings_version)&&scope.settings_version>=0&&positive(scope.schema_version)
  &&exact(command,['expected_version','expected_schema_fingerprint','settings'])
  &&command.expected_version===scope.settings_version&&HASH.test(command.expected_schema_fingerprint??'')
  &&exact(settings,['mode','workspace_id','provider_id','model_id','plugin_selection'])&&['agent','demo'].includes(settings.mode)
  &&['workspace_id','provider_id','model_id'].every(key=>typeof settings[key]==='string'&&settings[key].length>0&&settings[key].length<=512&&!/[\u0000-\u001f\u007f]/.test(settings[key]))
  &&Array.isArray(settings.plugin_selection)&&settings.plugin_selection.length<=128
  &&settings.plugin_selection.every(id=>typeof id==='string'&&id.length>0&&id.length<=256)
  &&new Set(settings.plugin_selection).size===settings.plugin_selection.length;
}

/** Browser recovery data is a request receipt, never an owner grant. */
export function createHostSettingsRecovery(storage,taskScope){
 if(!HASH.test(taskScope??''))throw Error('host_settings_recovery_invalid');
 const keyFor=writeScope=>{if(!HASH.test(writeScope??''))throw Error('host_settings_recovery_invalid');return`jot.host-settings-save.v1:${taskScope}:${writeScope}`;};
 const read=writeScope=>{
  let raw;try{raw=storage.getItem(keyFor(writeScope));}catch{throw Error('host_settings_recovery_unavailable');}
  if(raw===null)return null;
  let row;try{if(typeof raw!=='string'||raw.length>100000)throw Error();row=JSON.parse(raw);}catch{throw Error('host_settings_recovery_invalid');}
  if(!valid(row,taskScope,writeScope))throw Error('host_settings_recovery_invalid');
  return structuredClone(row);
 };
 return Object.freeze({
  read,
  write(row){
   const writeScope=row?.scope?.write_scope;
   if(!HASH.test(writeScope??'')||!valid(row,taskScope,writeScope))throw Error('host_settings_recovery_invalid');
   const previous=read(writeScope),raw=JSON.stringify(row);
   if(previous&&JSON.stringify(previous)!==raw)throw Error('host_settings_recovery_pending');
   try{storage.setItem(keyFor(writeScope),raw);if(storage.getItem(keyFor(writeScope))!==raw)throw Error();}catch{throw Error('host_settings_recovery_unavailable');}
  },
  clear(writeScope,key){
   const previous=read(writeScope);if(!previous||previous.key!==key)return false;
   try{storage.removeItem(keyFor(writeScope));}catch{throw Error('host_settings_recovery_unavailable');}
   return true;
  }
 });
}
