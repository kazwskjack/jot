import React,{useState} from 'react';
import {request} from './client';
import type {ConversationPage} from './types';
import {useResource} from '../workbench/useResource';
import {ResourceStatus} from '../workbench/AgentsPanel';

export default function ConversationPicker({onOpen}:{onOpen:(id:string)=>void}){
 const [cursors,setCursors]=useState<Array<string|undefined>>([undefined]),[page,setPage]=useState(0),cursor=cursors[page];
 const conversations=useResource(async signal=>({...await request<ConversationPage>(`/conversations?limit=100&state=active${cursor?'&cursor='+encodeURIComponent(cursor):''}`,'GET',undefined,undefined,signal),request_cursor:cursor??null}),'conversation-picker:'+(cursor??''));
 const current=conversations.data?.request_cursor===(cursor??null)&&!conversations.loading&&!conversations.error;
 return <section aria-label="我的对话"><h2>我的对话</h2><p>打开自己的对话，可将已完成消息设为持续任务，再选择执行角色。每页最多 100 个未归档对话，可继续查看旧会话。</p><ResourceStatus {...conversations} onRetry={conversations.reload}/>{current&&conversations.data&&<><ul>{conversations.data.items.filter(item=>!item.archived_at).map(item=><li key={item.conversation_id}><button onClick={()=>onOpen(item.conversation_id)}>{item.title||'未命名对话'}</button></li>)}</ul>{!conversations.data.items.some(item=>!item.archived_at)&&<p>此页暂无可打开的对话。</p>}</>}<div className="wb-actions"><button disabled={conversations.loading} onClick={()=>{setCursors([undefined]);setPage(0);conversations.reload();}}>刷新到最新</button><button disabled={!current||page===0} onClick={()=>setPage(value=>value-1)}>上一页</button><span>第 {page+1} 页</span><button disabled={!current||!conversations.data?.next_cursor} onClick={()=>{const next=conversations.data?.next_cursor;if(!next)return;setCursors(values=>[...values.slice(0,page+1),next]);setPage(value=>value+1);}}>下一页</button></div></section>;
}
