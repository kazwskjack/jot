// Selection context bounds adapted from PilotDeck 783499ff SpreadsheetInteractivePreview.tsx.
// AGPL-3.0 terms retained at packages/session-adapter/runtime-patches/PILOTDECK-AGPL-3.0.txt.
import OfficeTextReferenceAction from './OfficeTextReferenceAction';
import {officeTextView,resolveOfficeTextReference} from './office-text-reference';
import {cellRangeCoordinates} from '../../packages/gateway/src/messages/content-reference.js';
import {FileTextReferenceContext,type OfficeCellFocus,type OfficeTextFocus,type OfficeRegionFocus} from './FileTextReferences';
import {createCellRangeContentReference,type CellRangeSnapshot} from './vendor/pilotdeck-content-reference';
import './activity-tool-file-office.css';
import React,{useContext,useEffect,useMemo,useRef,useState} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import ActivityToolFileBytes from './ActivityToolFileBytes';
import ActivityToolFileDocx from './ActivityToolFileDocx';
import ActivityToolFilePptx from './ActivityToolFilePptx';
import ActivityToolFileXlsx from './ActivityToolFileXlsx';
import type {ListedFilePreviewSource} from './activity-file-preview-client';
import {officePreviewFormat,normalizeOfficePreviewContent,type OfficeDocumentPreview,type SpreadsheetRawValue} from '../../packages/gateway/src/artifacts/document-preview-content';

type VisualAdmission={protocol:1;ready:boolean;reason?:'source_limit'|'format_invalid'|'source_unverified'};
type Page={document_protocol:1;conversation_id:string;run_id:string;activity_id:string;result_sha256:string;
 path:string;version:number;sha256:string;size:number;source:'workspace'|'isolated';media_type:string;
 document:OfficeDocumentPreview;engine:{name:string;version:string};execution_authorized:false;
 docx_visual?:VisualAdmission;pptx_visual?:VisualAdmission;xlsx_visual?:VisualAdmission};

