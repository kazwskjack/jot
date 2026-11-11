import {request,subscribeTaskDraftScope,taskDraftScope} from './jot/client';
import {readWorkbenchRoute,writeWorkbenchRoute} from './jot/workbench-route-state';
import {registerUiDiagnostics} from './jot/ui-diagnostics';
import type {TaskSourceSelection} from './workbench/types';
import React,{useCallback,useEffect,useLayoutEffect,useState,useSyncExternalStore} from 'react';
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
  return <div className="workbench-application"><header><a href="/">Jot</a><strong>工作台</strong><button disabled={!!conversation||managementPending} onClick={()=>setShowConversations(value=>!value)}>{showConversations?'返回工作台':'我的对话'}</button><button onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?'浅色':'深色'}</button></header>{conversation?<RoleConversation ordinary={showConversations} onTaskSource={source=>{setTaskSource(source);setConversation('');setShowConversations(false);setView('persistent-tasks');}} id={conversation} onForkConversation={target=>setConversation(target)} onClose={()=>setConversation('')}/>:showConversations?<ConversationPicker onOpen={setConversation} onPendingChange={setManagementPending}/>:<Workbench onPendingChange={setManagementPending} taskSource={taskSource} onTaskSourceConsumed={()=>setTaskSource(null)} desktopOpenTask={managementPending?null:desktopOpenTask} onDesktopOpenTaskConsumed={consumeDesktopOpenTask} view={view} onOpen={setView} onConversation={setConversation}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<WorkbenchApplication/>);
