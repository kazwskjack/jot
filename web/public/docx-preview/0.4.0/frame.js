/* Rendering options follow PilotDeck DocxBuiltinPreview at 783499ffdb2d501bf590b2e035acd027a882df10. See SOURCES.json and LICENSES.txt. */
(() => {
 'use strict';
 // Adapted from the pinned PilotDeck fileSearch.ts Unicode fold/offset implementation.
const ASCII_TEXT_PATTERN = /^[\x00-\x7f]*$/u;

function foldTextWithSourceOffsets(text) {
  // The overwhelming majority of source files are ASCII. Native lowercasing
  // keeps offsets identical and avoids per-character objects or arrays while
  // the user types into the search field.
  if (ASCII_TEXT_PATTERN.test(text)) {
    return { value: text.toLowerCase(), offsetSegments: [] };
  }

  let value = '';
  const offsetSegments = [];

  for (let sourceIndex = 0; sourceIndex < text.length;) {
    const codePoint = text.codePointAt(sourceIndex);
    if (codePoint === undefined) break;
    const sourceCharacter = String.fromCodePoint(codePoint);
    const sourceEnd = sourceIndex + sourceCharacter.length;
    // Upper-then-lower provides a context-independent case fold (for example,
    // it treats the two Greek sigma forms alike). Record only length-changing
    // segments so expansions such as `İ` and `ß` map back to the source
    // without allocating two boxed-number arrays for the entire file.
    const foldedCharacter = sourceCharacter.toUpperCase().toLowerCase();
    const foldedStart = value.length;
    value += foldedCharacter;
    const foldedEnd = value.length;
    if (foldedCharacter.length !== sourceCharacter.length) {
      offsetSegments.push({
        foldedStart,
        foldedEnd,
        sourceStart: sourceIndex,
        sourceEnd,
      });
    }
    sourceIndex = sourceEnd;
  }

  return { value, offsetSegments };
}

function sourceRangeForFoldedIndex(
  foldedText,
  foldedIndex,
) {
  let low = 0;
  let high = foldedText.offsetSegments.length - 1;
  let previousSegmentIndex = -1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = foldedText.offsetSegments[middle];
    if (segment.foldedStart <= foldedIndex) {
      previousSegmentIndex = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const previousSegment = previousSegmentIndex >= 0
    ? foldedText.offsetSegments[previousSegmentIndex]
    : undefined;
  if (previousSegment && foldedIndex < previousSegment.foldedEnd) {
    return {
      from: previousSegment.sourceStart,
      to: previousSegment.sourceEnd,
    };
  }

  const accumulatedOffset = previousSegment
    ? previousSegment.foldedEnd - previousSegment.sourceEnd
    : 0;
  const sourceIndex = foldedIndex - accumulatedOffset;
  return { from: sourceIndex, to: sourceIndex + 1 };
}

function findTextSearchMatches(text, query, limit) {
  const normalizedQuery = foldTextWithSourceOffsets(query.trim()).value;
  if (!normalizedQuery) return [];

  const foldedText = foldTextWithSourceOffsets(text);
  const matches = [];
  let searchOffset = 0;

  while (matches.length < limit && searchOffset <= foldedText.value.length - normalizedQuery.length) {
    const index = foldedText.value.indexOf(normalizedQuery, searchOffset);
    if (index < 0) break;
    const lastFoldedIndex = index + normalizedQuery.length - 1;
    const firstSourceRange = sourceRangeForFoldedIndex(foldedText, index);
    const lastSourceRange = sourceRangeForFoldedIndex(foldedText, lastFoldedIndex);
    const match = {
      from: firstSourceRange.from,
      to: lastSourceRange.to,
    };
    const previous = matches[matches.length - 1];
    if (!previous || previous.from !== match.from || previous.to !== match.to) {
      matches.push(match);
    }
    searchOffset = index + Math.max(1, normalizedQuery.length);
  }

  return matches;
}

 const content=document.getElementById('content'),styles=document.getElementById('styles'),status=document.getElementById('status');
 let started=false,zoom=1;
 const resize=delta=>{
  zoom=Math.min(3,Math.max(0.25,Math.round((zoom+delta)*100)/100));
  content.style.zoom=String(zoom);document.getElementById('zoom').textContent=Math.round(zoom*100)+'%';
 };
 document.getElementById('in').addEventListener('click',()=>resize(0.1));
 document.getElementById('out').addEventListener('click',()=>resize(-0.1));
 const query=document.getElementById('query'),previous=document.getElementById('previous'),next=document.getElementById('next'),counter=document.getElementById('matches');
 let matches=[],active=0,searchTimer,fallbackRange;
 const clearHighlights=()=>{
  globalThis.CSS?.highlights?.delete('jot-docx-search');globalThis.CSS?.highlights?.delete('jot-docx-search-active');
  const selection=window.getSelection();
  if(fallbackRange&&selection?.rangeCount===1&&selection.getRangeAt(0)===fallbackRange)selection.removeAllRanges();
  fallbackRange=undefined;
 };
 const navigate=delta=>{
  previous.disabled=next.disabled=matches.length===0;
  if(!matches.length){counter.textContent=query.value.trim()?'没有匹配':'尚未搜索';return;}
  active=(active+delta+matches.length)%matches.length;counter.textContent=`${active+1} / ${matches.length}`;
  const current=matches[active];
  if(globalThis.CSS?.highlights&&globalThis.Highlight){globalThis.CSS.highlights.set('jot-docx-search-active',new Highlight(current.range));}
  else{clearHighlights();const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(current.range);fallbackRange=current.range;}
  current.element.scrollIntoView({block:'center'});
 };
 const search=()=>{
  clearHighlights();matches=[];active=0;
  let characters=0,limited=false;
  if(query.value.trim()){
   const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT,{acceptNode(node){
    return node.textContent?.trim()&&!node.parentElement?.closest('style,script,[data-file-search-exclude]')?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;
   }});
   let node;
   // shortcut: bound searches to 2097152 UTF-16 units, 262144 per node and 2000 hits, extend coverage with larger-source work.
   while((node=walker.nextNode())){
    const original=node.textContent??'',budget=Math.min(256*1024,2*1024*1024-characters),text=original.slice(0,budget);
    characters+=text.length;if(text.length<original.length)limited=true;
    for(const hit of findTextSearchMatches(text,query.value,2001-matches.length)){
     if(matches.length===2000){limited=true;break;}
     const range=document.createRange();range.setStart(node,hit.from);range.setEnd(node,hit.to);matches.push({range,element:node.parentElement??content});
    }
    if(matches.length===2000||characters>=2*1024*1024){limited=true;break;}
   }
  }
  document.getElementById('coverage').textContent=limited?' 搜索达到当前字符或命中上限，存在未覆盖内容。':'';
  if(globalThis.CSS?.highlights&&globalThis.Highlight&&matches.length)globalThis.CSS.highlights.set('jot-docx-search',new Highlight(...matches.map(match=>match.range)));
  navigate(0);
 };
 query.addEventListener('input',()=>{
  window.clearTimeout(searchTimer);clearHighlights();matches=[];previous.disabled=next.disabled=true;counter.textContent='等待搜索';
  searchTimer=window.setTimeout(search,180);
 });
 previous.addEventListener('click',()=>navigate(-1));next.addEventListener('click',()=>navigate(1));
 document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!query.disabled){event.preventDefault();query.focus();query.select();}
  if(event.target!==query)return;
  if(event.key==='Escape'){event.preventDefault();window.clearTimeout(searchTimer);query.value='';search();}
  if(event.key==='Enter'){event.preventDefault();window.clearTimeout(searchTimer);if(!matches.length)search();else navigate(event.shiftKey?-1:1);}
 });
 const buildOutline=()=>{
  const list=document.getElementById('headings');let headings=0,limited=false;
  for(const element of content.querySelectorAll('h1,h2,h3,h4,h5,h6,p')){
   const tag=/^H([1-6])$/.exec(element.tagName),style=String(element.className).match(/heading[\s_-]*([1-6])/i),level=Number(tag?.[1]??style?.[1]);
   const title=element.textContent?.replace(/\s+/g,' ').trim();
   if(!level||!title)continue;
   if(headings===1000){limited=true;break;}
   headings++;element.dataset.docxOutlineTarget=String(headings);element.tabIndex=-1;
   // shortcut: display 1000 headings and 256-unit labels, extend the directory with larger-source navigation.
   const row=document.createElement('li'),button=document.createElement('button');button.type='button';button.textContent=title.length>256?title.slice(0,256)+'…':title;row.style.marginInlineStart=(level-1)+'rem';
   button.addEventListener('click',()=>{element.focus({preventScroll:true});element.scrollIntoView({block:'start'});});row.append(button);list.append(row);
  }
  document.getElementById('outline-status').textContent=limited?'目录达到当前1000项上限，存在未列出标题。':headings?`识别到 ${headings} 个标题`:'此文档没有可识别的标题。';
 };
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
   buildOutline();query.disabled=false;
   status.textContent='Word视觉内容';report({type:'jot-docx-ready',sections});
  }catch(error){
   window.clearTimeout(searchTimer);clearHighlights();matches=[];query.disabled=true;
   document.getElementById('headings').replaceChildren();document.getElementById('outline-status').textContent='视觉内容未能渲染';
   content.replaceChildren();styles.replaceChildren();status.textContent='视觉内容未能渲染';
   report({type:'jot-docx-error',code:error instanceof Error&&error.message==='DOCX_VIEW_LIMIT'?'DOCX_VIEW_LIMIT':'DOCX_RENDER_FAILED'});
  }finally{value.bytes=null;}
 });
})();
