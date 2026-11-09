import React,{useEffect,useMemo,useRef,useState} from 'react';
import {request,taskDraftScope} from './client';
import {useResource} from '../workbench/useResource';
import {useMutationReceipt} from '../workbench/useMutationReceipt';
import {ArtifactRecoveryStore} from '../workbench/task-save-receipt.mjs';
import type {ArtifactBackup,ArtifactRestoreReceipt} from './types';

type Props={artifactId:string;onRestored:()=>void};
export default function ArtifactRecovery(props:Props){
 const owner=taskDraftScope();
 const recovery=useMemo(()=>{
  try{const store=new ArtifactRecoveryStore(window.sessionStorage,owner,props.artifactId);store.read();return {store};}
  catch{return {error:'文件恢复回执存储不可用，请保留当前页面后重新读取。'};}
 },[owner,props.artifactId]);
 return recovery.store?<Recovery key={JSON.stringify([owner,props.artifactId])} {...props} owner={owner} store={recovery.store}/>:<p role="alert">{recovery.error}</p>;
}

function Recovery({artifactId,onRestored,owner,store}:Props&{owner:string;store:ArtifactRecoveryStore}){
 const identity=JSON.stringify([owner,artifactId]),alive=useRef(true),previousState=useRef('');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const receipt=useMutationReceipt(store,undefined,async(path,method,body,key)=>{
  if(!current())throw Error('文件恢复账户范围已变化');
  const result=await request<ArtifactRestoreReceipt>(path,method,body,key);
  if(!current()||!result||result.accepted!==true||result.artifact_id!==artifactId||result.restore_protocol!==2
   ||result.version!==(body as {expected_version:number}).expected_version||!['ready','restoring'].includes(result.status))throw Error('文件恢复回执尚未确认，请重试原请求。');
  return result;
 });
 const resource=useResource(async signal=>{
  const backup=await request<ArtifactBackup>(`/artifacts/${encodeURIComponent(artifactId)}/backup-status`,'GET',undefined,undefined,signal);
  if(!current()||!backup||backup.artifact_id!==artifactId||!['pending','retry','verified','failed'].includes(backup.backup_status)
   ||!['present','deleted','restoring'].includes(backup.local_state)||typeof backup.restorable!=='boolean'
   ||backup.all_versions_archived!==undefined&&typeof backup.all_versions_archived!=='boolean'
   ||backup.restore_protocol!==undefined&&backup.restore_protocol!==2
   ||backup.version!==undefined&&(!Number.isSafeInteger(backup.version)||backup.version<1))throw Error('文件归档状态来源尚未确认');
  return {identity,backup};
 },identity,!!owner);
 const backup=resource.data?.identity===identity&&taskDraftScope()===owner?resource.data.backup:undefined;
 useEffect(()=>{
  if(!backup||resource.loading||resource.error)return;
  if(previousState.current&&previousState.current!=='present'&&backup.local_state==='present')onRestored();
  previousState.current=backup.local_state;
  if(backup.local_state!=='restoring')return;
  const timer=setTimeout(resource.reload,2000);return()=>clearTimeout(timer);
 },[backup,resource.loading,resource.error,resource.reload,onRestored]);
 const canRestore=backup?.restore_protocol===2&&backup.version!==undefined&&backup.backup_status==='verified'&&backup.restorable&&backup.local_state==='deleted';
 const restore=async()=>{
  if(busy||!current()||!receipt.pending&&!canRestore)return;
  setBusy(true);setError('');
  try{
   const result=await receipt.submit(`/artifacts/${encodeURIComponent(artifactId)}/restore`,'POST',{expected_version:backup?.version}) as ArtifactRestoreReceipt;
   if(current()){
    if(result.status==='restoring')previousState.current='restoring';
    resource.reload();if(result.status==='ready')onRestored();
   }
  }catch(reason){if(current()){setError(reason instanceof Error?reason.message:'文件恢复尚未确认');resource.reload();}}
  finally{if(current())setBusy(false);}
 };
 const statuses={pending:'待归档',retry:'归档重试中',verified:'归档已验证',failed:'归档失败'};
 const local={present:'本地文件保留中',deleted:'本地文件已清理',restoring:'正在从归档恢复'};
 return <section aria-label="文件归档与恢复" data-chat-search-ignore>
  {backup&&<p>{statuses[backup.backup_status]} · {local[backup.local_state]}</p>}
  {backup?.all_versions_archived===false&&<p role="status">归档清单尚未覆盖全部文件版本。</p>}
  {backup?.last_error&&<p role="status">上次归档或恢复未完成，可刷新状态后重试。</p>}
  {resource.loading&&<p role="status">正在读取归档状态…</p>}
  {resource.error&&<p role="alert">归档状态读取失败，可重新读取。</p>}
  <button type="button" disabled={busy||resource.loading} onClick={resource.reload}>刷新归档状态</button>
  {canRestore&&<button type="button" disabled={busy||resource.loading||!!resource.error||receipt.pending} onClick={()=>void restore()}>恢复本地文件</button>}
  {receipt.pending&&<p role="status">原恢复请求的回执尚未确认。<button type="button" disabled={busy} onClick={()=>void restore()}>重试原恢复请求</button></p>}
  {backup?.local_state==='restoring'&&<p role="status">恢复完成后将重新读取文件。</p>}
  {backup?.local_state==='deleted'&&backup.restore_protocol!==2&&<p role="status">服务器尚未提供按版本恢复入口。</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
