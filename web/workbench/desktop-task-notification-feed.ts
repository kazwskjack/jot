import {notificationIdentity,normalizeNotificationJournal} from '../../packages/desktop/src/notification-journal.mjs';
export {notificationIdentity,endNotificationWait} from '../../packages/desktop/src/notification-journal.mjs';
export type {NotificationIdentity,NotificationPending,NotificationJournal} from '../../packages/desktop/src/notification-journal.mjs';
import type {NotificationIdentity,NotificationJournal} from '../../packages/desktop/src/notification-journal.mjs';
import type {DesktopTaskNotificationCandidate,DesktopTaskNotificationEvent,DesktopTaskNotificationPage,DesktopTaskNotificationStatus} from './types';
import {normalizeDesktopTaskNotificationPolicy,normalizeDesktopNotificationPreferences} from '../../packages/desktop/src/notification-policy.mjs';

const kinds=['changed','completed','failed','needs_confirmation'];
const invalid=()=>{throw Error('desktop_notification_data_invalid');};
const row=(value:unknown):Record<string,any>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:invalid();
function exact(value:Record<string,any>,keys:string[]){if(Object.keys(value).sort().join(',')!==keys.slice().sort().join(','))invalid();}
const id=(value:unknown):value is string=>typeof value==='string'&&/^desktop-notice-[a-f0-9]{64}$/.test(value);
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max;
const time=(value:unknown):value is string=>text(value,40)&&Number.isFinite(Date.parse(value));
export function eventIdentity(event:DesktopTaskNotificationEvent):NotificationIdentity{
 return notificationIdentity({event_id:event.event_id,task_id:event.task_id,occurrence_id:event.occurrence_id,generation:event.generation,event_kind:event.event_kind});
}
export function sameNotification(left:NotificationIdentity,right:NotificationIdentity){return left.event_id===right.event_id&&left.task_id===right.task_id&&left.occurrence_id===right.occurrence_id&&left.generation===right.generation&&left.event_kind===right.event_kind;}
function notificationEvent(value:unknown):DesktopTaskNotificationEvent{
 const item=row(value);exact(item,['event_id','task_id','occurrence_id','generation','event_kind','created_at','source_status','candidate','task_settings']);
 const identity=notificationIdentity({event_id:item.event_id,task_id:item.task_id,occurrence_id:item.occurrence_id,generation:item.generation,event_kind:item.event_kind});
 if(!time(item.created_at))invalid();
 if(item.source_status==='revoked'){
  if(item.candidate!==null||item.task_settings!==null)invalid();
  return {...identity,created_at:item.created_at,source_status:'revoked',candidate:null,task_settings:null};
 }
 if(item.source_status!=='current')invalid();
 const candidate=row(item.candidate);exact(candidate,['event_id','task_id','occurrence_id','generation','event_kind','title','body']);
 if(!sameNotification(identity,notificationIdentity({event_id:candidate.event_id,task_id:candidate.task_id,occurrence_id:candidate.occurrence_id,generation:candidate.generation,event_kind:candidate.event_kind}))||!text(candidate.title,200)||!text(candidate.body,4096))invalid();
 const settings=row(item.task_settings);exact(settings,['task_id','version','channel_binding_ids','events','delivery_policy']);
 if(settings.task_id!==identity.task_id||!Number.isSafeInteger(settings.version)||settings.version<0||!Array.isArray(settings.channel_binding_ids)||settings.channel_binding_ids.length>5||settings.channel_binding_ids.some((value:unknown)=>!text(value,128))||new Set(settings.channel_binding_ids).size!==settings.channel_binding_ids.length||!Array.isArray(settings.events)||settings.events.length>4||settings.events.some((value:unknown)=>!kinds.includes(value as string))||new Set(settings.events).size!==settings.events.length||!settings.events.includes(identity.event_kind))invalid();
 const policy=row(settings.delivery_policy);exact(policy,['min_interval_seconds','max_per_24_hours','quiet_hours']);
 return {...identity,created_at:item.created_at,source_status:'current',candidate:{...candidate} as DesktopTaskNotificationCandidate,task_settings:{task_id:settings.task_id,version:settings.version,channel_binding_ids:[...settings.channel_binding_ids],events:[...settings.events],delivery_policy:normalizeDesktopTaskNotificationPolicy(policy)}};
}
export function notificationPage(value:unknown,after:string|null):DesktopTaskNotificationPage{
 const page=row(value);exact(page,['protocol','items','after_event_id','next_event_id','has_more','server_time','execution_granted']);
 if(page.protocol!==1||page.execution_granted!==false||!time(page.server_time)||page.after_event_id!==after||!Array.isArray(page.items)||page.items.length>50||typeof page.has_more!=='boolean'||page.has_more&&page.items.length!==50)invalid();
 const items=page.items.map(notificationEvent),next=items.length?items[items.length-1]!.event_id:after;
 if(page.next_event_id!==next||items.length&&next===after||new Set(items.map(item=>item.event_id)).size!==items.length)invalid();
 return {protocol:1,items,after_event_id:after,next_event_id:next,has_more:page.has_more,server_time:page.server_time,execution_granted:false};
}
export function notificationStatus(value:unknown,identity:NotificationIdentity):DesktopTaskNotificationEvent{
 const status=row(value);exact(status,['protocol','event','server_time','execution_granted']);
 if(status.protocol!==1||status.execution_granted!==false||!time(status.server_time))invalid();
 const event=notificationEvent(status.event);if(!sameNotification(identity,eventIdentity(event)))invalid();return event;
}
export function notificationInspection(value:unknown,eventId:string):'active'|'pending'|'seen'|'not_recorded'{
 const status=row(value);exact(status,['protocol','event_id','status']);
 if(status.protocol!==1||status.event_id!==eventId||!['active','pending','seen','not_recorded'].includes(status.status))invalid();
 return status.status;
}
export function notificationInitialization(value:unknown){
 const initialized=row(value);exact(initialized,['version','preferences','seen','initialized_at']);
 if(![1,2].includes(initialized.version)||!time(initialized.initialized_at)||!Array.isArray(initialized.seen)||initialized.seen.length>2000)invalid();
 normalizeDesktopNotificationPreferences(initialized.preferences);
}
// Retained browser records are read-only migration sources; native storage owns new writes.
export class DesktopNotificationJournal{
 private raw:string|null;
 private readonly key:string;
 constructor(private readonly storage:Storage,scope:string){
  if(!/^[a-f0-9]{64}$/.test(scope))invalid();
  this.key='jot:desktop-notification-feed:'+scope;this.raw=storage.getItem(this.key);
 }
 read():NotificationJournal|null{
  if(this.raw===null)return null;
  if(this.raw.length>131072)invalid();return normalizeNotificationJournal(JSON.parse(this.raw));
 }
}
