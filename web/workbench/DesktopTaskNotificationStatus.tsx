import React,{useLayoutEffect,useRef} from 'react';
import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import type {useDesktopTaskNotifications} from './useDesktopTaskNotifications';

type Props={feed:ReturnType<typeof useDesktopTaskNotifications>;onRestoreFocus:()=>void;onOpen:(identity:{task_id:string;occurrence_id:string})=>void};
export default function DesktopTaskNotificationStatus({feed,onOpen,onRestoreFocus}:Props){
 const language=useApplicationLanguage(),t=useApplicationText(),region=useRef<HTMLElement>(null),wasEnding=useRef(feed.endWaiting);
 useLayoutEffect(()=>{
  const active=document.activeElement;
  if(wasEnding.current&&!feed.endWaiting&&(active===document.body||region.current?.contains(active))){if(region.current)region.current.focus();else onRestoreFocus();}
  wasEnding.current=feed.endWaiting;
 },[feed.endWaiting,onRestoreFocus]);
 if(feed.state!=='blocked'&&feed.state!=='unsupported'&&!feed.unknown&&feed.pending<64&&!feed.ended.length&&!feed.endWaiting)return null;
 return <aside ref={region} tabIndex={-1} lang={language} aria-label={t('桌面通知状态','Desktop Notification Status')}>
  <p role="status">{feed.state==='unsupported'?t('此桌面版本暂不支持任务通知，设备偏好仍可查看。','This desktop version does not support task notifications. Device preferences remain available.'):feed.state==='blocked'?t('桌面通知暂时中断，原通知记录已保留。','Desktop notifications are interrupted. Original notification records are retained.'):feed.unknown>0?t(`有 ${feed.unknown} 条通知结果尚未确认，不会自动重发。`,`${feed.unknown} notification outcomes are unconfirmed and will not be resent automatically.`):feed.pending>=64?t('通知队列已满，原记录和未读位置已保留。','The notification queue is full. Original records and unread position are retained.'):t('已结束等待的通知仍保留未知结果。','Notifications whose waits have ended retain their unknown outcomes.')}</p>
  <button type="button" onClick={feed.retry}>{t('重新核对通知','Recheck Notifications')}</button>
  {feed.unknown>0&&<>
   <button type="button" disabled={feed.endWaiting||feed.historyAvailable<1} onClick={feed.endWait}>{feed.endWaiting?t('正在保留结束等待记录…','Retaining End-Wait Records…'):feed.unknown>feed.historyAvailable?t(`保留未知并结束前 ${feed.historyAvailable} 条等待`,`Preserve Unknown and End First ${feed.historyAvailable} Waits`):t('保留未知并结束等待','Preserve Unknown and End Wait')}</button>
   <p>{t('结束等待不会重发通知，也不代表通知已显示或任务已停止；会尝试撤销原通知。','Ending the wait does not resend the notification or mean it was shown or the task stopped; withdrawal of the original notification will be attempted.')}</p>
   {feed.unknown>feed.historyAvailable&&!feed.endWaiting&&<p role="status">{t('结束等待历史空间不足，尚未处理的原记录仍保留，不会覆盖旧记录。','End-wait history has insufficient space. Unprocessed original records are retained; old records will not be overwritten.')}</p>}
  </>}
  {feed.ended.length>0&&<details><summary>{t(`已结束等待 · ${feed.ended.length} 条未知记录`,`Ended Waits · ${feed.ended.length} Unknown Records`)}</summary>
   <p>{t('最多保留64条。记录不表示已发送、失败或取消成功。','Up to 64 records are retained. A record does not indicate confirmed sending, failure or successful cancellation.')}</p>
   <ul>{feed.ended.map(identity=><li key={identity.event_id} style={{overflowWrap:'anywhere'}}><code>{identity.task_id}</code> · <code>{identity.occurrence_id}</code>{' '}<button type="button" onClick={()=>onOpen({task_id:identity.task_id,occurrence_id:identity.occurrence_id})}>{t('查看原任务','View Original Task')}</button><details><summary>{t('原事件身份','Original Event Identity')}</summary><code>{identity.event_id}</code></details></li>)}</ul>
  </details>}
 </aside>;
}
