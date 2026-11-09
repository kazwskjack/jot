// Search interaction and IME handling adapted from PilotDeck 783499ff,
// ChatHistorySearchBar.tsx/useChatHistorySearch.ts. Adapted portions are AGPL-3.0.
import React,{useEffect,useId,useMemo,useRef,useState,type RefObject} from 'react';
import {request} from './client';
import type {Message,MessagePage,Activity} from './types';
import {activitySearchText,type ActivityReveal,type ActivityRun,type ToolActivity} from './activity-presentation';
import ToolResultSearch from './ToolResultSearch';
import InteractionSearch from './InteractionSearch';
import './conversation-history-search.css';

type ContentDocument={kind:'content';id:string;text:string};
const sourceLabels={activity:'工具步骤',message:'消息正文',content:'已加载内容'};
const searchAttributes={activity:'data-chat-search-activity',message:'data-chat-search-message',content:'data-chat-search-content'};
type SearchDocument={element:HTMLElement;text:string;nodes:Array<{node:Text;start:number;end:number}>};
type SharedProps={
 root:RefObject<HTMLElement|null>;
 activities:Activity[];
 runs:Record<string,ActivityRun>;
 onRevealActivity:(request:ActivityReveal)=>void;
 onLoadActivityHistory:()=>void;
 activityHistorySeq?:string;
 resultSearchSeq?:string;
 renderedRevision:unknown;
 ready:boolean;
};
type Props=SharedProps&({
 scope?:'conversation';
 conversationId:string;
 messages:Message[];
 revealedMessageId:string;
 onReveal:(messageId:string)=>void;
 historyComplete?:boolean;
 historyCursor?:string;
 onHistoryLoaded:(messages:Message[])=>void;
}|{scope:'activities';conversationId:string;runId:string});
const EMPTY_MESSAGES:Message[]=[];

function readSearchDocument(element:HTMLElement,visibleOnly=false):SearchDocument{
 const nodes:SearchDocument['nodes']=[],walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
 let text='',previousBlock:Element|null=null;
 while(walker.nextNode()){
  const node=walker.currentNode as Text;
  if(node.parentElement?.closest('script,style,[aria-hidden="true"],[data-chat-search-ignore]'))continue;
  if(visibleOnly){
   let parent:Element|null=node.parentElement;let hidden=false;
   while(parent){
    if(parent.tagName==='DETAILS'&&!parent.hasAttribute('open')&&!parent.querySelector(':scope > summary')?.contains(node)){hidden=true;break;}
    parent=parent.parentElement;
   }
   if(hidden)continue;
  }
  const block=node.parentElement?.closest('p,pre,li,h1,h2,h3,h4,h5,h6,td,th,dt,dd')??null;
  if(nodes.length&&block!==previousBlock)text+='\n';
  previousBlock=block;
  const start=text.length;
  text+=node.data;
  nodes.push({node,start,end:text.length});
 }
 return {element,text,nodes};
}

