import React,{useEffect,useMemo,useRef,useState} from 'react';

export default function ToolResultText({text,identity,reveal,sourceKey}:{text:string;identity:string;reveal?:{key:string;offset:number;length:number};sourceKey?:string}){
 const starts=useMemo(()=>{const values=[0];let offset=0;while(offset<text.length){let end=Math.min(offset+16384,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!)&&/[\uDC00-\uDFFF]/.test(text[end]!))end--;offset=end;values.push(end);}return values;},[text]);
 const [selected,setSelected]=useState(0),[matchEnd,setMatchEnd]=useState<number>(),appliedReveal=useRef('');
 useEffect(()=>{
  if(!reveal||appliedReveal.current===reveal.key||!Number.isSafeInteger(reveal.offset)||!Number.isSafeInteger(reveal.length)||reveal.offset<0||reveal.length<1||reveal.offset+reveal.length>text.length)return;
  appliedReveal.current=reveal.key;setSelected(Math.max(0,starts.findIndex(start=>start>reveal.offset)-1));setMatchEnd(reveal.offset+reveal.length);
 },[reveal?.key,reveal?.offset,reveal?.length,starts,text.length]);
 const page=Math.min(selected,Math.max(0,starts.length-2)),start=starts[page]??0;
 // Include the full source-bounded match when it straddles a normal text page.
 let end=Math.min(text.length,Math.max(starts[page+1]??0,matchEnd??0));
 if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!)&&/[\uDC00-\uDFFF]/.test(text[end]!))end++;
 const select=(next:number)=>{setMatchEnd(undefined);setSelected(next);};
 return <section data-chat-search-content={sourceKey?undefined:JSON.stringify([identity,start,end])}><pre style={sourceKey?{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}:undefined} data-chat-search-todo={sourceKey} data-chat-search-start={sourceKey?start:undefined} data-chat-search-end={sourceKey?end:undefined}>{text.slice(start,end)}</pre>{starts.length>2&&<nav aria-label="结果项文字翻页" data-chat-search-ignore><button type="button" disabled={!page} onClick={()=>select(page-1)}>上一页内容</button><span>{page+1} / {starts.length-1}</span><button type="button" disabled={page+2>=starts.length} onClick={()=>select(page+1)}>下一页内容</button></nav>}</section>;
}
