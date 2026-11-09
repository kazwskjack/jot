import React,{useEffect,useState} from 'react';
import {ApiError,abortableDelay,request,taskDraftScope} from './client';
import ArtifactTextResult from './ArtifactTextResult';
import ActivityArtifactDetails from './ActivityArtifactDetails';
import type {ActivityArtifactTarget} from './activity-presentation';
import type {ArtifactTextCursor,ArtifactTextMatch,ArtifactTextSearchPage} from './types';

const id=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const sha=/^[a-f0-9]{64}$/;
const validCursor=(value:ArtifactTextCursor)=>value&&typeof value.artifact_id==='string'&&id.test(value.artifact_id)&&Number.isSafeInteger(value.version)&&value.version>0
 &&(value.part_index===undefined?value.group_sha256===undefined:value.version===1&&Number.isSafeInteger(value.part_index)&&value.part_index>=1&&value.part_index<=50&&typeof value.group_sha256==='string'&&sha.test(value.group_sha256));
const cursorKey=(value:ArtifactTextCursor)=>JSON.stringify([value.artifact_id,value.version,value.part_index??null,value.group_sha256??null]);
type State={identity:string;items:ArtifactTextMatch[];scanned:number;unavailable:number;skipped:number;loading:boolean;next?:ArtifactTextCursor;error?:string};

