import React,{useEffect,useRef,useState} from 'react';
import type {WorkbenchMemoryReplacement,WorkbenchMemoryImportReplacementSource} from '../../packages/gateway/contracts/types';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import PrdTextPreview from './PrdTextPreview';

const pageSize=25;
export default function MemoryImportReplacement({workspace,importId,previewVersion,replacement}:{workspace:string;importId:string;previewVersion:number;replacement:WorkbenchMemoryReplacement}){
 const owner=taskDraftScope(),alive=useRef(true);
 const [page,setPage]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [source,setSource]=useState<WorkbenchMemoryImportReplacementSource|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const read=async(memoryId:string)=>{
  const item=replacement.items.find(value=>value.memory_id===memoryId);
  if(!item||busy||!current())return;setBusy(true);setError('');setSource(null);
  try{
   const value=await workbenchApi.memoryImportReplacementSource(workspace,importId,memoryId,previewVersion);
   if(value.import_id!==importId||value.preview_version!==previewVersion||value.memory_id!==memoryId||value.version!==item.version
    ||value.sha256!==item.content_sha256||value.execution_authorized!==false||typeof value.memory?.content!=='string')
    throw Error('原记忆快照与替换预览不一致，请重新核对');
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.memory.content));
   const actual=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
   if(actual!==item.content_sha256)throw Error('原记忆内容与 SHA-256 不一致');
   if(current())setSource(value);
  }catch(reason){if(current())setError(reason instanceof Error?reason.message:'原记忆读取失败');}
  finally{if(current())setBusy(false);}
 };
 return <section aria-label="替换受影响记忆" className="wb-form">
  <h4>当前范围内将退役 {replacement.count} 条记忆</h4>
  <p>清单包含当前范围中的已核实和已过期记忆。确认后，旧记录进入原有版本历史，所选源包中的有效项目记忆生成待核实记录。</p>
  <p style={{overflowWrap:'anywhere'}}>范围快照 SHA-256 {replacement.scope_sha256}</p>
  {error&&<p role="alert" className="wb-error">{error}</p>}
  <div className="wb-message-list">{replacement.items.slice(page*pageSize,(page+1)*pageSize).map(item=><article key={item.memory_id}>
   <strong>{item.memory_id} · v{item.version}</strong><p>{item.verified?'已核实':'待核实'} · {item.content_chars} 字符{item.expires_at&&` · 有效期 ${item.expires_at}`}</p>
   <p style={{overflowWrap:'anywhere'}}>SHA-256 {item.content_sha256}</p><button type="button" disabled={busy} onClick={()=>void read(item.memory_id)}>核对原版本内容</button>
  </article>)}</div>
  {replacement.items.length>pageSize&&<div className="wb-actions"><button type="button" disabled={page===0||busy} onClick={()=>{setPage(page-1);setSource(null);}}>上一页</button><span>第 {page+1} 页，共 {Math.ceil(replacement.items.length/pageSize)} 页</span><button type="button" disabled={busy||(page+1)*pageSize>=replacement.items.length} onClick={()=>{setPage(page+1);setSource(null);}}>下一页</button></div>}
  {source&&<div><h5>{source.memory_id} · 原 v{source.version}</h5><PrdTextPreview content={JSON.stringify(source.memory,null,2)} label="原记忆版本" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}/></div>}
 </section>;
}
