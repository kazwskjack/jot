import React,{useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {readListedFilePreviewBytes,type ListedFilePreviewSource} from './activity-file-preview-client';

function DocxAttempt({source,owner,identity}:{source:ListedFilePreviewSource;owner:string;identity:string}){
 const frame=useRef<HTMLIFrameElement>(null),loaded=useRef<HTMLIFrameElement|null>(null);
 const notify=useRef<(frame:HTMLIFrameElement)=>void>(()=>{});
 const cancel=useRef<()=>void>(()=>{});
 const [state,setState]=useState<{identity:string;phase:'loading'|'ready'|'error';message:string}>({identity,phase:'loading',message:'正在核对原文件并渲染Word…'});
 const current=state.identity===identity?state:undefined;
 useEffect(()=>{
  const controller=new AbortController(),target=frame.current,token=crypto.randomUUID();
  let bytes:ArrayBuffer|undefined,sent=false,closed=false;
  const live=()=>!closed&&!controller.signal.aborted&&taskDraftScope()===owner;
  const dispose=()=>{closed=true;controller.abort();bytes=undefined;window.clearTimeout(timeout);window.removeEventListener('message',message);};
  const fail=(text:string)=>{if(!live())return;dispose();setState({identity,phase:'error',message:text});};
  const send=(element:HTMLIFrameElement)=>{
   if(!live()||sent||!bytes||!target||element!==target||loaded.current!==target||!target.contentWindow)return;
   sent=true;
   try{target.contentWindow.postMessage({type:'jot-docx-init',protocol:1,token,bytes},'*',[bytes]);bytes=undefined;}
   catch{fail('Word查看器未能接收原文件，请重试。');}
  };
  const message=(event:MessageEvent)=>{
   if(!live()||!sent||event.source!==target?.contentWindow)return;
   const value=event.data;
   if(!value||typeof value!=='object'||value.protocol!==1||value.token!==token)return;
   if(value.type==='jot-docx-ready'&&Object.keys(value).length===4&&Number.isSafeInteger(value.sections)&&value.sections>=0&&value.sections<=50000){
    window.clearTimeout(timeout);setState({identity,phase:'ready',message:`已渲染 ${value.sections} 个Word分段。分段沿原文件分页标记。`});
   }else if(value.type==='jot-docx-error'&&Object.keys(value).length===4&&['DOCX_RENDER_FAILED','DOCX_VIEW_LIMIT'].includes(value.code)){
    fail(value.code==='DOCX_VIEW_LIMIT'?'Word内容超过当前视觉渲染范围，可切换结构化文字查看。':'Word视觉渲染失败，可重试或切换结构化文字查看。');
   }
  };
  const timeout=window.setTimeout(()=>fail('Word视觉读取超时，可重试或切换结构化文字查看。'),30000);
  setState({identity,phase:'loading',message:'正在核对原文件并渲染Word…'});
  window.addEventListener('message',message);notify.current=send;
  cancel.current=()=>fail('Word视觉读取已取消。');
  void readListedFilePreviewBytes(source,owner,controller.signal).then(value=>{
   if(!live())return;
   bytes=value.buffer as ArrayBuffer;if(target)send(target);
  }).catch(error=>{if(live())fail(error instanceof Error?error.message:'原Word文件读取失败');});
  return()=>{dispose();notify.current=()=>{};cancel.current=()=>{};};
 },[identity,owner]);
 return <section className="jot-docx-preview" aria-label="Word视觉内容">
  <p role={current?.phase==='error'?'alert':'status'}>{current?.message??'正在核对原文件…'}
   {current?.phase==='loading'&&<button type="button" onClick={()=>cancel.current()}>取消读取</button>}
  </p>
  {current?.phase!=='error'&&<iframe ref={frame} title="原固定版本Word视觉查看器" src="/docx-preview/0.4.0/frame.html" sandbox="allow-scripts" referrerPolicy="no-referrer"
   onLoad={event=>{loaded.current=event.currentTarget;notify.current(event.currentTarget);}}/>}
 </section>;
}

export default function ActivityToolFileDocx(source:ListedFilePreviewSource){
 const owner=taskDraftScope(),[revision,setRevision]=useState(0);
 const identity=JSON.stringify([owner,source.conversationId,source.runId,source.activityId,source.resultSha,source.file.path,source.file.version,source.file.sha256,source.file.size,revision]);
 return <><button type="button" onClick={()=>setRevision(value=>value+1)}>重新读取Word视觉内容</button><DocxAttempt key={identity} source={source} owner={owner} identity={identity}/></>;
}
