import {normalizeDesktopNotificationPreferences} from '../../packages/desktop/src/notification-policy.mjs';

export type DesktopNotificationPreferences={enabled:boolean;quiet_hours:{start:string;end:string;timezone:string}|null};
export type DesktopNotificationPermission='granted'|'denied'|'default'|'unsupported'|'unknown';
export type DesktopNotificationsBridge={
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
