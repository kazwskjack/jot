import React,{useMemo,useState} from 'react';
import {editTaskmasterSource,taskmasterSourceTasks} from '../../packages/gateway/src/persistent-tasks/taskmaster-source';
import TaskmasterSourceTasks from './TaskmasterSourceTasks';

const blank=()=>({id:'',title:'',description:'',status:'pending',priority:'medium',details:'',dependencies:'[]'});
export default function TaskmasterTaskDraft({content,disabled,onDraft}:{content:string;disabled:boolean;onDraft:(content:string)=>void}){
 const [open,setOpen]=useState(false),[index,setIndex]=useState<number|null>(null),[basis,setBasis]=useState<string|null>(null);
 const [fields,setFields]=useState(blank),[tag,setTag]=useState(''),[message,setMessage]=useState('');
 const source=useMemo(()=>{
  if(!open)return null;
  try{return taskmasterSourceTasks(content);}catch{return null;}
 },[content,open]);
 function add(){setIndex(null);setBasis(content);setFields(blank());setTag(source?.tags[0]??'');setMessage('');}
 function edit(selected:number){
  const row=source?.items[selected];if(!row)return;
  const task=row.task;setIndex(selected);setBasis(content);setTag(row.tag);setMessage('');
  setFields({id:String(task.id),title:String(task.title),description:String(task.description??''),status:String(task.status??''),
   priority:String(task.priority??''),details:String(task.details??''),dependencies:JSON.stringify(task.dependencies??[])});
 }
 function apply(event:React.FormEvent){
  event.preventDefault();if(disabled||basis===null)return;
  if(basis!==content){setMessage('原文件草稿已变化，请重新选择任务或新增入口后核对字段。');return;}
  try{
   const dependencies=JSON.parse(fields.dependencies);
   const values={title:fields.title,description:fields.description,status:fields.status,priority:fields.priority,details:fields.details,dependencies};
   let next:string;
   if(index===null)next=editTaskmasterSource(content,{kind:'add',tag,task:{id:fields.id,...values}});
   else{
    const original=source!.items[index]!.task;
    const changed=Object.fromEntries(Object.entries(values).filter(([key,value])=>key==='dependencies'
     ?JSON.stringify(value)!==JSON.stringify(original[key]??[]):value!==String(original[key]??'')));
    if(!Object.keys(changed).length){setMessage('任务字段尚无修改。');return;}
    next=editTaskmasterSource(content,{kind:'update',index,fields:changed});
   }
   onDraft(next);setBasis(null);setMessage('任务字段已应用到原文件草稿。请继续比较修改、确认并保存。');
  }catch(error){setMessage(error instanceof Error&&error.message==='taskmaster_source_too_large'?'修改后的文件超过 1 MiB 上限。':'任务字段无效。请核对唯一 ID、标题、说明和依赖 ID 的 JSON 数组。');}
 }
 return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>Taskmaster 任务字段编辑</summary>
  <p className="wb-hint">新增和修改作用于此逻辑文件草稿，保存使用原文件权限、会话恢复和版本比较。原文件中的其余字段会保留，JSON 通常按两空格缩进整理，接近 1 MiB 上限时使用紧凑格式。外部任务状态继续作为来源资料。</p>
  {open&&!source&&(content.trim()?<p role="alert">当前草稿无法解析。请先在文本草稿中修正 Taskmaster JSON。</p>:<button type="button" disabled={disabled} onClick={()=>{onDraft('{\n  "tasks": []\n}\n');setBasis(null);setMessage('已初始化任务文件草稿，请继续比较修改并确认保存。');}}>初始化空任务文件草稿</button>)}
  {source&&<>
   <button type="button" disabled={disabled} onClick={add}>新增顶层任务</button>
   <TaskmasterSourceTasks content={content} onEdit={edit} disabled={disabled}/>
   {basis!==null&&<form onSubmit={apply} aria-label="Taskmaster 任务字段草稿">
    <fieldset disabled={disabled}>
     <legend>{index===null?'新增任务':'修改任务'}</legend>
     {index===null?<label>标签组 <select value={tag} onChange={event=>setTag(event.target.value)}>{source.tags.map(name=><option key={name} value={name}>{name||'未分组'}</option>)}</select></label>:<p>标签组 {tag||'未分组'}</p>}
     <label>外部任务 ID <input required value={fields.id} readOnly={index!==null} onChange={event=>setFields({...fields,id:event.target.value})}/></label>
     <label>标题 <input required value={fields.title} onChange={event=>setFields({...fields,title:event.target.value})}/></label>
     <label>说明 <textarea required={index===null} value={fields.description} onChange={event=>setFields({...fields,description:event.target.value})}/></label>
     <label>原状态 <input value={fields.status} onChange={event=>setFields({...fields,status:event.target.value})}/></label>
     <label>优先级 <input value={fields.priority} onChange={event=>setFields({...fields,priority:event.target.value})}/></label>
     <label>详情 <textarea value={fields.details} onChange={event=>setFields({...fields,details:event.target.value})}/></label>
     <label>依赖 ID JSON 数组 <textarea value={fields.dependencies} onChange={event=>setFields({...fields,dependencies:event.target.value})}/></label>
     <button type="submit">应用任务字段到原文件草稿</button>
    </fieldset>
   </form>}
  </>}
  {message&&<p role="status">{message}</p>}
 </details>;
}
