import React,{useMemo,useState} from 'react';
import type {ResultTasks} from './tool-result-tasks';

const labels:Record<string,string>={pending:'待处理',in_progress:'进行中',completed:'已完成',failed:'失败',cancelled:'已取消',blocked:'受阻',unknown:'未确认'};
/** Tool-reported list data is not a Jot execution/goal receipt and provides no mutation controls. */
export default function ToolResultTaskList({value,documentId,origin='result'}:{value:ResultTasks;documentId:string;origin?:'input'|'result'}){
 const [selected,setSelected]=useState(0),count=Math.max(1,Math.ceil(value.items.length/20)),page=Math.min(selected,count-1);
 const summary=useMemo(()=>({completed:value.items.filter(item=>item.status==='completed').length,checked:value.items.filter(item=>item.marker==='checked').length}),[value]);
 return <section aria-label={origin==='input'?'原工具请求中的任务清单':'原工具结果中的任务清单'} data-chat-search-content={JSON.stringify([documentId,'tasks',page])}>
  <h6>{origin==='input'?'原工具请求中的任务清单':'原工具结果中的任务清单'}</h6>
  <p data-chat-search-ignore>{origin==='input'?'以下为原工具请求内容；是否成功应用仍以原步骤回执为准。':'以下为工具结果所报内容，Jot运行状态仍以原执行记录为准。'}</p>
  <p data-chat-search-ignore>{value.items.length} 项 · 原状态为完成 {summary.completed} 项{summary.checked?` · 已勾选 ${summary.checked} 项`:''}</p>
  {!value.items.length?<p>原清单为空。</p>:<ol start={page*20+1}>{value.items.slice(page*20,page*20+20).map((item,index)=><li key={page*20+index} style={{overflowWrap:'anywhere'}}>
   {item.id!==undefined&&<code>#{item.id}</code>}{' '}<span>{item.marker?item.marker==='checked'?'已勾选':'未勾选':item.status===undefined?'原结果未提供状态':Object.hasOwn(labels,item.status)?labels[item.status]:<>原状态：<code>{item.status||'（空）'}</code></>}</span>
   <p style={{whiteSpace:'pre-wrap'}}>{item.title||'（原标题为空）'}</p>
   {item.owner!==undefined&&<p>负责人：{item.owner}</p>}{item.priority!==undefined&&<p>原优先级：{item.priority}</p>}
   {item.blockedBy&&item.blockedBy.length>0&&<details><summary>原依赖 {item.blockedBy.length} 项</summary><p>{item.blockedBy.join('、')}</p></details>}
   {item.metadataUnconfirmed&&<p data-chat-search-ignore>部分附加信息格式尚未确认，可对照原数据。</p>}
  </li>)}</ol>}
  {value.unconfirmed>0&&<p data-chat-search-ignore>另有 {value.unconfirmed} 项暂不能按清单显示，可展开原数据查看。</p>}
  {count>1&&<nav aria-label="原任务清单翻页" data-chat-search-ignore><button type="button" disabled={!page} onClick={()=>setSelected(page-1)}>上一页清单</button><span>{page+1} / {count}</span><button type="button" disabled={page+1>=count} onClick={()=>setSelected(page+1)}>下一页清单</button></nav>}
 </section>;
}
