import React,{useContext,useEffect,useRef,useState} from 'react';
import {taskDraftScope} from './client';
import {FileTextReferenceContext,type FileCellReference,type OfficeCellFocus} from './FileTextReferences';
import type {OfficeRegionSession} from './OfficeFileRegionReference';
import type {ListedFilePreviewSource} from './activity-file-preview-client';
import {createCellRangeContentReference,type CellRangeSnapshot} from './vendor/pilotdeck-content-reference';
import {validateCellReferenceSource} from '../../packages/gateway/src/messages/content-reference.js';

type Selection={serial:number;sheetId:string;sheetName:string;ranges:string[];activeRange:string;cells:CellRangeSnapshot[];headers?:string[][];surroundingValues?:string[][]};
type Proposal={selection:Selection;value:FileCellReference};
function readProposal(input:unknown,source:ListedFilePreviewSource,owner:string):Proposal{
 const required=['serial','sheetId','sheetName','ranges','activeRange','cells'],optional=['headers','surroundingValues'];
 if(!input||typeof input!=='object'||Array.isArray(input)||required.some(key=>!Object.hasOwn(input,key))||Object.keys(input).some(key=>!required.includes(key)&&!optional.includes(key))||JSON.stringify(input).length>100000)throw Error('原生选区数据尚未确认。');
 const selection=input as Selection;
 if(!Number.isSafeInteger(selection.serial)||selection.serial<1)throw Error('原生选区序号尚未确认。');
 const file=source.file,reference=createCellRangeContentReference({
  source:{relativePath:file.path,fileName:file.path.split('/').at(-1)!,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',revision:{id:String(file.version),sha256:file.sha256,size:file.size}},
  renderer:{id:'xlsx',backend:'builtin',locatorQuality:'semantic'},
  locator:{surface:'sheet',sheetId:selection.sheetId,sheetName:selection.sheetName,ranges:selection.ranges,activeRange:selection.activeRange},
  cells:selection.cells,...(selection.headers!==undefined?{headers:selection.headers}:{}),...(selection.surroundingValues!==undefined?{surroundingValues:selection.surroundingValues}:{})
 });
 const value={cell_view:2 as const,conversationId:source.conversationId,runId:source.runId,activityId:source.activityId,resultSha:source.resultSha,file:{path:file.path,version:file.version,sha256:file.sha256,size:file.size},reference};
 try{validateCellReferenceSource(value,source.conversationId);}catch{throw Error('原生选区尚未通过来源、矩阵或引用长度核对，请缩小选区。');}
 return {selection,value:{...value,owner}};
}
function originalFocus(focus:OfficeCellFocus|undefined,source:ListedFilePreviewSource,owner:string){
 const value=focus?.value;
 if(!value||value.cell_view!==2||value.owner!==owner||value.conversationId!==source.conversationId||value.runId!==source.runId||value.activityId!==source.activityId||value.resultSha!==source.resultSha
  ||value.file.path!==source.file.path||value.file.version!==source.file.version||value.file.sha256!==source.file.sha256||value.file.size!==source.file.size)return;
 const snapshot={cell_view:value.cell_view,conversationId:value.conversationId,runId:value.runId,activityId:value.activityId,resultSha:value.resultSha,file:value.file,reference:value.reference};
 try{validateCellReferenceSource(snapshot,source.conversationId);}catch{return;}
 const reference=value.reference;
 return {sheetId:reference.locator.sheetId,sheetName:reference.locator.sheetName,ranges:reference.locator.ranges,activeRange:reference.locator.activeRange,cells:reference.cells,
  ...(reference.headers!==undefined?{headers:reference.headers}:{}),...(reference.surroundingValues!==undefined?{surroundingValues:reference.surroundingValues}:{})};
}

export default function XlsxCellReferences({source,owner,session,focus}:{source:ListedFilePreviewSource;owner:string;session:OfficeRegionSession;focus?:OfficeCellFocus}){
 const context=useContext(FileTextReferenceContext),latest=useRef(context);latest.current=context;
 const identity=JSON.stringify([owner,source.conversationId,source.runId,source.activityId,source.resultSha,source.file.path,source.file.version,source.file.sha256,source.file.size,focus?.key]);
 const [proposal,setProposal]=useState<Proposal>(),selected=useRef<Proposal|undefined>(undefined),pending=useRef<Proposal|undefined>(undefined);
 const [ready,setReady]=useState(false),[committing,setCommitting]=useState(false),[notice,setNotice]=useState(''),[confirmed,setConfirmed]=useState<boolean>();
 const timer=useRef<number|undefined>(undefined),commit=useRef<()=>void>(()=>{});
 const disabled=!context||context.disabled||context.owner!==owner||context.conversationId!==source.conversationId||!context.cellViews?.includes(2);
 const send=(type:string,payload:Record<string,unknown>)=>{if(session.live())session.window.postMessage({type,protocol:1,token:session.token,...payload},session.origin);};
 const clearPending=()=>{pending.current=undefined;window.clearTimeout(timer.current);setCommitting(false);};
 useEffect(()=>{
  if(disabled){selected.current=undefined;setProposal(undefined);clearPending();}
  send('jot-xlsx-cell-enable',{enabled:!disabled});
 },[disabled,session]);
 useEffect(()=>{
  let active=true;
  const canAdd=()=>{const ctx=latest.current;return active&&session.live()&&taskDraftScope()===owner&&!!ctx&&!ctx.disabled&&ctx.owner===owner&&ctx.conversationId===source.conversationId&&!!ctx.cellViews?.includes(2);};
  const receive=(event:MessageEvent)=>{
   if(!active||!session.live()||event.source!==session.window||event.origin!==session.origin)return;
   const value=event.data;if(!value||typeof value!=='object'||Array.isArray(value)||value.protocol!==1||value.token!==session.token||Object.keys(value).length!==4)return;
   if(value.type==='jot-xlsx-cell-ready'&&value.available===true){setReady(true);return;}
   if(value.type==='jot-xlsx-cell-focus'&&typeof value.confirmed==='boolean'){setConfirmed(value.confirmed);return;}
   if(value.type==='jot-xlsx-cells'){
    const changed=!!pending.current;clearPending();selected.current=undefined;setProposal(undefined);
    if(value.selection===null||!canAdd())return;
    try{const next=readProposal(value.selection,source,owner);selected.current=next;setProposal(next);setNotice(changed?'原生选区或计算值已更新，请再次确认引用。':'');}
    catch(error){setNotice(error instanceof Error?error.message:'原生选区尚未通过核对。');}
   }else if(value.type==='jot-xlsx-cell-error'&&['SELECTION_TOO_LARGE','SELECTION_UNAVAILABLE'].includes(value.code)){
    clearPending();selected.current=undefined;setProposal(undefined);setNotice('原生选区尚未就绪或超过引用范围，请缩小选区并重新准备。');
   }else if(value.type==='jot-xlsx-cell-commit-ready'){
    const original=pending.current;
    if(!original||!canAdd()||value.serial!==original.selection.serial||selected.current!==original)return;
    clearPending();
    if(latest.current!.onAdd(original.value)){
     selected.current=undefined;setProposal(undefined);setNotice('原生单元格引用已加入原对话草稿。');send('jot-xlsx-cell-added',{serial:value.serial});
    }else setNotice('原生引用尚未保存，请检查草稿状态或缩小选区。');
   }
  };
  window.addEventListener('message',receive);
  const original=originalFocus(focus,source,owner);if(focus&&!original)setConfirmed(false);
  send('jot-xlsx-cell-probe',{focus:original??null});
  commit.current=()=>{
   const original=selected.current;if(!canAdd()||!original||pending.current)return;
   pending.current=original;setCommitting(true);setNotice('正在复核原生选区和显示值…');
   timer.current=window.setTimeout(()=>{if(active&&session.live()){clearPending();selected.current=undefined;setProposal(undefined);send('jot-xlsx-cell-clear',{serial:original.selection.serial});setNotice('原生选区复核超时，请重新准备引用。');}},30000);
   send('jot-xlsx-cell-commit',{serial:original.selection.serial});
  };
  return()=>{active=false;window.clearTimeout(timer.current);pending.current=undefined;selected.current=undefined;commit.current=()=>{};window.removeEventListener('message',receive);};
 },[session,identity,owner]);
 return <section aria-label="原生单元格引用确认">
  {!context?.cellViews?.includes(2)&&<p role="status">当前服务尚未声明原生单元格视图引用能力。</p>}
  {focus&&<p role="status">{confirmed===true?'已核对原生选区快照，可在查看器中逐项定位原选区。':confirmed===false?'原生选区显示值、原值或公式尚未与保存快照核对，请对照原引用。':'正在核对原生选区快照…'}</p>}
  {notice&&<p role="status">{notice}</p>}
  {proposal&&<><p>{proposal.selection.sheetName} · {proposal.selection.ranges.join('、')} · 原生视图 2</p><details><summary>待引用的显示值、原值及公式</summary><pre>{JSON.stringify(proposal.value.reference,null,2)}</pre></details>
   <button type="button" disabled={disabled||!ready||committing} onClick={()=>commit.current()}>核对并引用到当前对话</button></>}
 </section>;
}
