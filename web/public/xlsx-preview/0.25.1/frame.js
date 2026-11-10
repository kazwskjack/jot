/* Adapted from pinned PilotDeck SpreadsheetInteractivePreview.tsx. See SOURCES.json and LICENSES.txt. */
import {scripts,styles} from './assets.js';
import {createNativeWorkbook} from './workbook.js';
import {createCellReferences} from './cell-references.js';

const parentHost=new URLSearchParams(location.search).get('parent');
if(!parentHost||!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(parentHost))throw Error('XLSX_PARENT_INVALID');
const parentOrigin='http://'+parentHost,content=document.getElementById('content'),status=document.getElementById('status');
const sheetSelect=document.getElementById('sheet'),zoom=document.getElementById('zoom'),cell=document.getElementById('cell');
const query=document.getElementById('query'),counter=document.getElementById('matches'),coverage=document.getElementById('coverage');
let token,started=false,closed=false,busy=false,univer,api,book,selectionListener,activeSheetListener,chain=Promise.resolve();
let workbookData,matches=[],matchIndex=0,searchGeneration=0,searchTimer,zoomPercent=100,cellReferences;
const report=message=>{if(!closed)parent.postMessage({protocol:1,token,...message},parentOrigin);};
const boot=()=>parent.postMessage({type:'jot-xlsx-boot',protocol:1,started},parentOrigin);
const controls=()=>{
 const ready=!!book&&!closed;
 sheetSelect.disabled=!ready||busy;zoom.disabled=!ready||busy;query.disabled=!ready;
 document.getElementById('search').disabled=!ready;
 document.getElementById('match-previous').disabled=!ready||busy||!matches.length;
 document.getElementById('match-next').disabled=!ready||busy||!matches.length;
 cellReferences?.controls();
};
const dispose=()=>{
 if(closed)return;
 closed=true;searchGeneration++;clearTimeout(searchTimer);matches=[];workbookData=undefined;
 cellReferences?.dispose();selectionListener?.dispose();activeSheetListener?.dispose();univer?.dispose();
 book=undefined;api=undefined;univer=undefined;content.replaceChildren();controls();
};
const fail=()=>{report({type:'jot-xlsx-error',code:'XLSX_RENDER_FAILED'});dispose();status.textContent='原生表格读取失败';};
function loadAsset(file,css=false){
 return new Promise((resolve,reject)=>{
  const element=document.createElement(css?'link':'script');
  if(css){element.rel='stylesheet';element.href='./'+file;}
  else{element.nonce=document.querySelector('script[nonce]')?.nonce??'';element.src=file.startsWith('/')?file:'./'+file;}
  element.onload=resolve;element.onerror=()=>reject(Error('XLSX_ASSET_FAILED'));document.head.append(element);
 });
}
function updateCell(worksheet,row=0,column=0){
 const range=worksheet.getRange(row,column);
 cell.textContent=range.getA1Notation()+' '+(range.getFormula()||range.getDisplayValue());
}
const run=action=>{
 chain=chain.then(async()=>{
  if(closed||!book)return;
  busy=true;controls();report({type:'jot-xlsx-work',busy:true});
  try{await action();}finally{busy=false;controls();report({type:'jot-xlsx-work',busy:false});}
 }).catch(fail);
};
function showMatch(delta,generation){
 if(closed||generation!==searchGeneration||!matches.length)return;
 matchIndex=(matchIndex+delta+matches.length)%matches.length;
 const match=matches[matchIndex],worksheet=book.getSheetBySheetId(match.sheetId);
 if(!worksheet)throw Error('XLSX_SEARCH_SHEET_MISSING');
 book.setActiveSheet(worksheet);
 worksheet.zoom(zoomPercent/100);
 worksheet.getRange(match.row,match.column).activate();
 sheetSelect.value=match.sheetId;updateCell(worksheet,match.row,match.column);
 counter.textContent=`${matchIndex+1} / ${matches.length}`;
}
async function search(generation,value){
 if(closed||generation!==searchGeneration)return;
 const normalized=value.trim().toLocaleLowerCase();
 if(value.length>200){counter.textContent='查找文字最多200字符';return;}
 matches=[];matchIndex=0;
 let scannedUnits=0,scannedCells=0,limited=false;
 const data=workbookData,currentBook=book;
 if(normalized){
  // shortcut: bounded display-value search, extend coverage with the larger-source viewer.
  scan:for(const sheetId of data.sheetOrder){
   if(closed||generation!==searchGeneration)return;
   const worksheet=currentBook.getSheetBySheetId(sheetId),sheetData=data.sheets[sheetId];
   if(!worksheet||!sheetData?.cellData)continue;
   for(const rowKey of Object.keys(sheetData.cellData)){
    const row=Number(rowKey),rowData=sheetData.cellData[rowKey];
    if(!Number.isInteger(row)||row<0||row>=sheetData.rowCount||!rowData)continue;
    for(const columnKey of Object.keys(rowData)){
     if(closed||generation!==searchGeneration)return;
     const column=Number(columnKey);
     if(!Number.isInteger(column)||column<0||column>=sheetData.columnCount)continue;
     if(scannedCells>=50000||scannedUnits>=2097152){limited=true;break scan;}
     const display=worksheet.getRange(row,column).getDisplayValue();
     if(typeof display!=='string')throw Error('XLSX_SEARCH_DISPLAY_INVALID');
     const text=display.slice(0,2097152-scannedUnits);
     scannedUnits+=text.length;scannedCells++;
     if(text.length<display.length)limited=true;
     if(text.toLocaleLowerCase().includes(normalized)){
      if(matches.length===2000){limited=true;break scan;}
      matches.push({sheetId,row,column});
     }
     if(scannedCells%250===0)await new Promise(resolve=>requestAnimationFrame(resolve));
    }
   }
  }
 }
 if(closed||generation!==searchGeneration)return;
 coverage.textContent=limited?'搜索达到当前字符、单元格或命中上限，存在未覆盖内容。':'';
 counter.textContent=matches.length?`1 / ${matches.length}`:normalized?'没有匹配':'尚未搜索';
 if(matches.length)showMatch(0,generation);
}
function scheduleSearch(immediate=false){
 const generation=++searchGeneration,value=query.value;
 clearTimeout(searchTimer);matches=[];matchIndex=0;controls();coverage.textContent='';
 counter.textContent=value.trim()?'等待搜索':'尚未搜索';
 searchTimer=setTimeout(()=>run(()=>search(generation,value)),immediate?0:180);
}
query.addEventListener('input',()=>scheduleSearch());
document.getElementById('search').addEventListener('click',()=>scheduleSearch(true));
function moveMatch(delta){const generation=searchGeneration;run(()=>showMatch(delta,generation));}
document.getElementById('match-previous').addEventListener('click',()=>moveMatch(-1));
document.getElementById('match-next').addEventListener('click',()=>moveMatch(1));
document.addEventListener('keydown',event=>{
 if(event.isComposing)return;
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!query.disabled){event.preventDefault();query.focus();query.select();}
 if(event.target===query&&event.key==='Escape'){event.preventDefault();query.value='';scheduleSearch(true);}
 if(event.target===query&&event.key==='Enter'){event.preventDefault();moveMatch(event.shiftKey?-1:1);}
});
sheetSelect.addEventListener('change',()=>{
 const id=sheetSelect.value;
 run(()=>{book.setActiveSheet(id);book.getActiveSheet().zoom(zoomPercent/100);updateCell(book.getActiveSheet());});
});
zoom.addEventListener('change',()=>{
 const value=Number(zoom.value);
 if(Number.isFinite(value)&&value>=25&&value<=300){zoomPercent=value;run(()=>book.getActiveSheet().zoom(value/100));}
 else zoom.value=String(zoomPercent);
});
addEventListener('pagehide',dispose,{once:true});
document.addEventListener('submit',event=>event.preventDefault(),true);
document.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('a'))event.preventDefault();},true);
addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==parentOrigin||!event.data||typeof event.data!=='object'||Array.isArray(event.data))return;
 const value=event.data;
 if(value.type==='jot-xlsx-probe'&&value.protocol===1&&Object.keys(value).length===2){boot();return;}
 if(started&&value.protocol===1&&value.token===token&&Object.keys(value).length===4){cellReferences?.command(value);return;}
 if(started||value.type!=='jot-xlsx-init'||value.protocol!==1||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token)||Object.keys(value).length!==4
  ||!(value.bytes instanceof ArrayBuffer)||value.bytes.byteLength>20*1024*1024)return;
 started=true;token=value.token;status.textContent='正在读取原生表格组件…';
 try{
  await Promise.all(styles.map(file=>loadAsset(file,true)));
  for(const file of scripts){if(closed)return;await loadAsset(file);}
  if(closed)return;
  await loadAsset('/docx-preview/0.4.0/jszip.min.js');
  if(closed)return;
  status.textContent='正在转换原工作簿…';
  const data=await createNativeWorkbook(value.bytes);
  if(closed)return;
  workbookData=data.workbook;
  const core=window.UniverCore,locale=core.LocaleType.ZH_CN;
  const locales=core.mergeLocales(window.UniverDesignZhCN,window.UniverUiZhCN,window.UniverDocsUiZhCN,window.UniverSheetsZhCN,window.UniverSheetsUiZhCN,window.UniverSheetsFormulaUiZhCN,window.UniverSheetsNumfmtUiZhCN);
  univer=new core.Univer({locale,locales:{[locale]:locales},logLevel:core.LogLevel.ERROR});
  univer.registerPlugin(window.UniverEngineRender.UniverRenderEnginePlugin);
  univer.registerPlugin(window.UniverEngineFormula.UniverFormulaEnginePlugin);
  univer.registerPlugin(window.UniverUi.UniverUIPlugin,{container:content,header:false,toolbar:false,footer:false,contextMenu:false,headerMenu:false,disableAutoFocus:true});
  univer.registerPlugin(window.UniverDocs.UniverDocsPlugin);
  univer.registerPlugin(window.UniverDocsUi.UniverDocsUIPlugin);
  univer.registerPlugin(window.UniverSheets.UniverSheetsPlugin);
  univer.registerPlugin(window.UniverSheetsUi.UniverSheetsUIPlugin,{formulaBar:false,footer:false,disableEdit:true,protectedRangeShadow:false});
  univer.registerPlugin(window.UniverSheetsFormula.UniverSheetsFormulaPlugin);
  univer.registerPlugin(window.UniverSheetsFormulaUi.UniverSheetsFormulaUIPlugin);
  univer.registerPlugin(window.UniverSheetsNumfmt.UniverSheetsNumfmtPlugin);
  univer.registerPlugin(window.UniverSheetsNumfmtUi.UniverSheetsNumfmtUIPlugin);
  api=window.UniverCoreFacade.FUniver.newAPI(univer);api.createWorkbook({...data.workbook,locale});book=api.getActiveWorkbook();
  if(!book)throw Error('XLSX_WORKBOOK_MISSING');
  for(const id of data.workbook.sheetOrder){
   const option=document.createElement('option');option.value=id;option.textContent=data.workbook.sheets[id].name;sheetSelect.append(option);
  }
  book.setActiveSheet('sheet-'+data.activeSheetIndex);
  await book.getWorkbookPermission().setReadOnly();
  if(closed)return;
  sheetSelect.value=book.getActiveSheet().getSheetId();updateCell(book.getActiveSheet());
  selectionListener=api.addEvent(api.Event.SelectionChanged,({worksheet,selections})=>{
   if(closed)return;
   cellReferences?.invalidate();const first=selections[0];if(first)updateCell(worksheet,first.startRow,first.startColumn);
  });
  activeSheetListener=api.addEvent(api.Event.ActiveSheetChanged,({activeSheet})=>{if(!closed){cellReferences?.invalidate();sheetSelect.value=activeSheet.getSheetId();updateCell(activeSheet);}});
  cellReferences=createCellReferences({getBook:()=>book,isWorking:()=>busy,report,run});
  controls();status.textContent='原生工作簿已读取。'+data.warnings.map(warning=>warning.message).join(' ');
  report({type:'jot-xlsx-ready',info:{sheets:data.workbook.sheetOrder.length,warnings:data.warnings.length}});
 }catch{if(!closed)fail();}finally{value.bytes=null;}
});
controls();boot();
