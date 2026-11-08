import React,{useRef,useState} from 'react';
import type {BrainPublication} from '../../packages/gateway/contracts/types';
import {workbenchApi,pathId} from './client';
import {memoryQuery} from './memory-form.mjs';
import {useResource} from './useResource';
import {useMutationReceipt} from './useMutationReceipt';
import {ResourceStatus,Empty} from './AgentsPanel';

type Command={path:string;body:unknown};
const states={proposed:'待审核',applied:'已发布',rejected:'已拒绝'};
export default function MemoryBrain({workspace,project,onClose}:{workspace:string;project:string;onClose:()=>void}){
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
 return <section aria-label="Brain项目发布">
  <div className="wb-toolbar"><div><h3>项目决策发布到 Brain</h3><p>选择项目记忆，生成页面变更预览，审核后写入项目文件。Brain 页面供按需读取，原记忆继续保存在原库。</p></div><button disabled={blocked} onClick={onClose}>返回记忆</button></div>
  {error&&<p role="alert" className="wb-error">{error}</p>}
  {mutation.pending&&<div role="alert"><p>上次请求结果尚未确认，重试沿用原请求。</p><button disabled={busy} onClick={()=>void execute()}>重试原操作</button></div>}
  {!selected?<>
   <form className="wb-form" onSubmit={event=>{event.preventDefault();void execute({path:base+'/preview',body:{project_id:project,page_id:page,title,summary,memory_ids:ids}});}}>
    <fieldset disabled={blocked}><legend>生成发布预览</legend>
     <label>页面 ID<input required maxLength={80} pattern={'[a-z0-9][a-z0-9\\-]*'} value={page} onChange={event=>setPage(event.target.value)}/></label>
     <label>新页面标题<input required maxLength={200} value={title} onChange={event=>setTitle(event.target.value)}/></label>
     <p>页面已存在时保留其标题，更新正文并追加决策时间线。</p>
     <label>本次发布说明<input required maxLength={1000} value={summary} onChange={event=>setSummary(event.target.value)}/></label>
     <ResourceStatus {...sources} onRetry={sources.reload}/>
     <div className="wb-message-list">{sourceItems.map(memory=><label key={memory.memory_id} className="wb-checkbox"><input type="checkbox" checked={ids.includes(memory.memory_id)} disabled={!ids.includes(memory.memory_id)&&ids.length>=10} onChange={event=>setIds(previous=>event.target.checked?[...previous,memory.memory_id]:previous.filter(id=>id!==memory.memory_id))}/><span>{memory.content}<small> · 版本 {memory.version} · {memory.verified?'原记忆已核实':'原记忆待核实'}</small></span></label>)}</div>
     {!sources.loading&&!sources.error&&!sourceItems.length&&<Empty>当前项目没有可发布的有效项目记忆。</Empty>}
     <p>每次选择 1 至 10 条，总正文最多 20,000 字符。审核预览同时列出页面、索引和所需的 Brain 初始化文件。</p>
     <button className="wb-primary" disabled={!ids.length||sources.loading||!!sources.error} type="submit">生成可审核预览</button>
    </fieldset>
   </form>
   <h4>发布记录</h4><button disabled={blocked||list.loading} onClick={list.reload}>刷新记录</button><ResourceStatus {...list} onRetry={list.reload}/>
   <div className="wb-message-list">{list.data?.items.map(item=><article key={item.publication_id}><strong>{item.title} · {states[item.status]}</strong><p>{item.page_id}</p><button disabled={blocked} onClick={()=>{setSelected(item.publication_id);setConfirm(null);}}>查看发布预览与回执</button></article>)}</div>
   {before&&<button disabled={blocked} onClick={()=>setBefore(undefined)}>查看最新记录</button>}{list.data?.next_before_id&&<button disabled={blocked} onClick={()=>setBefore(list.data!.next_before_id!)}>查看更早记录</button>}
  </>:<>
   <button disabled={blocked} onClick={()=>{setSelected(null);setConfirm(null);}}>返回发布列表</button><ResourceStatus {...detail} onRetry={detail.reload}/>
   {value&&<><h4>{value.title} · {states[value.status]}</h4><p>{value.summary}</p><p>Brain 目录 {value.brain_root}</p>
    {value.status==='proposed'&&!value.current&&<p role="alert">来源或项目文件已变化，请拒绝旧预览并重新生成。</p>}
    {value.sources.map(source=><article key={source.memory_id}><small>{source.memory_id} · 版本 {source.version} · {source.verified?'原记忆已核实':'原记忆待核实'}</small><p style={{whiteSpace:'pre-wrap'}}>{source.content??'原来源已变化，历史正文已隐藏。'}</p></article>)}
    {value.files.map(file=><details key={file.path}><summary>{file.path} · 原版本 {file.expected_version}</summary><h5>发布前</h5><pre style={{whiteSpace:'pre-wrap'}}>{file.before_content??'新文件'}</pre><h5>审核后将发布</h5><pre style={{whiteSpace:'pre-wrap'}}>{file.content}</pre></details>)}
    {value.results&&<div className="wb-message-list">{value.results.map(file=><p key={file.path}>{file.path} · 已保存版本 {file.version} · SHA-256 {file.sha256}</p>)}</div>}
    {value.status==='proposed'&&<div className="wb-actions"><button disabled={blocked||!value.current||detail.loading||!!detail.error} onClick={()=>setConfirm('apply')}>审核并发布项目文件</button><button disabled={blocked} onClick={()=>setConfirm('reject')}>拒绝此预览</button><button disabled={blocked||detail.loading} onClick={detail.reload}>重新核对来源与目标</button></div>}
    {confirm&&<div className="wb-form" role="alertdialog" aria-label="Brain发布确认"><p>{confirm==='apply'?'确认公开到当前项目的 Brain 文件？全部文件会按预览中的原版本一起写入。请先检查每项正文和来源。':'拒绝此预览？'}</p><button disabled={blocked} onClick={()=>setConfirm(null)}>取消</button><button disabled={blocked||(confirm==='apply'&&(!value.current||detail.loading||!!detail.error))} onClick={()=>void execute({path:`${base}/${pathId(value.publication_id)}/${confirm}`,body:{expected_version:value.version}})}>确认{confirm==='apply'?'发布':'拒绝'}</button></div>}
   </>}
  </>}
 </section>;
}
