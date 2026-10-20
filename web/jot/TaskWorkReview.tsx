import React,{useState} from 'react';
import type {TaskWorkReview,WorkReviewEntry} from './types';

const names={add:'新增',delete:'删除',replace:'替换',modify:'修改',rename:'重命名'};
function Inventory({label,items}:{label:string;items:WorkReviewEntry[]}){
 const [offset,setOffset]=useState(0);
 return <details><summary>{label}（{items.length} 项）</summary><ul>{items.slice(offset,offset+50).map(item=><li key={item.path}>{item.kind==='directory'?<><code>{item.path}</code> · 文件夹</>:<details><summary><code>{item.path}</code> · {item.bytes} 字节{item.executable?' · 可执行':''}</summary><small style={{display:'block',overflowWrap:'anywhere'}}>SHA-256 {item.sha256}</small></details>}</li>)}</ul>
 {items.length>50&&<nav aria-label={label+'分页'}><button type="button" disabled={offset===0} onClick={()=>setOffset(n=>Math.max(0,n-50))}>上一页</button><span>{offset+1}–{Math.min(offset+50,items.length)} / {items.length}</span><button type="button" disabled={offset+50>=items.length} onClick={()=>setOffset(n=>n+50)}>下一页</button></nav>}</details>;
}
/** Original frozen review only; no apply, Git or checkpoint action is granted. */
export default function TaskWorkReviewView({value}:{value:TaskWorkReview}){
 const [offset,setOffset]=useState(0),changes=value.diff.changes;
 return <section aria-label="完整任务改动" style={{overflowWrap:'anywhere',minWidth:0}}><h4>完整任务改动</h4><p>共 {changes.length} 项改动 · 隔离工作区结果，尚未发布到项目</p>
 <ul>{changes.slice(offset,offset+50).map((change,i)=><li key={offset+i}>{names[change.kind]} · <code>{change.from?`${change.from} → `:''}{change.path}</code></li>)}</ul>
 {changes.length>50&&<nav aria-label="改动分页"><button type="button" disabled={offset===0} onClick={()=>setOffset(n=>Math.max(0,n-50))}>上一页</button><span>{offset+1}–{Math.min(offset+50,changes.length)} / {changes.length}</span><button type="button" disabled={offset+50>=changes.length} onClick={()=>setOffset(n=>n+50)}>下一页</button></nav>}
 <Inventory label="原始版本完整清单" items={value.base_manifest.entries}/><Inventory label="结果版本完整清单" items={value.result_manifest.entries}/>
 <details><summary>本次选定方案原文</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{value.selected_objective}</pre></details>
 <details><summary>版本核验信息</summary><dl>{[['检查记录',value.inspection_sha256],['原始版本',value.diff.base_sha256],['结果版本',value.diff.result_sha256],['改动清单',value.diff.diff_sha256]].map(([name,hash])=><React.Fragment key={name}><dt>{name}</dt><dd style={{overflowWrap:'anywhere'}}>{hash}</dd></React.Fragment>)}</dl></details>
 </section>;
}
