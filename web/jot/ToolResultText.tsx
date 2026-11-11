import React,{useMemo,useState} from 'react';

export default function ToolResultText({text,identity}:{text:string;identity:string}){
 const starts=useMemo(()=>{const values=[0];let offset=0;while(offset<text.length){let end=Math.min(offset+16384,text.length);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!)&&/[\uDC00-\uDFFF]/.test(text[end]!))end--;offset=end;values.push(end);}return values;},[text]);
 const [selected,setSelected]=useState(0),page=Math.min(selected,Math.max(0,starts.length-2)),start=starts[page]??0,end=starts[page+1]??0;
 return <section data-chat-search-content={JSON.stringify([identity,start,end])}><pre>{text.slice(start,end)}</pre>{starts.length>2&&<nav aria-label="结果项文字翻页" data-chat-search-ignore><button type="button" disabled={!page} onClick={()=>setSelected(page-1)}>上一页内容</button><span>{page+1} / {starts.length-1}</span><button type="button" disabled={page+2>=starts.length} onClick={()=>setSelected(page+1)}>下一页内容</button></nav>}</section>;
}
