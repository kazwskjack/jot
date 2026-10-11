import type {TaskSourceSelection} from './workbench/types';
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import Workbench from './workbench/Workbench';
import RoleConversation from './jot/RoleConversation';
import ConversationPicker from './jot/ConversationPicker';
import './style.css';
import './workbench-entry.css';

function WorkbenchApplication(){
 const [taskSource,setTaskSource]=useState<TaskSourceSelection|null>(null);
 const [managementPending,setManagementPending]=useState(false);
 const [view,setView]=useState('agents'),[conversation,setConversation]=useState(''),[showConversations,setShowConversations]=useState(false);
 const [theme,setTheme]=useState(()=>localStorage.getItem('jot-theme')==='light'?'light':'dark');
 useEffect(()=>{document.documentElement.dataset.theme=theme;localStorage.setItem('jot-theme',theme);},[theme]);
 return <div className="workbench-application"><header><a href="/">Jot</a><strong>工作台</strong><button disabled={!!conversation||managementPending} onClick={()=>setShowConversations(value=>!value)}>{showConversations?'返回工作台':'我的对话'}</button><button onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?'浅色':'深色'}</button></header>{conversation?<RoleConversation ordinary={showConversations} onTaskSource={source=>{setTaskSource(source);setConversation('');setShowConversations(false);setView('persistent-tasks');}} id={conversation} onClose={()=>setConversation('')}/>:showConversations?<ConversationPicker onOpen={setConversation}/>:<Workbench onPendingChange={setManagementPending} taskSource={taskSource} onTaskSourceConsumed={()=>setTaskSource(null)} view={view} onOpen={setView} onConversation={setConversation}/>}</div>;
}
createRoot(document.getElementById('root')!).render(<WorkbenchApplication/>);
