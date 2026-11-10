/* Adapted from pinned PilotDeck SpreadsheetInteractivePreview.tsx. See SOURCES.json and LICENSES.txt. */
export function createCellReferences({getBook,isWorking,report,run}){
 const controller=new AbortController(),options={signal:controller.signal};
 const prepare=document.getElementById('cell-prepare'),status=document.getElementById('cell-status');
 const focusRanges=document.getElementById('cell-focus-range'),locate=document.getElementById('cell-locate');
 let enabled=false,disposed=false,serial=0,proposal,focus;
 const controls=()=>{prepare.disabled=!enabled||disposed||isWorking();focusRanges.disabled=!focus||disposed||isWorking();locate.disabled=focusRanges.disabled;};
 const invalidate=()=>{
  if(disposed)return;
  proposal=undefined;serial++;report({type:'jot-xlsx-cells',selection:null});
 };
 const key=value=>JSON.stringify([value.sheetId,value.sheetName,value.ranges,value.activeRange,
  value.cells.map(cell=>[cell.range,cell.displayValues,cell.rawValues,cell.formulas,cell.rowCount,cell.columnCount,cell.truncated]),value.headers,value.surroundingValues]);
 function snapshot(worksheet,selections){
  if(!selections.length||selections.length>100)throw Error('SELECTION_UNAVAILABLE');
  let units=0;
  const count=value=>{units+=JSON.stringify(value).length;if(units>100000)throw Error('SELECTION_TOO_LARGE');return value;};
  const matrix=(top,left,rows,columns,read)=>{
   const result=[];
   for(let row=0;row<rows;row++){
    const values=[];
    for(let column=0;column<columns;column++)values.push(count(read(worksheet.getRange(top+row,left+column))));
    result.push(values);
   }
   return result;
  };
  const cells=selections.map(selection=>{
   const {startRow,endRow,startColumn,endColumn}=selection;
   if(![startRow,endRow,startColumn,endColumn].every(Number.isSafeInteger)||startRow<0||startColumn<0||endRow<startRow||endColumn<startColumn||endRow>=1048576||endColumn>=16384)throw Error('SELECTION_UNAVAILABLE');
   const rowCount=endRow-startRow+1,columnCount=endColumn-startColumn+1,rows=Math.min(rowCount,100),columns=Math.min(columnCount,50);
   const displayValues=[],rawValues=[],formulas=[];
   for(let row=0;row<rows;row++){
    const displays=[],raws=[],expressions=[];
    for(let column=0;column<columns;column++){
     const cell=worksheet.getRange(startRow+row,startColumn+column),display=cell.getDisplayValue(),raw=cell.getValue()??null,formula=cell.getFormula();
     if(typeof display!=='string'||typeof formula!=='string'||raw!==null&&typeof raw!=='boolean'&&typeof raw!=='string'&&!(typeof raw==='number'&&Number.isFinite(raw)))throw Error('SELECTION_UNAVAILABLE');
     displays.push(count(display));raws.push(count(raw));expressions.push(count(formula));
    }
    displayValues.push(displays);rawValues.push(raws);formulas.push(expressions);
   }
   // Numeric range construction preserves finite row/column selections as explicit A1 rectangles.
   return {range:worksheet.getRange(startRow,startColumn,rowCount,columnCount).getA1Notation(),displayValues,rawValues,formulas,rowCount,columnCount,truncated:rows<rowCount||columns<columnCount};
  });
  const first=selections[0],headerRows=Math.min(2,first.startRow),top=Math.max(0,first.startRow-1),left=Math.max(0,first.startColumn-1);
  const display=range=>{const value=range.getDisplayValue();if(typeof value!=='string')throw Error('SELECTION_UNAVAILABLE');return value;};
  const headers=headerRows?matrix(first.startRow-headerRows,first.startColumn,headerRows,Math.min(first.endColumn-first.startColumn+1,30),display):undefined;
  const surroundingValues=matrix(top,left,Math.min(first.endRow-top+2,20,1048576-top),Math.min(first.endColumn-left+2,30,16384-left),display);
  const value={sheetId:worksheet.getSheetId(),sheetName:worksheet.getSheetName(),ranges:cells.map(cell=>cell.range),activeRange:cells[0].range,cells,...(headers?{headers}:{}),surroundingValues};
  if(new Set(value.ranges).size!==value.ranges.length)throw Error('SELECTION_UNAVAILABLE');
  if(JSON.stringify(value).length>100000)throw Error('SELECTION_TOO_LARGE');
  return value;
 }
 const current=()=>{
  const worksheet=getBook().getActiveSheet();
  return snapshot(worksheet,worksheet.getSelection()?.getActiveRangeList().map(range=>range.getRange())??[]);
 };
 const offer=value=>{proposal={serial:++serial,...value};report({type:'jot-xlsx-cells',selection:proposal});status.textContent='原生选区已准备，请在查看器下方确认引用。';};
 const error=code=>{
  invalidate();status.textContent=code==='SELECTION_TOO_LARGE'?'原生选区或上下文超过当前引用范围，请缩小选区。':'当前原生选区尚未就绪，请重新选择。';
  report({type:'jot-xlsx-cell-error',code});
 };
 prepare.addEventListener('click',()=>run(()=>{
  if(!enabled||disposed)return;
  try{offer(current());}catch(cause){error(cause.message==='SELECTION_TOO_LARGE'?'SELECTION_TOO_LARGE':'SELECTION_UNAVAILABLE');}
 }),options);
 function restore(value,rangeIndex=0){
  let confirmed=false;
  try{
   if(!value||JSON.stringify(value).length>100000)throw Error('FOCUS_INVALID');
   const book=getBook(),worksheet=book.getSheetBySheetId(value.sheetId);
   if(!worksheet||worksheet.getSheetName()!==value.sheetName)throw Error('FOCUS_SOURCE_MISMATCH');
   const selections=value.ranges.map(range=>worksheet.getRange(range).getRange());
   if(key(snapshot(worksheet,selections))!==key(value))throw Error('FOCUS_DATA_CHANGED');
   book.setActiveSheet(worksheet);worksheet.getRange(value.ranges[rangeIndex]).activate();
   focus=value;focusRanges.replaceChildren();
   value.ranges.forEach((range,index)=>{const option=document.createElement('option');option.value=String(index);option.textContent=range;focusRanges.append(option);});
   focusRanges.value=String(rangeIndex);confirmed=true;
  }catch{focus=undefined;}
  controls();
  report({type:'jot-xlsx-cell-focus',confirmed});
 }
 locate.addEventListener('click',()=>{if(focus){const value=focus,index=Number(focusRanges.value);run(()=>restore(value,index));}},options);
 return {
  invalidate,controls,
  dispose(){disposed=true;controller.abort();proposal=undefined;focus=undefined;focusRanges.replaceChildren();},
  command(value){
   if(value.type==='jot-xlsx-cell-enable'&&typeof value.enabled==='boolean'){
    enabled=value.enabled;if(!enabled)invalidate();controls();
   }else if(value.type==='jot-xlsx-cell-probe'){
    report({type:'jot-xlsx-cell-ready',available:true});if(value.focus)run(()=>restore(value.focus));
   }else if(value.type==='jot-xlsx-cell-commit')run(()=>{
    if(!enabled||disposed||!proposal||proposal.serial!==value.serial)return;
    try{
     const next=current();
     if(key(next)!==key(proposal)){offer(next);return;}
     report({type:'jot-xlsx-cell-commit-ready',serial:proposal.serial});
    }catch(cause){error(cause.message==='SELECTION_TOO_LARGE'?'SELECTION_TOO_LARGE':'SELECTION_UNAVAILABLE');}
   });
   else if(value.type==='jot-xlsx-cell-added'&&proposal?.serial===value.serial){invalidate();status.textContent='原生选区已交给原草稿入口。';}
   else if(value.type==='jot-xlsx-cell-clear'&&proposal?.serial===value.serial){invalidate();status.textContent='选区确认已取消，请重新准备。';}
  }
 };
}
