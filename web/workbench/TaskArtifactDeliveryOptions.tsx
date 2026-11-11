import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {taskUiMessage} from './task-ui-messages';
import React,{useEffect,useId,useRef} from 'react';
import type {ChannelBinding} from './types';
import {reconcileTaskArtifactDeliverySelection,taskArtifactDeliveryAvailability,updateTaskArtifactDeliverySelection} from './task-artifact-delivery-options.mjs';

export type TaskArtifactDeliveryTarget=Pick<ChannelBinding,'channel_binding_id'|'channel'|'status'|'version'>;
export type TaskArtifactDeliverySelection={channel_binding_id:string;binding_version:number};
export type TaskArtifactDeliveryNotificationDraft={expected_version?:number;channel_binding_ids:readonly string[];events:readonly string[]};
export type TaskArtifactDeliveryOptionsProps={
 targets:readonly TaskArtifactDeliveryTarget[];
 notificationDraft:TaskArtifactDeliveryNotificationDraft;
 selected:readonly TaskArtifactDeliverySelection[];
 scopeEpoch:string;
 disabled?:boolean;
 selectionFrozen?:boolean;
 onChange:(next:TaskArtifactDeliverySelection[])=>void;
};

const channelLabels:Record<string,string>={email:'邮箱',wecom:'微信',webpush:'浏览器通知'};
function reasonText(target:TaskArtifactDeliveryTarget,reason:string|null){
 if(reason==='notification-not-selected')return '请先将此渠道加入本任务通知。';
 if(reason==='binding-version-unavailable')return '渠道版本尚未确认，请刷新通知设置后再选择文件输出。';
 if(reason==='unverified')return '此渠道尚未验证，暂不能发送文件输出。';
 if(reason==='completed-disabled')return '任务完成提醒已关闭，暂不能选择文件输出。';
 return '此渠道暂不支持文件输出。';
}
function sameSelection(left:readonly TaskArtifactDeliverySelection[],right:readonly TaskArtifactDeliverySelection[]){
 return left.length===right.length&&left.every((choice,index)=>choice.channel_binding_id===right[index]?.channel_binding_id&&choice.binding_version===right[index]?.binding_version);
}

export default function TaskArtifactDeliveryOptions({targets,notificationDraft,selected,scopeEpoch,disabled=false,selectionFrozen=false,onChange}:TaskArtifactDeliveryOptionsProps){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 const scope=useRef({epoch:scopeEpoch,settingsVersion:notificationDraft.expected_version}),id=useId(),completedEnabled=notificationDraft.events.includes('completed');
 const normalized=reconcileTaskArtifactDeliverySelection(selected,targets,notificationDraft),scopeChanged=scope.current.epoch!==scopeEpoch||scope.current.settingsVersion!==notificationDraft.expected_version;
 useEffect(()=>{
  if(scopeChanged){if(!selectionFrozen){scope.current={epoch:scopeEpoch,settingsVersion:notificationDraft.expected_version};if(selected.length)onChange([]);}return;}
  if(selectionFrozen)return;
  if(!sameSelection(selected,normalized))onChange(normalized);
 },[normalized,onChange,scopeChanged,scopeEpoch,selected,selectionFrozen]);
 const visibleSelection=scopeChanged?[]:normalized;
 return <fieldset lang={language} className="wb-form" aria-label={message('本任务文件输出')} disabled={disabled||selectionFrozen}>
  <legend>{message('任务文件输出')}</legend>
  <p className="wb-hint">{message('可逐个选择已验证且支持文件输出的通知渠道。只有任务完成提醒开启时，文件选择才可用；开启文本提醒不会自动同意发送文件。')}</p>
  {!completedEnabled&&<p className="wb-status" role="status">{message('任务完成提醒已关闭。开启后可单独选择文件输出。')}</p>}
  {!targets.length&&<p className="wb-status" role="status">{message('当前没有可配置的通知渠道。')}</p>}
  {targets.map((target,index)=>{
   const availability=taskArtifactDeliveryAvailability(target,notificationDraft),reasonId=`${id}-reason-${index}`,checked=visibleSelection.some(choice=>choice.channel_binding_id===target.channel_binding_id&&choice.binding_version===target.version);
   const label=target.channel_binding_id.slice(-6)||message('未知渠道'),channel=message(channelLabels[target.channel]??'渠道');
   return <div key={target.channel_binding_id}>
    <label className="wb-checkbox"><input type="checkbox" checked={checked} disabled={!availability.available} aria-describedby={!availability.available?reasonId:undefined} onChange={event=>onChange(updateTaskArtifactDeliverySelection(visibleSelection,targets,notificationDraft,target.channel_binding_id,event.target.checked))}/>{t(`发送本任务已审核的文件输出到${label}（${channel}）`,`Send This Task’s Reviewed File Output to ${label} (${channel})`)}</label>
    {!availability.available&&<small className="wb-hint" id={reasonId}>{message(reasonText(target,availability.reason))}</small>}
   </div>;
  })}
 </fieldset>;
}
