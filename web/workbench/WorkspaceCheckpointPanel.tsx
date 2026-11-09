import React,{useEffect,useRef,useState} from 'react';
import {request,taskDraftScope} from '../jot/client';
import {useMutationReceipt} from './useMutationReceipt';
import {useResource} from './useResource';
import CheckpointRestoreRecovery from './CheckpointRestoreRecovery';
import type {WorkspaceCheckpoint,WorkspaceCheckpointPage,WorkspaceCheckpointRestoreReview} from './types';

export default function WorkspaceCheckpointPanel({workspace,project,canWrite,onPending,onChanged}:{workspace:string;project:string;canWrite:boolean;onPending:(value:boolean)=>void;onChanged:()=>void}){
 const scope=taskDraftScope(),alive=useRef(true),mutation=useMutationReceipt();
 const [paths,setPaths]=useState(''),[selected,setSelected]=useState<Record<string,string>>({}),[review,setReview]=useState<WorkspaceCheckpointRestoreReview|null>(null);
 const [restorePending,setRestorePending]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[action,setAction]=useState('');
 const [cursors,setCursors]=useState<Array<string|undefined>>([undefined]);
 const cursor=cursors.at(-1),prefix=`/workspaces/${encodeURIComponent(workspace)}/checkpoints`;
 const identity=JSON.stringify([scope,workspace,project,cursor]),current=()=>alive.current&&!!scope&&taskDraftScope()===scope;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{onPending(restorePending||mutation.pending||busy);},[restorePending,mutation.pending,busy,onPending]);
 const resource=useResource(async signal=>{
  const query=new URLSearchParams({project_id:project,limit:'25'});if(cursor!==undefined)query.set('before_checkpoint_id',cursor);
  const page=await request<WorkspaceCheckpointPage>(`${prefix}?${query}`,'GET',undefined,undefined,signal);
  if(!current()||!page||!Array.isArray(page.items)||page.items.length>25||page.execution_authorized!==false||page.restore_authorized!==false)throw Error('检查点目录来源尚未确认');
  const seen=new Set<string>();let previous:WorkspaceCheckpoint|undefined;
  for(const item of page.items){
   if(!item||typeof item.checkpoint_id!=='string'||!item.checkpoint_id||item.checkpoint_id.length>200||item.checkpoint_id===cursor||seen.has(item.checkpoint_id)
    ||item.workspace_id!==workspace||item.project_id!==project||!['ready','pruned'].includes(item.state)
    ||item.execution_authorized!==false||item.restore_authorized!==false||typeof item.created_at!=='string'||!Number.isFinite(Date.parse(item.created_at))
    ||!Array.isArray(item.paths)||!item.paths.length||item.paths.some(path=>typeof path!=='string'||!path)
    ||typeof item.manifest_sha256!=='string'||!/^[a-f0-9]{64}$/.test(item.manifest_sha256)
    ||item.receipt?.checkpoint_id!==item.checkpoint_id||item.receipt.project_id!==project||item.receipt.workspace_id!==workspace||item.receipt.manifest_sha256!==item.manifest_sha256
    ||previous&&(item.created_at>previous.created_at||item.created_at===previous.created_at&&item.checkpoint_id>=previous.checkpoint_id))throw Error('检查点目录来源尚未确认');
   seen.add(item.checkpoint_id);previous=item;
  }
  if(page.next_before_checkpoint_id!==null&&(page.items.length!==25||page.next_before_checkpoint_id!==previous?.checkpoint_id||cursors.includes(page.next_before_checkpoint_id)))throw Error('检查点分页来源尚未确认');
  return {identity,page};
 },identity,!!scope&&!!project);
 const page=resource.data?.identity===identity&&taskDraftScope()===scope?resource.data.page:undefined;
 const refresh=()=>{setCursors([undefined]);resource.reload();};
 const send=async(kind:string,url:string,body:unknown)=>{
  if(!current()||!canWrite||busy||restorePending||mutation.pending&&action!==kind)return;
  setBusy(true);setAction(kind);setError('');
  try{const value=await mutation.submit(url,'POST',body);if(!current())return;
   if(kind.startsWith('review:'))setReview(value as WorkspaceCheckpointRestoreReview);else {setPaths('');refresh();}
   setAction('');
  }catch(reason){if(current())setError(reason instanceof Error?reason.message:'检查点操作结果未知，请重试原操作。');}
  finally{if(current())setBusy(false);}
 };
 const create=()=>{const selectedPaths=[...new Set(paths.split(/[,\r\n]+/).map(path=>path.trim()).filter(Boolean))];if(!selectedPaths.length){setError('请输入至少一个项目内相对路径。');return;}void send('create',prefix,{project_id:project,paths:selectedPaths});};
 const pagingLocked=busy||mutation.pending||restorePending||resource.loading;
 return <section aria-label="项目文件检查点" className="wb-form">
  <h3>项目文件检查点</h3><p className="wb-hint">选择要保存的路径。恢复时先审阅当前与目标版本，每次恢复一个路径。</p>
  {error&&<p role="alert">{error}</p>}
  <label>相对路径（逗号或换行分隔）<textarea value={paths} disabled={!canWrite||busy||mutation.pending||restorePending} onChange={event=>setPaths(event.target.value)}/></label>
  <button disabled={!canWrite||!project||busy||restorePending||mutation.pending&&action!=='create'} onClick={create}>{mutation.pending&&action==='create'?'重试原创建操作':'创建检查点'}</button>
  <button disabled={pagingLocked} onClick={refresh}>刷新检查点</button>
  <p>每页25个检查点，当前第 {cursors.length} 页。</p>
  {resource.loading&&<p role="status">正在读取检查点目录…</p>}
  {resource.error&&<p role="alert">{resource.error} <button disabled={pagingLocked} onClick={resource.reload}>重试读取目录</button></p>}
  {page&&!resource.loading&&!resource.error&&<>
   {!page.items.length&&<p role="status">此页没有检查点。</p>}
   <ul>{page.items.map(item=>{
    const path=selected[item.checkpoint_id]??item.paths[0]??'',kind=`review:${item.checkpoint_id}:${path}`;
    return <li key={item.checkpoint_id}><strong>{item.checkpoint_id}</strong><small>{item.state==='ready'?'可用':'副本已清理'}</small>
     <select aria-label="恢复路径" value={path} disabled={busy||mutation.pending||restorePending} onChange={event=>setSelected(value=>({...value,[item.checkpoint_id]:event.target.value}))}>{item.paths.map(value=><option key={value} value={value}>{value}</option>)}</select>
     <button disabled={!canWrite||busy||restorePending||item.state!=='ready'||!path||mutation.pending&&action!==kind} onClick={()=>void send(kind,`${prefix}/${encodeURIComponent(item.checkpoint_id)}/restore-review`,{project_id:project,path})}>检查恢复内容</button>
    </li>;
   })}</ul>
  </>}
  <button disabled={pagingLocked||cursors.length===1} onClick={()=>setCursors(values=>values.slice(0,-1))}>上一页检查点</button>
  <button disabled={pagingLocked||!!resource.error||!page?.next_before_checkpoint_id} onClick={()=>{const next=page?.next_before_checkpoint_id;if(next)setCursors(values=>[...values,next]);}}>下一页检查点</button>
  <CheckpointRestoreRecovery workspace={workspace} project={project} review={review} canWrite={canWrite&&!busy&&!mutation.pending} onClose={()=>setReview(null)} onPending={setRestorePending} onApplied={()=>{refresh();onChanged();}}/>
 </section>;
}
