import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import ArtifactEditedDiff from './ArtifactEditedDiff';
import {isDocumentPreviewMediaType} from './document-preview-content.mjs';
import React,{useState} from 'react';
import {request,taskDraftScope} from './client';
import {useResource} from '../workbench/useResource';
import type {Artifact,ArtifactVersionPage} from './types';
import type {ActivityArtifactTarget} from './activity-presentation';

export default function ArtifactVersionHistory({conversationId,artifactId,onOpen}:{conversationId:string;artifactId:string;onOpen:(target:ActivityArtifactTarget)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),[open,setOpen]=useState(false),[cursors,setCursors]=useState<Array<number|undefined>>([undefined]);
 const [before,setBefore]=useState<Artifact>(),[after,setAfter]=useState<Artifact>();
 const [edited,setEdited]=useState<Artifact>();
 const cursor=cursors.at(-1),identity=JSON.stringify([owner,conversationId,artifactId,cursor]);
 const resource=useResource(async signal=>{
  const page=await request<ArtifactVersionPage>(`/artifacts/${encodeURIComponent(artifactId)}/versions?limit=20${cursor===undefined?'':`&before_version=${cursor}`}`,'GET',undefined,undefined,signal);
  if(taskDraftScope()!==owner||!page||page.artifact_id!==artifactId||page.conversation_id!==conversationId
   ||!Number.isSafeInteger(page.current_version)||page.current_version<1||!Array.isArray(page.items)||page.items.length>20)throw Error('文件版本目录来源尚未确认');
  let previous=cursor??page.current_version+1;
  for(const file of page.items){
   if(!file||file.artifact_id!==artifactId||file.conversation_id!==conversationId||!Number.isSafeInteger(file.version)||file.version<1
    ||file.version>=previous||file.version>page.current_version||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)
    ||typeof file.file_name!=='string'||typeof file.media_type!=='string'||typeof file.created_at!=='string'
    ||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||!['ready','quarantined','rejected','deleted'].includes(file.status))throw Error('文件版本目录来源尚未确认');
   previous=file.version;
  }
  if(cursor===undefined&&page.items[0]?.version!==page.current_version
   ||page.next_before_version!==undefined&&(page.items.length!==20||page.next_before_version!==previous))throw Error('文件版本分页尚未确认');
  return {identity,page};
 },identity,open&&!!owner);
 const page=resource.data?.identity===identity&&taskDraftScope()===owner?resource.data.page:undefined;
 const comparable=before&&after&&before.version<after.version;
 return <><details lang={language} open={open} onToggle={event=>setOpen(event.currentTarget.open)} data-chat-search-ignore>
  <summary>{t('文件版本历史','File Version History')}</summary>
  {open&&<>
   <p>{t(`每页20个固定版本，当前第 ${cursors.length} 页。`,`20 pinned versions per page. Current page: ${cursors.length}.`)}</p>
   <button type="button" disabled={resource.loading} onClick={()=>{setCursors([undefined]);setBefore(undefined);setAfter(undefined);setEdited(undefined);resource.reload();}}>{t('刷新版本目录','Refresh Version Catalog')}</button>
   {resource.loading&&<p role="status">{t('正在读取版本目录…','Reading version catalog…')}</p>}
   {resource.error&&<p role="alert">{conversationUiError(resource.error,language)} <button type="button" onClick={resource.reload}>{t('重试读取目录','Retry Reading Catalog')}</button></p>}
   {page&&!resource.loading&&!resource.error&&<>
    <p>{t('当前版本','Current Version')} {page.current_version}</p>
    <ol>{page.items.map(file=><li key={file.version}>
     <span>{t('版本','Version')} {file.version} · {file.file_name} · {file.created_at} · {file.size_bytes} {t('字节','bytes')}</span>
     {file.status==='ready'?<>
      <button type="button" onClick={()=>onOpen({kind:'file',artifactId,label:file.file_name,version:file.version,sha256:file.sha256})}>{t('查看版本','View Version')} {file.version}</button>
      {file.origin==='edited'&&!file.part_count&&isDocumentPreviewMediaType(file.media_type)&&<button type="button" onClick={()=>setEdited(file)}>{t('查看原编辑差异','View Original Edit Diff')}</button>}
      {!file.part_count&&file.media_type.startsWith('text/')&&<>
       <button type="button" aria-pressed={before?.version===file.version} onClick={()=>setBefore(file)}>{t('选为比较起点','Select as Comparison Start')}</button>
       <button type="button" aria-pressed={after?.version===file.version} onClick={()=>setAfter(file)}>{t('选为比较终点','Select as Comparison End')}</button>
      </>}
     </>:<span>{t(' · 此版本当前不可读取',' · This version is currently unreadable')}</span>}
    </li>)}</ol>
    <button type="button" disabled={cursors.length===1} onClick={()=>setCursors(values=>values.slice(0,-1))}>{t('上一页','Previous Page')}</button>
    <button type="button" disabled={page.next_before_version===undefined} onClick={()=>setCursors(values=>[...values,page.next_before_version])}>{t('下一页','Next Page')}</button>
   </>}
   {(before||after)&&<p>{t('比较起点','Comparison Start')} {before?t(`版本 ${before.version}`,`Version ${before.version}`):t('待选择','Not Selected')} → {t('终点','End')} {after?t(`版本 ${after.version}`,`Version ${after.version}`):t('待选择','Not Selected')}</p>}
   <button type="button" disabled={!comparable} onClick={()=>{if(before&&after&&comparable)onOpen({kind:'diff',artifactId,label:after.file_name,fromVersion:before.version,toVersion:after.version,beforeSha256:before.sha256,afterSha256:after.sha256});}}>{t('查看所选版本差异','View Selected Version Diff')}</button>
   {before&&after&&!comparable&&<p role="status">{t('请选择两个不同版本，比较起点需要早于终点。','Select two different versions, with the comparison start earlier than the end.')}</p>}
  </>}
 </details>
 {open&&edited&&edited.artifact_id===artifactId&&edited.conversation_id===conversationId&&<>
  <button lang={language} type="button" data-chat-search-ignore onClick={()=>setEdited(undefined)}>{t('关闭原编辑差异','Close Original Edit Diff')}</button>
  <ArtifactEditedDiff key={JSON.stringify([owner,artifactId,edited.version,edited.sha256])} conversationId={conversationId} file={edited}/>
 </>}</>;
}
