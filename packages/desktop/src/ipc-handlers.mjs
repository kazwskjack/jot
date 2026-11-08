import {initializeDesktopNotificationState} from './notification-state.mjs';
import {assertTrustedDesktopSender,parseDesktopCommand,parseDesktopNotificationRequest} from './bridge-contract.mjs';

const operationIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const updatePhases=new Set(['available','downloading','downloaded','verified','staged','awaiting-activation','activating','active','cancelled','failed','unknown']);

export function registerDesktopIpcHandlers({ipcMain,appOrigin,getWindow,stateStore,notificationRuntime,readPermission,selectFile,updateLifecycle=null}={}){
 if(!ipcMain||typeof ipcMain.handle!=='function'||typeof ipcMain.removeHandler!=='function'||typeof getWindow!=='function'||
  !stateStore||typeof stateStore.read!=='function'||typeof stateStore.write!=='function'||!notificationRuntime||
  typeof readPermission!=='function'||typeof selectFile!=='function')throw new Error('desktop_ipc_configuration_invalid');
 const trusted=event=>{
  const window=getWindow(),contents=window?.webContents;
  if(!window||window.isDestroyed?.()||!contents||contents.isDestroyed?.()||event?.sender!==contents)throw new Error('desktop_sender_denied');
  const frame=event?.senderFrame,main=event?.sender?.mainFrame;
  assertTrustedDesktopSender({senderUrl:frame?.url,appOrigin,mainFrame:!!frame&&frame===main});
 };
 const routes=new Map([
  ['notification.state.read',async()=>stateStore.read()],
  ['notification.state.initialize',async(_event,payload)=>{
   const current=await stateStore.read();if(current.initialized_at)return current;
   const next=initializeDesktopNotificationState(current,payload.started_at);await stateStore.write(next);return next;
  }],
  ['notification.permission.read',async event=>readPermission(event.sender)],
  ['preferences.read',async()=>{const state=await stateStore.read();return state.preferences;}],
  ['preferences.write',async(_event,payload)=>notificationRuntime.updatePreferences(payload)],
  ['notification.show',async(_event,payload)=>notificationRuntime.show(payload)],
  ['notification.dismiss',async(_event,payload)=>notificationRuntime.dismiss(parseDesktopCommand('notification.dismiss',payload).payload)],
  ['window.openTask',async(_event,payload)=>{
   const identity=parseDesktopCommand('window.openTask',payload).payload,window=getWindow();
   if(!window||window.isDestroyed?.())throw new Error('desktop_window_unavailable');
   window.webContents.send('desktop:open-task',identity);return true;
  }],
  ['dialog.selectFile',async()=>selectFile()],
  ['update.status',async()=>updateLifecycle?.status?updateLifecycle.status():Object.freeze({enabled:false,reason:'desktop_update_host_policy_missing',phase:null})],
  ['update.check',async()=>requireUpdateMethod('check')()],
  ['update.download',async()=>requireUpdateMethod('download')()],
  ['update.cancel',async(_event,payload)=>requireUpdateMethod('cancel')(payload)],
  ['update.activate',async(_event,payload)=>requireUpdateMethod('activate')(payload)]
 ]);
 function requireUpdateMethod(name){
  const method=updateLifecycle?.[name];
  if(typeof method!=='function')throw new Error('desktop_update_unavailable');
  return method.bind(updateLifecycle);
 }
 for(const [channel,handler] of routes)ipcMain.handle(channel,async(event,payload)=>{trusted(event);const command=channel==='notification.show'?{payload:parseDesktopNotificationRequest(payload)}:parseDesktopCommand(channel,payload);return handler(event,command.payload??payload);});
 let removeProgressListener=()=>{};
 if(typeof updateLifecycle?.onProgress==='function'){
  const dispose=updateLifecycle.onProgress(event=>{
   if(!event||typeof event!=='object'||Array.isArray(event)||Object.keys(event).length!==2||
    !operationIdPattern.test(event.operation_id)||!updatePhases.has(event.phase))return;
   const window=getWindow();if(!window||window.isDestroyed?.())return;
   window.webContents?.send?.('desktop:update-progress',Object.freeze({operation_id:event.operation_id.toLowerCase(),phase:event.phase}));
  });
  if(typeof dispose==='function')removeProgressListener=dispose;
 }
 return ()=>{removeProgressListener();for(const channel of routes.keys())ipcMain.removeHandler(channel);};
}
