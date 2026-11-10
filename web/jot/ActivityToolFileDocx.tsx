import React,{useContext,useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {readListedFilePreviewBytes,type ListedFilePreviewSource} from './activity-file-preview-client';
import {FileTextReferenceContext,type FileTextReference,type OfficeTextFocus} from './FileTextReferences';
import {createTextContentReference} from './vendor/pilotdeck-content-reference';
import {validateTextReferenceSource} from '../../packages/gateway/src/messages/content-reference.js';

type Selection={serial:number;selectedText:string;occurrenceIndex:number;prefix:string;suffix:string};
type Proposal={selection:Selection;reference:FileTextReference};
function readSelection(value:unknown):Selection|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const selection=value as Selection;
 if(Object.keys(selection).length!==5||Object.keys(selection).some(key=>!['serial','selectedText','occurrenceIndex','prefix','suffix'].includes(key))
  ||!Number.isSafeInteger(selection.serial)||selection.serial<1||!Number.isSafeInteger(selection.occurrenceIndex)||selection.occurrenceIndex<0||selection.occurrenceIndex>33554432
  ||typeof selection.selectedText!=='string'||!selection.selectedText.trim()||selection.selectedText.length>100000
  ||typeof selection.prefix!=='string'||selection.prefix.length>80||typeof selection.suffix!=='string'||selection.suffix.length>80)return;
 return selection;
}
function createVisualReference(selection:Selection,source:ListedFilePreviewSource,owner:string):FileTextReference{
 const {file,conversationId,runId,activityId,resultSha}=source;
 const reference=createTextContentReference({selectionMode:'text',
  source:{relativePath:file.path,fileName:file.path.split('/').at(-1)!,mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',revision:{id:String(file.version),sha256:file.sha256,size:file.size}},
  renderer:{id:'docx',backend:'builtin',locatorQuality:'semantic'},
  locator:{surface:'document',occurrenceIndex:selection.occurrenceIndex,quote:{exact:selection.selectedText,prefix:selection.prefix,suffix:selection.suffix}},
  selectedText:selection.selectedText,surroundingText:selection.prefix+selection.selectedText+selection.suffix,truncated:false});
 const value={text_view:2 as const,conversationId,runId,activityId,resultSha,file:{path:file.path,version:file.version,sha256:file.sha256,size:file.size},reference};
 validateTextReferenceSource(value,conversationId);return {...value,owner};
}
function originalVisualFocus(focus:OfficeTextFocus|undefined,source:ListedFilePreviewSource,owner:string){
 const value=focus?.value;
 if(!value||value.text_view!==2||value.owner!==owner||value.conversationId!==source.conversationId||value.runId!==source.runId
  ||value.activityId!==source.activityId||value.resultSha!==source.resultSha||value.file.path!==source.file.path
  ||value.file.version!==source.file.version||value.file.sha256!==source.file.sha256||value.file.size!==source.file.size)return;
 const {owner:referenceOwner,...reference}=value;
 try{validateTextReferenceSource(reference,source.conversationId);}catch{return;}
 const locator=value.reference.locator;
 return {selectedText:value.reference.selectedText,occurrenceIndex:locator.occurrenceIndex!,prefix:locator.quote.prefix??'',suffix:locator.quote.suffix??''};
}

function DocxAttempt({source,owner,identity,officeTextFocus}:{source:ListedFilePreviewSource;owner:string;identity:string;officeTextFocus?:OfficeTextFocus}){
 const context=useContext(FileTextReferenceContext),currentContext=useRef(context);currentContext.current=context;
 const frame=useRef<HTMLIFrameElement>(null),loaded=useRef<HTMLIFrameElement|null>(null);
 const notify=useRef<(frame:HTMLIFrameElement)=>void>(()=>{});
 const cancel=useRef<()=>void>(()=>{}),commit=useRef<()=>void>(()=>{});
 const [state,setState]=useState<{phase:'loading'|'ready'|'error';message:string}>({phase:'loading',message:'正在核对原文件并渲染Word…'});
 const [proposal,setProposal]=useState<Proposal>(),selected=useRef<Proposal|undefined>(undefined),pending=useRef<Proposal|undefined>(undefined);
 const pendingTimer=useRef<number|undefined>(undefined);
 const [committing,setCommitting]=useState(false),[notice,setNotice]=useState(''),[focused,setFocused]=useState<boolean>();
 const disabled=!context||context.disabled||context.owner!==owner||context.conversationId!==source.conversationId;
 useEffect(()=>{if(disabled){selected.current=undefined;pending.current=undefined;window.clearTimeout(pendingTimer.current);setCommitting(false);setProposal(undefined);}},[disabled]);
 useEffect(()=>{
  const controller=new AbortController(),target=frame.current,token=crypto.randomUUID(),focus=originalVisualFocus(officeTextFocus,source,owner);
  let bytes:ArrayBuffer|undefined,sent=false,closed=false,ready=false;
  const live=()=>!closed&&!controller.signal.aborted&&taskDraftScope()===owner;
  const canAdd=()=>{const value=currentContext.current;return live()&&!!value&&!value.disabled&&value.owner===owner&&value.conversationId===source.conversationId;};
  const resetPending=()=>{pending.current=undefined;window.clearTimeout(pendingTimer.current);setCommitting(false);};
  const dispose=()=>{closed=true;controller.abort();bytes=undefined;selected.current=undefined;pending.current=undefined;window.clearTimeout(timeout);window.clearTimeout(pendingTimer.current);window.removeEventListener('message',message);};
  const fail=(text:string)=>{if(!live())return;dispose();setProposal(undefined);setCommitting(false);if(officeTextFocus)setFocused(false);setState({phase:'error',message:text});};
  const send=(element:HTMLIFrameElement)=>{
   if(!live()||sent||!bytes||!target||element!==target||loaded.current!==target||!target.contentWindow)return;
   sent=true;
   try{target.contentWindow.postMessage({type:'jot-docx-init',protocol:1,token,bytes,...(focus?{focus}:{})},'*',[bytes]);bytes=undefined;}
   catch{fail('Word查看器未能接收原文件，请重试。');}
  };
  const message=(event:MessageEvent)=>{
   if(!live()||!sent||event.source!==target?.contentWindow)return;
   const value=event.data;
   if(!value||typeof value!=='object'||Array.isArray(value)||value.protocol!==1||value.token!==token||Object.keys(value).length!==4)return;
   if(value.type==='jot-docx-ready'&&Number.isSafeInteger(value.sections)&&value.sections>=0&&value.sections<=50000){
    ready=true;window.clearTimeout(timeout);setState({phase:'ready',message:`已渲染 ${value.sections} 个Word分段。分段沿原文件分页标记。`});
   }else if(value.type==='jot-docx-error'&&['DOCX_RENDER_FAILED','DOCX_VIEW_LIMIT'].includes(value.code)){
    fail(value.code==='DOCX_VIEW_LIMIT'?'Word内容超过当前视觉渲染范围，可切换结构化文字查看。':'Word视觉渲染失败，可重试或切换结构化文字查看。');
   }else if(ready&&value.type==='jot-docx-focus'&&typeof value.confirmed==='boolean'&&focus){
    setFocused(value.confirmed);
   }else if(ready&&value.type==='jot-docx-selection'){
    resetPending();selected.current=undefined;setProposal(undefined);setNotice('');
    if(!canAdd()||value.selection===null)return;
    const selection=readSelection(value.selection);if(!selection)return;
    try{
     const next={selection,reference:createVisualReference(selection,source,owner)};selected.current=next;setProposal(next);
    }catch{setNotice('视觉文字选区尚未通过原文件引用校验。');}
   }else if(ready&&value.type==='jot-docx-commit-ready'){
    const original=pending.current,selection=readSelection(value.selection);
    if(!original||!canAdd()||!selection||JSON.stringify(selection)!==JSON.stringify(original.selection))return;
    resetPending();
    if(currentContext.current?.onAdd(original.reference)){
     selected.current=undefined;setProposal(undefined);setNotice('Word文字引用已加入当前草稿。');
     target?.contentWindow?.postMessage({type:'jot-docx-added',protocol:1,token,serial:selection.serial},'*');
    }else setNotice('文字引用尚未保存，请检查草稿状态或缩小选区。');
   }
  };
  const timeout=window.setTimeout(()=>fail('Word视觉读取超时，可重试或切换结构化文字查看。'),30000);
  setState({phase:'loading',message:'正在核对原文件并渲染Word…'});setFocused(officeTextFocus&&!focus?false:undefined);
  window.addEventListener('message',message);notify.current=send;
  cancel.current=()=>fail('Word视觉读取已取消。');
  commit.current=()=>{
   const original=selected.current;
   if(!ready||!canAdd()||!original||pending.current||!target?.contentWindow)return;
   pending.current=original;setCommitting(true);setNotice('正在复核原视觉选区…');
   pendingTimer.current=window.setTimeout(()=>{if(live()){resetPending();setNotice('视觉选区复核未完成，请重新选择后引用。');}},2000);
   target.contentWindow.postMessage({type:'jot-docx-commit',protocol:1,token,serial:original.selection.serial},'*');
  };
  void readListedFilePreviewBytes(source,owner,controller.signal).then(value=>{
   if(!live())return;
   bytes=value.buffer as ArrayBuffer;if(target)send(target);
  }).catch(error=>{if(live())fail(error instanceof Error?error.message:'原Word文件读取失败');});
  return()=>{dispose();notify.current=()=>{};commit.current=()=>{};cancel.current=()=>{};};
 },[identity,owner]);
 return <section className="jot-docx-preview" aria-label="Word视觉内容">
  <p role={state.phase==='error'?'alert':'status'}>{state.message}
   {state.phase==='loading'&&<button type="button" onClick={()=>cancel.current()}>取消读取</button>}
  </p>
  {officeTextFocus?.value.text_view===2&&<p role="status">{focused===true?'已核对并定位原视觉文字引用。':focused===false?'原视觉文字尚未与固定版本核对，请对照原引用快照。':'正在核对原视觉文字引用…'}</p>}
  {notice&&<p role="status">{notice}</p>}
  {state.phase!=='error'&&<iframe ref={frame} title="原固定版本Word视觉查看器" src="/docx-preview/0.4.0/frame.html" sandbox="allow-scripts" referrerPolicy="no-referrer"
   onLoad={event=>{loaded.current=event.currentTarget;notify.current(event.currentTarget);}}/>}
  {proposal&&<section className="jot-docx-selection" aria-label="待确认的Word视觉文字引用"><blockquote>{proposal.reference.reference.selectedText}</blockquote><button type="button" disabled={disabled||committing} onPointerDown={event=>event.preventDefault()} onMouseDown={event=>event.preventDefault()} onClick={()=>commit.current()}>引用Word文字到当前对话</button></section>}
 </section>;
}

export default function ActivityToolFileDocx(source:ListedFilePreviewSource&{officeTextFocus?:OfficeTextFocus}){
 const owner=taskDraftScope(),[revision,setRevision]=useState(0);
 const identity=JSON.stringify([owner,source.conversationId,source.runId,source.activityId,source.resultSha,source.file.path,source.file.version,source.file.sha256,source.file.size,source.officeTextFocus?.key,revision]);
 return <><button type="button" onClick={()=>setRevision(value=>value+1)}>重新读取Word视觉内容</button><DocxAttempt key={identity} source={source} owner={owner} identity={identity} officeTextFocus={source.officeTextFocus}/></>;
}
