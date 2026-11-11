import type {NotificationJournal} from '../../packages/desktop/src/notification-journal.mjs';
import type {DesktopTaskNotificationCandidate,DesktopTaskNotificationSettings} from './types';
import {normalizeDesktopNotificationPreferences} from '../../packages/desktop/src/notification-policy.mjs';

export type DesktopNotificationPreferences={enabled:boolean;quiet_hours:{start:string;end:string;timezone:string}|null};
export type DesktopNotificationPermission='granted'|'denied'|'default'|'unsupported'|'unknown';
export type DesktopNotificationsBridge={
 readNotificationCapabilities?:()=>Promise<unknown>;
 readNotificationJournal?:(scope:string)=>Promise<unknown>;
 saveNotificationJournal?:(scope:string,revision:number,journal:NotificationJournal)=>Promise<unknown>;
 adoptNotificationJournal?:(scope:string,journal:NotificationJournal)=>Promise<unknown>;
 readNotificationState?:()=>Promise<unknown>;
 initializeNotificationState?:(startedAt:string)=>Promise<unknown>;
 showTaskNotification?:(candidate:DesktopTaskNotificationCandidate,settings:DesktopTaskNotificationSettings)=>Promise<unknown>;
 dismissTaskNotification?:(identity:Pick<DesktopTaskNotificationCandidate,'event_id'|'task_id'|'occurrence_id'|'generation'|'event_kind'>)=>Promise<unknown>;
 inspectTaskNotification?:(identity:Pick<DesktopTaskNotificationCandidate,'event_id'|'task_id'|'occurrence_id'|'generation'|'event_kind'>)=>Promise<unknown>;
 readNotificationPreferences:()=>Promise<unknown>;
 setNotificationPreferences:(value:DesktopNotificationPreferences)=>Promise<unknown>;
 readNotificationPermission:()=>Promise<unknown>;
 onNotificationPermission?:(listener:(value:unknown)=>void)=>()=>void;
 onOpenNotificationSettings?:(listener:()=>void)=>()=>void;
};
export function desktopNotificationsBridge():DesktopNotificationsBridge|null{
 if(typeof window==='undefined')return null;
 const value=(window as Window&{jotDesktop?:Partial<DesktopNotificationsBridge>}).jotDesktop;
 return typeof value?.readNotificationPreferences==='function'&&typeof value.setNotificationPreferences==='function'&&typeof value.readNotificationPermission==='function'?value as DesktopNotificationsBridge:null;
}
export function desktopNotificationPreferences(value:unknown):DesktopNotificationPreferences{
 return normalizeDesktopNotificationPreferences(value) as DesktopNotificationPreferences;
}
export function desktopNotificationPermission(value:unknown):DesktopNotificationPermission{
 return typeof value==='string'&&['granted','denied','default','unsupported'].includes(value)?value as DesktopNotificationPermission:'unknown';
}

export type DesktopNotificationDeliveryReceipt={protocol:1;event_id:string;status:'shown'|'already_seen'|'deferred'|'in_progress'|'unknown';reason:string|null};
const deliveryRecord=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
export function supportsDesktopNotificationDelivery(value:unknown):boolean{
 const row=deliveryRecord(value);
 return !!row&&Object.keys(row).sort().join(',')==='delivery_protocol,event_protocol,inspection_protocol,journal_protocol'&&row.event_protocol===2&&row.delivery_protocol===1&&row.inspection_protocol===1&&row.journal_protocol===1;
}
export function desktopNotificationDeliveryReceipt(value:unknown,eventId:string):DesktopNotificationDeliveryReceipt{
 const row=deliveryRecord(value);
 if(!row||Object.keys(row).sort().join(',')!=='event_id,protocol,reason,status'||row.protocol!==1||typeof row.event_id!=='string'||!/^desktop-notice-[a-f0-9]{64}$/.test(row.event_id)||row.event_id!==eventId||
  typeof row.status!=='string'||!['shown','already_seen','deferred','in_progress','unknown'].includes(row.status)||
  (row.status==='deferred'||row.status==='unknown'?typeof row.reason!=='string'||!/^[a-z][a-z0-9_]{0,95}$/.test(row.reason):row.reason!==null))throw Error('desktop_notification_receipt_invalid');
 return {protocol:1,event_id:row.event_id,status:row.status as DesktopNotificationDeliveryReceipt['status'],reason:row.reason as string|null};
}
