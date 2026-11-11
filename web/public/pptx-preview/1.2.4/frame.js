/* Adapted from pinned PilotDeck PptxBuiltinPreview.tsx. See SOURCES.json and LICENSES.txt. */
import {PptxViewer,RECOMMENDED_ZIP_LIMITS,buildTextIndex,searchText} from './pptx-renderer.js';
import {createPptxRegion} from './pptx-region.js';

const parentHost=new URLSearchParams(location.search).get('parent');
if(!parentHost||!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(parentHost))throw Error('PPTX_PARENT_INVALID');
const parentOrigin='http://'+parentHost,controller=new AbortController(),content=document.getElementById('content'),status=document.getElementById('status');
const query=document.getElementById('query'),slide=document.getElementById('slide'),counter=document.getElementById('matches');
const batchPrevious=document.getElementById('search-batch-previous'),batchNext=document.getElementById('search-batch-next');
const thumbnails=document.getElementById('thumbnails'),thumbnailList=document.getElementById('thumbnail-list'),thumbnailToggle=document.getElementById('thumbnail-toggle');
let thumbnailOpen=false,thumbnailPage=0,thumbnailGeneration=0,thumbnailHandles=[],region,slideObserver;
let viewer,token,started=false,closed=false,busy=false,rendering=false,partial=false,chain=Promise.resolve(),matches=[],matchIndex=0,highlights=[],highlightGeneration=0,needsHighlights=false,searchGeneration=0,searchTimer;
let searchBatch=0,searchStarts=[{slideIndex:0,entryIndex:0,offset:0}],hasNextSearchBatch=false;
const report=(message,transfer=[])=>{if(!closed)parent.postMessage({protocol:1,token,...message},parentOrigin,transfer);};
let viewEnabled=false,viewTimer,restoreScroll,viewGeneration=0;
const bounded=value=>Math.max(0,Math.min(33554432,value));
const validView=view=>view&&Object.keys(view).sort().join(',')==='kind,left,pageLeft,pageTop,protocol,slide,thumbnailPage,thumbnails,top,zoom'&&view.protocol===1&&view.kind==='pptx'
 &&Number.isSafeInteger(view.slide)&&view.slide>=1&&view.slide<=50000&&typeof view.zoom==='number'&&Number.isFinite(view.zoom)&&view.zoom>=25&&view.zoom<=300
 &&typeof view.thumbnails==='boolean'&&Number.isSafeInteger(view.thumbnailPage)&&view.thumbnailPage>=0&&view.thumbnailPage<=12499
 &&['pageTop','pageLeft','top','left'].every(key=>typeof view[key]==='number'&&Number.isFinite(view[key])&&view[key]>=0&&view[key]<=33554432);
