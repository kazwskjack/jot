/* Adapted from pinned PilotDeck SpreadsheetInteractivePreview.tsx. See SOURCES.json and LICENSES.txt. */
import {scripts,styles} from './assets.js';
import {createNativeWorkbook} from './workbook.js';
import {createCellReferences} from './cell-references.js';
import {createSpreadsheetRegion} from './region.js';

const parentHost=new URLSearchParams(location.search).get('parent');
if(!parentHost||!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(parentHost))throw Error('XLSX_PARENT_INVALID');
const parentOrigin='http://'+parentHost,content=document.getElementById('content'),status=document.getElementById('status');
// Keep language changes on owned UI nodes, outside document text and view/search state.
let language='zh-CN';
const labels=new Map(),languageListeners=new Set();
let localeTexts;
const refreshLibraryLanguage=()=>{
 if(!api||!localeTexts)return;
 const locale=window.UniverCore.LocaleType.ZH_CN;
 // Translate UI dictionaries under the original data locale; numfmt/formulas also read this locale.
 api.loadLocales(locale,localeTexts[language]);api.setLocale(locale);
};
const getLanguage=()=>language;
const subscribeLanguage=listener=>{languageListeners.add(listener);return()=>{languageListeners.delete(listener);};};
const showLabel=entry=>{
 const text=language==='en'?entry.en:entry.zh;
 if(entry.attribute)entry.element.setAttribute(entry.attribute,text);else entry.element.textContent=text;
};
const ui=(element,zh,en,attribute='')=>{
 let fields=labels.get(element);if(!fields){fields=new Map();labels.set(element,fields);}
 const entry={element,zh,en,attribute};fields.set(attribute,entry);showLabel(entry);
};
for(const element of document.querySelectorAll('[data-jot-ui-en]'))ui(element,element.textContent,element.dataset.jotUiEn);
for(const element of document.querySelectorAll('[data-jot-ui-aria-en]'))ui(element,element.getAttribute('aria-label'),element.dataset.jotUiAriaEn,'aria-label');
const setLanguage=value=>{
 if(language===value)return;language=value;document.documentElement.lang=value;
 for(const fields of labels.values())for(const entry of fields.values())showLabel(entry);
 for(const listener of languageListeners)listener();
 refreshLibraryLanguage();
};
const notices={
 "工作表视图恢复未完成，请手动定位。": "Worksheet view restoration did not complete. Locate the position manually.",
 "原生选区已准备，请在查看器下方确认引用。": "The native selection is ready. Confirm the reference below the viewer.",
 "原生选区或上下文超过当前引用范围，请缩小选区。": "The native selection or context exceeds current reference limits. Select a smaller range.",
 "当前原生选区尚未就绪，请重新选择。": "The current native selection is not ready. Select again.",
 "原生浮动入口尚未就绪，可使用工具栏准备引用。": "The native floating action is not ready. Use the toolbar to prepare a reference.",
 "原生选区已交给原草稿入口。": "The native selection was handed to the original draft entry.",
 "选区确认已取消，请重新准备。": "Selection confirmation was cancelled. Prepare it again.",
 "工作表视口尚未就绪。": "The worksheet viewport is not ready.",
 "区域边长至少需要8个显示像素。": "Region sides must be at least 8 display pixels.",
 "已选择工作表视口区域，请在查看器下方确认截图引用。": "The worksheet viewport region is selected. Confirm the screenshot reference below the viewer.",
 "工作表区域已取消。": "The worksheet region was cancelled.",
 "在当前工作表视口拖选，或选择整个视口。": "Drag within the current worksheet viewport or select the whole viewport.",
 "正在生成工作表视口PNG…": "Generating a worksheet viewport PNG…",
 "截图引擎尚未就绪。": "The screenshot engine is not ready.",
 "截图引擎读取失败。": "Loading the screenshot engine failed.",
 "工作表视口已变化。": "The worksheet viewport changed.",
 "PNG编码失败。": "PNG encoding failed.",
 "截图超过当前8 MiB范围。": "The screenshot exceeds the 8 MiB limit.",
 "PNG已生成，正在交给原草稿上传入口。": "The PNG was generated and is being handed to the original draft upload entry."
};
const notice=(element,message)=>ui(element,message,Object.hasOwn(notices,message)?notices[message]:message);
const warningText=(warning,language)=>{
 if(language!=='zh-CN')return warning.message;
 if(warning.code==='SPREADSHEET_MACROS_NOT_RENDERED')return '交互式预览不会执行工作簿宏。';
 if(warning.code==='SPREADSHEET_IMAGES_NOT_RENDERED'&&Number.isSafeInteger(warning.count)&&warning.count>0)return `交互式预览不显示 ${warning.count} 张内嵌图片。`;
 return warning.message;
};
const sheetSelect=document.getElementById('sheet'),zoom=document.getElementById('zoom'),cell=document.getElementById('cell');
const query=document.getElementById('query'),counter=document.getElementById('matches'),coverage=document.getElementById('coverage');
const batchPrevious=document.getElementById('search-batch-previous'),batchNext=document.getElementById('search-batch-next');
let searchBatch=0,searchStarts=[{sheetIndex:0,rowIndex:0,columnIndex:0}],hasNextSearchBatch=false;
let token,started=false,closed=false,busy=false,univer,api,book,selectionListener,activeSheetListener,chain=Promise.resolve();
let workbookData,matches=[],matchIndex=0,searchGeneration=0,searchTimer,zoomPercent=100,cellReferences,region;
const report=(message,transfer=[])=>{if(!closed)parent.postMessage({protocol:1,token,...message},parentOrigin,transfer);};
let viewEnabled=false,viewTimer,viewScrollListener,viewGeneration=0;
const validView=view=>view&&Object.keys(view).sort().join(',')==='kind,protocol,scroll,sheetId,sheetName,zoom'&&view.protocol===1&&view.kind==='xlsx'
 &&typeof view.sheetId==='string'&&view.sheetId.length>0&&view.sheetId.length<=192&&typeof view.sheetName==='string'&&view.sheetName.length>0&&view.sheetName.length<=512
 &&typeof view.zoom==='number'&&Number.isFinite(view.zoom)&&view.zoom>=0.1&&view.zoom<=4&&view.scroll&&Object.keys(view.scroll).sort().join(',')==='offsetX,offsetY,sheetViewStartColumn,sheetViewStartRow'
 &&Number.isSafeInteger(view.scroll.sheetViewStartRow)&&view.scroll.sheetViewStartRow>=-1048576&&view.scroll.sheetViewStartRow<=1048575
 &&Number.isSafeInteger(view.scroll.sheetViewStartColumn)&&view.scroll.sheetViewStartColumn>=-16384&&view.scroll.sheetViewStartColumn<=16383
 &&['offsetX','offsetY'].every(key=>typeof view.scroll[key]==='number'&&Number.isFinite(view.scroll[key])&&Math.abs(view.scroll[key])<=33554432);
