import {cellRangeCoordinates} from '../../packages/gateway/src/messages/content-reference.js';
import {FileTextReferenceContext,type OfficeCellFocus} from './FileTextReferences';
import {createCellRangeContentReference} from './vendor/pilotdeck-content-reference';
import './activity-tool-file-office.css';
import React,{useContext,useEffect,useMemo,useRef,useState} from 'react';
import {ApiError,request,taskDraftScope} from './client';
import ActivityToolFileBytes from './ActivityToolFileBytes';
import type {ListedFilePreviewSource} from './activity-file-preview-client';
import {officePreviewFormat,normalizeOfficePreviewContent,type OfficeDocumentPreview} from '../../packages/gateway/src/artifacts/document-preview-content';

type Page={document_protocol:1;conversation_id:string;run_id:string;activity_id:string;result_sha256:string;
 path:string;version:number;sha256:string;size:number;source:'workspace'|'isolated';media_type:string;
 document:OfficeDocumentPreview;engine:{name:string;version:string};execution_authorized:false};

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
      ||snapshot.formulas&&(cell?.formula??'')!==snapshot.formulas[rowIndex][columnIndex])confirmed=false;
    }
   }
  }
  return {confirmed,index,address:ref.locator.activeRange.split(':')[0]};
 },[value,source,officeFocus,owner]);
 const [part,setPart]=useState(focused?.index??0);
 const cells=useMemo(()=>Object.entries(value.sheets[part]?.cells??{}).sort(([a],[b])=>a.localeCompare(b,undefined,{numeric:true})),[value,part]);
 const [page,setPage]=useState(()=>Math.max(0,Math.floor(cells.findIndex(([address])=>address===focused?.address)/50)));
 const [selected,setSelected]=useState<string[]>([]),[notice,setNotice]=useState('');
 const sheet=value.sheets[part],disabled=!context||context.disabled||context.owner!==owner||context.conversationId!==source.conversationId;
 useEffect(()=>{
  if(jumped.current||!focused?.confirmed||part!==focused.index)return;
  const target=root.current?.querySelector<HTMLElement>(`[data-office-reference-cell="${focused.address}"]`);
  if(target){target.scrollIntoView({block:'center',inline:'nearest'});jumped.current=true;}
 },[focused,part,page]);
 const capture=()=>{
  if(!context||disabled||taskDraftScope()!==owner||!sheet?.name||!selected.length)return;
  const reference=createCellRangeContentReference({
   source:{relativePath:source.file.path,fileName:source.file.path.split('/').at(-1)!,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    revision:{id:String(source.file.version),sha256:source.file.sha256,size:source.file.size}},
   renderer:{id:'xlsx',backend:'builtin',locatorQuality:'semantic'},
   locator:{surface:'sheet',sheetId:`sheet-${part}`,sheetName:sheet.name,ranges:[...selected],activeRange:selected[0]},
   cells:selected.map(address=>({range:address,displayValues:[[sheet.cells[address].value]],formulas:[[sheet.cells[address].formula??'']],rowCount:1,columnCount:1})),
  });
  if(context.onAdd({conversationId:source.conversationId,runId:source.runId,activityId:source.activityId,resultSha:source.resultSha,file:{path:source.file.path,version:source.file.version,sha256:source.file.sha256,size:source.file.size},owner,reference})){
   setSelected([]);setNotice('单元格引用已加入当前对话草稿。');
  }else setNotice('单元格引用尚未保存，请检查草稿状态或减少选中的内容。');
 };
 return <section ref={root} aria-label="原工作表单元格">
  {officeFocus&&<p role="status">{focused?.confirmed?'已核对原引用工作表、显示值及保存的公式。':'原引用选区尚未完成核对，请对照原引用快照。'}</p>}
  <label>工作表 <select value={part} onChange={event=>{setPart(Number(event.target.value));setPage(0);setSelected([]);setNotice('');}}>
   {value.sheets.map((sheet,index)=><option key={index} value={index}>{sheet.name||`工作表 ${index+1}`}</option>)}
  </select></label>
  <div data-chat-search-ignore>
   <button type="button" disabled={disabled||!selected.length||!sheet?.name} onClick={capture}>引用选中的 {selected.length} 个单元格</button>
   <button type="button" disabled={!selected.length} onClick={()=>setSelected([])}>清空单元格选择</button>
   <span>每次最多选择100个单元格，可跨页选择。</span>
  </div>
  {notice&&<p role="status">{notice}</p>}
  <table><caption>{sheet?.name||'工作表'} · 单元格与保存的公式</caption>
   <thead><tr><th scope="col">引用</th><th scope="col">单元格</th><th scope="col">保存值</th><th scope="col">公式</th></tr></thead>
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
     <th scope="row">{address}</th><td><pre>{cell.value}</pre></td><td><code>{cell.formula===null?'':'='+cell.formula}</code></td>
    </tr>;
   })}</tbody>
  </table>
  {!cells.length&&<p>此工作表没有可显示的单元格。</p>}
  <Pager page={page} count={Math.ceil(cells.length/50)} onChange={setPage} label="工作表单元格翻页"/>
 </section>;
}
function OfficeContent({value,source,officeFocus}:{value:OfficeDocumentPreview;source:ListedFilePreviewSource;officeFocus?:OfficeCellFocus}){
 const [part,setPart]=useState(0),[page,setPage]=useState(0),[column,setColumn]=useState(0),[table,setTable]=useState(0);
 const changePart=(value:number)=>{setPart(value);setPage(0);setColumn(0);};
 if(value.kind==='xlsx')return <SpreadsheetContent value={value} source={source} officeFocus={officeFocus}/>;
 if(value.kind==='pptx')return <>
  {value.slides.slice(page*10,(page+1)*10).map(slide=><section key={slide.number} aria-label={`幻灯片 ${slide.number}`}><h5>幻灯片 {slide.number}</h5><pre>{slide.text}</pre></section>)}
  {!value.slides.length&&<p>此演示文稿没有可显示的幻灯片文字。</p>}
  <Pager page={page} count={Math.ceil(value.slides.length/10)} onChange={setPage} label="幻灯片文字翻页"/>
 </>;
 const rows=value.tables[table]??[],columns=rows.reduce((count,row)=>Math.max(count,row.length),0);
 return <>
  <nav aria-label="Word内容分组" data-chat-search-ignore><button type="button" disabled={part===0} onClick={()=>changePart(0)}>段落</button><button type="button" disabled={part===1||!value.tables.length} onClick={()=>changePart(1)}>表格</button></nav>
  {part===0?<>
   {value.paragraphs.slice(page*30,(page+1)*30).map((text,index)=><p key={page*30+index} style={{whiteSpace:'pre-wrap'}}>{text}</p>)}
   {!value.paragraphs.length&&<p>此文档没有可显示的段落。</p>}
   <Pager page={page} count={Math.ceil(value.paragraphs.length/30)} onChange={setPage} label="Word段落翻页"/>
  </>:<>
   <label>表格 <select value={table} onChange={event=>{setTable(Number(event.target.value));setPage(0);setColumn(0);}}>{value.tables.map((_table,index)=><option key={index} value={index}>表格 {index+1}</option>)}</select></label>
   <table><caption>表格 {table+1} · 列 {Math.min(column*20+1,columns)}–{Math.min((column+1)*20,columns)} / {columns}</caption><tbody>
    {rows.slice(page*20,(page+1)*20).map((row,index)=><tr key={page*20+index}>{row.slice(column*20,(column+1)*20).map((text,index)=><td key={column*20+index}><pre>{text}</pre></td>)}</tr>)}
   </tbody></table>
   <Pager page={page} count={Math.ceil(rows.length/20)} onChange={setPage} label="Word表格行翻页"/>
   <Pager page={column} count={Math.ceil(columns/20)} onChange={setColumn} label="Word表格列翻页"/>
  </>}
 </>;
}