function Pager({page,count,onChange,label}:{page:number;count:number;onChange:(page:number)=>void;label:string}){
 return <nav aria-label={label} data-chat-search-ignore>
  <button type="button" disabled={page===0} onClick={()=>onChange(page-1)}>上一页</button>
  <span>{page+1} / {Math.max(1,count)}</span>
  <button type="button" disabled={page+1>=count} onClick={()=>onChange(page+1)}>下一页</button>
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
function SpreadsheetContent({value,source,officeFocus}:{value:Extract<OfficeDocumentPreview,{kind:'xlsx'}>;source:ListedFilePreviewSource;officeFocus?:OfficeCellFocus}){
 const context=useContext(FileTextReferenceContext),owner=taskDraftScope();
 const root=useRef<HTMLElement>(null),jumped=useRef(false);
 const ranges=useMemo(()=>officeFocus?.value.reference.locator.ranges.map(cellRangeCoordinates)??[],[officeFocus]);
 const focused=useMemo(()=>{
  if(!officeFocus)return undefined;
  const original=officeFocus.value,ref=original.reference;
  const sameSource=original.owner===owner&&original.conversationId===source.conversationId&&original.runId===source.runId
   &&original.activityId===source.activityId&&original.resultSha===source.resultSha&&original.file.path===source.file.path&&original.file.version===source.file.version&&original.file.sha256===source.file.sha256&&original.file.size===source.file.size;
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
 const [part,setPart]=useState(focused?.index??0);
 const cells=useMemo(()=>Object.entries(value.sheets[part]?.cells??{}).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})),[value,part]);
 const [page,setPage]=useState(()=>Math.max(0,Math.floor(cells.findIndex(([address])=>address===focused?.address)/50)));
 const [selected,setSelected]=useState<string[]>([]),[notice,setNotice]=useState('');
 const [rangeDraft,setRangeDraft]=useState(officeFocus?.value.reference.locator.activeRange??'A1:J20');
 const [rangeView,setRangeView]=useState<string|undefined>(()=>{
  const range=officeFocus?.value.reference.locator.activeRange;
  return range&&(range.includes(':')||!value.sheets[part]?.cells[range])?range:undefined;
 });
 const [rangeRow,setRangeRow]=useState(0),[rangeColumn,setRangeColumn]=useState(0);
 const anchor=useRef<{row:number;column:number}|null>(null),drag=useRef<number|undefined>(undefined);
 useEffect(()=>{
  const stop=()=>{drag.current=undefined;};
  window.addEventListener('pointerdown',stop,true);window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop);window.addEventListener('blur',stop);
  return()=>{window.removeEventListener('pointerdown',stop,true);window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop);window.removeEventListener('blur',stop);};
 },[]);
 const sheet=value.sheets[part],disabled=!context||context.disabled||context.owner!==owner||context.conversationId!==source.conversationId;
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
  if(!context||disabled||taskDraftScope()!==owner||!sheet?.name||!ranges.length)return;
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
   source:{relativePath:source.file.path,fileName:source.file.path.split('/').at(-1)!,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    revision:{id:String(source.file.version),sha256:source.file.sha256,size:source.file.size}},
   renderer:{id:'xlsx',backend:'builtin',locatorQuality:'semantic'},
   locator:{surface:'sheet',sheetId:`sheet-${part}`,sheetName:sheet.name,ranges:[...ranges],activeRange:ranges[0]},
   cells:snapshots,...(nearby.headers?{headers:nearby.headers}:{}),...(nearby.surroundingValues?{surroundingValues:nearby.surroundingValues}:{}),
  });
  if(context.onAdd({conversationId:source.conversationId,runId:source.runId,activityId:source.activityId,resultSha:source.resultSha,file:{path:source.file.path,version:source.file.version,sha256:source.file.sha256,size:source.file.size},owner,reference})){
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
 return <section ref={root} aria-label="原工作表单元格">
  {officeFocus&&<p role="status">{focused?.confirmed?(value.truncated||officeFocus.value.reference.cells.some(snapshot=>snapshot.truncated)?'已核对原引用保存的快照片段，当前解析或原选区存在截断。':'已核对原引用工作表、保存值、公式及附带的原值与上下文。'):'原引用选区尚未完成核对，请对照原引用快照。'}</p>}
  <label>工作表 <select value={part} onChange={event=>{setPart(Number(event.target.value));setPage(0);setSelected([]);setNotice('');setRangeView(undefined);setRangeDraft('A1:J20');setRangeRow(0);setRangeColumn(0);anchor.current=null;drag.current=undefined;}}>
   {value.sheets.map((sheet,index)=><option key={index} value={index}>{sheet.name||`工作表 ${index+1}`}</option>)}
  </select></label>
  <div data-chat-search-ignore>
   <button type="button" disabled={disabled||!selected.length||!sheet?.name} onClick={()=>capture(selected)}>引用选中的 {selected.length} 个单元格</button>
   <button type="button" disabled={!selected.length&&!rangeDraft.trim()} onClick={()=>{setSelected([]);setRangeDraft('');anchor.current=null;drag.current=undefined;}}>清空选择</button>
   <span>每次最多选择100个单元格，可跨页选择。</span>
  </div>
  {notice&&<p role="status">{notice}</p>}
  <fieldset data-chat-search-ignore>
   <legend>矩形选区</legend>
   <label>单元格范围 <input value={rangeDraft} maxLength={32} onChange={event=>{setRangeDraft(event.target.value);anchor.current=null;drag.current=undefined;}} placeholder="A1:C10"/></label>
   <button type="button" onClick={showRange}>查看范围</button>
   <button type="button" disabled={disabled||!sheet?.name||!rangeDraft.trim()} onClick={()=>capture([rangeDraft.trim().toUpperCase()])}>引用矩形选区</button>
   {rangeView&&<button type="button" onClick={()=>{setRangeView(undefined);drag.current=undefined;}}>返回单元格列表</button>}
   <p>在选区表格中拖选，或用键盘选定起点后按住Shift选择终点。快照最多保留100行、50列，截断状态随引用保存。已确认的原保存值随选区附带，上方行最多2行，周边上下文最多20行、30列。</p>
  </fieldset>
  {viewport?<>
   <table className="jot-sheet-grid"><caption>{sheet?.name||'工作表'} · {rangeView}</caption>
    <thead><tr><th scope="col">行</th>{Array.from({length:Math.min(10,viewport.columns-rangeColumn*10)},(_value,index)=>
     <th scope="col" key={index}>{cellAddress(viewport.left+rangeColumn*10+index,1).replace(/[0-9]+$/,'')}</th>)}</tr></thead>
    <tbody>{Array.from({length:Math.min(20,viewport.rows-rangeRow*20)},(_value,rowIndex)=>{
     const row=viewport.top+rangeRow*20+rowIndex;
     return <tr key={row}><th scope="row">{row}</th>{Array.from({length:Math.min(10,viewport.columns-rangeColumn*10)},(_value,columnIndex)=>{
      const column=viewport.left+rangeColumn*10+columnIndex,address=cellAddress(column,row),cell=sheet?.cells[address];
      const original=focused?.confirmed&&focused.index===part&&ranges.some(range=>column>=range.left&&column<=range.right&&row>=range.top&&row<=range.bottom);
      return <td key={address} data-office-reference-cell={original?address:undefined} style={original?{outline:'2px solid var(--accent)'}:undefined}>
       <button type="button" className="jot-sheet-cell" aria-pressed={!!pendingRange&&column>=pendingRange.left&&column<=pendingRange.right&&row>=pendingRange.top&&row<=pendingRange.bottom} aria-label={`${address} ${cell?.value.slice(0,80)??(value.truncated?'尚未覆盖':'空单元格')}`}
        onPointerDown={event=>{if(event.button!==0||!event.isPrimary)return;event.preventDefault();event.currentTarget.focus();drag.current=event.pointerId;chooseCell(row,column,event.shiftKey);}}
        onPointerEnter={event=>{if(drag.current===event.pointerId&&event.buttons===1)chooseCell(row,column,true);}}
        onKeyDown={event=>{
         if(event.key==='Escape'){drag.current=undefined;anchor.current=null;return;}
         if(event.key==='Enter'||event.key===' '){event.preventDefault();chooseCell(row,column,event.shiftKey);}
        }}
        onClick={event=>{if(event.detail===0)chooseCell(row,column,event.shiftKey);}}>
        <span>{address}</span><pre>{cell?.value??(value.truncated?'尚未覆盖':'')}</pre>{cell?.formula&&<code>={cell.formula}</code>}
       </button>
      </td>;
     })}</tr>;
    })}</tbody>
   </table>
   <Pager page={rangeRow} count={Math.ceil(viewport.rows/20)} onChange={page=>{setRangeRow(page);drag.current=undefined;}} label="矩形选区行翻页"/>
   <Pager page={rangeColumn} count={Math.ceil(viewport.columns/10)} onChange={page=>{setRangeColumn(page);drag.current=undefined;}} label="矩形选区列翻页"/>
  </>:<>
  <table><caption>{sheet?.name||'工作表'} · 单元格与保存的公式</caption>
   <thead><tr><th scope="col">引用</th><th scope="col">单元格</th><th scope="col">保存值</th><th scope="col">原保存值类型与内容</th><th scope="col">公式</th></tr></thead>
   <tbody>{cells.slice(page*50,(page+1)*50).map(([address,cell])=>{
    const position=cellRangeCoordinates(address);
    const original=focused?.confirmed&&focused.index===part&&ranges.some(range=>position.left>=range.left&&position.left<=range.right&&position.top>=range.top&&position.top<=range.bottom);
    return <tr key={address} data-office-reference-cell={original?address:undefined} style={original?{outline:'2px solid var(--accent)'}:undefined}>
     <td data-chat-search-ignore><input type="checkbox" aria-label={`引用 ${sheet?.name??'工作表'} ${address}`} checked={selected.includes(address)}
      disabled={disabled||selected.length>=100&&!selected.includes(address)} onChange={event=>{
       const checked=event.target.checked;
       setSelected(values=>{
        if(!checked)return values.filter(value=>value!==address);
        if(values.includes(address)||values.length>=100)return values;
        return [...values,address];
       });
      }}/></td>
     <th scope="row">{address}</th><td><pre>{cell.value}</pre></td><td><code>{Object.hasOwn(cell,'raw_value')?JSON.stringify(cell.raw_value):'尚未确认'}</code></td><td><code>{cell.formula===null?'':'='+cell.formula}</code></td>
    </tr>;
   })}</tbody>
  </table>
  {!cells.length&&<p>此工作表没有可显示的单元格。</p>}
  <Pager page={page} count={Math.ceil(cells.length/50)} onChange={setPage} label="工作表单元格翻页"/>
  </>}
 </section>;
}
function OfficeText({text,match}:{text:string;match?:{start:number;end:number}}){
 if(!match)return <>{text}</>;
 return <>{text.slice(0,match.start)}<mark data-office-reference-text>{text.slice(match.start,match.end)}</mark>{text.slice(match.end)}</>;
}
function OfficeDocumentContent({value,source,officeTextFocus}:{value:Exclude<OfficeDocumentPreview,{kind:'xlsx'}>;source:ListedFilePreviewSource;officeTextFocus?:OfficeTextFocus}){
 const root=useRef<HTMLElement>(null),jumped=useRef(false),owner=taskDraftScope();
 const view=useMemo(()=>officeTextView(value),[value]);
 const focused=useMemo(()=>{
  const original=officeTextFocus?.value;if(!original)return undefined;
  if(original.text_view!==1||original.owner!==owner||original.conversationId!==source.conversationId||original.runId!==source.runId
   ||original.activityId!==source.activityId||original.resultSha!==source.resultSha||original.file.path!==source.file.path
   ||original.file.version!==source.file.version||original.file.sha256!==source.file.sha256||original.file.size!==source.file.size)return undefined;
  return resolveOfficeTextReference(view,original.reference);
 },[view,source,owner,officeTextFocus]);
 const [part,setPart]=useState(focused?.block.part??0),[page,setPage]=useState(focused?.block.page??0);
 const [column,setColumn]=useState(focused?.block.column??0),[table,setTable]=useState(focused?.block.table??0);
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
 return <section ref={root} aria-label="原Office文档文字">
  <OfficeTextReferenceAction key={`${part}-${page}-${table}-${column}`} root={root} source={source} view={view}/>
  {officeTextFocus&&<p role="status">{focused?(view.truncated||officeTextFocus.value.reference.truncated?'已核对原引用文字片段，原解析或引用存在截断。':'已核对并定位原引用文字。'):'原引用文字尚未与当前固定版本的解析结果核对，请对照原引用快照。'}</p>}
  {value.kind==='pptx'?<>
   {value.slides.slice(page*10,(page+1)*10).map(slide=><section key={slide.number} aria-label={`幻灯片 ${slide.number}`}>
    <h5>幻灯片 {slide.number}</h5><pre data-office-text-block={'slide-'+slide.number}><OfficeText text={slide.text} match={match('slide-'+slide.number)}/></pre>
   </section>)}
   {!value.slides.length&&<p>此演示文稿没有可显示的幻灯片文字。</p>}
   <Pager page={page} count={Math.ceil(value.slides.length/10)} onChange={setPage} label="幻灯片文字翻页"/>
  </>:<>
   <nav aria-label="Word内容分组" data-chat-search-ignore><button type="button" disabled={part===0} onClick={()=>changePart(0)}>段落</button><button type="button" disabled={part===1||!value.tables.length} onClick={()=>changePart(1)}>表格</button></nav>
   {part===0?<>
    {value.paragraphs.slice(page*30,(page+1)*30).map((text,index)=>{
     const key='paragraph-'+(page*30+index);
     return <p key={key} data-office-text-block={key} style={{whiteSpace:'pre-wrap'}}><OfficeText text={text} match={match(key)}/></p>;
    })}
    {!value.paragraphs.length&&<p>此文档没有可显示的段落。</p>}
    <Pager page={page} count={Math.ceil(value.paragraphs.length/30)} onChange={setPage} label="Word段落翻页"/>
   </>:<>
    <label>表格 <select value={table} onChange={event=>{setTable(Number(event.target.value));setPage(0);setColumn(0);}}>{value.tables.map((_table,index)=><option key={index} value={index}>表格 {index+1}</option>)}</select></label>
    <table><caption>表格 {table+1} · 列 {Math.min(column*20+1,columns)}–{Math.min((column+1)*20,columns)} / {columns}</caption><tbody>
     {rows.slice(page*20,(page+1)*20).map((row,rowIndex)=><tr key={page*20+rowIndex}>{row.slice(column*20,(column+1)*20).map((text,columnIndex)=>{
      const key=`table-${table}-row-${page*20+rowIndex}-column-${column*20+columnIndex}`;
      return <td key={key}><pre data-office-text-block={key}><OfficeText text={text} match={match(key)}/></pre></td>;
     })}</tr>)}
    </tbody></table>
    <Pager page={page} count={Math.ceil(rows.length/20)} onChange={setPage} label="Word表格行翻页"/>
    <Pager page={column} count={Math.ceil(columns/20)} onChange={setColumn} label="Word表格列翻页"/>
   </>}
  </>}
 </section>;
}
function OfficeContent({value,source,officeFocus,officeTextFocus}:{value:OfficeDocumentPreview;source:ListedFilePreviewSource;officeFocus?:OfficeCellFocus;officeTextFocus?:OfficeTextFocus}){
 if(value.kind==='xlsx')return <SpreadsheetContent value={value} source={source} officeFocus={officeFocus}/>;
 return <OfficeDocumentContent value={value} source={source} officeTextFocus={officeTextFocus}/>;
}

