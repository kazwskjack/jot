import React,{useMemo,useState} from 'react';
import {taskmasterSourceTasks} from '../../packages/gateway/src/persistent-tasks/taskmaster-source';
import PrdTextPreview from './PrdTextPreview';

const pageSize=50;
const textStyle:React.CSSProperties={whiteSpace:'pre-wrap',overflowWrap:'anywhere'};
export default function TaskmasterSourceTasks({content}:{content:string}){
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
 return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>结构化任务与下一项</summary>
  {source?.error&&<p role="alert">{source.error}</p>}
  {source?.value&&<>
   <p className="wb-hint">以下保留原文件状态与外部 ID。下一项按文件顺序选取 pending 或 in-progress 的顶层任务。执行步骤由原任务账本及 tasks.next 核对。</p>
   <label>标签组 <select aria-label="任务文件标签组" value={tag===null?'all':String(source.value.tags.indexOf(tag))} onChange={event=>{setTag(event.target.value==='all'?null:source.value!.tags[Number(event.target.value)]!);setPage(0);}}>
    <option value="all">全部</option>{source.value.tags.map((name,index)=><option key={index} value={String(index)}>{name||'未分组'}</option>)}
   </select></label>
   <p role="status">{selected.length} 条任务及子任务 · 第 {current+1} / {Math.max(1,Math.ceil(selected.length/pageSize))} 页</p>
   <p>下一项 {next?`${next.item.tag||'未分组'} · ${String(next.item.task.id)} · ${String(next.item.task.title)}`:'当前选择中没有 pending 或 in-progress 的顶层任务'}</p>
   <ol start={current*pageSize+1}>{selected.slice(current*pageSize,(current+1)*pageSize).map(({item,index})=><li key={index} style={textStyle}>
    <strong>{String(item.task.id)} · {String(item.task.title)}</strong>
    <p>标签 {item.tag||'未分组'} · 层级 {item.depth} · 原状态 {String(item.task.status??'未提供')} · 原优先级 {String(item.task.priority??'未提供')}</p>
    {item.parent_index!==null&&<p>所在父任务 {String(items[item.parent_index]!.task.id)}</p>}
    {item.task.parentId!==undefined&&<p>原声明父 ID {String(item.task.parentId)}</p>}
    {Array.isArray(item.task.dependencies)&&<p>原依赖 {JSON.stringify(item.task.dependencies)}</p>}
    <details><summary>任务字段</summary><PrdTextPreview content={JSON.stringify(Object.fromEntries(Object.entries(item.task).filter(([key])=>key!=='subtasks')),null,2)} label="任务来源字段" style={textStyle}/></details>
   </li>)}</ol>
   <button type="button" disabled={current===0} onClick={()=>setPage(current-1)}>上一页</button>
   <button type="button" disabled={(current+1)*pageSize>=selected.length} onClick={()=>setPage(current+1)}>下一页</button>
  </>}
 </details>;
}
