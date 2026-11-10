import React,{useEffect,useRef,useState} from 'react';
import type {OfficePreviewConfiguration,OfficePreviewConfigurationUpdate} from '../../packages/gateway/contracts/types';
import {ApiError,request,taskDraftScope} from './client';
import OfficePreviewCandidateScan from './OfficePreviewCandidateScan';

function configuration(value:OfficePreviewConfiguration){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==6||value.protocol!==1
  ||!Number.isSafeInteger(value.version)||value.version<0||!['builtin','libreoffice'].includes(value.service)
  ||typeof value.binaryPath!=='string'||value.binaryPath.length>4096||/[\u0000-\u001f\u007f]/.test(value.binaryPath)
  ||typeof value.writable!=='boolean'||value.execution_authorized!==false)throw Error('Office配置尚未确认。');
 return value;
}
export default function OfficePreviewConfigurationEditor({owner,onSaved}:{owner:string;onSaved:()=>void}){
 const [value,setValue]=useState<OfficePreviewConfiguration>();
 const [draft,setDraft]=useState<{service:OfficePreviewConfiguration['service'];binaryPath:string}>({service:'builtin',binaryPath:''});
 const [revision,setRevision]=useState(0),[reading,setReading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState('');
 const [attempt,setAttempt]=useState<{key:string;input:OfficePreviewConfigurationUpdate}>();
 const active=useRef<AbortController|null>(null),saved=useRef(onSaved);saved.current=onSaved;
 useEffect(()=>{
  const controller=new AbortController();setReading(true);
  void request<OfficePreviewConfiguration>('/office-preview/configuration','GET',undefined,undefined,controller.signal).then(raw=>{
   if(controller.signal.aborted||taskDraftScope()!==owner)return;
   const current=configuration(raw);setValue(current);setDraft({service:current.service,binaryPath:current.binaryPath});setReading(false);saved.current();
  }).catch(()=>{if(!controller.signal.aborted&&taskDraftScope()===owner){setReading(false);setError('Office配置读取失败，请重新读取。');}});
  return()=>{controller.abort();active.current?.abort();active.current=null;};
 },[owner,revision]);
 const save=async()=>{
  if(taskDraftScope()!==owner||active.current||reading||!value?.writable)return;
  const command=attempt??{key:crypto.randomUUID(),input:{expected_version:value.version,service:draft.service,binaryPath:draft.binaryPath}};
  const controller=new AbortController();active.current=controller;setAttempt(command);setSaving(true);setError('');
  try{
   const result=configuration(await request<OfficePreviewConfiguration>('/office-preview/configuration','PATCH',command.input,command.key,controller.signal));
   if(controller.signal.aborted||taskDraftScope()!==owner)return;
   if(!result.writable||result.version!==command.input.expected_version+1||result.service!==command.input.service||result.binaryPath!==command.input.binaryPath.trim())throw Error('Office配置保存回执尚未确认。');
   setAttempt(undefined);setValue(result);setRevision(current=>current+1);saved.current();
  }catch(cause){
   if(controller.signal.aborted||taskDraftScope()!==owner)return;
   if(cause instanceof ApiError&&[400,403,409,422].includes(cause.status)){
    setAttempt(undefined);setRevision(current=>current+1);setError(cause.status===409?'配置版本已变化，正在重新读取。请对照后保存。':'Office配置保存被拒绝，请重新核对。');
   }else setError('保存结果暂未确认，可重试同一保存请求。');
  }finally{if(active.current===controller){active.current=null;setSaving(false);}}
 };
 const disabled=reading||saving||!!attempt||!value?.writable;
 return <section aria-label="Office预览配置">
  <button type="button" disabled={reading||saving||!!attempt} onClick={()=>{setError('');setRevision(current=>current+1);}}>重新读取Office配置</button>
  {reading&&<p role="status">正在读取Office配置…</p>}
  {error&&<p role="alert">{error}</p>}
  {value&&<>
   <p>配置版本 {value.version}</p>
   {!value.writable&&<p role="status">当前身份具有Office配置读取权限，保存权限由服务端配置所有者绑定。</p>}
   <label>默认预览服务 <select disabled={disabled} value={draft.service} onChange={event=>setDraft(current=>({...current,service:event.target.value as OfficePreviewConfiguration['service']}))}>
    <option value="builtin">内置查看器</option><option value="libreoffice">LibreOffice转换PDF</option>
   </select></label>
   <label>LibreOffice程序路径 <input disabled={disabled} maxLength={4096} value={draft.binaryPath} placeholder="留空自动发现可用的LibreOffice程序" onChange={event=>setDraft(current=>({...current,binaryPath:event.target.value}))}/></label>
   <button type="button" disabled={disabled} onClick={()=>{setDraft({service:value.service,binaryPath:value.binaryPath});setError('');}}>取消编辑</button>
   <button type="button" disabled={reading||saving||!value.writable} onClick={()=>void save()}>{saving?'正在保存Office配置…':attempt?'重试原保存请求':'保存Office配置'}</button>
  </>}
  <OfficePreviewCandidateScan owner={owner} {...(!disabled?{onSelect:(binaryPath:string)=>setDraft(current=>({...current,binaryPath}))}:{})}/>
 </section>;
}