const reportView=()=>{
 clearTimeout(viewTimer);if(!viewEnabled||closed||!viewer||busy||rendering)return;
 if(restoreScroll){const view=restoreScroll;restoreScroll=undefined;content.scrollTo({top:view.top,left:view.left});window.scrollTo({top:view.pageTop,left:view.pageLeft});}
 report({type:'jot-pptx-view',view:{protocol:1,kind:'pptx',slide:viewer.currentSlideIndex+1,zoom:viewer.zoomPercent,thumbnails:thumbnailOpen,thumbnailPage,
  pageTop:bounded(window.scrollY),pageLeft:bounded(window.scrollX),top:bounded(content.scrollTop),left:bounded(content.scrollLeft)}});
};
const scheduleView=()=>{clearTimeout(viewTimer);if(viewEnabled)viewTimer=setTimeout(reportView,160);};
window.addEventListener('scroll',scheduleView,true);window.addEventListener('blur',reportView);
const cancelViewRestore=event=>{if(event.isTrusted){viewGeneration++;restoreScroll=undefined;}};
for(const type of ['pointerdown','wheel','keydown'])window.addEventListener(type,cancelViewRestore,{capture:true,passive:true});
const restoreView=view=>{
 const generation=++viewGeneration;viewEnabled=true;restoreScroll=undefined;if(!validView(view)){reportView();return;}
 run(async()=>{
  if(generation!==viewGeneration)return;
  await viewer.setZoom(view.zoom);if(closed||generation!==viewGeneration)return;await viewer.goToSlide(Math.min(view.slide,viewer.slideCount)-1);if(closed||generation!==viewGeneration)return;
  thumbnailOpen=view.thumbnails;thumbnailPage=Math.min(view.thumbnailPage,Math.ceil(viewer.slideCount/4)-1);
  if(thumbnailOpen)renderThumbnailPage(thumbnailPage);else clearThumbnails();
  restoreScroll=view;
 });
};
const reportWork=()=>{if(!closed)report({type:'jot-pptx-work',busy:busy||rendering});};
const instance=crypto.randomUUID();
const boot=()=>{if(!closed)parent.postMessage({type:'jot-pptx-boot',protocol:1,started,instance},parentOrigin);};
const clearThumbnails=()=>{
 thumbnailGeneration++;
 for(const handle of thumbnailHandles)handle.dispose();
 thumbnailHandles=[];
 thumbnailList.replaceChildren();
};
const clearHighlights=()=>{
 highlightGeneration++;needsHighlights=false;
 for(const handle of highlights)handle.dispose();
 highlights=[];viewer?.clearSearchHighlights();
};
const dispose=()=>{clearTimeout(viewTimer);viewGeneration++;restoreScroll=undefined;window.removeEventListener('scroll',scheduleView,true);window.removeEventListener('blur',reportView);for(const type of ['pointerdown','wheel','keydown'])window.removeEventListener(type,cancelViewRestore,true);closed=true;searchGeneration++;searchStarts=[];controller.abort();clearTimeout(searchTimer);slideObserver?.disconnect();region?.dispose();clearThumbnails();clearHighlights();viewer?.destroy();viewer=undefined;matches=[];content.replaceChildren();};
const fail=()=>{if(closed)return;report({type:'jot-pptx-error',code:'PPTX_RENDER_FAILED'});dispose();status.textContent='幻灯片视觉读取失败';};
const controls=()=>{
 const ready=!!viewer&&!closed,working=busy||rendering;slide.disabled=!ready||working;query.disabled=!ready;
 query.closest('nav').setAttribute('aria-busy',String(working));
 batchPrevious.disabled=!ready||working||searchBatch===0;batchNext.disabled=!ready||working||!hasNextSearchBatch;
 document.getElementById('previous').disabled=!ready||working||viewer.currentSlideIndex===0;
 document.getElementById('next').disabled=!ready||working||viewer.currentSlideIndex+1>=viewer.slideCount;
 document.getElementById('out').disabled=!ready||working||viewer.zoomPercent<=25;
 document.getElementById('in').disabled=!ready||working||viewer.zoomPercent>=300;
 document.getElementById('match-previous').disabled=!ready||working||!matches.length;document.getElementById('match-next').disabled=!ready||working||!matches.length;
 thumbnailToggle.disabled=!ready||working;thumbnailToggle.setAttribute('aria-expanded',String(thumbnailOpen));thumbnails.hidden=!thumbnailOpen;
 document.getElementById('thumbnail-previous').disabled=!ready||working||thumbnailPage===0;
 document.getElementById('thumbnail-next').disabled=!ready||working||(thumbnailPage+1)*4>=viewer.slideCount;
 document.getElementById('thumbnail-page').textContent=ready?`${thumbnailPage+1} / ${Math.ceil(viewer.slideCount/4)}`:'0 / 0';
 for(const button of thumbnailList.querySelectorAll('button')){
  button.disabled=!ready||working;
  button.setAttribute('aria-current',ready&&Number(button.dataset.slideIndex)===viewer.currentSlideIndex?'page':'false');
 }
 if(ready){slide.value=String(viewer.currentSlideIndex+1);slide.max=String(viewer.slideCount);document.getElementById('count').textContent='/ '+viewer.slideCount;document.getElementById('zoom').textContent=viewer.zoomPercent+'%';}
 region?.controls();scheduleView();
};
const run=action=>{
 chain=chain.then(async()=>{
  if(closed||!viewer)return;busy=true;controls();reportWork();
  try{await action();if(needsHighlights)await paintCurrentSlide();}
  finally{busy=false;controls();reportWork();if(needsHighlights&&!closed)run(()=>paintCurrentSlide());}
 }).catch(fail);
};
const navigate=delta=>run(async()=>{clearHighlights();await viewer.goToSlide(viewer.currentSlideIndex+delta);});
const renderThumbnailPage=page=>{
 if(closed||!viewer||!thumbnailOpen)return;
 thumbnailPage=Math.max(0,Math.min(Math.ceil(viewer.slideCount/4)-1,page));
 clearThumbnails();
 controls();
 const generation=thumbnailGeneration,start=thumbnailPage*4,end=Math.min(start+4,viewer.slideCount);
 run(async()=>{
  // shortcut: retain at most four native thumbnail handles, page to reach the remaining slides.
  for(let index=start;index<end;index++){
   if(closed||generation!==thumbnailGeneration||!thumbnailOpen)return;
   const button=document.createElement('button'),image=document.createElement('span'),label=document.createElement('span');
   button.type='button';
   button.dataset.slideIndex=String(index);
   button.setAttribute('aria-label',`转到第 ${index+1} 张幻灯片`);
   image.className='thumbnail-image';
   image.setAttribute('aria-hidden','true');
   image.inert=true;
   label.textContent=String(index+1);
   button.append(image,label);
   thumbnailList.append(button);
   button.addEventListener('click',()=>run(async()=>{
    clearHighlights();
    await viewer.goToSlide(index);
   }));
   const handle=viewer.renderThumbnailToContainer(index,image,{width:144});
   if(!handle)throw Error('PPTX_THUMBNAIL_FAILED');
   thumbnailHandles.push(handle);
   controls();
   await handle.ready;
  }
 });
};
thumbnailToggle.addEventListener('click',()=>{
 thumbnailOpen=!thumbnailOpen;
 if(thumbnailOpen)renderThumbnailPage(Math.floor(viewer.currentSlideIndex/4));
 else clearThumbnails();
 controls();
});
document.getElementById('thumbnail-previous').addEventListener('click',()=>renderThumbnailPage(thumbnailPage-1));
document.getElementById('thumbnail-next').addEventListener('click',()=>renderThumbnailPage(thumbnailPage+1));
document.getElementById('previous').addEventListener('click',()=>navigate(-1));document.getElementById('next').addEventListener('click',()=>navigate(1));
slide.addEventListener('change',()=>{const value=Number(slide.value);if(Number.isSafeInteger(value)&&value>=1)run(()=>viewer.goToSlide(value-1));});
document.getElementById('out').addEventListener('click',()=>run(()=>viewer.setZoom(Math.max(25,viewer.zoomPercent-10))));
document.getElementById('in').addEventListener('click',()=>run(()=>viewer.setZoom(Math.min(300,viewer.zoomPercent+10))));
const normalHighlight={scrollIntoView:false,borderColor:'var(--file-search-highlight-border)',
 backgroundColor:'var(--file-search-highlight-bg)',borderWidth:1,padding:1};
