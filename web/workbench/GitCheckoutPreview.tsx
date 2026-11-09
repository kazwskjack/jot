import React,{useLayoutEffect,useRef,useState} from 'react';
import {workbenchApi} from './client';
import {useResource} from './useResource';
import {ResourceStatus} from './PanelStatus';

export default function GitCheckoutPreview({project,snapshotId,targetRef,onClose}:{project:string;snapshotId:string;targetRef:string;onClose:()=>void}){
 const heading=useRef<HTMLHeadingElement>(null),[page,setPage]=useState(0),[attributePage,setAttributePage]=useState(0);
 useLayoutEffect(()=>{heading.current?.focus()},[]);
 const resource=useResource(async signal=>{
  const value=await workbenchApi.gitBranches(project,snapshotId,signal,targetRef),preview=value.checkout_preview;
  const target=value.branches.find(branch=>branch.ref===targetRef);
  if(value.project_id!==project||value.snapshot_id!==snapshotId||value.read_only!==true||value.execution_authorized!==false
   ||!preview||preview.target_ref!==targetRef||preview.execution_authorized!==false||preview.target_oid!==target?.checkout_oid)throw Error('GIT_CHECKOUT_PREVIEW_SCOPE_CHANGED');
  return {preview,target};
 },JSON.stringify(['git-checkout-preview',project,snapshotId,targetRef]));
 const state=!resource.loading&&!resource.error&&resource.data?.preview.target_ref===targetRef?resource.data:null;
 const error=['GIT_SNAPSHOT_CHANGED','GIT_REPOSITORY_CHANGED','GIT_CHECKOUT_TARGET_UNAVAILABLE'].includes(resource.error)?'仓库或目标已变化，请刷新仓库后重新选择分支。':['GIT_OUTPUT_LIMIT','GIT_ENTRY_LIMIT','GIT_METADATA_LIMIT'].includes(resource.error)?'预览内容或条目超过读取范围，请核对仓库。':resource.error?'暂时无法读取切换预览，请重试。':'';
 const retry=()=>{heading.current?.focus();setPage(0);setAttributePage(0);resource.reload()};
 const worktreeBefore=state?.preview.index_projection?.worktree_before;
 return <section className="wb-form wb-git-review" aria-label="Git 分支切换影响预览">
  <div className="wb-toolbar"><h3 ref={heading} tabIndex={-1}>分支切换影响</h3><button type="button" onClick={onClose}>关闭切换预览</button></div>
  <ResourceStatus loading={resource.loading} error={error} onRetry={retry}/>
  {state&&<>
   <dl><dt>目标引用</dt><dd><code>{state.preview.target_ref}</code></dd><dt>目标提交</dt><dd><code>{state.preview.target_oid}</code></dd>
    <dt>当前索引 SHA-256</dt><dd><code>{state.preview.source_index_sha256??'尚无索引文件'}</code></dd>
    {state.preview.index_projection&&<><dt>预览索引 SHA-256</dt><dd><code>{state.preview.index_projection.sha256}</code></dd><dt>预览索引条目</dt><dd>{state.preview.index_projection.entry_count}</dd></>}
   </dl>
   {state.target?.worktree_uses?.map(use=><p key={use.worktree+'-'+use.reason} role="status">{use.worktree==='current'?'当前工作区':'其他工作区'}占用 · {{head:'HEAD',rebase:'变基',bisect:'二分查找',update_refs:'待更新引用'}[use.reason]}</p>)}
   <p role="status">{state.preview.working_tree_check==='passed'?'工作区兼容检查已通过。':'工作区兼容性尚未确认，请核对暂存、未暂存及未跟踪文件和仓库状态。'}</p>
   {state.preview.index_projection&&<>{state.preview.index_projection.changes.length?<ul aria-label="切换索引变化">{state.preview.index_projection.changes.slice(page*50,(page+1)*50).map(change=><li key={change.path}>
    <strong>{change.before===null?'新增':change.after===null?'删除':'修改'}</strong> <code>{change.path}</code>
    <div>原条目 <code>{change.before?change.before.mode+' '+change.before.oid:'无'}</code></div><div>预览条目 <code>{change.after?change.after.mode+' '+change.after.oid:'无'}</code></div>
    {change.before?.blob&&<div>原条目 blob · {change.before.blob.size} 字节 · SHA-256 <code>{change.before.blob.sha256??'摘要待确认'}</code></div>}
    {change.after?.blob&&<div>预览条目 blob · {change.after.blob.size} 字节 · SHA-256 <code>{change.after.blob.sha256??'摘要待确认'}</code></div>}
    {change.after?.worktree_content&&<div>工作区输出 · {change.after.worktree_content.size===null?'大小待确认':change.after.worktree_content.size+' 字节'} · SHA-256 <code>{change.after.worktree_content.sha256??'摘要待确认'}</code>
     {change.after.worktree_content.reason&&<p>{{source_unconfirmed:'原始内容待确认',attribute_source_unconfirmed:'属性来源待确认',filter_policy_required:'过滤器策略待确认',read_failed:'转换读取未完成',output_limit:'输出超过本次预算',deadline:'读取时间预算已到',sparse_policy_required:'稀疏检出策略待确认'}[change.after.worktree_content.reason]}</p>}
     {change.after.worktree_content.attributes?.map(attribute=><span key={attribute.name}> · <code>{attribute.name}</code> = <code>{attribute.value}</code></span>)}
    </div>}
   </li>)}</ul>:<p>索引条目的对象及模式保持一致。</p>}
   {state.preview.index_projection.changes.length>50&&<nav className="wb-actions" aria-label="索引变化分页"><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><span role="status">第 {page+1} 页，共 {Math.ceil(state.preview.index_projection.changes.length/50)} 页</span><button type="button" disabled={(page+1)*50>=state.preview.index_projection.changes.length} onClick={()=>setPage(page+1)}>下一页</button></nav>}
   {state.preview.index_projection.attributes&&<section aria-label="目标索引属性"><h4>目标索引属性</h4>
    {state.preview.index_projection.attributes.length?<ul>{state.preview.index_projection.attributes.slice(attributePage*50,(attributePage+1)*50).map(attribute=><li key={attribute.path+'\0'+attribute.name}><code>{attribute.path}</code> · <code>{attribute.name}</code> · <code>{attribute.value}</code></li>)}</ul>:<p>目标索引返回的属性条目为空。</p>}
    {state.preview.index_projection.attributes.length>50&&<nav className="wb-actions" aria-label="目标属性分页"><button type="button" disabled={attributePage===0} onClick={()=>setAttributePage(attributePage-1)}>上一页</button><span role="status">第 {attributePage+1} 页，共 {Math.ceil(state.preview.index_projection.attributes.length/50)} 页</span><button type="button" disabled={(attributePage+1)*50>=state.preview.index_projection.attributes.length} onClick={()=>setAttributePage(attributePage+1)}>下一页</button></nav>}
   </section>}
   </>}
   {worktreeBefore===null&&<div role="status"><p>工作区原状态尚未确认，请重试预览。</p><button type="button" onClick={retry}>重新读取工作区状态</button></div>}
   {worktreeBefore&&<section aria-label="工作区变更前状态"><h4>工作区变更前状态</h4><p>凭证 SHA-256 <code>{worktreeBefore.sha256}</code></p>
    <ul>{worktreeBefore.entries.slice(page*50,(page+1)*50).map(entry=><li key={entry.path}>
     <code>{entry.path}</code> · {{missing:'不存在',blocked:'父路径阻挡',file:'文件',directory:'目录',symlink:'符号链接',other:'特殊文件'}[entry.kind]} · 节点大小 {entry.size} 字节 · 模式 <code>{entry.mode.toString(8).padStart(4,'0')}</code>
     {entry.blocked_by&&<p>阻挡路径 <code>{entry.blocked_by}</code></p>}
     {(entry.kind==='file'||entry.kind==='symlink')&&<p>内容 SHA-256 <code>{entry.sha256??'摘要待确认'}</code></p>}
    </li>)}</ul><p>此列表与索引变化按同一页码显示。目录内容和实际发布效果仍需完整审核。</p>
   </section>}
   {state.preview.index_projection?.worktree_attribute_before&&<p>工作区后备属性凭证 SHA-256 <code>{state.preview.index_projection.worktree_attribute_before.sha256}</code></p>}
   {state.preview.index_projection?.changes.some(change=>change.after?.worktree_content?.sha256===null)&&<button type="button" onClick={retry}>重新读取工作区输出摘要</button>}
   <p>blob 摘要对应 Git 原始内容，工作区输出摘要对应本次转换结果。文件发布、引用、日志和跟踪策略仍需完整审核。</p>
  </>}
 </section>;
}
