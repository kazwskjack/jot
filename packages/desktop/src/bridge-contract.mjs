const notificationEvents=new Set(['changed','completed','failed','needs_confirmation']);
const channels=new Set(['notification.show','notification.dismiss','notification.state.read','notification.state.initialize','notification.permission.read','preferences.read','preferences.write','window.openTask',
 'update.status','update.check','update.download','update.cancel','update.activate','dialog.selectFile']);
const hasOwn=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

function fail(code){throw new Error(code);}
function record(value,code){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail(code);
 return value;
}
function exactKeys(value,keys,code){
 if(Object.keys(value).some(key=>!keys.includes(key)))fail(code);
}
function boundedString(value,max,code){
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max)fail(code);
 return value;
}
function taskIdentity(value,code){
 record(value,code);
 if(!hasOwn(value,'task_id')||!hasOwn(value,'occurrence_id'))fail(code);
 boundedString(value.task_id,200,code);boundedString(value.occurrence_id,200,code);
}

export function parseDesktopCommand(channel,value){
 if(typeof channel!=='string'||!channels.has(channel))fail('desktop_ipc_channel_denied');
 if(channel==='notification.show'){
  const code='desktop_notification_invalid';record(value,code);
  const keys=['task_id','occurrence_id','generation','event_kind','title','body'];exactKeys(value,keys,code);
  taskIdentity(value,code);
  if(!Number.isSafeInteger(value.generation)||value.generation<1||!notificationEvents.has(value.event_kind))fail(code);
  boundedString(value.title,200,code);boundedString(value.body,4096,code);
  return Object.freeze({channel,payload:Object.freeze({...value})});
 }
 if(channel==='window.openTask'){
  const code='desktop_navigation_invalid';record(value,code);exactKeys(value,['task_id','occurrence_id'],code);taskIdentity(value,code);
  return Object.freeze({channel,payload:Object.freeze({task_id:value.task_id,occurrence_id:value.occurrence_id})});
 }
 if(channel==='notification.dismiss'){
  const code='desktop_notification_invalid';record(value,code);exactKeys(value,['task_id','occurrence_id','generation','event_kind'],code);taskIdentity(value,code);
  if(!Number.isSafeInteger(value.generation)||value.generation<1||!notificationEvents.has(value.event_kind))fail(code);
  return Object.freeze({channel,payload:Object.freeze({...value})});
 }
 if(channel==='notification.state.initialize'){
  const code='desktop_notification_state_invalid';record(value,code);exactKeys(value,['started_at'],code);boundedString(value.started_at,40,code);
  if(!Number.isFinite(Date.parse(value.started_at)))fail(code);
  return Object.freeze({channel,payload:Object.freeze({started_at:new Date(value.started_at).toISOString()})});
 }
 if(channel==='preferences.write'){
  const code='desktop_notification_preferences_invalid';record(value,code);exactKeys(value,['enabled','quiet_hours'],code);
  if(typeof value.enabled!=='boolean')fail(code);
  return Object.freeze({channel,payload:Object.freeze({...value})});
 }
 if(channel==='update.cancel'||channel==='update.activate'){
  const code='desktop_update_command_invalid';record(value,code);exactKeys(value,['operation_id'],code);
  if(typeof value.operation_id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operation_id))fail(code);
  return Object.freeze({channel,payload:Object.freeze({operationId:value.operation_id.toLowerCase()})});
 }
 if(channel==='update.status'||channel==='update.check'||channel==='update.download'){
  if(value!==undefined)fail('desktop_ipc_payload_invalid');
  return Object.freeze({channel,payload:null});
 }
  if(channel==='dialog.selectFile'){
   if(value!==undefined)fail('desktop_file_picker_payload_invalid');
   return Object.freeze({channel,payload:null});
  }
 if(value!==undefined&&value!==null&&Object.keys(record(value,'desktop_ipc_payload_invalid')).length)fail('desktop_ipc_payload_invalid');
 return Object.freeze({channel,payload:null});
}

export function assertTrustedDesktopSender({senderUrl,appOrigin,mainFrame}={}){
 try{
  if(mainFrame!==true||typeof senderUrl!=='string'||typeof appOrigin!=='string')fail('desktop_sender_denied');
  const sender=new URL(senderUrl),origin=new URL(appOrigin);
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.username||origin.password||origin.origin!==appOrigin||sender.username||sender.password||sender.origin!==origin.origin)fail('desktop_sender_denied');
  return true;
 }catch(error){
  if(error instanceof Error&&error.message==='desktop_sender_denied')throw error;
  fail('desktop_sender_denied');
 }
}

export function parseDesktopNotificationRequest(value){
 const code='desktop_notification_request_invalid';
 try{
  record(value,code);exactKeys(value,['candidate','task_settings'],code);
  const notification=parseDesktopCommand('notification.show',value.candidate).payload;
  const settings=record(value.task_settings,code);
  exactKeys(settings,['task_id','version','channel_binding_ids','events','delivery_policy'],code);
  if(settings.task_id!==notification.task_id||!Number.isSafeInteger(settings.version)||settings.version<0||
   !Array.isArray(settings.channel_binding_ids)||settings.channel_binding_ids.length>5||
   new Set(settings.channel_binding_ids).size!==settings.channel_binding_ids.length||
   settings.channel_binding_ids.some(id=>typeof id!=='string'||!id||id.length>128)||
   !Array.isArray(settings.events)||settings.events.length>4||new Set(settings.events).size!==settings.events.length||
   settings.events.some(event=>!notificationEvents.has(event))||!settings.delivery_policy||typeof settings.delivery_policy!=='object'||Array.isArray(settings.delivery_policy))fail(code);
  return Object.freeze({
   candidate:notification,
   task_settings:Object.freeze({
    task_id:settings.task_id,version:settings.version,
    channel_binding_ids:Object.freeze([...settings.channel_binding_ids]),
    events:Object.freeze([...settings.events]),
    delivery_policy:Object.freeze({...settings.delivery_policy,quiet_hours:settings.delivery_policy.quiet_hours===null?null:Object.freeze({...settings.delivery_policy.quiet_hours})})
   })
  });
 }catch(error){
  if(error instanceof Error&&error.message===code)throw error;
  fail(code);
 }
}
