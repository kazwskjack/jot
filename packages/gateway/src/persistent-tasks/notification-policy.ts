import {normalizeCalendarTrigger} from './calendar.ts';

export type NotificationDeliveryPolicy = {
  min_interval_seconds:number;
  max_per_24_hours:number;
  quiet_hours:null|{start:string;end:string;timezone:string};
};
export const defaultNotificationPolicy:NotificationDeliveryPolicy={min_interval_seconds:60,max_per_24_hours:20,quiet_hours:null};

export function normalizeNotificationPolicy(input:unknown):NotificationDeliveryPolicy {
  const value=input as Record<string,unknown>|null;
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['min_interval_seconds','max_per_24_hours','quiet_hours'].includes(key))||
    !Number.isInteger(value.min_interval_seconds)||Number(value.min_interval_seconds)<1||Number(value.min_interval_seconds)>86400||
    !Number.isInteger(value.max_per_24_hours)||Number(value.max_per_24_hours)<1||Number(value.max_per_24_hours)>100||value.quiet_hours===undefined)throw new Error('invalid_task_notification_settings');
  let quiet:NotificationDeliveryPolicy['quiet_hours']=null;
  if(value.quiet_hours!==null){
    const q=value.quiet_hours as Record<string,unknown>|null;
    if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).some(key=>!['start','end','timezone'].includes(key))||q.start===q.end)throw new Error('invalid_task_notification_settings');
    try {normalizeCalendarTrigger({kind:'daily',time:q.start,timezone:q.timezone});normalizeCalendarTrigger({kind:'daily',time:q.end,timezone:q.timezone});}
    catch {throw new Error('invalid_task_notification_settings');}
    quiet={start:String(q.start),end:String(q.end),timezone:String(q.timezone)};
  }
  return {min_interval_seconds:Number(value.min_interval_seconds),max_per_24_hours:Number(value.max_per_24_hours),quiet_hours:quiet};
}

/** Resolve quiet hours against actual instants, including skipped/repeated local
 * times. Never infer a UTC offset from the server's timezone. */
export function notificationQuietUntil(policy:NotificationDeliveryPolicy,now:number):number|null {
  const quiet=policy.quiet_hours;if(!quiet)return null;
  const format=new Intl.DateTimeFormat('en-US',{timeZone:quiet.timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit'});
  const minute=(text:string)=>Number(text.slice(0,2))*60+Number(text.slice(3));
  const start=minute(quiet.start),end=minute(quiet.end);
  const isQuiet=(instant:number)=>{
    const parts=format.formatToParts(new Date(instant*1000));
    const local=Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value);
    return start<end?local>=start&&local<end:local>=start||local<end;
  };
  if(!isQuiet(now))return null;
  // A wall-time inversion can choose the first occurrence of an ambiguous end
  // already behind us. Walk actual minute boundaries instead; this also handles
  // non-hour transitions and date-line changes without losing the queued effect.
  for(let next=Math.floor(now/60)*60+60;next<=now+48*3600;next+=60)if(!isQuiet(next))return next;
  throw new Error('notification_quiet_end_unresolved');
}
