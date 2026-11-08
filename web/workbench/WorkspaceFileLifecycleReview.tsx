import React,{useEffect,useState} from 'react';
import {workbenchApi} from './client';
import type {WorkspaceFile,WorkbenchFileLifecycleHistoryItem,WorkbenchFileLifecycleHistoryPage,WorkbenchFileLifecyclePreview,WorkbenchFileLifecycleReceipt} from './types';
import {clearPendingFileLifecycleCommand,persistPendingFileLifecycleCommand,reconcileFileLifecycleCommand,submitFileLifecycleCommand} from './file-lifecycle-flow.mjs';

type Action='rename'|'delete';
export type FileLifecycleCommand={action:Action;workspace_id:string;project_id:string;path:string;source_sha256:string;target_path?:string;target_version?:number;expected_version:number;preview_sha256:string;command_key:string;body:Record<string,unknown>};
type Command=FileLifecycleCommand;
type FileRef=Pick<WorkspaceFile,'path'|'version'|'sha256'>;

export function WorkspaceFileLifecycleHistoryListing({page,onMore,onRefresh,onPreviewSource}:{page:WorkbenchFileLifecycleHistoryPage&{loading:boolean;error:string};onMore:()=>void;onRefresh:()=>void;onPreviewSource:(item:WorkbenchFileLifecycleHistoryItem)=>void}){
 return <section className="wb-file-lifecycle-history" aria-label="文件操作历史">
  <div className="wb-file-lifecycle-heading"><div><h3>文件操作历史</h3><p className="wb-hint">改名与删除记录来自不可变操作回执；文件内容版本请在打开文件后查看。</p></div><button type="button" disabled={page.loading} onClick={onRefresh}>刷新历史</button></div>
  {page.error&&<p className="wb-error" role="alert">{page.error}</p>}
  {page.loading&&!page.items.length&&<p className="wb-status" role="status">正在读取操作历史…</p>}
  {!page.loading&&!page.error&&!page.items.length&&<p className="wb-status">暂无改名或删除记录。</p>}
  {!!page.items.length&&<ol>{page.items.map(item=><li key={item.command_key}>
   <div className="wb-file-lifecycle-entry">
    <strong>{item.action==='rename'?'重命名':'删除'} · {item.source.path}{item.action==='rename'&&<> → {item.target.path}</>}</strong>
    <small>来源：{item.source.path} · v{item.source.version}{item.action==='rename'&&<>；目标：{item.target.path} · v{item.target.version}</>}</small>
    <small>操作时间：{new Date(item.applied_at).toLocaleString()}</small>
    <button type="button" onClick={()=>onPreviewSource(item)}>预览历史版本</button>
    <details><summary>不可变回执</summary><dl><div><dt>命令 ID</dt><dd><code>{item.command_key}</code></dd></div><div><dt>预览 SHA-256</dt><dd><code>{item.preview_sha256}</code></dd></div></dl><pre>{JSON.stringify(item,null,2)}</pre></details>
   </div>
  </li>)}</ol>}
  {page.next_cursor&&<button type="button" disabled={page.loading} onClick={onMore}>{page.loading?'正在加载…':'加载更多历史'}</button>}
 </section>;
}

