import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {memoryUiMessage} from './memory-ui-messages';
import React,{useEffect,useRef,useState} from 'react';
import type {WorkbenchMemoryImportBundle,WorkbenchMemoryImportBundleSource} from '../../packages/gateway/contracts/types';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import PrdTextPreview from './PrdTextPreview';
import MemoryImportHistory from './MemoryImportHistory';

export default function MemoryImportBundle({workspace,importId,inputHash,bundle}:{workspace:string;importId:string;inputHash:string;bundle:WorkbenchMemoryImportBundle}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>memoryUiMessage(value,language);
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
 return <section lang={language} aria-label={t('上游记忆源包','Upstream Memory Source Bundle')} className="wb-form">
  <h4>{t("上游当前项目记忆快照","Upstream Current-project Memory Snapshot")}</h4>
  <p>{bundle.format_version}{t(` · ${bundle.file_count} 个文件 · 原文件 UTF-8 共 ${bundle.total_utf8_bytes} 字节`,` · ${bundle.file_count} Files · ${bundle.total_utf8_bytes} Original UTF-8 Bytes`)}</p>
  <p>{t(`可识别记忆文件 ${bundle.memory_file_count} 个，其中已废弃 ${bundle.deprecated_file_count} 个。global/ 来源文件 ${bundle.global_file_count} 个，其他源资料文件 ${bundle.source_only_file_count} 个，完整原文随源包保留。`,`${bundle.memory_file_count} Recognized Memory Files, Including ${bundle.deprecated_file_count} Deprecated Files. ${bundle.global_file_count} global/ Source Files and ${bundle.source_only_file_count} Other Source Files; Complete Original Text Retained in the Bundle.`)}</p>
  <p>{t("索引与 Dream 状态作为导入来源记录，正式记忆沿原有索引任务更新。上游文件以完整 SHA-256 区分版本，转换条目版本表示导入适配版本，原批次继续使用捕获时的适配规则。","Index and Dream states are recorded as import provenance. Formal memory follows the original indexing tasks. Complete SHA-256 hashes distinguish upstream file versions; converted entry versions identify import adapter versions. Original batches retain the adapter rules captured at creation.")}</p>
  <dl><dt>{t("包导出时间","Bundle Export Time")}</dt><dd>{metadata.exported_at??t("原始值见源包","See Source Bundle for Original Value")}</dd><dt>{t("原索引时间","Original Index Time")}</dt><dd>{metadata.last_indexed_at??t("未提供","Not Supplied")}</dd><dt>{t("原 Dream 时间与状态","Original Dream Time and Status")}</dt><dd>{metadata.last_dream_at??t("未提供","Not Supplied")} · {metadata.last_dream_status??t("未提供","Not Supplied")}</dd></dl>
  <p>{t(`Case 记录 ${metadata.case_trace_count} 条 · 索引记录 ${metadata.index_trace_count} 条 · Dream 记录 ${metadata.dream_trace_count} 条 · Dream 摘要 ${metadata.last_dream_summary_chars} 字符`,`${metadata.case_trace_count} Case Records · ${metadata.index_trace_count} Index Records · ${metadata.dream_trace_count} Dream Records · ${metadata.last_dream_summary_chars} Dream Summary Characters`)}</p>
  <p style={{overflowWrap:'anywhere'}}>{t('源包 SHA-256 ','Source Bundle SHA-256 ')}{bundle.sha256}</p>
  <MemoryImportHistory key={`${workspace}:${importId}:${inputHash}`} workspace={workspace} importId={importId} inputHash={inputHash} bundleHash={bundle.sha256}/>
  {error&&<p role="alert" className="wb-error">{message(error)}</p>}
  <button type="button" disabled={busy} onClick={()=>void read()}>{busy?t("正在读取并核对源包…","Reading and Verifying Source Bundle…"):t("读取完整源包","Read Complete Source Bundle")}</button>
  {source?.source_file&&<p role="status">{t(`已核对原项目文件 ${source.source_file.path} 的 v${source.source_file.version}。可通过上方原始源文件入口下载完整字节。`,`Verified Original Project File ${source.source_file.path} v${source.source_file.version}. Download All Original Bytes Using the Source File Entry Above.`)}</p>}
  {source?.bundle&&<><button type="button" onClick={download}>{t("下载已核对源包","Download Verified Source Bundle")}</button><details><summary>{t("分段查看完整文件与状态记录","Read Complete Files and Status Records in Segments")}</summary><PrdTextPreview content={JSON.stringify(source.bundle,null,2)} label={t('记忆源包','Memory Source Bundle')} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}/></details></>}
 </section>;
}
