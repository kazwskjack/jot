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
  const receipt=(status,reason=null)=>Object.hasOwn(identity,'event_id')?Object.freeze({protocol:1,event_id:identity.event_id,status,reason}):status==='shown';
  if(!supported()){closeAll();return receipt('deferred','unsupported');}
  if(preferenceChanges)return receipt('deferred','preferences_updating');
  if(active.has(key))return receipt('already_seen');
  if(pending.has(key))return receipt('in_progress');
  let finish=()=>{},closed=false,dispatched=false;
  const entry={identity,notification:null,cancelled:false,cancel:(reason='cancelled')=>{
   entry.cancelled=true;
   if(pending.get(key)===entry)pending.delete(key);
   if(active.get(key)===entry)active.delete(key);
   try{entry.notification?.close();}catch{}
   finish(receipt(dispatched?'unknown':'deferred',reason));
  }};
  // Reserve before the first await so duplicate calls and revocation see preparation.
  pending.set(key,entry);
  const current=()=>!entry.cancelled&&!closed&&!preferenceChanges&&pending.get(key)===entry;
  try{
   const state=await stateStore.read();if(!current())return receipt('deferred','cancelled');
   if(state.seen.some(item=>keyOf(item)===key))return receipt('already_seen');
   const notificationPermission=await permission();if(!current())return receipt('deferred','cancelled');
   if(notificationPermission!=='granted'){closeAll();return receipt('deferred',notificationPermission==='denied'?'permission_denied':'permission_required');}
   const instant=asDate(now instanceof Function?now():now);
   if(Number.isNaN(instant.getTime()))return receipt('deferred','invalid_time');
   const verdict=shouldDeliverDesktopNotification({candidate,preferences:state.preferences,taskSettings:task_settings,notificationPermission,now:instant,history:state.seen});
   if(!verdict.deliver)return receipt('deferred',verdict.reason);
   let notification;
   try{notification=new NotificationClass({title:candidate.title,body:candidate.body,actions:[{type:'button',text:'打开任务'}]});}
   catch{return receipt('deferred','native_unavailable');}
   entry.notification=notification;
   if(!current()){entry.cancel();return receipt('deferred','cancelled');}
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
      active.set(key,entry);finish(receipt('shown'));
     }catch{entry.cancel('acknowledgement_unavailable');}
    });
    notification.on('failed',()=>entry.cancel('native_failed'));
    notification.on('close',()=>{
     closed=true;
     if(active.get(key)===entry)active.delete(key);
     finish(receipt(dispatched?'unknown':'deferred','closed_before_acknowledgement'));
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
    timer=setTimeout(()=>entry.cancel('acknowledgement_timeout'),5000);timer.unref?.();
    try{dispatched=true;notification.show();}catch{entry.cancel('native_failed');}
   });
  }catch(error){
   entry.cancel('delivery_unavailable');
   if(Object.hasOwn(identity,'event_id'))return receipt(dispatched?'unknown':'deferred','delivery_unavailable');
   throw error;
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
 return Object.freeze({eventProtocol:2,deliveryProtocol:1,show,dismiss,dismissTask,closeAll,permissionChanged,updatePreferences});
}
