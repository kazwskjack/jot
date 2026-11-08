import React,{useEffect,useRef,useState} from 'react';
import type {WorkbenchMemoryImportBundle,WorkbenchMemoryImportBundleSource} from '../../packages/gateway/contracts/types';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import PrdTextPreview from './PrdTextPreview';
import MemoryImportHistory from './MemoryImportHistory';

export default function MemoryImportBundle({workspace,importId,inputHash,bundle}:{workspace:string;importId:string;inputHash:string;bundle:WorkbenchMemoryImportBundle}){
 const owner=taskDraftScope(),alive=useRef(true);
 const [source,setSource]=useState<WorkbenchMemoryImportBundleSource|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const read=async()=>{
  if(busy||!current())return;setBusy(true);setError('');
  try{
   const value=await workbenchApi.memoryImportSource(workspace,importId);
   if(value.import_id!==importId||value.input_sha256!==inputHash||value.sha256!==bundle.sha256||value.execution_authorized!==false)
    throw Error('源包回执与原导入批次不一致');
   if(value.source_file){
    if(value.source_file.kind!=='workspace_file'||value.source_file.sha256!==bundle.sha256)throw Error('源文件与原始源包 SHA-256 不一致');
    if(current())setSource(value);return;
   }
   if(!value.bundle)throw Error('原始源包内容不可用');
   const bytes=new TextEncoder().encode(JSON.stringify(value.bundle)),digest=await crypto.subtle.digest('SHA-256',bytes);
   const actual=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
   if(actual!==bundle.sha256)throw Error('源包内容与 SHA-256 不一致');
   if(current())setSource(value);
  }catch(reason){if(current())setError(reason instanceof Error?reason.message:'源包读取失败');}
  finally{if(current())setBusy(false);}
 };
 const download=()=>{
  if(!source?.bundle||!current())return;
  const blob=new Blob([JSON.stringify(source.bundle,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),anchor=window.document.createElement('a');
  try{anchor.href=url;anchor.download=`pilotdeck-memory-${bundle.sha256}.json`;window.document.body.appendChild(anchor);anchor.click();}
  finally{anchor.remove();URL.revokeObjectURL(url);}
 };
 const metadata=bundle.metadata;
 return <section aria-label="上游记忆源包" className="wb-form">
  <h4>上游当前项目记忆快照</h4>
  <p>{bundle.format_version} · {bundle.file_count} 个文件 · 原文件 UTF-8 共 {bundle.total_utf8_bytes} 字节</p>
  <p>项目记忆文件 {bundle.memory_file_count} 个，其中已废弃 {bundle.deprecated_file_count} 个。全局用户文件 {bundle.global_file_count} 个，其他源资料文件 {bundle.source_only_file_count} 个，完整原文随源包保留。</p>
  <p>索引与 Dream 状态作为导入来源记录，正式记忆沿原有索引任务更新。上游文件以完整 SHA-256 区分版本，转换条目的 v1 表示导入适配版本。</p>
  <dl><dt>包导出时间</dt><dd>{metadata.exported_at??'原始值见源包'}</dd><dt>原索引时间</dt><dd>{metadata.last_indexed_at??'未提供'}</dd><dt>原 Dream 时间与状态</dt><dd>{metadata.last_dream_at??'未提供'} · {metadata.last_dream_status??'未提供'}</dd></dl>
  <p>Case 记录 {metadata.case_trace_count} 条 · 索引记录 {metadata.index_trace_count} 条 · Dream 记录 {metadata.dream_trace_count} 条 · Dream 摘要 {metadata.last_dream_summary_chars} 字符</p>
  <p style={{overflowWrap:'anywhere'}}>源包 SHA-256 {bundle.sha256}</p>
  <MemoryImportHistory key={`${workspace}:${importId}:${inputHash}`} workspace={workspace} importId={importId} inputHash={inputHash} bundleHash={bundle.sha256}/>
  {error&&<p role="alert" className="wb-error">{error}</p>}
  <button type="button" disabled={busy} onClick={()=>void read()}>{busy?'正在读取并核对源包…':'读取完整源包'}</button>
  {source?.source_file&&<p role="status">已核对原项目文件 {source.source_file.path} 的 v{source.source_file.version}。可通过上方原始源文件入口下载完整字节。</p>}
  {source?.bundle&&<><button type="button" onClick={download}>下载已核对源包</button><details><summary>分段查看完整文件与状态记录</summary><PrdTextPreview content={JSON.stringify(source.bundle,null,2)} label="记忆源包" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}/></details></>}
 </section>;
}
