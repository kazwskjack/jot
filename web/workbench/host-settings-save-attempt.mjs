const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const KEY=/^[A-Za-z0-9_-]{8,200}$/;
const HASH=/^[a-f0-9]{64}$/;

function canonical(value){
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;
 if(record(value))return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
 throw new TypeError('host_settings_save_input_invalid');
}

function binding(scope,command){
 if(!record(scope)||!['schema_version,settings_version,task_scope','schema_version,settings_version,task_scope,write_scope','namespace,schema_version,settings_version,task_scope,write_scope'].includes(Object.keys(scope).sort().join(','))
  ||Object.hasOwn(scope,'namespace')&&(typeof scope.namespace!=='string'||!/^[a-z][a-z0-9._-]{0,127}$/.test(scope.namespace)||scope.namespace==='jot-host-policy')
  ||Object.hasOwn(scope,'write_scope')&&!HASH.test(scope.write_scope??'')
  ||!HASH.test(scope.task_scope??'')||!Number.isSafeInteger(scope.settings_version)||scope.settings_version<0
  ||!Number.isSafeInteger(scope.schema_version)||scope.schema_version<1||!record(command))throw new TypeError('host_settings_save_scope_invalid');
 return canonical({scope,command});
}

/** Keep the same idempotency key for a retry of one exact Host save. */
export function createHostSettingsSaveAttempt({createKey=()=>globalThis.crypto.randomUUID()}={}){
 if(typeof createKey!=='function')throw new TypeError('host_settings_save_key_factory_invalid');
 let active=null;
 const matches=(scope,command,key)=>{
  try{return !!active&&active.key===key&&active.binding===binding(scope,command);}catch{return false;}
 };
 return Object.freeze({
  begin(scope,command){
   const current=binding(scope,command);
   if(!active||active.binding!==current||active.status==='settled'){
    const key=createKey();
    if(typeof key!=='string'||!KEY.test(key))throw new TypeError('host_settings_save_key_invalid');
    active={binding:current,key,status:'ready'};
   }
   return Object.freeze({key:active.key,status:active.status});
  },
  isCurrent(scope,command,key){return matches(scope,command,key);},
  restore(scope,command,key){if(!KEY.test(key??''))throw new TypeError('host_settings_save_key_invalid');active={binding:binding(scope,command),key,status:'unknown_pending'};},
  markUnknown(scope,command,key){if(!matches(scope,command,key))return false;active.status='unknown_pending';return true;},
  settle(scope,command,key){if(!matches(scope,command,key))return false;active.status='settled';return true;},
  clear(){active=null;}
 });
}

/** Product request body excludes references and provider-specific credentials. */
export function hostSettingsSaveCommand(snapshot,draft){
 if(!record(snapshot)||!Number.isSafeInteger(snapshot.settings_version)||snapshot.settings_version<0
  ||!HASH.test(snapshot.schema_fingerprint??'')
  ||!record(draft)||!['agent','demo'].includes(draft.mode)
  ||['workspace_id','provider_id','model_id'].some(key=>typeof draft[key]!=='string'||draft[key].length===0)
  ||!Array.isArray(draft.plugin_selection)||draft.plugin_selection.some(value=>typeof value!=='string'))throw new TypeError('host_settings_save_input_invalid');
 return{
  expected_version:snapshot.settings_version,
  expected_schema_fingerprint:snapshot.schema_fingerprint,
  settings:{mode:draft.mode,workspace_id:draft.workspace_id,provider_id:draft.provider_id,model_id:draft.model_id,plugin_selection:[...draft.plugin_selection]}
 };
}
