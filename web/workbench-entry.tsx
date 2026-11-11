import {useDesktopCommands,type DesktopUiCommand} from './jot/useDesktopCommands';
import {useLayoutDisplayPreferences} from './jot/useToolDisplayPreference';
import {desktopUpdatesBridge} from './workbench/desktop-updates';
import {request,subscribeTaskDraftScope,taskDraftScope} from './jot/client';
import {readWorkbenchRoute,writeWorkbenchRoute} from './jot/workbench-route-state';
import {recordUiDiagnostic,registerUiDiagnostics} from './jot/ui-diagnostics';
import type {TaskSourceSelection} from './workbench/types';
import React,{useCallback,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import Workbench,{workbenchRetryViewSlot,workbenchViews} from './workbench/Workbench';
import RoleConversation from './jot/RoleConversation';
import ConversationPicker from './jot/ConversationPicker';
import './style.css';
import './workbench-entry.css';

type DesktopOpenTaskIdentity=Readonly<{task_id:string;occurrence_id:string}>;
type DesktopBridgeWindow=Window&{jotDesktop?:{onOpenTask?:(listener:(identity:DesktopOpenTaskIdentity)=>void)=>()=>void}};

function WorkbenchApplication(){
 useEffect(registerUiDiagnostics,[]);
 const owner=useSyncExternalStore(subscribeTaskDraftScope,taskDraftScope),[revision,setRevision]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();setLoading(true);setError('');
  void request('/capabilities','GET',undefined,undefined,controller.signal).then(()=>{if(!controller.signal.aborted&&!taskDraftScope())setError('当前账户身份尚未确认。');})
   .catch(()=>{if(!controller.signal.aborted)setError('暂时无法确认当前账户，请重试连接。');})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[revision]);
 if(!owner)return <section aria-label="工作台账户恢复"><p role={loading?'status':'alert'}>{loading?'正在确认账户并恢复工作台…':error||'账户身份已变化，请重新确认连接。'}</p><button type="button" disabled={loading} onClick={()=>setRevision(value=>value+1)}>重新确认账户</button></section>;
 return <WorkbenchSession key={owner} owner={owner}/>;
}
function WorkbenchSession({owner}:{owner:string}){
 const surface=useRef<HTMLDivElement>(null),layoutDisplay=useLayoutDisplayPreferences();
 const [desktopFocus,setDesktopFocus]=useState<{owner:string;command:DesktopUiCommand;route:string;workspace?:string}>(),[desktopError,setDesktopError]=useState('');
 const [initial]=useState(()=>{
  const saved=readWorkbenchRoute(owner,workbenchViews)??{view:'agents',conversation:'',showConversations:false};
  try{const retryView=sessionStorage.getItem(workbenchRetryViewSlot);if(retryView){sessionStorage.removeItem(workbenchRetryViewSlot);if(workbenchViews.includes(retryView))return {view:retryView,conversation:'',showConversations:false};}}catch{}
  return saved;
 });
 const [taskSource,setTaskSource]=useState<TaskSourceSelection|null>(null);
 const [managementPending,setManagementPending]=useState(false);
 const [desktopOpenTask,setDesktopOpenTask]=useState<DesktopOpenTaskIdentity|null>(null);
 const [view,setView]=useState(initial.view),[conversation,setConversation]=useState(initial.conversation),[showConversations,setShowConversations]=useState(initial.showConversations);
 useLayoutEffect(()=>{writeWorkbenchRoute(owner,{view,conversation,showConversations},workbenchViews);},[owner,view,conversation,showConversations]);
 const [reloadError,setReloadError]=useState('');
 const reloadRoute=useRef({owner,view,conversation,showConversations,managementPending,taskSource,desktopOpenTask});
 reloadRoute.current={owner,view,conversation,showConversations,managementPending,taskSource,desktopOpenTask};
 const reloadConversation=useCallback((conversationId:string)=>{
  setReloadError('');const current=reloadRoute.current;
  if(taskDraftScope()!==current.owner||current.conversation!==conversationId||!conversationId||current.managementPending||current.taskSource||current.desktopOpenTask){setReloadError('当前会话或工作台操作尚未确认，请保留页面。');return false;}
  if(!writeWorkbenchRoute(current.owner,{view:current.view,conversation:current.conversation,showConversations:current.showConversations},workbenchViews)){setReloadError('当前会话位置尚未保存，已保留页面，请稍后重试。');return false;}
  try{recordUiDiagnostic('manual-reload');window.location.reload();return true;}
  catch{setReloadError('界面暂时无法重新载入，当前页面已保留。');return false;}
 },[]);
 const [theme,setTheme]=useState(()=>{try{return localStorage.getItem('jot-theme')==='light'?'light':'dark';}catch{return 'dark';}});
 const handleDesktopOpenTask=useCallback((identity:DesktopOpenTaskIdentity)=>setDesktopOpenTask(identity),[]);
 const consumeDesktopOpenTask=useCallback(()=>setDesktopOpenTask(null),[]);
 useEffect(()=>{
  const bridge=(window as DesktopBridgeWindow).jotDesktop;
  if(typeof bridge?.onOpenTask!=='function')return;
  return bridge.onOpenTask(handleDesktopOpenTask);
 },[handleDesktopOpenTask]);
 useEffect(()=>{
  if(!desktopOpenTask||managementPending)return;
  setTaskSource(null);setConversation('');setShowConversations(false);setView('persistent-tasks');
 },[desktopOpenTask,managementPending]);
 useEffect(()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem('jot-theme',theme);}catch{}},[theme]);
 const visible=(node:HTMLElement|null):node is HTMLElement=>!!node&&!node.closest('[hidden],[inert],[aria-hidden="true"]')&&node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden'&&!(node instanceof HTMLButtonElement||node instanceof HTMLInputElement||node instanceof HTMLSelectElement?node.disabled:false);
 const target=(command:string)=>{const node=surface.current?.querySelector<HTMLElement>(`[data-desktop-target="${command}"]`)??null;return visible(node)?node:null;};
 const findTarget=()=>{
  const active=document.activeElement;if(active instanceof HTMLIFrameElement)return null;
  const context=active instanceof Element?active.closest<HTMLElement>('[data-chat-search-scope]'):null;
  const scope=context&&surface.current?.contains(context)?context:surface.current?.querySelector<HTMLElement>('[data-chat-search-scope]');
  if(!scope)return null;
  const node=scope.dataset.desktopFindSurface==='pdf'?scope.querySelector<HTMLInputElement>('[data-pdf-file-search]')
   :Array.from(scope.querySelectorAll<HTMLElement>('[data-desktop-target="find"]')).find(node=>node.closest('[data-chat-search-scope]')===scope)??null;
  return visible(node??null)?node:null;
 };
 const canNavigate=()=>{
  const current=reloadRoute.current;
  if(taskDraftScope()!==owner||current.managementPending||current.taskSource||current.desktopOpenTask)return false;
  if(!current.conversation)return true;
  const guard=surface.current?.querySelector<HTMLButtonElement>('button[data-desktop-navigation-guard]');return !!guard&&!guard.disabled&&guard.dataset.desktopConversation===current.conversation&&guard.dataset.desktopOwner===owner;
 };
 const filesContext=()=>surface.current?.querySelector<HTMLElement>('[data-desktop-workbench][data-desktop-files-ready="true"]');
 const commandEnabled=(command:DesktopUiCommand)=>{
  if(command==='find')return !!findTarget();
  if(command==='toggle-sidebar'||command==='skills')return !!target(command);
  if(command==='check-updates')return canNavigate()&&!!desktopUpdatesBridge()&&(!surface.current?.querySelector('[data-desktop-update-panel]')||!!target(command));
  if(command==='files')return canNavigate()&&Boolean(filesContext()?.dataset.desktopWorkspace);
  return canNavigate();
 };
 const executeDesktop=(command:DesktopUiCommand)=>{
  if(taskDraftScope()!==owner||!commandEnabled(command))return;setDesktopError('');
  if(command==='toggle-sidebar'){layoutDisplay.setPreference('sidebarVisible',!layoutDisplay.value.sidebarVisible);return;}
  if(command==='find'){const node=findTarget();node?.click();node?.focus();if(node instanceof HTMLInputElement)node.select();return;}
  if(command==='skills'){const node=target(command);node?.scrollIntoView({block:'nearest'});node?.focus();return;}
  const route=command==='new-conversation'||command==='chat'?'conversations':command==='new-project'?'projects':command==='files'?'shared-workspace':command==='scheduled-tasks'?'persistent-tasks':'settings';
  const workspace=command==='files'?filesContext()?.dataset.desktopWorkspace:undefined;
  setConversation('');setShowConversations(route==='conversations');if(route!=='conversations')setView(route);
  setDesktopFocus({owner,command,route,...(workspace?{workspace}:{})});
 };
 useEffect(()=>{
  if(!desktopFocus)return;
  const request=desktopFocus,current=reloadRoute.current;let done=false;
  const correctRoute=()=>taskDraftScope()===request.owner&&!reloadRoute.current.conversation&&(request.route==='conversations'?reloadRoute.current.showConversations:!reloadRoute.current.showConversations&&reloadRoute.current.view===request.route);
  const finish=()=>{done=true;setDesktopFocus(value=>value===request?undefined:value);};
  if(!correctRoute()||current.managementPending||current.taskSource||current.desktopOpenTask){finish();return;}
  let disposed=false,frame=0,openedProject=false;
  const cancel=()=>{if(disposed||done)return;setDesktopError('桌面命令的原入口尚未就绪，可从当前页面继续。');finish();};
  const apply=()=>{
   frame=0;if(disposed||done)return;
   if(!correctRoute()||!canNavigate()){finish();return;}
   let node:HTMLElement|null=null;
   if(request.command==='new-project'){
    node=target('new-project-input');
    if(!node){const action=target('new-project');if(action&&!openedProject){openedProject=true;action.click();}return;}
   }else if(request.command==='new-conversation')node=target('new-conversation');
   else if(request.command==='chat')node=target('chat');
   else if(request.command==='settings')node=target('settings');
    else if(request.command==='check-updates'){
     const panel=surface.current?.querySelector<HTMLElement>('[data-desktop-update-panel]');
     if(!panel||panel.dataset.desktopUpdateReady!=='true')return;
     const action=target('check-updates');node=action??panel;
     if(!visible(node))return;
     // Consume the transient menu request before clicking. A disabled/policy-only
     // panel receives focus without forcing a native command or replaying later.
     finish();node.scrollIntoView({block:'nearest'});node.focus();action?.click();return;
    }
   else if(request.command==='files'){
    node=target('files');if(node&&node.dataset.desktopWorkspace!==request.workspace){cancel();return;}
    if(node)node.click();
   }else node=surface.current?.querySelector<HTMLElement>(`[data-desktop-route="${request.route}"]`)??null;
   if(!visible(node))return;
   node.scrollIntoView({block:'nearest'});node.focus();if(node instanceof HTMLInputElement)node.select();finish();
  };
  const schedule=()=>{if(!done&&!frame)frame=requestAnimationFrame(apply);};
  const observer=new MutationObserver(schedule),root=surface.current;
  if(root)observer.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','hidden','data-desktop-workspace','data-desktop-update-ready']});
  const timer=setTimeout(cancel,15000);schedule();
  return()=>{disposed=true;cancelAnimationFrame(frame);clearTimeout(timer);observer.disconnect();};
 },[desktopFocus,owner,view,conversation,showConversations,managementPending,taskSource,desktopOpenTask]);
 useDesktopCommands({owner,sidebarVisible:layoutDisplay.value.sidebarVisible,enabled:commandEnabled,execute:executeDesktop});
  return <div ref={surface} className="workbench-application"><header><a href="/">Jot</a><strong>工作台</strong><button disabled={!!conversation||managementPending} onClick={()=>setShowConversations(value=>!value)}>{showConversations?'返回工作台':'我的对话'}</button><button onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?'浅色':'深色'}</button></header>{reloadError&&<p role="alert">{reloadError}</p>}{desktopError&&<p role="status">{desktopError}</p>}{conversation?<RoleConversation onReload={reloadConversation} ordinary={showConversations} onTaskSource={source=>{setTaskSource(source);setConversation('');setShowConversations(false);setView('persistent-tasks');}} id={conversation} onForkConversation={target=>setConversation(target)} onClose={()=>setConversation('')}/>:showConversations?<ConversationPicker onOpen={setConversation} onPendingChange={setManagementPending}/>:<Workbench onPendingChange={setManagementPending} taskSource={taskSource} onTaskSourceConsumed={()=>setTaskSource(null)} desktopOpenTask={managementPending?null:desktopOpenTask} onDesktopOpenTaskConsumed={consumeDesktopOpenTask} view={view} onOpen={setView} onConversation={setConversation}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<WorkbenchApplication/>);
