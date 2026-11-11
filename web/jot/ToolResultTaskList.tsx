import {useApplicationLanguage,useApplicationText} from './application-language';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import type {ResultTasks} from './tool-result-tasks';

/** Tool-reported list data is not a Jot execution/goal receipt and provides no mutation controls. */
export default function ToolResultTaskList({value,documentId,origin='result',reveal}:{value:ResultTasks;documentId:string;origin?:'input'|'result';reveal?:{key:string;itemIndex:number}}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const labels:Record<string,string>={pending:t("待处理","Pending"),in_progress:t("进行中","In Progress"),completed:t("已完成","Completed"),failed:t("失败","Failed"),cancelled:t("已取消","Cancelled"),blocked:t("受阻","Blocked"),unknown:t("未确认","Unconfirmed")};
 const [selected,setSelected]=useState(0),count=Math.max(1,Math.ceil(value.items.length/20)),page=Math.min(selected,count-1);
 const appliedReveal=useRef('');
 useEffect(()=>{if(reveal&&appliedReveal.current!==reveal.key&&Number.isSafeInteger(reveal.itemIndex)&&reveal.itemIndex>=0&&reveal.itemIndex<value.items.length){appliedReveal.current=reveal.key;setSelected(Math.floor(reveal.itemIndex/20));}},[reveal?.key,reveal?.itemIndex,value.items.length]);
 const summary=useMemo(()=>({completed:value.items.filter(item=>item.status==='completed').length,checked:value.items.filter(item=>item.marker==='checked').length}),[value]);
 return <section lang={language} aria-label={origin==='input'?t('原工具请求中的任务清单','Task List in the Original Tool Request'):t('原工具结果中的任务清单','Task List in the Original Tool Result')} data-chat-search-content={JSON.stringify([documentId,'tasks',page])}>
  <h6>{origin==='input'?t('原工具请求中的任务清单','Task List in the Original Tool Request'):t('原工具结果中的任务清单','Task List in the Original Tool Result')}</h6>
  <p data-chat-search-ignore>{origin==='input'?t('以下为原工具请求内容；是否成功应用仍以原步骤回执为准。','The following is original tool-request content. Whether it was applied successfully depends on the original step receipt.'):t('以下为工具结果所报内容，Jot运行状态仍以原执行记录为准。','The following is content reported by the tool result. Jot run status still depends on the original execution record.')}</p>
  <p data-chat-search-ignore>{t(`${value.items.length} 项 · 原状态为完成 ${summary.completed} 项`,`${value.items.length} items · ${summary.completed} originally marked completed`)}{summary.checked?t(` · 已勾选 ${summary.checked} 项`,` · ${summary.checked} checked`):''}</p>
  {!value.items.length?<p>{t('原清单为空。','The original list is empty.')}</p>:<ol start={page*20+1}>{value.items.slice(page*20,page*20+20).map((item,index)=><li key={page*20+index} style={{overflowWrap:'anywhere'}}>
   {item.id!==undefined&&<code>#{item.id}</code>}{' '}<span>{item.marker?item.marker==='checked'?t('已勾选','Checked'):t('未勾选','Unchecked'):item.status===undefined?t('原结果未提供状态','The original result did not provide a status'):Object.hasOwn(labels,item.status)?labels[item.status]:<>{t('原状态：','Original Status: ')}<code>{item.status||t('（空）','(empty)')}</code></>}</span>
   <p style={{whiteSpace:'pre-wrap'}}>{item.title||t('（原标题为空）','(original title is empty)')}</p>
   {item.owner!==undefined&&<p>{t('负责人：','Owner: ')}{item.owner}</p>}{item.priority!==undefined&&<p>{t('原优先级：','Original Priority: ')}{item.priority}</p>}
   {item.blockedBy&&item.blockedBy.length>0&&<details><summary>{t(`原依赖 ${item.blockedBy.length} 项`,`${item.blockedBy.length} original dependencies`)}</summary><p>{item.blockedBy.join('、')}</p></details>}
   {item.metadataUnconfirmed&&<p data-chat-search-ignore>{t('部分附加信息格式尚未确认，可对照原数据。','Some metadata formats are unconfirmed. Compare with the original data.')}</p>}
  </li>)}</ol>}
  {value.unconfirmed>0&&<p data-chat-search-ignore>{t(`另有 ${value.unconfirmed} 项暂不能按清单显示，可展开原数据查看。`,`${value.unconfirmed} additional items cannot currently be displayed as tasks. Expand the original data to inspect them.`)}</p>}
  {count>1&&<nav aria-label={t("原任务清单翻页","Original Task List Pages")} data-chat-search-ignore><button type="button" disabled={!page} onClick={()=>setSelected(page-1)}>{t('上一页清单','Previous Task List Page')}</button><span>{page+1} / {count}</span><button type="button" disabled={page+1>=count} onClick={()=>setSelected(page+1)}>{t('下一页清单','Next Task List Page')}</button></nav>}
 </section>;
}