export function WorkspaceFileLifecycleReview({workspace,project,file,action,canWrite,onClose,onApplied,ownerScope,lifecycleStorage,resumeCommand}:{workspace:string;project:string;file:FileRef;action:Action;canWrite:boolean;onClose:()=>void;onApplied:()=>void;ownerScope:string;lifecycleStorage:Storage|null;resumeCommand?:Command|null}){
 const scope={owner_scope:ownerScope,workspace_id:workspace,project_id:project};
 const [targetPath,setTargetPath]=useState(resumeCommand?.target_path??file.path),[preview,setPreview]=useState<WorkbenchFileLifecyclePreview|null>(null),[command,setCommand]=useState<Command|null>(resumeCommand??null),
  [stage,setStage]=useState<'edit'|'preview'|'applying'|'applied'|'not_applied'|'unknown'>(resumeCommand?'unknown':'edit'),[busy,setBusy]=useState(false),[error,setError]=useState(''),
  [receipt,setReceipt]=useState<WorkbenchFileLifecycleReceipt|null>(null);
 const closed=busy||stage==='unknown';
 const makePreview=async()=>{
  if(!canWrite||busy)return;setBusy(true);setError('');setPreview(null);setCommand(null);setReceipt(null);
  try{
   const input=action==='rename'?{project_id:project,path:file.path,target_path:targetPath.trim(),expected_version:file.version}:{project_id:project,path:file.path,expected_version:file.version};
   const result=await workbenchApi.fileLifecyclePreview(workspace,action,input);
   if(result.action!==action||result.source.path!==file.path||result.source.version!==file.version||result.source.sha256!==file.sha256)throw new Error('预览与当前文件版本或摘要不匹配，请刷新文件列表。');
   const command_key=globalThis.crypto?.randomUUID?.()??`file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
   const frozenBody=action==='rename'?{project_id:project,path:result.source.path,target_path:(result as Extract<WorkbenchFileLifecyclePreview,{action:'rename'}>).target.path,expected_version:result.source.version,preview_sha256:result.preview_sha256}
    :{project_id:project,path:result.source.path,expected_version:result.source.version,preview_sha256:result.preview_sha256};
   setCommand({action,workspace_id:workspace,project_id:project,path:result.source.path,source_sha256:result.source.sha256,
    ...(action==='rename'?{target_path:(result as Extract<WorkbenchFileLifecyclePreview,{action:'rename'}>).target.path,target_version:(result as Extract<WorkbenchFileLifecyclePreview,{action:'rename'}>).target.version}:{}),
    expected_version:result.source.version,preview_sha256:result.preview_sha256,command_key,body:frozenBody});
   setPreview(result);setStage('preview');
  }catch(cause){setError(cause instanceof Error?cause.message:'未能生成文件操作预览');}
  finally{setBusy(false);}
 };
 const applyCommand=async(current:Command)=>workbenchApi.applyFileLifecycle(current.workspace_id,current.action,current.body as any,current.command_key);
 const readStatus=async(current:Command)=>workbenchApi.fileLifecycleStatus(current.workspace_id,current.project_id,current.command_key);
 const finish=(result:WorkbenchFileLifecycleReceipt,current=command)=>{if(current)clearPendingFileLifecycleCommand(lifecycleStorage,scope,current.command_key);setReceipt(result);setStage('applied');setError('');onApplied();};
 const submit=async(candidate?:Command|null)=>{
  const current=candidate??command;
  if(!current||busy||!canWrite)return;
  if(!persistPendingFileLifecycleCommand(lifecycleStorage,scope,current)){setError('无法安全保存待确认命令；未发送文件操作。请检查当前标签页会话存储后重试。');return;}
  setCommand(current);setBusy(true);setStage('applying');setError('');
  try{
   const result=await submitFileLifecycleCommand(current,{apply:applyCommand,status:readStatus});
   if(result.state==='applied')finish(result.receipt as WorkbenchFileLifecycleReceipt,current);
   else if(result.state==='not_applied'){setStage('not_applied');setError('状态查询确认该命令尚未应用。可显式重试同一命令，或关闭后重新预览。');}
   else {setStage('unknown');setError('暂时无法确认操作结果。请重新查询状态；查询期间不会重放文件变更。');}
  }catch(cause){setStage('unknown');setError(cause instanceof Error?cause.message:'无法确认文件操作结果');}
  finally{setBusy(false);}
 };
 const reconcile=async(candidate?:Command)=>{
  const current=candidate??command;
  if(!current||busy)return;setCommand(current);setBusy(true);setError('');
  try{
   const result=await reconcileFileLifecycleCommand(current,readStatus);
   if(result.state==='applied')finish(result.receipt as WorkbenchFileLifecycleReceipt,current);
   else if(result.state==='not_applied'){setStage('not_applied');setError('状态查询确认该命令尚未应用。可显式重试同一命令，或关闭后重新预览。');}
   else setError('仍无法确认操作结果。稍后可再次查询状态。');
  }catch(cause){setError(cause instanceof Error?cause.message:'无法查询操作状态');}
  finally{setBusy(false);}
 };
 useEffect(()=>{if(resumeCommand)void reconcile(resumeCommand);},[resumeCommand]);
 const close=()=>{if(command)clearPendingFileLifecycleCommand(lifecycleStorage,scope,command.command_key);onClose();};
 const label=action==='rename'?'重命名':'删除';
 return <div className="wb-file-lifecycle-overlay"><section className="wb-file-lifecycle-review" role="dialog" aria-modal="true" aria-label={`${label}共同文件`}>
  <div className="wb-file-lifecycle-heading"><h3>{label}共同文件</h3><button type="button" disabled={closed} aria-label="关闭文件操作" onClick={close}>关闭</button></div>
  <p>当前文件：<code>{file.path}</code> · v{file.version}</p>
  {action==='rename'&&<label>新路径<input disabled={busy||stage!=='edit'} value={targetPath} onChange={event=>setTargetPath(event.target.value)} maxLength={1000}/></label>}
  {(stage==='edit'||stage==='unknown')&&stage==='edit'&&<button type="button" className="wb-primary" disabled={!canWrite||busy||(action==='rename'&&!targetPath.trim())} onClick={()=>void makePreview()}>{busy?'正在预览…':`预览${label}`}</button>}
  {preview&&stage==='preview'&&<div className="wb-file-lifecycle-preview" aria-label="操作影响预览"><h4>操作影响预览</h4><p>源文件：<code>{preview.source.path}</code> · v{preview.source.version}</p>{preview.action==='rename'&&<p>目标路径：<code>{preview.target.path}</code> · v{preview.target.version}</p>}<p>来源引用 {preview.source_refs.length} 项{preview.action==='rename'&&<>；目标引用 {preview.target_refs.length} 项</>}</p><details><summary>查看引用</summary><pre>{JSON.stringify({source_refs:preview.source_refs,...(preview.action==='rename'?{target_refs:preview.target_refs}:{})},null,2)}</pre></details>
   <div className="wb-actions"><button type="button" disabled={busy||!canWrite||!command} onClick={()=>void submit(command)}>确认{label}</button><button type="button" disabled={busy} onClick={()=>{setPreview(null);setCommand(null);setStage('edit');}}>返回修改</button></div>
  </div>}
  {stage==='applying'&&<p role="status">正在提交并确认操作结果…</p>}
  {error&&<p className="wb-error" role="alert">{error}</p>}
  {stage==='not_applied'&&<div className="wb-actions"><button type="button" disabled={busy||!canWrite} onClick={()=>void submit(command)}>按同一命令重试</button></div>}
  {stage==='unknown'&&command&&<button type="button" disabled={busy} onClick={()=>void reconcile()}>{busy?'正在查询…':'重新查询操作状态'}</button>}
  {stage==='applied'&&receipt&&<div className="wb-file-lifecycle-result" role="status"><h4>操作已完成{stage==='applied'&&command&&'，回执已确认'}</h4><p>命令 ID：<code>{receipt.command_key}</code></p><p>来源路径：<code>{receipt.source.path}</code>{receipt.action==='rename'&&<> → <code>{receipt.target.path}</code></>}</p><p>完成时间：{new Date(receipt.applied_at).toLocaleString()}</p><details><summary>查看完整回执</summary><pre>{JSON.stringify(receipt,null,2)}</pre></details><button type="button" onClick={close}>完成</button></div>}
 </section></div>;
}

export type {WorkbenchFileLifecycleHistoryItem};
