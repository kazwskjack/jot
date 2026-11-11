import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import ConversationDisplayBoundary from './ConversationDisplayBoundary';
import React,{useEffect,useState} from 'react';
import {abortableDelay,request,taskDraftScope} from './client';
import {InteractionHistorySelection} from './InteractionHistory';
import type {InteractionSearchBoundary,InteractionSearchMatch,InteractionSearchPage} from './types';

const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const validBoundary=(value:InteractionSearchBoundary)=>value&&typeof value.interaction_id==='string'&&id.test(value.interaction_id)
 &&typeof value.created_at==='string'&&Number.isFinite(Date.parse(value.created_at));
const older=(value:InteractionSearchBoundary,before:InteractionSearchBoundary)=>value.created_at<before.created_at
 ||value.created_at===before.created_at&&value.interaction_id<before.interaction_id;
type State={identity:string;items:InteractionSearchMatch[];scanned:number;loading:boolean;next?:InteractionSearchBoundary;error?:string};

export default function InteractionSearch({conversationId,runId,query}:{conversationId:string;runId?:string;query:string}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),q=query.trim(),identity=JSON.stringify([owner,conversationId,runId,q]);
 const [cursor,setCursor]=useState<{identity:string;before?:InteractionSearchBoundary;previous:Array<InteractionSearchBoundary|undefined>}>({identity,previous:[]});
 const currentCursor:typeof cursor=cursor.identity===identity?cursor:{identity,previous:[]};
 const before=currentCursor.before,batchIdentity=JSON.stringify([identity,before]);
 const [state,setState]=useState<State>(),[revision,setRevision]=useState(0);
 const [selected,setSelected]=useState<{identity:string;hit:InteractionSearchMatch}>();
 useEffect(()=>setCursor({identity,previous:[]}),[identity]);
 useEffect(()=>{
  const controller=new AbortController(),signal=controller.signal;
  const value:State={identity:batchIdentity,items:[],scanned:0,loading:true};
  setState({...value,items:[]});setSelected(undefined);
  const load=async()=>{
   if(!q||q.length>200)throw Error('交互正文搜索词支持1至200个 UTF-16 单元。');
   await abortableDelay(300,signal);
   let boundary=before;
   const seen=new Set<string>();
   const pattern=new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'iu');
   while(!signal.aborted){
    const params=new URLSearchParams({q,...(runId?{run_id:runId}:{}),...(boundary?{cursor:boundary.interaction_id}:{})});
    const page=await request<InteractionSearchPage>(`/conversations/${encodeURIComponent(conversationId)}/interaction-search?${params}`,'GET',undefined,undefined,signal);
    if(signal.aborted)return;
    const through=page?.scanned_through;
    if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.run_id!==runId||page.q!==q||page.execution_authorized!==false
     ||!Array.isArray(page.items)||page.items.length>10||!Number.isSafeInteger(page.scanned_records)
     ||page.scanned_records<page.items.length||page.scanned_records>10
     ||(page.scanned_records===0?through!==undefined:!through||!validBoundary(through)||boundary!==undefined&&!older(through,boundary))
     ||page.next_cursor!==undefined&&(!through||page.next_cursor!==through.interaction_id||page.scanned_records!==10||seen.has(page.next_cursor)))throw Error('原交互搜索分页或来源范围尚未确认');
    let prior=boundary;
    for(const hit of page.items){
     if(!validBoundary(hit)||typeof hit.run_id!=='string'||!id.test(hit.run_id)||runId!==undefined&&hit.run_id!==runId
      ||!['question','approval'].includes(hit.kind)||!['pending','answered','denied','cancelled','expired'].includes(hit.status)
      ||!Number.isSafeInteger(hit.version)||hit.version<1||prior!==undefined&&!older(hit,prior)
      ||!through||older(hit,through)||typeof hit.match_text!=='string'||!hit.match_text.length||hit.match_text.length>200
      ||!pattern.test(hit.match_text)||typeof hit.excerpt!=='string'||hit.excerpt.length>400||!hit.excerpt.includes(hit.match_text)
      ||value.items.some(item=>item.interaction_id===hit.interaction_id))throw Error('交互搜索命中身份或版本尚未确认');
     value.items.push(hit);prior=hit;
    }
    value.scanned+=page.scanned_records;value.next=page.next_cursor?through:undefined;
    if(!page.next_cursor||value.items.length>=64){value.loading=false;setState({...value,items:[...value.items]});return;}
    seen.add(page.next_cursor);boundary=through;
    setState({...value,items:[...value.items]});
    await abortableDelay(25,signal);
   }
  };
  void load().catch(error=>{if(!signal.aborted)setState({...value,items:[...value.items],loading:false,error:error instanceof Error?error.message:'原交互正文搜索失败'});});
  return()=>controller.abort();
 },[batchIdentity,revision]);
 if(!q)return null;
 const current=state?.identity===batchIdentity?state:undefined,hit=selected?.identity===batchIdentity?selected.hit:undefined;
 return <section lang={language} className="jot-interaction-search" aria-label={t('未打开交互记录搜索','Unopened Interaction Record Search')}>
  <div data-chat-search-ignore>
   <h4>{t('问题与确认记录正文','Question and Approval Record Bodies')}</h4>
   <button type="button" onClick={()=>{setCursor({identity,previous:[]});setRevision(value=>value+1);}}>{t('刷新交互搜索','Refresh Interaction Search')}</button>
   <p role="status">{current?.loading?t('正在搜索交互正文','Searching interaction bodies'):t(`本批命中 ${current?.items.length??0} 条交互记录`,`${current?.items.length??0} matching interaction records in this batch`)} · {t(`本批已检查 ${current?.scanned??0} 条记录`,`${current?.scanned??0} records checked in this batch`)}</p>
   <small>{t('搜索问题、选项、已保存回答和确认说明。每条记录列出首处命中，打开时核对检索版本；刷新可读取新记录及后续更新。','Search questions, options, saved answers and approval descriptions. Each record shows its first match, and its search version is verified when opened. Refresh to read new records and later updates.')}</small>
   <ol>{current?.items.map(item=><li key={item.interaction_id}>
    <p>{item.kind==='question'?t('问题记录','Question Record'):t('确认记录','Approval Record')} · {item.created_at} · {t('版本','Version')} {item.version}</p>
    <p className="jot-history-search-excerpt">{item.excerpt}</p>
    <button type="button" onClick={()=>setSelected({identity:batchIdentity,hit:item})}>{t('查看命中交互','View Matching Interaction')}</button>
   </li>)}</ol>
   <nav aria-label={t('交互正文搜索翻页','Interaction Body Search Pages')}>
    <button type="button" disabled={!current||current.loading||!currentCursor.previous.length} onClick={()=>{
     const previous=currentCursor.previous.slice(0,-1),prior=currentCursor.previous.at(-1);
     setCursor({identity,before:prior,previous});
    }}>{t('上一批命中','Previous Result Batch')}</button>
    <button type="button" disabled={!current||current.loading||!current.next} onClick={()=>{
     if(current?.next)setCursor({identity,before:current.next,previous:[...currentCursor.previous,before]});
    }}>{t('搜索更早交互','Search Earlier Interactions')}</button>
   </nav>
   {current?.error&&<p role="alert">{conversationUiError(current.error,language)} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('重新搜索本批','Search This Batch Again')}</button></p>}
   {hit&&<button type="button" onClick={()=>setSelected(undefined)}>{t('关闭命中交互','Close Matching Interaction')}</button>}
  </div>
  {hit&&<ConversationDisplayBoundary key={JSON.stringify([batchIdentity,hit.interaction_id,hit.version])} label={t('命中交互详情','Matching Interaction Details')}><div lang="zh-CN"><InteractionHistorySelection
   conversationId={conversationId} interactionId={hit.interaction_id} runId={hit.run_id} version={hit.version} highlight={q}/></div></ConversationDisplayBoundary>}
 </section>;
}
