import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {memoryUiMessage} from './memory-ui-messages';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import type {WorkbenchMemoryImportPreview,WorkbenchMemoryImportReceipt,WorkbenchMemoryImportTarget,WorkbenchMemoryImportFileSelection} from '../../packages/gateway/contracts/types';
import {request,taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import {useMutationReceipt} from './useMutationReceipt';
import {MemoryImportStore} from './memory-import-store.mjs';
import MemoryImportBundle from './MemoryImportBundle';
import MemoryImportReplacement,{MemoryImportRetirements} from './MemoryImportReplacement';
import MemoryImportProjectFiles,{MemoryImportSourceFile} from './MemoryImportProjectFiles';

const reasons:Record<string,string>={source_superseded:'来源已被替代',source_tombstone:'来源已删除',source_expired:'来源已过期',source_changed:'来源版本或内容已变化',target_exists:'此来源版本已导入',target_tombstone:'此来源的导入记忆已删除或被替代',provenance_limit:'来源引用已达上限'};
const pageSize=25;
function importMessage(reason:unknown){
 const code=reason instanceof Error?reason.message:'';
 if(['MEMORY_IMPORT_CONFLICT','VERSION_CONFLICT'].includes(code))return '来源、目标或预览版本已变化，整批未写入。请重新核对原文件。';
 if(code==='MEMORY_IMPORT_FILE_SOURCE_CHANGED')return '项目源文件的版本、大小或 SHA-256 与所选记录不一致，请核对原版本。';
 if(code==='INVALID_MEMORY_IMPORT_FILE_SOURCE')return '所选项目文件须为 UTF-8 JSON 记忆来源。';
 if(code==='INVALID_MEMORY_IMPORT_BUNDLE')return '请核对 clawxmemory-memory-snapshot.v4 当前项目包的格式、重复路径及目录层级。';
 if(code==='MEMORY_IMPORT_ID_CONFLICT')return '此批次已绑定另一份来源或目标。请读取原记录，或结束此批次后选择其他文件。';
 return code||'记忆导入未完成，请核对原记录';
}


export default function MemoryImport({workspace,selection,onChanged,onBusyChange}:{workspace:string;selection:{scope:'project'|'private';project_id:string;agent_id:string};onChanged:()=>void;onBusyChange:(busy:boolean)=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>memoryUiMessage(value,language);
 const states={ready:t('可导入','Ready to Import'),skipped:t('跳过','Skipped'),conflict:t('冲突','Conflict')};
 const owner=taskDraftScope();
 const target:WorkbenchMemoryImportTarget={scope:selection.scope,project_id:selection.project_id,agent_id:selection.scope==='private'?selection.agent_id:null};
 const recovery=useMemo(()=>{
  try{const store=new MemoryImportStore(sessionStorage,owner,workspace,target);return {store,batch:store.read()?.batch??null,error:''};}
  catch(error){return {store:null,batch:null,error:error instanceof Error?error.message:'记忆导入恢复记录不可用'};}
 },[owner,workspace,selection.scope,selection.project_id,selection.agent_id]);
 const [projectFiles,setProjectFiles]=useState(false);
 const [mode,setMode]=useState<'append'|'replace_scope'>(recovery.batch?.mode??'append');
 const [id,setId]=useState(recovery.batch?.import_id??''),[view,setView]=useState<WorkbenchMemoryImportPreview|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[page,setPage]=useState(0);
 const [receipt,setReceipt]=useState<WorkbenchMemoryImportReceipt|null>(null);
 const document=useRef<unknown>(recovery.batch?.source_file??null),alive=useRef(true);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const matches=(value:{import_id:string;target:WorkbenchMemoryImportTarget},expected:string)=>value?.import_id===expected&&JSON.stringify(value.target)===JSON.stringify(target);
 const mutation=useMutationReceipt(recovery.store??undefined,undefined,async(path,method,body,key)=>{
  if(!current())throw new Error('账号范围已改变，请返回原账号核对');
  const value=await request<WorkbenchMemoryImportReceipt>(path,method,body,key),batch=recovery.store?.read()?.batch;
  if(!batch||!matches(value,batch.import_id)||value.status!=='applied')throw new Error('导入回执与原批次不一致，请重试原请求');
  return value;
 });
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{onBusyChange(busy||mutation.pending);return()=>onBusyChange(false);},[busy,mutation.pending,onBusyChange]);
 const read=async(batchId:string,offset=0)=>{
  const value=await workbenchApi.memoryImport(workspace,batchId,undefined,offset);
  if(!matches(value,batchId))throw new Error('导入记录与所选目标范围不一致');
  if(current()){setView(value);setReceipt(value.receipt??null);setMode(value.mode??'append');setConfirmed(false);setPage(Math.floor((value.page?.offset??0)/pageSize));}
 };
 useEffect(()=>{
  const batchId=recovery.batch?.import_id;if(!batchId||!recovery.store)return;
  setBusy(true);setError('');
  void read(batchId).catch(reason=>{if(current())setError(Number((reason as {status?:number})?.status)===404?'批次尚未保存。可重新选择原文件继续预览，来源或目标改变会被服务端拒绝。':importMessage(reason));})
   .finally(()=>{if(current())setBusy(false);});
 },[recovery]);
 const preview=async(source:unknown,batchId:string)=>{
  const value=await workbenchApi.previewMemoryImport(workspace,{import_id:batchId,document:source,target,...(mode==='replace_scope'?{mode}:{})},crypto.randomUUID(),undefined,0);
  if(!matches(value,batchId))throw new Error('导入预览与所选目标范围不一致');
  if(current()){setView(value);setReceipt(value.receipt??null);setConfirmed(false);setPage(0);}
 };
 const chooseProjectFile=async(source:WorkbenchMemoryImportFileSelection)=>{
  if(busy||mutation.pending||!recovery.store||!current())return;setBusy(true);setError('');setConfirmed(false);
  try{
   const batchId=id||crypto.randomUUID();
   if(!id){recovery.store.saveBatch(batchId,mode,source);setId(batchId);}
   document.current=source;await preview(source,batchId);
  }catch(reason){if(current())setError(importMessage(reason));}
  finally{if(current())setBusy(false);}
 };
 const choose=async(event:React.ChangeEvent<HTMLInputElement>)=>{
  const file=event.target.files?.[0];event.target.value='';if(!file||busy||mutation.pending||!recovery.store)return;
  setBusy(true);setError('');setConfirmed(false);
  try{
   if(file.size>20_000_000)throw new Error('记忆导入文件超过 20 MB');
   const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()),source=JSON.parse(text);
   if(JSON.stringify(source).length>5_000_000)throw new Error('记忆导入文档超过 5,000,000 字符');
   if(!current())return;
   const batchId=id||crypto.randomUUID();
   if(!id){recovery.store.saveBatch(batchId,mode);setId(batchId);}
   document.current=source;await preview(source,batchId);
  }catch(reason){if(current())setError(importMessage(reason));}
  finally{if(current())setBusy(false);}
 };
 const refresh=async()=>{
  if(!id||busy)return;setBusy(true);setError('');
  try{if(document.current&&!mutation.pending)await preview(document.current,id);else await read(id);}
  catch(reason){if(current())setError(importMessage(reason));}
  finally{if(current())setBusy(false);}
 };
 const loadPage=async(offset:number)=>{
  if(!id||busy)return;setBusy(true);setError('');
  try{await read(id,offset);}catch(reason){if(current())setError(importMessage(reason));}
  finally{if(current())setBusy(false);}
 };
 const apply=async()=>{
  if(busy||!recovery.store)return;
  setBusy(true);setError('');
  try{
   const pending=recovery.store.read()?.command;
   if(!pending&&(!view||!confirmed||view.status!=='previewed'||view.counts.conflict||!view.counts.total&&!view.source_bundle))return;
   const value=await mutation.submit(pending?.path??recovery.store.path(id,true),'POST',pending?.body??{expected_version:view!.version}) as WorkbenchMemoryImportReceipt;
   if(current()){setReceipt(value);setView(previous=>previous?.version===value.version&&(previous.page?.offset??0)===(value.page?.offset??0)?{...previous,status:'applied',receipt:value}:null);setConfirmed(false);onChanged();}
  }catch(reason){if(current())setError(importMessage(reason));}
  finally{if(current())setBusy(false);}
 };
 const clear=()=>{
  try{recovery.store?.clear();setId('');setView(null);setReceipt(null);setConfirmed(false);setError('');document.current=null;}
  catch(reason){setError(reason instanceof Error?reason.message:'恢复记录未能清理');}
 };
 const blocked=busy||mutation.pending||!!recovery.error;
 return <section lang={language} className="wb-form" aria-label={t('版本化记忆导入','Versioned Memory Import')} aria-busy={busy}>
  <h3>{t("导入记忆 JSON","Import Memory JSON")}</h3>
  <p className="wb-hint">{t("选择 Jot schema_version 1 文档或上游 clawxmemory-memory-snapshot.v4 当前项目包，文件最多 20 MB、本地 JSON 最多 5,000,000 字符。较大源包可从已上传的项目文件中选取精确版本。Jot 格式每批最多 200 条记忆、每条 500 个历史版本。上游文件包按完整字符分段生成全部条目，每段最多 20,000 字符，按服务端分页核对，源包保留完整原文。核对后整批导入为待核实记忆。删除标记、过期来源及冲突会由服务端重新检查。","Choose a Jot schema_version 1 document or an upstream clawxmemory-memory-snapshot.v4 current-project bundle. Local files are limited to 20 MB and JSON to 5,000,000 characters. Larger bundles can use an exact uploaded project file version. Jot batches allow up to 200 memories and 500 historical versions per memory. Upstream files are split at complete character boundaries into all entries, up to 20,000 characters each, for server-paged review. The source bundle retains the complete original text. Confirmed batches import as unverified memories. The server rechecks deletion markers, expired sources and conflicts.")}</p>
  <p>{t('目标工作区 ','Target Workspace ')}{workspace}{t(' · 项目 ',' · Project ')}{target.project_id} · {target.scope==='private'?t(`角色私有 ${target.agent_id}`,`Role Private ${target.agent_id}`):t("项目共享","Project Shared")}</p>
  {(error||recovery.error)&&<p className="wb-error" role="alert">{message(error||recovery.error)}</p>}
  <label>{t("导入方式","Import Mode")}<select value={mode} disabled={blocked||!!id} onChange={event=>setMode(event.target.value as 'append'|'replace_scope')}><option value="append">{t("追加到所选范围","Append to Selected Scope")}</option><option value="replace_scope">{t("用上游文件包替换所选范围","Replace Selected Scope with Upstream Bundle")}</option></select></label>
  <button type="button" disabled={blocked} onClick={()=>setProjectFiles(value=>!value)}>{projectFiles?t("收起项目源文件","Hide Project Source Files"):t("从已上传的项目文件选择","Choose from Uploaded Project Files")}</button>
  {projectFiles&&<MemoryImportProjectFiles workspace={workspace} project={target.project_id} disabled={blocked||!recovery.store||view?.status==='applied'} onSelect={source=>void chooseProjectFile(source)}/>}
  <label>{t("选择本地记忆文件","Choose Local Memory File")}<input type="file" accept=".json,application/json" disabled={blocked||!recovery.store||view?.status==='applied'} onChange={event=>void choose(event)}/></label>
  {id&&<><p style={{overflowWrap:'anywhere'}}>{t("导入批次 ","Import Batch ")}{id}</p><div className="wb-actions"><button type="button" disabled={busy} onClick={()=>void refresh()}>{document.current&&!mutation.pending?t("重新核对原文件","Check Original File Again"):t("读取原导入记录","Read Original Import Record")}</button><button type="button" disabled={blocked} onClick={clear}>{t("结束此批次并选择其他文件","End This Batch and Choose Another File")}</button></div></>}
  {mutation.pending&&<p role="status">{t("原导入结果待确认，已保留批次、目标、版本与请求编号。刷新页面后仍可重试原请求。","The original import result is unconfirmed. Its batch, target, version and request ID are retained. The original request can still be retried after refreshing.")}</p>}
  {view&&<><p>{t(`来源工作区 ${view.document_workspace_id} · 预览 v${view.version} · 可导入 ${view.counts.ready} 条 · 跳过 ${view.counts.skipped} 条 · 冲突 ${view.counts.conflict} 条`,`Source Workspace ${view.document_workspace_id} · Preview v${view.version} · ${view.counts.ready} Ready · ${view.counts.skipped} Skipped · ${view.counts.conflict} Conflicts`)}</p><p style={{overflowWrap:'anywhere'}}>{t("输入 SHA-256 ","Input SHA-256 ")}{view.input_sha256}</p>
   {view.source_file&&<MemoryImportSourceFile key={`${id}:${view.source_file.version}:${view.source_file.sha256}`} source={view.source_file}/>}
   {view.source_bundle&&<MemoryImportBundle key={`${id}:${view.input_sha256}:${view.source_bundle.sha256}`} workspace={workspace} importId={id} inputHash={view.input_sha256} bundle={view.source_bundle}/>}
   {view.replacement&&<MemoryImportReplacement key={`${id}:${view.version}:${view.replacement.scope_sha256}`} workspace={workspace} importId={id} previewVersion={view.version} replacement={view.replacement}/>}
   <div className="wb-message-list">{(view.page?view.items:view.items.slice(page*pageSize,(page+1)*pageSize)).map(item=><article key={item.target_key}>
    <strong>{item.source_memory_id} · v{item.source_version} · {states[item.status]}</strong>{item.reason&&<p>{message(reasons[item.reason]??item.reason)}</p>}
    <p>{item.source_local?t("服务端已有此来源","Source Already Present on Server"):t("外部导出来源","External Export Source")}{t(" · 目标当前版本 "," · Current Target Version ")}{item.target_expected_version}</p>
    <details><summary>{t("核对正文、来源与历史版本","Review Body, Provenance and Versions")}</summary><p style={{whiteSpace:'pre-wrap'}}>{item.source_content}</p><p>{t("历史版本 ","Historical Versions ")}{item.source_history_versions.join('、')}</p>{item.source_revision&&<p>{t("来源版本 ","Source Revision ")}{item.source_revision}</p>}{item.source_expires_at&&<p>{t("有效期 ","Expires: ")}{item.source_expires_at}</p>}{item.source_provenance.map((source,index)=><p key={index}>{source.kind} · {source.reference}</p>)}</details>
   </article>)}</div>
   {(view.page?.total??view.items.length)>pageSize&&<div className="wb-actions"><button type="button" disabled={busy||page===0} onClick={()=>view.page?void loadPage((page-1)*pageSize):setPage(page-1)}>{t("上一页","Previous Page")}</button><span>{t(`第 ${page+1} 页，共 ${Math.ceil((view.page?.total??view.items.length)/pageSize)} 页`,`Page ${page+1} of ${Math.ceil((view.page?.total??view.items.length)/pageSize)}`)}</span><button type="button" disabled={busy||(page+1)*pageSize>=(view.page?.total??view.items.length)} onClick={()=>view.page?void loadPage((page+1)*pageSize):setPage(page+1)}>{t("下一页","Next Page")}</button></div>}
   {view.status==='previewed'&&<label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={blocked||!!view.counts.conflict} onChange={event=>setConfirmed(event.target.checked)}/>{view.mode==='replace_scope'?t("我已核对所选范围、全部来源和受影响记忆清单，确认将当前记忆退役并导入此包。","I reviewed the selected scope, all sources and affected memory inventory, and confirm retiring current memories and importing this bundle."):t("我已核对目标范围、全部来源与冲突，确认按此版本整批导入。","I reviewed the target scope, all sources and conflicts, and confirm importing this entire batch at this version.")}</label>}
  </>}
  {(mutation.pending||view?.status==='previewed')&&<button type="button" disabled={busy||!!recovery.error||!mutation.pending&&(!confirmed||!view||!!view.counts.conflict||!view.counts.total&&!view.source_bundle)} onClick={()=>void apply()}>{busy?t("正在处理…","Processing…"):mutation.pending?t("重试原导入请求","Retry Original Import Request"):view?.mode==='replace_scope'?t("确认替换并导入","Confirm Replacement and Import"):t("确认导入","Confirm Import")}</button>}
  {receipt&&<div role="status"><p>{t('批次已应用，时间 ','Batch Applied at ')}{receipt.applied_at}{t('。创建 ','. Created ')}{receipt.totals?.created??receipt.items.filter(item=>item.status==='created').length}{t(' 条',' Items')}{receipt.replacement&&t(`，原记忆退役 ${receipt.replacement.count} 条`,`, ${receipt.replacement.count} Original Memories Retired`)}{t('，跳过 ',', Skipped ')}{receipt.totals?.skipped??receipt.items.filter(item=>item.status==='skipped').length}{t(' 条。',' Items.')}</p>{receipt.replacement&&<MemoryImportRetirements key={`${receipt.import_id}:${receipt.version}:${receipt.replacement.scope_sha256}`} workspace={workspace} importId={receipt.import_id} version={receipt.version} replacement={receipt.replacement}/>}<details><summary>{t("查看逐条回执","View Item Receipts")}</summary>{receipt.page&&<p>{t(`已加载 ${receipt.items.length} 条，共 ${receipt.page.total} 条，当前位置 ${receipt.page.offset}。`,`${receipt.items.length} of ${receipt.page.total} Items Loaded; Current Offset ${receipt.page.offset}.`)}</p>}{receipt.items.map(item=><p key={item.source_memory_id}>{item.source_memory_id}{t(" · 来源 v"," · Source v")}{item.source_version} · {item.status==='created'?t(`已创建 ${item.memory_id} v${item.version}`,`Created ${item.memory_id} v${item.version}`):t("已跳过","Skipped")}</p>)}{receipt.page&&receipt.page.total>receipt.page.limit&&<div className="wb-actions"><button type="button" disabled={busy||receipt.page.offset===0} onClick={()=>void loadPage(Math.max(0,receipt.page!.offset-receipt.page!.limit))}>{t("上一页导入回执","Previous Import Receipt Page")}</button><button type="button" disabled={busy||receipt.page.next_offset===null} onClick={()=>void loadPage(receipt.page!.next_offset!)}>{t("下一页导入回执","Next Import Receipt Page")}</button></div>}</details></div>}
 </section>;
}
