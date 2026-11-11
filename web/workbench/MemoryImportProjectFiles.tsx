import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {memoryUiMessage} from './memory-ui-messages';
import React,{useEffect,useRef,useState} from 'react';
import type {WorkbenchMemoryImportFileSelection,WorkbenchMemoryImportFileSource} from '../../packages/gateway/contracts/types';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {downloadWorkspaceFile} from './workspace-directory-flow.mjs';

export default function MemoryImportProjectFiles({workspace,project,disabled,onSelect}:{workspace:string;project:string;disabled:boolean;onSelect:(source:WorkbenchMemoryImportFileSelection)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>memoryUiMessage(value,language);
 const [cursors,setCursors]=useState(['']),cursor=cursors.at(-1)!;
 const files=useResource(signal=>workbenchApi.files(workspace,project,{limit:50,...(cursor?{cursor}:{})},signal),JSON.stringify([taskDraftScope(),workspace,project,cursor]));
 return <section lang={language} className="wb-form" aria-label={t("选择项目源文件","Choose Project Source File")}>
  <p>{t("选择已上传的 JSON 文件版本，最多 100 MiB。上游 v4 源包使用原始文件字节、大小和 SHA-256 校验，Jot v1 按 200 条、5,000,000 字符规则读取。","Choose an uploaded JSON file version, up to 100 MiB. Upstream v4 bundles use original bytes, size and SHA-256 verification. Jot v1 reads remain limited to 200 items and 5,000,000 characters.")}</p>
  {files.error&&<p role="alert" className="wb-error">{message(files.error)}</p>}
  <div className="wb-actions"><button type="button" disabled={disabled||files.loading} onClick={()=>{setCursors(['']);files.reload();}}>{t("刷新项目文件","Refresh Project Files")}</button><button type="button" disabled={disabled||files.loading||cursors.length===1} onClick={()=>setCursors(current=>current.slice(0,-1))}>{t("上一页项目文件","Previous Project Files Page")}</button>{files.data?.next_cursor&&<button type="button" disabled={disabled||files.loading||cursors.includes(files.data.next_cursor)} onClick={()=>setCursors(current=>[...current,files.data!.next_cursor!])}>{t("下一页项目文件","Next Project Files Page")}</button>}</div>
  {files.loading&&<p role="status">{t("正在读取项目文件版本…","Reading Project File Versions…")}</p>}
  {files.data?.items.map(file=><article key={`${file.path}:${file.version}`}>
   <strong>{file.path} · v{file.version}</strong><p>{file.size}{t(' 字节 · SHA-256 ',' Bytes · SHA-256 ')}{file.sha256}</p>
   <button type="button" disabled={disabled||files.loading||file.size>104_857_600} onClick={()=>onSelect({kind:'workspace_file',path:file.path,version:file.version,sha256:file.sha256,size:file.size})}>{t("预览此版本的记忆来源","Preview Memory Source from This Version")}</button>
  </article>)}
 </section>;
}

export function MemoryImportSourceFile({source}:{source:WorkbenchMemoryImportFileSource}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>memoryUiMessage(value,language);
 const owner=taskDraftScope(),alive=useRef(true);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const download=async()=>{
  if(busy||!current())return;setBusy(true);setError('');
  try{
   const bytes=await downloadWorkspaceFile(source,{workspace:source.workspace_id,project:source.project_id,api:workbenchApi});
   if(!current())return;
   const blob=new Blob([new Uint8Array(bytes)],{type:'application/json'}),url=URL.createObjectURL(blob),anchor=window.document.createElement('a');
   try{anchor.href=url;anchor.download=source.path.split('/').at(-1)??'memory-source.json';window.document.body.appendChild(anchor);anchor.click();}
   finally{anchor.remove();URL.revokeObjectURL(url);}
  }catch(reason){if(current())setError(reason instanceof Error?reason.message:'原始源文件下载失败');}
  finally{if(current())setBusy(false);}
 };
 return <section lang={language} className="wb-form" aria-label={t("原项目源文件版本","Original Project Source File Version")}>
  <p>{t(`源文件 ${source.path} · v${source.version} · ${source.size} 字节`,`Source File ${source.path} · v${source.version} · ${source.size} Bytes`)}</p><p style={{overflowWrap:'anywhere'}}>{t('原始字节 SHA-256 ','Original Bytes SHA-256 ')}{source.sha256}</p>
  {error&&<p className="wb-error" role="alert">{message(error)}</p>}
  <button type="button" disabled={busy} onClick={()=>void download()}>{busy?t('正在读取并核对原始文件…','Reading and Verifying Original File…'):t('下载原始源文件版本','Download Original Source File Version')}</button>
 </section>;
}