export default function ActivityToolFileOffice(props:ListedFilePreviewSource&{officeFocus?:OfficeCellFocus;officeTextFocus?:OfficeTextFocus;officeRegionFocus?:OfficeRegionFocus}){
 const {conversationId,runId,activityId,resultSha,file}=props,owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,runId,activityId,resultSha,file.path,file.version,file.sha256,file.size,props.officeFocus?.key,props.officeTextFocus?.key,props.officeRegionFocus?.key]);
 const root=useRef<HTMLElement>(null),active=useRef<AbortController|null>(null);
 const [state,setState]=useState<{identity:string;page?:Page;error?:string}>(),[revision,setRevision]=useState(0);
 const [visualState,setVisualState]=useState<{identity:string;enabled:boolean}>();
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
  const controller=new AbortController();active.current=controller;setState({identity});
  const load=async()=>{
   const format=officePreviewFormat(file.path);
   if(!format)throw Error('此文件类型的Office查看器尚未确认');
   if(file.size>20*1024*1024)throw Error('此文件超过当前20 MiB结构化预览范围，可下载固定版本。');
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
 },[identity,revision]);
 const current=state?.identity===identity?state:undefined;
 const loading=!current||!current.page&&!current.error;
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
 return <section ref={root} tabIndex={-1} className="jot-activity-content jot-office-preview" aria-label="原Office文件结构化内容">
  <h4>{file.path} · 版本 {file.version}</h4>
  <nav aria-label="Office查看器工具栏" data-chat-search-ignore>
   <button type="button" aria-pressed={fullscreen} disabled={fullscreenPending} onClick={()=>void toggleFullscreen()}>{fullscreen?'退出全屏':'全屏查看Office文件'}</button>
   <button type="button" disabled={loading} onClick={refresh}>重新读取固定版本</button>
  </nav>
  {displayError&&<p role="alert">{displayError}</p>}
  <ActivityToolFileBytes {...props}/>
  {loading&&<p role="status">正在核对原版本并解析Office内容… <button type="button" onClick={()=>{active.current?.abort();setState({identity,error:'Office读取已取消'});}}>取消读取</button></p>}
  {current?.page&&<>
   <p>原文件结构化内容 · {current.page.engine.name} {current.page.engine.version}</p>
   {current.page.document.truncated&&<p role="status">结构化解析结果已截断，文字与单元格引用入口有未覆盖部分。可下载原固定版本查看完整文件。</p>}
   {current.page.document.kind==='xlsx'&&<>
    {props.officeRegionFocus&&(!visual||current.page.xlsx_visual?.ready!==true)&&<p role="status">原工作表截图引用按原生视口状态定位，请打开原生工作簿核对。</p>}
    {props.officeFocus?.value.cell_view!==2&&props.officeFocus&&visual&&<p role="status">原单元格引用按保存值与公式核对，可切换结构化单元格定位原引用。</p>}
    {props.officeFocus?.value.cell_view===2&&(!visual||current.page.xlsx_visual?.ready!==true)&&<p role="status">原引用使用原生单元格视图，请打开原生工作簿核对原选区。</p>}
    <nav aria-label="工作簿查看方式"><button type="button" aria-pressed={!visual} onClick={()=>setVisualState({identity,enabled:false})}>结构化单元格与引用</button>
     <button type="button" aria-pressed={visual} disabled={current.page.xlsx_visual?.protocol!==1||current.page.xlsx_visual.ready!==true} onClick={()=>setVisualState({identity,enabled:true})}>原生工作簿视觉内容</button></nav>
    {current.page.xlsx_visual?.ready!==true&&<p role="status">{current.page.xlsx_visual?.reason==='source_limit'?'原工作簿超过当前视觉渲染资源范围。':'原工作簿尚未通过视觉读取检查。'}</p>}
   </>}
   {current.page.document.kind==='docx'&&<>
    {props.officeRegionFocus&&(!visual||current.page.docx_visual?.ready!==true)&&<p role="status">原Word区域引用按视觉分段定位，请打开Word视觉内容核对原区域。</p>}
    {props.officeTextFocus?.value.text_view===2&&(!visual||current.page.docx_visual?.ready!==true)&&<p role="status">此原引用使用Word视觉文字定位。请打开Word视觉内容核对原位置；原引用快照仍可查看。</p>}
    <nav aria-label="Word查看方式"><button type="button" aria-pressed={!visual} onClick={()=>setVisualState({identity,enabled:false})}>结构化文字与引用</button>
     <button type="button" aria-pressed={visual} disabled={current.page.docx_visual?.protocol!==1||current.page.docx_visual.ready!==true} onClick={()=>setVisualState({identity,enabled:true})}>Word视觉内容</button></nav>
    {current.page.docx_visual?.ready!==true&&<p role="status">{current.page.docx_visual?.reason==='source_limit'?'原文件超过当前视觉渲染资源范围。':'原文件尚未通过视觉读取检查。'}</p>}
   </>}
   {current.page.document.kind==='pptx'&&<>
    {props.officeRegionFocus&&(!visual||current.page.pptx_visual?.ready!==true)&&<p role="status">原幻灯片区域引用按视觉坐标定位，请打开幻灯片视觉内容核对原区域。</p>}
    <nav aria-label="幻灯片查看方式"><button type="button" aria-pressed={!visual} onClick={()=>setVisualState({identity,enabled:false})}>结构化文字与引用</button>
     <button type="button" aria-pressed={visual} disabled={current.page.pptx_visual?.protocol!==1||current.page.pptx_visual.ready!==true} onClick={()=>setVisualState({identity,enabled:true})}>幻灯片视觉内容</button></nav>
    {current.page.pptx_visual?.ready!==true&&<p role="status">{current.page.pptx_visual?.reason==='source_limit'?'原幻灯片超过当前视觉渲染资源范围。':'原幻灯片尚未通过视觉读取检查。'}</p>}
   </>}
   {visual&&current.page.document.kind==='xlsx'&&current.page.xlsx_visual?.protocol===1&&current.page.xlsx_visual.ready===true
    ?<ActivityToolFileXlsx key={identity+':'+revision} {...props}/>
    :visual&&current.page.document.kind==='docx'&&current.page.docx_visual?.protocol===1&&current.page.docx_visual.ready===true
    ?<ActivityToolFileDocx key={identity+':'+revision} {...props}/>
    :visual&&current.page.document.kind==='pptx'&&current.page.pptx_visual?.protocol===1&&current.page.pptx_visual.ready===true
    ?<ActivityToolFilePptx key={identity+':'+revision} {...props}/>
    :<section className="jot-office-content" data-chat-search-content={JSON.stringify(['listed-office',identity])}><OfficeContent key={identity+':'+revision} value={current.page.document} source={props} officeFocus={props.officeFocus?.value.cell_view===2?undefined:props.officeFocus} officeTextFocus={props.officeTextFocus?.value.text_view===2?undefined:props.officeTextFocus}/></section>}
  </>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={refresh}>重试读取</button></p>}
 </section>;
}
