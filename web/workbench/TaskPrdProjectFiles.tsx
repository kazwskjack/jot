import React,{useEffect,useRef,useState} from 'react';
import {request} from '../jot/client';
import {useResource} from './useResource';
import {prdMessage} from './task-prd.mjs';
import {TaskSaveReceipt} from './task-save-receipt.mjs';
import PrdTextPreview from './PrdTextPreview';
import type {Task} from './types';
import type {TaskPrdProjectDocuments,TaskPrdProjectDocumentPreview,TaskPrdProjectDocumentImport,TaskPrdProjectDocumentImportRequest} from '../../packages/gateway/contracts/types';

const states={available:'可预览',missing:'已移除',too_large:'超过 1 MiB 读取上限'};
const previewStates={ready:'原文可读取',missing:'未找到',too_large:'超过 1 MiB 读取上限',invalid:'非受支持的 UTF-8 文本'};
const textStyle:React.CSSProperties={whiteSpace:'pre-wrap',overflowWrap:'anywhere',wordBreak:'break-word',maxWidth:'100%'};

export default function TaskPrdProjectFiles({task,locked,ready,save,onStateChange,onSaved}:{
 task:Task;locked:boolean;ready:boolean;save:TaskSaveReceipt;onStateChange:()=>void;onSaved:(receipt:TaskPrdProjectDocumentImport)=>void;
}){
 const context=`${task.task_id}:${task.version}:${task.status}`;
 const [open,setOpen]=useState(save.pending);
 const [after,setAfter]=useState(''),[previous,setPrevious]=useState<string[]>([]);
 const [preview,setPreview]=useState<TaskPrdProjectDocumentPreview|null>(null),[receipt,setReceipt]=useState<TaskPrdProjectDocumentImport|null>(null);
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const epoch=useRef(0),currentContext=useRef(context),controller=useRef<AbortController|null>(null);currentContext.current=context;
 const selected=useRef('');
 const files=useResource(signal=>request<TaskPrdProjectDocuments>(`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/taskmaster-prd-files${after?`?after=${encodeURIComponent(after)}`:''}`,'GET',undefined,undefined,signal),`${context}:${after}`,open);
 function invalidate(){epoch.current++;controller.current?.abort();selected.current='';setPreview(null);setConfirmed(false);setError('');setBusy(false);}
 useEffect(()=>{invalidate();setAfter('');setPrevious([]);},[context]);
 useEffect(()=>()=>{epoch.current++;controller.current?.abort();},[]);
 const listing=files.data?.task_id===task.task_id&&files.data.task_version===task.version?files.data:null;
 async function loadPreview(name:string){
  if(locked||busy)return;
  invalidate();const generation=epoch.current,identity=context,abort=new AbortController();controller.current=abort;setBusy(true);
  try{
   const value=await request<TaskPrdProjectDocumentPreview>(`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/taskmaster-prd-preview`,'POST',{file_name:name},undefined,abort.signal);
   if(abort.signal.aborted||generation!==epoch.current||identity!==currentContext.current)return;
   if(value.task_id!==task.task_id||value.task_version!==task.version||value.file?.path!==`.taskmaster/docs/${name}`||value.target?.path!==value.file.path
    ||value.execution_authorized!==false||!/^[a-f0-9]{64}$/.test(value.preview_sha256)||value.file.state==='ready'&&(typeof value.file.content!=='string'||!/^[a-f0-9]{64}$/.test(value.file.sha256??'')))throw Error('PRD_PREVIEW_VERSION_CONFLICT');
   selected.current=name;setPreview(value);
  }catch(e){if(!abort.signal.aborted&&generation===epoch.current&&identity===currentContext.current)setError(prdMessage(e instanceof Error?e.message:'项目 PRD 预览未完成'));}
  finally{if(generation===epoch.current)setBusy(false);}
 }
 async function importFile(){
  if(save.busy||(!save.pending&&(locked||busy||!ready||!confirmed||preview?.file.state!=='ready'||!selected.current)))return;
  setError('');
  const checkedRequest=async(path:string,method:string,body:TaskPrdProjectDocumentImportRequest,key:string)=>{
   const value=await request<TaskPrdProjectDocumentImport>(path,method,body,key),file=value?.file,source=file?.source;
   if(value?.task_id!==task.task_id||value.execution_authorized!==false||value.preview_sha256!==body.preview_sha256
    ||file?.protocol!==1||file.path!==`.taskmaster/docs/${body.file_name}`||!Number.isSafeInteger(file.version)||file.version<1||!/^[a-f0-9]{64}$/.test(file.sha256)
    ||source?.kind!=='taskmaster_prd_import'||source.task_id!==task.task_id||source.preview_sha256!==body.preview_sha256)throw Error('PRD_TASKMASTER_IMPORT_UNCONFIRMED');
   return value;
  };
  try{
   const work=save.submit(checkedRequest,`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/taskmaster-prd-import`,'POST',save.pending?{}:{file_name:selected.current,preview_sha256:preview!.preview_sha256});onStateChange();
   const value=await work;setReceipt(value);invalidate();files.reload();onSaved(value);
  }catch(e){if(!save.pending)invalidate();setError(prdMessage(e instanceof Error?e.message:'项目 PRD 导入未完成'));}
  finally{onStateChange();}
 }
 function page(cursor:string,history:string[]){if(locked||busy)return;invalidate();setAfter(cursor);setPrevious(history);}
 const disabled=locked||busy;
 return <details open={open} onToggle={e=>setOpen(e.currentTarget.open)}><summary>原项目 PRD 文件</summary>
  <p className="wb-hint">读取此任务原项目 Git 目录中的 .taskmaster/docs 文件，每页最多 50 项。选择后核对原文与目标版本，确认导入原逻辑文件版本库，再沿下方来源预览并绑定原任务。</p>
  <button type="button" disabled={disabled||files.loading} onClick={()=>{invalidate();files.reload();}}>刷新项目 PRD</button>
  {files.loading&&<p role="status">正在读取项目 PRD 文件目录…</p>}
  {files.error&&<p className="wb-error" role="alert">{prdMessage(files.error)}</p>}
  {!files.loading&&listing&&<>
   <p role="status">{listing.directory_state==='missing'?'未找到 .taskmaster/docs 目录':`共 ${listing.total} 个可列入的 PRD 文件`}。{listing.unsupported_count>0&&`另有 ${listing.unsupported_count} 个条目因文件类型或安全文件名限制无法列入。`}</p>
   <ul>{listing.files.map(file=><li key={file.path} style={{overflowWrap:'anywhere'}}>{file.name} · {file.size} 字节 · {states[file.state]} <button type="button" disabled={disabled||file.state!=='available'} onClick={()=>void loadPreview(file.name)}>预览原文</button></li>)}</ul>
   <div className="wb-actions"><button type="button" disabled={disabled||previous.length===0} onClick={()=>page(previous[previous.length-1]!,previous.slice(0,-1))}>上一页</button><button type="button" disabled={disabled||listing.next_after===null} onClick={()=>page(listing.next_after!,[...previous,after])}>下一页</button></div>
  </>}
  {busy&&<p role="status">正在读取原文快照…</p>}
  {preview&&<>
   <p role="status">{preview.file.path} · {previewStates[preview.file.state]} · {preview.file.size} 字节</p>
   {preview.file.content!==null&&<PrdTextPreview content={preview.file.content} label="原项目 PRD 原文" style={textStyle}/>}
   <dl style={textStyle}><dt>来源 SHA-256</dt><dd>{preview.file.sha256??'不可读取'}</dd><dt>目标文件 / 当前版本</dt><dd>{preview.target.path} / v{preview.target.version}</dd><dt>预览 SHA-256</dt><dd>{preview.preview_sha256}</dd></dl>
   <label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={disabled||!ready||preview.file.state!=='ready'} onChange={e=>setConfirmed(e.target.checked)}/>我已核对原文、来源和目标版本，确认保存此快照为项目文件的新版本。</label>
  </>}
  {(preview||save.pending)&&<button type="button" disabled={save.busy||(!save.pending&&(disabled||!ready||!confirmed||preview?.file.state!=='ready'))} onClick={()=>void importFile()}>{save.busy?'正在导入项目 PRD…':save.pending?'重试原 PRD 导入回执':'导入原项目 PRD'}</button>}
  {save.pending&&<p role="status">PRD 导入结果待确认，已保留原请求及 key。请重试原回执。</p>}
  {receipt&&<p role="status" style={textStyle}>已保存 {receipt.file.path} · v{receipt.file.version} · SHA-256 {receipt.file.sha256}。可从下方来源继续预览和绑定。</p>}
  {error&&<p className="wb-error" role="alert">{error}</p>}
 </details>;
}
