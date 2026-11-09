import React,{useState} from 'react';
import type {GitBranchInventory,GitCheckoutPreview} from './types';

export default function GitCheckoutEvidence({preview,target,onRetry}:{preview:GitCheckoutPreview;target:GitBranchInventory['branches'][number];onRetry?:()=>void}){
 const [page,setPage]=useState(0),[attributePage,setAttributePage]=useState(0),worktreeBefore=preview.index_projection?.worktree_before,reference=preview.reference_source;
 return <>
   <dl><dt>目标引用</dt><dd><code>{preview.target_ref}</code></dd><dt>目标提交</dt><dd><code>{preview.target_oid}</code></dd>
    <dt>当前索引 SHA-256</dt><dd><code>{preview.source_index_sha256??'尚无索引文件'}</code></dd>
    {preview.index_projection&&<><dt>预览索引 SHA-256</dt><dd><code>{preview.index_projection.sha256}</code></dd><dt>预览索引条目</dt><dd>{preview.index_projection.entry_count}</dd></>}
   </dl>
   {reference?<section aria-label="引用与配置原状态"><h4>引用与配置原状态</h4>
    <p>元数据凭证 SHA-256 <code>{reference.source_metadata_sha256}</code></p>
    <p>原 HEAD 引用 <code>{reference.source_ref?.ref??'分离 HEAD'}</code> · 目标引用 <code>{reference.target_ref.ref}</code></p>
    <dl>{[
     {name:'HEAD 文件',fact:reference.head_file},{name:'HEAD 日志',fact:reference.head_log},
     ...(reference.source_ref?[{name:'原分支松散引用文件',fact:reference.source_ref.file}]:[]),
     {name:'目标松散引用文件',fact:reference.target_ref.file},{name:'目标引用日志',fact:reference.target_log},
     {name:'打包引用文件',fact:reference.packed_refs},{name:'公共配置文件',fact:reference.configuration.common},
     ...(reference.configuration.worktree_enabled?[{name:'工作区配置文件',fact:reference.configuration.worktree}]:[])
    ].map(({name,fact})=><React.Fragment key={name}><dt>{name}</dt><dd>{fact.sha256===null?'文件尚不存在':<>{fact.size} 字节 · SHA-256 <code>{fact.sha256}</code></>}</dd></React.Fragment>)}</dl>
    <p>日志配置 {{default:'默认',true:'启用',false:'关闭',always:'全部启用'}[reference.log_policy.configuration]} · 有效策略{reference.log_policy.enabled?'启用':'关闭'}。工作区独立配置{reference.configuration.worktree_enabled?'启用':'关闭'}。</p>
    <p>松散引用文件缺失时，逻辑引用仍可能来自打包存储。日志及跟踪写入方案仍需完整审核。</p>
   </section>:<p role="status">此历史预览尚无引用与配置原状态凭证。</p>}
   {target?.worktree_uses?.map(use=><p key={use.worktree+'-'+use.reason} role="status">{use.worktree==='current'?'当前工作区':'其他工作区'}占用 · {{head:'HEAD',rebase:'变基',bisect:'二分查找',update_refs:'待更新引用'}[use.reason]}</p>)}
   <p role="status">{preview.working_tree_check==='passed'?'工作区兼容检查已通过。':'工作区兼容性尚未确认，请核对暂存、未暂存及未跟踪文件和仓库状态。'}</p>
   {preview.index_projection&&<>{preview.index_projection.changes.length?<ul aria-label="切换索引变化">{preview.index_projection.changes.slice(page*50,(page+1)*50).map(change=><li key={change.path}>
    <strong>{change.before===null?'新增':change.after===null?'删除':'修改'}</strong> <code>{change.path}</code>
    <div>原条目 <code>{change.before?change.before.mode+' '+change.before.oid:'无'}</code></div><div>预览条目 <code>{change.after?change.after.mode+' '+change.after.oid:'无'}</code></div>
    {change.before?.blob&&<div>原条目 blob · {change.before.blob.size} 字节 · SHA-256 <code>{change.before.blob.sha256??'摘要待确认'}</code></div>}
    {change.after?.blob&&<div>预览条目 blob · {change.after.blob.size} 字节 · SHA-256 <code>{change.after.blob.sha256??'摘要待确认'}</code></div>}
    {change.after?.worktree_content&&<div>工作区输出 · {change.after.worktree_content.size===null?'大小待确认':change.after.worktree_content.size+' 字节'} · SHA-256 <code>{change.after.worktree_content.sha256??'摘要待确认'}</code>
     {change.after.worktree_content.reason&&<p>{{source_unconfirmed:'原始内容待确认',attribute_source_unconfirmed:'属性来源待确认',filter_policy_required:'过滤器策略待确认',read_failed:'转换读取未完成',output_limit:'输出超过本次预算',deadline:'读取时间预算已到',sparse_policy_required:'稀疏检出策略待确认'}[change.after.worktree_content.reason]}</p>}
     {change.after.worktree_content.attributes?.map(attribute=><span key={attribute.name}> · <code>{attribute.name}</code> = <code>{attribute.value}</code></span>)}
    </div>}
   </li>)}</ul>:<p>索引条目的对象及模式保持一致。</p>}
   {preview.index_projection.changes.length>50&&<nav className="wb-actions" aria-label="索引变化分页"><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><span role="status">第 {page+1} 页，共 {Math.ceil(preview.index_projection.changes.length/50)} 页</span><button type="button" disabled={(page+1)*50>=preview.index_projection.changes.length} onClick={()=>setPage(page+1)}>下一页</button></nav>}
   {preview.index_projection.attributes&&<section aria-label="目标索引属性"><h4>目标索引属性</h4>
    {preview.index_projection.attributes.length?<ul>{preview.index_projection.attributes.slice(attributePage*50,(attributePage+1)*50).map(attribute=><li key={attribute.path+'\0'+attribute.name}><code>{attribute.path}</code> · <code>{attribute.name}</code> · <code>{attribute.value}</code></li>)}</ul>:<p>目标索引返回的属性条目为空。</p>}
    {preview.index_projection.attributes.length>50&&<nav className="wb-actions" aria-label="目标属性分页"><button type="button" disabled={attributePage===0} onClick={()=>setAttributePage(attributePage-1)}>上一页</button><span role="status">第 {attributePage+1} 页，共 {Math.ceil(preview.index_projection.attributes.length/50)} 页</span><button type="button" disabled={(attributePage+1)*50>=preview.index_projection.attributes.length} onClick={()=>setAttributePage(attributePage+1)}>下一页</button></nav>}
   </section>}
   </>}
   {worktreeBefore===null&&<div role="status"><p>工作区原状态尚未确认。</p>{onRetry&&<button type="button" onClick={onRetry}>重新读取工作区状态</button>}</div>}
   {worktreeBefore&&<section aria-label="工作区变更前状态"><h4>工作区变更前状态</h4><p>凭证 SHA-256 <code>{worktreeBefore.sha256}</code></p>
    <ul>{worktreeBefore.entries.slice(page*50,(page+1)*50).map(entry=><li key={entry.path}>
     <code>{entry.path}</code> · {{missing:'不存在',blocked:'父路径阻挡',file:'文件',directory:'目录',symlink:'符号链接',other:'特殊文件'}[entry.kind]} · 节点大小 {entry.size} 字节 · 模式 <code>{entry.mode.toString(8).padStart(4,'0')}</code>
     {entry.blocked_by&&<p>阻挡路径 <code>{entry.blocked_by}</code></p>}
     {(entry.kind==='file'||entry.kind==='symlink')&&<p>内容 SHA-256 <code>{entry.sha256??'摘要待确认'}</code></p>}
    </li>)}</ul><p>此列表与索引变化按同一页码显示。目录内容和实际发布效果仍需完整审核。</p>
   </section>}
   {preview.index_projection?.worktree_attribute_before&&<p>工作区后备属性凭证 SHA-256 <code>{preview.index_projection.worktree_attribute_before.sha256}</code></p>}
   {onRetry&&preview.index_projection?.changes.some(change=>change.after?.worktree_content?.sha256===null)&&<button type="button" onClick={onRetry}>重新读取工作区输出摘要</button>}
   <p>blob 摘要对应 Git 原始内容，工作区输出摘要对应本次转换结果。文件发布、引用、日志和跟踪策略仍需完整审核。</p>
 </>;
}
