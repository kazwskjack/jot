import {useApplicationLanguage,useApplicationText} from './application-language';
import React,{useMemo,useState} from 'react';
import {FileReferenceDetails,type FileSourceReference} from './FileTextReferences';
import {messageFileReferences} from './message-file-references';
import {taskDraftScope} from './client';
import type {Message} from './types';

export default function MessageFileReferences({message,onOpen}:{message:Message;onOpen:(value:FileSourceReference)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),references=useMemo(()=>messageFileReferences(message,owner),[message,owner]);
 const [page,setPage]=useState(0),start=Math.min(page*20,Math.max(0,Math.floor((references.length-1)/20)*20));
 if(message.role==='user'&&message.status==='complete'&&Object.hasOwn(message,'reference_snapshots')&&!references.length)return <p lang={language} role="status">{t("原文件引用记录暂未能核对，可查看原消息正文。","The original file reference record could not be verified. You can read the original message body.")}</p>;
 if(!references.length)return null;
 return <section lang={language} className="jot-assistant-quotes" aria-label={t("消息中的原文件引用快照","Original File Reference Snapshots in the Message")}>
  <p>{t('原文件引用','Original File References')} · {references.length}</p>
  {references.slice(start,start+20).map((value,index)=><div key={JSON.stringify([start+index,value.reference.id])}>
   <FileReferenceDetails value={value}/>
   <button type="button" data-chat-search-ignore onClick={()=>onOpen(value)}>{t('打开原文件并定位引用','Open Original File at Reference')}</button>
  </div>)}
  {references.length>20&&<nav aria-label={t("消息引用翻页","Message Reference Pages")} data-chat-search-ignore>
   <span>{start+1}–{Math.min(start+20,references.length)} / {references.length}</span>
   <button type="button" disabled={start===0} onClick={()=>setPage(start/20-1)}>{t('上一页引用','Previous Reference Page')}</button>
   <button type="button" disabled={start+20>=references.length} onClick={()=>setPage(start/20+1)}>{t('下一页引用','Next Reference Page')}</button>
  </nav>}
 </section>;
}
