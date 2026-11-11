import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {memoryUiMessage} from './memory-ui-messages';
import React,{useRef,useState} from 'react';
import type {Memory,MemoryVersion} from './types';
import {pathId,workbenchApi} from './client';
import {useResource} from './useResource';
import {useMutationReceipt} from './useMutationReceipt';
import {ResourceStatus} from './PanelStatus';
import {memoryRestoreReason,memoryRestoreInput} from './memory-history.mjs';

export default function MemoryHistory({workspace,memory,onClose,onRestored}:{workspace:string;memory:Memory;onClose:()=>void;onRestored:()=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>memoryUiMessage(value,language);
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
 return <section lang={language} aria-label={t("记忆历史版本","Memory Version History")}><div className="wb-toolbar"><div><h3>{t("记忆历史版本","Memory Version History")}</h3><p>{t(`当前 v${memory.version}。恢复会新增版本，并改为待核实。`,`Current v${memory.version}. Restoring creates a new version marked unverified.`)}</p></div><button disabled={busy||mutation.pending} onClick={onClose}>{t("返回记忆","Back to Memory")}</button></div>
  <ResourceStatus {...resource} error={message(resource.error)} onRetry={resource.reload}/>{error&&<p role="alert" className="wb-error">{message(error)}</p>}
  {current!==undefined&&current!==memory.version&&<p role="status">{t(`当前记忆已更新，最新为 v${current}。`,`The current memory changed; the latest version is v${current}.`)}<button disabled={busy||mutation.pending} onClick={onRestored}>{t("重新加载当前记忆","Reload Current Memory")}</button></p>}
  {selected?<div className="wb-form" role="alertdialog" aria-label={t("恢复记忆确认","Confirm Memory Restore")}><h4>{t(`将 v${selected.version} 的内容恢复为新版本 v${memory.version+1}？`,`Restore v${selected.version} content as new version v${memory.version+1}?`)}</h4><div className="wb-form-grid"><div><strong>{t("当前内容","Current Content")}</strong><p>{memory.content}</p></div><div><strong>{t("恢复后的内容","Content After Restore")}</strong><p>{selected.content}</p></div></div><p>{t("原版本仍保留。恢复后需要重新核实，不会延长当前有效期。","Original versions are retained. Restored memory needs verification again and does not extend the current expiry.")}</p>{memory.expires_at&&<p>{t("当前有效期：","Current Expiry: ")}{new Date(memory.expires_at).toLocaleString()}</p>}{selected.expires_at&&<p>{t("来源有效期：","Source Expiry: ")}{new Date(selected.expires_at).toLocaleString()}{t('；采用两者中较早的时间。','; the earlier of the two times is used.')}</p>}
   <div className="wb-actions"><button disabled={busy||mutation.pending} onClick={()=>{setSelected(null);setError('');}}>{t("取消恢复","Cancel Restore")}</button><button className="wb-primary" disabled={busy||(!mutation.pending&&!!memoryRestoreReason(memory,selected,current))} onClick={()=>void restore()}>{busy?t("正在恢复…","Restoring…"):mutation.pending?t("重试原恢复","Retry Original Restore"):t("确认恢复为新版本","Confirm Restore as New Version")}</button></div></div>
   :<><div className="wb-message-list">{resource.data?.items.map(version=>{const reason=memoryRestoreReason(memory,version,current);return <article key={version.version}><div><strong>{t("版本 ","Version ")}{version.version}</strong><span className="wb-badge">{version.verified?t("当时已核实","Verified at That Time"):t("待核实","Unverified")}</span></div><p>{version.content}</p>{version.source_revision&&<p>{t("来源版本：","Source Revision: ")}{version.source_revision}</p>}{version.provenance?.map((source,index)=><p key={index}>{source.kind}{t('：',': ')}{source.reference}</p>)}{version.verified_at&&<p>{t("核实于：","Verified at: ")}{new Date(version.verified_at).toLocaleString()}</p>}{version.supersedes&&<p>{t("替代关系：","Supersedes: ")}{version.supersedes}</p>}{version.restored_from_version!==undefined&&<p>{t(`由 v${version.restored_from_version} 恢复，替代当时的 v${version.restored_over_version}。`,`Restored from v${version.restored_from_version}, replacing the then-current v${version.restored_over_version}.`)}</p>}{version.expires_at&&<small>{t("有效期：","Expires: ")}{new Date(version.expires_at).toLocaleString()}</small>}{reason&&<p className="wb-hint">{version.version===memory.version?t("这是当前版本。","This is the current version."):message(reason)}</p>}<div className="wb-actions"><button disabled={busy||mutation.pending||resource.loading||!!reason} title={message(reason)} onClick={()=>setSelected(version)}>{t("恢复此版本","Restore This Version")}</button></div></article>;})}</div>
    <div className="wb-actions">{beforeVersion!==undefined&&<button disabled={busy||mutation.pending||resource.loading} onClick={()=>setBeforeVersion(undefined)}>{t("查看最新版本","View Latest Versions")}</button>}{resource.data?.next_before_version!=null&&<button disabled={busy||mutation.pending||resource.loading} onClick={()=>setBeforeVersion(resource.data!.next_before_version!)}>{t("查看更早历史","View Earlier History")}</button>}</div></>}
 </section>;
}
