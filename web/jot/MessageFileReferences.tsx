import React,{useMemo,useState} from 'react';
import {FileReferenceDetails,type FileSourceReference} from './FileTextReferences';
import {messageFileReferences} from './message-file-references';
import {taskDraftScope} from './client';
import type {Message} from './types';

export default function MessageFileReferences({message,onOpen}:{message:Message;onOpen:(value:FileSourceReference)=>void}){
 const owner=taskDraftScope(),references=useMemo(()=>messageFileReferences(message,owner),[message,owner]);
 const [page,setPage]=useState(0),start=Math.min(page*20,Math.max(0,Math.floor((references.length-1)/20)*20));
 if(!references.length)return null;
 return <section className="jot-assistant-quotes" aria-label="消息中的原文件引用快照">
  <p>原文件引用 · {references.length}</p>
  {references.slice(start,start+20).map((value,index)=><div key={JSON.stringify([start+index,value.reference.id])}>
   <FileReferenceDetails value={value}/>
   <button type="button" data-chat-search-ignore onClick={()=>onOpen(value)}>打开原文件并定位引用</button>
  </div>)}
  {references.length>20&&<nav aria-label="消息引用翻页" data-chat-search-ignore>
   <span>{start+1}–{Math.min(start+20,references.length)} / {references.length}</span>
   <button type="button" disabled={start===0} onClick={()=>setPage(start/20-1)}>上一页引用</button>
   <button type="button" disabled={start+20>=references.length} onClick={()=>setPage(start/20+1)}>下一页引用</button>
  </nav>}
 </section>;
}
