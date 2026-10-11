import React,{useState} from 'react';
import {blankReplyForm,replyModes} from './reply-policy-ui.mjs';
import {request} from '../jot/client';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './AgentsPanel';
import type {ConversationPage} from '../jot/types';

export default function ReplyPolicyFields({value,onChange,workspaceId,projectId,bindingsEnabled,executionEnabled=false}:{value?:Record<string,any>;onChange:(value:Record<string,any>)=>void;workspaceId?:string;projectId?:string;bindingsEnabled:boolean;executionEnabled?:boolean}){
 const [initial]=useState(blankReplyForm),form=value??initial,active=form.mode!=='report';
 const conversations=useResource(signal=>request<ConversationPage>('/conversations?limit=100','GET',undefined,undefined,signal),`reply-target-${workspaceId}-${projectId}`,active&&form.target_kind==='conversation');
 const bindings=useResource(signal=>workbenchApi.channelBindings(signal),'reply-bindings',active&&form.target_kind==='channel'&&bindingsEnabled);
 const set=(key:string,item:string|boolean)=>onChange({...form,[key]:item});
 return <div className="wb-form-grid"><label>回复方式<select aria-label="回复方式" value={form.mode} onChange={event=>set('mode',event.target.value)}>{replyModes.map(([mode,label])=><option key={mode} value={mode}>{label}</option>)}</select></label>{active&&<>
 {!executionEnabled&&<p className="wb-status" role="status">当前仅保存回复规则，实际发送尚未启用；保存后不会自动发出回复。</p>}
 <label>回复目标类型<select aria-label="回复目标类型" value={form.target_kind} onChange={event=>onChange({...form,target_kind:event.target.value,target_id:''})}><option value="conversation">自己的对话</option><option value="channel" disabled={!bindingsEnabled}>已验证通知渠道</option></select></label>
 {form.target_kind==='conversation'?<><ResourceStatus {...conversations} onRetry={conversations.reload}/><label>回复目标对话<select aria-label="回复目标对话" value={form.target_id} onChange={event=>set('target_id',event.target.value)}><option value="">选择同工作区和项目的对话</option>{conversations.data?.items.filter(item=>!item.archived_at&&item.workspace_id===workspaceId&&(item.project_id??null)===(projectId??null)).map(item=><option key={item.conversation_id} value={item.conversation_id}>{item.title||'未命名对话'}</option>)}</select></label></>:<><ResourceStatus {...bindings} onRetry={bindings.reload}/><label>回复目标渠道<select aria-label="回复目标渠道" value={form.target_id} onChange={event=>set('target_id',event.target.value)}><option value="">选择已验证渠道</option>{bindings.data?.items.filter(item=>item.status==='verified').map(item=><option key={item.channel_binding_id} value={item.channel_binding_id}>{item.channel==='email'?'邮箱':'微信'} · {item.channel_binding_id.slice(-6)}</option>)}</select></label></>}
 <label>回复主题<textarea maxLength={2000} value={form.topic} onChange={event=>set('topic',event.target.value)}/></label><label>回复语气<input maxLength={500} value={form.tone} onChange={event=>set('tone',event.target.value)}/></label><label>禁止事项（每行一条）<textarea value={form.forbidden} onChange={event=>set('forbidden',event.target.value)}/></label><p>回复必须带依据；新目标、付费、删除和权限变更仍需另行确认。</p>
 <label>每日回复上限<input type="number" min={1} max={20} value={form.max_per_24_hours} onChange={event=>set('max_per_24_hours',event.target.value)}/></label><label>回复冷却秒数<input type="number" min={60} max={86400} value={form.min_interval_seconds} onChange={event=>set('min_interval_seconds',event.target.value)}/></label><label>回复有效期<input value={form.expires_at} onChange={event=>set('expires_at',event.target.value)} placeholder="2026-10-06T12:00:00+08:00"/><small>含时区，最长30天。</small></label>
 <label className="wb-checkbox"><input type="checkbox" checked={form.quiet_enabled} onChange={event=>set('quiet_enabled',event.target.checked)}/>使用回复静默时段</label>{form.quiet_enabled&&<><label>回复静默开始<input type="time" value={form.quiet_start} onChange={event=>set('quiet_start',event.target.value)}/></label><label>回复静默结束<input type="time" value={form.quiet_end} onChange={event=>set('quiet_end',event.target.value)}/></label><label>回复静默时区<input value={form.quiet_timezone} onChange={event=>set('quiet_timezone',event.target.value)}/></label></>}
 </>}</div>;
}
