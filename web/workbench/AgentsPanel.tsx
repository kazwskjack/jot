import React,{useState} from 'react';
import {useMutationReceipt,MutationPending} from './useMutationReceipt';
import {copyAgentConfig,downloadAgentConfig,agentStatusInput} from './agent-config.mjs';
import LucideIcon from '../icons/LucideIcon';
import {agentInput,featureReason,executionReason} from './form-state.mjs';
import {workbenchApi,pathId} from './client';
import {useResource} from './useResource';
import type {Agent,Caps} from './types';
import DiscoveryPolicyPanel from './DiscoveryPolicyPanel';
import {taskDraftScope} from '../jot/client';
import './workbench.css';
export function ResourceStatus({loading,error,onRetry}:{loading:boolean;error:string;onRetry:()=>void}){return <>{loading&&<p className="wb-status" role="status">正在读取…</p>}{error&&<div className="wb-error" role="alert"><span>{error}</span><button type="button" onClick={onRetry}>重新读取</button></div>}</>;}
export function Empty({children}:{children:React.ReactNode}){return <p className="wb-empty">{children}</p>;}
export function AgentsPanel({caps,onConversation,compact=false}:{caps:Caps|null;onConversation:(id:string)=>void;compact?:boolean}){
 const reason=featureReason(caps?.workbench,'agent_roles');
 const execution=executionReason(caps?.workbench);
 const ownerScope=taskDraftScope(),resource=useResource(signal=>workbenchApi.agents(signal),'agents:'+ownerScope,!reason);
 const [discovery,setDiscovery]=useState<{agent_id:string;ownerScope:string}|null>(null);
 const [editing,setEditing]=useState<Partial<Agent>|null>(null),[deleting,setDeleting]=useState<{agent:Agent;preview:Record<string,unknown>}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const agents=resource.data?.items??[],workspaces=caps?.workspaces??[];
 const [changing,setChanging]=useState<Agent|null>(null);
 const mutation=useMutationReceipt();
 const run=async(action:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await action();resource.reload();}catch(e){setError(e instanceof Error?e.message:'操作未完成');}finally{setBusy(false);}};
 const start=(agent?:Agent)=>{setError('');setDeleting(null);setChanging(null);setEditing(agent?{...agent,allowed_tools:[...agent.allowed_tools]}:{name:'',instructions:'',workspace_id:workspaces[0]?.workspace_id??''});};
 const save=(e:React.FormEvent)=>{e.preventDefault();void run(async()=>{await mutation.submit(editing?.agent_id?`/agents/${pathId(editing.agent_id)}`:'/agents',editing?.agent_id?'PATCH':'POST',agentInput(editing));setEditing(null);});};
 const preview=(agent:Agent)=>void run(async()=>{setEditing(null);setDeleting({agent,preview:await workbenchApi.deletionPreview(agent.agent_id)});});
 const discoveryAgent=discovery?.ownerScope===ownerScope?agents.find(agent=>agent.agent_id===discovery.agent_id):null;
 if(discoveryAgent)return <DiscoveryPolicyPanel agent={discoveryAgent} onClose={()=>{setDiscovery(null);resource.reload();}} onChanged={resource.reload}/>;
 return <div className={`wb-agents ${compact?'wb-agents--compact':''}`}>
  <div className="wb-toolbar"><span>{agents.length?`${agents.length} 位角色 · 各自保留独立对话`:'让不同职责，有自己的位置'}</span><button className="wb-primary" type="button" disabled={!!reason||busy||mutation.pending} title={reason} onClick={()=>start()}><LucideIcon name="plus"/>创建角色</button></div>
  {reason&&<p className="wb-status">{reason}</p>}<ResourceStatus {...resource} onRetry={resource.reload}/>{error&&<p className="wb-error" role="alert">{error}</p>}
  {!reason&&execution&&<p className="wb-status wb-execution-notice" role="status">{execution}</p>}
  {editing&&<form className="wb-form" onSubmit={save} aria-label={editing.agent_id?'编辑角色':'创建角色'}>
   <div className="wb-form-head"><h3>{editing.agent_id?'编辑角色':'新的 Agent 角色'}</h3><button type="button" disabled={busy||mutation.pending} onClick={()=>setEditing(null)} aria-label="关闭角色编辑"><LucideIcon name="x"/></button></div>
   <fieldset className="wb-input-fields" disabled={busy||mutation.pending}><label>角色名称<input autoFocus required maxLength={100} value={editing.name??''} onChange={e=>setEditing({...editing,name:e.target.value})} placeholder="例如：资料研究员"/></label>
   <label>职责与输出要求<textarea required rows={4} maxLength={16000} value={editing.instructions??''} onChange={e=>setEditing({...editing,instructions:e.target.value})} placeholder="说明职责、资料要求、输出格式以及何时请求帮助"/></label>
   <label>共同工作区<select required disabled={!!editing.agent_id} value={editing.workspace_id??''} onChange={e=>setEditing({...editing,workspace_id:e.target.value})}>{workspaces.map(w=><option key={w.workspace_id} value={w.workspace_id}>{w.title}</option>)}</select></label>
   {editing.project_id&&<small>项目：{editing.project_id}</small>}
   <fieldset><legend>工具范围</legend>{caps?.workbench?.allowed_tools?.length?caps.workbench.allowed_tools.map(tool=><label className="wb-checkbox" key={tool}><input type="checkbox" checked={(editing.allowed_tools??caps.workbench!.allowed_tools!).includes(tool)} disabled={busy||mutation.pending} onChange={e=>{const current=editing.allowed_tools??caps.workbench!.allowed_tools!;setEditing({...editing,allowed_tools:e.target.checked?[...current,tool]:current.filter(value=>value!==tool)});}}/>{tool}</label>):<><button type="button" disabled>工具范围暂不可配置</button><p className="wb-hint">服务端尚未公布可选工具集合，角色使用当前宿主允许范围。</p></>}</fieldset>
   <p className="wb-hint">模型沿用服务端配置。角色与其他成员共用所选工作区，私有记忆按角色隔离。</p>
   </fieldset><button className="wb-primary" disabled={busy||!workspaces.length}>{busy?'正在保存…':mutation.pending?'重试原保存':'保存角色'}</button>
  </form>}
  {deleting&&<div className="wb-form wb-delete" role="alertdialog" aria-label="删除角色影响确认"><h3>删除「{deleting.agent.name}」</h3><p>删除后撤销角色访问并暂停相关任务，共享资料仍归工作区所有。</p><ul><li>在途运行：{Array.isArray(deleting.preview.active_runs)?deleting.preview.active_runs.length:0} 个</li><li>关联持续任务：{Array.isArray(deleting.preview.persistent_tasks)?deleting.preview.persistent_tasks.length:0} 个</li><li>角色私有记忆：{String(deleting.preview.private_memory_count??0)} 条</li><li>待处理消息：{String(deleting.preview.pending_message_count??0)} 条</li></ul><p className="wb-hint">私有记忆随角色访问撤销，历史归属保留。此版本尚未提供私有记忆转交。</p><div className="wb-actions"><button type="button" autoFocus disabled={busy||mutation.pending} onClick={()=>setDeleting(null)}>保留角色</button><button className="wb-danger" type="button" disabled={busy} onClick={()=>void run(async()=>{await mutation.submit('/agents/'+pathId(deleting.agent.agent_id),'DELETE',{expected_version:deleting.agent.version});setDeleting(null);})}>{busy?'正在删除…':'确认删除'}</button></div></div>}
  {!reason&&!resource.loading&&!resource.error&&!agents.length&&!editing&&<Empty>尚未创建角色。为研究、观察或校对设定职责，随后进入独立对话。</Empty>}
  <div className="wb-agent-grid">{agents.map(agent=><article className="wb-agent-card" key={agent.agent_id}>
   <div className="wb-card-top"><span className="wb-avatar" aria-hidden="true">{agent.name.slice(0,1)}</span><div><h3>{agent.name}</h3><small>{workspaces.find(w=>w.workspace_id===agent.workspace_id)?.title??agent.workspace_id}</small></div><span className="wb-badge">{agent.status==='active'?(execution?'已保存':'可对话'):agent.status==='disabled'?'已停用':agent.status}</span></div>
   <p className="wb-agent-instructions">{agent.instructions}</p><div className="wb-card-footer"><button type="button" disabled={!!execution||mutation.pending||!agent.conversation_id||agent.status!=='active'||busy} title={execution} onClick={()=>onConversation(agent.conversation_id)}><LucideIcon name="message-square-plus"/>进入对话</button><div><button type="button" aria-label={`编辑 ${agent.name}`} disabled={busy||mutation.pending} onClick={()=>start(agent)}><LucideIcon name="pencil"/></button><button type="button" aria-label={`删除 ${agent.name}`} disabled={busy||mutation.pending} onClick={()=>preview(agent)}><LucideIcon name="x"/></button></div></div>
   <div className="wb-actions wb-agent-config-actions"><button type="button" disabled={busy||mutation.pending||!ownerScope||!['active','disabled'].includes(agent.status)} aria-label={`项目发现 ${agent.name}`} onClick={()=>{setEditing(null);setDeleting(null);setChanging(null);setDiscovery({agent_id:agent.agent_id,ownerScope});}}>项目发现</button><button type="button" disabled={busy||mutation.pending||!['active','disabled'].includes(agent.status)} aria-label={`复制 ${agent.name}`} onClick={()=>{start();setEditing(copyAgentConfig(agent));}}>复制配置</button><button type="button" disabled={busy||mutation.pending||!['active','disabled'].includes(agent.status)} aria-label={`${agent.status==='disabled'?'启用':'停用'} ${agent.name}`} onClick={()=>{setEditing(null);setDeleting(null);setChanging(agent);setError('');}}>{agent.status==='disabled'?'启用':'停用'}</button><button type="button" disabled={busy||mutation.pending} aria-label={`导出 ${agent.name} 配置`} onClick={()=>downloadAgentConfig(agent)}>导出配置</button></div>
  </article>)}</div>
  {changing&&<div className="wb-form" role="alertdialog" aria-label="角色状态确认"><h3>{changing.status==='active'?'停用':'启用'}「{changing.name}」</h3><p>{changing.status==='active'?'停用会撤销该角色的运行权限。保留角色配置、对话和记忆；这不是删除操作。':'启用后可使用角色的新版本，不会自动重发消息或恢复已暂停的任务。'}</p><div className="wb-actions"><button type="button" disabled={busy||mutation.pending} onClick={()=>setChanging(null)}>取消</button><button type="button" disabled={busy} onClick={()=>void run(async()=>{await mutation.submit('/agents/'+pathId(changing.agent_id),'PATCH',agentStatusInput(changing));setChanging(null);})}>{changing.status==='active'?'确认停用':'确认启用'}</button></div></div>}
 </div>;
}
export default function AgentHome({onConversation,onWorkbench}:{onConversation:(id:string)=>void;onWorkbench:()=>void}){
 const [pending,setPending]=useState(false);
 const capabilities=useResource(signal=>workbenchApi.capabilities(signal),'home-capabilities');
 return <MutationPending.Provider value={setPending}><div className="wb-home"><ResourceStatus {...capabilities} onRetry={capabilities.reload}/><AgentsPanel caps={capabilities.data} onConversation={onConversation} compact/><button className="wb-open" type="button" disabled={pending} onClick={onWorkbench}>团队、持续任务与共享工作区 <LucideIcon name="chevron-right"/></button></div></MutationPending.Provider>;
}
