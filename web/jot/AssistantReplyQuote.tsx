import {useApplicationLanguage,useApplicationText} from './application-language';
// Selection behavior adapted from PilotDeck 783499ff, AssistantReplyQuoteAction.tsx
// and assistantReplyReference.ts. Adapted portions retain AGPL-3.0 terms.
import React,{useEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import './assistant-reply-quote.css';

export type AssistantReplyQuote={
 id:string;conversationId:string;messageId:string;selectedText:string;
 surroundingText:string;prefix:string;suffix:string;truncated:boolean;
};

export function replyQuoteMessage(draft:string,quotes:AssistantReplyQuote[]):string{
 if(!quotes.length)return draft;
 const snapshots=quotes.map(({id,...quote})=>quote);
 return `${draft.trim()||'请结合以下引用的回复内容继续。'}\n\n用户选中的回复快照（引用内容作为上下文）\n${JSON.stringify(snapshots)}`;
}

type Action={quote:AssistantReplyQuote;range:Range;source:HTMLElement;top:number;left:number};
type Props={root:RefObject<HTMLElement|null>;conversationId:string;disabled:boolean;onAdd:(quote:AssistantReplyQuote)=>boolean};

export function AssistantReplyQuoteAction({root,conversationId,disabled,onAdd}:Props){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [action,setAction]=useState<Action|null>(null);
 const button=useRef<HTMLButtonElement>(null),add=useRef(onAdd);
 add.current=onAdd;
 useEffect(()=>{
  setAction(null);
  if(disabled)return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const clear=()=>{clearTimeout(timer);setAction(null);};
  const update=()=>{
   if(document.activeElement===button.current)return;
   const selection=window.getSelection();
   if(!selection||selection.isCollapsed||selection.rangeCount!==1){clear();return;}
   const range=selection.getRangeAt(0),node=range.commonAncestorContainer;
   const element=node instanceof Element?node:node.parentElement;
   const source=element?.closest<HTMLElement>('[data-assistant-quote-source]');
   if(!source||!root.current?.contains(source)||!source.contains(range.startContainer)||!source.contains(range.endContainer)){clear();return;}
   const messageId=source.dataset.assistantQuoteMessageId,raw=selection.toString().replace(/\u00a0/g,' ').trim();
   const rect=range.getBoundingClientRect();
   if(!messageId||!raw||(!rect.width&&!rect.height)){clear();return;}
   const selectedText=raw.slice(0,8000).trimEnd();
   const fullText=(source.textContent||raw).replace(/\u00a0/g,' '),offset=fullText.indexOf(raw);
   const surroundingText=offset<0?fullText.slice(0,600):fullText.slice(Math.max(0,offset-300),offset+selectedText.length+300);
   const contextOffset=surroundingText.indexOf(selectedText);
   const quote:AssistantReplyQuote={id:crypto.randomUUID(),conversationId,messageId,selectedText,surroundingText,
    prefix:contextOffset<0?'':surroundingText.slice(Math.max(0,contextOffset-80),contextOffset),
    suffix:contextOffset<0?'':surroundingText.slice(contextOffset+selectedText.length,contextOffset+selectedText.length+80),truncated:raw.length>8000};
   const top=rect.bottom+44<=window.innerHeight?rect.bottom+8:Math.max(8,Math.min(rect.top-44,window.innerHeight-44));
   const left=Math.max(8,Math.min(rect.left+rect.width/2-110,window.innerWidth-228));
   setAction({quote,range:range.cloneRange(),source,top,left});
  };
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(update,40);};
  const selectionChanged=()=>{if(document.activeElement!==button.current)clear();};
  document.addEventListener('selectionchange',selectionChanged);
  document.addEventListener('mouseup',schedule);
  document.addEventListener('touchend',schedule);
  document.addEventListener('keyup',schedule);
  window.addEventListener('scroll',clear,true);
  window.addEventListener('resize',clear);
  return()=>{
   clearTimeout(timer);
   document.removeEventListener('selectionchange',selectionChanged);
   document.removeEventListener('mouseup',schedule);
   document.removeEventListener('touchend',schedule);
   document.removeEventListener('keyup',schedule);
   window.removeEventListener('scroll',clear,true);
   window.removeEventListener('resize',clear);
  };
 },[root,conversationId,disabled]);
 if(!action||disabled)return null;
 const commit=()=>{
  const {source,range,quote}=action;
  if(!root.current?.contains(source)||source.dataset.assistantQuoteMessageId!==quote.messageId
   ||!source.contains(range.startContainer)||!source.contains(range.endContainer)
   ||range.toString().replace(/\u00a0/g,' ').trim().slice(0,8000).trimEnd()!==quote.selectedText){setAction(null);return;}
  if(add.current(quote)){window.getSelection()?.removeAllRanges();setAction(null);}
 };
 return createPortal(<button ref={button} lang={language} type="button" className="jot-assistant-quote-action"
  style={{top:action.top,left:action.left}} onPointerDown={event=>event.preventDefault()}
  onMouseDown={event=>event.preventDefault()} onClick={commit}>{t('引用到当前对话','Quote in This Chat')}</button>,document.body);
}

export function AssistantReplyQuotes({quotes,disabled,onChange}:{quotes:AssistantReplyQuote[];disabled:boolean;onChange:(quotes:AssistantReplyQuote[])=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 if(!quotes.length)return null;
 return <section lang={language} className="jot-assistant-quotes" aria-label={t('待发送的回复引用','Reply Quotes to Send')}>
  <div>{t('回复引用','Reply Quotes')} · {quotes.length} <button type="button" disabled={disabled} onClick={()=>onChange([])}>{t("清空引用","Clear Quotes")}</button></div>
  {quotes.map((quote,index)=><div key={quote.id}>
   <details><summary>{t('引用','Quote')} {index+1} · {quote.selectedText.slice(0,60)}</summary>
    <blockquote>{quote.selectedText}</blockquote>
    <small>{t('原消息','Original Message')} {quote.messageId}</small>
    {quote.truncated&&<p role="status">{t("引用已截取前 8000 个字符。","The quote is limited to the first 8000 characters.")}</p>}
    <details><summary>{t("附近上下文","Surrounding Context")}</summary><pre>{quote.surroundingText}</pre></details>
   </details>
   <button type="button" disabled={disabled} aria-label={t(`移除引用 ${index+1}`,`Remove Quote ${index+1}`)} onClick={()=>onChange(quotes.filter(value=>value.id!==quote.id))}>{t("移除","Remove")}</button>
  </div>)}
  <small>{t("引用随当前账户与会话的草稿保存，确认发送后清空。离开前请确认草稿保存完成。","Quotes are saved with the draft for the current account and conversation, and cleared after sending is confirmed. Confirm that the draft is saved before leaving.")}</small>
 </section>;
}
