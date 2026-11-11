import React,{useCallback,useEffect,useRef,useState} from 'react';
import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {taskDraftScope} from '../jot/client';
import {desktopNotificationsBridge,desktopNotificationPreferences,desktopNotificationPermission,type DesktopNotificationPreferences,type DesktopNotificationPermission} from './desktop-notifications';

function quietDefaults(){
 let timezone='UTC';try{timezone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{}
 return {start:'22:00',end:'08:00',timezone};
}
export default function DesktopNotificationsPanel({scopeKey,onPendingChange,onClose}:{scopeKey:string;onPendingChange:(pending:boolean)=>void;onClose:()=>void}){
 const language=useApplicationLanguage(),t=useApplicationText(),[bridge]=useState(desktopNotificationsBridge);
 const [saved,setSaved]=useState<DesktopNotificationPreferences|null>(null),[draft,setDraft]=useState<DesktopNotificationPreferences>({enabled:false,quiet_hours:null});
 const [permission,setPermission]=useState<DesktopNotificationPermission>('unknown'),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const live=useRef(false),working=useRef(false),mutating=useRef(false),revision=useRef(0),pending=useRef(onPendingChange);pending.current=onPendingChange;
 const current=()=>live.current&&taskDraftScope()===scopeKey;
 const load=useCallback(async()=>{
  if(!bridge||working.current||taskDraftScope()!==scopeKey)return;
  working.current=true;const version=++revision.current;setBusy(true);setError('');setNotice('');
  try{
   const [preferences,status]=await Promise.all([bridge.readNotificationPreferences(),bridge.readNotificationPermission()]);
   const value=desktopNotificationPreferences(preferences);
   if(live.current&&version===revision.current&&taskDraftScope()===scopeKey){setSaved(value);setDraft(value);setPermission(desktopNotificationPermission(status));setUncertain(false);}
  }catch{if(live.current&&version===revision.current&&taskDraftScope()===scopeKey)setError('read');}
  finally{if(version===revision.current){working.current=false;if(live.current)setBusy(false);}}
 },[bridge,scopeKey]);
 useEffect(()=>{
  live.current=true;void load();
  const unsubscribe=bridge?.onNotificationPermission?.(value=>{if(current())setPermission(desktopNotificationPermission(value));});
  return()=>{live.current=false;revision.current++;working.current=false;if(mutating.current){mutating.current=false;pending.current(false);}unsubscribe?.();};
 },[bridge,scopeKey,load]);
 function start(){
  if(!bridge||!current()||working.current)return false;
  working.current=true;mutating.current=true;setBusy(true);setError('');setNotice('');pending.current(true);return true;
 }
 function finish(){working.current=false;if(current()){mutating.current=false;setBusy(false);pending.current(false);}}
 async function save(){
  if(!saved||uncertain)return;
  let value:DesktopNotificationPreferences;try{value=desktopNotificationPreferences(draft);}catch{setError('invalid');return;}
  if(!start()||!bridge)return;
  try{
   const result=desktopNotificationPreferences(await bridge.setNotificationPreferences(value));
   if(current()){setSaved(result);setDraft(result);setNotice('saved');}
   const status=await bridge.readNotificationPermission().catch(()=>undefined);
   if(current())setPermission(desktopNotificationPermission(status));
  }catch{if(current()){setUncertain(true);setError('unknown');}}
  finally{finish();}
 }
 async function requestPermission(){
  if(!saved?.enabled||uncertain||typeof window.Notification?.requestPermission!=='function'||!start()||!bridge)return;
  try{
   // Invoke in the user's click before awaiting so the original permission prompt retains its gesture.
   await window.Notification.requestPermission();
   const status=await bridge.readNotificationPermission();
   if(current())setPermission(desktopNotificationPermission(status));
  }catch{if(current()){setPermission('unknown');setError('permission');}}
  finally{finish();}
 }
 if(!bridge)return null;
 const permissionLabels={granted:t('浏览器通知权限已允许','Browser notification permission granted'),denied:t('浏览器通知权限已拒绝','Browser notification permission denied'),default:t('尚未允许浏览器通知','Browser notification permission not granted'),unsupported:t('当前通知接口不可用','Notification interface unavailable'),unknown:t('通知权限未知','Notification permission unknown')};
 const errors:Record<string,string>={read:t('未能读取设备通知设置，请重新读取。','Unable to read device notification settings. Read them again.'),invalid:t('请检查免打扰起止时间和时区，起止时间不能相同。','Check the quiet-hour times and timezone. Start and end must differ.'),unknown:t('保存结果尚未确认。请重新读取已保存设置后再修改，不会自动重发。','The save outcome is unconfirmed. Read the saved settings before editing again; nothing is resent automatically.'),permission:t('无法确认通知权限，请检查系统和应用权限后重新读取。','Unable to confirm notification permission. Check system and application permissions, then read again.')};
 return <section lang={language} tabIndex={-1} id="jot-desktop-notification-settings" data-desktop-notification-settings aria-label={t('此设备的桌面通知','Desktop Notifications on This Device')}>
  <h2>{t('桌面通知设置','Desktop Notification Settings')}</h2>
  <p>{t('此设置保存在当前桌面设备，不更改任务的事件与渠道选择。系统免打扰和操作系统设置仍可能阻止通知。','These settings are stored on this desktop device and do not change a task’s events or channels. System quiet mode and operating system settings may still block notifications.')}</p>
  <p role="status">{permissionLabels[permission]}{busy?t(' · 正在处理…',' · Working…'):''}</p>
  {error&&<p role="alert">{errors[error]}</p>}{notice==='saved'&&<p role="status">{t('主进程已确认保存。','The main process acknowledged the save.')}</p>}
  <form onSubmit={event=>{event.preventDefault();void save();}}>
   <fieldset disabled={!saved||busy||uncertain}><legend>{t('设备偏好','Device Preferences')}</legend>
    <label><input type="checkbox" checked={draft.enabled} onChange={event=>{const enabled=event.currentTarget.checked;setDraft(value=>({...value,enabled}));}}/>{t('允许此设备显示任务通知','Allow Task Notifications on This Device')}</label>
    <label><input type="checkbox" checked={draft.quiet_hours!==null} onChange={event=>{const checked=event.currentTarget.checked;setDraft(value=>({...value,quiet_hours:checked?quietDefaults():null}));}}/>{t('设备免打扰时段','Device Quiet Hours')}</label>
    {draft.quiet_hours&&<div>
     <label>{t('开始时间','Start')} <input type="time" required value={draft.quiet_hours.start} onChange={event=>{const start=event.currentTarget.value;setDraft(value=>({...value,quiet_hours:value.quiet_hours?{...value.quiet_hours,start}:null}));}}/></label>
     <label>{t('结束时间','End')} <input type="time" required value={draft.quiet_hours.end} onChange={event=>{const end=event.currentTarget.value;setDraft(value=>({...value,quiet_hours:value.quiet_hours?{...value.quiet_hours,end}:null}));}}/></label>
     <label>{t('时区','Timezone')} <input required maxLength={100} value={draft.quiet_hours.timezone} onChange={event=>{const timezone=event.currentTarget.value;setDraft(value=>({...value,quiet_hours:value.quiet_hours?{...value.quiet_hours,timezone}:null}));}}/></label>
    </div>}
    <button type="submit">{t('保存设备偏好','Save Device Preferences')}</button>
   </fieldset>
  </form>
  <button type="button" disabled={busy} onClick={()=>void load()}>{t('重新读取已保存设置','Read Saved Settings')}</button>
  <button type="button" disabled={busy||uncertain||!saved?.enabled||permission!=='default'||typeof window.Notification?.requestPermission!=='function'} onClick={()=>void requestPermission()}>{t('请求浏览器通知权限','Request Browser Notification Permission')}</button>
  <button type="button" disabled={busy} onClick={onClose}>{t('关闭通知设置','Close Notification Settings')}</button>
 </section>;
}
