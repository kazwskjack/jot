import React,{useEffect,useMemo,useRef,useState} from 'react';
import {request,taskDraftScope} from './client';
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
 const identity=JSON.stringify([owner,artifactId,version??null,sha256??null,partIndex??null]);
 const alive=useRef(true),previousState=useRef(''),pollAttempt=useRef(0);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [archiveAfterAttempt,setArchiveAfterAttempt]=useState<number|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{previousState.current='';pollAttempt.current=0;setError('');},[identity]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const receipt=useMutationReceipt(store,undefined,async(path,method,body,key)=>{
  if(!current()||!store)throw Error('文件恢复账户或回执范围尚未确认');
  const frozen={path,method,body,key};
  await store.persist(frozen);
  if(!current())throw Error('文件恢复账户范围已变化');
  const command=body as {expected_version:number;expected_sha256?:string;restore_version?:number;restore_sha256?:string;part_index?:number};
  const selected=command.restore_version!==undefined,archiving=path===`/artifacts/${encodeURIComponent(artifactId)}/archive`;
  let result:ArtifactRestoreReceipt|ArtifactArchiveReceipt;
  try{result=await request<ArtifactRestoreReceipt|ArtifactArchiveReceipt>(path,method,body,key);}
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
 const submit=async(path:string,body:unknown)=>{
  if(busy||!store||!current())return;
  setBusy(true);setError('');
  try{
   const result=await receipt.submit(path,'POST',body) as ArtifactRestoreReceipt|ArtifactArchiveReceipt;
   if(current()){
    if('archive_protocol' in result)setArchiveAfterAttempt(result.after_attempt);
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
 const statuses={pending:'待归档',retry:'归档重试中',verified:'归档已验证',failed:'归档失败'};
 const phases={unmanaged:'外部进程',starting:'正在启动',idle:'空闲',restoring:'正在恢复',archiving:'正在归档',cleaning:'正在清理已验证备份的本地缓存',failed:'处理失败',stopped:'已停止'};
 const local={present:'所选文件在本地',deleted:'所选文件缺失',restoring:'恢复请求已登记'};
 return <section aria-label="文件归档与恢复" data-chat-search-ignore>
  {recoveryLoading&&<p role="status">正在读取文件操作持久回执…</p>}
  {recoveryError&&<p role="alert">{recoveryError}</p>}
  <button type="button" disabled={busy||recoveryLoading} onClick={onReloadRecovery}>重读待确认归档或恢复请求</button>
  {backup&&<p>{statuses[backup.backup_status]} · {local[backup.local_state]}</p>}
  {backup?.executor?.mode==='managed'&&<p role="status">托管归档进程 · {phases[backup.executor.state]}{backup.executor.last_completed_at?` · 上次处理 ${backup.executor.last_completed_at}`:''}</p>}
  {backup?.executor?.mode==='managed'&&backup.executor.state==='failed'&&<p role="status">{backup.executor.restart_required?'归档进程回收尚未确认，自动重启已停止。需处理残留进程后重启网关。':'归档进程遇到错误，可刷新状态查看后续处理。'}</p>}
  {backup?.restore_protocol===3&&<p>版本 {backup.requested_version}{backup.part_index===undefined?'':` · 第 ${backup.part_index} 卷`} · {backup.selected_file_count} 个文件 · 缺失 {backup.missing_file_count} 个</p>}
  {backup?.all_versions_archived===false&&<p role="status">归档清单尚未覆盖全部文件版本。</p>}
  {Number(backup?.unarchived_file_count)>0&&<p role="status">所选版本有 {backup?.unarchived_file_count} 个文件尚无可验证归档。</p>}
  {backup?.local_state==='deleted'&&!backup.restorable&&<p role="status">所选文件缺少完整可验证备份，当前无法恢复。</p>}
  {backup?.last_error&&<p role="status">上次归档或恢复未完成，可刷新状态后重试。</p>}
  {resource.loading&&<p role="status">正在读取归档状态…</p>}
  {resource.error&&<p role="alert">归档状态读取失败，可重新读取。</p>}
  <button type="button" disabled={busy||resource.loading} onClick={refresh}>刷新归档状态</button>
  {canRestore&&<button type="button" disabled={busy||resource.loading||!!resource.error||receipt.pending} onClick={()=>void restore()}>{backup?.local_state==='present'?'从归档重新恢复此版本':'恢复所选文件'}</button>}
  {canArchive&&<button type="button" disabled={busy||resource.loading||!!resource.error||receipt.pending||archiveAfterAttempt!==null} onClick={()=>void archive()}>{backup?.last_error||backup?.backup_status==='retry'||backup?.backup_status==='failed'?'重试归档全部版本':'归档全部版本'}</button>}
  {backup?.archive_protocol===1&&!backup.archive_ready&&<p role="status">归档全部版本需要本地文件齐全，且当前没有恢复操作。</p>}
  {archiveAfterAttempt!==null&&<p role="status">全部版本归档请求已登记，等待归档进程完成并验证文件。</p>}
  {receipt.pending&&<p role="status">原归档或恢复请求的回执尚未确认，请先确认原请求。<button type="button" disabled={busy} onClick={()=>void restore()}>重试原请求</button></p>}
  {backup?.local_state==='restoring'&&<p role="status">{backup.executor?.mode==='managed'?'已登记到托管归档进程，完成后会重新读取文件。':'恢复由单独配置的外部归档进程处理，完成后会重新读取文件。'}</p>}
  {backup?.restore_protocol===2&&!legacyCurrent&&<p role="status">此服务器提供当前版本恢复，所选历史版本需通过新版恢复入口处理。</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
