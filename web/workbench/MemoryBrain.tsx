import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {memoryUiMessage} from './memory-ui-messages';
import React,{useRef,useState} from 'react';
import type {BrainPublication} from '../../packages/gateway/contracts/types';
import {workbenchApi,pathId} from './client';
import {memoryQuery} from './memory-form.mjs';
import {useResource} from './useResource';
import {useMutationReceipt} from './useMutationReceipt';
import {ResourceStatus,Empty} from './AgentsPanel';

type Command={path:string;body:unknown};
export default function MemoryBrain({workspace,project,onClose}:{workspace:string;project:string;onClose:()=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>memoryUiMessage(value,language);
 const states={proposed:t('待审核','Awaiting Review'),applied:t('已发布','Published'),rejected:t('已拒绝','Rejected')};
 const identity=JSON.stringify([workspace,project]),base=`/workspaces/${pathId(workspace)}/brain-publications`;
 const [selected,setSelected]=useState<string|null>(null),[before,setBefore]=useState<string|undefined>(),[ids,setIds]=useState<string[]>([]);
 const [page,setPage]=useState('project-decisions'),[title,setTitle]=useState('项目决策'),[summary,setSummary]=useState('发布经审核的项目决策');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirm,setConfirm]=useState<'apply'|'reject'|null>(null);
 const query=memoryQuery({scope:'project',project_id:project,agent_id:'',lifecycle:true,include_expired:false});
 const sources=useResource(signal=>workbenchApi.memories(workspace,query,signal),identity);
 const list=useResource(signal=>workbenchApi.brainPublications(workspace,project,before,signal),identity+before);
 const detail=useResource(signal=>workbenchApi.brainPublication(workspace,selected!,signal),identity+selected,!!selected);
 const value=detail.data?.publication_id===selected&&detail.data.workspace_id===workspace&&detail.data.project_id===project?detail.data:null;
 const mutation=useMutationReceipt(),command=useRef<Command|null>(null),running=useRef(false),blocked=busy||mutation.pending;
 const execute=async(next?:Command)=>{
  if(running.current)return;running.current=true;setBusy(true);setError('');
  try{
   if(!mutation.pending){if(!next)throw Error('原发布请求不可用。');command.current=next;}
   if(!command.current)throw Error('原发布请求不可用。');
   const result=await mutation.submit(command.current.path,'POST',command.current.body) as BrainPublication;
   if(result.workspace_id!==workspace||result.project_id!==project||!result.publication_id)throw Error('发布回执范围不一致，请刷新列表核对。');
   command.current=null;setConfirm(null);setSelected(result.publication_id);list.reload();detail.reload();sources.reload();
  }catch(reason){setError(reason instanceof Error?reason.message:'发布操作未完成');}
  finally{running.current=false;setBusy(false);}
 };
 const sourceItems=sources.data?.items.filter(memory=>memory.scope==='project'&&memory.project_id===project&&memory.status==='active'&&!memory.expired)??[];
 return <section lang={language} aria-label={t("Brain项目发布","Brain Project Publication")}>
  <div className="wb-toolbar"><div><h3>{t("项目决策发布到 Brain","Publish Project Decisions to Brain")}</h3><p>{t("选择项目记忆，生成页面变更预览，审核后写入项目文件。Brain 页面供按需读取，原记忆继续保存在原库。","Select project memories to generate a page change preview, then review before writing project files. Brain pages are read on demand; original memories remain in the original store.")}</p></div><button disabled={blocked} onClick={onClose}>{t("返回记忆","Back to Memory")}</button></div>
  {error&&<p role="alert" className="wb-error">{message(error)}</p>}
  {mutation.pending&&<div role="alert"><p>{t("上次请求结果尚未确认，重试沿用原请求。","The previous request result is unconfirmed. Retrying reuses the original request.")}</p><button disabled={busy} onClick={()=>void execute()}>{t("重试原操作","Retry Original Operation")}</button></div>}
  {!selected?<>
   <form className="wb-form" onSubmit={event=>{event.preventDefault();void execute({path:base+'/preview',body:{project_id:project,page_id:page,title,summary,memory_ids:ids}});}}>
    <fieldset disabled={blocked}><legend>{t("生成发布预览","Generate Publication Preview")}</legend>
     <label>{t("页面 ID","Page ID")}<input required maxLength={80} pattern={'[a-z0-9][a-z0-9\\-]*'} value={page} onChange={event=>setPage(event.target.value)}/></label>
     <label>{t("新页面标题","New Page Title")}<input required maxLength={200} value={title} onChange={event=>setTitle(event.target.value)}/></label>
     <p>{t("页面已存在时保留其标题，更新正文并追加决策时间线。","Existing pages retain their title; the body is updated and the decision timeline extended.")}</p>
     <label>{t("本次发布说明","Publication Summary")}<input required maxLength={1000} value={summary} onChange={event=>setSummary(event.target.value)}/></label>
     <ResourceStatus {...sources} error={message(sources.error)} onRetry={sources.reload}/>
     <div className="wb-message-list">{sourceItems.map(memory=><label key={memory.memory_id} className="wb-checkbox"><input type="checkbox" checked={ids.includes(memory.memory_id)} disabled={!ids.includes(memory.memory_id)&&ids.length>=10} onChange={event=>setIds(previous=>event.target.checked?[...previous,memory.memory_id]:previous.filter(id=>id!==memory.memory_id))}/><span>{memory.content}<small>{t(" · 版本 "," · Version ")}{memory.version} · {memory.verified?t("原记忆已核实","Original Memory Verified"):t("原记忆待核实","Original Memory Unverified")}</small></span></label>)}</div>
     {!sources.loading&&!sources.error&&!sourceItems.length&&<Empty>{t("当前项目没有可发布的有效项目记忆。","This project has no valid project memories available for publication.")}</Empty>}
     <p>{t("每次选择 1 至 10 条，总正文最多 20,000 字符。审核预览同时列出页面、索引和所需的 Brain 初始化文件。","Select 1 to 10 memories, up to 20,000 body characters in total. The review preview lists the page, index and required Brain initialization files.")}</p>
     <button className="wb-primary" disabled={!ids.length||sources.loading||!!sources.error} type="submit">{t("生成可审核预览","Generate Preview for Review")}</button>
    </fieldset>
   </form>
   <h4>{t("发布记录","Publication History")}</h4><button disabled={blocked||list.loading} onClick={list.reload}>{t("刷新记录","Refresh History")}</button><ResourceStatus {...list} error={message(list.error)} onRetry={list.reload}/>
   <div className="wb-message-list">{list.data?.items.map(item=><article key={item.publication_id}><strong>{item.title} · {states[item.status]}</strong><p>{item.page_id}</p><button disabled={blocked} onClick={()=>{setSelected(item.publication_id);setConfirm(null);}}>{t("查看发布预览与回执","View Publication Preview and Receipt")}</button></article>)}</div>
   {before&&<button disabled={blocked} onClick={()=>setBefore(undefined)}>{t("查看最新记录","View Latest History")}</button>}{list.data?.next_before_id&&<button disabled={blocked} onClick={()=>setBefore(list.data!.next_before_id!)}>{t("查看更早记录","View Earlier History")}</button>}
  </>:<>
   <button disabled={blocked} onClick={()=>{setSelected(null);setConfirm(null);}}>{t("返回发布列表","Back to Publication List")}</button><ResourceStatus {...detail} error={message(detail.error)} onRetry={detail.reload}/>
   {value&&<><h4>{value.title} · {states[value.status]}</h4><p>{value.summary}</p><p>{t("Brain 目录 ","Brain Directory ")}{value.brain_root}</p>
    {value.status==='proposed'&&!value.current&&<p role="alert">{t("来源或项目文件已变化，请拒绝旧预览并重新生成。","Sources or project files changed. Reject the old preview and generate a new one.")}</p>}
    {value.sources.map(source=><article key={source.memory_id}><small>{source.memory_id}{t(" · 版本 "," · Version ")}{source.version} · {source.verified?t("原记忆已核实","Original Memory Verified"):t("原记忆待核实","Original Memory Unverified")}</small><p style={{whiteSpace:'pre-wrap'}}>{source.content??t("原来源已变化，历史正文已隐藏。","The original source changed. Historical body content is hidden.")}</p></article>)}
    {value.files.map(file=><details key={file.path}><summary>{file.path}{t(" · 原版本 "," · Original Version ")}{file.expected_version}</summary><h5>{t("发布前","Before Publication")}</h5><pre style={{whiteSpace:'pre-wrap'}}>{file.before_content??t("新文件","New File")}</pre><h5>{t("审核后将发布","To Be Published After Review")}</h5><pre style={{whiteSpace:'pre-wrap'}}>{file.content}</pre></details>)}
    {value.results&&<div className="wb-message-list">{value.results.map(file=><p key={file.path}>{file.path}{t(" · 已保存版本 "," · Saved Version ")}{file.version} · SHA-256 {file.sha256}</p>)}</div>}
    {value.status==='proposed'&&<div className="wb-actions"><button disabled={blocked||!value.current||detail.loading||!!detail.error} onClick={()=>setConfirm('apply')}>{t("审核并发布项目文件","Review and Publish Project Files")}</button><button disabled={blocked} onClick={()=>setConfirm('reject')}>{t("拒绝此预览","Reject This Preview")}</button><button disabled={blocked||detail.loading} onClick={detail.reload}>{t("重新核对来源与目标","Check Sources and Targets Again")}</button></div>}
    {confirm&&<div className="wb-form" role="alertdialog" aria-label={t("Brain发布确认","Confirm Brain Publication")}><p>{confirm==='apply'?t("确认公开到当前项目的 Brain 文件？全部文件会按预览中的原版本一起写入。请先检查每项正文和来源。","Publish to the current project Brain files? All files will be written together against the original versions in the preview. Check every body and source first."):t("拒绝此预览？","Reject this preview?")}</p><button disabled={blocked} onClick={()=>setConfirm(null)}>{t("取消","Cancel")}</button><button disabled={blocked||(confirm==='apply'&&(!value.current||detail.loading||!!detail.error))} onClick={()=>void execute({path:`${base}/${pathId(value.publication_id)}/${confirm}`,body:{expected_version:value.version}})}>{confirm==='apply'?t('确认发布','Confirm Publication'):t('确认拒绝','Confirm Rejection')}</button></div>}
   </>}
  </>}
 </section>;
}
