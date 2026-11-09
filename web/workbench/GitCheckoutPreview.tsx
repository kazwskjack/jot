import React,{useLayoutEffect,useRef} from 'react';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './PanelStatus';

export default function GitCheckoutPreview({project,snapshotId,targetRef,onClose}:{project:string;snapshotId:string;targetRef:string;onClose:()=>void}){
 const heading=useRef<HTMLHeadingElement>(null);
 useLayoutEffect(()=>{heading.current?.focus()},[]);
 const resource=useResource(async signal=>{
  const value=await workbenchApi.gitBranches(project,snapshotId,signal,targetRef),preview=value.checkout_preview;
  const target=value.branches.find(branch=>branch.ref===targetRef);
  if(value.project_id!==project||value.snapshot_id!==snapshotId||value.read_only!==true||value.execution_authorized!==false
   ||!preview||preview.target_ref!==targetRef||preview.execution_authorized!==false||preview.target_oid!==target?.checkout_oid)throw Error('GIT_CHECKOUT_PREVIEW_SCOPE_CHANGED');
  return {preview,target};
 },JSON.stringify(['git-checkout-preview',project,snapshotId,targetRef]));
 const state=!resource.loading&&!resource.error&&resource.data?.preview.target_ref===targetRef?resource.data:null;
 const error=['GIT_SNAPSHOT_CHANGED','GIT_REPOSITORY_CHANGED','GIT_CHECKOUT_TARGET_UNAVAILABLE'].includes(resource.error)?'仓库或目标已变化，请刷新仓库后重新选择分支。':resource.error?'暂时无法读取切换预览，请重试。':'';
 return <section className="wb-form wb-git-review" aria-label="Git 分支切换影响预览">
  <div className="wb-toolbar"><h3 ref={heading} tabIndex={-1}>分支切换影响</h3><button type="button" onClick={onClose}>关闭切换预览</button></div>
  <ResourceStatus loading={resource.loading} error={error} onRetry={resource.reload}/>
  {state&&<>
   <dl><dt>目标引用</dt><dd><code>{state.preview.target_ref}</code></dd><dt>目标提交</dt><dd><code>{state.preview.target_oid}</code></dd>
    <dt>当前索引 SHA-256</dt><dd><code>{state.preview.source_index_sha256??'尚无索引文件'}</code></dd>
    {state.preview.index_projection&&<><dt>预览索引 SHA-256</dt><dd><code>{state.preview.index_projection.sha256}</code></dd><dt>预览索引条目</dt><dd>{state.preview.index_projection.entry_count}</dd></>}
   </dl>
   {state.target?.worktree_uses?.map(use=><p key={use.worktree+'-'+use.reason} role="status">{use.worktree==='current'?'当前工作区':'其他工作区'}占用 · {{head:'HEAD',rebase:'变基',bisect:'二分查找',update_refs:'待更新引用'}[use.reason]}</p>)}
   <p role="status">{state.preview.working_tree_check==='passed'?'工作区兼容检查已通过。':'工作区兼容性尚未确认，请核对暂存、未暂存及未跟踪文件和仓库状态。'}</p>
   {state.preview.index_projection&&<>{state.preview.index_projection.changes.length?<ul aria-label="切换索引变化">{state.preview.index_projection.changes.map(change=><li key={change.path}>
    <strong>{change.before===null?'新增':change.after===null?'删除':'修改'}</strong> <code>{change.path}</code>
    <div>原条目 <code>{change.before?change.before.mode+' '+change.before.oid:'无'}</code></div><div>预览条目 <code>{change.after?change.after.mode+' '+change.after.oid:'无'}</code></div>
   </li>)}</ul>:<p>索引条目的对象及模式保持一致。</p>}</>}
   <p>执行前仍需完成工作区内容、引用、日志和跟踪策略的完整审核。</p>
  </>}
 </section>;
}
