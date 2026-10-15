import React,{useRef,useState} from 'react';
import type {MemoryConsolidation} from './types';
import {workbenchApi,pathId} from './client';
import {useResource} from './useResource';
import {useMutationReceipt} from './useMutationReceipt';
import {ResourceStatus,Empty} from './AgentsPanel';
import {consolidationCommand,consolidationMatches,consolidationPreview} from './memory-consolidation.mjs';

type Selection={project_id:string;scope:'project'|'private';agent_id:string};
const statuses:Record<string,string>={draft:'正在准备建议',proposed:'待确认',applied:'已应用',rolled_back:'已回滚',rejected:'已拒绝'};
export default function MemoryConsolidations({workspace,selection,onClose,onChanged}:{workspace:string;selection:Selection;onClose:()=>void;onChanged:()=>void}){
 const query='?'+new URLSearchParams({project_id:selection.project_id,scope:selection.scope,...(selection.scope==='private'?{agent_id:selection.agent_id}:{})}).toString();
 const list=useResource(signal=>workbenchApi.memoryConsolidations(workspace,query,signal),workspace+query);
 const [selected,setSelected]=useState<string|null>(null),[confirmation,setConfirmation]=useState<'apply'|'rollback'|'reject'|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const detail=useResource(signal=>workbenchApi.memoryConsolidation(workspace,selected!,signal),workspace+query+selected,!!selected);
 const value=detail.data?.consolidation_id===selected&&consolidationMatches(detail.data,selection)?detail.data:null;
 const mutation=useMutationReceipt(),command=useRef<{path:string;body:{expected_version:number}}|null>(null);
 const commit=async()=>{
  if(!value||!confirmation||busy)return;setBusy(true);setError('');
  try{
   if(!mutation.pending)command.current={path:`/workspaces/${pathId(workspace)}/memory-consolidations/${pathId(value.consolidation_id)}/${confirmation}`,body:consolidationCommand(value,confirmation)};
   if(!command.current)throw new Error('原整理请求不可用，请核对记录。');
   await mutation.submit(command.current.path,'POST',command.current.body);command.current=null;setConfirmation(null);detail.reload();list.reload();onChanged();
  }catch(reason){
   if(reason instanceof Error&&['VERSION_CONFLICT','MEMORY_CONSOLIDATION_SOURCE_CONFLICT','MEMORY_CONSOLIDATION_STATE_CONFLICT'].includes(reason.message)){setConfirmation(null);detail.reload();list.reload();setError('记忆或整理记录已更新，请刷新并重新核对，未覆盖新内容。');}
   else if(command.current&&(!(reason as {status?:number})?.status||Number((reason as {status?:number}).status)>=500))setError('整理结果尚未确认。请留在此页重试原请求，不要新建操作。');
   else setError(reason instanceof Error?reason.message:'整理未完成，请刷新核对。');
  }finally{setBusy(false);}
 };
 const blocked=busy||mutation.pending;
 let preview:ReturnType<typeof consolidationPreview>=[],previewError='';
 if(value)try{preview=consolidationPreview(value);}catch(reason){previewError=reason instanceof Error?reason.message:'建议无效';}
 return <section aria-label="记忆整理记录"><div className="wb-toolbar"><div><h3>记忆整理</h3><p>在角色对话中提出整理记忆后，建议会显示在这里。确认前不会改变正式记忆。</p></div><button disabled={blocked} onClick={onClose}>返回记忆</button></div>
  {error&&<p role="alert" className="wb-error">{error}</p>}
  {!selected?<><ResourceStatus {...list} onRetry={list.reload}/><button disabled={blocked||list.loading} onClick={list.reload}>刷新整理记录</button><div className="wb-message-list">{list.data?.items.filter(item=>consolidationMatches(item,selection)).map(item=><article key={item.consolidation_id}><strong>{statuses[item.status]}</strong><p>{item.summary??'来源已冻结，尚未提交整理建议。'}</p><small>{item.source_count} 条来源 · {item.change_count} 项变更</small><button disabled={blocked} onClick={()=>{setSelected(item.consolidation_id);setError('');}}>查看整理建议</button></article>)}</div>{!list.loading&&!list.error&&!list.data?.items.length&&<Empty>当前范围暂无整理记录。</Empty>}</>
  :<><button disabled={blocked} onClick={()=>{setSelected(null);setConfirmation(null);setError('');}}>返回整理列表</button><ResourceStatus {...detail} onRetry={detail.reload}/>{value&&<><p>状态：{statuses[value.status]} · 记录 v{value.version}</p><h4>{value.proposal?.summary??'尚未提交建议'}</h4><details><summary>查看 {value.sources.length} 条冻结来源</summary>{value.sources.map(source=><article key={source.memory_id}><strong>v{source.version} · {source.memory_id}</strong><p>{source.content}</p>{source.provenance?.map((item,index)=><small key={index}>{item.kind}：{item.reference} </small>)}{source.expires_at&&<small>有效期：{new Date(source.expires_at).toLocaleString()}</small>}</article>)}</details>
   {previewError&&<p role="alert">{previewError}</p>}<div className="wb-message-list">{preview.map(item=><article key={item.memory_id}><strong>{item.action==='rewrite'?'精简改写':'合并重复条目'} · 原 v{item.source_version}</strong><p>整理前：{item.before}</p><p>{item.action==='rewrite'?'整理后：'+item.after:'归入 '+item.replacement_id+'：'+item.replacement_content}</p></article>)}</div>
   {value.proposal&&!preview.length&&<p>没有需要修改的记忆，本次为无变更整理。</p>}
   {confirmation?<div className="wb-form" role="alertdialog" aria-label="确认记忆整理"><h4>{confirmation==='apply'?'确认应用这批整理？':confirmation==='rollback'?'确认安全回滚这批整理？':'拒绝这批整理？'}</h4><p>{confirmation==='reject'?'正式记忆不会改变。':'服务端会重新检查版本与有效期；冲突时整批不改。改写或恢复会生成新版本，标记为待核实。'}</p><div className="wb-actions"><button disabled={blocked} onClick={()=>setConfirmation(null)}>取消</button><button disabled={busy} onClick={()=>void commit()}>{busy?'正在提交…':mutation.pending?'重试原整理请求':'确认'}</button></div></div>
   :<div className="wb-actions">{value.status==='proposed'&&<button disabled={blocked||!!previewError} onClick={()=>setConfirmation('apply')}>应用整理</button>}{value.status==='applied'&&<button disabled={blocked} onClick={()=>setConfirmation('rollback')}>回滚本次整理</button>}{['draft','proposed'].includes(value.status)&&<button disabled={blocked} onClick={()=>setConfirmation('reject')}>拒绝建议</button>}</div>}
  </>}</>}
 </section>;
}
