import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {gitUiMessage} from './git-ui-messages';
import React,{useState} from 'react';
import type {GitBranchInventory,GitCheckoutPreview} from './types';

export default function GitCheckoutEvidence({preview,target,onRetry}:{preview:GitCheckoutPreview;target:GitBranchInventory['branches'][number];onRetry?:()=>void}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>gitUiMessage(value,language);
 const [page,setPage]=useState(0),[attributePage,setAttributePage]=useState(0),[layoutPage,setLayoutPage]=useState(0),[directoryPage,setDirectoryPage]=useState(0),[directoryIssuePage,setDirectoryIssuePage]=useState(0),worktreeBefore=preview.index_projection?.worktree_before,reference=preview.reference_source,directories=preview.index_projection?.directories_before;
 return <div lang={language}>
   <dl><dt>{message('目标引用')}</dt><dd><code>{preview.target_ref}</code></dd><dt>{message('目标提交')}</dt><dd><code>{preview.target_oid}</code></dd>
    <dt>{message('当前索引 SHA-256')}</dt><dd><code>{preview.source_index_sha256??message('尚无索引文件')}</code></dd>
    {preview.index_projection&&<><dt>{message('预览索引 SHA-256')}</dt><dd><code>{preview.index_projection.sha256}</code></dd><dt>{message('预览索引条目')}</dt><dd>{preview.index_projection.entry_count}</dd></>}
   </dl>
   {reference?<section aria-label={message('引用与配置原状态')}><h4>{message('引用与配置原状态')}</h4>
    <p>{message('元数据凭证 SHA-256 ')}<code>{reference.source_metadata_sha256}</code></p>
    <p>{message('原 HEAD 引用 ')}<code>{reference.source_ref?.ref??message('分离 HEAD')}</code>{message(' · 目标引用 ')}<code>{reference.target_ref.ref}</code></p>
    <dl>{[
     {name:'HEAD 文件',fact:reference.head_file},{name:'HEAD 日志',fact:reference.head_log},
     ...(reference.source_ref?[{name:'原分支松散引用文件',fact:reference.source_ref.file}]:[]),
     {name:'目标松散引用文件',fact:reference.target_ref.file},{name:'目标引用日志',fact:reference.target_log},
     {name:'打包引用文件',fact:reference.packed_refs},{name:'公共配置文件',fact:reference.configuration.common},
     ...(reference.configuration.worktree_enabled?[{name:'工作区配置文件',fact:reference.configuration.worktree}]:[])
    ].map(({name,fact})=><React.Fragment key={name}><dt>{message(name)}</dt><dd>{fact.sha256===null?message('文件尚不存在'):<>{fact.size}{t(' 字节 · SHA-256 ',' Bytes · SHA-256 ')}<code>{fact.sha256}</code></>}{fact.physical&&<div>{message('节点 ')}<code>{fact.physical.identity}</code>{message(' · 模式 ')}<code>{fact.physical.mode.toString(8).padStart(4,'0')}</code> · UID {fact.physical.uid} · GID {fact.physical.gid}</div>}</dd></React.Fragment>)}</dl>
    {reference.layout?<section aria-label={message('元数据目录凭证')}><h5>{message('元数据目录凭证')}</h5>
     <ul>{[{name:'项目根目录',fact:reference.layout.root},{name:'当前 Git 目录',fact:reference.layout.git},{name:'公共 Git 目录',fact:reference.layout.common}].map(({name,fact})=><li key={name}>{message(name)}{t(' · 节点 ',' · Node ')}<code>{fact.identity}</code>{message(' · 模式 ')}<code>{fact.mode.toString(8).padStart(4,'0')}</code> · UID {fact.uid} · GID {fact.gid}<div>{message('状态 SHA-256 ')}<code>{fact.stat_sha256}</code></div></li>)}</ul>
     <ul aria-label={message('元数据父目录')}>{reference.layout.parents.slice(layoutPage*50,(layoutPage+1)*50).map(parent=><li key={parent.scope+'\0'+parent.path}>{message(parent.scope==='git'?'当前 Git 目录':'公共 Git 目录')} · <code>{parent.path}</code>{parent.before?<span>{message(' · 节点 ')}<code>{parent.before.identity}</code>{message(' · 模式 ')}<code>{parent.before.mode.toString(8).padStart(4,'0')}</code> · UID {parent.before.uid} · GID {parent.before.gid}</span>:<span>{message(' · 目录尚不存在')}</span>}</li>)}</ul>
     {reference.layout.parents.length>50&&<nav className="wb-actions" aria-label={message('元数据父目录分页')}><button type="button" disabled={layoutPage===0} onClick={()=>setLayoutPage(layoutPage-1)}>{message('上一页')}</button><span role="status">{t(`第 ${layoutPage+1} 页，共 ${Math.ceil(reference.layout.parents.length/50)} 页`,`Page ${layoutPage+1} of ${Math.ceil(reference.layout.parents.length/50)}`)}</span><button type="button" disabled={(layoutPage+1)*50>=reference.layout.parents.length} onClick={()=>setLayoutPage(layoutPage+1)}>{message('下一页')}</button></nav>}
    </section>:<p role="status">{message('此历史预览尚无物理权限与目录凭证。')}</p>}
    {reference.chains?<section aria-label={message('引用链凭证')}><h5>{message('引用链凭证')}</h5>
     {[{name:'原 HEAD',chain:reference.chains.head},{name:'切换目标',chain:reference.chains.target}].map(({name,chain})=><div key={name}><h6>{message(name)}</h6><ol>{chain.nodes.map(node=><li key={node.scope+'\0'+node.path}>{message(node.scope==='git'?'当前 Git 目录':'公共 Git 目录')} · <code>{node.path}</code> → <code>{node.symbolic_target??chain.oid??message('未出生分支')}</code><span> · {message(node.file.sha256===null?'无松散引用文件':'文件 SHA-256 ')}</span>{node.file.sha256&&<code>{node.file.sha256}</code>}</li>)}</ol></div>)}
    </section>:<p role="status">{message(reference.chains===null?'引用链尚未完整确认，保留待补策略状态。':'此历史预览尚无引用链凭证。')}</p>}
    {reference.creation?.state==='observed'&&<section aria-label={message('新建日志权限')}><h5>{message('新建日志权限')}</h5>
     <p>{message('文件模式 ')}<code>{reference.creation.file.mode.toString(8).padStart(4,'0')}</code> · UID {reference.creation.file.uid} · GID {reference.creation.file.gid}</p>
     <p>{message(reference.creation.directory.created?'新建 logs 目录':'保留 logs 目录')} {t('· 模式 ','· Mode ')}<code>{reference.creation.directory.mode.toString(8).padStart(4,'0')}</code> · UID {reference.creation.directory.uid} · GID {reference.creation.directory.gid}</p>
     <p>umask <code>{reference.creation.umask.toString(8).padStart(3,'0')}</code>{message(' · 权限策略 SHA-256 ')}<code>{reference.creation.policy_sha256}</code></p>
    </section>}
    {reference.creation?.state==='not_confirmed'&&<p role="status">{message({platform_policy_required:'当前平台的新建权限策略仍待补齐。',owner_policy_required:'所属组或目录权限策略尚未确认。',native_policy_required:'Git 原生权限结果尚未确认。'}[reference.creation.reason])}</p>}
    <p>{t('日志配置 ','Log Configuration ')}{message({default:'默认',true:'启用',false:'关闭',always:'全部启用'}[reference.log_policy.configuration])}{t(' · 有效策略',' · Effective Policy ')}{message(reference.log_policy.enabled?'启用':'关闭')}{t('。工作区独立配置','; Worktree-Specific Configuration ')}{message(reference.configuration.worktree_enabled?'启用':'关闭')}{t('。','.')}</p>
    <p>{message('松散引用文件缺失时，逻辑引用仍可能来自打包存储。日志及跟踪写入方案仍需完整审核。')}</p>
   </section>:<p role="status">{message('此历史预览尚无引用与配置原状态凭证。')}</p>}
   {target?.worktree_uses?.map(use=><p key={use.worktree+'-'+use.reason} role="status">{message(use.worktree==='current'?'当前工作区':'其他工作区')}{t('占用 · ',' In Use · ')}{message({head:'HEAD',rebase:'变基',bisect:'二分查找',update_refs:'待更新引用'}[use.reason])}</p>)}
   <p role="status">{message(preview.working_tree_check==='passed'?'工作区兼容检查已通过。':'工作区兼容性尚未确认，请核对暂存、未暂存及未跟踪文件和仓库状态。')}</p>
   {preview.index_projection&&<>{preview.index_projection.changes.length?<ul aria-label={message('切换索引变化')}>{preview.index_projection.changes.slice(page*50,(page+1)*50).map(change=><li key={change.path}>
    <strong>{message(change.before===null?'新增':change.after===null?'删除':'修改')}</strong> <code>{change.path}</code>
    <div>{message('原条目 ')}<code>{change.before?change.before.mode+' '+change.before.oid:message('无')}</code></div><div>{message('预览条目 ')}<code>{change.after?change.after.mode+' '+change.after.oid:message('无')}</code></div>
    {change.before?.blob&&<div>{t('原条目 blob · ','Original Entry Blob · ')}{change.before.blob.size}{t(' 字节 · SHA-256 ',' Bytes · SHA-256 ')}<code>{change.before.blob.sha256??message('摘要待确认')}</code></div>}
    {change.after?.blob&&<div>{t('预览条目 blob · ','Preview Entry Blob · ')}{change.after.blob.size}{t(' 字节 · SHA-256 ',' Bytes · SHA-256 ')}<code>{change.after.blob.sha256??message('摘要待确认')}</code></div>}
    {change.after?.worktree_content&&<div>{t('工作区输出 · ','Worktree Output · ')}{change.after.worktree_content.size===null?message('大小待确认'):t(change.after.worktree_content.size+' 字节',change.after.worktree_content.size+' Bytes')} · SHA-256 <code>{change.after.worktree_content.sha256??message('摘要待确认')}</code>
     {change.after.worktree_content.reason&&<p>{message({source_unconfirmed:'原始内容待确认',attribute_source_unconfirmed:'属性来源待确认',filter_policy_required:'过滤器策略待确认',read_failed:'转换读取未完成',output_limit:'输出超过本次预算',deadline:'读取时间预算已到',sparse_policy_required:'稀疏检出策略待确认'}[change.after.worktree_content.reason])}</p>}
     {change.after.worktree_content.attributes?.map(attribute=><span key={attribute.name}> · <code>{attribute.name}</code> = <code>{attribute.value}</code></span>)}
    </div>}
   </li>)}</ul>:<p>{message('索引条目的对象及模式保持一致。')}</p>}
   {preview.index_projection.changes.length>50&&<nav className="wb-actions" aria-label={message('索引变化分页')}><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>{message('上一页')}</button><span role="status">{t(`第 ${page+1} 页，共 ${Math.ceil(preview.index_projection.changes.length/50)} 页`,`Page ${page+1} of ${Math.ceil(preview.index_projection.changes.length/50)}`)}</span><button type="button" disabled={(page+1)*50>=preview.index_projection.changes.length} onClick={()=>setPage(page+1)}>{message('下一页')}</button></nav>}
   {preview.index_projection.attributes&&<section aria-label={message('目标索引属性')}><h4>{message('目标索引属性')}</h4>
    {preview.index_projection.attributes.length?<ul>{preview.index_projection.attributes.slice(attributePage*50,(attributePage+1)*50).map(attribute=><li key={attribute.path+'\0'+attribute.name}><code>{attribute.path}</code> · <code>{attribute.name}</code> · <code>{attribute.value}</code></li>)}</ul>:<p>{message('目标索引返回的属性条目为空。')}</p>}
    {preview.index_projection.attributes.length>50&&<nav className="wb-actions" aria-label={message('目标属性分页')}><button type="button" disabled={attributePage===0} onClick={()=>setAttributePage(attributePage-1)}>{message('上一页')}</button><span role="status">{t(`第 ${attributePage+1} 页，共 ${Math.ceil(preview.index_projection.attributes.length/50)} 页`,`Page ${attributePage+1} of ${Math.ceil(preview.index_projection.attributes.length/50)}`)}</span><button type="button" disabled={(attributePage+1)*50>=preview.index_projection.attributes.length} onClick={()=>setAttributePage(attributePage+1)}>{message('下一页')}</button></nav>}
   </section>}
   </>}
   {worktreeBefore===null&&<div role="status"><p>{message('工作区原状态尚未确认。')}</p>{onRetry&&<button type="button" onClick={onRetry}>{message('重新读取工作区状态')}</button>}</div>}
   {worktreeBefore&&<section aria-label={message('工作区变更前状态')}><h4>{message('工作区变更前状态')}</h4><p>{message('凭证 SHA-256 ')}<code>{worktreeBefore.sha256}</code></p>
    <ul>{worktreeBefore.entries.slice(page*50,(page+1)*50).map(entry=><li key={entry.path}>
     <code>{entry.path}</code> · {message({missing:'不存在',blocked:'父路径阻挡',file:'文件',directory:'目录',symlink:'符号链接',other:'特殊文件'}[entry.kind])}{t(' · 节点大小 ',' · Node Size ')}{entry.size}{t(' 字节 · 模式 ',' Bytes · Mode ')}<code>{entry.mode.toString(8).padStart(4,'0')}</code>
     {entry.blocked_by&&<p>{message('阻挡路径 ')}<code>{entry.blocked_by}</code></p>}
     {(entry.kind==='file'||entry.kind==='symlink')&&<p>{message('内容 SHA-256 ')}<code>{entry.sha256??message('摘要待确认')}</code></p>}
    </li>)}</ul><p>{message('此列表与索引变化按同一页码显示。实际发布效果仍需完整审核。')}</p>
   </section>}
   {directories?.state==='captured'&&directories.roots.length>0&&<section aria-label={message('工作区目录内容凭证')}><h4>{message('工作区目录内容凭证')}</h4>
    <p role="status">{message(directories.complete?'目录内容凭证已固定。':'目录内容凭证尚不完整。')}{t('目录根 ',' Directory Roots ')}{directories.roots.length}{t(' 个 · 节点 ',' · Nodes ')}{directories.entries.length}{t(' 个','')}</p><p>SHA-256 <code>{directories.sha256}</code></p>
    <ul>{directories.entries.slice(directoryPage*50,(directoryPage+1)*50).map(entry=><li key={entry.path}><code>{entry.path}</code> · {message({directory:'目录',file:'文件',symlink:'符号链接',other:'特殊节点',missing:'缺失',blocked:'父路径阻挡'}[entry.kind])} · {message(entry.parent===null?'目录根':'子项')} · {entry.size}{t(' 字节 · 模式 ',' Bytes · Mode ')}<code>{entry.mode.toString(8).padStart(4,'0')}</code> · UID {entry.uid} · GID {entry.gid}
     {entry.kind!=='directory'&&<p>{message('内容 SHA-256 ')}<code>{entry.sha256??message('待确认')}</code></p>}{entry.listing_sha256&&<p>{message('目录清单 SHA-256 ')}<code>{entry.listing_sha256}</code></p>}
    </li>)}</ul>
    {directories.entries.length>50&&<nav className="wb-actions" aria-label={message('目录内容分页')}><button type="button" disabled={directoryPage===0} onClick={()=>setDirectoryPage(directoryPage-1)}>{message('上一页')}</button><span role="status">{t(`第 ${directoryPage+1} 页，共 ${Math.ceil(directories.entries.length/50)} 页`,`Page ${directoryPage+1} of ${Math.ceil(directories.entries.length/50)}`)}</span><button type="button" disabled={(directoryPage+1)*50>=directories.entries.length} onClick={()=>setDirectoryPage(directoryPage+1)}>{message('下一页')}</button></nav>}
    {directories.issues.length>0&&<><h5>{message('待确认内容')}</h5><ul>{directories.issues.slice(directoryIssuePage*50,(directoryIssuePage+1)*50).map(issue=><li key={issue.path+'\0'+issue.reason}><code>{issue.path}</code> · {message({nested_repository:'嵌套仓库',protected_path:'受保护或不支持的路径',path_alias:'名称存在大小写或规范化冲突',content_unconfirmed:'内容摘要待确认',special_node:'特殊节点策略待补齐'}[issue.reason])}</li>)}</ul></>}
    {directories.issues.length>50&&<nav className="wb-actions" aria-label={message('目录待确认内容分页')}><button type="button" disabled={directoryIssuePage===0} onClick={()=>setDirectoryIssuePage(directoryIssuePage-1)}>{message('上一页')}</button><span role="status">{t(`第 ${directoryIssuePage+1} 页，共 ${Math.ceil(directories.issues.length/50)} 页`,`Page ${directoryIssuePage+1} of ${Math.ceil(directories.issues.length/50)}`)}</span><button type="button" disabled={(directoryIssuePage+1)*50>=directories.issues.length} onClick={()=>setDirectoryIssuePage(directoryIssuePage+1)}>{message('下一页')}</button></nav>}
   </section>}
   {!directories&&worktreeBefore?.entries.some(entry=>entry.kind==='directory')&&<p role="status">{message('此历史预览尚无目录内容凭证。')}</p>}
   {directories?.state==='not_confirmed'&&directories.reason!=='before_unconfirmed'&&<div role="status"><p>{message({before_unconfirmed:'变更前工作区状态尚未确认。',deadline:'目录读取时间预算已到。',entry_limit:'目录节点超过读取范围。',path_limit:'目录路径信息超过读取范围。',read_unavailable:'目录内容暂时无法完整读取。'}[directories.reason])}</p>{onRetry&&<button type="button" onClick={onRetry}>{message('重新读取目录内容')}</button>}</div>}
   {preview.index_projection?.worktree_attribute_before&&<p>{message('工作区后备属性凭证 SHA-256 ')}<code>{preview.index_projection.worktree_attribute_before.sha256}</code></p>}
   {onRetry&&preview.index_projection?.changes.some(change=>change.after?.worktree_content?.sha256===null)&&<button type="button" onClick={onRetry}>{message('重新读取工作区输出摘要')}</button>}
   <p>{message('blob 摘要对应 Git 原始内容，工作区输出摘要对应本次转换结果。文件发布、引用、日志和跟踪策略仍需完整审核。')}</p>
 </div>;
}
