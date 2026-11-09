import React,{useEffect,useMemo,useRef,useState} from 'react';
import {request,taskDraftScope} from './client';
import {useResource} from '../workbench/useResource';
import {useMutationReceipt} from '../workbench/useMutationReceipt';
import {ArtifactRecoveryStore} from '../workbench/task-save-receipt.mjs';
import type {ArtifactBackup,ArtifactRestoreReceipt} from './types';

type Props={artifactId:string;version?:number|undefined;sha256?:string|undefined;partIndex?:number|undefined;onRestored:()=>void};
export default function ArtifactRecovery(props:Props){
 const owner=taskDraftScope(),[storageRevision,setStorageRevision]=useState(0);
 const recovery=useMemo(()=>{
  try{const store=new ArtifactRecoveryStore(window.sessionStorage,owner,props.artifactId);store.read();return {store,error:''};}
  catch{return {store:null,error:'恢复回执存储不可用，请先重新读取回执。'};}
 },[owner,props.artifactId,storageRevision]);
 return <>
  {recovery.error&&<p role="alert">{recovery.error} <button type="button" onClick={()=>setStorageRevision(value=>value+1)}>重读恢复回执</button></p>}
  <Recovery key={JSON.stringify([owner,props.artifactId,storageRevision])} {...props} owner={owner} store={recovery.store}/>
 </>;
}

