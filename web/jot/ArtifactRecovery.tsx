import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {request,taskDraftScope} from './client';
import {artifactCommandDisposition} from './artifact-command-recovery.mjs';
import {useResource} from '../workbench/useResource';
import {useMutationReceipt} from '../workbench/useMutationReceipt';
import {useDurableFileRecovery} from '../workbench/useDurableFileRecovery';
import type {DurableFileRecoveryStore} from '../workbench/durable-file-recovery.mjs';
import {ArtifactRecoveryStore} from '../workbench/task-save-receipt.mjs';
import type {ArtifactBackup,ArtifactArchiveReceipt,ArtifactRestoreReceipt} from './types';

type Props={artifactId:string;version?:number|undefined;sha256?:string|undefined;partIndex?:number|undefined;onRestored:()=>void};
export default function ArtifactRecovery(props:Props){
 const owner=taskDraftScope();
 const createStore=useMemo(()=>(storage:Storage)=>new ArtifactRecoveryStore(storage,owner,props.artifactId),[owner,props.artifactId]);
 const recovery=useDurableFileRecovery(JSON.stringify(['artifact',owner,props.artifactId]),createStore,!!owner&&!!props.artifactId);
 return <Recovery key={recovery.key} {...props} owner={owner} store={recovery.store} recoveryLoading={recovery.loading} recoveryError={recovery.error} onReloadRecovery={recovery.reload}/>;
}

