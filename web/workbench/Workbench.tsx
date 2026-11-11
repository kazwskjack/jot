import React,{useState,useCallback,useLayoutEffect,useId,useRef} from 'react';
import {MutationPending,MutationPendingState} from './MutationContext';
import {useLayoutDisplayPreferences} from '../jot/useToolDisplayPreference';
import {taskDraftScope} from '../jot/client';
import type {BrowserActionReadinessItem,TaskSourceSelection} from './types';
import {useResource} from './useResource';
import {workbenchApi,hostAdminClient} from './client';
import {ResourceStatus} from './PanelStatus';
import {RetryablePanel} from './RetryablePanel';
import './workbench.css';

export const workbenchViews=['agents','teams','shared-workspace','persistent-tasks','git','projects','settings'];
export const workbenchRetryViewSlot='jot.workbench.retry-view';
const loadAgents=()=>import('./AgentPanel').then(({AgentsPanel})=>({default:AgentsPanel}));
const loadTasks=()=>import('./TasksPanel');
const loadTeams=()=>import('./TeamsPanel');
const loadSharedWorkspace=()=>import('./SharedWorkspace');
const loadGit=()=>import('./GitPanel');
const loadProjects=()=>import('./ProjectsPanel');
const loadSettings=()=>import('./SettingsPanel');

function BrowserActionReadiness({items}:{items:BrowserActionReadinessItem[]}){
 const label={ready:'就绪',unknown:'未知',failed:'不可用'};
 return <section aria-label="浏览器操作 readiness"><h2>浏览器操作 readiness</h2>{items.length
  ?<ul>{items.map(item=><li key={item.run_id}>{item.workspace_id} · {item.run_id}：{label[item.status]}{item.reason?`（${item.reason}）`:''}</li>)}</ul>
  :<p role="status">未知：当前没有活动且已绑定 browser_action 的 run。</p>}</section>;
}

export default function Workbench({view,onOpen,onConversation,taskSource,onTaskSourceConsumed,desktopOpenTask,onDesktopOpenTaskConsumed,onPendingChange}:{view:string;onOpen:(view:string)=>void;onConversation:(id:string)=>void;taskSource?:TaskSourceSelection|null;onTaskSourceConsumed?:()=>void;desktopOpenTask?:{task_id:string;occurrence_id:string}|null;onDesktopOpenTaskConsumed?:()=>void;onPendingChange?:(pending:boolean)=>void}){
 const layoutDisplay=useLayoutDisplayPreferences(),navigation=useRef<HTMLElement>(null),toggle=useRef<HTMLButtonElement>(null),navigationId=useId();
 const previousSidebar=useRef(layoutDisplay.value.sidebarVisible);
 useLayoutEffect(()=>{
  const active=document.activeElement;
  if(previousSidebar.current&&!layoutDisplay.value.sidebarVisible&&(active===document.body||navigation.current?.contains(active)))toggle.current?.focus();
  previousSidebar.current=layoutDisplay.value.sidebarVisible;
 },[layoutDisplay.value.sidebarVisible]);
 const [pending,setPending]=useState(false),reportPending=useCallback((value:boolean)=>{setPending(value);onPendingChange?.(value);},[onPendingChange]);
 const capabilities=useResource(signal=>workbenchApi.capabilities(signal),'workbench-capabilities'),agents=useResource(signal=>workbenchApi.agents(signal),'workbench-agents',capabilities.data?.workbench?.agent_roles===true);
 const retryChunk=()=>{try{sessionStorage.setItem(workbenchRetryViewSlot,view);}catch{};};
 const panel=view==='settings'
  ?<RetryablePanel key={view} load={loadSettings} label="设置" props={{key:taskDraftScope(),caps:capabilities.data,client:hostAdminClient}} onBeforeRetry={retryChunk}/>
  :view==='git'
  ?<RetryablePanel key={view} load={loadGit} label="Git 工作台" props={{key:taskDraftScope(),caps:capabilities.data}} onBeforeRetry={retryChunk}/>
   :view==='projects'
    ?<RetryablePanel key={view} load={loadProjects} label="项目" props={{}} onBeforeRetry={retryChunk}/>
  :view==='agents'
   ?<><h2>Agent 角色</h2><p className="wb-page-intro">设置职责，进入各自对话，在共同工作区协作。</p><RetryablePanel key={view} load={loadAgents} label="Agent 角色" props={{caps:capabilities.data,onConversation}} onBeforeRetry={retryChunk}/></>
   :<><ResourceStatus {...agents} onRetry={agents.reload}/>{view==='persistent-tasks'
    ?<RetryablePanel key={view} load={loadTasks} label="持续任务" props={{key:taskDraftScope()||'volatile',taskSource,onTaskSourceConsumed,desktopOpenTask,onDesktopOpenTaskConsumed,caps:capabilities.data,agents:agents.data?.items??[],onConversation}} onBeforeRetry={retryChunk}/>
    :view==='teams'
     ?<RetryablePanel key={view} load={loadTeams} label="角色团队" props={{caps:capabilities.data,agents:agents.data?.items??[],onConversation}} onBeforeRetry={retryChunk}/>
     :<RetryablePanel key={view} load={loadSharedWorkspace} label="共享工作区" props={{caps:capabilities.data,agents:agents.data?.items??[],onWorkspaceSelected:capabilities.reload}} onBeforeRetry={retryChunk}/>}</>;
 const selectedWorkspace=capabilities.data?.workspace_selection?.configured?capabilities.data.workspaces.find(item=>item.workspace_id===capabilities.data!.workspace_selection!.workspace_id):capabilities.data?.workspaces[0];
 const desktopFilesReady=capabilities.data?.workbench?.shared_workspace===true&&selectedWorkspace?.can_read===true;
  return <MutationPendingState.Provider value={pending}><MutationPending.Provider value={reportPending}><div className="wb-layout" data-desktop-workbench data-desktop-files-ready={desktopFilesReady?'true':'false'} data-desktop-workspace={selectedWorkspace?.workspace_id}><nav ref={navigation} id={navigationId} className="wb-nav" data-desktop-sidebar hidden={!layoutDisplay.value.sidebarVisible} aria-label="Agent 工作台">{[['agents','Agent 角色'],['persistent-tasks','持续任务'],['teams','角色团队'],['shared-workspace','共享工作区'],['git','Git 工作台'],['projects','项目'],['settings','设置']].map(([value,label])=><button key={value} disabled={pending} aria-current={view===value?'page':undefined} onClick={()=>{agents.reload();onOpen(value);}}>{label}</button>)}</nav><div className="wb-content" tabIndex={-1} data-desktop-route={view}><button ref={toggle} type="button" className="wb-nav-toggle" data-desktop-target="toggle-sidebar" disabled={!layoutDisplay.available} aria-controls={navigationId} aria-expanded={layoutDisplay.value.sidebarVisible} onClick={()=>layoutDisplay.setPreference('sidebarVisible',!layoutDisplay.value.sidebarVisible)}>{layoutDisplay.value.sidebarVisible?'收起工作台导航':'显示工作台导航'}</button><ResourceStatus {...capabilities} onRetry={capabilities.reload}/>{capabilities.data&&<><BrowserActionReadiness items={capabilities.data.workbench?.browser_action_readiness??[]}/>{panel}</>}</div></div></MutationPending.Provider></MutationPendingState.Provider>;
}
