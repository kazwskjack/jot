import {registerUiDiagnostics} from './jot/ui-diagnostics';
import type {TaskSourceSelection} from './workbench/types';
import React,{useCallback,useEffect,useState} from 'react';
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
 const [taskSource,setTaskSource]=useState<TaskSourceSelection|null>(null);
 const [managementPending,setManagementPending]=useState(false);
 const [desktopOpenTask,setDesktopOpenTask]=useState<DesktopOpenTaskIdentity|null>(null);
 const [view,setView]=useState(()=>{
  try{const retryView=sessionStorage.getItem(workbenchRetryViewSlot);if(retryView){sessionStorage.removeItem(workbenchRetryViewSlot);if(workbenchViews.includes(retryView))return retryView;}}catch{}
  return 'agents';
 }),[conversation,setConversation]=useState(''),[showConversations,setShowConversations]=useState(false);
 const [theme,setTheme]=useState(()=>localStorage.getItem('jot-theme')==='light'?'light':'dark');
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
 useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('jot-theme',theme);},[theme]);
  return <div className="workbench-application"><header><a href="/">Jot</a><strong>工作台</strong><button disabled={!!conversation||managementPending} onClick={()=>setShowConversations(value=>!value)}>{showConversations?'返回工作台':'我的对话'}</button><button onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?'浅色':'深色'}</button></header>{conversation?<RoleConversation ordinary={showConversations} onTaskSource={source=>{setTaskSource(source);setConversation('');setShowConversations(false);setView('persistent-tasks');}} id={conversation} onForkConversation={target=>setConversation(target)} onClose={()=>setConversation('')}/>:showConversations?<ConversationPicker onOpen={setConversation} onPendingChange={setManagementPending}/>:<Workbench onPendingChange={setManagementPending} taskSource={taskSource} onTaskSourceConsumed={()=>setTaskSource(null)} desktopOpenTask={managementPending?null:desktopOpenTask} onDesktopOpenTaskConsumed={consumeDesktopOpenTask} view={view} onOpen={setView} onConversation={setConversation}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<WorkbenchApplication/>);