function searchPattern(query:string){return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');}

export default function ConversationHistorySearch(props:Props){
 const {root,activities,runs,onRevealActivity,onLoadActivityHistory,activityHistorySeq,renderedRevision,ready}=props;
 const conversation=props.scope==='activities'?undefined:props;
 const conversationId=conversation?.conversationId,messages=conversation?.messages??EMPTY_MESSAGES;
 const revealedMessageId=conversation?.revealedMessageId??'',onReveal=conversation?.onReveal;
 const historyComplete=conversation?.historyComplete,historyCursor=conversation?.historyCursor,onHistoryLoaded=conversation?.onHistoryLoaded;
 const activityOnly=props.scope==='activities';
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(''),[query,setQuery]=useState('');
 const [index,setIndex]=useState(0),[navigationVersion,setNavigationVersion]=useState(0);
 const [contentDocuments,setContentDocuments]=useState<ContentDocument[]>([]);
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const input=useRef<HTMLInputElement>(null),opener=useRef<HTMLButtonElement>(null);
 const composing=useRef(false),compositionEnded=useRef(0),cursor=useRef<string>(),complete=useRef(false);
 const pages=useRef<Message[][]>([]);
 const pageCallback=useRef(onHistoryLoaded),lastReveal=useRef('');
 pageCallback.current=onHistoryLoaded;
 const highlightName=`jot-chat-search-${useId().replace(/[^a-z0-9-]/gi,'')}`;
 const needle=query.trim();
 useEffect(()=>{if(open)onLoadActivityHistory();},[open,activityHistorySeq,onLoadActivityHistory]);
 useEffect(()=>{
  cursor.current=historyCursor;
  complete.current=historyComplete===true;
  pages.current=[];
  if(complete.current)pageCallback.current?.([]);
  setError('');
 },[conversationId,historyCursor,historyComplete]);

 useEffect(()=>{
  if(!conversationId||!open||!ready||complete.current)return;
  const abort=new AbortController(),seen=new Set<string>();
  setLoading(true);setError('');
  void(async()=>{
   try{
    if(!cursor.current)throw Error('快照未提供更早历史边界，请刷新会话后继续');
    while(!abort.signal.aborted){
     const boundary=cursor.current;
     const path=`/conversations/${encodeURIComponent(conversationId)}/messages?limit=200${boundary?`&cursor=${encodeURIComponent(boundary)}`:''}`;
     const page=await request<MessagePage>(path,'GET',undefined,undefined,abort.signal);
     if(abort.signal.aborted)return;
     if(!page||!Array.isArray(page.items)||page.items.length>200
      ||page.items.some(message=>!message||typeof message.message_id!=='string'||!message.message_id||!Array.isArray(message.blocks))
      ||new Set(page.items.map(message=>message.message_id)).size!==page.items.length
      ||(page.next_cursor!==undefined&&(typeof page.next_cursor!=='string'||!page.next_cursor||page.next_cursor===boundary||seen.has(page.next_cursor)||!page.items.length)))throw Error('历史分页结果尚未确认');
     pages.current.push(page.items);
     cursor.current=page.next_cursor;
     if(!page.next_cursor){
      const history=pages.current.slice().reverse().flat();
      if(new Set(history.map(message=>message.message_id)).size!==history.length)throw Error('历史分页出现重复消息，请刷新会话后继续');
      pageCallback.current?.(history);pages.current=[];complete.current=true;return;
     }
     seen.add(page.next_cursor);
    }
   }catch(cause){if(!abort.signal.aborted)setError(cause instanceof Error?cause.message:'历史消息加载失败');}
   finally{if(!abort.signal.aborted)setLoading(false);}
  })();
  return()=>{abort.abort();setLoading(false);};
 },[open,ready,conversationId,retry,historyCursor,historyComplete]);

 useEffect(()=>{
  if(!open||!ready){setContentDocuments([]);return;}
  let frame:number|undefined;
  const collect=()=>{
   frame=undefined;const container=root.current,documents:ContentDocument[]=[];
   for(const element of container?.querySelectorAll<HTMLElement>('[data-chat-search-content]')??[]){
    const scope=element.closest('[data-chat-search-scope]'),id=element.getAttribute('data-chat-search-content');
    if(!id||scope&&scope!==container||element.closest('[data-chat-search-ignore]')||!element.getClientRects().length)continue;
    documents.push({kind:'content',id,text:readSearchDocument(element,true).text});
   }
   setContentDocuments(previous=>previous.length===documents.length&&previous.every((value,index)=>value.id===documents[index]!.id&&value.text===documents[index]!.text)?previous:documents);
  };
  const schedule=()=>{if(frame===undefined)frame=requestAnimationFrame(collect);};
  const observer=new MutationObserver(schedule),container=root.current;
  if(container)observer.observe(container,{subtree:true,childList:true,characterData:true,attributes:true,
   attributeFilter:['open','hidden','data-chat-search-content','data-chat-search-ready']});
  schedule();
  return()=>{observer.disconnect();if(frame!==undefined)cancelAnimationFrame(frame);};
 },[open,ready,root]);

 const results=useMemo(()=>{
  if(!needle)return [];
  const pattern=searchPattern(needle);
  const sources:Array<{kind:'message'|'activity'|'content';id:string;text:string}>=[
   ...activities.filter((activity):activity is ToolActivity=>activity.kind!=='compaction')
    .sort((a,b)=>a.started_at.localeCompare(b.started_at)||a.activity_id.localeCompare(b.activity_id))
    .map(activity=>({kind:'activity' as const,id:activity.activity_id,text:activitySearchText(activity,runs[activity.run_id])})),
   ...contentDocuments,
   ...messages.map(message=>({kind:'message' as const,id:message.message_id,
    text:message.blocks.filter(block=>block.kind==='text').map(block=>block.text).join('\n')})),
  ];
  return sources.map(source=>{
   pattern.lastIndex=0;
   let count=0;
   while(pattern.exec(source.text))count++;
   return {...source,count};
  }).filter(result=>result.count>0);
 },[messages,activities,runs,contentDocuments,needle]);
 const total=results.reduce((sum,result)=>sum+result.count,0),activeIndex=Math.min(index,Math.max(0,total-1));
 const active=useMemo(()=>{
  let remaining=activeIndex;
  for(const result of results){
   if(remaining>=result.count){remaining-=result.count;continue;}
   const pattern=searchPattern(needle);
   let match:RegExpExecArray|null=null;
   for(let occurrence=0;occurrence<=remaining;occurrence++)match=pattern.exec(result.text);
   if(match)return {source:result,occurrence:remaining,offset:match.index,length:match[0].length};
  }
  return null;
 },[results,activeIndex,needle]);

 const activeKind=active?.source.kind,activeId=active?.source.id;
 const revealKey=active?JSON.stringify([highlightName,navigationVersion,activeKind,activeId,query,active.offset]):'';
 useEffect(()=>{
  if(!open||!activeId)return;
  if(activeKind==='activity')onRevealActivity({activityId:activeId,key:revealKey});
  else if(activeKind==='message'&&!loading)onReveal?.(activeId);
 },[open,activeKind,activeId,revealKey,loading,onReveal,onRevealActivity]);
 useEffect(()=>{
  if(!open||!active)return;
  let frame:number|undefined,marked:HTMLElement|undefined;
  const registry=(globalThis as unknown as {CSS?:{highlights?:Map<string,unknown>}}).CSS?.highlights;
  const HighlightClass=(globalThis as unknown as {Highlight?:new(...ranges:Range[])=>unknown}).Highlight;
  const clear=()=>{registry?.delete(highlightName);marked?.removeAttribute('data-chat-search-active');marked=undefined;};
  const refresh=()=>{
   frame=undefined;clear();
   const attribute=searchAttributes[active.source.kind],selector=`[${attribute}]`;
   const element=Array.from(root.current?.querySelectorAll<HTMLElement>(selector)??[])
    .find(node=>{
     const scope=node.closest('[data-chat-search-scope]');
     return (!scope||scope===root.current)&&node.getAttribute(attribute)===active.source.id;
    });
   if(!element||element.dataset.chatSearchReady==='false'||!element.getClientRects().length)return;
   const source=readSearchDocument(element,active.source.kind==='content'),pattern=searchPattern(needle);
   let visibleMatch:RegExpExecArray|null=null;
   for(let occurrence=0;occurrence<=active.occurrence;occurrence++){
    visibleMatch=pattern.exec(source.text);
    if(!visibleMatch)break;
   }
   let range:Range|undefined;
   if(visibleMatch){
    const offset=visibleMatch.index,endOffset=offset+visibleMatch[0].length;
    const start=source.nodes.find(entry=>entry.end>offset),end=source.nodes.find(entry=>entry.end>=endOffset);
    if(start&&end){
     range=document.createRange();
     range.setStart(start.node,Math.max(0,Math.min(start.node.length,offset-start.start)));
     range.setEnd(end.node,Math.max(0,Math.min(end.node.length,endOffset-end.start)));
    }
   }
   if(range&&registry&&HighlightClass)registry.set(highlightName,new HighlightClass(range));
   element.setAttribute('data-chat-search-active','true');marked=element;
   const ready=active.source.kind!=='message'||(!loading&&revealedMessageId===active.source.id);
   if(ready&&lastReveal.current!==revealKey){
    lastReveal.current=revealKey;
    const targetRect=()=>{
     const rect=range?.getBoundingClientRect();
     return rect&&(rect.width||rect.height)?rect:element.getBoundingClientRect();
    };
    const rangeNode=range?.startContainer;
    let container:HTMLElement|null=rangeNode instanceof HTMLElement?rangeNode:rangeNode?.parentElement??element;
    while(container){
     if(container.scrollHeight>container.clientHeight&&/(auto|scroll)/.test(getComputedStyle(container).overflowY)){
      const bounds=container.getBoundingClientRect(),rect=targetRect();
      container.scrollBy({top:rect.top-bounds.top-container.clientHeight/2,behavior:'auto'});
     }
     container=container.parentElement;
    }
    const rect=targetRect();
    const behavior=window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth';
    window.scrollBy({top:rect.top-window.innerHeight/2,behavior});
   }
  };
  const schedule=()=>{if(frame===undefined)frame=requestAnimationFrame(refresh);};
  const observer=new MutationObserver(schedule),container=root.current;
  if(container)observer.observe(container,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['open','data-chat-search-ready']});
  schedule();
  return()=>{observer.disconnect();if(frame!==undefined)cancelAnimationFrame(frame);clear();};
 },[open,active,needle,root,highlightName,loading,renderedRevision,revealedMessageId,revealKey]);

 const changeQuery=(value:string)=>{setQuery(value);setIndex(0);setNavigationVersion(version=>version+1);};
 const close=()=>{setOpen(false);setDraft('');changeQuery('');lastReveal.current='';opener.current?.focus();};
 const navigate=(direction:number)=>{if(total){setIndex((activeIndex+direction+total)%total);setNavigationVersion(version=>version+1);}};
 const openSearch=()=>{if(!ready)return;setOpen(true);if(open){input.current?.focus();input.current?.select();}else setNavigationVersion(version=>version+1);};
 useEffect(()=>{if(open)input.current?.focus();},[open]);
 useEffect(()=>{
  const container=root.current;
  const keydown=(event:KeyboardEvent)=>{
   if(!ready||event.isComposing||event.keyCode===229||event.defaultPrevented)return;
   if(event.target instanceof Element){
    if(event.target.closest('[role="dialog"]'))return;
    const scope=event.target.closest('[data-chat-search-scope]');
    if(scope&&scope!==container)return;
   }
   if((event.ctrlKey||event.metaKey)&&!event.altKey&&event.key.toLowerCase()==='f'){
    event.preventDefault();openSearch();
   }else if(open&&event.key==='F3'){
    event.preventDefault();navigate(event.shiftKey?-1:1);
   }
  };
  container?.addEventListener('keydown',keydown);
  return()=>container?.removeEventListener('keydown',keydown);
 });

 return <div className="jot-history-search">
  <style>{`::highlight(${highlightName}){background:#f4cd54;color:#151515}`}</style>
  <button ref={opener} type="button" aria-expanded={open} disabled={!ready} onClick={openSearch}>{activityOnly?'搜索公开记录':'搜索当前会话'}</button>
  {open&&<div role="search" aria-label={activityOnly?'公开记录搜索':'会话历史搜索'}>
   <input ref={input} type="search" aria-label={activityOnly?'搜索公开记录':'搜索会话内容'} placeholder={activityOnly?'搜索公开记录…':'搜索会话内容…'} value={draft} autoComplete="off" spellCheck={false}
    onChange={event=>{setDraft(event.currentTarget.value);if(!composing.current){changeQuery(event.currentTarget.value);}}}
    onCompositionStart={()=>{composing.current=true;compositionEnded.current=0;}}
    onCompositionEnd={event=>{composing.current=false;compositionEnded.current=Date.now();setDraft(event.currentTarget.value);changeQuery(event.currentTarget.value);}}
    onKeyDown={event=>{
     if(composing.current||event.nativeEvent.isComposing||event.keyCode===229)return;
     if(event.key==='Enter'&&Date.now()-compositionEnded.current>=150){event.preventDefault();navigate(event.shiftKey?-1:1);}
     if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
    }}/>
   <span role="status" aria-live="polite">{needle?(total?`${activeIndex+1} / ${total}`:'没有匹配结果'):'输入搜索词'}{loading?' · 正在加载完整历史':''}</span>
   <button type="button" disabled={!total} onClick={()=>navigate(-1)}>上一个结果</button>
   <button type="button" disabled={!total} onClick={()=>navigate(1)}>下一个结果</button>
   <button type="button" onClick={close}>关闭搜索</button>
   {active&&<p className="jot-history-search-excerpt">{sourceLabels[active.source.kind]} · {active.source.text.slice(Math.max(0,active.offset-60),active.offset+active.length+60)}</p>}
   <small>{activityOnly?'搜索范围为已加载的公开记录。步骤历史的加载进度和保留缺口显示在时间线上方。':'公开步骤历史的加载进度和保留缺口显示在时间线上方。'} 文件预览参与已打开内容搜索，未打开的工具正文和交互记录另列检索结果。</small>
   {(props.resultSearchSeq??activityHistorySeq)&&ready&&needle&&<ToolResultSearch conversationId={props.conversationId} asOfSeq={(props.resultSearchSeq??activityHistorySeq)!}
    {...(props.scope==='activities'?{runId:props.runId}:{})} query={needle} onRevealActivity={onRevealActivity}/>}
   {ready&&needle&&<InteractionSearch conversationId={props.conversationId}
    {...(props.scope==='activities'?{runId:props.runId}:{})} query={needle}/>}
   {error&&<p role="alert">完整历史尚未加载，当前结果来自已加载的公开记录。{error} <button type="button" disabled={loading} onClick={()=>setRetry(value=>value+1)}>继续加载历史</button></p>}
  </div>}
 </div>;
}
