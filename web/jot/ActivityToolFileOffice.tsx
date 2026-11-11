import {useApplicationLanguage,useApplicationText} from './application-language';
import {conversationUiError} from './conversation-ui-errors';
import {officeViewIdentity,readOfficeView} from './office-file-view-state';
import {useStructuredOfficeViewState} from './office-structured-view-state';
import type {OfficePrintFocus} from './pdf-file-view-state';
import OfficeFilePrintPreview from './OfficeFilePrintPreview';
import {OFFICE_SOURCE_MAX_BYTES} from '../../packages/gateway/src/artifacts/office-preview-format.js';
import OfficePreviewServiceStatus from './OfficePreviewServiceStatus';
// Selection context bounds adapted from PilotDeck 783499ff SpreadsheetInteractivePreview.tsx.
// AGPL-3.0 terms retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
import OfficeTextReferenceAction from './OfficeTextReferenceAction';
import {officeTextView,resolveOfficeTextReference} from './office-text-reference';
import {cellRangeCoordinates} from '../../packages/gateway/src/messages/content-reference.js';
import {FileTextReferenceContext,nativeReferenceIdentity,type FileReferenceIdentity,type OfficeCellFocus,type OfficeTextFocus,type OfficeRegionFocus} from './FileTextReferences';
import {createCellRangeContentReference,type CellRangeSnapshot} from './vendor/pilotdeck-content-reference';
import './activity-tool-file-office.css';
import React,{useContext,useEffect,useMemo,useRef,useState} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import ActivityToolFileBytes from './ActivityToolFileBytes';
import ActivityToolFileDocx from './ActivityToolFileDocx';
import ActivityToolFilePptx from './ActivityToolFilePptx';
import ActivityToolFileXlsx from './ActivityToolFileXlsx';
import {fileViewingReferenceSource,type FileViewingIdentity,type ListedFilePreviewSource} from './activity-file-preview-client';
import {officePreviewFormat,normalizeOfficePreviewContent,type OfficeDocumentPreview,type SpreadsheetRawValue} from '../../packages/gateway/src/artifacts/document-preview-content';

type VisualAdmission={protocol:1;ready:boolean;reason?:'source_limit'|'format_invalid'|'source_unverified'};
type Page={document_protocol:1;conversation_id:string;run_id:string;activity_id:string;result_sha256:string;
 path:string;version:number;sha256:string;size:number;source:'workspace'|'isolated';media_type:string;
 document:OfficeDocumentPreview;engine:{name:string;version:string};execution_authorized:false;
 docx_visual?:VisualAdmission;pptx_visual?:VisualAdmission;xlsx_visual?:VisualAdmission};

