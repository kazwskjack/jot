import {markDesktopNotificationSeen,updateDesktopNotificationState,desktopNotificationIdentityKey} from './notification-state.mjs';
import {parseDesktopCommand,parseDesktopNotificationRequest} from './bridge-contract.mjs';
import {normalizeDesktopNotificationPreferences,shouldDeliverDesktopNotification} from './notification-policy.mjs';

const identityOf=value=>({task_id:value.task_id,occurrence_id:value.occurrence_id,generation:value.generation,event_kind:value.event_kind,...(Object.hasOwn(value,'event_id')?{event_id:value.event_id}:{})});
const keyOf=desktopNotificationIdentityKey;
const asDate=value=>value instanceof Date?value:new Date(value);

export function createDesktopNotificationRuntime({NotificationClass,stateStore,permission,openTask,now=()=>new Date()}={}){
 if(typeof NotificationClass!=='function'||!stateStore||typeof stateStore.read!=='function'||typeof stateStore.write!=='function'||
  typeof permission!=='function'||typeof openTask!=='function')throw new Error('desktop_notification_runtime_invalid');
 const active=new Map(),pending=new Map();let preferenceChanges=0;
 function supported(){return typeof NotificationClass.isSupported==='function'&&NotificationClass.isSupported();}
 async function show(input){
  const {candidate,task_settings}=parseDesktopNotificationRequest(input),identity=identityOf(candidate),key=keyOf(identity);
  if(!supported()){closeAll();return false;}
  if(preferenceChanges||active.has(key)||pending.has(key))return false;
  let finish=()=>{},closed=false;
  const entry={identity,notification:null,cancelled:false,cancel:()=>{
   entry.cancelled=true;
   if(pending.get(key)===entry)pending.delete(key);
   if(active.get(key)===entry)active.delete(key);
   try{entry.notification?.close();}catch{}
   finish(false);
  }};
  // Reserve before the first await so duplicate calls and revocation see preparation.
  pending.set(key,entry);
  const current=()=>!entry.cancelled&&!closed&&!preferenceChanges&&pending.get(key)===entry;
  try{
   const state=await stateStore.read();if(!current())return false;
   if(state.seen.some(item=>keyOf(item)===key))return false;
   const notificationPermission=await permission();if(!current())return false;
   if(notificationPermission!=='granted'){closeAll();return false;}
   const instant=asDate(now instanceof Function?now():now);
   if(Number.isNaN(instant.getTime()))return false;
   const verdict=shouldDeliverDesktopNotification({candidate,preferences:state.preferences,taskSettings:task_settings,notificationPermission,now:instant,history:state.seen});
   if(!verdict.deliver)return false;
   let notification;
   try{notification=new NotificationClass({title:candidate.title,body:candidate.body,actions:[{type:'button',text:'打开任务'}]});}
   catch{return false;}
   entry.notification=notification;
   if(!current()){entry.cancel();return false;}
   return await new Promise(resolve=>{
    let settled=false,shown=false,timer;
    finish=value=>{
     if(settled)return;settled=true;if(timer)clearTimeout(timer);
     if(pending.get(key)===entry)pending.delete(key);
     resolve(value);
    };
    notification.on('show',async()=>{
     if(settled||shown||!current())return;shown=true;
     try{
      const next=await updateDesktopNotificationState(stateStore,async latest=>{
       if(!current()||latest.seen.some(item=>keyOf(item)===key))return null;
       const currentPermission=await permission();if(!current())return null;
       const currentTime=asDate(now instanceof Function?now():now);
       if(Number.isNaN(currentTime.getTime()))return null;
       const currentVerdict=shouldDeliverDesktopNotification({candidate,preferences:latest.preferences,taskSettings:task_settings,notificationPermission:currentPermission,now:currentTime,history:latest.seen});
       if(!currentVerdict.deliver)return null;
       return markDesktopNotificationSeen(latest,identity,currentTime.toISOString()).state;
      });
      if(!next||!current()){entry.cancel();return;}
      active.set(key,entry);finish(true);
     }catch{entry.cancel();}
    });
    notification.on('failed',()=>entry.cancel());
    notification.on('close',()=>{
     closed=true;
     if(active.get(key)===entry)active.delete(key);
     finish(false);
    });
    const open=()=>{
     if(entry.cancelled||closed||pending.get(key)!==entry&&active.get(key)!==entry)return;
     try{void Promise.resolve(openTask({task_id:identity.task_id,occurrence_id:identity.occurrence_id})).catch(()=>{});}catch{}
    };
    notification.on('click',open);
    notification.on('action',(event,index)=>{
     const actionIndex=typeof event==='number'?event:typeof index==='number'?index:event?.actionIndex;
     if(actionIndex===0)open();
    });
    timer=setTimeout(()=>entry.cancel(),5000);timer.unref?.();
    try{notification.show();}catch{entry.cancel();}
   });
  }finally{if(pending.get(key)===entry)pending.delete(key);}
 }
 function dismiss(value){
  let identity;try{identity=parseDesktopCommand('notification.dismiss',value).payload;}catch{return false;}
  const key=keyOf(identity),entry=active.get(key)??pending.get(key);
  if(!entry)return false;entry.cancel();return true;
 }
 function dismissTask(taskId){
  let count=0;
  for(const entry of [...active.values(),...pending.values()])if(entry.identity.task_id===taskId){entry.cancel();count++;}
  return count;
 }
 function closeAll(){
  const entries=[...active.values(),...pending.values()];
  for(const entry of entries)entry.cancel();
  return entries.length;
 }
 function permissionChanged(status){return status==='granted'?0:closeAll();}
 async function updatePreferences(value){
  const preferences=normalizeDesktopNotificationPreferences(value);
  preferenceChanges++;closeAll();
  try{
   await updateDesktopNotificationState(stateStore,state=>({...state,preferences}));
   return preferences;
  }finally{preferenceChanges--;}
 }
 return Object.freeze({eventProtocol:2,show,dismiss,dismissTask,closeAll,permissionChanged,updatePreferences});
}
