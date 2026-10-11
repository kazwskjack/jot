import React,{useMemo,useState} from 'react';
import {request,taskDraftScope} from '../jot/client';
import {pathId} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './AgentsPanel';
import ReplyPolicyFields from './ReplyPolicyFields';
import {replyPolicyInput,replyModes} from './reply-policy-ui.mjs';
import {replyFormFromPolicy,ReplyPolicyReceiptStore} from './reply-policy-save.mjs';
import {TaskSaveReceipt} from './task-save.mjs';
type Settings={task_id:string;version:number;policy:any};
export default function TaskReplyPolicyPanel({taskId,workspaceId,projectId,bindingsEnabled,executionEnabled,canEdit,onSaved}:{taskId:string;workspaceId?:string;projectId?:string;bindingsEnabled:boolean;executionEnabled:boolean;canEdit:boolean;onSaved:()=>void}){
 const path=`/persistent-tasks/${pathId(taskId)}/reply-policy`,settings=useResource(signal=>request<Settings>(path,'GET',undefined,undefined,signal),taskId);
 const recovery=useMemo(()=>{try{return {receipt:new TaskSaveReceipt(()=>crypto.randomUUID(),new ReplyPolicyReceiptStore(sessionStorage,taskDraftScope(),taskId)),error:''};}catch(error){return {receipt:null,error:error instanceof Error?error.message:'无法读取回复保存回执'};}},[taskId]);
 const [form,setForm]=useState<Record<string,any>|null>(null),[preview,setPreview]=useState<any>(null),[editVersion,setEditVersion]=useState<number|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState(Boolean(recovery.receipt?.pending));
 const save=async()=>{
  if(busy||!recovery.receipt)return;setBusy(true);setError('');
  try{if(!recovery.receipt.pending&&(!canEdit||!preview||!settings.data))throw new Error('任务当前不可修改回复规则');
   await recovery.receipt.submit(request,path,'PATCH',preview??{});setForm(null);setPreview(null);settings.reload();onSaved();setNotice('回复规则已保存，执行和通知配置保持不变。');
  }catch(error){setError(error instanceof Error?error.message:'保存未完成');if(!recovery.receipt.pending){setForm(null);setPreview(null);settings.reload();}}
  finally{setPending(recovery.receipt.pending);setBusy(false);}
 };
 const policy=preview?.policy??settings.data?.policy;
 return <section aria-label="任务回复规则"><h4>回复规则</h4><p className="wb-hint">回复与通知分别配置。规则只允许既有角色权限内的操作；修改按独立版本校验。</p>
 {!executionEnabled&&<p role="status">实际回复尚未启用；仅保存规则不会发送消息。</p>}
 <ResourceStatus {...settings} onRetry={settings.reload}/>{(error||recovery.error)&&<p role="alert" className="wb-error">{error||recovery.error}</p>}{notice&&<p role="status">{notice}</p>}
 {policy&&<dl><dt>回复方式</dt><dd>{replyModes.find(([mode])=>mode===policy.mode)?.[1]}</dd>{policy.mode!=='report'&&<><dt>目标</dt><dd style={{overflowWrap:'anywhere'}}>{policy.target.conversation_id??policy.target.channel_binding_id}</dd><dt>主题与语气</dt><dd>{policy.direction.topic} · {policy.direction.tone}</dd><dt>限制</dt><dd>24小时最多{policy.limits.max_per_24_hours}次，至少间隔{policy.limits.min_interval_seconds}秒；有效至{policy.limits.expires_at}。</dd><dt>静默时段</dt><dd>{policy.quiet_hours?`${policy.quiet_hours.start}–${policy.quiet_hours.end} · ${policy.quiet_hours.timezone}`:'无'}</dd><dt>禁止事项</dt><dd>{policy.direction.forbidden.join('；')||'无额外事项'}。回复必须有证据。</dd></>}</dl>}
 {pending?<><p role="status">上次保存结果待确认，恢复页面不会自动发送。重试使用原规则、原版本和原请求键。</p><button disabled={busy||!!recovery.error} onClick={()=>void save()}>重试原回复规则</button></>:form?<form className="wb-form" aria-label="修改任务回复规则" onSubmit={event=>{event.preventDefault();if(preview){void save();return;}try{setPreview({expected_version:editVersion,policy:replyPolicyInput(form)});setError('');}catch(error){setError(error instanceof Error?error.message:'请检查回复规则');}}}>
 {!preview&&<fieldset disabled={busy||!canEdit}><ReplyPolicyFields value={form} onChange={setForm} workspaceId={workspaceId} projectId={projectId} bindingsEnabled={bindingsEnabled} executionEnabled={executionEnabled}/></fieldset>}
 {preview&&<p>请确认上方规则。选择“仅整理结果”会撤销后续回复授权，不撤回已发送内容。</p>}
 <button className="wb-primary" disabled={busy||!canEdit||!!recovery.error}>{preview?'确认保存回复规则':'检查回复规则'}</button>{preview&&<button type="button" disabled={busy} onClick={()=>setPreview(null)}>返回修改</button>}<button type="button" disabled={busy} onClick={()=>{setForm(null);setPreview(null);setError('');}}>取消修改</button>
 </form>:<button disabled={busy||!canEdit||!settings.data||settings.loading||!!settings.error||!!recovery.error} onClick={()=>{setEditVersion(settings.data!.version);setForm(replyFormFromPolicy(settings.data!.policy));setPreview(null);setError('');}}>修改回复规则</button>}
 {!canEdit&&<p className="wb-hint">任务运行中或已归档，暂不能修改；服务器保存时还会复核。</p>}
 </section>;
}
