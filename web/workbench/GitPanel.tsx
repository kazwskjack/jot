import React,{useState,useContext} from 'react';
import type {Caps,GitEntry} from './types';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './AgentsPanel';
import GitReview,{type GitReviewDraft} from './GitReview';
import {MutationPendingState} from './useMutationReceipt';

function message(code:string){
 const messages:Record<string,string>={GIT_SNAPSHOT_CHANGED:'文件已变化，请刷新仓库。',GIT_REPOSITORY_CHANGED:'仓库位置已变化，请重新核对绑定。',GIT_REPOSITORY_UNCONFIGURED:'此项目尚未绑定仓库。',GIT_PATH_UNAVAILABLE:'此文件无法预览。',GIT_OUTPUT_LIMIT:'差异超过读取范围，请缩小变更后重试。',GIT_ENTRY_LIMIT:'变更文件过多，暂时无法完整展示。',GIT_METADATA_LIMIT:'仓库超过当前读取范围。',GIT_READ_TIMEOUT:'读取超时，请重试。',PROJECT_NOT_FOUND:'项目已不可用，请刷新页面。'};
 return code?Object.hasOwn(messages,code)?messages[code]!:'暂时无法读取仓库，请检查配置后重试。':'';
}
const label=(value:string)=>({M:'修改',A:'新增',D:'删除',R:'重命名',C:'复制',U:'冲突','?':'未跟踪',T:'类型变化'} as Record<string,string>)[value]??value;

export default function GitPanel({caps}:{caps:Caps}){
 const configured=caps.git_workbench?.configured_projects??[],projects=useResource(workbenchApi.projects,'git-projects',configured.length>0);
 const [selected,setSelected]=useState(''),[selection,setSelection]=useState<{project:string;snapshot:string;path:string;stage:'working'|'staged'}>();
 const [draft,setDraft]=useState<GitReviewDraft|null>(null),[reviewBusy,setReviewBusy]=useState(false),pending=useContext(MutationPendingState),locked=pending||reviewBusy;
 const available=projects.data?.items.filter(project=>configured.includes(project.project_id))??[],project=available.some(value=>value.project_id===selected)?selected:available[0]?.project_id??'';
 const snapshot=useResource(signal=>workbenchApi.git(project,signal),'git-snapshot:'+project,Boolean(project)),state=!snapshot.error&&!snapshot.loading&&snapshot.data?.project_id===project?snapshot.data:null;
 const active=selection?.project===project&&state?.snapshot_id===selection.snapshot?selection:undefined;
 const diff=useResource(signal=>workbenchApi.gitDiff(active!.project,active!.snapshot,active!.path,active!.stage,signal),'git-diff:'+JSON.stringify(active??null),Boolean(active));
 const patch=!diff.error&&!diff.loading&&active&&diff.data?.project_id===project&&diff.data.snapshot_id===active.snapshot&&diff.data.path===active.path&&diff.data.stage===active.stage?diff.data:null;
 const refresh=()=>{setDraft(null);setSelection(undefined);snapshot.reload();};
 const rows=(stage:'working'|'staged')=>(state?.entries??[]).filter(entry=>stage==='staged'?entry.index_status!==' '&&entry.index_status!=='?':entry.worktree_status!==' ');
 const row=(entry:GitEntry,stage:'working'|'staged')=><li key={entry.path}><button type="button" disabled={locked||!['file','missing'].includes(entry.kind)} aria-label={`查看${stage==='staged'?'暂存区':'工作区'}差异：${entry.path}`} aria-pressed={active?.path===entry.path&&active.stage===stage} onClick={()=>{setDraft(null);setSelection({project,snapshot:state!.snapshot_id,path:entry.path,stage});}}><code>{entry.original_path?entry.original_path+' → ':''}{entry.path}</code><span className="wb-badge">{entry.conflicted?'冲突':label(stage==='staged'?entry.index_status:entry.worktree_status)}</span></button></li>;
 return <section className="wb-git" aria-label="Git 工作台">
  <h2>Git 工作台</h2><p className="wb-page-intro">查看项目的分支与文件变化。<span className="wb-badge">只读</span></p>
  {!configured.length?<p role="status">尚未绑定项目仓库，请先完成服务端配置。</p>:<>
   <ResourceStatus {...projects} onRetry={projects.reload}/><div className="wb-toolbar"><label>项目仓库<select aria-label="项目仓库" disabled={locked} value={project} onChange={event=>{setDraft(null);setSelection(undefined);setSelected(event.target.value);}}>{available.map(value=><option key={value.project_id} value={value.project_id}>{value.title}</option>)}</select></label><button type="button" disabled={locked||!project||snapshot.loading} onClick={refresh}>刷新仓库</button></div>
   <ResourceStatus loading={snapshot.loading} error={message(snapshot.error)} onRetry={refresh}/>
   {state&&<>
    <div className="wb-git-head"><strong>{state.head.branch??(state.head.detached?'分离 HEAD':'未命名分支')}</strong><code>{state.head.oid?.slice(0,12)??'尚无提交'}</code></div>
    {state.remotes.length>0&&<p className="wb-hint">{state.remotes.map(remote=>remote.name+' · '+(remote.host??(remote.kind==='local'?'本地':'其他远端'))).join(' / ')}</p>}
    {!state.entries.length&&<p role="status">工作区没有可展示的变更。</p>}{state.omitted_count>0&&<p className="wb-hint">{state.omitted_count} 个受保护路径未展示。</p>}
    <div className="wb-git-files"><div><h3>暂存区</h3>{rows('staged').length?<ul>{rows('staged').map(entry=>row(entry,'staged'))}</ul>:<p className="wb-hint">没有暂存变更。</p>}</div><div><h3>工作区</h3>{rows('working').length?<ul>{rows('working').map(entry=>row(entry,'working'))}</ul>:<p className="wb-hint">没有未暂存变更。</p>}</div></div>
    {diff.loading&&<p role="status">正在读取差异…</p>}{active&&diff.error&&<p role="alert" className="wb-error">{message(diff.error)}</p>}
    {patch&&(patch.kind==='binary'?<p role="status">二进制文件，暂无文本差异。</p>:patch.patch?<pre aria-label="Git 差异">{patch.patch}</pre>:<p role="status">这部分没有内容变化。</p>)}
    {patch&&active&&!draft&&!state.entries.find(entry=>entry.path===active.path)?.conflicted&&<button type="button" disabled={locked} onClick={()=>{const entry=state.entries.find(value=>value.path===active.path)!;const actions:GitReviewDraft['actions']=active.stage==='staged'?['unstage']:entry.index_status==='?'?['stage','delete-untracked']:['stage','discard'];setDraft({project,snapshot:state.snapshot_id,paths:[active.path],action:actions[0]!,actions});}}>审核此变更</button>}
    {!draft&&rows('staged').length>0&&<button type="button" disabled={locked||state.omitted_count>0||rows('staged').some(entry=>entry.conflicted)} onClick={()=>setDraft({project,snapshot:state.snapshot_id,paths:rows('staged').map(entry=>entry.path),action:'commit',actions:['commit']})}>审核提交</button>}
    {draft&&draft.project===project&&draft.snapshot===state.snapshot_id&&<GitReview key={JSON.stringify(draft)} draft={draft} onClose={()=>setDraft(null)} onBusy={setReviewBusy}/>}
   </>}
  </>}
 </section>;
}
