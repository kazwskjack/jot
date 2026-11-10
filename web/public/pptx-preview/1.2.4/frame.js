/* Adapted from pinned PilotDeck PptxBuiltinPreview.tsx. See SOURCES.json and LICENSES.txt. */
import {PptxViewer,RECOMMENDED_ZIP_LIMITS,buildTextIndex,searchText} from './pptx-renderer.js';

const parentHost=new URLSearchParams(location.search).get('parent');
if(!parentHost||!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(parentHost))throw Error('PPTX_PARENT_INVALID');
const parentOrigin='http://'+parentHost,controller=new AbortController(),content=document.getElementById('content'),status=document.getElementById('status');
const query=document.getElementById('query'),slide=document.getElementById('slide'),counter=document.getElementById('matches');
let viewer,token,started=false,closed=false,busy=false,rendering=false,partial=false,chain=Promise.resolve(),matches=[],matchIndex=0,highlight,searchGeneration=0,searchTimer;
const report=message=>parent.postMessage({protocol:1,token,...message},parentOrigin);
const reportWork=()=>{if(!closed)report({type:'jot-pptx-work',busy:busy||rendering});};
const boot=()=>parent.postMessage({type:'jot-pptx-boot',protocol:1,started},parentOrigin);
const dispose=()=>{closed=true;controller.abort();clearTimeout(searchTimer);highlight?.dispose();viewer?.destroy();viewer=undefined;matches=[];content.replaceChildren();};
const fail=()=>{if(closed)return;report({type:'jot-pptx-error',code:'PPTX_RENDER_FAILED'});dispose();status.textContent='幻灯片视觉读取失败';};
const controls=()=>{
 const ready=!!viewer&&!closed,working=busy||rendering;slide.disabled=!ready||working;query.disabled=!ready;
 document.getElementById('previous').disabled=!ready||working||viewer.currentSlideIndex===0;
 document.getElementById('next').disabled=!ready||working||viewer.currentSlideIndex+1>=viewer.slideCount;
 document.getElementById('out').disabled=!ready||working||viewer.zoomPercent<=25;
 document.getElementById('in').disabled=!ready||working||viewer.zoomPercent>=300;
 document.getElementById('match-previous').disabled=!ready||working||!matches.length;document.getElementById('match-next').disabled=!ready||working||!matches.length;
 if(ready){slide.value=String(viewer.currentSlideIndex+1);slide.max=String(viewer.slideCount);document.getElementById('count').textContent='/ '+viewer.slideCount;document.getElementById('zoom').textContent=viewer.zoomPercent+'%';}
};
const run=action=>{
 chain=chain.then(async()=>{
  if(closed||!viewer)return;busy=true;controls();reportWork();
  try{await action();}finally{busy=false;controls();reportWork();}
 }).catch(fail);
};
const navigate=delta=>run(async()=>{highlight?.dispose();highlight=undefined;await viewer.goToSlide(viewer.currentSlideIndex+delta);});
document.getElementById('previous').addEventListener('click',()=>navigate(-1));document.getElementById('next').addEventListener('click',()=>navigate(1));
slide.addEventListener('change',()=>{const value=Number(slide.value);if(Number.isSafeInteger(value)&&value>=1)run(()=>viewer.goToSlide(value-1));});
document.getElementById('out').addEventListener('click',()=>run(()=>viewer.setZoom(Math.max(25,viewer.zoomPercent-10))));
document.getElementById('in').addEventListener('click',()=>run(()=>viewer.setZoom(Math.min(300,viewer.zoomPercent+10))));
const showMatch=async(delta,generation=searchGeneration)=>{
 if(generation!==searchGeneration||!matches.length)return;
 matchIndex=(matchIndex+delta+matches.length)%matches.length;highlight?.dispose();
 const handle=await viewer.highlightSearchResult(matches[matchIndex]);
 if(generation!==searchGeneration||closed){handle?.dispose();return;}
 highlight=handle;counter.textContent=`${matchIndex+1} / ${matches.length}`;
};
const search=async(generation,value)=>{
 if(generation!==searchGeneration)return;
 if(value.length>200){counter.textContent='查找文字最多200字符';return;}
 viewer.clearSearchHighlights();matches=[];matchIndex=0;let scanned=0,limited=false;
 if(value.trim()){
  const data=viewer.presentationData;
  // shortcut: search at most 2097152 UTF-16 units and retain 2000 hits, extend with larger-source search.
  outer:for(let index=0;index<data.slides.length;index++){
   if(generation!==searchGeneration||closed)return;
   const entries=buildTextIndex({...data,slides:[data.slides[index]]});
   for(const entry of entries){
    const text=entry.text.slice(0,Math.max(0,2097152-scanned));if(text.length<entry.text.length)limited=true;scanned+=text.length;
    let offset=0;
    while(offset<=text.length-value.length){
     const chunk=text.slice(offset,offset+4096),hits=searchText([{...entry,text:chunk}],value,{useRegex:false});let advance=0;
     for(const hit of hits){
      if(matches.length===2000){limited=true;break outer;}
      matches.push({...hit,slideIndex:index,nodePath:entry.nodePath.replace(/^slides\/0\//,`slides/${index}/`),text:entry.text,matchStart:offset+hit.matchStart,matchEnd:offset+hit.matchEnd});
      advance=hit.matchEnd;
     }
     offset+=advance||Math.max(1,chunk.length-value.length+1);
    }
    if(scanned>=2097152){limited=true;break outer;}
   }
   await new Promise(resolve=>requestAnimationFrame(resolve));
  }
 }
 if(generation!==searchGeneration||closed)return;
 document.getElementById('coverage').textContent=limited?'搜索达到当前字符或命中上限，存在未覆盖内容。':'';
 counter.textContent=matches.length?`1 / ${matches.length}`:value.trim()?'没有匹配':'尚未搜索';
 if(matches.length)await showMatch(0,generation);
};
const schedule=()=>{const generation=++searchGeneration,value=query.value;clearTimeout(searchTimer);matches=[];highlight?.dispose();highlight=undefined;controls();counter.textContent='等待搜索';searchTimer=setTimeout(()=>run(()=>search(generation,value)),180);};
query.addEventListener('input',schedule);
document.getElementById('match-previous').addEventListener('click',()=>run(()=>showMatch(-1)));document.getElementById('match-next').addEventListener('click',()=>run(()=>showMatch(1)));
document.addEventListener('keydown',event=>{
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!query.disabled){event.preventDefault();query.focus();query.select();}
 if(event.target===query&&event.key==='Escape'){event.preventDefault();query.value='';schedule();}
 if(event.target===query&&event.key==='Enter'){event.preventDefault();run(()=>showMatch(event.shiftKey?-1:1));}
});
content.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('a'))event.preventDefault();},true);
document.addEventListener('submit',event=>event.preventDefault(),true);
addEventListener('pagehide',dispose,{once:true});
addEventListener('message',async event=>{
 if(event.source!==parent||event.origin!==parentOrigin||!event.data||typeof event.data!=='object'||Array.isArray(event.data))return;
 const value=event.data;
 if(value.type==='jot-pptx-probe'&&value.protocol===1&&Object.keys(value).length===2){boot();return;}
 if(started||value.type!=='jot-pptx-init'||value.protocol!==1||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token)||Object.keys(value).length!==4
  ||!(value.bytes instanceof ArrayBuffer)||value.bytes.byteLength>20*1024*1024)return;
 started=true;token=value.token;status.textContent='正在读取原幻灯片…';
 try{
  const next=await PptxViewer.open(value.bytes,content,{renderMode:'slide',fitMode:'contain',zoomPercent:100,
   zipLimits:{...RECOMMENDED_ZIP_LIMITS,maxEntryUncompressedBytes:8*1024*1024,maxTotalUncompressedBytes:32*1024*1024,maxMediaBytes:32*1024*1024,maxConcurrency:2},
   lazyMedia:true,lazySlides:true,pdfjs:false,signal:controller.signal,onSlideChange:()=>controls(),onSlideError:fail,
   onRenderStart:()=>{rendering=true;controls();reportWork();},onRenderComplete:()=>{rendering=false;controls();reportWork();},
   onNodeError:()=>{partial=true;status.textContent='部分节点尚未成功绘制，请对照原文件。';}});
  if(closed){next.destroy();return;}viewer=next;
  if(!Number.isSafeInteger(viewer.slideCount)||viewer.slideCount<1||viewer.slideCount>50000)throw Error('PPTX_VIEW_LIMIT');
  status.textContent=partial?'部分节点尚未成功绘制，请对照原文件。':'原幻灯片视觉内容';controls();report({type:'jot-pptx-ready',info:{slides:viewer.slideCount,partial}});reportWork();
 }catch{if(!controller.signal.aborted)fail();}finally{value.bytes=null;}
});
boot();
