import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import React,{useEffect,useRef,useState} from 'react';
import {ApiError,abortableDelay,request,taskDraftScope} from './client';
import ActivityToolResult from './ActivityToolResult';
import type {ActivityToolResultMatch,ActivityToolResultSearchPage} from './types';
import type {ActivityReveal} from './activity-presentation';

const id=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const sha=/^[a-f0-9]{64}$/;
const sequence=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9]\d{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
type State={identity:string;items:ActivityToolResultMatch[];scanned:number;unavailable:number;unsearched:number;gap:boolean;loading:boolean;next?:string;error?:string};

export default function ToolResultSearch({conversationId,runId,asOfSeq:latestSeq,query,onRevealActivity}:{conversationId:string;runId?:string;asOfSeq:string;query:string;onRevealActivity:(value:ActivityReveal)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),q=query.trim(),scopeIdentity=JSON.stringify([owner,conversationId,runId,q]);
 // Keep paging stable while live events advance the available search boundary.
 const [snapshot,setSnapshot]=useState({scopeIdentity,seq:latestSeq});
 const asOfSeq=snapshot.scopeIdentity===scopeIdentity?snapshot.seq:latestSeq;
 const identity=JSON.stringify([scopeIdentity,asOfSeq]);
 useEffect(()=>setSnapshot({scopeIdentity,seq:latestSeq}),[scopeIdentity]);
 const [cursor,setCursor]=useState<{identity:string;before?:string;previous:Array<string|undefined>}>({identity,previous:[]});
 const currentCursor:typeof cursor=cursor.identity===identity?cursor:{identity,previous:[]};
 const batchIdentity=JSON.stringify([identity,currentCursor.before]);
 const [state,setState]=useState<State>(),[revision,setRevision]=useState(0);
 const [selected,setSelected]=useState<{identity:string;hit:ActivityToolResultMatch}>();
 const revealVersion=useRef(0),before=currentCursor.before;
 useEffect(()=>setCursor({identity,previous:[]}),[identity]);
 useEffect(()=>{
  const controller=new AbortController(),signal=controller.signal;
  const value:State={identity:batchIdentity,items:[],scanned:0,unavailable:0,unsearched:0,gap:false,loading:true};
  setState({...value,items:[]});setSelected(undefined);
  const load=async()=>{
   if(q.length>200)throw Error('原结果正文搜索词最多支持200个 UTF-16 单元。');
   if(!q||!sequence(asOfSeq)||!id.test(conversationId)||runId!==undefined&&!id.test(runId))throw Error('正文搜索范围尚未确认');
   await abortableDelay(300,signal);
   let boundary=before,nativeSources=true;
   const seen=new Set<string>();
   while(!signal.aborted){
    const params=new URLSearchParams({q,as_of_seq:asOfSeq,...(nativeSources?{native_sources:'true'}:{}),...(runId?{run_id:runId}:{}),...(boundary?{before_seq:boundary}:{})});
    let page:ActivityToolResultSearchPage;
    try{page=await request<ActivityToolResultSearchPage>(`/conversations/${encodeURIComponent(conversationId)}/tool-result-search?${params}`,'GET',undefined,undefined,signal);}
    catch(error){
     if(!(error instanceof ApiError)||error.status!==400||!nativeSources)throw error;
     nativeSources=false;params.delete('native_sources');
     page=await request<ActivityToolResultSearchPage>(`/conversations/${encodeURIComponent(conversationId)}/tool-result-search?${params}`,'GET',undefined,undefined,signal);
    }
    if(signal.aborted)return;
    const through=boundary===undefined?BigInt(asOfSeq):BigInt(boundary)-1n,coverage=page?.coverage;
    if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.run_id!==runId||page.as_of_seq!==asOfSeq||page.q!==q
     ||page.execution_authorized!==false||page.native_sources!==(nativeSources?true:undefined)||!Array.isArray(page.items)||page.items.length>8
     ||!Number.isSafeInteger(page.scanned_upserts)||page.scanned_upserts<page.items.length||page.scanned_upserts>8
     ||!Number.isSafeInteger(page.unavailable_results)||page.unavailable_results<0||page.unavailable_results+page.items.length>page.scanned_upserts
     ||page.unsearched_results!==undefined&&(!Number.isSafeInteger(page.unsearched_results)||page.unsearched_results<0||page.unsearched_results>page.scanned_upserts)
     ||!coverage||!sequence(coverage.from_seq)||!sequence(coverage.through_seq)||!sequence(coverage.event_count)
     ||coverage.from_seq==='0'&&through!==0n||BigInt(coverage.through_seq)!==through||BigInt(coverage.from_seq)>through
     ||BigInt(coverage.event_count)>(through===0n?0n:through-BigInt(coverage.from_seq)+1n)
     ||coverage.complete!==(BigInt(coverage.event_count)===(through===0n?0n:through-BigInt(coverage.from_seq)+1n))
     ||page.next_before_seq!==undefined&&(!sequence(page.next_before_seq)||page.next_before_seq!==coverage.from_seq||page.next_before_seq==='0'
      ||!page.scanned_upserts||seen.has(page.next_before_seq)||boundary!==undefined&&BigInt(page.next_before_seq)>=BigInt(boundary)))throw Error('原结果搜索分页或来源范围尚未确认');
    const pattern=new RegExp(`^(?:${q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')})$`,'iu');
    for(const hit of page.items){
     if(!hit||typeof hit.run_id!=='string'||!id.test(hit.run_id)||typeof hit.activity_id!=='string'||!id.test(hit.activity_id)||runId!==undefined&&hit.run_id!==runId
      ||typeof hit.tool_name!=='string'||!(['jot_workspace','glob','grep'].includes(hit.tool_name)||/^jot_mcp_[a-z0-9_]{1,50}$/.test(hit.tool_name))
      ||hit.native_source!==undefined&&(hit.native_source!==true||!nativeSources||!['glob','grep'].includes(hit.tool_name))
      ||typeof hit.title!=='string'||hit.title.length>256||typeof hit.result_sha256!=='string'||!sha.test(hit.result_sha256)
      ||hit.text_sha256!==undefined&&(typeof hit.text_sha256!=='string'||!sha.test(hit.text_sha256))
      ||['glob','grep'].includes(hit.tool_name)&&hit.text_sha256===undefined
      ||!Number.isSafeInteger(hit.offset_chars)||hit.offset_chars<0||hit.offset_chars>(hit.native_source?33554432:6*1048576)
      ||!Number.isSafeInteger(hit.match_offset_chars)||hit.match_offset_chars>(hit.native_source?33554432:6*1048576)||hit.match_offset_chars<hit.offset_chars||hit.match_offset_chars-hit.offset_chars>61
      ||typeof hit.match_text!=='string'||!hit.match_text.length||hit.match_text.length>200||!pattern.test(hit.match_text)
      ||typeof hit.excerpt!=='string'||hit.excerpt.length>400
      ||hit.excerpt.slice(hit.match_offset_chars-hit.offset_chars,hit.match_offset_chars-hit.offset_chars+hit.match_text.length)!==hit.match_text
      ||value.items.some(prior=>prior.run_id===hit.run_id&&prior.activity_id===hit.activity_id))throw Error('正文搜索命中来源尚未确认');
     value.items.push(hit);
    }
    value.scanned+=page.scanned_upserts;value.unavailable+=page.unavailable_results;value.unsearched+=page.unsearched_results??0;value.gap||=!coverage.complete;
    value.next=page.next_before_seq;
    if(!page.next_before_seq||value.items.length>=64){value.loading=false;setState({...value,items:[...value.items]});return;}
    seen.add(page.next_before_seq);boundary=page.next_before_seq;
    setState({...value,items:[...value.items]});
    await abortableDelay(25,signal);
   }
  };
  void load().catch(error=>{
   if(!signal.aborted)setState({...value,items:[...value.items],loading:false,error:error instanceof Error?error.message:'原结果正文搜索失败'});
  });
  return()=>controller.abort();
 },[batchIdentity,revision]);
 if(!q)return null;
 const current=state?.identity===batchIdentity?state:undefined,hit=selected?.identity===batchIdentity?selected.hit:undefined;
 return <section lang={language} className="jot-tool-result-search" aria-label={t('未打开工具正文搜索','Unopened Tool Body Search')}>
  <div data-chat-search-ignore>
   <h4>{t('原工具结果正文','Original Tool Result Bodies')}</h4>
   <button type="button" onClick={()=>{setSnapshot({scopeIdentity,seq:latestSeq});setCursor({identity,previous:[]});setRevision(value=>value+1);}}>{t('刷新正文搜索','Refresh Body Search')}</button>
   <p role="status">{current?.loading?t('正在搜索原结果正文','Searching original result bodies'):t(`本批命中 ${current?.items.length??0} 条工具正文`,`${current?.items.length??0} matching tool bodies in this batch`)} · {t(`本批已检查 ${current?.scanned??0} 条步骤记录`,`${current?.scanned??0} step records checked in this batch`)}</p>
   <small>{t('搜索固定历史边界内已留存的 MCP 文本、原文件列表及文件、网页读取回执、原生大结果来源和来源可确认的文件变更差异。每条正文列出首处命中，可打开原结果继续查看。','Search retained MCP text, original file lists and files, web-reading receipts, native large-result sources and file changes with verified sources within a fixed history boundary. Each body shows its first match. Open the original result to read more.')}</small>
   {Boolean(current?.unavailable)&&<p role="status">{t(`本批有 ${current!.unavailable} 条步骤暂无可确认的结果正文。`,`${current!.unavailable} steps in this batch have no verifiable result body available.`)}</p>}
   {Boolean(current?.unsearched)&&<p role="status">{t(`本批有 ${current!.unsearched} 条结果含尚未纳入搜索的文件内容、原生行预览范围或后续列表记录。`,`${current!.unsearched} results in this batch contain file content, native line-preview ranges or later list records not yet included in search.`)}</p>}
   {current?.gap&&<p role="status">{t('原事件历史存在保留缺口，搜索覆盖当前可读取的记录。','Original event history has retention gaps. Search covers the records currently available.')}</p>}
   <ol>{current?.items.map(item=><li key={JSON.stringify([item.run_id,item.activity_id])}>
    <p>{item.title} · {item.tool_name}</p><p className="jot-history-search-excerpt">{item.excerpt}</p>
    <button type="button" onClick={()=>setSelected({identity:batchIdentity,hit:item})}>{t('查看命中正文','View Matching Body')}</button>
    <button type="button" onClick={()=>onRevealActivity({activityId:item.activity_id,key:JSON.stringify([identity,item.activity_id,++revealVersion.current])})}>{t('定位工具步骤','Locate Tool Step')}</button>
   </li>)}</ol>
   <nav aria-label={t('原工具正文搜索翻页','Original Tool Body Search Pages')}>
    <button type="button" disabled={!current||current.loading||!currentCursor.previous.length} onClick={()=>{
     const previous=currentCursor.previous.slice(0,-1),prior=currentCursor.previous.at(-1);
     setCursor({identity,before:prior,previous});
    }}>{t('上一批命中','Previous Result Batch')}</button>
    <button type="button" disabled={!current||current.loading||!current?.next} onClick={()=>{
     if(current?.next)setCursor({identity,before:current.next,previous:[...currentCursor.previous,before]});
    }}>{t('搜索更早正文','Search Earlier Bodies')}</button>
   </nav>
   {current?.error&&<p role="alert">{conversationUiError(current.error,language)} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('重新搜索本批','Search This Batch Again')}</button></p>}
   {hit&&<button type="button" onClick={()=>setSelected(undefined)}>{t('关闭命中正文','Close Matching Body')}</button>}
  </div>
  {hit&&<ConversationDisplayBoundary key={JSON.stringify([identity,hit])} label={t('命中工具正文','Matching Tool Body')}><div lang="zh-CN"><ActivityToolResult conversationId={conversationId}
   target={{...(hit.native_source?{nativeSource:true,asOfSeq}:{}),runId:hit.run_id,activityId:hit.activity_id,toolName:hit.tool_name,offset:hit.offset_chars,resultSha:hit.result_sha256,textSha:hit.text_sha256,
    match:{offset:hit.match_offset_chars,text:hit.match_text}}}/></div></ConversationDisplayBoundary>}
 </section>;
}