const activeHighlight={...normalHighlight,borderColor:'var(--file-search-highlight-active-border)',
 backgroundColor:'var(--file-search-highlight-active-bg)',borderWidth:2,padding:2,zIndex:10001,
 boxShadow:'0 0 0 2px var(--file-search-highlight-active-ring)'};
const boundsKey=result=>JSON.stringify([result.bounds.x,result.bounds.y,result.bounds.w,result.bounds.h]);
const paintCurrentSlide=async(generation=searchGeneration,selected=matches[matchIndex])=>{
 clearHighlights();
 const value=query.value,current=viewer,surface=content.firstElementChild;
 if(closed||!current||!surface||!value.trim()||value.length>200)return;
 const slideIndex=current.currentSlideIndex,paint=highlightGeneration;
 const valid=()=>!closed&&current===viewer&&generation===searchGeneration&&paint===highlightGeneration
  &&current.currentSlideIndex===slideIndex&&content.firstElementChild===surface;
 const data=current.presentationData,entries=buildTextIndex({...data,slides:[data.slides[slideIndex]]});
 const active=selected?.slideIndex===slideIndex?boundsKey(selected):undefined,seen=new Set();
 let steps=0;
 for(const entry of entries){
  if(!valid())return;
  const text=entry.text;let hit;
  for(let offset=0;offset<=text.length-value.length;){
   if(!valid())return;
   const chunk=text.slice(offset,offset+4096),found=searchText([{...entry,text:chunk}],value,{useRegex:false});
   if(found.length){
    const first=found[0];hit={...first,slideIndex,nodePath:entry.nodePath.replace(/^slides\/0\//,`slides/${slideIndex}/`),text,
     matchStart:offset+first.matchStart,matchEnd:offset+first.matchEnd};break;
   }
   offset+=Math.max(1,chunk.length-value.length+1);
   if(++steps%16===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(hit){
   const key=boundsKey(hit);
   // Native search marks node bounds; repeated hits with identical bounds share an overlay.
   if(!seen.has(key)){
    seen.add(key);
    const handle=await current.highlightSearchResult(key===active?selected:hit,key===active?activeHighlight:normalHighlight);
    if(!valid()){handle?.dispose();return;}
    if(handle){handle.element.setAttribute('aria-hidden','true');highlights.push(handle);}
   }
  }
  if(++steps%16===0)await new Promise(resolve=>setTimeout(resolve,0));
 }
};
const showMatch=async(delta,generation=searchGeneration)=>{
 if(generation!==searchGeneration||!matches.length)return;
 matchIndex=(matchIndex+delta+matches.length)%matches.length;
 const selected=matches[matchIndex];clearHighlights();await viewer.goToSlide(selected.slideIndex);
 if(generation!==searchGeneration||closed)return;
 await paintCurrentSlide(generation,selected);
 if(generation===searchGeneration&&!closed)counter.textContent=`第 ${searchBatch+1} 批 · ${matchIndex+1} / ${matches.length}`;
};
const search=async(generation,value,page=0)=>{
 if(generation!==searchGeneration||closed)return;
 if(value.length>200){counter.textContent='查找文字最多200字符';return;}
 clearHighlights();matches=[];matchIndex=0;hasNextSearchBatch=false;
 const found=[],cursor=searchStarts[page];
 let more=false,nextCursor,steps=0;
 counter.textContent=`正在搜索第 ${page+1} 批…`;
 if(value.trim()){
  const data=viewer.presentationData;
  outer:for(let index=cursor.slideIndex;index<data.slides.length;index++){
   if(generation!==searchGeneration||closed)return;
   const entries=buildTextIndex({...data,slides:[data.slides[index]]});
   const firstEntry=index===cursor.slideIndex?cursor.entryIndex:0;
   for(let entryIndex=firstEntry;entryIndex<entries.length;entryIndex++){
    const entry=entries[entryIndex],text=entry.text;
    let offset=index===cursor.slideIndex&&entryIndex===cursor.entryIndex?cursor.offset:0;
    while(offset<=text.length-value.length){
     if(generation!==searchGeneration||closed)return;
     const chunk=text.slice(offset,offset+4096);
     const hits=searchText([{...entry,text:chunk}],value,{useRegex:false});
     for(const hit of hits){
      if(found.length===1000){more=true;break outer;}
      found.push({...hit,slideIndex:index,nodePath:entry.nodePath.replace(/^slides\/0\//,`slides/${index}/`),text,
       matchStart:offset+hit.matchStart,matchEnd:offset+hit.matchEnd});
      if(found.length===1000)nextCursor={slideIndex:index,entryIndex,offset:offset+hit.matchEnd};
     }
     // Revisit only the unmatched tail so literal matches crossing windows remain reachable.
     offset+=hits.length?hits[hits.length-1].matchEnd:Math.max(1,chunk.length-value.length+1);
     if(++steps%8===0){
      counter.textContent=`正在搜索第 ${page+1} 批 · 已找到 ${found.length} 处`;
      await new Promise(resolve=>setTimeout(resolve,0));
     }
    }
   }
   if(++steps%8===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
 }
 if(generation!==searchGeneration||closed)return;
 searchStarts.length=page+1;if(more)searchStarts.push(nextCursor);
 searchBatch=page;hasNextSearchBatch=more;matches=found;
 document.getElementById('coverage').textContent=more?'当前批最多1000处，可继续搜索后续全部已接纳文字。':value.trim()?'已搜索至演示文稿末尾。':'';
 counter.textContent=matches.length?`第 ${page+1} 批 · 1 / ${matches.length}`:value.trim()?'没有匹配':'尚未搜索';
 if(matches.length)await showMatch(0,generation);
};
const schedule=()=>{
 const generation=++searchGeneration,value=query.value;
 clearTimeout(searchTimer);matches=[];clearHighlights();
 searchBatch=0;searchStarts=[{slideIndex:0,entryIndex:0,offset:0}];hasNextSearchBatch=false;
 document.getElementById('coverage').textContent='';controls();counter.textContent='等待搜索';
 searchTimer=setTimeout(()=>run(()=>search(generation,value)),180);
};
const changeSearchBatch=delta=>{
 if(busy||rendering||closed||delta<0&&searchBatch===0||delta>0&&!hasNextSearchBatch)return;
 const generation=searchGeneration,value=query.value,page=searchBatch+delta;
 run(()=>search(generation,value,page));
};
batchPrevious.addEventListener('click',()=>changeSearchBatch(-1));
batchNext.addEventListener('click',()=>changeSearchBatch(1));
query.addEventListener('input',schedule);
document.getElementById('match-previous').addEventListener('click',()=>run(()=>showMatch(-1)));document.getElementById('match-next').addEventListener('click',()=>run(()=>showMatch(1)));
document.addEventListener('keydown',event=>{
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!query.disabled){event.preventDefault();query.focus();query.select();}
 if(event.target===query&&event.key==='Escape'){event.preventDefault();query.value='';schedule();}
 if(event.target===query&&event.key==='Enter'){event.preventDefault();run(()=>showMatch(event.shiftKey?-1:1));}
});
content.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('a'))event.preventDefault();},true);
document.addEventListener('submit',event=>event.preventDefault(),true);
addEventListener('pagehide',()=>{reportView();if(started&&!closed)report({type:'jot-pptx-closed',reason:'pagehide'});dispose();},{once:true});
addEventListener('message',async event=>{
 if(closed||event.source!==parent||event.origin!==parentOrigin||!event.data||typeof event.data!=='object'||Array.isArray(event.data))return;
 const value=event.data;
 if(value.type==='jot-pptx-probe'&&value.protocol===1&&Object.keys(value).length===2){boot();return;}
 if(started&&value.protocol===1&&value.token===token&&Object.keys(value).length===4){if(value.type==='jot-pptx-view-probe'&&viewer)restoreView(value.view);else region?.command(value);return;}
 if(started||value.type!=='jot-pptx-init'||value.protocol!==1||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token)||Object.keys(value).length!==4
  ||!(value.bytes instanceof ArrayBuffer)||value.bytes.byteLength>32*1024*1024)return;
 started=true;token=value.token;status.textContent='正在读取原幻灯片…';
 try{
  const next=await PptxViewer.open(value.bytes,content,{renderMode:'slide',fitMode:'contain',zoomPercent:100,
   zipLimits:{...RECOMMENDED_ZIP_LIMITS,maxEntryUncompressedBytes:8*1024*1024,maxTotalUncompressedBytes:32*1024*1024,maxMediaBytes:32*1024*1024,maxConcurrency:2},
   lazyMedia:true,lazySlides:true,pdfjs:false,signal:controller.signal,onSlideChange:controls,onSlideError:fail,
   onRenderStart:()=>{clearHighlights();rendering=true;controls();reportWork();},onRenderComplete:()=>{rendering=false;controls();reportWork();},
   onNodeError:()=>{partial=true;status.textContent='部分节点尚未成功绘制，请对照原文件。';}});
  if(closed){next.destroy();return;}viewer=next;
  if(!Number.isSafeInteger(viewer.slideCount)||viewer.slideCount<1||viewer.slideCount>50000)throw Error('PPTX_VIEW_LIMIT');
  region=createPptxRegion({content,getViewer:()=>viewer,isWorking:()=>busy||rendering,report,run});
  slideObserver=new MutationObserver(()=>{
   if(closed)return;
   region.invalidate();clearHighlights();needsHighlights=!!query.value.trim();
   if(needsHighlights&&!busy)run(()=>paintCurrentSlide());
   // Native main rendering disposes shared chart instances, including external thumbnails.
   if(thumbnailOpen)renderThumbnailPage(Math.floor(viewer.currentSlideIndex/4));
  });
  slideObserver.observe(content,{childList:true});
  status.textContent=partial?'部分节点尚未成功绘制，请对照原文件。':'原幻灯片视觉内容';controls();report({type:'jot-pptx-ready',info:{slides:viewer.slideCount,partial}});reportWork();
 }catch{if(!controller.signal.aborted)fail();}finally{value.bytes=null;}
});
boot();