const reportView=()=>{
 clearTimeout(viewTimer);if(!viewEnabled||closed||!book||busy)return;
 const sheet=book.getActiveSheet(),scroll=sheet.getScrollState();
 const view={protocol:1,kind:'xlsx',sheetId:sheet.getSheetId(),sheetName:sheet.getSheetName(),zoom:sheet.getZoom(),
  scroll:{sheetViewStartRow:scroll.sheetViewStartRow,sheetViewStartColumn:scroll.sheetViewStartColumn,offsetX:scroll.offsetX,offsetY:scroll.offsetY}};
 if(validView(view))report({type:'jot-xlsx-view',view});
};
const scheduleView=()=>{clearTimeout(viewTimer);if(viewEnabled)viewTimer=setTimeout(reportView,160);};
const observeViewScroll=()=>{viewScrollListener?.dispose();viewScrollListener=book.getActiveSheet().onScroll(scheduleView);scheduleView();};
window.addEventListener('blur',reportView);
const cancelViewRestore=event=>{if(event.isTrusted){viewGeneration++;}};
for(const type of ['pointerdown','wheel','keydown'])window.addEventListener(type,cancelViewRestore,{capture:true,passive:true});
const restoreView=view=>{
 const generation=++viewGeneration;viewEnabled=true;if(!validView(view)){reportView();return;}
 run(async()=>{
  try{
   if(generation!==viewGeneration)return;
   const sheet=book.getSheetBySheetId(view.sheetId);if(!sheet||sheet.getSheetName()!==view.sheetName)return;
   book.setActiveSheet(sheet);
   if(!await api.executeCommand('sheet.command.set-zoom-ratio',{unitId:book.getId(),subUnitId:view.sheetId,zoomRatio:view.zoom}))throw Error('VIEW_ZOOM_UNCONFIRMED');
   if(closed||generation!==viewGeneration)return;
   if(!await api.executeCommand('sheet.operation.set-scroll',{unitId:book.getId(),sheetId:view.sheetId,...view.scroll,duration:0}))throw Error('VIEW_SCROLL_UNCONFIRMED');
   await document.fonts?.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(closed||generation!==viewGeneration)return;
   zoomPercent=sheet.getZoom()*100;zoom.value=String(zoomPercent);sheetSelect.value=sheet.getSheetId();updateCell(sheet);
  }catch{if(!closed)notice(status,'工作表视图恢复未完成，请手动定位。');}
 });
};
const instance=crypto.randomUUID();
const boot=()=>{if(!closed)parent.postMessage({type:'jot-xlsx-boot',protocol:1,started,instance},parentOrigin);};
const controls=()=>{
 const ready=!!book&&!closed;
 sheetSelect.disabled=!ready||busy;zoom.disabled=!ready||busy;query.disabled=!ready;
 document.getElementById('search').disabled=!ready;
 query.closest('nav').setAttribute('aria-busy',String(busy));
 batchPrevious.disabled=!ready||busy||searchBatch===0;batchNext.disabled=!ready||busy||!hasNextSearchBatch;
 document.getElementById('match-previous').disabled=!ready||busy||!matches.length;
 document.getElementById('match-next').disabled=!ready||busy||!matches.length;
 cellReferences?.controls();
 region?.controls();scheduleView();
};
const dispose=()=>{
 if(closed)return;
 clearTimeout(viewTimer);viewGeneration++;viewScrollListener?.dispose();window.removeEventListener('blur',reportView);for(const type of ['pointerdown','wheel','keydown'])window.removeEventListener(type,cancelViewRestore,true);closed=true;searchGeneration++;clearTimeout(searchTimer);matches=[];searchStarts=[];workbookData=undefined;
 region?.dispose();cellReferences?.dispose();selectionListener?.dispose();activeSheetListener?.dispose();univer?.dispose();
 book=undefined;api=undefined;univer=undefined;content.replaceChildren();controls();
};
const fail=()=>{report({type:'jot-xlsx-error',code:'XLSX_RENDER_FAILED'});dispose();ui(status,'原生表格读取失败','Native spreadsheet reading failed');};
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
 ui(counter,`第 ${searchBatch+1} 批 · ${matchIndex+1} / ${matches.length}`,`Batch ${searchBatch+1} · ${matchIndex+1} / ${matches.length}`);
}
async function search(generation,value,page=0){
 if(closed||generation!==searchGeneration)return;
 const normalized=value.trim().toLocaleLowerCase();
 if(value.length>200){ui(counter,'查找文字最多200字符','Search text is limited to 200 characters');return;}
 matches=[];matchIndex=0;hasNextSearchBatch=false;
 const data=workbookData,currentBook=book,cursor=searchStarts[page],found=[];
 let scannedCells=0,more=false,nextCursor;
 ui(counter,`正在搜索第 ${page+1} 批…`,`Searching batch ${page+1}…`);
 if(normalized){
  scan:for(let sheetIndex=cursor.sheetIndex;sheetIndex<data.sheetOrder.length;sheetIndex++){
   if(closed||generation!==searchGeneration)return;
   const sheetId=data.sheetOrder[sheetIndex];
   const worksheet=currentBook.getSheetBySheetId(sheetId),sheetData=data.sheets[sheetId];
   if(!worksheet||!sheetData?.cellData)continue;
   const rowKeys=Object.keys(sheetData.cellData);
   const firstRow=sheetIndex===cursor.sheetIndex?cursor.rowIndex:0;
   for(let rowIndex=firstRow;rowIndex<rowKeys.length;rowIndex++){
    const rowKey=rowKeys[rowIndex],row=Number(rowKey),rowData=sheetData.cellData[rowKey];
    if(!Number.isInteger(row)||row<0||row>=sheetData.rowCount||!rowData)continue;
    const columnKeys=Object.keys(rowData);
    const firstColumn=sheetIndex===cursor.sheetIndex&&rowIndex===cursor.rowIndex?cursor.columnIndex:0;
    for(let columnIndex=firstColumn;columnIndex<columnKeys.length;columnIndex++){
     if(closed||generation!==searchGeneration)return;
     const column=Number(columnKeys[columnIndex]);
     if(!Number.isInteger(column)||column<0||column>=sheetData.columnCount)continue;
     const display=worksheet.getRange(row,column).getDisplayValue();
     if(typeof display!=='string')throw Error('XLSX_SEARCH_DISPLAY_INVALID');
     scannedCells++;
     if(display.toLocaleLowerCase().includes(normalized)){
      if(found.length===1000){more=true;break scan;}
      found.push({sheetId,row,column});
      // Resume after the last retained cell, including at the end of a sparse row.
      if(found.length===1000)nextCursor={sheetIndex,rowIndex,columnIndex:columnIndex+1};
     }
     if(scannedCells%250===0){
      ui(counter,`正在搜索第 ${page+1} 批 · 已找到 ${found.length} 处`,`Searching batch ${page+1} · ${found.length} matches found`);
      await new Promise(resolve=>setTimeout(resolve,0));
     }
    }
   }
  }
 }
 if(closed||generation!==searchGeneration)return;
 searchStarts.length=page+1;if(more)searchStarts.push(nextCursor);
 searchBatch=page;hasNextSearchBatch=more;matches=found;
 ui(coverage,more?'当前批最多1000处，可继续搜索后续全部已接纳显示值。':normalized?'已搜索至可见工作表末尾。':'',more?'Up to 1000 matches in this batch. Continue to search all remaining admitted display values.':normalized?'Searched to the end of the visible worksheets.':'');
 ui(counter,matches.length?`第 ${page+1} 批 · 1 / ${matches.length}`:normalized?'没有匹配':'尚未搜索',matches.length?`Batch ${page+1} · 1 / ${matches.length}`:normalized?'No matches':'Not searched');
 if(matches.length)showMatch(0,generation);
}
function scheduleSearch(immediate=false){
 const generation=++searchGeneration,value=query.value;
 clearTimeout(searchTimer);matches=[];matchIndex=0;
 searchBatch=0;searchStarts=[{sheetIndex:0,rowIndex:0,columnIndex:0}];hasNextSearchBatch=false;
 controls();ui(coverage,'','');ui(counter,value.trim()?'等待搜索':'尚未搜索',value.trim()?'Waiting to search':'Not searched');
 searchTimer=setTimeout(()=>run(()=>search(generation,value)),immediate?0:180);
}
function changeSearchBatch(delta){
 if(busy||closed||delta<0&&searchBatch===0||delta>0&&!hasNextSearchBatch)return;
 const generation=searchGeneration,value=query.value,page=searchBatch+delta;
 run(()=>search(generation,value,page));
}
batchPrevious.addEventListener('click',()=>changeSearchBatch(-1));
batchNext.addEventListener('click',()=>changeSearchBatch(1));
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
 if(Number.isFinite(value)&&value>=10&&value<=400){zoomPercent=value;run(()=>book.getActiveSheet().zoom(value/100));}
 else zoom.value=String(zoomPercent);
});
addEventListener('pagehide',()=>{reportView();if(started&&!closed)report({type:'jot-xlsx-closed',reason:'pagehide'});dispose();},{once:true});
document.addEventListener('submit',event=>event.preventDefault(),true);
document.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('a'))event.preventDefault();},true);
addEventListener('message',async event=>{
 if(closed||event.source!==parent||event.origin!==parentOrigin||!event.data||typeof event.data!=='object'||Array.isArray(event.data))return;
 const value=event.data;
 if(!started&&value.type==='jot-xlsx-language-preview'&&value.protocol===1&&value.instance===instance
  &&Object.keys(value).sort().join(',')==='instance,language,protocol,type'&&['zh-CN','en'].includes(value.language)){setLanguage(value.language);return;}
 if(started&&value.type==='jot-xlsx-language'&&value.protocol===1&&value.token===token
  &&Object.keys(value).sort().join(',')==='language,protocol,token,type'&&['zh-CN','en'].includes(value.language)){setLanguage(value.language);return;}
 if(value.type==='jot-xlsx-probe'&&value.protocol===1&&Object.keys(value).length===2){boot();return;}
 if(started&&value.protocol===1&&value.token===token&&Object.keys(value).length===4){if(value.type==='jot-xlsx-view-probe'&&book)restoreView(value.view);else{cellReferences?.command(value);region?.command(value);}return;}
 if(started||value.type!=='jot-xlsx-init'||value.protocol!==1||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token)||Object.keys(value).length!==4
  ||!(value.bytes instanceof ArrayBuffer)||value.bytes.byteLength>32*1024*1024)return;
 started=true;token=value.token;ui(status,'正在读取原生表格组件…','Loading native spreadsheet components…');
 try{
  await Promise.all(styles.map(file=>loadAsset(file,true)));
  for(const file of scripts){if(closed)return;await loadAsset(file);}
  if(closed)return;
  await loadAsset('/docx-preview/0.4.0/jszip.min.js');
  if(closed)return;
  ui(status,'正在转换原工作簿…','Converting the original workbook…');
  const data=await createNativeWorkbook(value.bytes);
  if(closed)return;
  workbookData=data.workbook;
  const core=window.UniverCore,locale=core.LocaleType.ZH_CN;
  const locales=core.mergeLocales(window.UniverDesignZhCN,window.UniverUiZhCN,window.UniverDocsUiZhCN,window.UniverSheetsZhCN,window.UniverSheetsUiZhCN,window.UniverSheetsFormulaUiZhCN,window.UniverSheetsNumfmtUiZhCN);
  localeTexts={'zh-CN':locales,en:core.mergeLocales(window.UniverDesignEnUS,window.UniverUiEnUS,window.UniverDocsUiEnUS,window.UniverSheetsEnUS,window.UniverSheetsUiEnUS,window.UniverSheetsFormulaUiEnUS,window.UniverSheetsNumfmtUiEnUS)};
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
  refreshLibraryLanguage();
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
  activeSheetListener=api.addEvent(api.Event.ActiveSheetChanged,({activeSheet})=>{if(!closed){cellReferences?.invalidate();region?.sheetChanged();observeViewScroll();sheetSelect.value=activeSheet.getSheetId();updateCell(activeSheet);}});
  cellReferences=createCellReferences({api,content,getBook:()=>book,isWorking:()=>busy,isRegionActive:()=>!!region?.active,report,run,notice,getLanguage,subscribeLanguage});
  region=createSpreadsheetRegion({api,content,getBook:()=>book,isWorking:()=>busy,report,run,notice,
   onModeChange:()=>{cellReferences.invalidate();controls();},onViewRestored:ratio=>{zoomPercent=ratio*100;zoom.value=String(zoomPercent);}});
  observeViewScroll();controls();ui(status,'原生工作簿已读取。'+data.warnings.map(warning=>warningText(warning,'zh-CN')).join(' '),'Native workbook read. '+data.warnings.map(warning=>warningText(warning,'en')).join(' '));
  report({type:'jot-xlsx-ready',info:{sheets:data.workbook.sheetOrder.length,warnings:data.warnings.length}});
 }catch{if(!closed)fail();}finally{value.bytes=null;}
});
controls();boot();