function Recovery({artifactId,version,sha256,partIndex,onRestored,owner,store,recoveryLoading,recoveryError,onReloadRecovery}:Props&{owner:string;store:DurableFileRecoveryStore|null;recoveryLoading:boolean;recoveryError:string;onReloadRecovery:()=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const identity=JSON.stringify([owner,artifactId,version??null,sha256??null,partIndex??null]);
 const alive=useRef(true),previousState=useRef(''),pollAttempt=useRef(0);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const requestMode=useRef<'retry'|'inspect'|'close'>('retry');
 const [archiveAfterAttempt,setArchiveAfterAttempt]=useState<number|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{previousState.current='';pollAttempt.current=0;setError('');setNotice('');},[identity]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const receipt=useMutationReceipt(store,undefined,async(path,method,body,key)=>{
  if(!current()||!store)throw Error('文件恢复账户或回执范围尚未确认');
  const frozen={path,method,body,key};
  const mode=requestMode.current,closing=mode!=='inspect'&&store.closing;
  if(mode!=='inspect')await store.persist(frozen);
  if(!current())throw Error('文件恢复账户范围已变化');
  const command=body as {expected_version:number;expected_sha256?:string;restore_version?:number;restore_sha256?:string;part_index?:number};
  const selected=command.restore_version!==undefined,archiving=path===`/artifacts/${encodeURIComponent(artifactId)}/archive`;
  let result:ArtifactRestoreReceipt|ArtifactArchiveReceipt;
  try{
   if(mode==='inspect'||closing){
    const disposition=await artifactCommandDisposition(store,frozen,artifactId,request,current,closing);
    if(disposition.state==='terminal_rejected'){
     await store.acknowledge(frozen);
     if(!current())throw Error('文件恢复账户范围已变化');
     return {command_closed:true};
    }
    if(disposition.state==='unobserved')throw Error('尚未观察到原请求，请保留原请求或明确结束。');
    if(disposition.state==='recorded_pending')throw Error('原请求已有登记，尚无最终回执。可重试原请求，或结束未提交的请求。');
    if(disposition.state==='unresolved')throw Error('旧请求缺少可核对的原子回执，原记录已保留。');
    result=disposition.result;
   }else result=await request<ArtifactRestoreReceipt|ArtifactArchiveReceipt>(path,method,body,key);
  }
  catch(reason){
   const failure=reason as {status?:number;message?:string};
   if(archiving&&(failure.status===404||[400,422].includes(failure.status??0)
    &&['CONTRACT_REQUEST_INVALID','INVALID_ARTIFACT_ARCHIVE_REQUEST'].includes(failure.message??'')))throw Error('归档请求尚未确认，请保留回执并在归档入口可用后重试。');
   if(selected&&[400,422].includes(failure.status??0)
    &&['CONTRACT_REQUEST_INVALID','INVALID_ARTIFACT_RESTORE','INVALID_ARTIFACT_RESTORE_QUERY'].includes(failure.message??''))throw Error('服务器尚未支持原恢复请求，请保留回执并在恢复入口可用后重试。');
   if(!current())throw Error('文件恢复账户范围已变化');
   // A rejected retry can follow a previously committed original request.
   throw new Error(reason instanceof Error?reason.message:'文件归档或恢复结果待确认',{cause:reason});
  }
  if(archiving){
   const archived=result as ArtifactArchiveReceipt;
   if(!current()||!archived||archived.accepted!==true||archived.artifact_id!==artifactId||archived.archive_protocol!==1
    ||archived.version!==command.expected_version||archived.sha256!==command.expected_sha256||archived.status!=='queued'
    ||!Number.isSafeInteger(archived.after_attempt)||archived.after_attempt<0)throw Error('文件归档回执尚未确认，请重试原请求。');
   await store.acknowledge(frozen);
   if(!current())throw Error('文件恢复账户范围已变化');
   return archived;
  }
  const restored=result as ArtifactRestoreReceipt;
  if(!current()||!restored||restored.accepted!==true||restored.artifact_id!==artifactId||restored.restore_protocol!==(selected?3:2)
   ||restored.version!==command.expected_version||!['ready','restoring'].includes(restored.status)
   ||selected&&(restored.requested_version!==command.restore_version||restored.requested_sha256!==command.restore_sha256||restored.part_index!==command.part_index))throw Error('文件恢复回执尚未确认，请重试原请求。');
  await store.acknowledge(frozen);
  if(!current())throw Error('文件恢复账户范围已变化');
  return restored;
 });
 const resource=useResource(async signal=>{
  const query=new URLSearchParams({restore_protocol:'3'});
  if(version!==undefined){if(!Number.isSafeInteger(version)||version<1)throw Error('文件恢复版本尚未确认');query.set('version',String(version));}
  if(sha256!==undefined){if(!/^[a-f0-9]{64}$/.test(sha256))throw Error('文件恢复SHA尚未确认');query.set('sha256',sha256);}
  if(partIndex!==undefined){if(!Number.isSafeInteger(partIndex)||partIndex<1||partIndex>50||version!==1)throw Error('分卷恢复范围尚未确认');query.set('part_index',String(partIndex));}
  const backup=await request<ArtifactBackup>(`/artifacts/${encodeURIComponent(artifactId)}/backup-status?${query}`,'GET',undefined,undefined,signal);
  if(!current()||!backup||backup.artifact_id!==artifactId||!['pending','retry','verified','failed'].includes(backup.backup_status)
   ||!['present','deleted','restoring'].includes(backup.local_state)||typeof backup.restorable!=='boolean'
   ||backup.all_versions_archived!==undefined&&typeof backup.all_versions_archived!=='boolean'
   ||backup.restore_protocol!==undefined&&![2,3].includes(backup.restore_protocol)
   ||backup.version!==undefined&&(!Number.isSafeInteger(backup.version)||backup.version<1))throw Error('文件归档状态来源尚未确认');
  if(backup.archive_protocol!==undefined&&(backup.archive_protocol!==1||typeof backup.head_sha256!=='string'||!/^[a-f0-9]{64}$/.test(backup.head_sha256)
   ||typeof backup.archive_ready!=='boolean'||!Number.isSafeInteger(backup.archive_attempts)||Number(backup.archive_attempts)<0))throw Error('文件归档请求来源尚未确认');
  if(backup.executor!==undefined){
   const executor=backup.executor;
   if(!executor||!['managed','external'].includes(executor.mode)
    ||!['unmanaged','starting','idle','restoring','archiving','cleaning','failed','stopped'].includes(executor.state)
    ||executor.restart_required!==undefined&&typeof executor.restart_required!=='boolean'
    ||executor.mode==='external'&&executor.state!=='unmanaged'||executor.mode==='managed'&&(executor.state==='unmanaged'||typeof executor.cleanup_enabled!=='boolean'))throw Error('归档执行器状态尚未确认');
   for(const time of [executor.last_started_at,executor.last_completed_at]){
    if(time!==undefined&&(typeof time!=='string'||time.length>40||!Number.isFinite(Date.parse(time))))throw Error('归档执行器时间尚未确认');
   }
  }
  if(backup.restore_protocol===3){
   if(!Number.isSafeInteger(backup.version)||Number(backup.version)<1||!Number.isSafeInteger(backup.requested_version)||Number(backup.requested_version)<1||Number(backup.requested_version)>Number(backup.version)
    ||version!==undefined&&backup.requested_version!==version||typeof backup.requested_sha256!=='string'||!/^[a-f0-9]{64}$/.test(backup.requested_sha256)
    ||sha256!==undefined&&backup.requested_sha256!==sha256||backup.part_index!==partIndex
    ||!['present','deleted','restoring'].includes(backup.archive_local_state??'')
    ||!Number.isSafeInteger(backup.selected_file_count)||Number(backup.selected_file_count)<1||Number(backup.selected_file_count)>50
    ||!Number.isSafeInteger(backup.missing_file_count)||Number(backup.missing_file_count)<0||Number(backup.missing_file_count)>Number(backup.selected_file_count)
    ||!Number.isSafeInteger(backup.unarchived_file_count)||Number(backup.unarchived_file_count)<0||Number(backup.unarchived_file_count)>Number(backup.selected_file_count))throw Error('所选文件的恢复来源尚未确认');
  }
  return {identity,backup};
 },identity,!!owner);
 const backup=resource.data?.identity===identity&&taskDraftScope()===owner?resource.data.backup:undefined;
 useEffect(()=>{
  if(!backup||resource.loading||resource.error)return;
  if(previousState.current==='restoring'&&backup.local_state==='present')onRestored();
  previousState.current=backup.local_state;
  if(archiveAfterAttempt!==null&&Number(backup.archive_attempts)>archiveAfterAttempt
   &&(backup.backup_status==='verified'&&backup.all_versions_archived===true||backup.backup_status==='retry'||backup.backup_status==='failed'||!!backup.last_error)){
   setArchiveAfterAttempt(null);return;
  }
  if(backup.local_state!=='restoring'&&archiveAfterAttempt===null)return;
  const delay=Math.min(30000,2000*2**Math.min(pollAttempt.current,4));pollAttempt.current+=1;
  const timer=setTimeout(resource.reload,delay);return()=>clearTimeout(timer);
 },[backup,resource.loading,resource.error,resource.reload,onRestored,archiveAfterAttempt]);
 const legacyCurrent=backup?.restore_protocol===2&&partIndex===undefined&&(version===undefined||version===backup.version);
 const canRestore=!!store&&backup?.version!==undefined&&backup.restorable
  &&(backup.restore_protocol===3&&backup.local_state!=='restoring'||legacyCurrent&&backup.backup_status==='verified'&&backup.local_state==='deleted');
 const canArchive=!!store&&backup?.archive_protocol===1&&backup.archive_ready&&backup.version!==undefined;
 const submit=async(path:string,body:unknown,mode:'retry'|'inspect'|'close'='retry')=>{
  if(busy||!store||!current())return;
  setBusy(true);setError('');setNotice('');
  try{
   if(mode!=='retry'&&!store.read()?.command)return;
   requestMode.current=mode;
   if(mode==='close')store.requestClose();
   const result=await receipt.submit(path,'POST',body) as ArtifactRestoreReceipt|ArtifactArchiveReceipt|{command_closed:true};
   if(current()){
    if('command_closed' in result)setNotice('原文件请求已确认未提交并结束，可以重新选择操作。');
    else if('archive_protocol' in result)setArchiveAfterAttempt(result.after_attempt);
    else{
     if(result.status==='restoring')previousState.current='restoring';
     if(result.status==='ready')onRestored();
    }
    pollAttempt.current=0;resource.reload();
   }
  }catch(reason){if(current()){setError(reason instanceof Error?reason.message:'文件归档或恢复尚未确认');resource.reload();}}
  finally{if(current())setBusy(false);}
 };
 const restore=async()=>{
  if(!receipt.pending&&!canRestore)return;
  const body=backup?.restore_protocol===3?{expected_version:backup.version,restore_version:backup.requested_version,restore_sha256:backup.requested_sha256,
   ...(backup.part_index!==undefined?{part_index:backup.part_index}:{})}:{expected_version:backup?.version};
  await submit(`/artifacts/${encodeURIComponent(artifactId)}/restore`,body);
 };
 const archive=async()=>{
  if(receipt.pending||!canArchive)return;
  await submit(`/artifacts/${encodeURIComponent(artifactId)}/archive`,{expected_version:backup?.version,expected_sha256:backup?.head_sha256});
 };
 const refresh=()=>{pollAttempt.current=0;resource.reload();};
 const statuses={pending:t("待归档","Awaiting Archive"),retry:t("归档重试中","Archive Retry Pending"),verified:t("归档已验证","Archive Verified"),failed:t("归档失败","Archive Failed")};
 const phases={unmanaged:t("外部进程","External Process"),starting:t("正在启动","Starting"),idle:t("空闲","Idle"),restoring:t("正在恢复","Restoring"),archiving:t("正在归档","Archiving"),cleaning:t("正在清理已验证备份的本地缓存","Cleaning Local Cache with Verified Backups"),failed:t("处理失败","Processing Failed"),stopped:t("已停止","Stopped")};
 const local={present:t("所选文件在本地","Selected Files Are Local"),deleted:t("所选文件缺失","Selected Files Are Missing"),restoring:t("恢复请求已登记","Restore Request Recorded")};
 return <section lang={language} aria-label={t('文件归档与恢复','File Archive and Recovery')} data-chat-search-ignore>
  {recoveryLoading&&<p role="status">{t("正在读取文件操作持久回执…","Reading durable file-operation receipts…")}</p>}
  {recoveryError&&<p role="alert">{conversationUiError(recoveryError,language)}</p>}
  <button type="button" disabled={busy||recoveryLoading} onClick={onReloadRecovery}>{t("重读待确认归档或恢复请求","Read Pending Archive or Restore Requests Again")}</button>
  {notice&&<p role="status">{conversationUiError(notice,language)}</p>}
  {backup&&<p>{statuses[backup.backup_status]} · {local[backup.local_state]}</p>}
  {backup?.executor?.mode==='managed'&&<p role="status">{t('托管归档进程','Managed Archive Process')} · {phases[backup.executor.state]}{backup.executor.last_completed_at?t(` · 上次处理 ${backup.executor.last_completed_at}`,` · Last Processed ${backup.executor.last_completed_at}`):''}</p>}
  {backup?.executor?.mode==='managed'&&backup.executor.state==='failed'&&<p role="status">{backup.executor.restart_required?t("归档进程回收尚未确认，自动重启已停止。需处理残留进程后重启网关。","Archive process cleanup is unconfirmed and automatic restart has stopped. Handle remaining processes before restarting the gateway."):t("归档进程遇到错误，可刷新状态查看后续处理。","The archive process encountered an error. Refresh its status to check subsequent handling.")}</p>}
  {backup?.restore_protocol===3&&<p>{t('版本','Version')} {backup.requested_version}{backup.part_index===undefined?'':t(` · 第 ${backup.part_index} 卷`,` · Part ${backup.part_index}`)} · {t(`${backup.selected_file_count} 个文件 · 缺失 ${backup.missing_file_count} 个`,`${backup.selected_file_count} files · ${backup.missing_file_count} missing`)}</p>}
  {backup?.all_versions_archived===false&&<p role="status">{t("归档清单尚未覆盖全部文件版本。","The archive inventory does not yet cover all file versions.")}</p>}
  {Number(backup?.unarchived_file_count)>0&&<p role="status">{t(`所选版本有 ${backup?.unarchived_file_count} 个文件尚无可验证归档。`,`${backup?.unarchived_file_count} files in the selected version have no verifiable archive.`)}</p>}
  {backup?.local_state==='deleted'&&!backup.restorable&&<p role="status">{t("所选文件缺少完整可验证备份，当前无法恢复。","The selected files lack complete verifiable backups and cannot currently be restored.")}</p>}
  {backup?.last_error&&<p role="status">{t("上次归档或恢复未完成，可刷新状态后重试。","The last archive or restore did not complete. Refresh its status before retrying.")}</p>}
  {resource.loading&&<p role="status">{t("正在读取归档状态…","Reading archive status…")}</p>}
  {resource.error&&<p role="alert">{t("归档状态读取失败，可重新读取。","Reading archive status failed. Read it again.")}</p>}
  <button type="button" disabled={busy||resource.loading} onClick={refresh}>{t("刷新归档状态","Refresh Archive Status")}</button>
  {canRestore&&<button type="button" disabled={busy||resource.loading||!!resource.error||receipt.pending} onClick={()=>void restore()}>{backup?.local_state==='present'?t("从归档重新恢复此版本","Restore This Version Again from Archive"):t("恢复所选文件","Restore Selected Files")}</button>}
  {canArchive&&<button type="button" disabled={busy||resource.loading||!!resource.error||receipt.pending||archiveAfterAttempt!==null} onClick={()=>void archive()}>{backup?.last_error||backup?.backup_status==='retry'||backup?.backup_status==='failed'?t("重试归档全部版本","Retry Archiving All Versions"):t("归档全部版本","Archive All Versions")}</button>}
  {backup?.archive_protocol===1&&!backup.archive_ready&&<p role="status">{t("归档全部版本需要本地文件齐全，且当前没有恢复操作。","Archiving all versions requires all local files to be present and no restoration in progress.")}</p>}
  {archiveAfterAttempt!==null&&<p role="status">{t("全部版本归档请求已登记，等待归档进程完成并验证文件。","The request to archive all versions was recorded. Wait for the archive process to complete and verify the files.")}</p>}
  {receipt.pending&&<div role="status">
   <p>{store?.closing?t("结束原请求的意图已保留，请继续确认原回执。","The intent to close the original request was retained. Continue verifying its original receipt."):t("原归档或恢复请求的回执尚未确认，请先确认原请求。","The original archive or restore receipt is unconfirmed. Verify the original request first.")}</p>
   <button type="button" disabled={busy} onClick={()=>void restore()}>{store?.closing?t("重试结束确认","Retry Close Confirmation"):t("重试原请求","Retry Original Request")}</button>
   <button type="button" disabled={busy} onClick={()=>void submit(`/artifacts/${encodeURIComponent(artifactId)}/restore`,{},'inspect')}>{t("读取原请求回执","Read Original Request Receipt")}</button>
   <button type="button" disabled={busy} onClick={()=>void submit(`/artifacts/${encodeURIComponent(artifactId)}/restore`,{},'close')}>{t("结束未提交的原请求","Close the Unsubmitted Original Request")}</button>
  </div>}
  {backup?.local_state==='restoring'&&<p role="status">{backup.executor?.mode==='managed'?t("已登记到托管归档进程，完成后会重新读取文件。","The request is registered with the managed archive process. Files will be read again after completion."):t("恢复由单独配置的外部归档进程处理，完成后会重新读取文件。","Restoration is handled by the separately configured external archive process. Files will be read again after completion.")}</p>}
  {backup?.restore_protocol===2&&!legacyCurrent&&<p role="status">{t("此服务器提供当前版本恢复，所选历史版本需通过新版恢复入口处理。","This server restores the current version. The selected historical version requires the newer recovery interface.")}</p>}
  {error&&<p role="alert">{conversationUiError(error,language)}</p>}
 </section>;
}
