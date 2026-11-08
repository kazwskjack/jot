import React,{useState} from 'react';
import {useResource} from '../workbench/useResource';
import {readSelectedSkillDirectory} from './skill-catalog-client';

export default function SkillResourceBrowser({runId,ownerScope,name,onRead,onClose}:{
 runId:string;ownerScope:string;name:string;onRead:(path:string)=>void;onClose:()=>void;
}){
 const [path,setPath]=useState('.');
 const [pages,setPages]=useState<Array<string|null>>([null]);
 const after=pages.at(-1)??null;
 const resource=useResource(signal=>readSelectedSkillDirectory(runId,ownerScope,name,path,after,signal),
  JSON.stringify([ownerScope,runId,name,path,after]));
 const current=resource.data?.relativePath===path&&resource.data.after===after?resource.data:null;
 const navigate=(next:string)=>{setPath(next);setPages([null]);};
 const child=(name:string)=>path==='.'?name:path+'/'+name;
 const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.';
 return <section aria-label={`${name} 配套资源`}>
  <h4>{name} 配套资源</h4>
  <p>目录 <code>{path}</code></p>
  <button type="button" onClick={onClose}>关闭资源目录</button>
  <button type="button" disabled={path==='.'} onClick={()=>navigate(parent)}>上一级目录</button>
  <button type="button" onClick={resource.reload}>刷新目录</button>
  {resource.loading&&<p role="status">正在读取目录…</p>}
  {resource.error&&<p role="alert">资源目录暂不可用，可刷新重试或填写已知相对路径读取。</p>}
  {current&&<>
   {current.entries.length===0?<p role="status">当前页没有资源。</p>:<ul>{current.entries.map(entry=><li key={entry.name}>
    <code>{entry.name}</code> · {entry.kind==='directory'?'目录':entry.size===null?'文件':`${entry.size} 字节`}
    <button type="button" onClick={()=>entry.kind==='directory'?navigate(child(entry.name)):onRead(child(entry.name))}>
     {entry.kind==='directory'?'进入目录':'读取此文件'}
    </button>
   </li>)}</ul>}
   <nav aria-label="技能目录分页">
    <button type="button" disabled={resource.loading||pages.length===1} onClick={()=>setPages(value=>value.slice(0,-1))}>上一页</button>
    <span>第 {pages.length} 页</span>
    <button type="button" disabled={resource.loading||current.next===null} onClick={()=>{if(current.next)setPages(value=>[...value,current.next]);}}>下一页</button>
   </nav>
  </>}
 </section>;
}
