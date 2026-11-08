const notificationEvents=new Set(['changed','completed','failed','needs_confirmation']);
const timePattern=/^(?:[01]\d|2[0-3]):[0-5]\d$/;

function invalid(){throw new Error('desktop_notification_preferences_invalid');}
function plainRecord(value){return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function normalizeQuietHours(value){
 if(value===null)return null;
 if(!plainRecord(value)||Object.keys(value).some(key=>!['start','end','timezone'].includes(key))||
  typeof value.start!=='string'||!timePattern.test(value.start)||typeof value.end!=='string'||!timePattern.test(value.end)||
  value.start===value.end||typeof value.timezone!=='string'||!value.timezone||value.timezone.length>100||
  value.timezone.trim()!==value.timezone||/^[+-]/.test(value.timezone))invalid();
 try{new Intl.DateTimeFormat('en-US',{timeZone:value.timezone});}catch{invalid();}
 return Object.freeze({start:value.start,end:value.end,timezone:value.timezone});
}

export function normalizeDesktopNotificationPreferences(value){
 if(!plainRecord(value)||Object.keys(value).some(key=>!['enabled','quiet_hours'].includes(key))||typeof value.enabled!=='boolean'||!Object.hasOwn(value,'quiet_hours'))invalid();
 return Object.freeze({enabled:value.enabled,quiet_hours:normalizeQuietHours(value.quiet_hours)});
}
function quietAt(quiet,date){
 if(!quiet)return false;
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:quiet.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date);
 const part=name=>Number(parts.find(value=>value.type===name)?.value);
 const minute=part('hour')*60+part('minute'),start=Number(quiet.start.slice(0,2))*60+Number(quiet.start.slice(3)),end=Number(quiet.end.slice(0,2))*60+Number(quiet.end.slice(3));
 return start<end?minute>=start&&minute<end:minute>=start||minute<end;
}
function normalizeDeliveryPolicy(value){
 if(value===undefined||value===null)return {min_interval_seconds:60,max_per_24_hours:20,quiet_hours:null};
 if(!plainRecord(value)||Object.keys(value).some(key=>!['min_interval_seconds','max_per_24_hours','quiet_hours'].includes(key))||
  !Number.isInteger(value.min_interval_seconds)||value.min_interval_seconds<1||value.min_interval_seconds>86400||
  !Number.isInteger(value.max_per_24_hours)||value.max_per_24_hours<1||value.max_per_24_hours>100||
  !Object.hasOwn(value,'quiet_hours'))invalid();
 return {min_interval_seconds:value.min_interval_seconds,max_per_24_hours:value.max_per_24_hours,quiet_hours:normalizeQuietHours(value.quiet_hours)};
}

export function shouldDeliverDesktopNotification({candidate,preferences,taskSettings,notificationPermission,now,history=[]}={}){
 const local=normalizeDesktopNotificationPreferences(preferences);
 if(!local.enabled)return {deliver:false,reason:'disabled'};
 if(notificationPermission!=='granted')return {deliver:false,reason:notificationPermission==='denied'?'permission_denied':'permission_required'};
 if(!candidate||!notificationEvents.has(candidate.event_kind)||!taskSettings||!Array.isArray(taskSettings.events)||!taskSettings.events.includes(candidate.event_kind))return {deliver:false,reason:'event_not_selected'};
 const time=now instanceof Date?now:new Date(now);
 if(Number.isNaN(time.getTime()))return {deliver:false,reason:'invalid_time'};
 const policy=normalizeDeliveryPolicy(taskSettings.delivery_policy);
 if(quietAt(local.quiet_hours,time)||quietAt(policy.quiet_hours,time))return {deliver:false,reason:'quiet_hours'};
 const recent=Array.isArray(history)?history.filter(item=>item&&item.task_id===candidate.task_id).map(item=>Date.parse(item.shown_at)).filter(value=>Number.isFinite(value)&&value<=time.getTime()&&value>time.getTime()-86400000):[];
 if(recent.length>=policy.max_per_24_hours)return {deliver:false,reason:'rate_limited'};
 if(recent.length&&time.getTime()-Math.max(...recent)<policy.min_interval_seconds*1000)return {deliver:false,reason:'rate_limited'};
 return {deliver:true,reason:'ready'};
}
