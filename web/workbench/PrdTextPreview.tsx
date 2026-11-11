import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import React,{useEffect,useRef,useState} from 'react';

/** Keep large source text outside the rendered page while preserving scalar boundaries. */
export default function PrdTextPreview({content,label,style}:{content:string;label:string;style:React.CSSProperties}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [page,setPage]=useState(0);
 const text=useRef<HTMLPreElement>(null);
 useEffect(()=>setPage(0),[content]);
 const pages=Math.max(1,Math.ceil(content.length/4096)),current=Math.min(page,pages-1);
 useEffect(()=>{if(text.current)text.current.scrollTop=0;},[content,current]);
 let start=current*4096,end=Math.min(content.length,(current+1)*4096);
 if(start>0&&(content.codePointAt(start-1)??0)>0xffff)start--;
 if(end<content.length&&(content.codePointAt(end-1)??0)>0xffff)end--;
 return <div lang={language} role="group" aria-label={t(`${label}分段预览`,`${label} Segmented Preview`)}>
  <pre ref={text} aria-label={label} style={{...style,maxHeight:'24rem',overflow:'auto'}}>{content.slice(start,end)}</pre>
  {pages>1&&<div className="wb-actions">
   <button type="button" aria-label={t(`${label}上一段`,`${label} Previous Segment`)} disabled={current===0} onClick={()=>setPage(current-1)}>{t('上一段','Previous Segment')}</button>
   <span role="status">{t(`第 ${current+1} / ${pages} 段`,`Segment ${current+1} / ${pages}`)}</span>
   <button type="button" aria-label={t(`${label}下一段`,`${label} Next Segment`)} disabled={current===pages-1} onClick={()=>setPage(current+1)}>{t('下一段','Next Segment')}</button>
  </div>}
 </div>;
}
