import React,{useEffect,useMemo,useState,useRef} from 'react';
import {useDurableFileRecovery} from './useDurableFileRecovery';
import type {DurableFileRecoveryStore} from './durable-file-recovery.mjs';
import {CheckpointRestoreDraftStore,readCheckpointRestoreCommand,closeCheckpointRestoreCommand} from './checkpoint-restore-draft.mjs';
import {request,taskDraftScope,ApiError} from '../jot/client';
import {workbenchApi} from './client';
import type {WorkspaceCheckpointRestoreReview,WorkspaceCheckpointRestoreReceipt} from './types';

type RestoreDiff = {kind: 'text' | 'binary' | 'unavailable'; text: string};
type ReviewedFile = Extract<WorkspaceCheckpointRestoreReview['before'], {kind: 'file'}>;

function checkpointTextDiff(before: string, target: string, beforeAbsent: boolean, targetAbsent: boolean): string {
 if (before === target) {
  if (beforeAbsent !== targetAbsent) return beforeAbsent ? '新增空文件。' : '删除空文件。';
  return '字节内容相同。';
 }
 const oldLines = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
 const newLines = target.match(/[^\n]*\n|[^\n]+$/g) ?? [];
 let prefix = 0;
 let suffix = 0;
 while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
 while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
  && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
 const start = Math.max(0, prefix - 3);
 const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
 const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
 const render = (mark: string, lines: string[]) => lines.map(line =>
  mark + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'),
 ).join('');
 return `--- 当前版本\n+++ 检查点版本\n@@ -${oldLines.length ? start + 1 : 0},${oldEnd - start} +${newLines.length ? start + 1 : 0},${newEnd - start} @@\n`
  + render(' ', oldLines.slice(start, prefix))
  + render('-', oldLines.slice(prefix, oldLines.length - suffix))
  + render('+', newLines.slice(prefix, newLines.length - suffix))
  + render(' ', oldLines.slice(oldLines.length - suffix, oldEnd));
}

export async function readCheckpointRestoreDiff(
 review: WorkspaceCheckpointRestoreReview,
 readBytes: (file: ReviewedFile, signal: AbortSignal) => Promise<Uint8Array>,
 signal: AbortSignal,
 readTargetBytes?: (file: ReviewedFile, signal: AbortSignal) => Promise<Uint8Array>,
): Promise<RestoreDiff> {
 signal.throwIfAborted();
 if ([review.before, review.target].some(file => file.kind === 'file' && file.size > 1_048_576)) {
  return {kind: 'unavailable', text: '文件超过 1 MiB 文本差异预览上限，请核对当前与目标的字节摘要、大小和版本。'};
 }
 const read = async (file: WorkspaceCheckpointRestoreReview['before'], reader = readBytes) => {
  if (file.kind === 'absent') return new Uint8Array();
  const bytes = await reader(file, signal);
  signal.throwIfAborted();
  if (bytes.byteLength !== file.size) throw new Error('workspace_file_source_mismatch');
  const content = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', content);
  signal.throwIfAborted();
  const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== file.sha256) throw new Error('workspace_file_source_mismatch');
  return content;
 };
 const beforeRead=read(review.before).then(bytes=>({bytes,unavailable:false})).catch(error=>{
  signal.throwIfAborted();
  if(readTargetBytes&&error instanceof ApiError&&(error.status===404&&error.message==='FILE_NOT_FOUND'||error.status===409&&error.message==='FILE_INTEGRITY_FAILED'))return {bytes:new Uint8Array(),unavailable:true};
  throw error;
 });
 const [beforeResult,targetBytes]=await Promise.all([beforeRead,read(review.target,readTargetBytes??readBytes)]);
 signal.throwIfAborted();
 if(beforeResult.unavailable)return {kind:'unavailable',text:'当前版本字节缺失或校验失败，完整差异无法生成。目标快照已按原审阅摘要核对，请核对路径、版本、摘要和大小后决定恢复。'};
 const beforeBytes=beforeResult.bytes;
 let before: string;
 let target: string;
 try {
  const decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
  before = decoder.decode(beforeBytes);
  target = decoder.decode(targetBytes);
 } catch {
  return {kind: 'binary', text: '二进制内容无法显示文本差异，请核对当前与目标的字节摘要、大小和版本。'};
 }
 if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(before + target)) {
  return {kind: 'binary', text: '二进制内容无法显示文本差异，请核对当前与目标的字节摘要、大小和版本。'};
 }
 return {kind: 'text', text: checkpointTextDiff(before, target, review.before.kind === 'absent', review.target.kind === 'absent')};
}

