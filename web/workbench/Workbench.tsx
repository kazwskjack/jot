import React,{useState,useCallback} from 'react';
import {MutationPending,MutationPendingState} from './useMutationReceipt';
import {taskDraftScope} from '../jot/client';
import type {TaskSourceSelection} from './types';
import {useResource} from './useResource';
import {workbenchApi} from './client';
import {AgentsPanel,ResourceStatus} from './AgentsPanel';
import TasksPanel from './TasksPanel';
import TeamsPanel from './TeamsPanel';
import SharedWorkspace from './SharedWorkspace';
import './workbench.css';
export const workbenchViews=['agents','teams','shared-workspace','persistent-tasks'];
export default function Workbench({view,onOpen,onConversation,taskSource,onTaskSourceConsumed,onPendingChange}:{view:string;onOpen:(view:string)=>void;onConversation:(id:string)=>void;taskSource?:TaskSourceSelection|null;onTaskSourceConsumed?:()=>void;onPendingChange?:(pending:boolean)=>void}){
 const [pending,setPending]=useState(false),reportPending=useCallback((value:boolean)=>{setPending(value);onPendingChange?.(value);},[onPendingChange]);
 const capabilities=useResource(signal=>workbenchApi.capabilities(signal),'workbench-capabilities'),agents=useResource(signal=>workbenchApi.agents(signal),'workbench-agents',capabilities.data?.workbench?.agent_roles===true);
 return <MutationPendingState.Provider value={pending}><MutationPending.Provider value={reportPending}><div className="wb-layout"><nav className="wb-nav" aria-label="Agent 工作台">{[['agents','Agent 角色'],['persistent-tasks','持续任务'],['teams','角色团队'],['shared-workspace','共享工作区']].map(([value,label])=><button key={value} disabled={pending} aria-current={view===value?'page':undefined} onClick={()=>{agents.reload();onOpen(value);}}>{label}</button>)}</nav><div className="wb-content"><ResourceStatus {...capabilities} onRetry={capabilities.reload}/>{capabilities.data&&(view==='agents'?<><h2>Agent 角色</h2><p className="wb-page-intro">设置职责，进入各自对话，在共同工作区协作。</p><AgentsPanel caps={capabilities.data} onConversation={onConversation}/></>:<><ResourceStatus {...agents} onRetry={agents.reload}/>{view==='persistent-tasks'?<TasksPanel key={taskDraftScope()||'volatile'} taskSource={taskSource} onTaskSourceConsumed={onTaskSourceConsumed} caps={capabilities.data} agents={agents.data?.items??[]} onConversation={onConversation}/>:view==='teams'?<TeamsPanel caps={capabilities.data} agents={agents.data?.items??[]} onConversation={onConversation}/>:<SharedWorkspace caps={capabilities.data} agents={agents.data?.items??[]}/>}</>)}</div></div></MutationPending.Provider></MutationPendingState.Provider>;
}
