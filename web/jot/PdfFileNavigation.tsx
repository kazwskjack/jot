import React,{useEffect,useState} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import {resolvePdfOutline,type PdfOutlineItem} from './vendor/pilotdeck-pdf-outline';
import {findPdfSearchMatches,type PdfSearchMatch} from './vendor/pilotdeck-pdf-search';

function OutlineItems({items,page,onNavigate}:{items:PdfOutlineItem[];page:number;onNavigate:(page:number)=>void}){
 return <ul>{items.map(item=><li key={item.id}>
  {item.pageNumber===null?<span>{item.title}</span>:<button type="button" aria-current={item.pageNumber===page?'page':undefined} onClick={()=>onNavigate(item.pageNumber!)}>{item.title} · {item.pageNumber}</button>}
  {!!item.items.length&&<details><summary>展开子目录</summary><OutlineItems items={item.items} page={page} onNavigate={onNavigate}/></details>}
 </li>)}</ul>;
}

export default function PdfFileNavigation({document,page,onNavigate,onMatches}:{document:PDFDocumentProxy;page:number;onNavigate:(page:number)=>void;onMatches:(matches:PdfSearchMatch[],selected:string|null)=>void}){
 const [outline,setOutline]=useState<{document:PDFDocumentProxy;items?:PdfOutlineItem[];error?:string}>(),[outlineRevision,setOutlineRevision]=useState(0);
 const [query,setQuery]=useState(''),[request,setRequest]=useState<{query:string}>();
 const [search,setSearch]=useState<{document:PDFDocumentProxy;query:string;scanned:number;busy:boolean;matches:PdfSearchMatch[];selected:number;error?:string}>();
 useEffect(()=>{
  const controller=new AbortController();let cancelled=false;setOutline({document});
  void document.getOutline().then(items=>resolvePdfOutline(document,items,controller.signal)).then(items=>{if(!cancelled)setOutline({document,items});})
   .catch(error=>{if(!cancelled)setOutline({document,error:error instanceof Error?error.message:'PDF目录读取失败'});});
  return()=>{cancelled=true;controller.abort();};
 },[document,outlineRevision]);
 useEffect(()=>{
  let cancelled=false;onMatches([],null);
  if(!request){setSearch(undefined);return;}
  setSearch({document,query:request.query,scanned:0,busy:true,matches:[],selected:0});
  const scan=async()=>{
   const matches:PdfSearchMatch[]=[];let scanned=0;
   try{
    for(let pageNumber=1;pageNumber<=document.numPages;pageNumber++){
     if(cancelled)return;
     const page=await document.getPage(pageNumber);
     try{
      if(cancelled)return;
      const content=await page.getTextContent();if(cancelled)return;
      const items=content.items.filter(item=>'str' in item).map(item=>item.str);
      for(const match of findPdfSearchMatches(items,request.query,pageNumber))matches.push(match);
      scanned=pageNumber;
     }finally{try{page.cleanup();}catch{}}
     if(!cancelled)setSearch({document,query:request.query,scanned,busy:true,matches:[],selected:0});
    }
    if(cancelled)return;
    setSearch({document,query:request.query,scanned,busy:false,matches,selected:0});
    const first=matches[0];onMatches(matches,first?.id??null);if(first)onNavigate(first.pageNumber);
   }catch(error){
    if(!cancelled)setSearch({document,query:request.query,scanned,busy:false,matches:[],selected:0,error:error instanceof Error?error.message:'PDF全文搜索失败'});
   }
  };
  void scan();return()=>{cancelled=true;};
 },[document,request,onMatches,onNavigate]);
 const currentOutline=outline?.document===document?outline:undefined,currentSearch=search?.document===document?search:undefined;
 const select=(index:number)=>{
  const match=currentSearch?.matches[index];if(!match)return;
  setSearch({...currentSearch!,selected:index});onMatches(currentSearch!.matches,match.id);onNavigate(match.pageNumber);
 };
 return <section aria-label="PDF目录和全文搜索" data-chat-search-ignore>
  <details><summary>PDF目录</summary>
   {(!currentOutline||!currentOutline.items&&!currentOutline.error)&&<p role="status">正在读取PDF目录…</p>}
   {currentOutline?.items&&(currentOutline.items.length?<OutlineItems items={currentOutline.items} page={page} onNavigate={onNavigate}/>:<p>原PDF未提供目录。</p>)}
   {currentOutline?.error&&<p role="alert">{currentOutline.error}<button type="button" onClick={()=>setOutlineRevision(value=>value+1)}>重试目录</button></p>}
  </details>
  <form onSubmit={event=>{event.preventDefault();const text=query.trim();setRequest(text?{query:text}:undefined);}}>
   <label>搜索PDF全文<input data-pdf-file-search type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label>
   <button type="submit">搜索PDF</button>
   <button type="button" onClick={()=>{setRequest(undefined);setQuery('');}}>清除PDF搜索</button>
   {currentSearch?.busy&&<button type="button" onClick={()=>setRequest(undefined)}>取消PDF搜索</button>}
  </form>
  {currentSearch?.busy&&<p role="status">正在搜索第 {currentSearch.scanned} / {document.numPages} 页…</p>}
  {currentSearch&&!currentSearch.busy&&!currentSearch.error&&<nav aria-label="PDF搜索命中">
   <span role="status">“{currentSearch.query}” · {currentSearch.matches.length?currentSearch.selected+1:0} / {currentSearch.matches.length} 处命中</span>
   <button type="button" disabled={!currentSearch.matches.length} onClick={()=>select((currentSearch.selected-1+currentSearch.matches.length)%currentSearch.matches.length)}>上一处PDF命中</button>
   <button type="button" disabled={!currentSearch.matches.length} onClick={()=>select((currentSearch.selected+1)%currentSearch.matches.length)}>下一处PDF命中</button>
   {!!currentSearch.matches.length&&<label>PDF命中序号<input type="number" min={1} max={currentSearch.matches.length} value={currentSearch.selected+1} onChange={event=>{const value=Number(event.target.value);if(Number.isSafeInteger(value)&&value>=1&&value<=currentSearch.matches.length)select(value-1);}}/></label>}
  </nav>}
  {currentSearch?.error&&<p role="alert">已读取 {currentSearch.scanned} / {document.numPages} 页，全文搜索未完成。{currentSearch.error}<button type="button" onClick={()=>setRequest({query:currentSearch.query})}>重试全文搜索</button></p>}
 </section>;
}
