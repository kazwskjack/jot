import React,{useEffect,useState} from 'react';
import {ApiError,base,request,taskDraftScope} from './client';
import type {ActivityNativeSearchMembersPage} from './types';

type Target={runId:string;activityId:string;toolName:'glob'|'grep';asOfSeq?:string};
const sha=/^[a-f0-9]{64}$/;

export default function NativeSearchMembers({conversationId,target}:{conversationId:string;target:Target}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,target]);
 const [cursor,setCursor]=useState<{identity:string;offset:number;previous:number[];resultSha?:string;membersSha?:string}>({identity,offset:0,previous:[]});
 const [state,setState]=useState<{identity:string;offset:number;page?:ActivityNativeSearchMembersPage;error?:string}>();
 const [revision,setRevision]=useState(0);
 const currentCursor=cursor.identity===identity?cursor:{identity,offset:0,previous:[],resultSha:undefined,membersSha:undefined};
 const {offset,resultSha,membersSha}=currentCursor;
 useEffect(()=>{
  const controller=new AbortController();
  setState({identity,offset});
  const load=async()=>{
   const query=new URLSearchParams({run_id:target.runId,offset_members:String(offset),
    ...(target.asOfSeq?{as_of_seq:target.asOfSeq}:{}),...(resultSha?{result_sha256:resultSha}:{}),...(membersSha?{members_sha256:membersSha}:{})});
   const page=await request<ActivityNativeSearchMembersPage>(`/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(target.activityId)}/tool-result/members?${query}`,'GET',undefined,undefined,controller.signal);
   if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.run_id!==target.runId||page.activity_id!==target.activityId
    ||page.tool_name!==target.toolName||page.as_of_seq!==target.asOfSeq||page.execution_authorized!==false
    ||typeof page.result_sha256!=='string'||!sha.test(page.result_sha256)||resultSha!==undefined&&page.result_sha256!==resultSha
    ||typeof page.members_sha256!=='string'||!sha.test(page.members_sha256)||membersSha!==undefined&&page.members_sha256!==membersSha
    ||!Number.isSafeInteger(page.original_total)||page.original_total<0||!Number.isSafeInteger(page.total_members)||page.total_members<0
    ||page.total_members>page.original_total||page.offset_members!==offset||offset>page.total_members
    ||!Array.isArray(page.items)||page.items.length!==Math.min(256,page.total_members-offset)
    ||page.items.some((item,index)=>!item||Object.keys(item).sort().join(',')!=='index,path'||item.index!==offset+index
     ||typeof item.path!=='string'||!item.path||item.path.length>32768||item.path.includes('\0'))
    ||(offset+page.items.length<page.total_members?page.next_offset_members!==offset+page.items.length:page.next_offset_members!==undefined))
    throw Error('原搜索成员来源或分页尚未确认');
   if(!controller.signal.aborted)setState({identity,offset,page});
  };
  void load().catch(error=>{
   if(controller.signal.aborted)return;
   const message=error instanceof ApiError&&error.status===404?'此步骤暂无可确认的结构化文件成员记录。'
    :error instanceof ApiError&&error.status===409?'成员来源已变化，请关闭后重新打开。'
    :error instanceof Error?error.message:'原搜索成员读取失败';
   setState({identity,offset,error:message});
  });
  return()=>controller.abort();
 },[identity,offset,resultSha,membersSha,revision]);
 const current=state?.identity===identity&&state.offset===offset?state:undefined,page=current?.page;
 const downloadUrl=(index:number)=>{
  const query=new URLSearchParams({run_id:target.runId,result_sha256:page!.result_sha256,members_sha256:page!.members_sha256,
   ...(target.asOfSeq?{as_of_seq:target.asOfSeq}:{})});
  return `${base}/v1/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(target.activityId)}/tool-result/members/${index}/download?${query}`;
 };
 return <section aria-label="原生搜索文件成员" data-chat-search-ignore>
  <h4>原生搜索文件成员</h4>
  {(!current||!page&&!current.error)&&<p role="status">正在读取原搜索成员…</p>}
  {page&&<>
   <p>按原结果顺序保留路径，合并连续重复路径。原结果共 {page.original_total} {target.toolName==='grep'?'条命中':'条路径'}，保留 {page.total_members} 个成员。</p>
   <p>下载前按原生权限读取并固定打开时的完整内容。原生成员下载共享 512 MiB 临时内容预算，最多同时处理 4 个。</p>
   {page.total_members===0?<p role="status">原搜索没有文件成员。</p>:<ol start={offset+1} style={{maxHeight:'24rem',overflow:'auto'}}>
    {page.items.map(item=><li key={item.index}><code style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.path}</code> <a href={downloadUrl(item.index)} download={item.path.split(/[\\/]/).at(-1)||'file'}
     onClick={event=>{if(taskDraftScope()!==owner)event.preventDefault();}}>下载打开时内容</a></li>)}
   </ol>}
   <nav aria-label="原搜索成员翻页">
    <button type="button" disabled={!currentCursor.previous.length} onClick={()=>setCursor({identity,offset:currentCursor.previous.at(-1)!,previous:currentCursor.previous.slice(0,-1),resultSha:page.result_sha256,membersSha:page.members_sha256})}>上一页成员</button>
    <span>{Math.min(offset+1,page.total_members)}–{offset+page.items.length} / {page.total_members}</span>
    <button type="button" disabled={page.next_offset_members===undefined} onClick={()=>{
     if(page.next_offset_members!==undefined)setCursor({identity,offset:page.next_offset_members,previous:[...currentCursor.previous,offset],resultSha:page.result_sha256,membersSha:page.members_sha256});
    }}>下一页成员</button>
   </nav>
  </>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试读取成员</button></p>}
 </section>;
}
