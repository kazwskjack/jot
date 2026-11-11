import {useApplicationLanguage,useApplicationText} from '../jot/application-language';
import {taskUiMessage} from './task-ui-messages';
import React,{useEffect,useRef,useState} from 'react';
import {request} from '../jot/client';
import {useResource} from './useResource';
import {PRD_TEMPLATE,prdMessage} from './task-prd.mjs';
import {TaskSaveReceipt} from './task-save-receipt.mjs';
import PrdTextPreview from './PrdTextPreview';
import type {Task} from './types';
import type {TaskPrdTemplates as Templates,TaskPrdTemplateRequest,TaskPrdTemplatePreview,TaskPrdTemplateApply} from '../../packages/gateway/contracts/types';

export default function TaskPrdTemplates({task,locked,ready,save,onStateChange,onSaved}:{
 task:Task;locked:boolean;ready:boolean;save:TaskSaveReceipt;onStateChange:()=>void;onSaved:(receipt:TaskPrdTemplateApply)=>void;
}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const message=(value:string)=>taskUiMessage(value,language);
 const identity=`${task.task_id}:${task.version}:${task.status}`;
 const catalog=useResource(signal=>request<Templates>(`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/templates`,'GET',undefined,undefined,signal),identity);
 const [selected,setSelected]=useState(''),[fileName,setFileName]=useState('prd.md'),[values,setValues]=useState('{}');
 const [prompt,setPrompt]=useState(''),[priority,setPriority]=useState('medium'),[dependencies,setDependencies]=useState('[]');
 const [preview,setPreview]=useState<TaskPrdTemplatePreview|null>(null),[receipt,setReceipt]=useState<TaskPrdTemplateApply|null>(null);
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const epoch=useRef(0),currentIdentity=useRef(identity);currentIdentity.current=identity;
 const draft=useRef<TaskPrdTemplateRequest|null>(null);
 function invalidate(){epoch.current++;draft.current=null;setPreview(null);setConfirmed(false);setError('');}
 useEffect(()=>{invalidate();},[identity,catalog.data]);
 useEffect(()=>()=>{epoch.current++;},[]);
 const template=catalog.data?.task_id===task.task_id&&catalog.data.task_version===task.version?catalog.data.templates.find(item=>item.id===selected):undefined;
 async function loadPreview(){
  if(locked||busy||!template)return;
  invalidate();const generation=epoch.current,context=identity;setBusy(true);
  try{
   const body={template_id:template.id,file_name:fileName,values:template.id==='task-request'?{'任务提示词':prompt,'优先级':priority,'依赖原生ID':dependencies}:JSON.parse(values)};
   const value=await request<TaskPrdTemplatePreview>(`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/template-preview`,'POST',body);
   if(generation!==epoch.current||context!==currentIdentity.current)return;
   if(value.task_id!==task.task_id||value.task_version!==task.version||value.template?.id!==template.id||value.target?.path!==`.taskmaster/docs/${fileName}`
    ||value.execution_authorized!==false||typeof value.content!=='string'||!/^[a-f0-9]{64}$/.test(value.preview_sha256)||!/^[a-f0-9]{64}$/.test(value.content_sha256))throw Error('PRD_PREVIEW_VERSION_CONFLICT');
   draft.current=body;setPreview(value);
  }catch(e){if(generation===epoch.current&&context===currentIdentity.current)setError(e instanceof SyntaxError?'模板字段须填写 JSON 字符串对象。':prdMessage(e instanceof Error?e.message:'模板预览未完成'));}
  finally{setBusy(false);}
 }
 async function apply(){
  if(save.busy||(!save.pending&&(locked||!ready||!confirmed||!preview||!draft.current)))return;
  setError('');
  const checkedRequest=async(path:string,method:string,body:TaskPrdTemplateRequest&{preview_sha256:string},key:string)=>{
   const value=await request<TaskPrdTemplateApply>(path,method,body,key),file=value?.file,source=file?.source;
   if(value?.task_id!==task.task_id||value.execution_authorized!==false||value.preview_sha256!==body.preview_sha256
    ||file?.protocol!==1||file.path!==`.taskmaster/docs/${body.file_name}`||!Number.isSafeInteger(file.version)||file.version<1||!/^[a-f0-9]{64}$/.test(file.sha256)
    ||source?.kind!=='prd_template'||source.task_id!==task.task_id||source.template_id!==body.template_id||source.preview_sha256!==body.preview_sha256)throw Error('PRD_TASKMASTER_IMPORT_UNCONFIRMED');
   return value;
  };
  try{
   const work=save.submit(checkedRequest,`/persistent-tasks/${encodeURIComponent(task.task_id)}/prd/template-apply`,'POST',save.pending?{}:{...draft.current!,preview_sha256:preview!.preview_sha256});onStateChange();
   const value=await work;setReceipt(value);invalidate();onSaved(value);
  }catch(e){if(!save.pending)invalidate();setError(prdMessage(e instanceof Error?e.message:'模板保存未完成'));}
  finally{onStateChange();}
 }
 const disabled=locked||busy;
 const textStyle:React.CSSProperties={whiteSpace:'pre-wrap',overflowWrap:'anywhere',wordBreak:'break-word',maxWidth:'100%'};
 return <details lang={language}><summary>{message('PRD 模板与提示词任务')}</summary>
  <label>{message('模板类别')}<select value={selected} disabled={disabled} onChange={e=>{invalidate();setSelected(e.target.value);if(e.target.value==='task-request')setFileName('task-request.md');}}>
   <option value="">{message('通用需求模板')}</option>{catalog.data?.templates.map(item=><option key={item.id} value={item.id}>{message(item.name)}</option>)}
  </select></label>
  {catalog.loading&&<p role="status">{message('正在读取模板目录…')}</p>}
  {catalog.error&&<p className="wb-error" role="alert">{message(prdMessage(catalog.error))}</p>}
  <PrdTextPreview content={template?.content??PRD_TEMPLATE} label={message('PRD 模板原文')} style={textStyle}/>
  {template&&<>
   <p className="wb-hint">{message(template.description)}{t('。','.')}{template.id==='task-request'?message('填写下方提示词、优先级和原生依赖后预览。'):<>{t('可替换字段为 ','Replaceable Fields: ')}{template.placeholders.join(t('、',', '))}{t('。字段值填写为 JSON 字符串对象，未填写的字段保留占位符。','. Enter Field Values as a JSON Object of Strings; Omitted Fields Keep Their Placeholders.')}</>}</p>
   <label>{message('文件名')}<input value={fileName} maxLength={200} disabled={disabled} onChange={e=>{invalidate();setFileName(e.target.value);}}/></label>
   {template.id==='task-request'?<>
    <p className="wb-hint">{message('保存请求来源后，可在来源列表选择此精确版本，预览并绑定原暂停任务。绑定选项会预设为追加一项并启用研究，可在确认前调整。由原任务的恢复入口交给原 DSH 生成原生子任务。')}</p>
    <label>{message('任务提示词')}<textarea value={prompt} maxLength={1048576} disabled={disabled} rows={6} onChange={event=>{invalidate();setPrompt(event.target.value);}}/></label>
    <label>{message('优先级')}<select value={priority} disabled={disabled} onChange={event=>{invalidate();setPriority(event.target.value);}}><option value="high">high / 90</option><option value="medium">medium / 50</option><option value="low">low / 10</option></select></label>
    <label>{message('依赖原生 ID JSON 数组')}<textarea value={dependencies} maxLength={10240} disabled={disabled} rows={2} onChange={event=>{invalidate();setDependencies(event.target.value);}}/></label>
   </>:<><label>{message('模板字段')}<textarea value={values} maxLength={524288} disabled={disabled} rows={6} spellCheck={false} onChange={e=>{invalidate();setValues(e.target.value);}}/></label></>}

   <button type="button" disabled={disabled||template.id==='task-request'&&!prompt.trim()} onClick={()=>void loadPreview()}>{message(busy?'正在生成预览…':'只读模板预览')}</button>
  </>}
  {preview&&<>
   <PrdTextPreview content={preview.content} label={message('模板填充预览')} style={textStyle}/>
   <dl style={{overflowWrap:'anywhere'}}><dt>{message('目标文件 / 当前版本')}</dt><dd>{preview.target.path} / v{preview.target.version}</dd><dt>{message('正文 SHA-256')}</dt><dd>{preview.content_sha256}</dd><dt>{message('预览 SHA-256')}</dt><dd>{preview.preview_sha256}</dd></dl>
   <label className="wb-checkbox"><input type="checkbox" checked={confirmed} disabled={disabled||!ready} onChange={e=>setConfirmed(e.target.checked)}/>{message('我已核对正文和目标版本，确认保存到原项目文件版本库。')}</label>
  </>}
  {(preview||save.pending)&&<button type="button" disabled={save.busy||(!save.pending&&(disabled||!ready||!confirmed))} onClick={()=>void apply()}>{message(save.busy?'正在保存模板…':save.pending?'重试原模板保存回执':'保存模板文件')}</button>}
  {save.pending&&<p role="status">{message('模板保存结果待确认，已保留原请求及 key。请重试原回执。')}</p>}
  {receipt&&<p role="status" style={{overflowWrap:'anywhere'}}>{t('已保存 ','Saved ')}{receipt.file.path} · v{receipt.file.version} · SHA-256 {receipt.file.sha256}{t('。可从来源列表继续预览并绑定原任务。','. Continue Previewing and Binding the Original Task from Sources.')}</p>}
  {error&&<p className="wb-error" role="alert">{message(error)}</p>}
 </details>;
}
