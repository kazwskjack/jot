import React,{useMemo,useState,useEffect} from 'react';
import {request} from './client';
import type {ConversationPage,Capabilities} from './types';
import {useResource} from '../workbench/useResource';
import {ResourceStatus} from '../workbench/AgentsPanel';
import {ConversationCreateWriter,conversationCreation,conversationModeSupport} from './conversation-mode.mjs';

export default function ConversationPicker({onOpen,onPendingChange}:{onOpen:(id:string)=>void;onPendingChange?:(pending:boolean)=>void}){
 const [cursors,setCursors]=useState<Array<string|undefined>>([undefined]),[page,setPage]=useState(0),cursor=cursors[page];
 const conversations=useResource(async signal=>({...await request<ConversationPage>(`/conversations?limit=100&state=active${cursor?'&cursor='+encodeURIComponent(cursor):''}`,'GET',undefined,undefined,signal),request_cursor:cursor??null}),'conversation-picker:'+(cursor??''));
 const caps=useResource(signal=>request<Capabilities>('/capabilities','GET',undefined,undefined,signal),'conversation-picker-capabilities');
 const [,render]=useState(0),[creating,setCreating]=useState(false),[error,setError]=useState(''),[workspace,setWorkspace]=useState('');
 const writer=useMemo(()=>new ConversationCreateWriter(request,()=>render(n=>n+1)),[]);
 useEffect(()=>{onPendingChange?.(creating||writer.pending);return()=>onPendingChange?.(false);},[creating,writer.pending,onPendingChange]);
 useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(writer.pending){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[writer]);
 const workspaces=caps.data?.workspaces?.filter(w=>w.can_write)??[],workspaceId=workspace||workspaces[0]?.workspace_id||'';
 let creation:Record<string,unknown>|undefined,creationError='',chatReady=false;
 if(caps.data)try{creation=conversationCreation(caps.data,workspaceId);chatReady=conversationModeSupport(caps.data).chatReady;}catch(e){creationError=e instanceof Error?e.message:'新对话配置尚未确认';}
 const create=async(retry=false)=>{if(creating||!retry&&(!creation||writer.pending)||retry&&!writer.pending)return;setCreating(true);setError('');try{const value=await(retry?writer.retry():writer.create(creation));onOpen(value.conversation_id);}catch(e){setError(e instanceof Error?e.message:'新建对话尚未确认');}finally{setCreating(false);}};
 const pending=creating||writer.pending,current=conversations.data?.request_cursor===(cursor??null)&&!conversations.loading&&!conversations.error;
 return <section aria-label="我的对话"><h2>我的对话</h2><p>打开自己的对话，可将已完成消息设为持续任务，再选择执行角色。每页最多 100 个未归档对话，可继续查看旧会话。</p>
 <div className="wb-actions">{workspaces.length>1&&<label>对话工作区<select aria-label="对话工作区" value={workspaceId} disabled={pending} onChange={e=>setWorkspace(e.target.value)}>{workspaces.map(w=><option key={w.workspace_id} value={w.workspace_id}>{w.title||w.workspace_id}</option>)}</select></label>}<button type="button" disabled={pending||caps.loading||!!caps.error||!creation} onClick={()=>void create()}>新建对话</button>{writer.pending&&<button type="button" disabled={creating} onClick={()=>void create(true)}>重试原新建请求</button>}</div>
 {caps.data&&!chatReady&&<p role="status">{creationError||'Chat 暂不可用，新对话使用 Work。'}</p>}{caps.error&&<p role="alert">{caps.error}<button onClick={caps.reload} disabled={pending}>重试能力检查</button></p>}{error&&<p role="alert">{error}</p>}
 <ResourceStatus {...conversations} onRetry={conversations.reload}/>{current&&conversations.data&&<><ul>{conversations.data.items.filter(item=>!item.archived_at).map(item=><li key={item.conversation_id}><button disabled={pending} onClick={()=>onOpen(item.conversation_id)}>{item.title||'未命名对话'}</button></li>)}</ul>{!conversations.data.items.some(item=>!item.archived_at)&&<p>此页暂无可打开的对话。</p>}</>}
 <div className="wb-actions"><button disabled={pending||conversations.loading} onClick={()=>{setCursors([undefined]);setPage(0);conversations.reload();}}>刷新到最新</button><button disabled={pending||!current||page===0} onClick={()=>setPage(value=>value-1)}>上一页</button><span>第 {page+1} 页</span><button disabled={pending||!current||!conversations.data?.next_cursor} onClick={()=>{const next=conversations.data?.next_cursor;if(!next)return;setCursors(values=>[...values.slice(0,page+1),next]);setPage(value=>value+1);}}>下一页</button></div></section>;
}
