import {useEffect,useState} from 'react';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import {desktopNotificationsBridge,desktopNotificationPreferences,desktopNotificationDeliveryReceipt,supportsDesktopNotificationDelivery,type DesktopNotificationsBridge} from './desktop-notifications';
import {DesktopNotificationJournal,eventIdentity,notificationPage,notificationStatus,notificationInspection,notificationInitialization,sameNotification,type NotificationIdentity,type NotificationJournal,type NotificationPending} from './desktop-task-notification-feed';

type DeliveryBridge=DesktopNotificationsBridge&Required<Pick<DesktopNotificationsBridge,'readNotificationCapabilities'|'initializeNotificationState'|'showTaskNotification'|'dismissTaskNotification'|'inspectTaskNotification'>>;
type FeedState={state:'disabled'|'running'|'waiting'|'blocked'|'unsupported';pending:number;unknown:number};
function pause(signal:AbortSignal){return new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,5000);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});}
export function useDesktopTaskNotifications(owner:string){
 const [snapshot,setSnapshot]=useState<FeedState>({state:'disabled',pending:0,unknown:0}),[revision,retry]=useState(0);
 useEffect(()=>{
  const candidate=desktopNotificationsBridge();
  if(!candidate)return;
  const methods=['readNotificationCapabilities','initializeNotificationState','showTaskNotification','dismissTaskNotification','inspectTaskNotification'] as const;
  if(methods.some(method=>typeof candidate[method]!=='function')||!navigator.locks?.request){setSnapshot({state:'unsupported',pending:0,unknown:0});return;}
  const bridge=candidate as DeliveryBridge,controller=new AbortController(),signal=controller.signal;
  let saved:NotificationJournal|null=null,rotation=0;
  const current=()=>!signal.aborted&&taskDraftScope()===owner;
  const publish=(state:FeedState['state'])=>{if(current())setSnapshot(previous=>{const pending=saved?.pending.length??0,unknown=saved?.pending.filter(item=>['dispatching','unknown','observing'].includes(item.state)).length??0;return previous.state===state&&previous.pending===pending&&previous.unknown===unknown?previous:{state,pending,unknown};});};
  async function native<T>(promise:Promise<T>):Promise<T>{
   let timer:ReturnType<typeof setTimeout>|undefined,onAbort=()=>{};
   try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{
    onAbort=()=>reject(Error('desktop_notification_native_unavailable'));
    timer=setTimeout(onAbort,12000);signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();
   })]);}finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
  }
  async function network<T>(load:(signal:AbortSignal)=>Promise<T>):Promise<T>{
   const request=new AbortController(),abort=()=>request.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   const timer=setTimeout(abort,12000);try{return await load(request.signal);}finally{clearTimeout(timer);signal.removeEventListener('abort',abort);request.abort();}
  }
  async function dismiss(identity:NotificationIdentity){if(typeof await native(bridge.dismissTaskNotification(identity))!=='boolean')throw Error('desktop_notification_data_invalid');}
  const release=()=>{for(const entry of saved?.pending??[])if(entry.state!=='queued')void bridge.dismissTaskNotification(entry.identity).catch(()=>{});};
  void navigator.locks.request('jot:desktop-notification-feed:'+owner,{mode:'exclusive',signal},async()=>{
   if(!current())return;
   const journal=new DesktopNotificationJournal(localStorage,owner);saved=journal.read();
   function commit(value:NotificationJournal){if(!current())throw Error('desktop_notification_owner_changed');journal.save(value);saved=value;}
   function replace(entry:NotificationPending,next:NotificationPending|null){
    if(!saved)return;commit({...saved,pending:next?saved.pending.map(item=>item.identity.event_id===entry.identity.event_id?next:item):saved.pending.filter(item=>item.identity.event_id!==entry.identity.event_id)});
   }
   if(!supportsDesktopNotificationDelivery(await native(bridge.readNotificationCapabilities()))){publish('unsupported');release();return;}
   publish('waiting');
   try{
    while(current()){
     try{
      const preferences=desktopNotificationPreferences(await native(bridge.readNotificationPreferences()));if(!current())break;
      if(!saved){
       if(!preferences.enabled){publish('disabled');await pause(signal);continue;}
       const first=notificationPage(await network(abort=>workbenchApi.desktopNotificationEvents(undefined,abort)),null);if(!current())break;
       const initialized=await native(bridge.initializeNotificationState(first.server_time));if(!current())break;
       notificationInitialization(initialized);
       commit({version:1,cursor:null,baseline:first.server_time,pending:[]});
      }
      const state=saved!;
      const entries=state.pending.slice();const count=Math.min(8,entries.length),start=entries.length?rotation%entries.length:0;
      for(let offset=0;offset<count&&current();offset++){
       const entry=entries[(start+offset)%entries.length]!;
       const inspection=notificationInspection(await native(bridge.inspectTaskNotification(entry.identity)),entry.identity.event_id);if(!current())break;
       const event=notificationStatus(await network(abort=>workbenchApi.desktopNotificationStatus(entry.identity.event_id,abort)),entry.identity);if(!current())break;
       if(event.source_status==='revoked'){await dismiss(entry.identity);replace(entry,null);continue;}
       if(inspection==='seen'){replace(entry,null);continue;}
       if(inspection==='active'){if(entry.state!=='shown')replace(entry,{...entry,state:'shown'});continue;}
       if(inspection==='pending'){if(entry.state!=='observing')replace(entry,{...entry,state:'observing'});continue;}
       if(entry.state!=='queued'){if(entry.state!=='unknown')replace(entry,{...entry,state:'unknown'});continue;}
       if(!preferences.enabled)continue;
       // Persist before crossing IPC. Recovered attempts can only be observed, never resent.
       replace(entry,{...entry,state:'dispatching'});
       try{
        const response=desktopNotificationDeliveryReceipt(await native(bridge.showTaskNotification(event.candidate,event.task_settings)),entry.identity.event_id);
        if(!current())break;
        replace(entry,{...entry,state:response.status==='deferred'?'queued':response.status==='shown'||response.status==='already_seen'?'shown':response.status==='in_progress'?'observing':'unknown'});
       }catch(error){if(current())replace(entry,{...entry,state:'unknown'});throw error;}
      }
      rotation=start+count;
      if(!current())break;
      if(preferences.enabled&&saved!.pending.length<64){
       const after=saved!.cursor,page=notificationPage(await network(abort=>workbenchApi.desktopNotificationEvents(after??undefined,abort)),after);if(!current())break;
       let next={...saved!,pending:saved!.pending.slice()};
       for(const event of page.items){
        const identity=eventIdentity(event),existing=next.pending.find(item=>item.identity.event_id===event.event_id);
        if(existing&&!sameNotification(existing.identity,identity))throw Error('desktop_notification_data_invalid');
        if(!existing&&event.source_status==='current'&&Date.parse(event.created_at)>=Date.parse(next.baseline)){
         if(next.pending.length>=64)break;
         next.pending.push({identity,state:'queued'});
        }
        next.cursor=event.event_id;
       }
       if(next.cursor!==saved!.cursor||next.pending.length!==saved!.pending.length)commit(next);
      }
      publish(preferences.enabled?'running':'disabled');
     }catch(error){
      if(!current())break;
      const code=error instanceof Error?error.message:'';
      if(!code||code.startsWith('desktop_notification_'))throw error;
      // A source cannot be confirmed while disconnected. Close known views without replaying them.
      for(const entry of saved?.pending??[])if(entry.state!=='queued')await dismiss(entry.identity);
      publish('blocked');
     }
     await pause(signal);
    }
   }finally{release();}
  }).catch(()=>{if(current()){publish('blocked');release();}});
  return()=>{controller.abort();release();};
 },[owner,revision]);
 return {...snapshot,retry:()=>retry(value=>value+1)};
}