function storedPage(page:number|undefined,count:number){return Math.max(0,Math.min(page??0,Math.max(0,count-1)));}
function Pager({page,count,onChange,label}:{page:number;count:number;onChange:(page:number)=>void;label:string}){
 const language=useApplicationLanguage(),t=useApplicationText();
 return <nav lang={language} aria-label={label} data-chat-search-ignore>
  <button type="button" disabled={page===0} onClick={()=>onChange(page-1)}>{t("上一页","Previous Page")}</button>
  <span>{page+1} / {Math.max(1,count)}</span>
  <button type="button" disabled={page+1>=count} onClick={()=>onChange(page+1)}>{t("下一页","Next Page")}</button>
 </nav>;
}
function cellAddress(column:number,row:number){
 let letters='';
 while(column>0){
  column--;
  letters=String.fromCharCode(65+column%26)+letters;
  column=Math.floor(column/26);
 }
 return letters+row;
}
function spreadsheetReferenceContext(sheet:Extract<OfficeDocumentPreview,{kind:'xlsx'}>['sheets'][number],truncated:boolean,range:ReturnType<typeof cellRangeCoordinates>){
 const matrix=(top:number,left:number,rows:number,columns:number)=>{
  const result:string[][]=[];
  for(let row=0;row<rows;row++){
   const values:string[]=[];
   for(let column=0;column<columns;column++){
    const cell=sheet.cells[cellAddress(left+column,top+row)];
    if(!cell&&truncated)return undefined;
    values.push(cell?.value??'');
   }
   result.push(values);
  }
  return result;
 };
 const headerRows=Math.min(2,range.top-1),top=Math.max(1,range.top-1),left=Math.max(1,range.left-1);
 const headers=headerRows?matrix(range.top-headerRows,range.left,headerRows,Math.min(range.columns,30)):undefined;
 const surroundingValues=matrix(top,left,Math.min(range.bottom-top+2,20,1048576-top+1),Math.min(range.right-left+2,30,16384-left+1));
 return {headers,surroundingValues,incomplete:headerRows>0&&!headers||!surroundingValues};
}
function SpreadsheetContent({value,source,viewingSource,officeFocus}:{value:Extract<OfficeDocumentPreview,{kind:'xlsx'}>;source?:FileReferenceIdentity|undefined;viewingSource?:FileViewingIdentity|undefined;officeFocus?:OfficeCellFocus}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const context=useContext(FileTextReferenceContext),owner=taskDraftScope();
 const root=useRef<HTMLElement>(null),jumped=useRef(false);
 const storageKey=viewingSource?officeViewIdentity(viewingSource,owner,'structured-xlsx'):undefined;
 const stored=useMemo(()=>storageKey&&!officeFocus?readOfficeView(storageKey,owner,'structured-xlsx'):undefined,[storageKey,owner,officeFocus?.key]);
 const saved=stored?.kind==='structured-xlsx'?stored:undefined;
 const ranges=useMemo(()=>officeFocus?.value.reference.locator.ranges.map(cellRangeCoordinates)??[],[officeFocus]);
 const focused=useMemo(()=>{
  if(!officeFocus||!source)return undefined;
  const original=officeFocus.value,ref=original.reference;
  const sameSource=original.owner===owner&&original.conversationId===source.conversationId&&original.runId===source.runId
   &&original.activityId===source.activityId&&original.resultSha===source.resultSha&&original.file.path===source.file.path&&original.file.version===source.file.version&&nativeReferenceIdentity(original.native_source)===nativeReferenceIdentity(source.native_source)&&original.file.sha256===source.file.sha256&&original.file.size===source.file.size;
  const index=value.sheets.findIndex((sheet,index)=>`sheet-${index}`===ref.locator.sheetId&&sheet.name===ref.locator.sheetName);
  if(!sameSource||index<0)return {confirmed:false,index:0,address:''};
  const sheet=value.sheets[index];let confirmed=true;
  for(const snapshot of ref.cells){
   const range=cellRangeCoordinates(snapshot.range);
   for(const [rowIndex,row]of snapshot.displayValues.entries()){
    for(const [columnIndex,display]of row.entries()){
     const cell=sheet.cells[cellAddress(range.left+columnIndex,range.top+rowIndex)];
     if(!cell&&value.truncated||(cell?.value??'')!==display
      ||snapshot.formulas&&(cell?.formula??'')!==snapshot.formulas[rowIndex][columnIndex]
      ||snapshot.rawValues&&(cell&&!Object.hasOwn(cell,'raw_value')||JSON.stringify(cell?cell.raw_value:null)!==JSON.stringify(snapshot.rawValues[rowIndex][columnIndex])))confirmed=false;
    }
   }
  }
  const context=spreadsheetReferenceContext(sheet,value.truncated,cellRangeCoordinates(ref.locator.activeRange));
  if(ref.headers&&JSON.stringify(ref.headers)!==JSON.stringify(context.headers)
   ||ref.surroundingValues&&JSON.stringify(ref.surroundingValues)!==JSON.stringify(context.surroundingValues))confirmed=false;
  return {confirmed,index,address:ref.locator.activeRange.split(':')[0]};
 },[value,source,officeFocus,owner]);
 const [part,setPart]=useState(focused?.index??storedPage(saved?.sheet,value.sheets.length));
 const cells=useMemo(()=>Object.entries(value.sheets[part]?.cells??{}).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})),[value,part]);
 const [page,setPage]=useState(()=>focused?Math.max(0,Math.floor(cells.findIndex(([address])=>address===focused.address)/50)):storedPage(saved?.page,Math.ceil(cells.length/50)));
 const [selected,setSelected]=useState<string[]>([]),[notice,setNotice]=useState('');
 const [rangeDraft,setRangeDraft]=useState(officeFocus?.value.reference.locator.activeRange??saved?.range??'A1:J20');
 const [rangeView,setRangeView]=useState<string|undefined>(()=>{
  if(!officeFocus)return saved?.range;
  const range=officeFocus.value.reference.locator.activeRange;
  return range&&(range.includes(':')||!value.sheets[part]?.cells[range])?range:undefined;
 });
 const [rangeRow,setRangeRow]=useState(()=>storedPage(saved?.rowPage,rangeView?Math.ceil(cellRangeCoordinates(rangeView).rows/20):1)),[rangeColumn,setRangeColumn]=useState(()=>storedPage(saved?.columnPage,rangeView?Math.ceil(cellRangeCoordinates(rangeView).columns/10):1));
 useStructuredOfficeViewState(storageKey,owner,root,{protocol:1,kind:'structured-xlsx',sheet:part,page,rowPage:rangeRow,columnPage:rangeColumn,left:0,...(rangeView?{range:rangeView}:{})},saved?.left);
 const anchor=useRef<{row:number;column:number}|null>(null),drag=useRef<number|undefined>(undefined);
 useEffect(()=>{
  const stop=()=>{drag.current=undefined;};
  window.addEventListener('pointerdown',stop,true);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);window.addEventListener('blur',stop);
  return()=>{window.removeEventListener('pointerdown',stop,true);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);window.removeEventListener('blur',stop);};
 },[]);
 const sheet=value.sheets[part],disabled=!source||!!source.native_source&&!context?.nativeSources?.includes(1)||!context||context.disabled||context.owner!==owner||context.conversationId!==source.conversationId;
 useEffect(()=>{
  if(jumped.current||!focused?.confirmed||part!==focused.index)return;
  const frame=window.requestAnimationFrame(()=>{
   if(taskDraftScope()!==owner||jumped.current)return;
   const target=root.current?.querySelector<HTMLElement>(`[data-office-reference-cell="${focused.address}"]`);
   if(target){target.scrollIntoView({block:'center',inline:'nearest'});jumped.current=true;}
  });
  return()=>window.cancelAnimationFrame(frame);
 },[focused,part,page,rangeView,rangeRow,rangeColumn,owner]);
 const capture=(ranges:string[])=>{
  if(!source||!context||disabled||taskDraftScope()!==owner||!sheet?.name||!ranges.length)return;
  let snapshots:CellRangeSnapshot[];
  let rawUnavailable=false;
  try{
   snapshots=ranges.map(range=>{
    let dimensions:ReturnType<typeof cellRangeCoordinates>;
    try{dimensions=cellRangeCoordinates(range);}catch{throw Error('单元格范围无效，请使用A1或A1:C10等范围。');}
    const rows=Math.min(dimensions.rows,100),columns=Math.min(dimensions.columns,50);
    const displayValues:string[][]=[],formulas:string[][]=[],rawValues:SpreadsheetRawValue[][]=[];
    let rawComplete=true;
    for(let row=0;row<rows;row++){
     const values:string[]=[],expressions:string[]=[],raw:SpreadsheetRawValue[]=[];
     for(let column=0;column<columns;column++){
      const address=cellAddress(dimensions.left+column,dimensions.top+row),cell=sheet.cells[address];
      if(!cell&&value.truncated)throw Error(`当前解析尚未覆盖${address}，无法确认该单元格为空，请缩小范围或读取完整来源。`);
      values.push(cell?.value??'');expressions.push(cell?.formula??'');
      if(cell&&!Object.hasOwn(cell,'raw_value'))rawComplete=false;
      raw.push(cell?.raw_value??null);
     }
     displayValues.push(values);formulas.push(expressions);rawValues.push(raw);
    }
    if(!rawComplete)rawUnavailable=true;
    return {range,displayValues,formulas,...(rawComplete?{rawValues}:{}),rowCount:dimensions.rows,columnCount:dimensions.columns,
     truncated:value.truncated||rows<dimensions.rows||columns<dimensions.columns};
   });
  }catch(error){setNotice(error instanceof Error?error.message:'选区快照尚未完成核对');return;}
  const nearby=spreadsheetReferenceContext(sheet,value.truncated,cellRangeCoordinates(ranges[0]));
  const reference=createCellRangeContentReference({
   source:{relativePath:source.file.path,fileName:source.native_source?source.file.path.split(/[\\/]/).at(-1)!:source.file.path.split('/').at(-1)!,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    revision:{id:source.native_source?.openSha??String(source.file.version),sha256:source.file.sha256,size:source.file.size}},
   renderer:{id:'xlsx',backend:'builtin',locatorQuality:'semantic'},
   locator:{surface:'sheet',sheetId:`sheet-${part}`,sheetName:sheet.name,ranges:[...ranges],activeRange:ranges[0]},
   cells:snapshots,...(nearby.headers?{headers:nearby.headers}:{}),...(nearby.surroundingValues?{surroundingValues:nearby.surroundingValues}:{}),
  });
  if(context.onAdd({conversationId:source.conversationId,runId:source.runId,activityId:source.activityId,resultSha:source.resultSha,...(source.native_source?{native_source:source.native_source,file:{path:source.file.path,sha256:source.file.sha256,size:source.file.size}}:{file:{path:source.file.path,version:source.file.version!,sha256:source.file.sha256,size:source.file.size}}),owner,reference})){
   setSelected([]);setRangeDraft('');anchor.current=null;drag.current=undefined;
   setNotice('单元格引用已加入当前对话草稿。'+(rawUnavailable?' 部分原保存值尚未确认，相关选区未附原值矩阵。':'')+(nearby.incomplete?' 部分上下文尚未覆盖，未附对应上下文矩阵。':''));
  }else setNotice('单元格引用尚未保存，请检查草稿状态或减少选中的内容。');
 };
 const chooseCell=(row:number,column:number,extend:boolean)=>{
  if(!extend||!anchor.current)anchor.current={row,column};
  const start=anchor.current;
  const first=cellAddress(Math.min(start.column,column),Math.min(start.row,row));
  const last=cellAddress(Math.max(start.column,column),Math.max(start.row,row));
  setRangeDraft(first===last?first:first+':'+last);
 };
 const showRange=()=>{
  const range=rangeDraft.trim().toUpperCase();
  try{cellRangeCoordinates(range);}catch{setNotice('单元格范围无效，请使用A1或A1:C10等范围。');return;}
  setRangeView(range);setRangeRow(0);setRangeColumn(0);setNotice('');anchor.current=null;drag.current=undefined;
 };
 const viewport=rangeView?cellRangeCoordinates(rangeView):undefined;
 const pendingRange=useMemo(()=>{
  try{return cellRangeCoordinates(rangeDraft.trim().toUpperCase());}catch{return undefined;}
 },[rangeDraft]);
 return <section lang={language} ref={root} aria-label={t('原工作表单元格','Original Sheet Cells')}>
  {officeFocus&&<p role="status">{focused?.confirmed?(value.truncated||officeFocus.value.reference.cells.some(snapshot=>snapshot.truncated)?t('已核对原引用保存的快照片段，当前解析或原选区存在截断。','Saved fragments of the original reference were verified. The current parse or original selection is truncated.'):t('已核对原引用工作表、保存值、公式及附带的原值与上下文。','The original sheet, saved values, formulas and included original values/context were verified.')):t('原引用选区尚未完成核对，请对照原引用快照。','The original selection has not completed verification. Compare with the original reference snapshot.')}</p>}
  <label>{t('工作表','Sheet')} <select value={part} onChange={event=>{setPart(Number(event.target.value));setPage(0);setSelected([]);setNotice('');setRangeView(undefined);setRangeDraft('A1:J20');setRangeRow(0);setRangeColumn(0);anchor.current=null;drag.current=undefined;}}>
   {value.sheets.map((sheet,index)=><option key={index} value={index}>{sheet.name||t(`工作表 ${index+1}`,`Sheet ${index+1}`)}</option>)}
  </select></label>
  <div data-chat-search-ignore>
   <button type="button" disabled={disabled||!selected.length||!sheet?.name} onClick={()=>capture(selected)}>{t(`引用选中的 ${selected.length} 个单元格`,`Reference ${selected.length} Selected Cells`)}</button>
   <button type="button" disabled={!selected.length&&!rangeDraft.trim()} onClick={()=>{setSelected([]);setRangeDraft('');anchor.current=null;drag.current=undefined;}}>{t('清空选择','Clear Selection')}</button>
   <span>{t('每次最多选择100个单元格，可跨页选择。','Select up to 100 cells at a time, across pages.')}</span>
  </div>
  {notice&&<p role="status">{conversationUiError(notice,language)}</p>}
  <fieldset data-chat-search-ignore>
   <legend>{t('矩形选区','Rectangular Selection')}</legend>
   <label>{t('单元格范围','Cell Range')} <input value={rangeDraft} maxLength={32} onChange={event=>{setRangeDraft(event.target.value);anchor.current=null;drag.current=undefined;}} placeholder="A1:C10"/></label>
   <button type="button" onClick={showRange}>{t('查看范围','View Range')}</button>
   <button type="button" disabled={disabled||!sheet?.name||!rangeDraft.trim()} onClick={()=>capture([rangeDraft.trim().toUpperCase()])}>{t('引用矩形选区','Reference Rectangular Selection')}</button>
   {rangeView&&<button type="button" onClick={()=>{setRangeView(undefined);drag.current=undefined;}}>{t('返回单元格列表','Return to Cell List')}</button>}
   <p>{t('在选区表格中拖选，或用键盘选定起点后按住Shift选择终点。快照最多保留100行、50列，截断状态随引用保存。已确认的原保存值随选区附带，上方行最多2行，周边上下文最多20行、30列。','Drag in the selection table, or choose the start with the keyboard and hold Shift to choose the end. Snapshots retain up to 100 rows and 50 columns, with truncation saved in the reference. Verified original values are included. Context includes up to 2 rows above and up to 20 rows and 30 columns around the selection.')}</p>
  </fieldset>
  {viewport?<>
   <table className="jot-sheet-grid"><caption>{sheet?.name||t('工作表','Sheet')} · {rangeView}</caption>
    <thead><tr><th scope="col">{t('行','Row')}</th>{Array.from({length:Math.min(10,viewport.columns-rangeColumn*10)},(_value,index)=>
     <th scope="col" key={index}>{cellAddress(viewport.left+rangeColumn*10+index,1).replace(/[0-9]+$/,'')}</th>)}</tr></thead>
    <tbody>{Array.from({length:Math.min(20,viewport.rows-rangeRow*20)},(_value,rowIndex)=>{
     const row=viewport.top+rangeRow*20+rowIndex;
     return <tr key={row}><th scope="row">{row}</th>{Array.from({length:Math.min(10,viewport.columns-rangeColumn*10)},(_value,columnIndex)=>{
      const column=viewport.left+rangeColumn*10+columnIndex,address=cellAddress(column,row),cell=sheet?.cells[address];
      const original=focused?.confirmed&&focused.index===part&&ranges.some(range=>column>=range.left&&column<=range.right&&row>=range.top&&row<=range.bottom);
      return <td key={address} data-office-reference-cell={original?address:undefined} style={original?{outline:'2px solid var(--accent)'}:undefined}>
       <button type="button" className="jot-sheet-cell" aria-pressed={!!pendingRange&&column>=pendingRange.left&&column<=pendingRange.right&&row>=pendingRange.top&&row<=pendingRange.bottom} aria-label={`${address} ${cell?.value.slice(0,80)??(value.truncated?t('尚未覆盖','Not Covered Yet'):t('空单元格','Empty Cell'))}`}
        onPointerDown={event=>{if(event.button!==0||!event.isPrimary)return;event.preventDefault();event.currentTarget.focus();drag.current=event.pointerId;chooseCell(row,column,event.shiftKey);}}
        onPointerEnter={event=>{if(drag.current===event.pointerId&&event.buttons===1)chooseCell(row,column,true);}}
        onKeyDown={event=>{
         if(event.key==='Escape'){drag.current=undefined;anchor.current=null;return;}
         if(event.key==='Enter'||event.key===' '){event.preventDefault();chooseCell(row,column,event.shiftKey);}
        }}
        onClick={event=>{if(event.detail===0)chooseCell(row,column,event.shiftKey);}}>
        <span>{address}</span><pre>{cell?.value??(value.truncated?t('尚未覆盖','Not Covered Yet'):'')}</pre>{cell?.formula&&<code>={cell.formula}</code>}
       </button>
      </td>;
     })}</tr>;
    })}</tbody>
   </table>
   <Pager page={rangeRow} count={Math.ceil(viewport.rows/20)} onChange={page=>{setRangeRow(page);drag.current=undefined;}} label={t('矩形选区行翻页','Selection Row Pages')}/>
   <Pager page={rangeColumn} count={Math.ceil(viewport.columns/10)} onChange={page=>{setRangeColumn(page);drag.current=undefined;}} label={t('矩形选区列翻页','Selection Column Pages')}/>
  </>:<>
  <table><caption>{sheet?.name||t('工作表','Sheet')} · {t('单元格与保存的公式','Cells and Saved Formulas')}</caption>
   <thead><tr><th scope="col">{t('引用','Reference')}</th><th scope="col">{t('单元格','Cell')}</th><th scope="col">{t('保存值','Saved Value')}</th><th scope="col">{t('原保存值类型与内容','Original Value Type and Content')}</th><th scope="col">{t('公式','Formula')}</th></tr></thead>
   <tbody>{cells.slice(page*50,(page+1)*50).map(([address,cell])=>{
    const position=cellRangeCoordinates(address);
    const original=focused?.confirmed&&focused.index===part&&ranges.some(range=>position.left>=range.left&&position.left<=range.right&&position.top>=range.top&&position.top<=range.bottom);
    return <tr key={address} data-office-reference-cell={original?address:undefined} style={original?{outline:'2px solid var(--accent)'}:undefined}>
     <td data-chat-search-ignore><input type="checkbox" aria-label={t(`引用 ${sheet?.name??'工作表'} ${address}`,`Reference ${sheet?.name??'Sheet'} ${address}`)} checked={selected.includes(address)}
      disabled={disabled||selected.length>=100&&!selected.includes(address)} onChange={event=>{
       const checked=event.target.checked;
       setSelected(values=>{
        if(!checked)return values.filter(value=>value!==address);
        if(values.includes(address)||values.length>=100)return values;
        return [...values,address];
       });
      }}/></td>
     <th scope="row">{address}</th><td><pre>{cell.value}</pre></td><td><code>{Object.hasOwn(cell,'raw_value')?JSON.stringify(cell.raw_value):t('尚未确认','Unconfirmed')}</code></td><td><code>{cell.formula===null?'':'='+cell.formula}</code></td>
    </tr>;
   })}</tbody>
  </table>
  {!cells.length&&<p>{t('此工作表没有可显示的单元格。','This sheet has no displayable cells.')}</p>}
  <Pager page={page} count={Math.ceil(cells.length/50)} onChange={setPage} label={t('工作表单元格翻页','Sheet Cell Pages')}/>
  </>}
 </section>;
}
function OfficeText({text,match}:{text:string;match?:{start:number;end:number}}){
 if(!match)return <>{text}</>;
 return <>{text.slice(0,match.start)}<mark data-office-reference-text>{text.slice(match.start,match.end)}</mark>{text.slice(match.end)}</>;
}
function OfficeDocumentContent({value,source,viewingSource,officeTextFocus}:{value:Exclude<OfficeDocumentPreview,{kind:'xlsx'}>;source?:FileReferenceIdentity|undefined;viewingSource?:FileViewingIdentity|undefined;officeTextFocus?:OfficeTextFocus}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const root=useRef<HTMLElement>(null),jumped=useRef(false),owner=taskDraftScope();
 const view=useMemo(()=>officeTextView(value),[value]);
 const focused=useMemo(()=>{
  const original=officeTextFocus?.value;if(!original||!source)return undefined;
  if(original.text_view!==1||original.owner!==owner||original.conversationId!==source.conversationId||original.runId!==source.runId
   ||original.activityId!==source.activityId||original.resultSha!==source.resultSha||original.file.path!==source.file.path
   ||original.file.version!==source.file.version||nativeReferenceIdentity(original.native_source)!==nativeReferenceIdentity(source.native_source)||original.file.sha256!==source.file.sha256||original.file.size!==source.file.size)return undefined;
  return resolveOfficeTextReference(view,original.reference);
 },[view,source,owner,officeTextFocus]);
 const viewKind=value.kind==='docx'?'structured-docx':'structured-pptx';
 const storageKey=viewingSource?officeViewIdentity(viewingSource,owner,viewKind):undefined;
 const stored=useMemo(()=>storageKey&&!officeTextFocus?readOfficeView(storageKey,owner,viewKind):undefined,[storageKey,owner,viewKind,officeTextFocus?.key]);
 const saved=stored?.kind==='structured-docx'||stored?.kind==='structured-pptx'?stored:undefined;
 const initialPart=focused?.block.part??storedPage(saved?.part,value.kind==='docx'&&value.tables.length?2:1);
 const initialTable=focused?.block.table??storedPage(saved?.table,value.kind==='docx'?value.tables.length:1);
 const initialRows=value.kind==='docx'?value.tables[initialTable]??[]:[];
 const initialPages=value.kind==='pptx'?Math.ceil(value.slides.length/10):initialPart===0?Math.ceil(value.paragraphs.length/30):Math.ceil(initialRows.length/20);
 const initialColumns=initialRows.reduce((count,row)=>Math.max(count,row.length),0);
 const [part,setPart]=useState(initialPart),[page,setPage]=useState(focused?.block.page??storedPage(saved?.page,initialPages));
 const [column,setColumn]=useState(focused?.block.column??storedPage(saved?.column,Math.ceil(initialColumns/20))),[table,setTable]=useState(initialTable);
 useStructuredOfficeViewState(storageKey,owner,root,{protocol:1,kind:viewKind,part,page,table,column,left:0},saved?.left);
 const changePart=(value:number)=>{setPart(value);setPage(0);setColumn(0);};
 useEffect(()=>{
  if(!focused||jumped.current)return;
  const frame=window.requestAnimationFrame(()=>{
   if(taskDraftScope()!==owner||jumped.current)return;
   const target=root.current?.querySelector<HTMLElement>('[data-office-reference-text]');
   if(target){target.scrollIntoView({block:'center',inline:'nearest'});jumped.current=true;}
  });
  return()=>window.cancelAnimationFrame(frame);
 },[focused,part,page,column,table,owner]);
 const match=(key:string)=>focused?.block.key===key?focused:undefined;
 const rows=value.kind==='docx'?value.tables[table]??[]:[],columns=rows.reduce((count,row)=>Math.max(count,row.length),0);
 return <section lang={language} ref={root} aria-label={t('原Office文档文字','Original Office Document Text')}>
  {source&&<OfficeTextReferenceAction key={`${part}-${page}-${table}-${column}`} root={root} source={source} view={view}/>}
  {officeTextFocus&&<p role="status">{focused?(view.truncated||officeTextFocus.value.reference.truncated?t('已核对原引用文字片段，原解析或引用存在截断。','The original quoted text fragment was verified. The original parse or reference is truncated.'):t('已核对并定位原引用文字。','The original quoted text was verified and located.')):t('原引用文字尚未与当前固定版本的解析结果核对，请对照原引用快照。','The original quoted text has not been verified against the current pinned-version parse. Compare with the original reference snapshot.')}</p>}
  {value.kind==='pptx'?<>
   {value.slides.slice(page*10,(page+1)*10).map(slide=><section key={slide.number} aria-label={t(`幻灯片 ${slide.number}`,`Slide ${slide.number}`)}>
    <h5>{t(`幻灯片 ${slide.number}`,`Slide ${slide.number}`)}</h5><pre data-office-text-block={'slide-'+slide.number}><OfficeText text={slide.text} match={match('slide-'+slide.number)}/></pre>
   </section>)}
   {!value.slides.length&&<p>{t('此演示文稿没有可显示的幻灯片文字。','This presentation has no displayable slide text.')}</p>}
   <Pager page={page} count={Math.ceil(value.slides.length/10)} onChange={setPage} label={t('幻灯片文字翻页','Slide Text Pages')}/>
  </>:<>
   <nav aria-label={t('Word内容分组','Word Content Groups')} data-chat-search-ignore><button type="button" disabled={part===0} onClick={()=>changePart(0)}>{t('段落','Paragraphs')}</button><button type="button" disabled={part===1||!value.tables.length} onClick={()=>changePart(1)}>{t('表格','Tables')}</button></nav>
   {part===0?<>
    {value.paragraphs.slice(page*30,(page+1)*30).map((text,index)=>{
     const key='paragraph-'+(page*30+index);
     return <p key={key} data-office-text-block={key} style={{whiteSpace:'pre-wrap'}}><OfficeText text={text} match={match(key)}/></p>;
    })}
    {!value.paragraphs.length&&<p>{t('此文档没有可显示的段落。','This document has no displayable paragraphs.')}</p>}
    <Pager page={page} count={Math.ceil(value.paragraphs.length/30)} onChange={setPage} label={t('Word段落翻页','Word Paragraph Pages')}/>
   </>:<>
    <label>{t('表格','Table')} <select value={table} onChange={event=>{setTable(Number(event.target.value));setPage(0);setColumn(0);}}>{value.tables.map((_table,index)=><option key={index} value={index}>{t(`表格 ${index+1}`,`Table ${index+1}`)}</option>)}</select></label>
    <table><caption>{t('表格','Table')} {table+1} · {t('列','Columns')} {Math.min(column*20+1,columns)}–{Math.min((column+1)*20,columns)} / {columns}</caption><tbody>
     {rows.slice(page*20,(page+1)*20).map((row,rowIndex)=><tr key={page*20+rowIndex}>{row.slice(column*20,(column+1)*20).map((text,columnIndex)=>{
      const key=`table-${table}-row-${page*20+rowIndex}-column-${column*20+columnIndex}`;
      return <td key={key}><pre data-office-text-block={key}><OfficeText text={text} match={match(key)}/></pre></td>;
     })}</tr>)}
    </tbody></table>
    <Pager page={page} count={Math.ceil(rows.length/20)} onChange={setPage} label={t('Word表格行翻页','Word Table Row Pages')}/>
    <Pager page={column} count={Math.ceil(columns/20)} onChange={setColumn} label={t('Word表格列翻页','Word Table Column Pages')}/>
   </>}
  </>}
 </section>;
}
export function OfficeContent({value,source,officeFocus,officeTextFocus}:{value:OfficeDocumentPreview;source?:FileViewingIdentity|undefined;officeFocus?:OfficeCellFocus;officeTextFocus?:OfficeTextFocus}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const owner=taskDraftScope(),identity=source?officeViewIdentity(source,owner,value.kind==='xlsx'?'structured-xlsx':value.kind==='docx'?'structured-docx':'structured-pptx'):'unbound-'+value.kind;
 const referenceSource=useMemo(()=>source?fileViewingReferenceSource(source):undefined,[identity,source?.file.path,source?.native_source?.proof]),cellFocus=referenceSource?officeFocus:undefined,textFocus=referenceSource?officeTextFocus:undefined;
 const content=value.kind==='xlsx'?<SpreadsheetContent key={JSON.stringify([identity,cellFocus?.key])} value={value} source={referenceSource} viewingSource={source} officeFocus={cellFocus}/>
  :<OfficeDocumentContent key={JSON.stringify([identity,textFocus?.key])} value={value} source={referenceSource} viewingSource={source} officeTextFocus={textFocus}/>;
 return <>{source?.native_source&&!referenceSource&&<p lang={language}>{t("此打开内容没有引用凭据，可阅读和下载；文字与单元格引用暂不可用。","This opened content has no reference credentials. You can read and download it; text and cell references are unavailable.")}</p>}{content}</>;
}

