// Search interaction and IME handling adapted from PilotDeck 783499ff,
// ChatHistorySearchBar.tsx/useChatHistorySearch.ts. Adapted portions are AGPL-3.0.
import React,{useEffect,useId,useMemo,useRef,useState,type RefObject} from 'react';
import {request} from './client';
import type {Message,MessagePage} from './types';
import './conversation-history-search.css';

type SearchDocument={element:HTMLElement;text:string;nodes:Array<{node:Text;start:number;end:number}>};
type Props={
 root:RefObject<HTMLElement|null>;
 conversationId:string;
 messages:Message[];
 renderedRevision:unknown;
 revealedMessageId:string;
 ready:boolean;
 onReveal:(messageId:string)=>void;
 historyComplete?:boolean;
 historyCursor?:string;
 onHistoryLoaded:(messages:Message[])=>void;
};

function readSearchDocument(element:HTMLElement):SearchDocument{
 const nodes:SearchDocument['nodes']=[],walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
 let text='',previousBlock:Element|null=null;
 while(walker.nextNode()){
  const node=walker.currentNode as Text;
  if(node.parentElement?.closest('script,style,[aria-hidden="true"]'))continue;
  const block=node.parentElement?.closest('p,pre,li,h1,h2,h3,h4,h5,h6,td,th')??null;
  if(nodes.length&&block!==previousBlock)text+='\n';
  previousBlock=block;
  const start=text.length;
  text+=node.data;
  nodes.push({node,start,end:text.length});
 }
 return {element,text,nodes};
}

