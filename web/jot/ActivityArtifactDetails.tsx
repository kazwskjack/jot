import React,{useCallback,useEffect,useRef,useState} from 'react';
import {base,request,taskDraftScope} from './client';
import ArtifactVersionHistory from './ArtifactVersionHistory';
import ArtifactRecovery from './ArtifactRecovery';
import ArtifactParts from './ArtifactParts';
import {artifactPreviewErrorMessage,fetchVerifiedArtifactPreviewBytes} from './artifact-preview-bytes.mjs';
import type {ActivityArtifactTarget} from './activity-presentation';
import type {Artifact,Diff} from './types';

const id=/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const version=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0;
type Content={file:Artifact;before?:Artifact;text?:string;image?:string;truncated?:boolean;notice?:string};

export default function ActivityArtifactDetails({conversationId,target,onOpen}:{conversationId:string;target:ActivityArtifactTarget;onOpen:(target:ActivityArtifactTarget)=>void}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,target]);
 const region=useRef<HTMLDivElement>(null);
 useEffect(()=>{region.current?.focus();region.current?.scrollIntoView({block:'nearest'});},[identity]);
 const [state,setState]=useState<{identity:string;content?:Content;error?:string}>(),[revision,setRevision]=useState(0);
 const reload=useCallback(()=>setRevision(value=>value+1),[]);
 useEffect(()=>{
  const controller=new AbortController(),signal=controller.signal;let image='';
  setState({identity});
  const metadata=async(expectedVersion?:number,expectedSha?:string)=>{
   const partIndex=target.kind==='file'?target.partIndex:undefined;
   if(partIndex!==undefined&&(!version(partIndex)||partIndex>50))throw Error('分卷文件引用尚未确认');
   if(!id.test(target.artifactId)||expectedVersion!==undefined&&!version(expectedVersion))throw Error('文件引用尚未确认');
   const file=await request<Artifact>(`/artifacts/${encodeURIComponent(target.artifactId)}${partIndex===undefined?'':`/parts/${partIndex}`}${expectedVersion!==undefined?`?version=${expectedVersion}`:''}`,'GET',undefined,undefined,signal);
   if(taskDraftScope()!==owner||!file||file.artifact_id!==target.artifactId||file.conversation_id!==conversationId||!version(file.version)
    ||file.part_index!==partIndex||expectedVersion!==undefined&&file.version!==expectedVersion||expectedSha!==undefined&&file.sha256!==expectedSha
    ||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)
    ||typeof file.file_name!=='string'||typeof file.media_type!=='string'||file.status!=='ready')throw Error('文件版本或来源尚未确认');
   return file;
  };
  const load=async():Promise<Content>=>{
   if(target.kind==='diff'){
    const before=await metadata(target.fromVersion,target.beforeSha256),file=await metadata(target.toVersion,target.afterSha256);
    if(before.part_count||file.part_count)return {file,before,notice:'多卷成果需要选择单卷文件查看。'};
    if(before.local_state&&before.local_state!=='present'||file.local_state&&file.local_state!=='present')return {file,before,notice:'本地文件恢复后可读取这两个固定版本。'};
    if(before.size_bytes>20*1024*1024||file.size_bytes>20*1024*1024)return {file,before,notice:'文件超过20 MiB差异预览范围，可下载两个固定版本核对。'};
    if(!before.media_type.startsWith('text/')||!file.media_type.startsWith('text/'))return {file,before,notice:'此格式可下载两个固定版本核对。'};
    const diff=await request<Diff>(`/artifacts/${encodeURIComponent(target.artifactId)}/diff?from_version=${target.fromVersion}&to_version=${target.toVersion}`,'GET',undefined,undefined,signal);
    if(!diff||diff.artifact_id!==target.artifactId||diff.from_version!==target.fromVersion||diff.to_version!==target.toVersion
     ||typeof diff.unified_diff!=='string'||diff.unified_diff.length>200000||typeof diff.truncated!=='boolean')throw Error('文件差异来源尚未确认');
    return {file,before,text:diff.unified_diff,truncated:diff.truncated};
   }
   const file=await metadata(target.version,target.sha256);
   if(file.part_count)return {file,notice:`此成果包含 ${file.part_count} 卷，请选择单卷文件查看。`};
   if(file.local_state&&file.local_state!=='present')return {file,notice:'此固定版本的本地文件暂不可用，请查看归档与恢复状态。'};
   if(file.preview_kind!=='text'&&file.preview_kind!=='image')return {file};
   if(file.size_bytes>20*1024*1024)return {file,notice:'文件超过20 MiB预览范围，可下载固定版本查看。'};
   let verified;
   try{verified=await fetchVerifiedArtifactPreviewBytes(file,file.preview_kind,signal);}
   catch(error){
    if(error instanceof Error&&error.message==='artifact_preview_format_unsupported')return {file,notice:artifactPreviewErrorMessage(error)};
    throw error;
   }
   signal.throwIfAborted();
   if(file.preview_kind==='text'){
    const text=new TextDecoder().decode(verified.bytes);
    return {file,text:text.slice(0,200000),truncated:text.length>200000};
   }
   image=URL.createObjectURL(new Blob([verified.bytes],{type:verified.media_type}));
   return {file,image};
  };
  void load().then(content=>{if(!signal.aborted&&taskDraftScope()===owner)setState({identity,content});}).catch(error=>{
   if(!signal.aborted&&taskDraftScope()===owner)setState({identity,error:artifactPreviewErrorMessage(error)});
  });
  return()=>{controller.abort();if(image)URL.revokeObjectURL(image);};
 },[identity,revision]);
 const current=state?.identity===identity?state:undefined,content=current?.content;
 const download=(file:Artifact)=>`${base}/v1/artifacts/${encodeURIComponent(file.artifact_id)}${file.part_index===undefined?'':`/parts/${file.part_index}`}/download?version=${file.version}`;
 return <div ref={region} tabIndex={-1} className="jot-activity-content" aria-label="步骤文件内容">
  <ArtifactVersionHistory key={JSON.stringify([owner,conversationId,target.artifactId])} conversationId={conversationId} artifactId={target.artifactId} onOpen={onOpen}/>
  <ArtifactRecovery key={JSON.stringify([owner,target.artifactId])} artifactId={target.artifactId} version={target.kind==='file'?target.version:target.toVersion} sha256={target.kind==='file'?target.sha256:target.afterSha256} partIndex={target.kind==='file'?target.partIndex:undefined} onRestored={reload}/>
  {(!current||!content&&!current.error)&&<p role="status">正在读取步骤文件…</p>}
  {content&&<section data-chat-search-content={JSON.stringify(['artifact',identity,content.file.version,content.before?.version??null])}>
   <h4>{content.file.relative_path||content.file.file_name}</h4>
   <p>{content.before?`版本 ${content.before.version} → ${content.file.version}`:`版本 ${content.file.version}`}
    {content.file.part_index!==undefined?` · 第 ${content.file.part_index} 卷`:''}
    {target.kind==='file'&&target.version===undefined?' · 当前可读文件版本':''}</p>
   {!content.file.part_count&&(!content.file.local_state||content.file.local_state==='present')&&<a href={download(content.file)} download rel="noreferrer">下载版本 {content.file.version}</a>}
   {content.before&&!content.before.part_count&&(!content.before.local_state||content.before.local_state==='present')&&<a href={download(content.before)} download rel="noreferrer">下载版本 {content.before.version}</a>}
   {content.file.part_index!==undefined&&<button type="button" data-chat-search-ignore onClick={()=>onOpen({kind:'file',artifactId:content.file.artifact_id,label:'查看全部分卷',version:1})}>返回各卷目录</button>}
   {content.file.part_count&&<ArtifactParts key={JSON.stringify([owner,content.file.artifact_id,content.file.version,content.file.sha256])} file={content.file} onOpen={onOpen}/>}
   {content.text!==undefined&&<pre>{content.text}</pre>}
   {content.image&&<img src={content.image} alt={content.file.file_name}/>}
   {content.truncated&&<p role="status">已显示前200000个字符，可下载对应版本查看全文。</p>}
   {content.notice&&<p role="status" data-chat-search-ignore>{content.notice}</p>}
   {!content.notice&&content.text===undefined&&!content.image&&<p role="status" data-chat-search-ignore>此格式可下载查看。</p>}
  </section>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试读取</button></p>}
 </div>;
}
