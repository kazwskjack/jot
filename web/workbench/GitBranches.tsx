import React,{useLayoutEffect,useRef,useState} from 'react';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './PanelStatus';
import GitBranchReview from './GitBranchReview';
import GitCheckoutPreview from './GitCheckoutPreview';

export default function GitBranches({project,snapshotId,locked,onRefresh,onBusy,allowCreate=false,identityReady=false}:{project:string;snapshotId:string;locked:boolean;onRefresh:()=>void;onBusy:(busy:boolean)=>void;allowCreate?:boolean;identityReady?:boolean}){
 const [opened,setOpened]=useState(false),[creating,setCreating]=useState(false),[restoreFocus,setRestoreFocus]=useState(false),opener=useRef<HTMLButtonElement>(null);
 const [preview,setPreview]=useState<{project:string;snapshot:string;ref:string}|null>(null),previewOpener=useRef<HTMLButtonElement|null>(null);
 const previewRef=preview?.project===project&&preview.snapshot===snapshotId?preview.ref:null;
 useLayoutEffect(()=>{if(!creating&&restoreFocus){opener.current?.focus();setRestoreFocus(false)}},[creating,restoreFocus]);
 const inventory=useResource(async signal=>{
  const value=await workbenchApi.gitBranches(project,snapshotId,signal);
  if(value.project_id!==project||value.snapshot_id!==snapshotId||value.read_only!==true||value.execution_authorized!==false)throw Error('GIT_BRANCH_SCOPE_CHANGED');
  return value;
 },JSON.stringify(['git-branches',project,snapshotId]),opened);
 const state=!inventory.loading&&!inventory.error&&inventory.data?.project_id===project&&inventory.data.snapshot_id===snapshotId?inventory.data:null;
 const error=inventory.error==='GIT_SNAPSHOT_CHANGED'?'仓库已变化，请刷新仓库后重新展开分支。':inventory.error==='GIT_REFERENCE_BACKEND_UNSUPPORTED'?'仓库引用存储格式暂不支持，请核对仓库配置。':inventory.error==='GIT_ENTRY_LIMIT'?'分支数量超过读取范围，请核对仓库。':inventory.error?'暂时无法读取分支，请刷新仓库后重试。':'';
 return <section className="wb-git-branches" aria-label="Git 分支列表">
  <button type="button" disabled={locked} aria-expanded={opened} onClick={()=>setOpened(value=>!value)}>分支列表</button>
  {opened&&<>
   <ResourceStatus loading={inventory.loading} error={error} onRetry={onRefresh}/>
   {state&&<>{!creating&&<button ref={opener} type="button" disabled={locked||!identityReady} onClick={()=>setCreating(true)}>创建分支</button>}{!identityReady&&<p role="status">创建分支审核需要配置操作者日志身份。</p>}{!state.branches.length?<p role="status">尚无已提交的分支引用。{state.head.detached?'当前处于分离 HEAD。':<>当前分支 <code>{state.head.branch??'未命名'}</code>。</>}</p>:<ul aria-label="本地与远端分支">{state.branches.map(branch=><li key={branch.ref}>
    <span className="wb-badge">{branch.kind==='local'?'本地':'远端'}</span>{branch.current&&<strong>当前</strong>}
    <code>{branch.ref}</code><code>{branch.oid}</code>
    {branch.symbolic_target&&<span>指向 <code>{branch.symbolic_target}</code></span>}
    {branch.object_type!=='commit'&&<span>对象类型 {branch.object_type}</span>}
    {branch.worktree_uses?.map(use=><span key={use.worktree+'-'+use.reason}>{use.worktree==='current'?'当前工作区':'其他工作区'}占用 · {{head:'HEAD',rebase:'变基',bisect:'二分查找',update_refs:'待更新引用'}[use.reason]}</span>)}
    {branch.checkout_oid===null&&<span>目标无法解析为提交</span>}
    {branch.checkout_oid&&branch.checkout_oid!==branch.oid&&<span>切换目标提交 <code>{branch.checkout_oid}</code></span>}
    <button type="button" disabled={locked||!branch.checkout_oid} onClick={event=>{previewOpener.current=event.currentTarget;setPreview({project,snapshot:snapshotId,ref:branch.ref})}} aria-label={'查看分支切换影响 '+branch.ref}>查看切换影响</button>
   </li>)}</ul>}</>}
   {previewRef&&<GitCheckoutPreview key={JSON.stringify([project,snapshotId,previewRef])} project={project} snapshotId={snapshotId} targetRef={previewRef} onBusy={onBusy} onClose={()=>{setPreview(null);previewOpener.current?.focus()}}/>}
   {state&&creating&&<GitBranchReview project={project} snapshotId={snapshotId} allowExecution={allowCreate} onBusy={onBusy} onChanged={status=>{if(status.execution.state==='applied'&&status.workspace_state==='released_settled')onRefresh()}} onClose={()=>{setCreating(false);setRestoreFocus(true)}}/>}
  </>}
 </section>;
}
