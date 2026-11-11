import {useApplicationLanguage} from '../jot/application-language';
import {gitUiMessage} from './git-ui-messages';
import React,{useLayoutEffect,useRef,useState,useContext} from 'react';
import type {Caps,GitEntry} from './types';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './PanelStatus';
import GitReview,{type GitReviewDraft} from './GitReview';
import GitHistory from './GitHistory';
import GitBranches from './GitBranches';
import GitInitializationReview from './GitInitializationReview';
import GitPendingRequests from './GitPendingRequests';
import {MutationPendingState} from './useMutationReceipt';

function message(code:string){
 const messages:Record<string,string>={GIT_SNAPSHOT_CHANGED:'文件已变化，请刷新仓库。',GIT_REPOSITORY_CHANGED:'仓库位置已变化，请重新核对绑定。',GIT_REPOSITORY_UNCONFIGURED:'此项目尚未绑定仓库。',GIT_PATH_UNAVAILABLE:'此文件无法预览。',GIT_OUTPUT_LIMIT:'差异超过读取范围，请缩小变更后重试。',GIT_ENTRY_LIMIT:'变更文件过多，暂时无法完整展示。',GIT_METADATA_LIMIT:'仓库超过当前读取范围。',GIT_REFERENCE_BACKEND_UNSUPPORTED:'仓库引用存储格式暂不支持，请核对仓库配置。',GIT_READ_TIMEOUT:'读取超时，请重试。',PROJECT_NOT_FOUND:'项目已不可用，请刷新页面。'};
 return code?Object.hasOwn(messages,code)?messages[code]!:'暂时无法读取仓库，请检查配置后重试。':'';
}
const label=(value:string)=>({M:'修改',A:'新增',D:'删除',R:'重命名',C:'复制',U:'冲突','?':'未跟踪',T:'类型变化'} as Record<string,string>)[value]??value;

