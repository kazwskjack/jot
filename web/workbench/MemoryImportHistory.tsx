import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {memoryUiMessage} from './memory-ui-messages';
import React,{useEffect,useRef,useState} from 'react';
import type {WorkbenchMemoryImportHistorySection,WorkbenchMemoryImportSourceHistory} from '../../packages/gateway/contracts/types';
import {taskDraftScope} from '../jot/client';
import {workbenchApi} from './client';

export default function MemoryImportHistory({workspace,importId,inputHash,bundleHash}:{workspace:string;importId:string;inputHash:string;bundleHash:string}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>memoryUiMessage(value,language);
 const owner=useRef(taskDraftScope()).current,alive=useRef(true),pending=useRef<AbortController|null>(null);
 const [section,setSection]=useState<WorkbenchMemoryImportHistorySection>('metadata');
 const [view,setView]=useState<WorkbenchMemoryImportSourceHistory|null>(null),[previous,setPrevious]=useState<number[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;pending.current?.abort();};},[]);
 const current=()=>alive.current&&taskDraftScope()===owner;
 const read=async(offset:number,history:number[])=>{
  if(pending.current||!current())return;
  const controller=new AbortController();pending.current=controller;setBusy(true);setError('');
  try{
   const value=await workbenchApi.memoryImportSourceHistory(workspace,importId,section,offset,controller.signal),page=value.page;
   if(value.import_id!==importId||value.input_sha256!==inputHash||value.sha256!==bundleHash||value.execution_authorized!==false
    ||value.section!==section||typeof value.text!=='string'||!/^([a-f0-9]{64})$/.test(value.content_sha256)
    ||!page||page.offset!==offset||page.limit!==4096||!Number.isSafeInteger(page.total)||page.total<offset+value.text.length
    ||value.text.length>4096||page.next_offset!==(offset+value.text.length<page.total?offset+value.text.length:null)
    ||page.next_offset!==null&&!value.text.length||view&&value.content_sha256!==view.content_sha256)
    throw Error('历史来源回执与原导入批次不一致');
   if(current()){setView(value);setPrevious(history);}
  }catch(reason){if(current()&&!controller.signal.aborted)setError(reason instanceof Error?reason.message:'历史来源读取失败');}
  finally{if(pending.current===controller)pending.current=null;if(current())setBusy(false);}
 };
 if(!current())return null;
 return <section lang={language} aria-label={t("导入来源历史","Import Source History")} className="wb-form">
  <h4>{t("索引与 Dream 来源历史","Index and Dream Source History")}</h4>
  <p>{t("按原导入批次读取完整摘要和 Case、索引、Dream 记录，每页显示最多 4096 个 UTF-16 单位。源包顺序与字段原样保留。","Read complete summaries and Case, Index and Dream records from the original import batch, up to 4096 UTF-16 units per page. Original bundle ordering and fields are retained.")}</p>
  <label>{t('历史内容 ','History Content ')}<select disabled={busy} value={section} onChange={event=>{setSection(event.target.value as WorkbenchMemoryImportHistorySection);setView(null);setPrevious([]);setError('');}}>
   <option value="metadata">{t("导出、索引与 Dream 摘要","Export, Index and Dream Summary")}</option><option value="case">{t("Case 记录","Case Records")}</option><option value="index">{t("索引记录","Index Records")}</option><option value="dream">{t("Dream 记录","Dream Records")}</option>
  </select></label>
  <button type="button" disabled={busy} onClick={()=>void read(0,[])}>{busy?t('正在核对并读取…','Verifying and Reading…'):t('读取历史来源','Read Historical Source')}</button>
  {error&&<p role="alert" className="wb-error">{message(error)}</p>}
  {view&&<>
   <pre aria-label={t("历史来源内容","Historical Source Content")} style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'24rem',overflow:'auto'}}>{view.text}</pre>
   <div className="wb-actions">
    <button type="button" disabled={busy||!previous.length} onClick={()=>void read(previous[previous.length-1]!,previous.slice(0,-1))}>{t("上一段","Previous Segment")}</button>
    <span role="status">{view.page.offset+1}–{view.page.offset+view.text.length} / {view.page.total}</span>
    <button type="button" disabled={busy||view.page.next_offset===null} onClick={()=>{if(view.page.next_offset!==null)void read(view.page.next_offset,[...previous,view.page.offset]);}}>{t("下一段","Next Segment")}</button>
   </div>
   <p style={{overflowWrap:'anywhere'}}>{t('完整当前历史内容 SHA-256 ','Complete Current History SHA-256 ')}{view.content_sha256}</p>
  </>}
 </section>;
}
