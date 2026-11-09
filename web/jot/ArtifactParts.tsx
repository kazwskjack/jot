import React from 'react';
import {base,request,taskDraftScope} from './client';
import {useResource} from '../workbench/useResource';
import type {Artifact,ArtifactPartsPage} from './types';
import type {ActivityArtifactTarget} from './activity-presentation';

export default function ArtifactParts({file,onOpen}:{file:Artifact;onOpen:(target:ActivityArtifactTarget)=>void}){
 const owner=taskDraftScope(),identity=JSON.stringify([owner,file.conversation_id,file.artifact_id,file.version,file.sha256]);
 const resource=useResource(async signal=>{
  const page=await request<ArtifactPartsPage>(`/artifacts/${encodeURIComponent(file.artifact_id)}/parts?version=${file.version}`,'GET',undefined,undefined,signal);
  if(taskDraftScope()!==owner||!page||page.artifact_id!==file.artifact_id||page.conversation_id!==file.conversation_id
   ||page.version!==file.version||page.sha256!==file.sha256||!Array.isArray(page.items)||page.items.length!==file.part_count||page.items.length>50)throw Error('分卷成果来源尚未确认');
  let total=0;
  page.items.forEach((part,index)=>{
   if(!part||part.artifact_id!==file.artifact_id||part.conversation_id!==file.conversation_id||part.version!==file.version||part.part_index!==index+1
    ||typeof part.file_name!=='string'||typeof part.media_type!=='string'||typeof part.sha256!=='string'||!/^[a-f0-9]{64}$/.test(part.sha256)
    ||!Number.isSafeInteger(part.size_bytes)||part.size_bytes<1||part.size_bytes>19*1024*1024||part.status!=='ready'
    ||!['present','deleted','restoring'].includes(part.local_state??''))throw Error('分卷成果来源尚未确认');
   total+=part.size_bytes;
  });
  if(total!==file.size_bytes)throw Error('分卷成果大小尚未确认');
  return {identity,page};
 },identity,!!owner);
 const page=resource.data?.identity===identity&&taskDraftScope()===owner?resource.data.page:undefined;
 return <section aria-label="成果各卷文件" data-chat-search-ignore>
  {resource.loading&&<p role="status">正在读取各卷文件…</p>}
  {resource.error&&<p role="alert">{resource.error} <button type="button" onClick={resource.reload}>重试读取各卷</button></p>}
  {page&&<ol>{page.items.map(part=><li key={part.part_index}>
   <span>第 {part.part_index} 卷 · {part.file_name} · {part.size_bytes} 字节</span>
   <button type="button" onClick={()=>onOpen({kind:'file',artifactId:part.artifact_id,label:part.file_name,version:part.version,sha256:part.sha256,partIndex:part.part_index})}>查看第 {part.part_index} 卷</button>
   {part.local_state==='present'?<a href={`${base}/v1/artifacts/${encodeURIComponent(part.artifact_id)}/parts/${part.part_index}/download?version=${part.version}`} download rel="noreferrer">下载第 {part.part_index} 卷</a>:<span> · 本地文件暂不可用</span>}
  </li>)}</ol>}
 </section>;
}