export default function ArtifactTextSearch({conversationId,runId,query}:{conversationId:string;runId?:string;query:string}){
 const owner=taskDraftScope(),q=query.trim(),identity=JSON.stringify([owner,conversationId,runId,q]);
 const [cursor,setCursor]=useState<{identity:string;before?:ArtifactTextCursor;previous:Array<ArtifactTextCursor|undefined>}>({identity,previous:[]});
 const currentCursor:typeof cursor=cursor.identity===identity?cursor:{identity,previous:[]};
 const before=currentCursor.before,batchIdentity=JSON.stringify([identity,before]);
 const [state,setState]=useState<State>(),[revision,setRevision]=useState(0);
 const [selected,setSelected]=useState<{identity:string;hit:ArtifactTextMatch}>(),[fileTarget,setFileTarget]=useState<ActivityArtifactTarget>();
 useEffect(()=>setCursor({identity,previous:[]}),[identity]);
 useEffect(()=>{
  const controller=new AbortController(),signal=controller.signal;
  const value:State={identity:batchIdentity,items:[],scanned:0,unavailable:0,skipped:0,loading:true};
  setState({...value,items:[]});setSelected(undefined);setFileTarget(undefined);
  const load=async()=>{
   if(!q||q.length>200)throw Error('文件正文搜索词支持1至200个 UTF-16 单元。');
   await abortableDelay(300,signal);
   let boundary=before;const seen=new Set<string>();
   while(!signal.aborted){
    const params=new URLSearchParams({q,parts_protocol:'1',document_protocol:'1',...(runId?{run_id:runId}:{}),...(boundary?{cursor_artifact_id:boundary.artifact_id,cursor_version:String(boundary.version),...(boundary.part_index===undefined?{}:{cursor_part_index:String(boundary.part_index),cursor_group_sha256:boundary.group_sha256!})}:{})});
    const page=await request<ArtifactTextSearchPage>(`/conversations/${encodeURIComponent(conversationId)}/artifact-search?${params}`,'GET',undefined,undefined,signal,120000);
    if(signal.aborted)return;
    if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.run_id!==runId||page.q!==q||page.execution_authorized!==false
     ||!Array.isArray(page.items)||page.items.length>1||!Number.isSafeInteger(page.scanned_versions)||page.scanned_versions<page.items.length||page.scanned_versions>1
     ||!Number.isSafeInteger(page.unavailable_versions)||page.unavailable_versions<0||!Number.isSafeInteger(page.skipped_versions)||page.skipped_versions<0
     ||page.items.length+page.unavailable_versions+page.skipped_versions>page.scanned_versions
     ||page.next_cursor!==undefined&&(!validCursor(page.next_cursor)||page.scanned_versions!==1||seen.has(cursorKey(page.next_cursor))
      ||boundary!==undefined&&cursorKey(page.next_cursor)===cursorKey(boundary)))throw Error('原文件搜索分页或范围尚未确认');
    for(const hit of page.items){
     const textSize=hit.document_job_id===undefined?hit.size_bytes:hit.text_total_chars!;
     if(!validCursor(hit)||typeof hit.sha256!=='string'||!sha.test(hit.sha256)||typeof hit.file_name!=='string'
      ||!Number.isSafeInteger(hit.size_bytes)||hit.size_bytes<0||typeof hit.created_at!=='string'||!Number.isFinite(Date.parse(hit.created_at))
      ||(hit.document_job_id===undefined
       ?hit.document_result_sha256!==undefined||hit.text_sha256!==undefined||hit.text_total_chars!==undefined||hit.source_truncated!==undefined
       :typeof hit.document_job_id!=='string'||!id.test(hit.document_job_id)||hit.part_index!==undefined
        ||typeof hit.document_result_sha256!=='string'||!sha.test(hit.document_result_sha256)||typeof hit.text_sha256!=='string'||!sha.test(hit.text_sha256)
        ||!Number.isSafeInteger(hit.text_total_chars)||Number(hit.text_total_chars)<0||Number(hit.text_total_chars)>200000||typeof hit.source_truncated!=='boolean')
      ||!Number.isSafeInteger(hit.offset_chars)||hit.offset_chars<0||hit.offset_chars>textSize
      ||!Number.isSafeInteger(hit.match_offset_chars)||hit.match_offset_chars<hit.offset_chars||hit.match_offset_chars-hit.offset_chars>61
      ||typeof hit.match_text!=='string'||!hit.match_text.length||hit.match_text.length>200||hit.match_offset_chars+hit.match_text.length>textSize
      ||typeof hit.excerpt!=='string'||hit.excerpt.length>400
      ||hit.excerpt.slice(hit.match_offset_chars-hit.offset_chars,hit.match_offset_chars-hit.offset_chars+hit.match_text.length)!==hit.match_text
      ||value.items.some(item=>cursorKey(item)===cursorKey(hit)))throw Error('原文件搜索命中来源尚未确认');
     value.items.push(hit);
    }
    value.scanned+=page.scanned_versions;value.unavailable+=page.unavailable_versions;value.skipped+=page.skipped_versions;value.next=page.next_cursor;
    if(!page.next_cursor||value.items.length>=64){value.loading=false;setState({...value,items:[...value.items]});return;}
    seen.add(cursorKey(page.next_cursor));boundary=page.next_cursor;
    setState({...value,items:[...value.items]});await abortableDelay(25,signal);
   }
  };
  void load().catch(error=>{if(!signal.aborted)setState({...value,items:[...value.items],loading:false,error:error instanceof ApiError&&error.status===409?'原文件或分卷清单已更新，请刷新文件搜索。':error instanceof Error?error.message:'原文件正文搜索失败'});});
  return()=>controller.abort();
 },[batchIdentity,revision]);
 if(!q)return null;
 const current=state?.identity===batchIdentity?state:undefined,hit=selected?.identity===batchIdentity?selected.hit:undefined;
 return <section className="jot-artifact-text-search" aria-label="未打开文件正文搜索">
  <div data-chat-search-ignore>
   <h4>原文件版本正文</h4>
   <button type="button" onClick={()=>{setCursor({identity,previous:[]});setRevision(value=>value+1);}}>刷新文件搜索</button>
   <p role="status">{current?.loading?'正在读取并检索原文件':`本批命中 ${current?.items.length??0} 个文件版本/分卷`} · 本批已检查 {current?.scanned??0} 个原版本/分卷</p>
   <small>检索本地文本原版本、单卷和已有的文档预览，每个来源列出首处命中。成员范围只包含原运行实际引用或产生的版本。</small>
   {Boolean(current?.unavailable)&&<p role="status">本批有 {current!.unavailable} 个版本/分卷暂不可读取或未通过内容核对。</p>}
   {Boolean(current?.skipped)&&<p role="status">本批有 {current!.skipped} 个版本/分卷为其他格式或尚无已保存文档预览，未计入正文匹配。</p>}
   <ol>{current?.items.map(item=><li key={cursorKey(item)}>
    <p>{item.file_name} · 版本 {item.version}{item.part_index===undefined?'':` · 第 ${item.part_index} 卷`}{item.document_job_id?' · 已保存文档预览':''}</p><p className="jot-history-search-excerpt">{item.excerpt}</p>
    <button type="button" onClick={()=>{setSelected({identity:batchIdentity,hit:item});setFileTarget(undefined);}}>查看命中文本</button>
    <button type="button" onClick={()=>{setSelected({identity:batchIdentity,hit:item});setFileTarget({kind:'file',artifactId:item.artifact_id,label:item.file_name,version:item.version,sha256:item.sha256,...(item.part_index===undefined?{}:{partIndex:item.part_index})});}}>查看文件与版本</button>
   </li>)}</ol>
   <nav aria-label="原文件正文搜索翻页">
    <button type="button" disabled={!current||current.loading||!currentCursor.previous.length} onClick={()=>{
     const previous=currentCursor.previous.slice(0,-1),prior=currentCursor.previous.at(-1);setCursor({identity,before:prior,previous});
    }}>上一批命中</button>
    <button type="button" disabled={!current||current.loading||!current.next} onClick={()=>{
     if(current?.next)setCursor({identity,before:current.next,previous:[...currentCursor.previous,before]});
    }}>搜索更早版本</button>
   </nav>
   {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重新搜索本批</button></p>}
   {hit&&<button type="button" onClick={()=>{setSelected(undefined);setFileTarget(undefined);}}>关闭命中文件</button>}
  </div>
  {hit&&(fileTarget?<ActivityArtifactDetails key={JSON.stringify([batchIdentity,fileTarget])} conversationId={conversationId} target={fileTarget} onOpen={setFileTarget}/>
   :<ArtifactTextResult key={JSON.stringify([batchIdentity,hit])} conversationId={conversationId} runId={runId} target={hit}/>)}
 </section>;
}
