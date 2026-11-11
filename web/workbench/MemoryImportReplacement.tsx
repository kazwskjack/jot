import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {memoryUiMessage} from './memory-ui-messages';
import React,{useEffect,useRef,useState} from 'react';
import type {WorkbenchMemoryReplacement,WorkbenchMemoryImportReplacementSource,WorkbenchMemoryReplacementReceipt} from '../../packages/gateway/contracts/types';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';
import PrdTextPreview from './PrdTextPreview';

const pageSize=25;
export default function MemoryImportReplacement({workspace,importId,previewVersion,replacement}:{workspace:string;importId:string;previewVersion:number;replacement:WorkbenchMemoryReplacement}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>memoryUiMessage(value,language);
 const owner=useRef(taskDraftScope()).current,alive=useRef(true);
 const [inventory,setInventory]=useState(replacement);
 const [page,setPage]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [source,setSource]=useState<WorkbenchMemoryImportReplacementSource|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const load=async(offset:number)=>{
  if(busy||!current())return;setBusy(true);setError('');setSource(null);
  try{
   const value=await workbenchApi.memoryImport(workspace,importId,undefined,offset),next=value.replacement;
   if(value.import_id!==importId||value.version!==previewVersion||!next||next.scope_sha256!==replacement.scope_sha256
    ||next.count!==replacement.count||!next.page||next.page.offset!==offset||next.page.total!==next.count||next.page.limit!==pageSize)
    throw Error('替换清单版本已变化，请重新读取原批次');
   if(current())setInventory(next);
  }catch(reason){if(current())setError(reason instanceof Error?reason.message:'替换清单读取失败');}
  finally{if(current())setBusy(false);}
 };
 const read=async(memoryId:string)=>{
  const item=inventory.items.find(value=>value.memory_id===memoryId);
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
 if(!current())return null;
 return <section lang={language} aria-label={t('替换受影响记忆','Memories Affected by Replacement')} className="wb-form">
  <h4>{t(`当前范围内将退役 ${replacement.count} 条记忆`,`${replacement.count} Memories in the Current Scope Will Be Retired`)}</h4>
  <p>{t("清单包含当前范围中的已核实和已过期记忆。确认后，旧记录进入原有版本历史，所选源包中的有效记忆生成待核实记录。","The inventory includes verified and expired memories in the current scope. After confirmation, old records enter their original version history and valid memories from the selected bundle become unverified records.")}</p>
  <p style={{overflowWrap:'anywhere'}}>{t('范围快照 SHA-256 ','Scope Snapshot SHA-256 ')}{replacement.scope_sha256}</p>
  {error&&<p role="alert" className="wb-error">{message(error)}</p>}
  <div className="wb-message-list">{(inventory.page?inventory.items:inventory.items.slice(page*pageSize,(page+1)*pageSize)).map(item=><article key={item.memory_id}>
   <strong>{item.memory_id} · v{item.version}</strong><p>{item.verified?t('已核实','Verified'):t('待核实','Unverified')} · {item.content_chars}{t(' 字符',' Characters')}{item.expires_at&&t(` · 有效期 ${item.expires_at}`,` · Expires ${item.expires_at}`)}</p>
   <p style={{overflowWrap:'anywhere'}}>SHA-256 {item.content_sha256}</p><button type="button" disabled={busy} onClick={()=>void read(item.memory_id)}>{t("核对原版本内容","Check Original Version Content")}</button>
  </article>)}</div>
  {inventory.page&&inventory.count>pageSize?<div className="wb-actions"><button type="button" disabled={busy||inventory.page.offset===0} onClick={()=>void load(Math.max(0,inventory.page!.offset-pageSize))}>{t("上一页","Previous Page")}</button><span role="status">{t(`当前位置 ${inventory.page.offset}，共 ${inventory.count} 条`,`Current Offset ${inventory.page.offset}; ${inventory.count} Items Total`)}</span><button type="button" disabled={busy||inventory.page.next_offset===null} onClick={()=>void load(inventory.page!.next_offset!)}>{t("下一页","Next Page")}</button></div>
   :!inventory.page&&inventory.items.length>pageSize&&<div className="wb-actions"><button type="button" disabled={page===0||busy} onClick={()=>{setPage(page-1);setSource(null);}}>{t("上一页","Previous Page")}</button><span>{t(`第 ${page+1} 页，共 ${Math.ceil(inventory.items.length/pageSize)} 页`,`Page ${page+1} of ${Math.ceil(inventory.items.length/pageSize)}`)}</span><button type="button" disabled={busy||(page+1)*pageSize>=inventory.items.length} onClick={()=>{setPage(page+1);setSource(null);}}>{t("下一页","Next Page")}</button></div>}

  {source&&<div><h5>{source.memory_id}{t(' · 原 v',' · Original v')}{source.version}</h5><PrdTextPreview content={JSON.stringify(source.memory,null,2)} label={t('原记忆版本','Original Memory Version')} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}/></div>}
 </section>;
}

