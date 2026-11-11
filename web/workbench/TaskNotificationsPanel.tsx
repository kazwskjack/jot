import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {taskUiMessage} from './task-ui-messages';
import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {ChannelBinding,ChannelBindingChallenge,TaskNotificationSettings,UpdateTaskNotifications} from './types';
import type {TaskArtifactDeliverySelection} from './TaskArtifactDeliveryOptions';
import TaskArtifactDeliveryOptions from './TaskArtifactDeliveryOptions';
import {workbenchApi,type ReadonlyNotificationInput} from './client';import {useResource} from './useResource';import {ApiError,taskDraftScope} from '../jot/client';
import {ResourceStatus,Empty} from './PanelStatus';import {notificationRequest,deliveryLabel,channelBindingLabel} from './notification-ui.mjs';
import {canOfferBrowserPushEnrollment,enableBrowserPush,revokeBrowserPush} from './push-notifications.mjs';
import EmailBindingPanel from './EmailBindingPanel';
import {reconcileTaskArtifactDeliverySelection} from './task-artifact-delivery-options.mjs';
export default function TaskNotificationsPanel({taskId,occurrenceId,bindingsEnabled,emailBindingsEnabled=false,wecomBindingsEnabled=bindingsEnabled,webPushBindingsEnabled=false,canEdit,onSaved}:{taskId:string;occurrenceId?:string;bindingsEnabled:boolean;emailBindingsEnabled?:boolean;wecomBindingsEnabled?:boolean;webPushBindingsEnabled?:boolean;canEdit:boolean;onSaved:(restoreFocus:()=>void)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 const ownerScope=taskDraftScope(),identityScope=`${ownerScope}:${taskId}`;
 const canOfferPush=typeof window!=='undefined'&&canOfferBrowserPushEnrollment({webPushBindingsEnabled,secureContext:window.isSecureContext,notification:window.Notification,pushManager:window.PushManager,serviceWorker:typeof navigator!=='undefined'?navigator.serviceWorker:undefined});
 const settings=useResource(signal=>workbenchApi.taskNotifications(taskId,signal),identityScope),bindings=useResource(signal=>workbenchApi.channelBindings(signal),`channel-bindings:${ownerScope}`,bindingsEnabled);
 const [historyCursor,setHistoryCursor]=useState<string|undefined>(undefined);
 const deliveries=useResource(signal=>workbenchApi.taskNotificationHistory(taskId,historyCursor,signal),identityScope+':'+(historyCursor??''));
 useEffect(()=>{setHistoryCursor(undefined);},[identityScope]);
 const [editing,setEditing]=useState(false),[selected,setSelected]=useState<string[]>([]),[artifactSelection,setArtifactSelection]=useState<TaskArtifactDeliverySelection[]>([]),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[challenge,setChallenge]=useState<ChannelBindingChallenge|null>(null),[revoking,setRevoking]=useState<ChannelBinding|null>(null);
 const [interval,setIntervalSeconds]=useState(60),[limit,setLimit]=useState(20),[quiet,setQuiet]=useState(false),[quietStart,setQuietStart]=useState('22:00'),[quietEnd,setQuietEnd]=useState('08:00'),[timezone,setTimezone]=useState('Asia/Hong_Kong');
 const [events,setEvents]=useState<NonNullable<UpdateTaskNotifications['events']>>(['completed']);
 const eventOptions=[['changed','页面有变化'],['completed','任务完成'],['failed','执行失败'],['needs_confirmation','需要你确认']] as const;
 const saveKey=useRef(''),codeKey=useRef(crypto.randomUUID()),pushKey=useRef(crypto.randomUUID()),revokeKey=useRef(''),pending=useRef<ReadonlyNotificationInput|null>(null),pendingScope=useRef(''),identityRef=useRef(identityScope);
 const pendingScopeMismatch=!!pending.current&&pendingScope.current!==identityScope;
 const settingsOpener=useRef<HTMLButtonElement>(null),settingsEditor=useRef<HTMLFormElement>(null),settingsStatus=useRef<HTMLDivElement>(null),editorWasOpen=useRef(false),editorScope=useRef('');
 const returnFocus=useRef<{scope:string;previous:TaskNotificationSettings|null;recoveryFocused?:boolean}|null>(null);
 useLayoutEffect(()=>{
  if(editing&&!editorWasOpen.current){editorScope.current=identityScope;returnFocus.current=null;settingsEditor.current?.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();}
  if(!editing&&editorWasOpen.current)returnFocus.current=editorScope.current===identityScope?{scope:identityScope,previous:settings.data}:null;
  editorWasOpen.current=editing;
  const pending=returnFocus.current;
  if(pending&&pending.scope!==identityScope){returnFocus.current=null;return;}
  if(pending&&settings.loading)pending.recoveryFocused=false;
  if(pending&&!editing&&!settings.loading&&settings.error&&!pending.recoveryFocused){const retry=settingsStatus.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');if(retry){retry.focus();pending.recoveryFocused=true;}}
  if(pending&&!editing&&settings.data!==pending.previous&&!settings.loading&&settingsOpener.current&&!settingsOpener.current.disabled){settingsOpener.current.focus();returnFocus.current=null;}
 },[editing,identityScope,settings.data,settings.loading,settings.error,bindings.loading,busy,canEdit,uncertain]);
 useEffect(()=>{if(identityRef.current!==identityScope){identityRef.current=identityScope;setSelected([]);setArtifactSelection([]);setChallenge(null);setRevoking(null);setNotice('');setError('');codeKey.current=crypto.randomUUID();if(!uncertain)setEditing(false);}},[identityScope,uncertain]);
 useEffect(()=>{if(challenge&&bindings.data?.items.some(binding=>binding.channel_binding_id===challenge.channel_binding_id&&binding.status==='verified'))setChallenge(null);},[challenge,bindings.data]);
 useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!busy){if(challenge)bindings.reload();if(!historyCursor)deliveries.reload();}},5000);return()=>clearInterval(timer);},[challenge,historyCursor,busy]);
 const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'请求未完成');}finally{setBusy(false);}};
 const create=()=>void run(async()=>{const scope=identityRef.current,result=await workbenchApi.createChannelBinding(codeKey.current);if(identityRef.current!==scope)return;setChallenge(result);codeKey.current=crypto.randomUUID();bindings.reload();});
 const enablePush=()=>void run(async()=>{const scope=identityRef.current;await enableBrowserPush({api:workbenchApi,notification:window.Notification,serviceWorker:navigator.serviceWorker,idempotencyKey:pushKey.current,isCurrent:()=>identityRef.current===scope});if(identityRef.current!==scope)return;pushKey.current=crypto.randomUUID();bindings.reload();setNotice('本浏览器通知已绑定；可在下方撤销该渠道。');});
 const revoke=()=>void run(async()=>{let localUnknown=false,localUnsubscribeFailed=false;if(revoking!.channel==='webpush'){const result=await revokeBrowserPush({api:workbenchApi,serviceWorker:typeof navigator!=='undefined'?navigator.serviceWorker:undefined,binding:revoking!,idempotencyKey:revokeKey.current});localUnknown=!result.localSubscriptionMatches;localUnsubscribeFailed=result.localUnsubscribeFailed;}else await workbenchApi.revokeChannelBinding(revoking!,revokeKey.current);setRevoking(null);bindings.reload();deliveries.reload();setNotice(localUnsubscribeFailed?'服务器订阅已撤销，但浏览器本地取消未确认。':localUnknown?'服务器渠道已撤销；本机订阅未匹配或状态未知，因此未取消本机订阅。':'渠道及匹配的本机浏览器订阅已撤销，尚未发送的通知会在发送前复核时停止。');});
 const save=(e:React.FormEvent)=>{e.preventDefault();void run(async()=>{try{
  if(pendingScopeMismatch)throw new Error('账户或任务范围已变化；请切回原范围核对待确认请求。');
  if(!pending.current){
   const draft={expected_version:settings.data!.version,channel_binding_ids:selected,events};
   const currentArtifacts=reconcileTaskArtifactDeliverySelection(artifactSelection,bindings.data?.items??[],draft);
   if(currentArtifacts.length!==artifactSelection.length){setArtifactSelection(currentArtifacts);throw new Error('通知渠道版本已变化，请重新确认文件输出目标。');}
   pending.current=notificationRequest(settings.data!.version,selected,bindings.data?.items??[],{min_interval_seconds:interval,max_per_24_hours:limit,quiet_hours:quiet?{start:quietStart,end:quietEnd,timezone}:null},events,currentArtifacts.map(choice=>choice.channel_binding_id));
   pendingScope.current=identityScope;
  }
  await workbenchApi.saveTaskNotifications(taskId,pending.current!,saveKey.current);pending.current=null;pendingScope.current='';setUncertain(false);setEditing(false);settings.reload();onSaved(()=>settingsOpener.current?.focus());setNotice('任务通知设置已保存，原有结果和消耗保持不变。');
 }catch(e){if(e instanceof ApiError&&e.status<500){pending.current=null;pendingScope.current='';saveKey.current=crypto.randomUUID();setUncertain(false);}else setUncertain(!!pending.current);throw e;}});};
 return <section lang={language} aria-label={message('任务通知与交付')}><h4>{message('通知与交付')}</h4><p className="wb-hint">{message('任务结果先保存在应用内。可选择已验证的微信企业、邮箱或浏览器通知渠道，按变化、完成、失败或待确认状态接收提醒；渠道接收与用户阅读分别判断。')}</p>
 <div ref={settingsStatus}><ResourceStatus {...settings} error={message(settings.error)} onRetry={settings.reload}/></div><ResourceStatus {...bindings} error={message(bindings.error)} onRetry={bindings.reload}/>{error&&<p className="wb-error" role="alert">{message(error)}</p>}{notice&&<p className="wb-status" role="status">{message(notice)}</p>}
 {bindingsEnabled?<>{wecomBindingsEnabled&&<button disabled={busy} onClick={create}>{message(challenge?'重新生成绑定码':'生成微信绑定码')}</button>}{canOfferPush?<button disabled={busy} onClick={enablePush}>{message('启用此浏览器通知')}</button>:webPushBindingsEnabled&&<p className="wb-hint">{message('当前浏览器或连接不支持安全的浏览器通知。')}</p>}{challenge&&<div className="wb-form" aria-label={message('微信绑定验证')}>{challenge.code?<><p>{message('请从自己的微信发送以下完整消息：')}</p><code style={{overflowWrap:'anywhere'}}>/jot-bind {challenge.code}</code><small>{t('有效期至 ','Expires ')}{new Date(challenge.expires_at).toLocaleString()}{t('，只在本页面显示，不保存到浏览器。','; Displayed Only on This Page, Not Saved in Browser Storage.')}</small></>:<p>{message('明文绑定码只显示一次。若初次响应丢失，请重新生成。')}</p>}<button disabled={busy} onClick={bindings.reload}>{message('刷新验证状态')}</button></div>}
 {emailBindingsEnabled&&<EmailBindingPanel bindings={bindings.data?.items??[]} onUpdated={bindings.reload}/>}
 <div className="wb-message-list">{bindings.data?.items.map(binding=><article key={binding.channel_binding_id}><p>{message(channelBindingLabel(binding.channel))}{t('渠道',' Channel')} · {binding.channel_binding_id.slice(-6)} · {message({verified:'已验证',pending:'等待验证',expired:'绑定码已过期',revoked:'已撤销'}[binding.status])}</p>{binding.status==='verified'&&<button className="wb-danger" disabled={busy} onClick={()=>{setRevoking(binding);revokeKey.current=crypto.randomUUID();}}>{message('撤销渠道')}</button>}</article>)}</div></>:<Empty>{message('服务端尚未配置通知渠道绑定入口。')}</Empty>}
 {revoking&&<div className="wb-form" role="group" aria-label={message('确认撤销通知渠道')}><p>{message('撤销此渠道后，尚未发送的任务通知将停止。已经提交的消息无法撤回。')}</p><div className="wb-actions"><button className="wb-danger" disabled={busy} onClick={revoke}>{message('确认撤销')}</button><button disabled={busy} onClick={()=>setRevoking(null)}>{message('取消')}</button></div></div>}
 {!editing?<><p className="wb-status">{settings.data?.channel_binding_ids.length?t(`已选择 ${settings.data.channel_binding_ids.length} 个通知渠道`,`${settings.data.channel_binding_ids.length} Notification Channels Selected`):message('未配置外部通知')}</p>
 {settings.data&&<p className="wb-hint">{t('通知条件：','Notification Events: ')}{eventOptions.filter(([kind])=>settings.data!.events.includes(kind)).map(([,label])=>message(label)).join(t('、',', '))||message('不发送事件提醒')}{t('。','.')}</p>}
 {settings.data&&<p className="wb-hint">{t(`发送间隔至少 ${settings.data.delivery_policy.min_interval_seconds} 秒，同一渠道收件人24小时最多 ${settings.data.delivery_policy.max_per_24_hours} 次。`,`At Least ${settings.data.delivery_policy.min_interval_seconds} Seconds Between Sends; Up to ${settings.data.delivery_policy.max_per_24_hours} Notifications per Channel Recipient in 24 Hours.`)}{settings.data.delivery_policy.quiet_hours&&t(`安静时段 ${settings.data.delivery_policy.quiet_hours.start}–${settings.data.delivery_policy.quiet_hours.end}（${settings.data.delivery_policy.quiet_hours.timezone}）。`,` Quiet Hours ${settings.data.delivery_policy.quiet_hours.start}–${settings.data.delivery_policy.quiet_hours.end} (${settings.data.delivery_policy.quiet_hours.timezone}).`)}</p>}
  <button ref={settingsOpener} disabled={!canEdit||busy||uncertain||pendingScopeMismatch||!settings.data||!!settings.error||bindingsEnabled&&(!bindings.data||bindings.loading||!!bindings.error)} onClick={()=>{
   setEditing(true);setSelected(settings.data!.channel_binding_ids);setEvents(settings.data!.events);const policy=settings.data!.delivery_policy;
   const artifactIds=(settings.data as TaskNotificationSettings&{artifact_delivery_binding_ids?:string[]}).artifact_delivery_binding_ids??[];
   setArtifactSelection(artifactIds.flatMap(id=>{const binding=bindings.data?.items.find(item=>item.channel_binding_id===id&&item.status==='verified'&&item.channel==='wecom');return binding?[{channel_binding_id:id,binding_version:binding.version}]:[];}));
  setIntervalSeconds(policy.min_interval_seconds);setLimit(policy.max_per_24_hours);setQuiet(!!policy.quiet_hours);
  setQuietStart(policy.quiet_hours?.start??'22:00');setQuietEnd(policy.quiet_hours?.end??'08:00');setTimezone(policy.quiet_hours?.timezone??'Asia/Hong_Kong');
   saveKey.current=crypto.randomUUID();pending.current=null;pendingScope.current='';setUncertain(false);
 }}>{message('设置任务通知')}</button></>:<form ref={settingsEditor} className="wb-form" aria-label={message('设置任务通知')} onSubmit={save}>
 <fieldset disabled={busy||uncertain||!canEdit}><legend>{message('通知条件与渠道')}</legend>
  {eventOptions.map(([kind,label])=><label className="wb-checkbox" key={kind}><input type="checkbox" checked={events.includes(kind)} onChange={e=>{setEvents(values=>e.target.checked?[...values,kind]:values.filter(value=>value!==kind));if(kind==='completed'&&!e.target.checked)setArtifactSelection([]);}}/>{message(label)}</label>)}
  {bindings.data?.items.filter(binding=>binding.status==='verified').map(binding=><label className="wb-checkbox" key={binding.channel_binding_id}><input type="checkbox" checked={selected.includes(binding.channel_binding_id)} onChange={e=>{setSelected(ids=>e.target.checked?[...ids,binding.channel_binding_id]:ids.filter(id=>id!==binding.channel_binding_id));if(!e.target.checked)setArtifactSelection(choices=>choices.filter(choice=>choice.channel_binding_id!==binding.channel_binding_id));}}/>{message(channelBindingLabel(binding.channel))}{t('渠道',' Channel')} {binding.channel_binding_id.slice(-6)}</label>)}
  <TaskArtifactDeliveryOptions targets={bindings.data?.items??[]} notificationDraft={{expected_version:settings.data?.version,channel_binding_ids:selected,events}} selected={artifactSelection} scopeEpoch={identityScope} disabled={busy||!canEdit||pendingScopeMismatch} selectionFrozen={uncertain} onChange={setArtifactSelection}/>
  <button type="button" onClick={()=>{setSelected([]);setArtifactSelection([]);}}>{message('仅保留应用内结果')}</button>
 <label>{message('最短发送间隔（秒）')}<input type="number" min="1" max="86400" required value={interval} onChange={e=>setIntervalSeconds(Number(e.target.value))}/></label>
 <label>{message('滚动24小时通知上限')}<input type="number" min="1" max="100" required value={limit} onChange={e=>setLimit(Number(e.target.value))}/></label>
 <label className="wb-checkbox"><input type="checkbox" checked={quiet} onChange={e=>setQuiet(e.target.checked)}/>{message('启用安静时段')}</label>
 {quiet&&<><label>{message('安静开始')}<input type="time" required value={quietStart} onChange={e=>setQuietStart(e.target.value)}/></label><label>{message('恢复通知')}<input type="time" required value={quietEnd} onChange={e=>setQuietEnd(e.target.value)}/></label><label>{message('通知时区')}<input required maxLength={100} value={timezone} onChange={e=>setTimezone(e.target.value)} placeholder="Asia/Hong_Kong"/></label></>}
 </fieldset><small>{message('最多五个渠道；执行中无法修改。通知条件从下次任务派发生效，不补发历史提醒。首次建立页面基准不提醒；结果未知时会保留待核对状态。发送限制跨任务共用，安静时段结束后文本提醒最多五条合为一组摘要，完整结果仍分别保存在工作台。')}</small>
 {uncertain&&<p>{message('请求结果待确认，重试沿用原设置。')}</p>}<div className="wb-actions"><button className="wb-primary" disabled={busy||!canEdit}>{message(uncertain?'重试原设置':'保存通知设置')}</button><button type="button" disabled={busy||uncertain} onClick={()=>{setEditing(false);settings.reload();}}>{message('关闭设置并刷新')}</button></div></form>}
 {!canEdit&&<p className="wb-status">{message('任务执行中或已归档，暂不能修改通知配置；可查看交付或撤销渠道。')}</p>}
 <h4>{message('任务通知历史')}</h4><ResourceStatus {...deliveries} error={message(deliveries.error)} onRetry={deliveries.reload}/>{deliveries.data?.items.map(delivery=><p className="wb-status" key={delivery.delivery_id}>{message(delivery.source==='monitor'?'检查提醒':'执行提醒')}{(delivery.digest_size??1)>1?t(`（${delivery.digest_size}条汇总）`,` (${delivery.digest_size} Notifications Summarized)`):''}{t('：',': ')}{message(deliveryLabel(delivery.status))}{message({TASK_DELIVERY_AUTHORIZATION_REVOKED:'（授权已失效）',TASK_NOTIFICATION_SOURCE_RESOLVED:'（提醒来源已变化）',TASK_NOTIFICATION_QUIET_HOURS:'（等待安静时段结束）',TASK_NOTIFICATION_RATE_LIMIT:'（等待发送额度）'}[delivery.reason??'']??'')}<small> · {new Date(delivery.created_at).toLocaleString()}</small></p>)}{!deliveries.loading&&!deliveries.error&&!deliveries.data?.items.length&&<p className="wb-status">{message('尚无外部通知记录。')}</p>}
 <div className="wb-actions">{historyCursor&&<button disabled={deliveries.loading} onClick={()=>setHistoryCursor(undefined)}>{message('返回最新通知')}</button>}{deliveries.data?.has_more&&deliveries.data.next_cursor&&<button disabled={deliveries.loading} onClick={()=>setHistoryCursor(deliveries.data!.next_cursor!)}>{message('查看较早通知')}</button>}</div>
 </section>;
}
