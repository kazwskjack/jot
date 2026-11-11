import {initializeDesktopNotificationState,updateDesktopNotificationState} from './notification-state.mjs';
import {assertTrustedDesktopSender,parseDesktopCommand,parseDesktopNotificationRequest} from './bridge-contract.mjs';

const operationIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const updatePhases=new Set(['available','downloading','downloaded','verified','staged','awaiting-activation','activating','active','cancelled','failed','unknown']);

export function registerDesktopIpcHandlers({ipcMain,appOrigin,getWindow,stateStore,notificationRuntime,readPermission,selectFile,updateLifecycle=null,setMenuState=null,showCaptionMenu=null,closeCaptionMenu=null,readWindowChrome=null,setWindowTheme=null,setWindowAppearance=null,linuxCaptionMenu=null,readDesktopAbout=null,readAppearance=null,readAppearanceCapabilities=null,writeAppearance=null,appearanceImages=null}={}){
 if(typeof readAppearance==='function'&&(typeof ipcMain?.on!=='function'||typeof ipcMain?.removeListener!=='function'))throw Error('desktop_ipc_configuration_invalid');
 if(!ipcMain||typeof ipcMain.handle!=='function'||typeof ipcMain.removeHandler!=='function'||typeof getWindow!=='function'||
  !stateStore||typeof stateStore.read!=='function'||typeof stateStore.write!=='function'||!notificationRuntime||
  typeof readPermission!=='function'||typeof selectFile!=='function')throw new Error('desktop_ipc_configuration_invalid');
 const trusted=event=>{
  const window=getWindow(),contents=window?.webContents;
  if(!window||window.isDestroyed?.()||!contents||contents.isDestroyed?.()||event?.sender!==contents)throw new Error('desktop_sender_denied');
  const frame=event?.senderFrame,main=event?.sender?.mainFrame;
  assertTrustedDesktopSender({senderUrl:frame?.url,appOrigin,mainFrame:!!frame&&frame===main});
 };
 const appearanceRead=(event,payload)=>{try{trusted(event);parseDesktopCommand('appearance.read',payload);event.returnValue=readAppearance();}catch{event.returnValue=null;}};
 const routes=new Map([
  ['appearance.capabilities',async()=>{if(typeof readAppearanceCapabilities!=='function')throw Error('desktop_appearance_unavailable');return readAppearanceCapabilities();}],
  ['appearance.image.recover',async()=>{if(!appearanceImages)throw Error('desktop_appearance_image_unavailable');return appearanceImages.recover();}],
  ['appearance.image.save',async(_event,payload)=>{if(!appearanceImages)throw Error('desktop_appearance_image_unavailable');return appearanceImages.save(payload);}],
  ['appearance.image.read',async(_event,payload)=>{if(!appearanceImages)throw Error('desktop_appearance_image_unavailable');return appearanceImages.read(payload.id);}],
  ['appearance.image.delete',async(_event,payload)=>{if(!appearanceImages)throw Error('desktop_appearance_image_unavailable');return appearanceImages.delete(payload.id);}],
  ['appearance.write',async(_event,payload)=>{if(typeof writeAppearance!=='function')throw Error('desktop_appearance_unavailable');return writeAppearance(payload);}],
  ['desktop.about.read',async()=>{if(typeof readDesktopAbout!=='function')throw Error('desktop_about_unavailable');return readDesktopAbout();}],
  ['menu.caption.items',async(_event,payload)=>{if(!linuxCaptionMenu)throw Error('desktop_caption_unavailable');return linuxCaptionMenu.read(payload);}],
  ['menu.caption.activate',async(_event,payload)=>{if(!linuxCaptionMenu)throw Error('desktop_caption_unavailable');return linuxCaptionMenu.activate(payload);}],
  ['menu.caption.dismiss',async(_event,payload)=>{if(!linuxCaptionMenu)throw Error('desktop_caption_unavailable');return linuxCaptionMenu.dismiss(payload);}],
  ['window.chrome.read',async()=>{if(typeof readWindowChrome!=='function')throw Error('desktop_window_chrome_unavailable');return readWindowChrome();}],
  ['window.chrome.appearance',async(_event,payload)=>{if(typeof setWindowAppearance!=='function')throw Error('desktop_window_chrome_unavailable');return setWindowAppearance(payload);}],
  ['window.chrome.theme',async(_event,payload)=>{if(typeof setWindowTheme!=='function')throw Error('desktop_window_chrome_unavailable');return setWindowTheme(payload.theme);}],
  ['menu.caption.show',async(_event,payload)=>{if(typeof showCaptionMenu!=='function')throw Error('desktop_caption_unavailable');return showCaptionMenu(payload);}],
  ['menu.caption.close',async()=>{if(typeof closeCaptionMenu!=='function')throw Error('desktop_caption_unavailable');closeCaptionMenu();return Object.freeze({protocol:1,closed:true});}],
  ['menu.state.set',async(_event,payload)=>{if(typeof setMenuState!=='function')throw Error('desktop_menu_unavailable');setMenuState(payload);return Object.freeze({protocol:1,accepted:true});}],
  ['notification.capabilities',async()=>Object.freeze({event_protocol:notificationRuntime.eventProtocol===2?2:1})],
  ['notification.state.read',async()=>stateStore.read()],
  ['notification.state.initialize',async(_event,payload)=>{
   return updateDesktopNotificationState(stateStore,current=>initializeDesktopNotificationState(current,payload.started_at));
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
  ['update.status',async()=>updateLifecycle?.status?updateLifecycle.status():Object.freeze({enabled:false,reason:'desktop_update_host_policy_missing',phase:null,checking:false,actionPending:false,operationCommands:1,activeCommand:null,cancelPending:false})],
  ['update.check',async()=>requireUpdateMethod('check')()],
  ['update.download',async(_event,payload)=>requireUpdateMethod('download')(payload)],
  ['update.pause',async(_event,payload)=>requireUpdateMethod('pause')(payload)],
  ['update.resume',async(_event,payload)=>requireUpdateMethod('resume')(payload)],
  ['update.cancel',async(_event,payload)=>requireUpdateMethod('cancel')(payload)],
  ['update.activate',async(_event,payload)=>requireUpdateMethod('activate')(payload)]
 ]);
 function requireUpdateMethod(name){
  const method=updateLifecycle?.[name];
  if(typeof method!=='function')throw new Error('desktop_update_unavailable');
  return method.bind(updateLifecycle);
 }
 for(const [channel,handler] of routes)ipcMain.handle(channel,async(event,payload)=>{trusted(event);const command=channel==='notification.show'?{payload:parseDesktopNotificationRequest(payload)}:parseDesktopCommand(channel,payload);return handler(event,command.payload??payload);});
 if(typeof readAppearance==='function')ipcMain.on('appearance.read',appearanceRead);
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
 return ()=>{if(typeof readAppearance==='function')ipcMain.removeListener('appearance.read',appearanceRead);removeProgressListener();for(const channel of routes.keys())ipcMain.removeHandler(channel);};
}
