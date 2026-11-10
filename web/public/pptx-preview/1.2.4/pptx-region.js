/* Adapted from pinned PilotDeck RegionSelectionOverlay.tsx. See SOURCES.json and LICENSES.txt. */
import {renderSlide} from './pptx-renderer.js';
let engine;
function loadEngine(){
 if(window.html2canvas)return Promise.resolve(window.html2canvas);
 if(!engine)engine=new Promise((resolve,reject)=>{
  const script=document.createElement('script');
  script.nonce=document.querySelector('script[nonce]')?.nonce??'';
  script.src='/docx-preview/0.4.0/html2canvas.js';
  script.onload=()=>window.html2canvas?resolve(window.html2canvas):reject(Error('截图引擎尚未就绪。'));
  script.onerror=()=>{script.remove();engine=undefined;reject(Error('截图引擎读取失败。'));};
  document.head.append(script);
 });
 return engine;
}

export function createPptxRegion({content,getViewer,isWorking,report,run}){
 const controller=new AbortController(),options={signal:controller.signal};
 const captureCharts=new Set();
 const startButton=document.getElementById('region-start'),whole=document.getElementById('region-whole'),cancel=document.getElementById('region-cancel'),status=document.getElementById('region-status');
 const inputs=['x','y','width','height'].map(key=>[key,document.getElementById('region-'+key)]);
 const layer=document.createElement('div'),box=document.createElement('div');
 layer.className='jot-pptx-region-layer';box.className='jot-pptx-region-box';
 layer.setAttribute('data-html2canvas-ignore','true');layer.append(box);box.hidden=true;
 let enabled=false,active=false,capturing=false,disposed=false,selection,start,serial=0,captureHandle,captureRoot,canvas;
 const view=()=>{
  const viewer=getViewer(),data=viewer?.presentationData;
  return data?{protocol:1,slideNumber:viewer.currentSlideIndex+1,width:data.width,height:data.height}:undefined;
 };
 const sameView=(a,b)=>!!a&&!!b&&a.slideNumber===b.slideNumber&&Math.abs(a.width-b.width)<=1&&Math.abs(a.height-b.height)<=1;
 const surface=()=>content.firstElementChild;
 const attach=()=>{const target=surface();if(target&&layer.parentElement!==target)target.append(layer);return target;};
 const send=()=>{if(!disposed)report({type:'jot-pptx-region',selection:selection??null});};
 const controls=()=>{
  const working=capturing||isWorking();
  startButton.disabled=!enabled||working;whole.disabled=!active||working;cancel.disabled=!active&&!capturing;
  layer.style.pointerEvents=active&&!working?'auto':'none';
  for(const [key,input]of inputs){
   input.disabled=!active||working;
   input.value=String(Math.round((selection?.rect[key]??(key==='width'||key==='height'?1:0))*10000)/100);
  }
 };
 const clear=()=>{selection=undefined;start=undefined;serial++;box.hidden=true;send();controls();};
 const draw=rect=>{
  box.hidden=false;
  for(const key of ['x','y','width','height'])box.style[{x:'left',y:'top',width:'width',height:'height'}[key]]=rect[key]*100+'%';
 };
 const choose=rect=>{
  const bounds=attach()?.getBoundingClientRect(),stamp=view();
  if(!bounds||!stamp||[stamp.width,stamp.height].some(value=>!Number.isFinite(value)||value<=0||value>33554432)
   ||rect.width*bounds.width<8||rect.height*bounds.height<8){clear();status.textContent='区域边长至少需要8个显示像素。';return;}
  selection={serial:++serial,rect,view:stamp};draw(rect);send();controls();
  status.textContent='区域已选中，请在查看器下方确认截图引用。';
 };
 const stop=()=>{
  if(capturing){report({type:'jot-pptx-capture-cancel',reason:'cancelled'});return;}
  active=false;clear();status.textContent='截图区域已取消。';
 };
 const invalidate=()=>{
  if(disposed)return;
  if(capturing){report({type:'jot-pptx-capture-cancel',reason:'layout_changed'});return;}
  clear();attach();
 };
 startButton.addEventListener('click',()=>{
  if(!enabled||capturing||isWorking())return;
  active=true;attach();clear();window.getSelection()?.removeAllRanges();
  status.textContent='在当前幻灯片内拖动框选，或选择整张幻灯片。';
 },options);
 whole.addEventListener('click',()=>{if(active&&!capturing&&!isWorking())choose({x:0,y:0,width:1,height:1});},options);
 cancel.addEventListener('click',stop,options);
 for(const [key,input]of inputs)input.addEventListener('change',()=>{
  if(!active||capturing||isWorking())return;
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
  const bounds=surface()?.getBoundingClientRect();if(!bounds)return;
  event.preventDefault();clear();start={...point(event.clientX,event.clientY,bounds),bounds,pointerId:event.pointerId};layer.setPointerCapture(event.pointerId);
 },options);
 layer.addEventListener('pointermove',event=>{const rect=drag(event);if(rect)draw(rect);},options);
 layer.addEventListener('pointerup',event=>{
  if(start&&event.pointerId!==start.pointerId)return;
  const rect=drag(event);start=undefined;
  if(layer.hasPointerCapture(event.pointerId))layer.releasePointerCapture(event.pointerId);
  if(rect)choose(rect);
 },options);
 layer.addEventListener('pointercancel',()=>{if(!capturing)clear();},options);
 const moved=event=>{
  if(!active&&!capturing)return;
  if(event?.target instanceof Element&&event.target.closest('#region-controls'))return;
  invalidate();
 };
 window.addEventListener('scroll',moved,{...options,capture:true});window.addEventListener('resize',moved,options);
 document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(active||capturing)){event.preventDefault();stop();}},options);
 const cleanupCapture=()=>{
  captureHandle?.dispose();captureHandle=undefined;captureRoot?.remove();captureRoot=undefined;
  captureCharts.clear();
  if(canvas){canvas.width=0;canvas.height=0;canvas=undefined;}
  for(const frame of document.querySelectorAll('iframe.html2canvas-container'))frame.remove();
 };
 const capture=async expected=>{
  if(disposed||!enabled||capturing||!selection||selection.serial!==expected)return;
  const original=selection;
  if(!sameView(view(),original.view)){clear();return;}
  capturing=true;controls();status.textContent='正在生成有界幻灯片PNG…';
  try{
   const render=await loadEngine();if(disposed)return;
   captureRoot=document.createElement('div');captureRoot.inert=true;captureRoot.setAttribute('aria-hidden','true');
   captureRoot.style.cssText=`position:fixed;left:-40000000px;top:0;width:${original.view.width}px;height:${original.view.height}px;overflow:hidden;pointer-events:none;`;
   document.body.append(captureRoot);
   const data=getViewer().presentationData;
   captureHandle=renderSlide(data,data.slides[original.view.slideNumber-1],{chartInstances:captureCharts,pdfjs:false});
   if(!captureHandle)throw Error('原生幻灯片截图句柄未就绪。');
   captureRoot.append(captureHandle.element);
   await captureHandle.ready;await document.fonts?.ready;
   if(disposed)return;
   // A fresh native chart starts animated. Recreate only capture-owned charts in their final state.
   for(const chart of captureCharts)if(!chart.isDisposed())chart.setOption({...chart.getOption(),animation:false},{notMerge:true});
   await new Promise(resolve=>requestAnimationFrame(resolve));
   if(disposed)return;
   const element=captureHandle.element,bounds=element.getBoundingClientRect();
   if(!sameView(view(),original.view)||Math.abs(bounds.width-original.view.width)>1||Math.abs(bounds.height-original.view.height)>1)throw Error('原幻灯片尺寸已变化。');
   const rect=original.rect,x=rect.x*bounds.width,y=rect.y*bounds.height,width=rect.width*bounds.width,height=rect.height*bounds.height;
   const scale=Math.min(2,Math.max(1,window.devicePixelRatio||1),4096/width,4096/height,Math.sqrt(4194304/(width*height)));
   canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(width*scale));canvas.height=Math.max(1,Math.floor(height*scale));
   await render(element,{canvas,x,y,width,height,scale,backgroundColor:'#ffffff',logging:false,useCORS:false,allowTaint:false,imageTimeout:10000,removeContainer:true,
    ignoreElements:node=>node.id==='content'||node.id==='thumbnails'||node.tagName==='HEADER'||node.hasAttribute('data-jot-region-controls')});
   if(disposed)return;
   if(!sameView(view(),original.view))throw Error('原幻灯片已变化。');
   const widthPng=canvas.width,heightPng=canvas.height;
   const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('PNG编码失败。')),'image/png'));
   if(disposed)return;
   if(blob.size<1||blob.size>8*1024*1024)throw Error('截图超过当前8 MiB范围。');
   const nearbyText=(element.textContent??'').replace(/\s+/g,' ').trim().slice(0,1000),bytes=await blob.arrayBuffer();
   if(disposed)return;
   report({type:'jot-pptx-capture',capture:{selection:original,width:widthPng,height:heightPng,bytes,nearbyText}},[bytes]);
   status.textContent='PNG已生成，正在交给原草稿上传入口。';
  }catch(error){
   if(!disposed){status.textContent=error instanceof Error?error.message:'区域截图失败。';report({type:'jot-pptx-capture-error',reason:'capture_failed'});}
  }finally{cleanupCapture();capturing=false;if(!disposed)controls();}
 };
 const restore=async focus=>{
  let confirmed=false;
  try{
   const stamp=focus?.view,rect=focus?.rect,viewer=getViewer();
   if(!stamp||Object.keys(stamp).sort().join(',')!=='height,protocol,slideNumber,width'||stamp.protocol!==1||!Number.isSafeInteger(stamp.slideNumber)||stamp.slideNumber<1||stamp.slideNumber>viewer.slideCount
    ||['width','height'].some(key=>!Number.isFinite(stamp[key])||stamp[key]<=0||stamp[key]>33554432)
    ||!rect||Object.keys(rect).sort().join(',')!=='height,width,x,y'||Object.values(rect).some(value=>!Number.isFinite(value)||value<0||value>1)
    ||!rect.width||!rect.height||rect.x+rect.width>1+1e-9||rect.y+rect.height>1+1e-9)throw Error('focus_invalid');
   await viewer.goToSlide(stamp.slideNumber-1);await new Promise(resolve=>requestAnimationFrame(resolve));
   if(disposed)return;
   if(sameView(view(),stamp)){attach();draw(rect);layer.scrollIntoView({block:'center',inline:'center'});confirmed=true;}
  }catch{confirmed=false;}
  if(!disposed)report({type:'jot-pptx-region-focus',confirmed});
 };
 attach();controls();
 return {
  controls,invalidate,
  dispose(){disposed=true;controller.abort();cleanupCapture();layer.remove();},
  command(value){
   if(value.type==='jot-pptx-region-enable'&&typeof value.enabled==='boolean'){
    enabled=value.enabled;
    if(!enabled){if(capturing)report({type:'jot-pptx-capture-cancel',reason:'scope_changed'});else{active=false;clear();}}
    controls();
   }else if(value.type==='jot-pptx-region-probe'){
    report({type:'jot-pptx-region-ready',available:true});send();if(value.focus)run(()=>restore(value.focus));
   }else if(value.type==='jot-pptx-capture')run(()=>capture(value.serial));
   else if(value.type==='jot-pptx-region-clear'&&selection?.serial===value.serial)stop();
  }
 };
}
