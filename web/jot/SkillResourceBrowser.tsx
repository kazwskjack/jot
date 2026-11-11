import {useApplicationLanguage,useApplicationText} from './application-language';
import React,{useState} from 'react';
import {useResource} from '../workbench/useResource';
import {readSelectedSkillDirectory} from './skill-catalog-client';

export default function SkillResourceBrowser({runId,ownerScope,name,onRead,onClose}:{
 runId:string;ownerScope:string;name:string;onRead:(path:string)=>void;onClose:()=>void;
}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const [path,setPath]=useState('.');
 const [pages,setPages]=useState<Array<string|null>>([null]);
 const after=pages.at(-1)??null;
 const resource=useResource(signal=>readSelectedSkillDirectory(runId,ownerScope,name,path,after,signal),
  JSON.stringify([ownerScope,runId,name,path,after]));
 const current=resource.data?.relativePath===path&&resource.data.after===after?resource.data:null;
 const navigate=(next:string)=>{setPath(next);setPages([null]);};
 const child=(name:string)=>path==='.'?name:path+'/'+name;
 const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'.';
 return <section lang={language} aria-label={t(`${name} 配套资源`,`${name} Supporting Resources`)}>
  <h4>{name} {t('配套资源','Supporting Resources')}</h4>
  <p>{t('目录','Directory')} <code>{path}</code></p>
  <button type="button" onClick={onClose}>{t('关闭资源目录','Close Resource Directory')}</button>
  <button type="button" disabled={path==='.'} onClick={()=>navigate(parent)}>{t('上一级目录','Parent Directory')}</button>
  <button type="button" onClick={resource.reload}>{t('刷新目录','Refresh Directory')}</button>
  {resource.loading&&<p role="status">{t('正在读取目录…','Reading directory…')}</p>}
  {resource.error&&<p role="alert">{t('资源目录暂不可用，可刷新重试或填写已知相对路径读取。','The resource directory is unavailable. Refresh and retry, or enter a known relative path to read.')}</p>}
  {current&&<>
   {current.entries.length===0?<p role="status">{t('当前页没有资源。','No resources on this page.')}</p>:<ul>{current.entries.map(entry=><li key={entry.name}>
    <code>{entry.name}</code> · {entry.kind==='directory'?t('目录','Directory'):entry.size===null?t('文件','File'):t(`${entry.size} 字节`,`${entry.size} bytes`)}
    <button type="button" onClick={()=>entry.kind==='directory'?navigate(child(entry.name)):onRead(child(entry.name))}>
     {entry.kind==='directory'?t('进入目录','Open Directory'):t('读取此文件','Read This File')}
    </button>
   </li>)}</ul>}
   <nav aria-label={t('技能目录分页','Skill Directory Pages')}>
    <button type="button" disabled={resource.loading||pages.length===1} onClick={()=>setPages(value=>value.slice(0,-1))}>{t('上一页','Previous Page')}</button>
    <span>{t(`第 ${pages.length} 页`,`Page ${pages.length}`)}</span>
    <button type="button" disabled={resource.loading||current.next===null} onClick={()=>{if(current.next)setPages(value=>[...value,current.next]);}}>{t('下一页','Next Page')}</button>
   </nav>
  </>}
 </section>;
}
