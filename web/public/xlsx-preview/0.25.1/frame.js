/* Adapted from pinned PilotDeck SpreadsheetInteractivePreview.tsx. See SOURCES.json and LICENSES.txt. */
import {scripts,styles} from './assets.js';
import {createNativeWorkbook} from './workbook.js';

const parentHost=new URLSearchParams(location.search).get('parent');
if(!parentHost||!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(parentHost))throw Error('XLSX_PARENT_INVALID');
const parentOrigin='http://'+parentHost,content=document.getElementById('content'),status=document.getElementById('status');
const sheetSelect=document.getElementById('sheet'),zoom=document.getElementById('zoom'),cell=document.getElementById('cell');
let token,started=false,closed=false,busy=false,univer,api,book,selectionListener,activeSheetListener,chain=Promise.resolve();
const report=message=>{if(!closed)parent.postMessage({protocol:1,token,...message},parentOrigin);};
const boot=()=>parent.postMessage({type:'jot-xlsx-boot',protocol:1,started},parentOrigin);
const controls=()=>{sheetSelect.disabled=!book||busy||closed;zoom.disabled=!book||busy||closed;};
const dispose=()=>{
 if(closed)return;
 closed=true;selectionListener?.dispose();activeSheetListener?.dispose();univer?.dispose();
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
sheetSelect.addEventListener('change',()=>{
 const id=sheetSelect.value;
 run(()=>{book.setActiveSheet(id);book.getActiveSheet().zoom(Number(zoom.value)/100);updateCell(book.getActiveSheet());});
});
zoom.addEventListener('change',()=>{
 const value=Number(zoom.value);
 if(Number.isFinite(value)&&value>=25&&value<=300)run(()=>book.getActiveSheet().zoom(value/100));
});
addEventListener('pagehide',dispose,{once:true});
document.addEventListener('submit',event=>event.preventDefault(),true);
document.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('a'))event.preventDefault();},true);
addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==parentOrigin||!event.data||typeof event.data!=='object'||Array.isArray(event.data))return;
 const value=event.data;
 if(value.type==='jot-xlsx-probe'&&value.protocol===1&&Object.keys(value).length===2){boot();return;}
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
   const first=selections[0];if(!closed&&first)updateCell(worksheet,first.startRow,first.startColumn);
  });
  activeSheetListener=api.addEvent(api.Event.ActiveSheetChanged,({activeSheet})=>{if(!closed){sheetSelect.value=activeSheet.getSheetId();updateCell(activeSheet);}});
  controls();status.textContent='原生工作簿已读取。'+data.warnings.map(warning=>warning.message).join(' ');
  report({type:'jot-xlsx-ready',info:{sheets:data.workbook.sheetOrder.length,warnings:data.warnings.length}});
 }catch{if(!closed)fail();}finally{value.bytes=null;}
});
controls();boot();
