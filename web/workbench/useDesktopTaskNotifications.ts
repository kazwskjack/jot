import {NativeDesktopNotificationJournal} from './desktop-native-notification-journal';
import {useEffect,useRef,useState} from 'react';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import {desktopNotificationsBridge,desktopNotificationPreferences,desktopNotificationDeliveryReceipt,supportsDesktopNotificationDelivery,type DesktopNotificationsBridge} from './desktop-notifications';
import {DesktopNotificationJournal,endNotificationWait,eventIdentity,notificationPage,notificationStatus,notificationInspection,notificationInitialization,sameNotification,type NotificationIdentity,type NotificationJournal,type NotificationPending} from './desktop-task-notification-feed';

type DeliveryBridge=DesktopNotificationsBridge&Required<Pick<DesktopNotificationsBridge,'readNotificationJournal'|'saveNotificationJournal'|'adoptNotificationJournal'|'readNotificationCapabilities'|'initializeNotificationState'|'showTaskNotification'|'dismissTaskNotification'|'inspectTaskNotification'>>;
type FeedState={state:'disabled'|'running'|'waiting'|'blocked'|'unsupported';pending:number;unknown:number;ended:NotificationIdentity[];endWaiting:boolean;historyAvailable:number};
function pause(signal:AbortSignal){return new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,5000);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});}
export function useDesktopTaskNotifications(owner:string){
 const [snapshot,setSnapshot]=useState<FeedState>({state:'disabled',pending:0,unknown:0,ended:[],endWaiting:false,historyAvailable:64}),[revision,retry]=useState(0);
 const endRequest=useRef<{owner:string;ids:string[]}|null>(null),visibleUnknown=useRef<{owner:string;ids:string[]}>({owner,ids:[]});
 useEffect(()=>{
  const candidate=desktopNotificationsBridge();
  if(!candidate)return;
  const methods=['readNotificationJournal','saveNotificationJournal','adoptNotificationJournal','readNotificationCapabilities','initializeNotificationState','showTaskNotification','dismissTaskNotification','inspectTaskNotification'] as const;
  if(methods.some(method=>typeof candidate[method]!=='function')||!navigator.locks?.request){setSnapshot({state:'unsupported',pending:0,unknown:0,ended:[],endWaiting:false,historyAvailable:64});return;}
  const bridge=candidate as DeliveryBridge,controller=new AbortController(),signal=controller.signal;
  let saved:NotificationJournal|null=null,rotation=0;
  const current=()=>!signal.aborted&&taskDraftScope()===owner;
  const publish=(state?:FeedState['state'])=>{
   if(!current())return;
   visibleUnknown.current={owner,ids:saved?.pending.filter(item=>['dispatching','unknown','observing'].includes(item.state)).map(item=>item.identity.event_id)??[]};
   const pending=saved?.pending.length??0,ending=saved?.pending.filter(item=>item.state==='ending').length??0,unknown=visibleUnknown.current.ids.length+ending;
   const endWaiting=ending>0||endRequest.current?.owner===owner,historyAvailable=64-(saved?.ended.length??0)-ending,ended=saved?.ended;
   setSnapshot(previous=>{const phase=state??previous.state,history=ended??previous.ended;return previous.state===phase&&previous.pending===pending&&previous.unknown===unknown&&previous.ended===history&&previous.endWaiting===endWaiting&&previous.historyAvailable===historyAvailable?previous:{state:phase,pending,unknown,ended:history,endWaiting,historyAvailable};});
  };
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
   const legacy=new DesktopNotificationJournal(localStorage,owner).read();
   if(!supportsDesktopNotificationDelivery(await native(bridge.readNotificationCapabilities()))){publish('unsupported');return;}
   async function journalCall<T>(operation:()=>Promise<T>){
    if(!current())throw Error('desktop_notification_owner_changed');
    try{return await native(operation());}catch{throw Error('desktop_notification_journal_unavailable');}
   }
   const journal=await NativeDesktopNotificationJournal.open({read:scope=>journalCall(()=>bridge.readNotificationJournal(scope)),write:(scope,revision,value)=>journalCall(()=>bridge.saveNotificationJournal(scope,revision,value)),adopt:(scope,value)=>journalCall(()=>bridge.adoptNotificationJournal(scope,value))},owner,legacy);
   saved=journal.read();
   async function commit(value:NotificationJournal){if(!current())throw Error('desktop_notification_owner_changed');await journal.save(value);if(!current())throw Error('desktop_notification_owner_changed');saved=value;}
   async function replace(entry:NotificationPending,next:NotificationPending|null){
    if(!saved)return;await commit({...saved,pending:next?saved.pending.map(item=>item.identity.event_id===entry.identity.event_id?next:item):saved.pending.filter(item=>item.identity.event_id!==entry.identity.event_id)});
   }
   async function flushEndWait(){
    if(!saved||!current())return;
    if(endRequest.current?.owner===owner){
     const request=endRequest.current;
     try{await commit(endNotificationWait(saved,request.ids));}catch(error){endRequest.current=null;throw error;}
     endRequest.current=null;
    }
    const ending=saved.pending.filter(item=>item.state==='ending');if(!ending.length)return;
    const ids=new Set(ending.map(item=>item.identity.event_id));
    await commit({...saved,pending:saved.pending.filter(item=>!ids.has(item.identity.event_id)),ended:[...saved.ended,...ending.map(item=>item.identity)]});
    // Ending the wait preserves unknown; cancellation is best effort, not a completion receipt.
    for(const entry of ending)void native(bridge.dismissTaskNotification(entry.identity)).catch(()=>{});
   }
   try{
    await flushEndWait();publish('waiting');
    while(current()){
     try{
      await flushEndWait();
      const preferences=desktopNotificationPreferences(await native(bridge.readNotificationPreferences()));if(!current())break;
      if(!saved){
       if(!preferences.enabled){publish('disabled');await pause(signal);continue;}
       const first=notificationPage(await network(abort=>workbenchApi.desktopNotificationEvents(undefined,abort)),null);if(!current())break;
       const initialized=await native(bridge.initializeNotificationState(first.server_time));if(!current())break;
       notificationInitialization(initialized);
       await commit({version:2,cursor:null,baseline:first.server_time,pending:[],ended:[]});
      }
      const state=saved!;
      const entries=state.pending.slice();const count=Math.min(8,entries.length),start=entries.length?rotation%entries.length:0;
      for(let offset=0;offset<count&&current();offset++){
       const entry=entries[(start+offset)%entries.length]!;
       const inspection=notificationInspection(await native(bridge.inspectTaskNotification(entry.identity)),entry.identity.event_id);if(!current())break;
       const event=notificationStatus(await network(abort=>workbenchApi.desktopNotificationStatus(entry.identity.event_id,abort)),entry.identity);if(!current())break;
       if(event.source_status==='revoked'){await dismiss(entry.identity);await replace(entry,null);continue;}
       if(inspection==='seen'){await replace(entry,null);continue;}
       if(inspection==='active'){if(entry.state!=='shown')await replace(entry,{...entry,state:'shown'});continue;}
       if(inspection==='pending'){if(entry.state!=='observing')await replace(entry,{...entry,state:'observing'});continue;}
       if(entry.state!=='queued'){if(entry.state!=='unknown')await replace(entry,{...entry,state:'unknown'});continue;}
       if(!preferences.enabled)continue;
       // Persist before crossing IPC. Recovered attempts can only be observed, never resent.
       await replace(entry,{...entry,state:'dispatching'});if(!current())break;
       try{
        const response=desktopNotificationDeliveryReceipt(await native(bridge.showTaskNotification(event.candidate,event.task_settings)),entry.identity.event_id);
        if(!current())break;
        await replace(entry,{...entry,state:response.status==='deferred'?'queued':response.status==='shown'||response.status==='already_seen'?'shown':response.status==='in_progress'?'observing':'unknown'});
       }catch(error){if(current())await replace(entry,{...entry,state:'unknown'});throw error;}
      }
      rotation=start+count;
      if(!current())break;
      if(preferences.enabled&&saved!.pending.length<64){
       const after=saved!.cursor,page=notificationPage(await network(abort=>workbenchApi.desktopNotificationEvents(after??undefined,abort)),after);if(!current())break;
       let next={...saved!,pending:saved!.pending.slice()};
       for(const event of page.items){
        const identity=eventIdentity(event),existing=next.pending.find(item=>item.identity.event_id===event.event_id)??next.ended.find(item=>item.event_id===event.event_id);
        if(existing&&!sameNotification('identity' in existing?existing.identity:existing,identity))throw Error('desktop_notification_data_invalid');
        if(!existing&&event.source_status==='current'&&Date.parse(event.created_at)>=Date.parse(next.baseline)){
         if(next.pending.length>=64)break;
         next.pending.push({identity,state:'queued'});
        }
        next.cursor=event.event_id;
       }
       if(next.cursor!==saved!.cursor||next.pending.length!==saved!.pending.length)await commit(next);
      }
      publish(preferences.enabled?'running':'disabled');
     }catch(error){
      if(!current())break;
      const code=error instanceof Error?error.message:'';
      if(code==='desktop_notification_history_full')endRequest.current=null;
      if(!code||code.startsWith('desktop_notification_'))throw error;
      // A source cannot be confirmed while disconnected. Close known views without replaying them.
      for(const entry of saved?.pending??[])if(entry.state!=='queued')await dismiss(entry.identity);
      publish('blocked');
     }
     await pause(signal);
    }
   }finally{try{await flushEndWait();publish();}finally{release();}}
  }).catch(()=>{if(current()){publish('blocked');release();}});
  return()=>{controller.abort();release();};
 },[owner,revision]);
 return {...snapshot,retry:()=>retry(value=>value+1),endWait:()=>{
  const selection=visibleUnknown.current;
  if(taskDraftScope()!==owner||selection.owner!==owner||!selection.ids.length||snapshot.historyAvailable<1||snapshot.endWaiting)return;
  endRequest.current={owner,ids:selection.ids.slice(0,snapshot.historyAvailable)};setSnapshot(previous=>({...previous,endWaiting:true}));
  if(snapshot.state==='blocked'||snapshot.state==='unsupported')retry(value=>value+1);
 }};
}