export default function GitPanel({caps}:{caps:Caps}){
 const language=useApplicationLanguage(),uiMessage=(value:string)=>gitUiMessage(value,language);
 const configured=caps.git_workbench?.configured_projects??[],projects=useResource(workbenchApi.projects,'git-projects',configured.length>0);
 const [selected,setSelected]=useState(''),[selection,setSelection]=useState<{project:string;snapshot:string;path:string;stage:'working'|'staged'}>();
 const [draft,setDraft]=useState<GitReviewDraft|null>(null),[initializing,setInitializing]=useState(false),[reviewBusy,setReviewBusy]=useState(false),[recoveryPending,setRecoveryPending]=useState(false),pending=useContext(MutationPendingState),locked=pending||reviewBusy||recoveryPending;
 const reviewPanel=useRef<HTMLElement|null>(null),reviewOpener=useRef<'change'|'commit'|'initialization'|null>(null),[restoreReviewFocus,setRestoreReviewFocus]=useState(false);
 useLayoutEffect(()=>{if(!draft&&!initializing&&restoreReviewFocus){(reviewPanel.current?.querySelector<HTMLElement>(`[data-review-opener="${reviewOpener.current}"]`)??reviewPanel.current?.querySelector<HTMLElement>('h2'))?.focus();setRestoreReviewFocus(false);}},[draft,initializing,restoreReviewFocus]);
 const closeReview=()=>{setRestoreReviewFocus(true);setDraft(null);};
 const available=projects.data?.items.filter(project=>configured.includes(project.project_id))??[],project=available.some(value=>value.project_id===selected)?selected:available[0]?.project_id??'';
 const commitAllowed=caps.git_workbench?.read_only===false&&caps.git_workbench.commit_projects?.includes(project)===true;
 const branchAllowed=caps.git_workbench?.read_only===false&&caps.git_workbench.branch_projects?.includes(project)===true;
 const initializationAllowed=caps.git_workbench?.read_only===false&&caps.git_workbench.initialization_projects?.includes(project)===true;
 const reinitializationAllowed=caps.git_workbench?.read_only===false&&caps.git_workbench.reinitialization_projects?.includes(project)===true;
 const initialization=useResource(async signal=>{
  const value=await workbenchApi.gitInitialization(project,signal);
  if(value.project_id!==project||value.read_only!==true||value.execution_authorized!==false)throw Error('GIT_INITIALIZATION_SCOPE_CHANGED');
  return value;
 },'git-initialization:'+project,Boolean(project));
 const presence=!initialization.error&&!initialization.loading&&initialization.data?.project_id===project?initialization.data:null;
 const snapshot=useResource(signal=>workbenchApi.git(project,signal),'git-snapshot:'+project,Boolean(project)&&presence?.git_present===true),state=presence?.git_present===true&&!snapshot.error&&!snapshot.loading&&snapshot.data?.project_id===project?snapshot.data:null;
 const active=selection?.project===project&&state?.snapshot_id===selection.snapshot?selection:undefined;
 const diff=useResource(signal=>workbenchApi.gitDiff(active!.project,active!.snapshot,active!.path,active!.stage,signal),'git-diff:'+JSON.stringify(active??null),Boolean(active));
 const patch=!diff.error&&!diff.loading&&active&&diff.data?.project_id===project&&diff.data.snapshot_id===active.snapshot&&diff.data.path===active.path&&diff.data.stage===active.stage?diff.data:null;
 const refresh=()=>{setDraft(null);setInitializing(false);setSelection(undefined);initialization.reload();snapshot.reload();};
 const initialized=()=>{reviewOpener.current='initialization';setRestoreReviewFocus(true);refresh();};
 const rows=(stage:'working'|'staged')=>(state?.entries??[]).filter(entry=>stage==='staged'?entry.index_status!==' '&&entry.index_status!=='?':entry.worktree_status!==' ');
 const row=(entry:GitEntry,stage:'working'|'staged')=><li key={entry.path}><button type="button" disabled={locked||!['file','missing'].includes(entry.kind)} aria-label={uiMessage(stage==='staged'?'查看暂存区差异：':'查看工作区差异：')+entry.path} aria-pressed={active?.path===entry.path&&active.stage===stage} onClick={()=>{setDraft(null);setSelection({project,snapshot:state!.snapshot_id,path:entry.path,stage});}}><code>{entry.original_path?entry.original_path+' → ':''}{entry.path}</code><span className="wb-badge">{entry.conflicted?uiMessage('冲突'):uiMessage(label(stage==='staged'?entry.index_status:entry.worktree_status))}</span></button></li>;
 return <section lang={language} ref={reviewPanel} className="wb-git" aria-label={uiMessage("Git 工作台")}>
  <h2 tabIndex={-1}>{uiMessage("Git 工作台")}</h2><p className="wb-page-intro">{uiMessage("查看项目的分支与文件变化。")}<span className="wb-badge">{commitAllowed?uiMessage('可审核提交'):caps.git_workbench?.read_only===false?uiMessage('可审核暂存'):uiMessage('只读')}</span></p>
  {!configured.length?<p role="status">{uiMessage("尚未绑定项目仓库，请先完成服务端配置。")}</p>:<>
   <ResourceStatus {...projects} onRetry={projects.reload}/><div className="wb-toolbar"><label>{uiMessage("项目仓库")}<select aria-label={uiMessage("项目仓库")} disabled={locked} value={project} onChange={event=>{setDraft(null);setInitializing(false);setSelection(undefined);setSelected(event.target.value);}}>{available.map(value=><option key={value.project_id} value={value.project_id}>{value.title}</option>)}</select></label><button type="button" disabled={locked||!project||initialization.loading||snapshot.loading} onClick={refresh}>{uiMessage("刷新仓库")}</button></div>
   {project&&<GitPendingRequests key={'pending:'+project} project={project} allowDispatch={caps.git_workbench?.read_only===false} allowCommitDispatch={commitAllowed} allowBranchDispatch={branchAllowed} allowInitializationDispatch={initializationAllowed} allowReinitializationDispatch={reinitializationAllowed} onInitialized={initialized} onPending={setRecoveryPending}/>}
   {project&&<GitHistory key={project} project={project} locked={reviewBusy} allowDispatch={caps.git_workbench?.read_only===false} allowCommitDispatch={commitAllowed} allowBranchDispatch={branchAllowed} allowInitializationDispatch={initializationAllowed} allowReinitializationDispatch={reinitializationAllowed} onInitialized={initialized} onBusy={setReviewBusy}/>}
   <ResourceStatus loading={initialization.loading} error={uiMessage(message(initialization.error))} onRetry={refresh}/>
   {presence?.git_present===false&&<section aria-label={uiMessage("尚未初始化的仓库")}><p role="status">{uiMessage("此项目尚无 Git 元数据，请选择初始分支与对象格式后生成初始化审核。")}</p>
    {!initializing?<button data-review-opener="initialization" type="button" disabled={locked} onClick={()=>setInitializing(true)}>{uiMessage("审核初始化仓库")}</button>:<GitInitializationReview key={project+':'+presence.snapshot_id} project={project} snapshotId={presence.snapshot_id} blocked={pending||recoveryPending} allowExecution={initializationAllowed} onBusy={setReviewBusy} onInitialized={initialized} onClose={()=>{reviewOpener.current='initialization';setRestoreReviewFocus(true);setInitializing(false)}}/>}
   </section>}
   {presence?.git_present===true&&<ResourceStatus loading={snapshot.loading} error={uiMessage(message(snapshot.error))} onRetry={refresh}/>}
   {state&&<>
    <div className="wb-git-head"><strong>{state.head.branch??(state.head.detached?uiMessage('分离 HEAD'):uiMessage('未命名分支'))}</strong><code>{state.head.oid?.slice(0,12)??uiMessage('尚无提交')}</code></div>
    <section aria-label={uiMessage("已有仓库重新初始化")}>
     {!initializing?<button data-review-opener="initialization" type="button" disabled={locked} onClick={()=>{reviewOpener.current='initialization';setInitializing(true)}}>{uiMessage("审核重新初始化仓库")}</button>:<GitInitializationReview key={project+':reinit:'+state.snapshot_id} project={project} snapshotId={state.snapshot_id} reinitializing initialBranch={state.head.branch??''} initialObjectFormat={state.head.oid?.length===64?'sha256':state.head.oid?.length===40?'sha1':''} blocked={pending||recoveryPending} allowExecution={initializationAllowed} allowReinitializationExecution={reinitializationAllowed} onBusy={setReviewBusy} onInitialized={initialized} onClose={()=>{reviewOpener.current='initialization';setRestoreReviewFocus(true);setInitializing(false)}}/>}
    </section>
    <GitBranches key={project+':'+state.snapshot_id} project={project} snapshotId={state.snapshot_id} locked={locked} onRefresh={refresh} onBusy={setReviewBusy} allowCreate={branchAllowed} identityReady={state.commit_identity_ready===true}/>
    {state.remotes.length>0&&<p className="wb-hint">{state.remotes.map(remote=>remote.name+' · '+(remote.host??(remote.kind==='local'?uiMessage('本地'):uiMessage('其他远端')))).join(' / ')}</p>}
    {!state.entries.length&&<p role="status">{uiMessage("工作区没有可展示的变更。")}</p>}{state.omitted_count>0&&<p className="wb-hint">{state.omitted_count}{uiMessage(" 个受保护路径未展示。")}</p>}
    <div className="wb-git-files"><div><h3>{uiMessage("暂存区")}</h3>{rows('staged').length?<ul>{rows('staged').map(entry=>row(entry,'staged'))}</ul>:<p className="wb-hint">{uiMessage("没有暂存变更。")}</p>}</div><div><h3>{uiMessage("工作区")}</h3>{rows('working').length?<ul>{rows('working').map(entry=>row(entry,'working'))}</ul>:<p className="wb-hint">{uiMessage("没有未暂存变更。")}</p>}</div></div>
    {diff.loading&&<p role="status">{uiMessage("正在读取差异…")}</p>}{active&&diff.error&&<p role="alert" className="wb-error">{uiMessage(message(diff.error))}</p>}
    {patch&&(patch.kind==='binary'?<p role="status">{uiMessage("二进制文件，暂无文本差异。")}</p>:patch.patch?<pre aria-label={uiMessage("Git 差异")}>{patch.patch}</pre>:<p role="status">{uiMessage("这部分没有内容变化。")}</p>)}
    {patch&&active&&!draft&&!state.entries.find(entry=>entry.path===active.path)?.conflicted&&<button data-review-opener="change" type="button" disabled={locked} onClick={()=>{reviewOpener.current='change';const entry=state.entries.find(value=>value.path===active.path)!;const actions:GitReviewDraft['actions']=active.stage==='staged'?['unstage']:entry.index_status==='?'?['stage','delete-untracked']:['stage','discard'];setDraft({project,snapshot:state.snapshot_id,paths:[active.path],action:actions[0]!,actions});}}>{uiMessage("审核此变更")}</button>}
    {state.commit_identity_ready===false&&<p role="status">{uiMessage("提交审核需要操作者在项目仓库绑定中配置作者与提交者身份。")}</p>}
    {rows('staged').length>5000&&<p role="status">{uiMessage("当前暂存文件超过单次审核的5000个文件范围，请调整暂存范围后生成审核。")}</p>}
    {state.commit_identity_ready===true&&!commitAllowed&&<p role="status">{uiMessage("提交派发需要匹配的原生连接、操作者身份和提交存储版本。")}</p>}
    {!draft&&rows('staged').length>0&&<button data-review-opener="commit" type="button" disabled={locked||state.commit_identity_ready===false||state.omitted_count>0||rows('staged').length>5000||rows('staged').some(entry=>entry.conflicted)} onClick={()=>{reviewOpener.current='commit';setDraft({project,snapshot:state.snapshot_id,paths:rows('staged').map(entry=>entry.path),action:'commit',actions:['commit']});}}>{uiMessage("审核提交")}</button>}
    {draft&&draft.project===project&&draft.snapshot===state.snapshot_id&&<GitReview key={JSON.stringify(draft)} draft={draft} onClose={closeReview} onBusy={setReviewBusy} allowIndexExecution={caps.git_workbench?.read_only===false&&caps.git_workbench.index_actions.includes(draft.action as 'stage'|'unstage')} allowCommitExecution={commitAllowed&&state.commit_identity_ready===true}/>}
   </>}
  </>}
 </section>;
}