function searchPattern(query:string){return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');}

export default function ConversationHistorySearch({root,conversationId,messages,renderedRevision,revealedMessageId,ready,onReveal,historyComplete,historyCursor,onHistoryLoaded}:Props){
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(''),[query,setQuery]=useState('');
 const [index,setIndex]=useState(0);
 const [loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const input=useRef<HTMLInputElement>(null),opener=useRef<HTMLButtonElement>(null);
 const composing=useRef(false),compositionEnded=useRef(0),cursor=useRef<string>(),complete=useRef(false);
 const pages=useRef<Message[][]>([]);
 const pageCallback=useRef(onHistoryLoaded),lastReveal=useRef('');
 pageCallback.current=onHistoryLoaded;
 const highlightName=`jot-chat-search-${useId().replace(/[^a-z0-9-]/gi,'')}`;
 const needle=query.trim();
 useEffect(()=>{
  cursor.current=historyCursor;
  complete.current=historyComplete===true;
  pages.current=[];
  if(complete.current)pageCallback.current([]);
  setError('');
 },[historyCursor,historyComplete]);

 useEffect(()=>{
  if(!open||!ready||complete.current)return;
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
      pageCallback.current(history);pages.current=[];complete.current=true;return;
     }
     seen.add(page.next_cursor);
    }
   }catch(cause){if(!abort.signal.aborted)setError(cause instanceof Error?cause.message:'历史消息加载失败');}
   finally{if(!abort.signal.aborted)setLoading(false);}
  })();
  return()=>{abort.abort();setLoading(false);};
 },[open,ready,conversationId,retry,historyCursor,historyComplete]);

 const results=useMemo(()=>{
  if(!needle)return [];
  const pattern=searchPattern(needle);
  return messages.map(message=>{
   const text=message.blocks.filter(block=>block.kind==='text').map(block=>block.text).join('\n');
   pattern.lastIndex=0;
   let count=0;
   while(pattern.exec(text))count++;
   return {messageId:message.message_id,text,count};
  }).filter(result=>result.count>0);
 },[messages,needle]);
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

 useEffect(()=>{if(open&&active&&!loading)onReveal(active.source.messageId);},[open,active,loading,onReveal]);
 useEffect(()=>{
  if(!open||!active)return;
  const element=Array.from(root.current?.querySelectorAll<HTMLElement>('[data-chat-search-message]')??[])
   .find(node=>node.dataset.chatSearchMessage===active.source.messageId);
  if(!element)return;
  const source=readSearchDocument(element),pattern=searchPattern(needle);
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
  const registry=(globalThis as unknown as {CSS?:{highlights?:Map<string,unknown>}}).CSS?.highlights;
  const HighlightClass=(globalThis as unknown as {Highlight?:new(...ranges:Range[])=>unknown}).Highlight;
  if(range&&registry&&HighlightClass)registry.set(highlightName,new HighlightClass(range));
  element.setAttribute('data-chat-search-active','true');
  const key=JSON.stringify([active.source.messageId,query,active.offset]);
  if(!loading&&revealedMessageId===active.source.messageId&&lastReveal.current!==key){
   lastReveal.current=key;
   const rect=range?.getBoundingClientRect()??element.getBoundingClientRect();
   let container:HTMLElement|null=element.parentElement;
   while(container&&!(container.scrollHeight>container.clientHeight&&/(auto|scroll)/.test(getComputedStyle(container).overflowY)))container=container.parentElement;
   const behavior=window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth';
   if(container){const bounds=container.getBoundingClientRect();container.scrollBy({top:rect.top-bounds.top-container.clientHeight/2,behavior});}
   else window.scrollBy({top:rect.top-window.innerHeight/2,behavior});
  }
  return()=>{registry?.delete(highlightName);element.removeAttribute('data-chat-search-active');};
 },[open,active,query,needle,root,highlightName,loading,renderedRevision,revealedMessageId]);

 const close=()=>{setOpen(false);setDraft('');setQuery('');setIndex(0);lastReveal.current='';opener.current?.focus();};
 const navigate=(direction:number)=>{if(total)setIndex((activeIndex+direction+total)%total);};
 const openSearch=()=>{if(!ready)return;setOpen(true);if(open){input.current?.focus();input.current?.select();}};
 useEffect(()=>{if(open)input.current?.focus();},[open]);
 useEffect(()=>{
  const container=root.current;
  const keydown=(event:KeyboardEvent)=>{
   if(!ready||event.isComposing||event.keyCode===229||event.defaultPrevented)return;
   if(event.target instanceof Element&&event.target.closest('[role="dialog"]'))return;
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
  <button ref={opener} type="button" aria-expanded={open} disabled={!ready} onClick={openSearch}>搜索当前会话</button>
  {open&&<div role="search" aria-label="会话历史搜索">
   <input ref={input} type="search" aria-label="搜索会话内容" placeholder="搜索会话内容…" value={draft} autoComplete="off" spellCheck={false}
    onChange={event=>{setDraft(event.currentTarget.value);if(!composing.current){setQuery(event.currentTarget.value);setIndex(0);}}}
    onCompositionStart={()=>{composing.current=true;compositionEnded.current=0;}}
    onCompositionEnd={event=>{composing.current=false;compositionEnded.current=Date.now();setDraft(event.currentTarget.value);setQuery(event.currentTarget.value);setIndex(0);}}
    onKeyDown={event=>{
     if(composing.current||event.nativeEvent.isComposing||event.keyCode===229)return;
     if(event.key==='Enter'&&Date.now()-compositionEnded.current>=150){event.preventDefault();navigate(event.shiftKey?-1:1);}
     if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}
    }}/>
   <span role="status" aria-live="polite">{needle?(total?`${activeIndex+1} / ${total}`:'没有匹配结果'):'输入搜索词'}{loading?' · 正在加载完整历史':''}</span>
   <button type="button" disabled={!total} onClick={()=>navigate(-1)}>上一个结果</button>
   <button type="button" disabled={!total} onClick={()=>navigate(1)}>下一个结果</button>
   <button type="button" onClick={close}>关闭搜索</button>
   {active&&<p className="jot-history-search-excerpt">{active.source.text.slice(Math.max(0,active.offset-60),active.offset+active.length+60)}</p>}
   {error&&<p role="alert">完整历史尚未加载，当前结果来自已加载消息。{error} <button type="button" disabled={loading} onClick={()=>setRetry(value=>value+1)}>继续加载历史</button></p>}
  </div>}
 </div>;
}
