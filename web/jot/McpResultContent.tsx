import PagedText from './ToolResultText';
import ToolResultTaskList from './ToolResultTaskList';
import {toolResultTasks} from './tool-result-tasks';
import React,{useCallback,useEffect,useId,useMemo,useRef,useState} from 'react';
import {ApiError,taskDraftScope} from './client';
import {readMcpResultContent,mcpInlinePayload,type McpResultSource,type McpResultContent as Content} from './mcp-result-content-client';
import {mcpInlineImageSize} from './mcp-inline-image';

const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
function serialized(value:unknown){try{return JSON.stringify(value)??'';}catch{return '此项嵌套过深，可下载原结果JSON查看。';}}
function BlockView({block,index,owner,documentId}:{block:unknown;index:number;owner:string;documentId:string}){
 const [state,setState]=useState<{url?:string;image?:string|undefined;audio?:string|undefined;size?:number;sha?:string;mime?:string;error?:string}>(),[revision,setRevision]=useState(0);
 const audioRef=useRef<HTMLAudioElement|null>(null);
 const bindAudio=useCallback((element:HTMLAudioElement|null)=>{const previous=audioRef.current;if(previous&&previous!==element)try{previous.pause();previous.removeAttribute('src');previous.load();}catch{}audioRef.current=element;},[]);
 useEffect(()=>{
  let closed=false,url='',image='',audio='';setState(undefined);
  const load=async()=>{
   if(index<0)return;const payload=mcpInlinePayload(block);if(!payload)return;
   const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',payload.bytes)),value=>value.toString(16).padStart(2,'0')).join('');
   let size:Awaited<ReturnType<typeof mcpInlineImageSize>>=undefined;try{size=await mcpInlineImageSize(payload.bytes,payload.mime);}catch{}
   if(closed||taskDraftScope()!==owner)return;
   url=URL.createObjectURL(new Blob([payload.bytes],{type:'application/octet-stream'}));
   if(size)image=URL.createObjectURL(new Blob([payload.bytes],{type:payload.mime}));
   if(['audio/mpeg','audio/wav','audio/x-wav','audio/ogg','audio/flac','audio/aac'].includes(payload.mime))audio=URL.createObjectURL(new Blob([payload.bytes],{type:payload.mime}));
   setState({url,...(image?{image}:{}),...(audio?{audio}:{}),size:payload.bytes.length,sha,mime:payload.mime});
  };
  void load().catch(()=>{if(!closed&&taskDraftScope()===owner)setState({error:'内嵌文件尚未通过编码或内容核对，可对照原结果JSON。'});});
  return()=>{closed=true;if(url)URL.revokeObjectURL(url);if(image)URL.revokeObjectURL(image);if(audio)URL.revokeObjectURL(audio);};
 },[block,index,owner,revision]);
 const value=index>=0?object(block):undefined,resource=object(value?.resource),text=typeof value?.text==='string'?value.text:typeof resource?.text==='string'?resource.text:undefined;
 const tasks=useMemo(()=>toolResultTasks(index<0?block:text??block),[block,index,text]);
 const [taskMode,setTaskMode]=useState(index<0);
 const extensions:Record<string,string>={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg','audio/flac':'flac','audio/x-wav':'wav','audio/aac':'aac'};
 return <section aria-label="已选原结果项">
  {state?.url&&<><p>{state.mime} · {state.size} 字节 · SHA-256 <code>{state.sha}</code></p>
   <a href={state.url} download={`tool-result-${index+1}.${extensions[state.mime??'']??'bin'}`} onClick={event=>{if(taskDraftScope()!==owner)event.preventDefault();}}>下载此内嵌文件</a>
   {state.audio&&<audio ref={bindAudio} controls preload="none" style={{maxWidth:'100%',width:'100%'}} src={state.audio} aria-label={`原工具结果第${index+1}项音频`}
    onPlay={event=>{if(taskDraftScope()!==owner)event.currentTarget.pause();}} onError={()=>{URL.revokeObjectURL(state.audio!);setState(current=>current?{...current,audio:undefined}:current);}}>浏览器未能播放此音频，可下载原文件查看。</audio>}
   {state.image?<figure><img src={state.image} alt={`工具结果第${index+1}项`} style={{maxWidth:'100%',height:'auto'}} onError={()=>{URL.revokeObjectURL(state.image!);setState(current=>current?{...current,image:undefined}:current);}}/></figure>:<p>此文件可下载查看。</p>}
  </>}
  {state?.error&&<p role="alert">{state.error}<button type="button" onClick={()=>setRevision(value=>value+1)}>重新核对文件</button></p>}
  {tasks&&<button type="button" data-chat-search-ignore aria-pressed={taskMode} onClick={()=>setTaskMode(value=>!value)}>{taskMode?text!==undefined?'返回原始文字':'返回原始数据':'按任务清单查看'}</button>}
  {tasks&&taskMode?<ToolResultTaskList value={tasks} documentId={documentId}/>:text!==undefined?<PagedText text={text} identity={documentId+':text'}/>:tasks&&<PagedText text={serialized(block)} identity={documentId+':original'}/>}

  <details><summary>此结果项原数据</summary><PagedText text={serialized(block)} identity={documentId+':data'}/></details>
 </section>;
}

export default function McpResultContent({source}:{source:McpResultSource}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,source]),instance=useId();
 const [state,setState]=useState<{identity:string;content?:Content;url?:string;error?:string}>(),[revision,setRevision]=useState(0),[page,setPage]=useState(0),[selected,setSelected]=useState<number>();
 useEffect(()=>{
  const controller=new AbortController();let url='';setState({identity});
  const timer=window.setTimeout(()=>{controller.abort();if(taskDraftScope()===owner)setState({identity,error:'原结果内容读取超时，可重新读取。'});},45000);
  void readMcpResultContent(source,owner,controller.signal).then(content=>{
   if(controller.signal.aborted||taskDraftScope()!==owner)return;
   url=URL.createObjectURL(new Blob([content.json],{type:'application/json'}));setState({identity,content,url});
  }).catch(error=>{if(!controller.signal.aborted&&taskDraftScope()===owner)setState({identity,error:error instanceof ApiError&&error.status===409?'原工具结果来源已变化，请重新打开步骤。':'原工具结果内容暂不可确认，请稍后重试。'});}).finally(()=>window.clearTimeout(timer));
  return()=>{controller.abort();window.clearTimeout(timer);if(url)URL.revokeObjectURL(url);};
 },[identity,revision]);
 const current=state?.identity===identity?state:undefined,content=current?.content,total=content?.value.content.length??0,count=Math.max(1,Math.ceil(total/8)),currentPage=Math.min(page,count-1);
 const item=content&&selected!==undefined?(selected===-1?content.value.structuredContent:content.value.content[selected]):undefined;
 return <section aria-label="原MCP结果内容项">
  <h5>原工具结果内容</h5><p>结果SHA-256 <code>{source.resultSha}</code></p>
  {!current?.content&&!current?.error&&<p role="status">正在读取并核对完整原结果…</p>}
  {content&&<>
   {content.value.isError===true&&<p role="alert">原工具结果标记为错误。</p>}
   {current?.url&&<a href={current.url} download="tool-result.json" onClick={event=>{if(taskDraftScope()!==owner)event.preventDefault();}}>下载已核对的原结果JSON</a>}
   {Object.hasOwn(content.value,'structuredContent')&&<button type="button" onClick={()=>setSelected(-1)}>查看结构化结果字段</button>}
   {!total?<p>原结果没有content项。</p>:<ol start={currentPage*8+1}>{content.value.content.slice(currentPage*8,currentPage*8+8).map((block,index)=>{
    const value=object(block),position=currentPage*8+index,label=typeof value?.type==='string'?value.type.slice(0,80):'其他数据';
    return <li key={position}>{position+1} · {label} <button type="button" onClick={()=>setSelected(position)}>查看此结果项</button></li>;
   })}</ol>}
   {count>1&&<nav aria-label="原结果项翻页"><button type="button" disabled={!currentPage} onClick={()=>{setSelected(undefined);setPage(currentPage-1);}}>上一页结果项</button><span>{currentPage+1} / {count}</span><button type="button" disabled={currentPage+1>=count} onClick={()=>{setSelected(undefined);setPage(currentPage+1);}}>下一页结果项</button></nav>}
   {selected!==undefined&&<><button type="button" onClick={()=>setSelected(undefined)}>关闭结果项</button><BlockView key={identity+':'+selected} owner={owner} block={item} index={selected} documentId={JSON.stringify(['mcp-block',instance,identity,selected])}/></>}
  </>}
  {current?.error&&<p role="alert">{current.error}</p>}
  <button type="button" onClick={()=>{setSelected(undefined);setRevision(value=>value+1);}}>重新读取原结果内容</button>
 </section>;
}
