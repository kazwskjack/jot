import React,{useEffect,useRef,useState} from 'react';
import type {Agent,Task,SaveTaskCollaboration} from './types';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './AgentsPanel';
import {ApiError} from '../jot/client';
import {eligibleCollaborationTeams,collaborationRequest} from './task-collaboration-ui.mjs';

export default function TaskCollaborationPanel({task,agents}:{task:Task;agents:Agent[]}){
 const policy=useResource(signal=>workbenchApi.taskCollaboration(task.task_id,signal),task.task_id);
 const teams=useResource(signal=>workbenchApi.teams(signal),task.task_id);
 const lead=agents.find(a=>a.agent_id===task.agent_id),available=eligibleCollaborationTeams(lead,teams.data?.items??[]);
 const [enabled,setEnabled]=useState(false),[teamId,setTeamId]=useState(''),[members,setMembers]=useState<string[]>([]),[maximum,setMaximum]=useState(5),[active,setActive]=useState(1);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[saved,setSaved]=useState(false);
 const pending=useRef<{input:SaveTaskCollaboration;key:string}|null>(null);
 useEffect(()=>{if(!policy.data||pending.current)return;setEnabled(policy.data.enabled);setTeamId(policy.data.team_id??'');setMembers(policy.data.member_ids);setMaximum(policy.data.max_delegations||5);setActive(policy.data.max_active||1);},[policy.data]);
 const selected=available.find(t=>t.team_id===teamId),choices=agents.filter(a=>selected?.member_ids?.includes(a.agent_id)&&a.agent_id!==lead?.agent_id&&a.status==='active');
 const disabled=busy||uncertain||policy.loading||teams.loading||!!policy.error||!!teams.error||!policy.data;
 async function save(e:React.FormEvent){e.preventDefault();if(busy||!policy.data)return;setBusy(true);setError('');setSaved(false);
  try{
   pending.current??={input:collaborationRequest(policy.data.version,enabled,lead,selected,agents,members,maximum,active) as SaveTaskCollaboration,key:crypto.randomUUID()};
   await workbenchApi.saveTaskCollaboration(task.task_id,pending.current.input,pending.current.key);
   pending.current=null;setUncertain(false);setSaved(true);policy.reload();
  }catch(e){setError(e instanceof Error?e.message:'授权未保存');
   if(e instanceof ApiError&&e.status<500){pending.current=null;setUncertain(false);policy.reload();teams.reload();}
   else setUncertain(!!pending.current);
  }finally{setBusy(false);}
 }
 return <section aria-label="主控自动派工授权"><h4>自动派工</h4><p className="wb-hint">允许主控从现有子任务中选择成员协作。成员共享工作区和任务额度，只交回材料，由主控核验并回答。</p>
 <ResourceStatus {...policy} onRetry={policy.reload}/><ResourceStatus {...teams} onRetry={teams.reload}/>
 <form className="wb-form" onSubmit={save}>
 <label className="wb-checkbox"><input type="checkbox" checked={enabled} disabled={disabled} onChange={e=>{setEnabled(e.target.checked);setSaved(false);}}/>允许主控自动派工</label>
 {enabled&&<><label>协作团队<select value={teamId} disabled={disabled} onChange={e=>{setTeamId(e.target.value);setMembers([]);}}><option value="">选择包含主控的团队</option>{available.map(t=><option key={t.team_id} value={t.team_id}>{t.name}</option>)}</select></label>
 {!available.length&&<p className="wb-hint">请先创建包含任务主控的同项目团队。</p>}
 <fieldset disabled={disabled}><legend>授权成员（最多两名）</legend>{choices.map(a=><label className="wb-checkbox" key={a.agent_id}><input type="checkbox" checked={members.includes(a.agent_id)} disabled={!members.includes(a.agent_id)&&members.length>=2} onChange={e=>setMembers(ids=>e.target.checked?[...ids,a.agent_id]:ids.filter(id=>id!==a.agent_id))}/>{a.name}</label>)}</fieldset>
 <label>每次任务派工上限<input type="number" min={1} max={20} step={1} value={maximum} disabled={disabled} onChange={e=>setMaximum(Number(e.target.value))}/></label>
 <label>同时执行成员<select value={active} disabled={disabled} onChange={e=>setActive(Number(e.target.value))}><option value={1}>一名，其他排队</option><option value={2}>最多两名</option></select></label></>}
 <p className="wb-hint">关闭再开启不会清零本次已用次数，也不会增加模型额度。团队或权限变化后需要重新授权。</p>
 {uncertain&&<p role="status">保存结果尚未确认；重试沿用原设置和请求。</p>}{error&&<p className="wb-error" role="alert">{error}</p>}{saved&&<p role="status">授权设置已保存</p>}
 <button className="wb-primary" disabled={busy||(!uncertain&&disabled)}>{busy?'正在保存…':uncertain?'重试原授权设置':'保存派工授权'}</button>
 </form></section>;
}
