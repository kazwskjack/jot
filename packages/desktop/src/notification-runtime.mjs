import {markDesktopNotificationSeen} from './notification-state.mjs';
import {parseDesktopCommand,parseDesktopNotificationRequest} from './bridge-contract.mjs';
import {normalizeDesktopNotificationPreferences,shouldDeliverDesktopNotification} from './notification-policy.mjs';

const identityOf=value=>({task_id:value.task_id,occurrence_id:value.occurrence_id,generation:value.generation,event_kind:value.event_kind});
const keyOf=value=>JSON.stringify([value.task_id,value.occurrence_id,value.generation,value.event_kind]);
const asDate=value=>value instanceof Date?value:new Date(value);

export function createDesktopNotificationRuntime({NotificationClass,stateStore,permission,openTask,now=()=>new Date()}={}){
 if(typeof NotificationClass!=='function'||!stateStore||typeof stateStore.read!=='function'||typeof stateStore.write!=='function'||
  typeof permission!=='function'||typeof openTask!=='function')throw new Error('desktop_notification_runtime_invalid');
 const active=new Map(),pending=new Map();
 function supported(){return typeof NotificationClass.isSupported==='function'&&NotificationClass.isSupported();}
 async function show(input){
  const {candidate,task_settings}=parseDesktopNotificationRequest(input),identity=identityOf(candidate),key=keyOf(identity);
  if(!supported()){closeAll();return false;}if(active.has(key)||pending.has(key))return false;
  const state=await stateStore.read();
  if(state.seen.some(item=>keyOf(item)===key))return false;
  const notificationPermission=await permission();
  if(notificationPermission!=='granted')closeAll();
  const instant=asDate(now instanceof Function?now():now);
  if(Number.isNaN(instant.getTime()))return false;
  const verdict=shouldDeliverDesktopNotification({candidate,preferences:state.preferences,taskSettings:task_settings,notificationPermission,now:instant,history:state.seen});
  if(!verdict.deliver)return false;
  let notification;
  try{notification=new NotificationClass({title:candidate.title,body:candidate.body,actions:[{type:'button',text:'打开任务'}]});}
  catch{return false;}
  return await new Promise(resolve=>{
   let settled=false,closed=false,timer;
   const finish=value=>{
    if(settled)return;settled=true;if(timer)clearTimeout(timer);
    if(pending.get(key)?.notification===notification)pending.delete(key);
    resolve(value);
   };
   const cancel=()=>{try{notification.close();}catch{}finish(false);};
   pending.set(key,{identity,notification,cancel});
   notification.on('show',async()=>{
    if(settled)return;
    try{
     const latest=await stateStore.read();
     if(latest.seen.some(item=>keyOf(item)===key)){notification.close();finish(false);return;}
     const currentPermission=await permission(),currentTime=asDate(now instanceof Function?now():now);
     const currentVerdict=shouldDeliverDesktopNotification({candidate,preferences:latest.preferences,taskSettings:task_settings,notificationPermission:currentPermission,now:currentTime,history:latest.seen});
     if(Number.isNaN(currentTime.getTime())||!currentVerdict.deliver){notification.close();finish(false);return;}
     const next=markDesktopNotificationSeen(latest,identity,currentTime.toISOString()).state;
     await stateStore.write(next);
     if(!closed)active.set(key,{identity,notification});
     finish(true);
    }catch{notification.close();finish(false);}
   });
   notification.on('failed',()=>{active.delete(key);finish(false);});
   notification.on('close',()=>{closed=true;active.delete(key);});
   notification.on('click',()=>{void Promise.resolve(openTask({task_id:identity.task_id,occurrence_id:identity.occurrence_id})).catch(()=>{});});
   notification.on('action',(event,index)=>{
    const actionIndex=typeof event==='number'?event:typeof index==='number'?index:event?.actionIndex;
    if(actionIndex===0)void Promise.resolve(openTask({task_id:identity.task_id,occurrence_id:identity.occurrence_id})).catch(()=>{});
   });
   timer=setTimeout(()=>cancel(),5000);timer.unref?.();
   try{notification.show();}catch{cancel();}
  });
 }
 function dismiss(value){
  let identity;try{identity=parseDesktopCommand('notification.dismiss',value).payload;}catch{return false;}
  const key=keyOf(identity),entry=active.get(key),queued=pending.get(key);
  if(queued){queued.cancel();return true;}
  if(!entry)return false;
  active.delete(key);try{entry.notification.close();}catch{}return true;
 }
 function dismissTask(taskId){
  let count=0;
  for(const [key,entry] of active){
   if(entry.identity.task_id===taskId){active.delete(key);try{entry.notification.close();}catch{}count++;}
  }
  for(const [key,notification] of pending){
   if(notification.identity.task_id===taskId){notification.cancel();count++;}
  }
  return count;
 }
 function closeAll(){
  const activeNotifications=[...active.values()].map(entry=>entry.notification),pendingNotifications=[...pending.values()];active.clear();
  for(const notification of activeNotifications)try{notification.close();}catch{}
  for(const notification of pendingNotifications)notification.cancel();
  return activeNotifications.length+pendingNotifications.length;
 }
 function permissionChanged(status){
  if(!['denied','default','unsupported'].includes(status))return 0;
  return closeAll();
 }
 async function updatePreferences(value){
  const preferences=normalizeDesktopNotificationPreferences(value),state=await stateStore.read();
  await stateStore.write({...state,preferences});
  if(!preferences.enabled||(await permission())!=='granted')closeAll();
  return preferences;
 }
 return Object.freeze({show,dismiss,dismissTask,closeAll,permissionChanged,updatePreferences});
}
