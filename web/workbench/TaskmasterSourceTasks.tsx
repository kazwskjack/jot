import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {workspaceUiMessage} from './workspace-ui-messages';
import React,{useMemo,useState} from 'react';
import {taskmasterSourceTasks} from '../../packages/gateway/src/persistent-tasks/taskmaster-source';
import PrdTextPreview from './PrdTextPreview';

const pageSize=50;
const textStyle:React.CSSProperties={whiteSpace:'pre-wrap',overflowWrap:'anywhere'};
export default function TaskmasterSourceTasks({content,onEdit,disabled=false}:{content:string;onEdit?:(index:number)=>void;disabled?:boolean}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const showMessage=(value:string)=>workspaceUiMessage(value,language);
 const [open,setOpen]=useState(false),[tag,setTag]=useState<string|null>(null),[page,setPage]=useState(0);
 const source=useMemo(()=>{
  if(!open)return null;
  try{return {value:taskmasterSourceTasks(content),error:''};}
  catch{return {value:null,error:'任务文件结构无法读取，请核对原文。'};}
 },[content,open]);
 const items=source?.value?.items??[];
 const selected=useMemo(()=>items.map((item,index)=>({item,index})).filter(({item})=>tag===null||item.tag===tag),[source,tag]);
 const current=Math.min(page,Math.max(0,Math.ceil(selected.length/pageSize)-1));
 const next=selected.find(({item})=>item.depth===0&&['pending','in-progress'].includes(String(item.task.status)));
 return <details lang={language} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>{t("结构化任务与下一项","Structured Tasks and Next Item")}</summary>
  {source?.error&&<p role="alert">{showMessage(source.error)}</p>}
  {source?.value&&<>
   <p className="wb-hint">{t("以下保留原文件状态与外部 ID。下一项按文件顺序选取 pending 或 in-progress 的顶层任务。执行步骤由原任务账本及 tasks.next 核对。","Original file states and external IDs are retained below. The next item is the first top-level pending or in-progress task in file order. Execution steps are checked through the original task ledger and tasks.next.")}</p>
   <label>{t("标签组 ","Tag Group ")}<select aria-label={t('任务文件标签组','Task File Tag Group')} value={tag===null?'all':String(source.value.tags.indexOf(tag))} onChange={event=>{setTag(event.target.value==='all'?null:source.value!.tags[Number(event.target.value)]!);setPage(0);}}>
    <option value="all">{t("全部","All")}</option>{source.value.tags.map((name,index)=><option key={index} value={String(index)}>{name||t("未分组","Ungrouped")}</option>)}
   </select></label>
   <p role="status">{t(`${selected.length} 条任务及子任务 · 第 ${current+1} / ${Math.max(1,Math.ceil(selected.length/pageSize))} 页`,`${selected.length} Tasks and Subtasks · Page ${current+1} / ${Math.max(1,Math.ceil(selected.length/pageSize))}`)}</p>
   <p>{t("下一项 ","Next Item ")}{next?`${next.item.tag||t("未分组","Ungrouped")} · ${String(next.item.task.id)} · ${String(next.item.task.title)}`:t("当前选择中没有 pending 或 in-progress 的顶层任务","No Top-level Pending or In-progress Task in the Current Selection")}</p>
   <ol start={current*pageSize+1}>{selected.slice(current*pageSize,(current+1)*pageSize).map(({item,index})=><li key={index} style={textStyle}>
    <strong>{String(item.task.id)} · {String(item.task.title)}</strong>
    {onEdit&&<button type="button" disabled={disabled} onClick={()=>onEdit(index)}>{t("编辑任务字段","Edit Task Fields")}</button>}
    <p>{t("标签 ","Tag ")}{item.tag||t("未分组","Ungrouped")}{t(" · 层级 "," · Depth ")}{item.depth}{t(" · 原状态 "," · Original State ")}{String(item.task.status??t("未提供","Not Supplied"))}{t(" · 原优先级 "," · Original Priority ")}{String(item.task.priority??t("未提供","Not Supplied"))}</p>
    {item.parent_index!==null&&<p>{t("所在父任务 ","Parent Task ")}{String(items[item.parent_index]!.task.id)}</p>}
    {item.task.parentId!==undefined&&<p>{t("原声明父 ID ","Original Declared Parent ID ")}{String(item.task.parentId)}</p>}
    {Array.isArray(item.task.dependencies)&&<p>{t("原依赖 ","Original Dependencies ")}{JSON.stringify(item.task.dependencies)}</p>}
    <details><summary>{t("任务字段","Task Fields")}</summary><PrdTextPreview content={JSON.stringify(Object.fromEntries(Object.entries(item.task).filter(([key])=>key!=='subtasks')),null,2)} label={t('任务来源字段','Task Source Fields')} style={textStyle}/></details>
   </li>)}</ol>
   <button type="button" disabled={current===0} onClick={()=>setPage(current-1)}>{t("上一页","Previous Page")}</button>
   <button type="button" disabled={(current+1)*pageSize>=selected.length} onClick={()=>setPage(current+1)}>{t("下一页","Next Page")}</button>
  </>}
 </details>;
}
