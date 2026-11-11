// ThinkingBlock/StreamingScrollViewport presentation adapts PilotDeck 783499ff.
// Adapted portions retain AGPL-3.0; see THIRD_PARTY_NOTICES.md.
import React,{useId,useMemo,useRef,useState} from 'react';
import type {ContentBlock,Message} from './types';
import TwemojiMarkdown from './TwemojiMarkdown';
import {useScrollFollow} from './vendor/pilotdeck-use-scroll-follow';

function ThinkingBlock({block,streaming,inline,identity}:{block:ContentBlock;streaming:boolean;inline:boolean;identity:string}){
 const [view,setView]=useState({streaming,expanded:streaming}),viewport=useRef<HTMLDivElement>(null),contentId=useId();
 // Token updates preserve the manual choice; only the original message phase changes the default.
 if(view.streaming!==streaming)setView({streaming,expanded:streaming});
 const expanded=view.streaming===streaming?view.expanded:streaming;
 const {hasOverflow,canReturnToLatest,scrollToBottom}=useScrollFollow({containerRef:viewport,enabled:expanded&&streaming,scopeKey:identity});
 const label=block.kind==='summary'||block.exposure==='summary'?'模型摘要':'模型思考内容';
 return <div className={inline?'jot-message-thinking-inline':'jot-message-thinking'} style={{minWidth:0,marginBlock:8}}>
  <button type="button" aria-expanded={expanded} aria-controls={contentId} onClick={()=>setView({streaming,expanded:!expanded})}>{expanded?'收起':'展开'}{label}{streaming?' · 消息生成中':''}</button>
  <div id={contentId} hidden={!expanded}>
   <div ref={viewport} role="region" tabIndex={0} aria-label={label} data-stream-scroll-viewport data-chat-search-content={identity}
    style={{maxHeight:'16rem',overflowY:'auto',overflowAnchor:'none',overscrollBehaviorY:hasOverflow?'contain':'auto',borderInlineStart:`2px solid ${inline?'var(--wb-accent,#5479de)':'currentColor'}`,paddingInlineStart:12}}>
    <div><TwemojiMarkdown>{block.text}</TwemojiMarkdown></div>
   </div>
   {canReturnToLatest&&<button type="button" data-chat-search-ignore onClick={scrollToBottom}>回到这段内容末尾</button>}
  </div>
 </div>;
}

export default function MessageThinking({message,owner,conversationId,show,inline}:{message:Message;owner:string;conversationId:string;show:boolean;inline:boolean}){
 const [selected,setSelected]=useState(0),blocks=useMemo(()=>message.role==='assistant'?message.blocks.filter(block=>(block.kind==='reasoning'||block.kind==='summary')&&block.text):[],[message.role,message.blocks]);
 const count=Math.max(1,Math.ceil(blocks.length/8)),page=Math.min(selected,count-1);
 if(!show||!blocks.length)return null;
 // Keep provider content outside the original final-answer quote source.
 return <section aria-label="模型思考与摘要">
  {blocks.slice(page*8,page*8+8).map(block=>{
   const identity=JSON.stringify(['message-thinking',owner,conversationId,message.message_id,message.run_id,block.block_id,block.kind,block.exposure??null]);
   return <ThinkingBlock key={identity} block={block} streaming={message.status==='streaming'} inline={inline} identity={identity}/>;
  })}
  {count>1&&<nav aria-label="思考与摘要翻页" data-chat-search-ignore><button type="button" disabled={!page} onClick={()=>setSelected(page-1)}>上一页内容段</button><span>{page+1} / {count}</span><button type="button" disabled={page+1>=count} onClick={()=>setSelected(page+1)}>下一页内容段</button></nav>}
 </section>;
}