export default function ActivityToolFileOffice(props:ListedFilePreviewSource&{officeFocus?:OfficeCellFocus;officeTextFocus?:OfficeTextFocus;officeRegionFocus?:OfficeRegionFocus;printFocus?:OfficePrintFocus}){
 const language=useApplicationLanguage(),t=useApplicationText();
 const {conversationId,runId,activityId,resultSha,file}=props,owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,runId,activityId,resultSha,file.path,file.version,file.sha256,file.size,props.officeFocus?.key,props.officeTextFocus?.key,props.officeRegionFocus?.key,props.printFocus?.key]);
 const root=useRef<HTMLElement>(null),active=useRef<AbortController|null>(null);
 const [state,setState]=useState<{identity:string;page?:Page;error?:string}>(),[revision,setRevision]=useState(0);
 const [visualState,setVisualState]=useState<{identity:string;enabled:boolean}>();
 const [printSource,setPrintSource]=useState<{identity:string;enabled:boolean}>();
 const [configuredService,setConfiguredService]=useState<{identity:string;service:'builtin'|'libreoffice'}>();
 const native=officePreviewFormat(file.path)?.native===true;
 const nativeFocus=!!(props.officeFocus||props.officeTextFocus||props.officeRegionFocus);
 const print=printSource?.identity===identity?printSource.enabled:!!props.printFocus||!nativeFocus&&configuredService?.identity===identity&&configuredService.service==='libreoffice';
 const [fullscreen,setFullscreen]=useState(false),[displayError,setDisplayError]=useState('');
 const [fullscreenPending,setFullscreenPending]=useState(false),fullscreenRequest=useRef(false);
 const visual=visualState?.identity===identity?visualState.enabled:props.officeFocus?.value.cell_view===2||props.officeTextFocus?.value.text_view===2||!!props.officeRegionFocus;
 useEffect(()=>{
  const changed=()=>setFullscreen(!!root.current&&window.document.fullscreenElement===root.current);
  window.document.addEventListener('fullscreenchange',changed);changed();
  return()=>window.document.removeEventListener('fullscreenchange',changed);
 },[]);
 useEffect(()=>{setDisplayError('');root.current?.focus();root.current?.scrollIntoView({block:'nearest'});},[identity]);
 useEffect(()=>{
  if(print||!native)return;
  const controller=new AbortController();active.current=controller;setState({identity});
  const load=async()=>{
   const format=officePreviewFormat(file.path);
   if(!format)throw Error('此文件类型的Office查看器尚未确认');
   if(file.size>OFFICE_SOURCE_MAX_BYTES)throw Error('此文件超过当前100 MiB结构化预览来源范围，可下载固定版本。');
   const params=new URLSearchParams({run_id:runId,result_sha256:resultSha,path:file.path,version:String(file.version),sha256:file.sha256,size_bytes:String(file.size)});
   const page=await request<Page>(`/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/tool-result/file/document?${params}`,'GET',undefined,undefined,controller.signal,60000);
   controller.signal.throwIfAborted();
   if(taskDraftScope()!==owner||!page||page.document_protocol!==1||page.conversation_id!==conversationId||page.run_id!==runId||page.activity_id!==activityId
    ||page.result_sha256!==resultSha||page.path!==file.path||page.version!==file.version||page.sha256!==file.sha256||page.size!==file.size
    ||!['workspace','isolated'].includes(page.source)||page.media_type!==format.mediaType||page.document?.kind!==format.kind||page.execution_authorized!==false
    ||!page.engine||typeof page.engine.name!=='string'||typeof page.engine.version!=='string')throw Error('原Office文件版本或解析结果尚未确认');
   const document=normalizeOfficePreviewContent(page.media_type,page.document);
   if(!controller.signal.aborted)setState({identity,page:{...page,document}});
  };
  void load().catch(error=>{
   if(controller.signal.aborted)return;
   const message=error instanceof ApiError&&error.status===429?'文档引擎正在处理另一个文件，请稍后重试。'
    :error instanceof ApiError&&error.status===503?'文档引擎暂不可用，或本次解析超时，请重试。'
    :error instanceof Error?error.message:'原Office文件读取失败';
   setState({identity,error:message});
  });
  return()=>{controller.abort();if(active.current===controller)active.current=null;};
 },[identity,revision,print,native]);
 const current=state?.identity===identity?state:undefined;
 const loading=!print&&native&&(!current||!current.page&&!current.error);
 const refresh=()=>{
  if(taskDraftScope()!==owner)return;
  active.current?.abort();setState({identity});setRevision(value=>value+1);
 };
 const toggleFullscreen=async()=>{
  const element=root.current;if(!element||taskDraftScope()!==owner||fullscreenRequest.current)return;
  fullscreenRequest.current=true;setFullscreenPending(true);setDisplayError('');
  try{
   if(window.document.fullscreenElement===element)await window.document.exitFullscreen();else await element.requestFullscreen();
  }catch{if(root.current===element&&taskDraftScope()===owner)setDisplayError('Office全屏暂不可用，请重试。');}
  finally{fullscreenRequest.current=false;if(root.current===element)setFullscreenPending(false);}
 };
 return <section lang={language} ref={root} tabIndex={-1} className="jot-activity-content jot-office-preview" aria-label={t('原Office文件预览','Original Office File Preview')}>
  <h4>{file.path} · {t('版本','Version')} {file.version}</h4>
  <nav aria-label={t('Office查看器工具栏','Office Viewer Toolbar')} data-chat-search-ignore>
   <button type="button" aria-pressed={fullscreen} disabled={fullscreenPending} onClick={()=>void toggleFullscreen()}>{fullscreen?t('退出全屏','Exit Fullscreen'):t('全屏查看Office文件','View Office File Fullscreen')}</button>
   <button type="button" disabled={loading} onClick={refresh}>{t('重新读取固定版本','Read Pinned Version Again')}</button>
   <button type="button" aria-pressed={!print} disabled={!native} onClick={()=>setPrintSource({identity,enabled:false})}>{t("内置Office查看器","Built-In Office Viewer")}</button>
   <button type="button" aria-pressed={print} disabled={loading} onClick={()=>setPrintSource({identity,enabled:true})}>{t('LibreOffice转换PDF','LibreOffice Converted PDF')}</button>
  </nav>
  {displayError&&<p role="alert">{conversationUiError(displayError,language)}</p>}
  <div lang="zh-CN"><OfficePreviewServiceStatus key={identity} owner={owner} onRendererChange={()=>{setPrintSource(undefined);refresh();}} onStatus={value=>setConfiguredService({identity,service:value.service})}/></div>
  <ActivityToolFileBytes {...props}/>
  {!native&&!print&&<p role="status">{t('此文件可通过LibreOffice转换PDF查看，请选择转换入口。','This file can be viewed as a LibreOffice-converted PDF. Select the conversion view.')}</p>}
  {print&&<div lang="zh-CN"><OfficeFilePrintPreview key={identity+':print:'+revision} {...props} focus={props.printFocus}/></div>}
  {loading&&<p role="status">{t('正在核对原版本并解析Office内容…','Verifying the original version and parsing Office content…')} <button type="button" onClick={()=>{active.current?.abort();setState({identity,error:'Office读取已取消'});}}>{t('取消读取','Cancel Reading')}</button></p>}
  {!print&&current?.page&&<>
   <p>{t('原文件结构化内容','Original File Structured Content')} · {current.page.engine.name} {current.page.engine.version}</p>
   {current.page.document.truncated&&<p role="status">{t('结构化解析结果已截断，文字与单元格引用入口有未覆盖部分。可下载原固定版本查看完整文件。','The structured result is truncated. Text and cell references have uncovered parts. Download the original pinned version to inspect the complete file.')}</p>}
   {current.page.document.kind==='xlsx'&&<>
    {props.officeRegionFocus&&(!visual||current.page.xlsx_visual?.ready!==true)&&<p role="status">{t('原工作表截图引用按原生视口状态定位，请打开原生工作簿核对。','The original sheet screenshot reference uses native viewport state. Open the native workbook to verify it.')}</p>}
    {props.officeFocus?.value.cell_view!==2&&props.officeFocus&&visual&&<p role="status">{t('原单元格引用按保存值与公式核对，可切换结构化单元格定位原引用。','Original cell references are verified against saved values and formulas. Switch to structured cells to locate the original reference.')}</p>}
    {props.officeFocus?.value.cell_view===2&&(!visual||current.page.xlsx_visual?.ready!==true)&&<p role="status">{t('原引用使用原生单元格视图，请打开原生工作簿核对原选区。','The original reference uses native cell view. Open the native workbook to verify the original selection.')}</p>}
    <nav aria-label={t('工作簿查看方式','Workbook View Mode')}><button type="button" aria-pressed={!visual} onClick={()=>setVisualState({identity,enabled:false})}>{t('结构化单元格与引用','Structured Cells and References')}</button>
     <button type="button" aria-pressed={visual} disabled={current.page.xlsx_visual?.protocol!==1||current.page.xlsx_visual.ready!==true} onClick={()=>setVisualState({identity,enabled:true})}>{t('原生工作簿视觉内容','Native Workbook Visual Content')}</button></nav>
    {current.page.xlsx_visual?.ready!==true&&<p role="status">{current.page.xlsx_visual?.reason==='source_limit'?t('原工作簿超过当前视觉渲染资源范围。','The original workbook exceeds current visual rendering limits.'):t('原工作簿尚未通过视觉读取检查。','The original workbook has not passed visual read verification.')}</p>}
   </>}
   {current.page.document.kind==='docx'&&<>
    {props.officeRegionFocus&&(!visual||current.page.docx_visual?.ready!==true)&&<p role="status">{t('原Word区域引用按视觉分段定位，请打开Word视觉内容核对原区域。','The original Word region reference uses visual sections. Open Word visual content to verify the original region.')}</p>}
    {props.officeTextFocus?.value.text_view===2&&(!visual||current.page.docx_visual?.ready!==true)&&<p role="status">{t('此原引用使用Word视觉文字定位。请打开Word视觉内容核对原位置；原引用快照仍可查看。','This original reference uses Word visual text locations. Open Word visual content to verify its location. The original reference snapshot remains available.')}</p>}
    <nav aria-label={t('Word查看方式','Word View Mode')}><button type="button" aria-pressed={!visual} onClick={()=>setVisualState({identity,enabled:false})}>{t('结构化文字与引用','Structured Text and References')}</button>
     <button type="button" aria-pressed={visual} disabled={current.page.docx_visual?.protocol!==1||current.page.docx_visual.ready!==true} onClick={()=>setVisualState({identity,enabled:true})}>{t('Word视觉内容','Word Visual Content')}</button></nav>
    {current.page.docx_visual?.ready!==true&&<p role="status">{current.page.docx_visual?.reason==='source_limit'?t('原文件超过当前视觉渲染资源范围。','The original file exceeds current visual rendering limits.'):t('原文件尚未通过视觉读取检查。','The original file has not passed visual read verification.')}</p>}
   </>}
   {current.page.document.kind==='pptx'&&<>
    {props.officeRegionFocus&&(!visual||current.page.pptx_visual?.ready!==true)&&<p role="status">{t('原幻灯片区域引用按视觉坐标定位，请打开幻灯片视觉内容核对原区域。','The original slide region reference uses visual coordinates. Open slide visual content to verify the original region.')}</p>}
    <nav aria-label={t('幻灯片查看方式','Slide View Mode')}><button type="button" aria-pressed={!visual} onClick={()=>setVisualState({identity,enabled:false})}>{t('结构化文字与引用','Structured Text and References')}</button>
     <button type="button" aria-pressed={visual} disabled={current.page.pptx_visual?.protocol!==1||current.page.pptx_visual.ready!==true} onClick={()=>setVisualState({identity,enabled:true})}>{t('幻灯片视觉内容','Slide Visual Content')}</button></nav>
    {current.page.pptx_visual?.ready!==true&&<p role="status">{current.page.pptx_visual?.reason==='source_limit'?t('原幻灯片超过当前视觉渲染资源范围。','The original slides exceed current visual rendering limits.'):t('原幻灯片尚未通过视觉读取检查。','The original slides have not passed visual read verification.')}</p>}
   </>}
   <div lang="zh-CN">{visual&&current.page.document.kind==='xlsx'&&current.page.xlsx_visual?.protocol===1&&current.page.xlsx_visual.ready===true
    ?<ActivityToolFileXlsx key={identity+':'+revision} {...props}/>
    :visual&&current.page.document.kind==='docx'&&current.page.docx_visual?.protocol===1&&current.page.docx_visual.ready===true
    ?<ActivityToolFileDocx key={identity+':'+revision} {...props}/>
    :visual&&current.page.document.kind==='pptx'&&current.page.pptx_visual?.protocol===1&&current.page.pptx_visual.ready===true
    ?<ActivityToolFilePptx key={identity+':'+revision} {...props}/>
    :<section className="jot-office-content" data-chat-search-content={JSON.stringify(['listed-office',identity])}><OfficeContent key={identity+':'+revision} value={current.page.document} source={props} officeFocus={props.officeFocus?.value.cell_view===2?undefined:props.officeFocus} officeTextFocus={props.officeTextFocus?.value.text_view===2?undefined:props.officeTextFocus}/></section>}</div>
  </>}
  {!print&&current?.error&&<p role="alert">{conversationUiError(current.error,language)} <button type="button" onClick={refresh}>{t('重试读取','Retry Reading')}</button></p>}
 </section>;
}