function Recovery({artifactId,version,sha256,partIndex,onRestored,owner,store}:Props&{owner:string;store:ArtifactRecoveryStore|null}){
 const identity=JSON.stringify([owner,artifactId,version??null,sha256??null,partIndex??null]);
 const alive=useRef(true),previousState=useRef(''),pollAttempt=useRef(0);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{previousState.current='';pollAttempt.current=0;setError('');},[identity]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const receipt=useMutationReceipt(store,undefined,async(path,method,body,key)=>{
  if(!current())throw Error('文件恢复账户范围已变化');
  const command=body as {expected_version:number;restore_version?:number;restore_sha256?:string;part_index?:number};
  const selected=command.restore_version!==undefined;
  let result:ArtifactRestoreReceipt;
  try{result=await request<ArtifactRestoreReceipt>(path,method,body,key);}
  catch(reason){
   const failure=reason as {status?:number;message?:string};
   if(selected&&[400,422].includes(failure.status??0)
    &&['CONTRACT_REQUEST_INVALID','INVALID_ARTIFACT_RESTORE','INVALID_ARTIFACT_RESTORE_QUERY'].includes(failure.message??''))throw Error('服务器尚未支持原恢复请求，请保留回执并在恢复入口可用后重试。');
   throw reason;
  }
  if(!current()||!result||result.accepted!==true||result.artifact_id!==artifactId||result.restore_protocol!==(selected?3:2)
   ||result.version!==command.expected_version||!['ready','restoring'].includes(result.status)
   ||selected&&(result.requested_version!==command.restore_version||result.requested_sha256!==command.restore_sha256||result.part_index!==command.part_index))throw Error('文件恢复回执尚未确认，请重试原请求。');
  return result;
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
  if(backup.executor!==undefined){
   const executor=backup.executor;
   if(!executor||!['managed','external'].includes(executor.mode)
    ||!['unmanaged','starting','idle','restoring','archiving','cleaning','failed','stopped'].includes(executor.state)
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
  if(backup.local_state!=='restoring')return;
  const delay=Math.min(30000,2000*2**Math.min(pollAttempt.current,4));pollAttempt.current+=1;
  const timer=setTimeout(resource.reload,delay);return()=>clearTimeout(timer);
 },[backup,resource.loading,resource.error,resource.reload,onRestored]);
 const legacyCurrent=backup?.restore_protocol===2&&partIndex===undefined&&(version===undefined||version===backup.version);
 const canRestore=!!store&&backup?.version!==undefined&&backup.restorable
  &&(backup.restore_protocol===3&&backup.local_state!=='restoring'||legacyCurrent&&backup.backup_status==='verified'&&backup.local_state==='deleted');
 const restore=async()=>{
  if(busy||!store||!current()||!receipt.pending&&!canRestore)return;
  setBusy(true);setError('');
  const body=backup?.restore_protocol===3?{expected_version:backup.version,restore_version:backup.requested_version,restore_sha256:backup.requested_sha256,
   ...(backup.part_index!==undefined?{part_index:backup.part_index}:{})}:{expected_version:backup?.version};
  try{
   const result=await receipt.submit(`/artifacts/${encodeURIComponent(artifactId)}/restore`,'POST',body) as ArtifactRestoreReceipt;
   if(current()){
    if(result.status==='restoring')previousState.current='restoring';
    pollAttempt.current=0;resource.reload();if(result.status==='ready')onRestored();
   }
  }catch(reason){if(current()){setError(reason instanceof Error?reason.message:'文件恢复尚未确认');resource.reload();}}
  finally{if(current())setBusy(false);}
 };
 const refresh=()=>{pollAttempt.current=0;resource.reload();};
 const statuses={pending:'待归档',retry:'归档重试中',verified:'归档已验证',failed:'归档失败'};
 const phases={unmanaged:'外部进程',starting:'正在启动',idle:'空闲',restoring:'正在恢复',archiving:'正在归档',cleaning:'正在清理已验证备份的本地缓存',failed:'处理失败',stopped:'已停止'};
 const local={present:'所选文件在本地',deleted:'所选文件缺失',restoring:'恢复请求已登记'};
 return <section aria-label="文件归档与恢复" data-chat-search-ignore>
  {backup&&<p>{statuses[backup.backup_status]} · {local[backup.local_state]}</p>}
  {backup?.executor?.mode==='managed'&&<p role="status">托管归档进程 · {phases[backup.executor.state]}{backup.executor.last_completed_at?` · 上次处理 ${backup.executor.last_completed_at}`:''}</p>}
  {backup?.executor?.mode==='managed'&&backup.executor.state==='failed'&&<p role="status">归档进程遇到错误，请刷新状态后重试原请求。</p>}
  {backup?.restore_protocol===3&&<p>版本 {backup.requested_version}{backup.part_index===undefined?'':` · 第 ${backup.part_index} 卷`} · {backup.selected_file_count} 个文件 · 缺失 {backup.missing_file_count} 个</p>}
  {backup?.all_versions_archived===false&&<p role="status">归档清单尚未覆盖全部文件版本。</p>}
  {Number(backup?.unarchived_file_count)>0&&<p role="status">所选版本有 {backup?.unarchived_file_count} 个文件尚无可验证归档。</p>}
  {backup?.local_state==='deleted'&&!backup.restorable&&<p role="status">所选文件缺少完整可验证备份，当前无法恢复。</p>}
  {backup?.last_error&&<p role="status">上次归档或恢复未完成，可刷新状态后重试。</p>}
  {resource.loading&&<p role="status">正在读取归档状态…</p>}
  {resource.error&&<p role="alert">归档状态读取失败，可重新读取。</p>}
  <button type="button" disabled={busy||resource.loading} onClick={refresh}>刷新归档状态</button>
  {canRestore&&<button type="button" disabled={busy||resource.loading||!!resource.error||receipt.pending} onClick={()=>void restore()}>{backup?.local_state==='present'?'从归档重新恢复此版本':'恢复所选文件'}</button>}
  {receipt.pending&&<p role="status">原恢复请求的回执尚未确认，请先确认原请求。<button type="button" disabled={busy} onClick={()=>void restore()}>重试原恢复请求</button></p>}
  {backup?.local_state==='restoring'&&<p role="status">{backup.executor?.mode==='managed'?'已登记到托管归档进程，完成后会重新读取文件。':'恢复由单独配置的外部归档进程处理，完成后会重新读取文件。'}</p>}
  {backup?.restore_protocol===2&&!legacyCurrent&&<p role="status">此服务器提供当前版本恢复，所选历史版本需通过新版恢复入口处理。</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