export default function ActivityToolFileOffice(props:ListedFilePreviewSource&{officeFocus?:OfficeCellFocus}){
 const {conversationId,runId,activityId,resultSha,file}=props,owner=taskDraftScope(),identity=JSON.stringify([owner,conversationId,runId,activityId,resultSha,file.path,file.version,file.sha256,file.size,props.officeFocus?.key]);
 const root=useRef<HTMLElement>(null),active=useRef<AbortController|null>(null);
 const [state,setState]=useState<{identity:string;page?:Page;error?:string}>(),[revision,setRevision]=useState(0);
 useEffect(()=>{root.current?.focus();root.current?.scrollIntoView({block:'nearest'});},[identity]);
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
 return <section ref={root} tabIndex={-1} className="jot-activity-content jot-office-preview" aria-label="原Office文件结构化内容">
  <h4>{file.path} · 版本 {file.version}</h4>
  <ActivityToolFileBytes {...props}/>
  {(!current||!current.page&&!current.error)&&<p role="status">正在核对原版本并解析Office内容… <button type="button" onClick={()=>{active.current?.abort();setState({identity,error:'Office读取已取消'});}}>取消读取</button></p>}
  {current?.page&&<>
   <p>原文件结构化内容 · {current.page.engine.name} {current.page.engine.version}</p>
   {current.page.document.truncated&&<p role="status">解析结果已截断，当前内容有未覆盖部分。可下载原固定版本查看完整文件。</p>}
   <section className="jot-office-content" data-chat-search-content={JSON.stringify(['listed-office',identity])}><OfficeContent key={identity+':'+revision} value={current.page.document} source={props} officeFocus={props.officeFocus}/></section>
  </>}
  {current?.error&&<p role="alert">{current.error} <button type="button" onClick={()=>setRevision(value=>value+1)}>重试读取</button></p>}
 </section>;
}
