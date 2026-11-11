const {contextBridge,ipcRenderer}=require('electron');
(()=>{
if(process.isMainFrame!==true)return;

const validIdentity=value=>value&&typeof value.task_id==='string'&&value.task_id.length>0&&value.task_id.length<=200&&
 typeof value.occurrence_id==='string'&&value.occurrence_id.length>0&&value.occurrence_id.length<=200;
let openTaskListeners=new Set(),queuedOpenTasks=[],openNotificationSettingsListeners=new Set(),queuedOpenNotificationSettings=false;
const updateOperationIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const updatePhases=new Set(['available','downloading','downloaded','verified','staged','awaiting-activation','activating','active','cancelled','failed','unknown']);
const updateProgressListeners=new Set();
const notificationPermissionStatuses=new Set(['granted','denied','default','unsupported','unknown']);
const notificationPermissionListeners=new Set();
ipcRenderer.on('desktop:notification-permission',(_event,status)=>{
 if(!notificationPermissionStatuses.has(status))return;
 for(const listener of notificationPermissionListeners)try{listener(status);}catch{}
});
ipcRenderer.on('desktop:open-task',(_event,identity)=>{
 if(!validIdentity(identity))return;
 const safe=Object.freeze({task_id:identity.task_id,occurrence_id:identity.occurrence_id});
 if(!openTaskListeners.size){queuedOpenTasks.push(safe);if(queuedOpenTasks.length>8)queuedOpenTasks.shift();return;}
 for(const listener of openTaskListeners)try{listener(safe);}catch{}
});
ipcRenderer.on('desktop:open-notification-settings',()=>{
 if(!openNotificationSettingsListeners.size){queuedOpenNotificationSettings=true;return;}
 for(const listener of openNotificationSettingsListeners)try{listener();}catch{}
});
ipcRenderer.on('desktop:update-progress',(_event,value)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||
  typeof value.operation_id!=='string'||!updateOperationIdPattern.test(value.operation_id)||!updatePhases.has(value.phase))return;
 const safe=Object.freeze({operation_id:value.operation_id.toLowerCase(),phase:value.phase});
 for(const listener of updateProgressListeners)try{listener(safe);}catch{}
});
const menuCommands=new Set(['new-conversation','new-project','settings','check-updates','find','toggle-sidebar','chat','files','skills','scheduled-tasks']);
const commandListeners=new Set();
// Transient UI commands are never replayed into a later document/account.
ipcRenderer.on('desktop:command',(_event,value)=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='command,owner_scope,protocol'
  ||value.protocol!==1||!menuCommands.has(value.command)||typeof value.owner_scope!=='string'||!/^[a-f0-9]{64}$/.test(value.owner_scope))return;
 const safe=Object.freeze({protocol:1,command:value.command,owner_scope:value.owner_scope});
 for(const listener of commandListeners)try{listener(safe);}catch{}
});
const invoke=(channel,payload)=>ipcRenderer.invoke(channel,payload);
const bridge=Object.freeze({
 platform:process.platform,
 setMenuState:value=>invoke('menu.state.set',value),
 onCommand(listener){if(typeof listener!=='function')throw TypeError('desktop_listener_invalid');commandListeners.add(listener);return()=>commandListeners.delete(listener);},
 selectFile:()=>invoke('dialog.selectFile'),
 readNotificationState:()=>invoke('notification.state.read'),
 initializeNotificationState:startedAt=>invoke('notification.state.initialize',{started_at:startedAt}),
 readNotificationPermission:()=>invoke('notification.permission.read'),
 onNotificationPermission(listener){
  if(typeof listener!=='function')throw new TypeError('desktop_listener_invalid');
  notificationPermissionListeners.add(listener);
  return ()=>notificationPermissionListeners.delete(listener);
 },
 readNotificationPreferences:()=>invoke('preferences.read'),
 setNotificationPreferences:value=>invoke('preferences.write',value),
 showTaskNotification:(candidate,taskSettings)=>invoke('notification.show',{candidate,task_settings:taskSettings}),
 dismissTaskNotification:identity=>invoke('notification.dismiss',identity),
 getUpdateStatus:()=>invoke('update.status'),
 checkForUpdate:()=>invoke('update.check'),
 downloadUpdate:()=>invoke('update.download'),
 cancelUpdate:operationId=>invoke('update.cancel',{operation_id:operationId}),
 activateUpdate:operationId=>invoke('update.activate',{operation_id:operationId}),
 onUpdateProgress(listener){
  if(typeof listener!=='function')throw new TypeError('desktop_listener_invalid');
  updateProgressListeners.add(listener);
  return ()=>updateProgressListeners.delete(listener);
 },
 onOpenTask(listener){
  if(typeof listener!=='function')throw new TypeError('desktop_listener_invalid');
  openTaskListeners.add(listener);
  for(const identity of queuedOpenTasks.splice(0))try{listener(identity);}catch{}
  return ()=>openTaskListeners.delete(listener);
 },
 onOpenNotificationSettings(listener){
  if(typeof listener!=='function')throw new TypeError('desktop_listener_invalid');
  openNotificationSettingsListeners.add(listener);
  if(queuedOpenNotificationSettings){queuedOpenNotificationSettings=false;try{listener();}catch{}}
  return ()=>openNotificationSettingsListeners.delete(listener);
 }
});
contextBridge.exposeInMainWorld('jotDesktop',bridge);
})();
