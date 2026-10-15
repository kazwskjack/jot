import React,{useRef,useState} from 'react';
import type {Memory,MemoryVersion} from './types';
import {pathId,workbenchApi} from './client';
import {useResource} from './useResource';
import {useMutationReceipt} from './useMutationReceipt';
import {ResourceStatus} from './AgentsPanel';
import {memoryRestoreReason,memoryRestoreInput} from './memory-history.mjs';

export default function MemoryHistory({workspace,memory,onClose,onRestored}:{workspace:string;memory:Memory;onClose:()=>void;onRestored:()=>void}){
 const [beforeVersion,setBeforeVersion]=useState<number|undefined>(undefined);
 const resource=useResource(signal=>workbenchApi.memoryHistory(workspace,memory.memory_id,signal,beforeVersion),JSON.stringify([workspace,memory.memory_id,memory.version,beforeVersion]));
 const mutation=useMutationReceipt(),[selected,setSelected]=useState<MemoryVersion|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const command=useRef<{expected_version:number;source_version:number}|null>(null);
 const current=resource.data?.current_version;
 const restore=async()=>{
  if(!selected||busy||current===undefined)return;setBusy(true);setError('');
  try{
   if(!mutation.pending)command.current=memoryRestoreInput(memory,selected,current);
   if(!command.current)throw new Error('原恢复请求不可用，请保留页面核对回执。');
   await mutation.submit(`/workspaces/${pathId(workspace)}/memory/${pathId(memory.memory_id)}/restore`,'POST',command.current);command.current=null;onRestored();
  }
  catch(error){
   if(error instanceof Error&&error.message==='VERSION_CONFLICT'){setSelected(null);resource.reload();setError('这条记忆已更新。请重新加载当前记忆，再选择版本确认。');}
   else if(command.current&&(!(error as {status?:number})?.status||Number((error as {status?:number}).status)>=500))setError('恢复结果尚未确认。请留在当前页面重试原请求，避免重复操作。');
   else setError(error instanceof Error?error.message:'恢复未完成，请保留此页核对。');
  }finally{setBusy(false);}
 };
 return <section aria-label="记忆历史版本"><div className="wb-toolbar"><div><h3>记忆历史版本</h3><p>当前 v{memory.version}。恢复会新增版本，并改为待核实。</p></div><button disabled={busy||mutation.pending} onClick={onClose}>返回记忆</button></div>
  <ResourceStatus {...resource} onRetry={resource.reload}/>{error&&<p role="alert" className="wb-error">{error}</p>}
  {current!==undefined&&current!==memory.version&&<p role="status">当前记忆已更新，最新为 v{current}。<button disabled={busy||mutation.pending} onClick={onRestored}>重新加载当前记忆</button></p>}
  {selected?<div className="wb-form" role="alertdialog" aria-label="恢复记忆确认"><h4>将 v{selected.version} 的内容恢复为新版本 v{memory.version+1}？</h4><div className="wb-form-grid"><div><strong>当前内容</strong><p>{memory.content}</p></div><div><strong>恢复后的内容</strong><p>{selected.content}</p></div></div><p>原版本仍保留。恢复后需要重新核实，不会延长当前有效期。</p>{memory.expires_at&&<p>当前有效期：{new Date(memory.expires_at).toLocaleString()}</p>}{selected.expires_at&&<p>来源有效期：{new Date(selected.expires_at).toLocaleString()}；采用两者中较早的时间。</p>}
   <div className="wb-actions"><button disabled={busy||mutation.pending} onClick={()=>{setSelected(null);setError('');}}>取消恢复</button><button className="wb-primary" disabled={busy||(!mutation.pending&&!!memoryRestoreReason(memory,selected,current))} onClick={()=>void restore()}>{busy?'正在恢复…':mutation.pending?'重试原恢复':'确认恢复为新版本'}</button></div></div>
   :<><div className="wb-message-list">{resource.data?.items.map(version=>{const reason=memoryRestoreReason(memory,version,current);return <article key={version.version}><div><strong>版本 {version.version}</strong><span className="wb-badge">{version.verified?'当时已核实':'待核实'}</span></div><p>{version.content}</p>{version.source_revision&&<p>来源版本：{version.source_revision}</p>}{version.provenance?.map((source,index)=><p key={index}>{source.kind}：{source.reference}</p>)}{version.verified_at&&<p>核实于：{new Date(version.verified_at).toLocaleString()}</p>}{version.supersedes&&<p>替代关系：{version.supersedes}</p>}{version.restored_from_version!==undefined&&<p>由 v{version.restored_from_version} 恢复，替代当时的 v{version.restored_over_version}。</p>}{version.expires_at&&<small>有效期：{new Date(version.expires_at).toLocaleString()}</small>}{reason&&<p className="wb-hint">{version.version===memory.version?'这是当前版本。':reason}</p>}<div className="wb-actions"><button disabled={busy||mutation.pending||resource.loading||!!reason} title={reason} onClick={()=>setSelected(version)}>恢复此版本</button></div></article>;})}</div>
    <div className="wb-actions">{beforeVersion!==undefined&&<button disabled={busy||mutation.pending||resource.loading} onClick={()=>setBeforeVersion(undefined)}>查看最新版本</button>}{resource.data?.next_before_version!=null&&<button disabled={busy||mutation.pending||resource.loading} onClick={()=>setBeforeVersion(resource.data!.next_before_version!)}>查看更早历史</button>}</div></>}
 </section>;
}
