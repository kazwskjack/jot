/* Rendering options follow PilotDeck DocxBuiltinPreview at 783499ffdb2d501bf590b2e035acd027a882df10. See SOURCES.json and LICENSES.txt. */
(() => {
 'use strict';
 const content=document.getElementById('content'),styles=document.getElementById('styles'),status=document.getElementById('status');
 let started=false,zoom=1;
 const resize=delta=>{
  zoom=Math.min(3,Math.max(0.25,Math.round((zoom+delta)*100)/100));
  content.style.zoom=String(zoom);document.getElementById('zoom').textContent=Math.round(zoom*100)+'%';
 };
 document.getElementById('in').addEventListener('click',()=>resize(0.1));
 document.getElementById('out').addEventListener('click',()=>resize(-0.1));
 content.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('a'))event.preventDefault();},true);
 document.addEventListener('submit',event=>event.preventDefault(),true);
 window.addEventListener('message',async event=>{
  const value=event.data;
  if(started||event.source!==window.parent||!value||value.type!=='jot-docx-init'||value.protocol!==1
   ||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token)||Object.keys(value).length!==4
   ||!(value.bytes instanceof ArrayBuffer)||value.bytes.byteLength>20*1024*1024)return;
  started=true;const token=value.token;
  const report=message=>window.parent.postMessage({protocol:1,token,...message},'*');
  status.textContent='正在渲染…';
  try{
   let nodes=0;
   await window.docx.renderAsync(value.bytes,content,styles,{
    className:'jot-docx',breakPages:true,ignoreLastRenderedPageBreak:false,
    renderHeaders:true,renderFooters:true,renderFootnotes:true,renderEndnotes:true,
    renderComments:false,renderAltChunks:false,useBase64URL:true,
    h(element){
     if(++nodes>50000)throw Error('DOCX_VIEW_LIMIT');
     const node=window.docx.defaultOptions.h(element);
     if(node instanceof HTMLImageElement){node.loading='lazy';node.decoding='async';}
     return node;
    }
   });
   const sections=content.querySelectorAll('section.jot-docx').length;
   status.textContent='Word视觉内容';report({type:'jot-docx-ready',sections});
  }catch(error){
   content.replaceChildren();styles.replaceChildren();status.textContent='视觉内容未能渲染';
   report({type:'jot-docx-error',code:error instanceof Error&&error.message==='DOCX_VIEW_LIMIT'?'DOCX_VIEW_LIMIT':'DOCX_RENDER_FAILED'});
  }finally{value.bytes=null;}
 });
})();
