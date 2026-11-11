import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useState} from 'react';
import {request,taskDraftScope} from './client';
import {useResource} from '../workbench/useResource';
import ActivityArtifactDetails from './ActivityArtifactDetails';
import type {ActivityArtifactTarget} from './activity-presentation';
import type {ArtifactHistoryPage,Run} from './types';

type Props={conversationId:string;runs:Run[]};
export default function ConversationArtifacts({conversationId,runs}:Props){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),[open,setOpen]=useState(false),[cursors,setCursors]=useState<Array<string|undefined>>([undefined]);
 const [target,setTarget]=useState<ActivityArtifactTarget>(),[runId,setRunId]=useState('');
 const cursor=cursors.at(-1),identity=JSON.stringify([owner,conversationId,runId,cursor]);
 const resource=useResource(async signal=>{
  const page=await request<ArtifactHistoryPage>(`/conversations/${encodeURIComponent(conversationId)}/artifacts?limit=20${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}${runId?`&run_id=${encodeURIComponent(runId)}`:''}`,'GET',undefined,undefined,signal);
  if(taskDraftScope()!==owner||!page||page.conversation_id!==conversationId||page.run_id!==(runId||undefined)||!Array.isArray(page.items)||page.items.length>20)throw Error('成果目录来源尚未确认');
  const ids=new Set<string>();let previous:{created_at:string;artifact_id:string}|undefined;
  for(const entry of page.items){
   const file=entry?.artifact;
   if(!file||file.conversation_id!==conversationId||typeof file.artifact_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(file.artifact_id)
    ||ids.has(file.artifact_id)||file.artifact_id===cursor||!Number.isSafeInteger(file.version)||file.version<1
    ||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||typeof file.file_name!=='string'||typeof entry.created_at!=='string'
    ||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<0||file.part_count!==undefined&&(!Number.isSafeInteger(file.part_count)||file.part_count<1||file.part_count>50)
    ||previous&&(entry.created_at>previous.created_at||entry.created_at===previous.created_at&&file.artifact_id>=previous.artifact_id))throw Error('成果目录来源尚未确认');
   ids.add(file.artifact_id);previous={created_at:entry.created_at,artifact_id:file.artifact_id};
  }
  if(page.next_cursor!==undefined&&(page.items.length!==20||page.next_cursor!==previous?.artifact_id||cursors.includes(page.next_cursor)))throw Error('成果分页来源尚未确认');
  return {identity,page};
 },identity,open&&!!owner);
 const page=resource.data?.identity===identity&&taskDraftScope()===owner?resource.data.page:undefined;
 return <details lang={language} open={open} onToggle={event=>setOpen(event.currentTarget.open)} aria-label={t('会话成果目录','Conversation Artifact Catalog')}>
  <summary>{t('会话成果与文件历史','Conversation Artifacts and File History')}</summary>
  {open&&<>
   <label data-chat-search-ignore>{t('所属运行','Run')} <select value={runId} onChange={event=>{setRunId(event.currentTarget.value);setCursors([undefined]);setTarget(undefined);}}>
    <option value="">{t('全部运行与上传文件','All Runs and Uploaded Files')}</option>
    {runs.map(run=><option key={run.run_id} value={run.run_id}>{run.created_at} · {run.status}</option>)}
   </select></label>
   <p data-chat-search-ignore>{t(`每页20项，第 ${cursors.length} 页。`,`20 items per page. Page ${cursors.length}.`)}</p>
   <button type="button" disabled={resource.loading} data-chat-search-ignore onClick={()=>{setCursors([undefined]);resource.reload();}}>{t('刷新成果目录','Refresh Artifact Catalog')}</button>
   {resource.loading&&<p role="status">{t('正在读取会话成果…','Reading conversation artifacts…')}</p>}
   {resource.error&&<p role="alert">{conversationUiError(resource.error,language)} <button type="button" onClick={resource.reload}>{t('重试读取目录','Retry Reading Catalog')}</button></p>}
   {page&&!resource.loading&&!resource.error&&<>
    {!page.items.length&&<p>{t('此会话暂无已登记文件。','This conversation has no registered files yet.')}</p>}
    <ol>{page.items.map(({created_at,artifact:file})=><li key={file.artifact_id}>
     <span>{file.relative_path||file.file_name} · {created_at} · {t('版本','Version')} {file.version} · {file.size_bytes} {t('字节','bytes')}{file.part_count?t(` · ${file.part_count} 卷`,` · ${file.part_count} parts`):''}</span>
     {file.status==='ready'?<button type="button" data-chat-search-ignore onClick={()=>setTarget({kind:'file',artifactId:file.artifact_id,label:file.file_name,version:file.version,sha256:file.sha256})}>{t('查看文件与版本','View File and Version')}</button>:<span>{t(' · 当前不可读取',' · Currently unreadable')}</span>}
    </li>)}</ol>
    <nav aria-label={t('成果目录翻页','Artifact Catalog Pages')} data-chat-search-ignore>
     <button type="button" disabled={cursors.length===1} onClick={()=>setCursors(values=>values.slice(0,-1))}>{t('上一页','Previous Page')}</button>
     <button type="button" disabled={!page.next_cursor} onClick={()=>setCursors(values=>[...values,page.next_cursor])}>{t('下一页','Next Page')}</button>
    </nav>
   </>}
   {target&&<section aria-label={t('已选会话成果','Selected Conversation Artifact')}>
    <button type="button" data-chat-search-ignore onClick={()=>setTarget(undefined)}>{t('关闭成果详情','Close Artifact Details')}</button>
    <ActivityArtifactDetails key={JSON.stringify([owner,conversationId,target.artifactId])} conversationId={conversationId} target={target} onOpen={setTarget}/>
   </section>}
  </>}
 </details>;
}
