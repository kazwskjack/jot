/* Adapted from pinned PilotDeck RegionSelectionOverlay.tsx and SpreadsheetInteractivePreview.tsx. See SOURCES.json and LICENSES.txt. */
let engine;
function loadEngine(){
 if(window.html2canvas)return Promise.resolve(window.html2canvas);
 if(!engine)engine=new Promise((resolve,reject)=>{
  const script=document.createElement('script');script.nonce=document.querySelector('script[nonce]')?.nonce??'';
  script.src='/docx-preview/0.4.0/html2canvas.js';
  script.onload=()=>window.html2canvas?resolve(window.html2canvas):reject(Error('截图引擎尚未就绪。'));
  script.onerror=()=>{script.remove();engine=undefined;reject(Error('截图引擎读取失败。'));};document.head.append(script);
 });
 return engine;
}

export function createSpreadsheetRegion({api,content,getBook,isWorking,report,run,notice,onModeChange,onViewRestored}){
 const controller=new AbortController(),options={signal:controller.signal};
 const begin=document.getElementById('region-start'),whole=document.getElementById('region-whole'),cancel=document.getElementById('region-cancel'),status=document.getElementById('region-status');
 const inputs=['x','y','width','height'].map(key=>[key,document.getElementById('region-'+key)]);
 const layer=document.createElement('div'),box=document.createElement('div');
 layer.className='jot-sheet-region-layer';box.className='jot-sheet-region-box';layer.append(box);box.hidden=true;
 layer.setAttribute('data-html2canvas-ignore','true');content.parentElement.append(layer);
 let enabled=false,active=false,capturing=false,restoring=false,disposed=false,serial=0,selection,start,canvas,scrollListener,focusView;
 function view(){
  const sheet=getBook().getActiveSheet(),scroll=sheet.getScrollState(),bounds=content.getBoundingClientRect();
  const stamp={protocol:1,sheetId:sheet.getSheetId(),sheetName:sheet.getSheetName(),width:bounds.width,height:bounds.height,zoom:sheet.getZoom(),
   scroll:{sheetViewStartRow:scroll.sheetViewStartRow,sheetViewStartColumn:scroll.sheetViewStartColumn,offsetX:scroll.offsetX,offsetY:scroll.offsetY}};
  if(!validView(stamp))throw Error('工作表视口尚未就绪。');
  return stamp;
 }
 function validView(stamp){
  const scroll=stamp?.scroll;
  return stamp&&Object.keys(stamp).sort().join(',')==='height,protocol,scroll,sheetId,sheetName,width,zoom'&&stamp.protocol===1
   &&typeof stamp.sheetId==='string'&&stamp.sheetId.length>0&&stamp.sheetId.length<=192&&typeof stamp.sheetName==='string'&&stamp.sheetName.length>0&&stamp.sheetName.length<=512
   &&['width','height'].every(key=>typeof stamp[key]==='number'&&Number.isFinite(stamp[key])&&stamp[key]>0&&stamp[key]<=33554432)
   &&typeof stamp.zoom==='number'&&Number.isFinite(stamp.zoom)&&stamp.zoom>=0.1&&stamp.zoom<=4
   &&scroll&&Object.keys(scroll).sort().join(',')==='offsetX,offsetY,sheetViewStartColumn,sheetViewStartRow'
   &&Number.isSafeInteger(scroll.sheetViewStartRow)&&scroll.sheetViewStartRow>=-1048576&&scroll.sheetViewStartRow<=1048575
   &&Number.isSafeInteger(scroll.sheetViewStartColumn)&&scroll.sheetViewStartColumn>=-16384&&scroll.sheetViewStartColumn<=16383
   &&['offsetX','offsetY'].every(key=>typeof scroll[key]==='number'&&Number.isFinite(scroll[key])&&Math.abs(scroll[key])<=33554432);
 }
 const sameView=(a,b)=>a.sheetId===b.sheetId&&a.sheetName===b.sheetName&&Math.abs(a.width-b.width)<=1&&Math.abs(a.height-b.height)<=1&&Math.abs(a.zoom-b.zoom)<1e-6
  &&a.scroll.sheetViewStartRow===b.scroll.sheetViewStartRow&&a.scroll.sheetViewStartColumn===b.scroll.sheetViewStartColumn
  &&Math.abs(a.scroll.offsetX-b.scroll.offsetX)<=1&&Math.abs(a.scroll.offsetY-b.scroll.offsetY)<=1;
 function controls(){
  const working=isWorking()||capturing;
  begin.disabled=!enabled||working;whole.disabled=!active||working;cancel.disabled=!active&&!capturing;
  layer.style.pointerEvents=active?'auto':'none';
  for(const [key,input]of inputs){input.disabled=!active||working;input.value=String(Math.round((selection?.rect[key]??(key==='width'||key==='height'?1:0))*10000)/100);}
 }
 function clear(){selection=undefined;start=undefined;serial++;box.hidden=true;report({type:'jot-xlsx-region',selection:null});controls();}
 function invalidate(){
  if(disposed||restoring)return;
  if(capturing){report({type:'jot-xlsx-capture-cancel',reason:'viewport_changed'});return;}
  clear();
  if(focusView){focusView=undefined;report({type:'jot-xlsx-region-focus',confirmed:false});}
 }
 function changed(){
  if(disposed||restoring)return;
  if(start){invalidate();return;}
  const original=selection?.view??focusView;if(!original)return;
  try{if(!sameView(view(),original))invalidate();}catch{invalidate();}
 }
 function sheetChanged(){scrollListener?.dispose();scrollListener=getBook().getActiveSheet().onScroll(changed);changed();}
 function draw(rect){box.hidden=false;box.style.left=rect.x*100+'%';box.style.top=rect.y*100+'%';box.style.width=rect.width*100+'%';box.style.height=rect.height*100+'%';}
 function anchorRange(){
  try{
   const sheet=getBook().getActiveSheet(),range=sheet.getSelection()?.getActiveRangeList()[0]?.getRange();if(!range)return;
   const {startRow,startColumn,endRow,endColumn}=range;
   if(![startRow,startColumn,endRow,endColumn].every(Number.isSafeInteger)||startRow<0||startColumn<0||endRow<startRow||endColumn<startColumn||endRow>=1048576||endColumn>=16384)return;
   return sheet.getRange(startRow,startColumn,endRow-startRow+1,endColumn-startColumn+1).getA1Notation();
  }catch{return;}
 }
 function choose(rect){
  try{
   const bounds=content.getBoundingClientRect();if(rect.width*bounds.width<8||rect.height*bounds.height<8)throw Error('区域边长至少需要8个显示像素。');
   const anchor=anchorRange();selection={serial:++serial,rect,view:view(),...(anchor?{anchorRange:anchor}:{})};focusView=undefined;draw(rect);controls();report({type:'jot-xlsx-region',selection});
   notice(status,'已选择工作表视口区域，请在查看器下方确认截图引用。');
  }catch(error){clear();notice(status,error.message);}
 }
 function stop(){
  if(capturing){report({type:'jot-xlsx-capture-cancel',reason:'cancelled'});return;}
  if(focusView){focusView=undefined;report({type:'jot-xlsx-region-focus',confirmed:false});}
  active=false;clear();onModeChange(false);notice(status,'工作表区域已取消。');
 }
 begin.addEventListener('click',()=>{
  if(!enabled||isWorking()||capturing)return;
  if(focusView){focusView=undefined;report({type:'jot-xlsx-region-focus',confirmed:false});}
  active=true;clear();onModeChange(true);notice(status,'在当前工作表视口拖选，或选择整个视口。');
 },options);
 whole.addEventListener('click',()=>{if(active&&!isWorking()&&!capturing)choose({x:0,y:0,width:1,height:1});},options);
 cancel.addEventListener('click',stop,options);
 for(const [key,input]of inputs)input.addEventListener('change',()=>{
  if(!active||isWorking()||capturing)return;
  const value=Number(input.value);if(!Number.isFinite(value))return;
  const rect={...(selection?.rect??{x:0,y:0,width:1,height:1}),[key]:Math.max(0,Math.min(1,value/100))};
  rect.width=Math.min(rect.width,1-rect.x);rect.height=Math.min(rect.height,1-rect.y);choose(rect);
 },options);
 const point=(x,y,bounds)=>({x:Math.max(0,Math.min(1,(x-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(y-bounds.top)/bounds.height))});
 const drag=event=>{
  if(!start||event.pointerId!==start.pointerId)return;
  const end=point(event.clientX,event.clientY,start.bounds);
  return {x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(start.x-end.x),height:Math.abs(start.y-end.y)};
 };
 layer.addEventListener('pointerdown',event=>{
  if(!active||capturing||isWorking()||event.button!==0||!event.isPrimary)return;
  event.preventDefault();clear();const bounds=content.getBoundingClientRect();start={...point(event.clientX,event.clientY,bounds),bounds,pointerId:event.pointerId};layer.setPointerCapture(event.pointerId);
 },options);
 layer.addEventListener('pointermove',event=>{const rect=drag(event);if(rect)draw(rect);},options);
 layer.addEventListener('pointerup',event=>{
  if(start&&start.pointerId!==event.pointerId)return;
  const rect=drag(event);start=undefined;if(layer.hasPointerCapture(event.pointerId))layer.releasePointerCapture(event.pointerId);if(rect)choose(rect);
 },options);
 layer.addEventListener('pointercancel',()=>{if(!capturing)clear();},options);
 layer.addEventListener('wheel',event=>{if(active)event.preventDefault();},{...options,passive:false});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(active||capturing)){event.preventDefault();stop();}},options);
 const resize=new ResizeObserver(changed);resize.observe(content);
 window.addEventListener('resize',changed,options);
 window.addEventListener('scroll',event=>{
  if(event.target instanceof Element&&event.target.closest('header'))return;
  if(active||capturing)invalidate();
 },{...options,capture:true});
 const cleanup=()=>{if(canvas){canvas.width=0;canvas.height=0;canvas=undefined;}for(const frame of document.querySelectorAll('iframe.html2canvas-container'))frame.remove();};
 async function capture(expected){
  if(disposed||!enabled||capturing||!selection||selection.serial!==expected)return;
  const original=selection;
  if(!sameView(view(),original.view)){invalidate();return;}
  capturing=true;box.hidden=true;controls();notice(status,'正在生成工作表视口PNG…');
  const frozen=Array.from(document.querySelectorAll('header button,header input,header select')).filter(node=>node!==cancel).map(node=>({node,disabled:node.disabled}));
  for(const {node} of frozen)node.disabled=true;
  try{
   const render=await loadEngine();await document.fonts?.ready;
   if(disposed)return;
   if(!sameView(view(),original.view))throw Error('工作表视口已变化。');
   const {width:fullWidth,height:fullHeight}=content.getBoundingClientRect(),rect=original.rect;
   const x=rect.x*fullWidth,y=rect.y*fullHeight,width=rect.width*fullWidth,height=rect.height*fullHeight;
   const scale=Math.min(2,Math.max(1,window.devicePixelRatio||1),4096/width,4096/height,Math.sqrt(4194304/(width*height)));
   canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(width*scale));canvas.height=Math.max(1,Math.floor(height*scale));
   await render(content,{canvas,x,y,width,height,scale,backgroundColor:'#ffffff',logging:false,useCORS:false,allowTaint:false,imageTimeout:10000,removeContainer:true,
    ignoreElements:node=>node.tagName==='HEADER'||node===layer||node.classList.contains('jot-native-cell-action')});
   if(disposed)return;
   if(!sameView(view(),original.view))throw Error('工作表视口已变化。');
   const widthPng=canvas.width,heightPng=canvas.height;
   const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('PNG编码失败。')),'image/png'));
   if(disposed)return;
   if(blob.size<1||blob.size>8*1024*1024)throw Error('截图超过当前8 MiB范围。');
   const bytes=await blob.arrayBuffer();if(disposed)return;
   report({type:'jot-xlsx-capture',capture:{selection:original,width:widthPng,height:heightPng,bytes,nearbyText:''}},[bytes]);
   notice(status,'PNG已生成，正在交给原草稿上传入口。');
  }catch(error){if(!disposed){notice(status,error.message);report({type:'jot-xlsx-capture-error',reason:'capture_failed'});}}
  finally{cleanup();capturing=false;if(!disposed){for(const {node,disabled} of frozen)node.disabled=disabled;controls();}}
 }
 async function restore(value){
  let confirmed=false;restoring=true;focusView=undefined;active=false;clear();onModeChange(false);
  try{
   const stamp=value?.view,rect=value?.rect;
   if(!validView(stamp)||!rect||Object.keys(rect).sort().join(',')!=='height,width,x,y'||Object.values(rect).some(number=>typeof number!=='number'||!Number.isFinite(number)||number<0||number>1)||!rect.width||!rect.height||rect.x+rect.width>1+1e-9||rect.y+rect.height>1+1e-9)throw Error('REGION_FOCUS_INVALID');
   const book=getBook(),sheet=book.getSheetBySheetId(stamp.sheetId);
   if(!sheet||sheet.getSheetName()!==stamp.sheetName)throw Error('REGION_SHEET_MISMATCH');
   book.setActiveSheet(sheet);
   if(!await api.executeCommand('sheet.command.set-zoom-ratio',{unitId:book.getId(),subUnitId:stamp.sheetId,zoomRatio:stamp.zoom}))throw Error('REGION_ZOOM_UNCONFIRMED');
   if(!await api.executeCommand('sheet.operation.set-scroll',{unitId:book.getId(),sheetId:stamp.sheetId,...stamp.scroll,duration:0}))throw Error('REGION_SCROLL_UNCONFIRMED');
   await document.fonts?.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   if(disposed)return;
   onViewRestored(sheet.getZoom());
   if(sameView(view(),stamp)){active=false;focusView=stamp;draw(rect);onModeChange(false);confirmed=true;}
  }catch{confirmed=false;}
  finally{restoring=false;}
  if(!disposed)report({type:'jot-xlsx-region-focus',confirmed});
 }
 sheetChanged();controls();
 return {
  controls,sheetChanged,changed,
  get active(){return active;},
  dispose(){disposed=true;controller.abort();scrollListener?.dispose();resize.disconnect();cleanup();layer.remove();selection=undefined;focusView=undefined;},
  command(value){
   if(value.type==='jot-xlsx-region-enable'&&typeof value.enabled==='boolean'){
    enabled=value.enabled;if(!enabled){if(capturing)report({type:'jot-xlsx-capture-cancel',reason:'scope_changed'});else stop();}controls();
   }else if(value.type==='jot-xlsx-region-probe'){
    report({type:'jot-xlsx-region-ready',available:true});if(value.focus)run(()=>restore(value.focus));
   }else if(value.type==='jot-xlsx-capture')run(()=>capture(value.serial));
   else if(value.type==='jot-xlsx-region-clear'&&selection?.serial===value.serial)stop();
  }
 };
}
