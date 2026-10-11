import React,{useEffect,useRef,useState} from 'react';
import type {Agent,Task,Occurrence,CreateTaskDelegation} from './types';
import {ApiError} from '../jot/client';
import type {Run} from '../jot/types';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus,Empty} from './AgentsPanel';
import {taskMemberCanSend,taskMemberRequest,taskDelegationRequest} from './task-member-ui.mjs';
const labels:Record<string,string>={pending:'等待执行',processing:'正在协作',completed:'回复已完成',delivered:'已送达',failed:'执行失败',outcome_unknown:'结果待核对',task_revoked:'任务已暂停或结束',budget_exhausted:'额度不足',recipient_deleted:'接收角色已删除',sender_deleted:'发起角色已删除'};
export default function TaskMembersPanel({task,occurrence,run,agents,enabled}:{task:Task;occurrence:Occurrence;run:Run|null;agents:Agent[];enabled:boolean}){
 const lead=agents.find(a=>a.agent_id===task.agent_id),members=agents.filter(a=>lead&&a.agent_id!==lead.agent_id&&a.status==='active'&&a.project_id===lead.project_id&&a.workspace_id===lead.workspace_id);
 const [recipient,setRecipient]=useState(members[0]?.agent_id??''),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false);
 const [subtaskId,setSubtaskId]=useState('');
 const pending=useRef<{kind:'message';input:ReturnType<typeof taskMemberRequest>}|{kind:'delegation';input:CreateTaskDelegation}|null>(null);
 const steps=useResource(signal=>workbenchApi.subtasks(task.task_id,signal),task.task_id);
 const history=useResource(signal=>workbenchApi.taskMessages(lead!.workspace_id,occurrence.occurrence_id,signal),occurrence.occurrence_id,!!lead);
 const canSend=taskMemberCanSend(task,occurrence,run,enabled);
 useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!busy){history.reload();steps.reload();}},10000);return()=>clearInterval(timer);},[busy,occurrence.occurrence_id]);
 async function send(e:React.FormEvent){e.preventDefault();if(busy||!canSend||!lead)return;setBusy(true);setError('');try{
  pending.current??=subtaskId?{kind:'delegation',input:taskDelegationRequest(lead,members.find(a=>a.agent_id===recipient),occurrence,steps.data?.items.find(s=>s.subtask_id===subtaskId),crypto.randomUUID())}
    :{kind:'message',input:taskMemberRequest(lead,members.find(a=>a.agent_id===recipient),occurrence.run_id!,text,crypto.randomUUID())};
  if(pending.current.kind==='delegation')await workbenchApi.delegateTask(task.task_id,pending.current.input);
  else await workbenchApi.sendMessage(lead.workspace_id,pending.current.input,pending.current.input.client_message_id);
  pending.current=null;setUncertain(false);setText('');setSubtaskId('');history.reload();steps.reload();
 }catch(e){setError(e instanceof Error?e.message:'请求未完成');
  if(e instanceof ApiError&&pending.current?.kind==='delegation'&&['VERSION_CONFLICT','TASK_ASSIGNMENT_REVOKED','DEPENDENCY_NOT_COMPLETED','DEPENDENCY_EVIDENCE_UNVERIFIED'].includes(e.message)){pending.current=null;steps.reload();}
  setUncertain(!!pending.current);}finally{setBusy(false);}}
 return <section aria-label="本次任务成员协作"><h4>成员协作</h4><p className="wb-hint">由执行角色发起一次协作，沿用本次任务额度与共享工作区。成员回复作为参考，最终结果仍由任务执行角色负责。</p>
 <form className="wb-form" onSubmit={send}><label>接收角色<select value={recipient} disabled={busy||uncertain||!canSend} onChange={e=>setRecipient(e.target.value)}><option value="">选择角色</option>{members.map(a=><option key={a.agent_id} value={a.agent_id}>{a.name}</option>)}</select></label>
 <label>协作方式<select value={subtaskId} disabled={busy||uncertain||!canSend} onChange={e=>setSubtaskId(e.target.value)}><option value="">成员交流</option>{steps.data?.items.filter(s=>['pending','blocked'].includes(s.status)).map(s=><option key={s.subtask_id} value={s.subtask_id}>执行子任务：{s.title}</option>)}</select></label>
 {subtaskId?<p className="wb-hint">按现有子任务的验收要求派工，冻结当前版本；成员交回材料，由主控核验并更新任务账本。最多两个活动成员，其余排队。</p>:<label>协作要求<textarea rows={3} maxLength={12000} value={text} disabled={busy||uncertain||!canSend} onChange={e=>setText(e.target.value)}/></label>}
 <ResourceStatus {...steps} onRetry={steps.reload}/>
 {uncertain&&<p role="status">请求结果尚未确认；重试沿用原请求，不会重新派发。请先核对下方消息记录。</p>}
 {!canSend&&<p className="wb-status">当前执行暂不能发起新协作，已有记录仍可查看。</p>}
 {error&&<p className="wb-error" role="alert">{error}</p>}<button className="wb-primary" disabled={busy||!canSend||!recipient||(!subtaskId&&!text.trim())}>{busy?'正在提交…':uncertain?'重试原请求':subtaskId?'派发子任务':'发起协作'}</button></form>
 <ResourceStatus {...history} onRetry={history.reload}/>{!history.loading&&!history.error&&!history.data?.items.length&&<Empty>本次执行尚无成员交流。</Empty>}
 <div className="wb-message-list">{history.data?.items.map(message=><article key={message.message_id}><small>{agents.find(a=>a.agent_id===message.sender_agent_id)?.name??'已移除角色'} → {agents.find(a=>a.agent_id===message.recipient_agent_id)?.name??'已移除角色'} · {labels[message.status??'']??'状态待核对'}</small><p>{message.text}</p></article>)}</div></section>;
}