function reviewStateLabel(state:WorkspaceCheckpointRestoreReview['before']){
 if(state.kind==='absent')return '不存在';
 const mode=state.executable===null?'执行位未知':state.executable?'可执行':'不可执行';
 return `文件（按原始字节保存；文本/二进制不作推断） · v${state.version} · SHA-256 ${state.sha256} · ${state.size} B · ${mode}`;
}

type Props={workspace:string;project:string;review:WorkspaceCheckpointRestoreReview|null;canWrite:boolean;onClose:()=>void;onPending:(value:boolean)=>void;onApplied:(receipt:WorkspaceCheckpointRestoreReceipt)=>void};
export default function CheckpointRestoreRecovery(props:Props){
 const scope=taskDraftScope();
 const createStore=useMemo(()=>(storage:Storage)=>new CheckpointRestoreDraftStore(storage,scope,props.workspace),[scope,props.workspace]);
 const recovery=useDurableFileRecovery(JSON.stringify(['checkpoint-restore',scope,props.workspace]),createStore,!!scope&&!!props.workspace);
 return <RestoreRecovery key={recovery.key} {...props} scope={scope} store={recovery.store} recoveryLoading={recovery.loading} recoveryError={recovery.error} onReloadRecovery={recovery.reload}/>;
}
function RestoreRecovery({workspace,project,review,canWrite,onClose,onPending,onApplied,scope,store,recoveryLoading,recoveryError,onReloadRecovery}:Props&{scope:string;store:DurableFileRecoveryStore|null;recoveryLoading:boolean;recoveryError:string;onReloadRecovery:()=>void}){
 const [command,setCommand]=useState<any>(()=>store?.read()?.command??null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const [dismissed,setDismissed]=useState(false);
 const [pendingOperation,setPendingOperation]=useState<{commandKey:string;operationId:string}|null>(null);
 const [difference,setDifference]=useState<{review_id:string;value?:RestoreDiff;error?:string}|null>(null);
 const diffReady=!!review&&difference?.review_id===review.review_id&&!!difference.value;
 const dialogRef=useRef<HTMLElement|null>(null),cancelRef=useRef<HTMLButtonElement|null>(null),confirmRef=useRef<HTMLButtonElement|null>(null),receiptRef=useRef<HTMLButtonElement|null>(null),resumeRef=useRef<HTMLButtonElement|null>(null);
 const openerRef=useRef<HTMLElement|null>(null),fallbackRef=useRef<HTMLElement|null>(null),dialogWasOpen=useRef(false),closeReason=useRef<'cancel'|'confirm'|null>(null),dismissedBefore=useRef(false),returnAfterFinish=useRef(false);
 useEffect(()=>{onPending(!!command||busy||!!store?.issue||recoveryLoading);},[command,busy,store,store?.issue,recoveryLoading,onPending]);
 const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=()=>alive.current&&taskDraftScope()===scope&&!!scope;
 useEffect(()=>{
  setDifference(null);if(!review)return;
  const controller=new AbortController();
  if(review.workspace_id!==workspace||review.project_id!==project){setDifference({review_id:review.review_id,error:'恢复预览范围不匹配，请重新检查恢复内容。'});return;}
  void readCheckpointRestoreDiff(review,(file,signal)=>workbenchApi.readWorkspaceFileBinary(workspace,project,file.path,file.version,file.sha256,signal),controller.signal,
   (file,signal)=>workbenchApi.readCheckpointRestoreTarget(workspace,project,review.checkpoint_id,review.review_id,file.path,file.version,file.sha256,review.review_sha256,signal))
   .then(value=>{if(!controller.signal.aborted&&current())setDifference({review_id:review.review_id,value});})
   .catch(error=>{if(!controller.signal.aborted&&current())setDifference({review_id:review.review_id,error:error instanceof Error?error.message:'恢复差异读取失败，请重新检查恢复内容。'});});
  return()=>controller.abort();
 },[review,workspace,project,scope]);
 const focusReturn=()=>{const target=openerRef.current?.isConnected?openerRef.current:null,fallback=fallbackRef.current;if(target)target.focus();else if(fallback?.isConnected){fallback.tabIndex=-1;fallback.focus();}};
 const finish=async(result:any,original:any)=>{
  if(!current()||!store)return;
  await store.acknowledge(original);
  if(!current())return;
  returnAfterFinish.current=true;store.complete(original);setCommand(null);setPendingOperation(null);
  if(result.state==='settled'&&result.receipt.outcome==='applied'&&original.body.project_id===project)onApplied(result.receipt);
  onClose();
  let message='已读取原恢复回执。';
  if(result.state==='terminal_rejected'){
   message='原恢复已确认未执行，请重新检查恢复内容。';
   if(result.reason==='workspace_checkpoint_request_closed')message='原恢复请求已结束，可以重新审阅路径。';
  }
  setMessage(message);
 };

 const showStatus=async(result:any,original:any)=>{
  if(!current())return;
  setPendingOperation(null);
  if(result.state==='terminal_rejected'||result.state==='settled')await finish(result,original);
  else {
   if(result.state==='recorded_pending')setPendingOperation({commandKey:original.key,operationId:result.operation_id});
   setMessage(result.state==='unobserved'?'尚未观察到原请求终态；保留原命令。':'原恢复仍未结算；保留原命令。');
  }
 };
 const inspect=async(original:any)=>{await showStatus(await readCheckpointRestoreCommand(original,workspace,request),original);};
 const closeOriginal=async()=>{
  if(!command||busy||!canWrite||!current()||!store||store.issue)return;
  const original=command;setBusy(true);
  try{
   store.requestClose();await store.persist(original);
   if(!current())return;
   await showStatus(await closeCheckpointRestoreCommand(original,workspace,request,current),original);
  }catch(error){if(current())setMessage(error instanceof Error?error.message:'结束原恢复请求的回执待确认，请重试原请求。');}
  finally{if(current())setBusy(false);}
 };
 const reconcile=async()=>{
  if(!command||!pendingOperation||pendingOperation.commandKey!==command.key||busy||!canWrite||!current()||!store||store.issue)return;
  const original=command;
  const operationId=pendingOperation.operationId;
  setBusy(true);
  try {
   await store.persist(original);
   if(!current())return;
   try {
    await request(`/workspaces/${encodeURIComponent(workspace)}/checkpoint-restores/${encodeURIComponent(operationId)}/reconcile`,
     'POST',{project_id:original.body.project_id},operationId);
   } catch { /* A lost response is resolved only by the original command receipt. */ }
   await inspect(original);
  } catch(error) {
   if(current())setMessage(error instanceof Error?error.message:'原恢复调和结果待确认，请继续读取原回执。');
  } finally {if(current())setBusy(false);}
 };
 const check=async()=>{if(!command||busy||!current())return;setBusy(true);try{await inspect(command);}catch(e){if(current())setMessage(e instanceof Error?e.message:'原回执读取失败');}finally{if(current())setBusy(false);}};
 const submit=async()=>{
  if(!review||!diffReady||command||busy||!canWrite||!current()||!store||store.issue)return;
  setBusy(true);
  try{
   const original=store.read()?.command??{path:`/workspaces/${encodeURIComponent(workspace)}/checkpoints/${encodeURIComponent(review.checkpoint_id)}/restore`,method:'POST',key:crypto.randomUUID(),body:{project_id:project,path:review.path,review_id:review.review_id,review_sha256:review.review_sha256}};
   if(original.body.project_id!==project||original.body.path!==review.path||original.body.review_id!==review.review_id||original.body.review_sha256!==review.review_sha256)throw Error('原恢复确认请求尚未保存，请重读原请求。');
   store.saveCommand(original);
   await store.persist(original);
   if(!current())return;
   closeReason.current='confirm';setCommand(original);
   try{await request(original.path,'POST',original.body,original.key);}catch{}
   await inspect(original);
  }catch(e){if(current())setMessage(e instanceof Error?e.message:'恢复结果未知，请读取原回执。');}
  finally{if(current())setBusy(false);}
 };

 const closeReview=()=>{if(busy||command)return;closeReason.current='cancel';onClose();};
 const dismissPending=()=>{if(!command)return;setDismissed(true);onClose();};
 const dialogOpen=!!review&&!command&&!dismissed&&!!store;
 useEffect(()=>{
  if(dialogOpen&&!dialogWasOpen.current){openerRef.current=document.activeElement instanceof HTMLElement?document.activeElement:null;fallbackRef.current=dialogRef.current?.parentElement?.querySelector<HTMLElement>(':scope > h3')??null;cancelRef.current?.focus();}
  else if(!dialogOpen&&dialogWasOpen.current){if(closeReason.current!=='confirm')focusReturn();closeReason.current=null;}
  dialogWasOpen.current=dialogOpen;
 },[dialogOpen,command]);
 useEffect(()=>{if(dismissed&&command)resumeRef.current?.focus();else if(!dismissed&&command&&dismissedBefore.current)(busy?dialogRef.current:receiptRef.current)?.focus();dismissedBefore.current=dismissed;},[dismissed,command,busy]);
 useEffect(()=>{if(command&&busy&&!dismissed)dialogRef.current?.focus();},[command,busy,dismissed]);
 useEffect(()=>{if(returnAfterFinish.current&&!command&&!review){returnAfterFinish.current=false;focusReturn();}},[command,review]);
 useEffect(()=>{if(review&&!command){setDismissed(false);setMessage('');}},[review?.review_id]);
 if(dismissed&&command)return <section className="wb-form" role="status" aria-label="检查点恢复待回执"><p>恢复仍未结算。原请求和回执线索已保留，不会重新发送。</p><button ref={resumeRef} onClick={()=>setDismissed(false)}>继续查看原恢复回执</button></section>;
 return <section ref={dialogRef} id={command?'restore-pending':undefined} tabIndex={command&&!dialogOpen?-1:undefined} role={dialogOpen?'alertdialog':command?'region':undefined} aria-modal={dialogOpen?'true':undefined} aria-labelledby={dialogOpen?'checkpoint-restore-title':undefined} aria-describedby={dialogOpen?'checkpoint-restore-description':undefined} aria-label={dialogOpen?undefined:'检查点恢复与回执'} className="wb-form"
  onKeyDown={event=>{
   if(event.key==='Escape'){
    event.preventDefault();if(command)dismissPending();else if(dialogOpen)closeReview();return;
   }
   if(!dialogOpen||event.key!=='Tab')return;
   const controls=[cancelRef.current,confirmRef.current].filter((button):button is HTMLButtonElement=>!!button&&!button.disabled),first=controls[0],last=controls.at(-1),active=document.activeElement;
   if(!first){event.preventDefault();return;}
   if(event.shiftKey&&(active===first||!dialogRef.current?.contains(active))){event.preventDefault();last!.focus();}
   else if(!event.shiftKey&&(active===last||!dialogRef.current?.contains(active))){event.preventDefault();first.focus();}
  }}>
  <h3 id="checkpoint-restore-title">检查点恢复</h3>
  {recoveryLoading&&<p role="status">正在读取物理恢复持久回执…</p>}
  {recoveryError&&<p role="alert">{recoveryError}</p>}
  {!dialogOpen&&<button type="button" disabled={busy||recoveryLoading} onClick={onReloadRecovery}>重读待确认物理恢复请求</button>}
  {store?.issue&&<p role="alert">{store.issue}；原恢复记录保留。</p>}
  {message&&<p role="status">{message}</p>}
  {command?<><p>原恢复命令待确认：{command.body.project_id} / {command.body.path}</p><button ref={receiptRef} disabled={busy||!current()} onClick={()=>void check()}>读取原恢复回执</button>{pendingOperation?.commandKey===command.key&&<button disabled={busy||!canWrite||!current()||!store||!!store.issue} onClick={()=>void reconcile()}>核对并结算原恢复</button>}<button disabled={busy||!canWrite||!current()||!store||!!store.issue} onClick={()=>void closeOriginal()}>{store?.closing?'重试确认结束原恢复':'结束尚未登记的原恢复'}</button><p>已登记的恢复可继续读取或结算原回执。</p><button disabled={!current()} onClick={dismissPending}>稍后检查</button></>:review&&<>
   <p id="checkpoint-restore-description">当前状态：{reviewStateLabel(review.before)}。检查点目标：{reviewStateLabel(review.target)}。确认仅恢复 {review.path}。</p>
   <p>恢复范围为所选共同文件路径。外部操作保留各自的回执与处理流程。</p>
   <section aria-label="恢复差异预览">
    {!difference||difference.review_id!==review.review_id?<p role="status">正在读取并校验恢复差异…</p>:difference.error?<p role="alert">{difference.error}</p>:difference.value?.kind==='text'?<pre aria-label="恢复文本差异">{difference.value.text}</pre>:<p>{difference.value?.text}</p>}
   </section>
   <button ref={cancelRef} id="restore-cancel" disabled={busy} onClick={closeReview}>取消</button>
   <button ref={confirmRef} id="restore-confirm" disabled={busy||!canWrite||!diffReady||!current()||!store||!!store.issue} onClick={()=>void submit()}>确认恢复此路径</button>
  </>}
 </section>;
}