export function MemoryImportRetirements({workspace,importId,version,replacement}:{workspace:string;importId:string;version:number;replacement:WorkbenchMemoryReplacementReceipt}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>memoryUiMessage(value,language);
 const owner=useRef(taskDraftScope()).current,alive=useRef(true);
 const [view,setView]=useState(replacement),[page,setPage]=useState(0),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const load=async(offset:number)=>{
  if(busy||!current())return;setBusy(true);setError('');
  try{
   const value=await workbenchApi.memoryImport(workspace,importId,undefined,offset),receipt=value.receipt,next=receipt?.replacement;
   if(value.import_id!==importId||receipt?.import_id!==importId||receipt.status!=='applied'||receipt.version!==version
    ||!next||next.scope_sha256!==replacement.scope_sha256||next.count!==replacement.count||!next.page||next.page.offset!==offset
    ||next.page.total!==next.count||next.page.limit!==pageSize)throw Error('退役回执与原应用批次不一致');
   if(current())setView(next);
  }catch(reason){if(current())setError(reason instanceof Error?reason.message:'退役回执读取失败');}
  finally{if(current())setBusy(false);}
 };
 if(!current())return null;
 return <details lang={language}><summary>{t("查看原记忆退役回执","View Original Memory Retirement Receipts")}</summary>
  {error&&<p role="alert" className="wb-error">{message(error)}</p>}
  {(view.page?view.items:view.items.slice(page*pageSize,(page+1)*pageSize)).map(item=><p key={item.memory_id}>{item.memory_id} · v{item.from_version} → v{item.result_version}{t(' · 已退役',' · Retired')}</p>)}
  {view.page&&view.count>pageSize?<div className="wb-actions"><button type="button" disabled={busy||view.page.offset===0} onClick={()=>void load(Math.max(0,view.page!.offset-pageSize))}>{t("上一页退役回执","Previous Retirement Receipt Page")}</button><span role="status">{t(`当前位置 ${view.page.offset}，共 ${view.count} 条`,`Current Offset ${view.page.offset}; ${view.count} Items Total`)}</span><button type="button" disabled={busy||view.page.next_offset===null} onClick={()=>void load(view.page!.next_offset!)}>{t("下一页退役回执","Next Retirement Receipt Page")}</button></div>
   :!view.page&&view.items.length>pageSize&&<div className="wb-actions"><button type="button" disabled={page===0} onClick={()=>setPage(page-1)}>{t("上一页退役回执","Previous Retirement Receipt Page")}</button><span>{t(`第 ${page+1} 页，共 ${Math.ceil(view.items.length/pageSize)} 页`,`Page ${page+1} of ${Math.ceil(view.items.length/pageSize)}`)}</span><button type="button" disabled={(page+1)*pageSize>=view.items.length} onClick={()=>setPage(page+1)}>{t("下一页退役回执","Next Retirement Receipt Page")}</button></div>}
 </details>;
}
