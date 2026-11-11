import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import {readListedFilePreviewBytes} from './activity-file-preview-client';
import React,{useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {artifactPreviewErrorMessage} from './artifact-preview-bytes.mjs';
import ActivityToolFileBytes from './ActivityToolFileBytes';

const imageTypes:Record<string,string>={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',bmp:'image/bmp',ico:'image/vnd.microsoft.icon',tiff:'image/tiff',tif:'image/tiff',avif:'image/avif'};
export function listedFileImageType(path:string){
 const extension=path.split('/').at(-1)?.split('.').at(-1)?.toLowerCase()??'';
 return Object.hasOwn(imageTypes,extension)?imageTypes[extension]:undefined;
}

export default function ActivityToolFileImage({conversationId,runId,activityId,resultSha,file}:React.ComponentProps<typeof ActivityToolFileBytes>){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,runId,activityId,resultSha,file]),type=listedFileImageType(file.path);
 const region=useRef<HTMLElement>(null);
 const [state,setState]=useState<{identity:string;url?:string;error?:string}>(),[revision,setRevision]=useState(0);
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  const controller=new AbortController();let url='';setState({identity});
  const check=()=>{controller.signal.throwIfAborted();if(taskDraftScope()!==owner)throw Error('文件所属账户已变化');};
  const load=async()=>{
   if(!type)throw Error('此文件的图片格式尚未确认');
   const bytes=await readListedFilePreviewBytes({conversationId,runId,activityId,resultSha,file},owner,controller.signal);check();
   url=URL.createObjectURL(new Blob([bytes],{type}));setState({identity,url});
  };
  void load().catch(error=>{if(!controller.signal.aborted&&taskDraftScope()===owner)setState({identity,error:artifactPreviewErrorMessage(error)});});
  return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
 },[identity,revision]);
 const current=state?.identity===identity?state:undefined;
 return <section lang={language} ref={region} tabIndex={-1} className="jot-activity-content" aria-label={t("原列表固定图片版本","Original List Pinned Image Version")}>
  <h4>{file.path} · {t('版本','Version')} {file.version}</h4>
  <ActivityToolFileBytes key={identity} conversationId={conversationId} runId={runId} activityId={activityId} resultSha={resultSha} file={file}/>
  {(!current||!current.url&&!current.error)&&<p role="status">{t('正在核对原图片完整内容…','Verifying the complete original image…')}</p>}
  {current?.url&&<figure data-chat-search-ignore><img src={current.url} alt={file.path} style={{maxWidth:'100%',height:'auto'}} onError={()=>{URL.revokeObjectURL(current.url!);setState({identity,error:'浏览器无法显示此图片格式，可下载固定版本查看。'});}}/><figcaption>{t(`固定版本 ${file.version} · ${file.size} 字节`,`Pinned Version ${file.version} · ${file.size} bytes`)}</figcaption></figure>}
  {current?.error&&<p role="alert">{conversationUiError(current.error,language)} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('重试图片','Retry Image')}</button></p>}
 </section>;
}
