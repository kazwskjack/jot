/* Adapted from pinned PilotDeck RegionSelectionOverlay.tsx. See SOURCES.json and LICENSES.txt. */
(() => {
 'use strict';
 let engine;
 const loadEngine=()=>{
  if(window.html2canvas)return Promise.resolve(window.html2canvas);
  if(engine)return engine;
  engine=new Promise((resolve,reject)=>{
   const script=document.createElement('script');script.nonce=document.querySelector('script[nonce]')?.nonce??'';script.src='./html2canvas.js';
   script.onload=()=>window.html2canvas?resolve(window.html2canvas):reject(Error('截图引擎尚未就绪。'));
   script.onerror=()=>{script.remove();engine=undefined;reject(Error('截图引擎读取失败，请重试。'));};document.head.append(script);
  });return engine;
 };
 const sameView=(a,b)=>Math.abs(a.width-b.width)<=1&&Math.abs(a.height-b.height)<=1;
 window.JotWordRegion=({content,report,isWorking=()=>false,onCaptureStart=()=>{}})=>{
  const wrapper=content.querySelector('.jot-docx-wrapper')??content,sections=Array.from(content.querySelectorAll('section.jot-docx'));
  let surface=sections[0];
  const startButton=document.getElementById('region-start'),whole=document.getElementById('region-whole'),cancel=document.getElementById('region-cancel'),status=document.getElementById('region-status');
  const inputs=['x','y','width','height'].map(key=>[key,document.getElementById('region-'+key)]);
  if(!surface){status.textContent='此文档没有可截图分段。';return {command(value){if(value.type==='jot-docx-region-probe'){report({type:'jot-docx-region-ready',available:false});if(value.focus)report({type:'jot-docx-region-focus',confirmed:false});}}};}
  const box=document.createElement('div');box.className='jot-word-region-box';box.setAttribute('data-html2canvas-ignore','true');box.hidden=true;surface.append(box);
  let enabled=false,active=false,busy=false,start,selection,serial=0,confirmed;
  const zoom=()=>Number.parseFloat(content.style.zoom)||1;
  const view=bounds=>({protocol:1,section:sections.indexOf(surface)+1,width:bounds.width/zoom(),height:bounds.height/zoom()});
  const send=()=>report({type:'jot-docx-region',selection:selection??null});
  const controls=()=>{
   startButton.disabled=!enabled||busy||isWorking();whole.disabled=!active||busy||isWorking();cancel.disabled=!active&&!busy;
   for(const [key,input]of inputs){input.disabled=!active||busy||isWorking();input.value=String(Math.round((selection?.rect[key]??(key==='width'||key==='height'?1:0))*10000)/100);}
  };
  const clear=()=>{start=undefined;selection=undefined;box.hidden=true;serial++;send();controls();};
  const draw=rect=>{
   box.hidden=false;box.style.left=rect.x*100+'%';box.style.top=rect.y*100+'%';box.style.width=rect.width*100+'%';box.style.height=rect.height*100+'%';
  };
  const choose=rect=>{
   const bounds=surface.getBoundingClientRect(),stamp=view(bounds);
   if(!Number.isFinite(stamp.width)||!Number.isFinite(stamp.height)||stamp.width<=0||stamp.height<=0||stamp.width>33554432||stamp.height>33554432
    ||rect.width*bounds.width<8||rect.height*bounds.height<8){clear();status.textContent='区域边长至少需要8个显示像素，文档尺寸须在当前范围内。';return;}
   selection={serial:++serial,rect,view:stamp};draw(rect);controls();status.textContent='区域已选中，请在查看器下方确认截图引用。';send();
  };
  const stop=()=>{
   if(busy){report({type:'jot-docx-capture-cancel',reason:'cancelled'});return;}
   active=false;wrapper.style.touchAction='';clear();status.textContent='截图区域已取消。';
  };
  startButton.addEventListener('click',()=>{if(!enabled||busy||isWorking())return;active=true;wrapper.style.touchAction='none';window.getSelection()?.removeAllRanges();clear();status.textContent='在Word分段内拖动框选，或选择当前可见分段。';});
  whole.addEventListener('click',()=>{
   if(!active||busy||isWorking())return;
   const top=document.getElementById('toolbar').getBoundingClientRect().bottom;
   surface=sections.find(section=>{const bounds=section.getBoundingClientRect();return bounds.bottom>top&&bounds.top<window.innerHeight;})??surface;surface.append(box);choose({x:0,y:0,width:1,height:1});
  });cancel.addEventListener('click',stop);
  for(const [key,input]of inputs)input.addEventListener('change',()=>{
   if(!active||busy||isWorking())return;const value=Number(input.value);if(!Number.isFinite(value))return;
   const rect={...(selection?.rect??{x:0,y:0,width:1,height:1}),[key]:Math.max(0,Math.min(1,value/100))};rect.width=Math.min(rect.width,1-rect.x);rect.height=Math.min(rect.height,1-rect.y);choose(rect);
  });
  const fromPoint=(x,y,bounds)=>({x:Math.max(0,Math.min(1,(x-bounds.left)/bounds.width)),y:Math.max(0,Math.min(1,(y-bounds.top)/bounds.height))});
  const drag=event=>{
   if(!start||event.pointerId!==start.pointerId)return;const end=fromPoint(event.clientX,event.clientY,start.bounds);
   return {x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(start.x-end.x),height:Math.abs(start.y-end.y)};
  };
  wrapper.addEventListener('pointerdown',event=>{
   if(!active||busy||isWorking()||event.button!==0||!event.isPrimary)return;
   const section=event.target instanceof Element?event.target.closest('section.jot-docx'):null;if(!section||!sections.includes(section))return;
   event.preventDefault();clear();surface=section;surface.append(box);const bounds=surface.getBoundingClientRect();start={...fromPoint(event.clientX,event.clientY,bounds),bounds,pointerId:event.pointerId};wrapper.setPointerCapture(event.pointerId);
  });
  wrapper.addEventListener('pointermove',event=>{const rect=drag(event);if(rect)draw(rect);});
  wrapper.addEventListener('pointerup',event=>{if(start&&event.pointerId!==start.pointerId)return;const rect=drag(event);start=undefined;if(wrapper.hasPointerCapture(event.pointerId))wrapper.releasePointerCapture(event.pointerId);if(rect)choose(rect);});
  wrapper.addEventListener('pointercancel',()=>{if(!busy)clear();});
  const moved=event=>{if(busy||!active||event?.target instanceof Element&&event.target.closest('#region-controls'))return;clear();status.textContent='文档位置已变化，请重新选择区域。';};
  window.addEventListener('scroll',moved,true);window.addEventListener('resize',moved);
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(active||busy)){event.preventDefault();stop();}});
  const capture=async expected=>{
   if(!enabled||busy||!selection||selection.serial!==expected)return;
   if(isWorking()){report({type:'jot-docx-capture-error',reason:'capture_failed'});return;}
   onCaptureStart();
   const original=selection;busy=true;box.hidden=true;controls();status.textContent='正在生成有界PNG截图…';
   const old={zoom:content.style.zoom,width:surface.style.width,minWidth:surface.style.minWidth},replaced=[];let canvas;
   const frozen=Array.from(document.querySelectorAll('#toolbar button,#toolbar input,#outline button,#outline input')).filter(node=>node!==cancel).map(node=>({node,disabled:node.disabled}));
   for(const {node}of frozen)node.disabled=true;
   try{
    const render=await loadEngine();
    content.style.zoom='1';surface.style.width=original.view.width+'px';surface.style.minWidth=original.view.width+'px';
    await document.fonts?.ready;await new Promise(resolve=>requestAnimationFrame(resolve));
    const bounds=surface.getBoundingClientRect();if(!sameView(bounds,original.view))throw Error('文档布局已变化，请重新选择区域。');
    const rect=original.rect,x=rect.x*bounds.width,y=rect.y*bounds.height,width=rect.width*bounds.width,height=rect.height*bounds.height;
    const crop={left:bounds.left+x,top:bounds.top+y,right:bounds.left+x+width,bottom:bounds.top+y+height};
    // Preserve off-crop image boxes while the clone uses a one-pixel source.
    for(const image of wrapper.querySelectorAll('img')){
     const b=image.getBoundingClientRect();if(b.right>crop.left&&b.left<crop.right&&b.bottom>crop.top&&b.top<crop.bottom)continue;
     const placeholder=image.cloneNode(false),style=getComputedStyle(image);placeholder.removeAttribute('srcset');placeholder.style.width=style.width;placeholder.style.height=style.height;
     placeholder.src='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1z0AAAAASUVORK5CYII=';
     image.replaceWith(placeholder);replaced.push({image,placeholder});
    }
    const scale=Math.min(2,Math.max(1,window.devicePixelRatio||1),4096/width,4096/height,Math.sqrt(4194304/(width*height)));
    canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(width*scale));canvas.height=Math.max(1,Math.floor(height*scale));
    await render(surface,{canvas,x,y,width,height,scale,backgroundColor:'#ffffff',logging:false,useCORS:false,allowTaint:false,imageTimeout:10000,removeContainer:true,
     ignoreElements:element=>element.id==='toolbar'||element.id==='outline'||element===box});
    if(!sameView(surface.getBoundingClientRect(),original.view))throw Error('文档布局已变化，请重新选择区域。');
    const blob=await new Promise((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(Error('截图编码失败。')),'image/png'));
    if(blob.size<1||blob.size>8*1024*1024)throw Error('截图超出当前8 MiB范围，请缩小区域。');
    const walker=document.createTreeWalker(surface,NodeFilter.SHOW_TEXT);let nearbyText='',node;
    while((node=walker.nextNode())&&nearbyText.length<1000){
     const range=document.createRange();range.selectNodeContents(node);
     if(Array.from(range.getClientRects()).some(b=>b.right>crop.left&&b.left<crop.right&&b.bottom>crop.top&&b.top<crop.bottom))nearbyText+=(nearbyText?' ':'')+node.textContent;
    }
    nearbyText=nearbyText.replace(/\s+/g,' ').trim().slice(0,1000);
    const bytes=await blob.arrayBuffer();report({type:'jot-docx-capture',capture:{selection:original,width:canvas.width,height:canvas.height,bytes,nearbyText}},[bytes]);
    status.textContent='PNG已生成，正在交给原草稿上传入口。';
   }catch(error){status.textContent=error instanceof Error?error.message:'区域截图失败。';report({type:'jot-docx-capture-error',reason:'capture_failed'});}
   finally{
    if(canvas){canvas.width=0;canvas.height=0;}for(const {image,placeholder}of replaced)if(placeholder.isConnected)placeholder.replaceWith(image);
    for(const frame of document.querySelectorAll('iframe.html2canvas-container'))frame.remove();
    content.style.zoom=old.zoom;surface.style.width=old.width;surface.style.minWidth=old.minWidth;for(const {node,disabled}of frozen)node.disabled=disabled;busy=false;controls();
   }
  };
  const restore=async focus=>{
   confirmed=false;
   try{
    const rect=focus?.rect,stamp=focus?.view;
    if(stamp?.protocol!==1||!Number.isSafeInteger(stamp.section)||!sections[stamp.section-1]||!['width','height'].every(key=>Number.isFinite(stamp[key])&&stamp[key]>0&&stamp[key]<=33554432)
     ||!rect||!['x','y','width','height'].every(key=>Number.isFinite(rect[key])&&rect[key]>=0&&rect[key]<=1)||!rect.width||!rect.height||rect.x+rect.width>1+1e-9||rect.y+rect.height>1+1e-9)throw Error('focus_invalid');
    surface=sections[stamp.section-1];surface.append(box);content.style.zoom='1';surface.style.width=stamp.width+'px';surface.style.minWidth=stamp.width+'px';await document.fonts?.ready;
    if(sameView(surface.getBoundingClientRect(),stamp)){draw(rect);box.scrollIntoView({block:'center',inline:'center'});confirmed=true;}
   }catch{confirmed=false;}
   report({type:'jot-docx-region-focus',confirmed});
  };
  controls();
  return {get busy(){return busy;},refresh:controls,command(value){
   if(value.type==='jot-docx-region-enable'&&typeof value.enabled==='boolean'){enabled=value.enabled;if(!enabled){if(busy)report({type:'jot-docx-capture-cancel',reason:'scope_changed'});else{active=false;wrapper.style.touchAction='';clear();}}controls();}
   else if(value.type==='jot-docx-region-probe'){report({type:'jot-docx-region-ready',available:true});if(value.focus)void restore(value.focus);send();}
   else if(value.type==='jot-docx-capture')void capture(value.serial);
   else if(value.type==='jot-docx-region-clear')stop();
  }};
 };
})();
