import React,{useEffect,useRef,useState} from 'react';
import type {ChannelBinding,ChannelBindingChallenge,UpdateTaskNotifications} from './types';
import {workbenchApi} from './client';import {useResource} from './useResource';import {ApiError} from '../jot/client';
import {ResourceStatus,Empty} from './AgentsPanel';import {notificationRequest,deliveryLabel} from './notification-ui.mjs';
import EmailBindingPanel from './EmailBindingPanel';
export default function TaskNotificationsPanel({taskId,occurrenceId,bindingsEnabled,emailBindingsEnabled=false,wecomBindingsEnabled=bindingsEnabled,canEdit,onSaved}:{taskId:string;occurrenceId?:string;bindingsEnabled:boolean;emailBindingsEnabled?:boolean;wecomBindingsEnabled?:boolean;canEdit:boolean;onSaved:()=>void}){
 const settings=useResource(signal=>workbenchApi.taskNotifications(taskId,signal),taskId),bindings=useResource(signal=>workbenchApi.channelBindings(signal),'channel-bindings',bindingsEnabled);
 const [historyCursor,setHistoryCursor]=useState<string|undefined>(undefined);
 const deliveries=useResource(signal=>workbenchApi.taskNotificationHistory(taskId,historyCursor,signal),taskId+':'+(historyCursor??''));
 useEffect(()=>{setHistoryCursor(undefined);},[taskId]);
 const [editing,setEditing]=useState(false),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[challenge,setChallenge]=useState<ChannelBindingChallenge|null>(null),[revoking,setRevoking]=useState<ChannelBinding|null>(null);
 const [interval,setIntervalSeconds]=useState(60),[limit,setLimit]=useState(20),[quiet,setQuiet]=useState(false),[quietStart,setQuietStart]=useState('22:00'),[quietEnd,setQuietEnd]=useState('08:00'),[timezone,setTimezone]=useState('Asia/Hong_Kong');
 const [events,setEvents]=useState<NonNullable<UpdateTaskNotifications['events']>>(['completed']);
 const eventOptions=[['changed','页面有变化'],['completed','任务完成'],['failed','执行失败'],['needs_confirmation','需要你确认']] as const;
 const saveKey=useRef(''),codeKey=useRef(crypto.randomUUID()),revokeKey=useRef(''),pending=useRef<UpdateTaskNotifications|null>(null);
 useEffect(()=>{if(challenge&&bindings.data?.items.some(binding=>binding.channel_binding_id===challenge.channel_binding_id&&binding.status==='verified'))setChallenge(null);},[challenge,bindings.data]);
 useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!busy){if(challenge)bindings.reload();if(!historyCursor)deliveries.reload();}},5000);return()=>clearInterval(timer);},[challenge,historyCursor,busy]);
 const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError('');try{await action();}catch(e){setError(e instanceof Error?e.message:'请求未完成');}finally{setBusy(false);}};
 const create=()=>void run(async()=>{const result=await workbenchApi.createChannelBinding(codeKey.current);setChallenge(result);codeKey.current=crypto.randomUUID();bindings.reload();});
 const revoke=()=>void run(async()=>{await workbenchApi.revokeChannelBinding(revoking!,revokeKey.current);setRevoking(null);bindings.reload();deliveries.reload();setNotice('渠道已撤销，尚未发送的通知会在发送前复核时停止。');});
 const save=(e:React.FormEvent)=>{e.preventDefault();void run(async()=>{try{
  pending.current??=notificationRequest(settings.data!.version,selected,bindings.data?.items??[],{min_interval_seconds:interval,max_per_24_hours:limit,quiet_hours:quiet?{start:quietStart,end:quietEnd,timezone}:null},events);
  await workbenchApi.saveTaskNotifications(taskId,pending.current!,saveKey.current);pending.current=null;setUncertain(false);setEditing(false);settings.reload();onSaved();setNotice('任务通知设置已保存，原有结果和消耗保持不变。');
 }catch(e){if(e instanceof ApiError&&e.status<500){pending.current=null;saveKey.current=crypto.randomUUID();setUncertain(false);}else setUncertain(!!pending.current);throw e;}});};
 return <section aria-label="任务通知与交付"><h4>通知与交付</h4><p className="wb-hint">任务结果先保存在应用内。可选择已验证的微信或邮箱渠道，按变化、完成、失败或待确认状态接收提醒；渠道接收与用户阅读分别判断。</p>
 <ResourceStatus {...settings} onRetry={settings.reload}/><ResourceStatus {...bindings} onRetry={bindings.reload}/>{error&&<p className="wb-error" role="alert">{error}</p>}{notice&&<p className="wb-status" role="status">{notice}</p>}
 {bindingsEnabled?<>{wecomBindingsEnabled&&<button disabled={busy} onClick={create}>{challenge?'重新生成绑定码':'生成微信绑定码'}</button>}{challenge&&<div className="wb-form" aria-label="微信绑定验证">{challenge.code?<><p>请从自己的微信发送以下完整消息：</p><code style={{overflowWrap:'anywhere'}}>/jot-bind {challenge.code}</code><small>有效期至 {new Date(challenge.expires_at).toLocaleString()}，只在本页面显示，不保存到浏览器。</small></>:<p>明文绑定码只显示一次。若初次响应丢失，请重新生成。</p>}<button disabled={busy} onClick={bindings.reload}>刷新验证状态</button></div>}
 {emailBindingsEnabled&&<EmailBindingPanel bindings={bindings.data?.items??[]} onUpdated={bindings.reload}/>}
 <div className="wb-message-list">{bindings.data?.items.map(binding=><article key={binding.channel_binding_id}><p>{binding.channel==='email'?'邮箱':'微信'}渠道 · {binding.channel_binding_id.slice(-6)} · {{verified:'已验证',pending:'等待验证',expired:'绑定码已过期',revoked:'已撤销'}[binding.status]}</p>{binding.status==='verified'&&<button className="wb-danger" disabled={busy} onClick={()=>{setRevoking(binding);revokeKey.current=crypto.randomUUID();}}>撤销渠道</button>}</article>)}</div></>:<Empty>服务端尚未配置通知渠道绑定入口。</Empty>}
 {revoking&&<div className="wb-form" role="group" aria-label="确认撤销通知渠道"><p>撤销此渠道后，尚未发送的任务通知将停止。已经提交的消息无法撤回。</p><div className="wb-actions"><button className="wb-danger" disabled={busy} onClick={revoke}>确认撤销</button><button disabled={busy} onClick={()=>setRevoking(null)}>取消</button></div></div>}
 {!editing?<><p className="wb-status">{settings.data?.channel_binding_ids.length?`已选择 ${settings.data.channel_binding_ids.length} 个通知渠道`:'未配置外部通知'}</p>
 {settings.data&&<p className="wb-hint">通知条件：{eventOptions.filter(([kind])=>settings.data!.events.includes(kind)).map(([,label])=>label).join('、')||'不发送事件提醒'}。</p>}
 {settings.data&&<p className="wb-hint">发送间隔至少 {settings.data.delivery_policy.min_interval_seconds} 秒，同一渠道收件人24小时最多 {settings.data.delivery_policy.max_per_24_hours} 次。{settings.data.delivery_policy.quiet_hours&&`安静时段 ${settings.data.delivery_policy.quiet_hours.start}–${settings.data.delivery_policy.quiet_hours.end}（${settings.data.delivery_policy.quiet_hours.timezone}）。`}</p>}
 <button disabled={!canEdit||busy||!settings.data||!!settings.error} onClick={()=>{
  setEditing(true);setSelected(settings.data!.channel_binding_ids);setEvents(settings.data!.events);const policy=settings.data!.delivery_policy;
  setIntervalSeconds(policy.min_interval_seconds);setLimit(policy.max_per_24_hours);setQuiet(!!policy.quiet_hours);
  setQuietStart(policy.quiet_hours?.start??'22:00');setQuietEnd(policy.quiet_hours?.end??'08:00');setTimezone(policy.quiet_hours?.timezone??'Asia/Hong_Kong');
  saveKey.current=crypto.randomUUID();pending.current=null;setUncertain(false);
 }}>设置任务通知</button></>:<form className="wb-form" aria-label="设置任务通知" onSubmit={save}>
 <fieldset disabled={busy||uncertain||!canEdit}><legend>通知条件与渠道</legend>
 {eventOptions.map(([kind,label])=><label className="wb-checkbox" key={kind}><input type="checkbox" checked={events.includes(kind)} onChange={e=>setEvents(values=>e.target.checked?[...values,kind]:values.filter(value=>value!==kind))}/>{label}</label>)}
 {bindings.data?.items.filter(binding=>binding.status==='verified').map(binding=><label className="wb-checkbox" key={binding.channel_binding_id}><input type="checkbox" checked={selected.includes(binding.channel_binding_id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,binding.channel_binding_id]:ids.filter(id=>id!==binding.channel_binding_id))}/>{binding.channel==='email'?'邮箱':'微信'}渠道 {binding.channel_binding_id.slice(-6)}</label>)}
 <button type="button" onClick={()=>setSelected([])}>仅保留应用内结果</button>
 <label>最短发送间隔（秒）<input type="number" min="1" max="86400" required value={interval} onChange={e=>setIntervalSeconds(Number(e.target.value))}/></label>
 <label>滚动24小时通知上限<input type="number" min="1" max="100" required value={limit} onChange={e=>setLimit(Number(e.target.value))}/></label>
 <label className="wb-checkbox"><input type="checkbox" checked={quiet} onChange={e=>setQuiet(e.target.checked)}/>启用安静时段</label>
 {quiet&&<><label>安静开始<input type="time" required value={quietStart} onChange={e=>setQuietStart(e.target.value)}/></label><label>恢复通知<input type="time" required value={quietEnd} onChange={e=>setQuietEnd(e.target.value)}/></label><label>通知时区<input required maxLength={100} value={timezone} onChange={e=>setTimezone(e.target.value)} placeholder="Asia/Hong_Kong"/></label></>}
 </fieldset><small>最多五个渠道；执行中无法修改。通知条件从下次任务派发生效，不补发历史提醒。首次建立页面基准不提醒；结果未知时会保留待核对状态。发送限制跨任务共用，安静时段结束后文本提醒最多五条合为一组摘要，完整结果仍分别保存在工作台。</small>
 {uncertain&&<p>请求结果待确认，重试沿用原设置。</p>}<div className="wb-actions"><button className="wb-primary" disabled={busy||!canEdit}>{uncertain?'重试原设置':'保存通知设置'}</button><button type="button" disabled={busy||uncertain} onClick={()=>{setEditing(false);settings.reload();}}>关闭设置并刷新</button></div></form>}
 {!canEdit&&<p className="wb-status">任务执行中或已归档，暂不能修改通知配置；可查看交付或撤销渠道。</p>}
 <h4>任务通知历史</h4><ResourceStatus {...deliveries} onRetry={deliveries.reload}/>{deliveries.data?.items.map(delivery=><p className="wb-status" key={delivery.delivery_id}>{delivery.source==='monitor'?'检查提醒':'执行提醒'}{(delivery.digest_size??1)>1?`（${delivery.digest_size}条汇总）`:''}：{deliveryLabel(delivery.status)}{{TASK_DELIVERY_AUTHORIZATION_REVOKED:'（授权已失效）',TASK_NOTIFICATION_SOURCE_RESOLVED:'（提醒来源已变化）',TASK_NOTIFICATION_QUIET_HOURS:'（等待安静时段结束）',TASK_NOTIFICATION_RATE_LIMIT:'（等待发送额度）'}[delivery.reason??'']??''}<small> · {new Date(delivery.created_at).toLocaleString()}</small></p>)}{!deliveries.loading&&!deliveries.error&&!deliveries.data?.items.length&&<p className="wb-status">尚无外部通知记录。</p>}
 <div className="wb-actions">{historyCursor&&<button disabled={deliveries.loading} onClick={()=>setHistoryCursor(undefined)}>返回最新通知</button>}{deliveries.data?.has_more&&deliveries.data.next_cursor&&<button disabled={deliveries.loading} onClick={()=>setHistoryCursor(deliveries.data!.next_cursor!)}>查看较早通知</button>}</div>
 </section>;
}
