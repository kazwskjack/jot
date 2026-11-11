/* Rendering options follow PilotDeck DocxBuiltinPreview at 783499ffdb2d501bf590b2e035acd027a882df10. See SOURCES.json and LICENSES.txt. */
(() => {
 'use strict';
 const parentHost=new URLSearchParams(window.location.search).get('parent');
 if(!parentHost||!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(parentHost))return;
 const parentOrigin='http://'+parentHost;
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

 // Keep language changes on owned UI nodes, outside document text and view/search state.
 let language='zh-CN';
 const labels=new Map();
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
 };
 const notices={
  'Word视图恢复未完成，请手动定位。':'Word view restoration did not complete. Locate the position manually.',
  '引用文字超出100000字符范围，请缩小选区。':'The reference exceeds 100000 characters. Select less text.',
  '文字选区尚未确认':'The text selection is unconfirmed.',
  '此文档没有可截图分段。':'This document has no sections available for screenshots.',
  '区域边长至少需要8个显示像素，文档尺寸须在当前范围内。':'Region sides must be at least 8 display pixels and document dimensions must be within current limits.',
  '区域已选中，请在查看器下方确认截图引用。':'The region is selected. Confirm the screenshot reference below the viewer.',
  '截图区域已取消。':'The screenshot region was cancelled.',
  '在Word分段内拖动框选，或选择当前可见分段。':'Drag within a Word section or select the currently visible section.',
  '文档位置已变化，请重新选择区域。':'The document position changed. Select the region again.',
  '正在生成有界PNG截图…':'Generating a bounded PNG screenshot…',
  '截图引擎尚未就绪。':'The screenshot engine is not ready.',
  '截图引擎读取失败，请重试。':'Loading the screenshot engine failed. Retry.',
  '文档布局已变化，请重新选择区域。':'The document layout changed. Select the region again.',
  '截图编码失败。':'Screenshot encoding failed.',
  '截图超出当前8 MiB范围，请缩小区域。':'The screenshot exceeds the 8 MiB limit. Select a smaller region.',
  'PNG已生成，正在交给原草稿上传入口。':'The PNG was generated and is being handed to the original draft upload entry.',
  '区域截图失败。':'Region screenshot capture failed.'
 };
 const notice=(element,message)=>ui(element,message,Object.hasOwn(notices,message)?notices[message]:message);
 const content=document.getElementById('content'),styles=document.getElementById('styles'),status=document.getElementById('status');
 const instance=crypto.randomUUID();
 let closed=false,started=false,zoom=1,sessionToken,visualView,selectionSerial=0,proposal,focusRange,regionController;
 window.addEventListener('message',event=>{
  const value=event.data;
  if(closed||!started||event.source!==window.parent||event.origin!==parentOrigin||!value||typeof value!=='object'||Array.isArray(value)
   ||Object.keys(value).sort().join(',')!=='language,protocol,token,type'||value.type!=='jot-docx-language'||value.protocol!==1||value.token!==sessionToken
   ||!['zh-CN','en'].includes(value.language))return;
  setLanguage(value.language);
 });
 const boot=()=>{if(!closed)window.parent.postMessage({type:'jot-docx-boot',protocol:1,started,instance},parentOrigin);};
 window.addEventListener('message',event=>{
  if(event.source===window.parent&&event.origin===parentOrigin&&event.data?.type==='jot-docx-probe'&&event.data.protocol===1&&Object.keys(event.data).length===2)boot();
 });
 const report=(message,transfer=[])=>{if(!closed)window.parent.postMessage({protocol:1,token:sessionToken,...message},parentOrigin,transfer);};
 let viewEnabled=false,viewRestoring=false,viewTimer,viewGeneration=0;
 const bounded=value=>Math.max(0,Math.min(33554432,value));
 const currentView=()=>({protocol:1,kind:'docx',zoom,outlinePage,pageTop:bounded(window.scrollY),pageLeft:bounded(window.scrollX),top:bounded(content.scrollTop),left:bounded(content.scrollLeft)});
 const validView=view=>view&&Object.keys(view).sort().join(',')==='kind,left,outlinePage,pageLeft,pageTop,protocol,top,zoom'&&view.protocol===1&&view.kind==='docx'
  &&typeof view.zoom==='number'&&Number.isFinite(view.zoom)&&view.zoom>=0.25&&view.zoom<=3&&Number.isSafeInteger(view.outlinePage)&&view.outlinePage>=0&&view.outlinePage<=50000
  &&['pageTop','pageLeft','top','left'].every(key=>typeof view[key]==='number'&&Number.isFinite(view[key])&&view[key]>=0&&view[key]<=33554432);
 const reportView=()=>{clearTimeout(viewTimer);if(viewEnabled&&!viewRestoring&&!closed&&visualView)report({type:'jot-docx-view',view:currentView()});};
 const scheduleView=()=>{clearTimeout(viewTimer);if(viewEnabled&&!viewRestoring)viewTimer=setTimeout(reportView,160);};
 window.addEventListener('scroll',scheduleView,true);window.addEventListener('blur',reportView);
 const cancelViewRestore=event=>{if(event.isTrusted){viewGeneration++;viewRestoring=false;}};
 for(const type of ['pointerdown','wheel','keydown'])window.addEventListener(type,cancelViewRestore,{capture:true,passive:true});
 const restoreView=view=>{
  const generation=++viewGeneration;viewEnabled=true;viewRestoring=false;
  if(!validView(view)){reportView();return;}
  viewRestoring=true;zoom=view.zoom;content.style.zoom=String(zoom);document.getElementById('zoom').textContent=Math.round(zoom*100)+'%';renderOutlinePage(view.outlinePage);
  void Promise.resolve(document.fonts?.ready).then(()=>{if(closed||generation!==viewGeneration)return;requestAnimationFrame(()=>requestAnimationFrame(()=>{if(closed||generation!==viewGeneration)return;content.scrollTo({top:view.top,left:view.left});window.scrollTo({top:view.pageTop,left:view.pageLeft});viewRestoring=false;reportView();}));}).catch(()=>{if(!closed&&generation===viewGeneration){viewRestoring=false;notice(status,'Word视图恢复未完成，请手动定位。');reportView();}});
 };
 // text_view 2 pins docx-preview 0.4.0 raw DOM text order. A renderer upgrade needs a new locator protocol.
 const indexVisualText=()=>{
  const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT),parts=[],nodes=[];let length=0,node;
  while((node=walker.nextNode())){
   const text=node.data;if(!text.length)continue;
   if(length+text.length>33554432)throw Error('DOCX_VIEW_LIMIT');
   nodes.push({node,start:length,end:length+text.length});parts.push(text);length+=text.length;
  }
  return {text:parts.join(''),nodes};
 };
 // Source adaptation of office-text-reference.ts::officeTextOccurrence keeps overlapping matches linear.
 const occurrence=(text,query,target)=>{
  if(!query.length)return;
  const prefix=new Int32Array(query.length);let count=0;
  for(let index=1,matched=0;index<query.length;index++){
   while(matched>0&&query[index]!==query[matched])matched=prefix[matched-1];
   if(query[index]===query[matched])matched++;
   prefix[index]=matched;
  }
  for(let index=0,matched=0;index<text.length;index++){
   while(matched>0&&text[index]!==query[matched])matched=prefix[matched-1];
   if(text[index]===query[matched])matched++;
   if(matched===query.length){
    const offset=index-query.length+1;
    if('offset' in target?offset===target.offset:count===target.index)return {offset,index:count};
    count++;matched=prefix[matched-1];
   }
  }
 };
 const quoteFromRange=(range,serial)=>{
  if(!visualView||range.collapsed||!content.contains(range.startContainer)||!content.contains(range.endContainer))return;
  const raw=range.toString(),selectedText=raw.trim();if(!selectedText)return;
  if(selectedText.length>100000)throw Error('引用文字超出100000字符范围，请缩小选区。');
  const before=document.createRange();before.selectNodeContents(content);before.setEnd(range.startContainer,range.startOffset);
  const offset=before.toString().length+raw.length-raw.trimStart().length;
  if(visualView.text.slice(offset,offset+selectedText.length)!==selectedText)return;
  const match=occurrence(visualView.text,selectedText,{offset});if(!match)return;
  return {serial,selectedText,occurrenceIndex:match.index,prefix:visualView.text.slice(Math.max(0,offset-80),offset),suffix:visualView.text.slice(offset+selectedText.length,offset+selectedText.length+80)};
 };
 const publishSelection=()=>{
  if(!visualView)return;
  proposal=undefined;
  const selected=window.getSelection();
  try{
   if(selected?.rangeCount===1&&!selected.isCollapsed&&!document.activeElement?.closest('#toolbar,#outline')){
    const range=selected.getRangeAt(0);
    if(range!==focusRange&&range!==fallbackRange){
     const data=quoteFromRange(range,++selectionSerial);
     if(data)proposal={data,range:range.cloneRange()};
    }
   }
   report({type:'jot-docx-selection',selection:proposal?.data??null});
  }catch(error){notice(status,error instanceof Error?error.message:'文字选区尚未确认');report({type:'jot-docx-selection',selection:null});}
 };
 const restoreFocus=focus=>{
  let confirmed=false;
  if(visualView&&focus&&typeof focus.selectedText==='string'&&focus.selectedText.length>0&&focus.selectedText.length<=100000
   &&Number.isSafeInteger(focus.occurrenceIndex)&&focus.occurrenceIndex>=0&&focus.occurrenceIndex<=33554432
   &&typeof focus.prefix==='string'&&focus.prefix.length<=500&&typeof focus.suffix==='string'&&focus.suffix.length<=500&&Object.keys(focus).length===4){
   const offset=occurrence(visualView.text,focus.selectedText,{index:focus.occurrenceIndex})?.offset,end=offset===undefined?undefined:offset+focus.selectedText.length;
   if(offset!==undefined&&end!==undefined&&visualView.text.slice(Math.max(0,offset-focus.prefix.length),offset)===focus.prefix&&visualView.text.slice(end,end+focus.suffix.length)===focus.suffix){
    const startNode=visualView.nodes.find(item=>offset>=item.start&&offset<item.end),endNode=visualView.nodes.find(item=>end>item.start&&end<=item.end);
    if(startNode&&endNode){
     const range=document.createRange();range.setStart(startNode.node,offset-startNode.start);range.setEnd(endNode.node,end-endNode.start);
     if(range.toString()===focus.selectedText){
      focusRange=range;
      if(globalThis.CSS?.highlights&&globalThis.Highlight)globalThis.CSS.highlights.set('jot-docx-source',new Highlight(range));
      else{window.getSelection()?.removeAllRanges();window.getSelection()?.addRange(range);}
      startNode.node.parentElement?.scrollIntoView({block:'center'});confirmed=true;
     }
    }
   }
  }
  report({type:'jot-docx-focus',confirmed});
 };
 let selectionTimer;
 document.addEventListener('selectionchange',()=>{
  if(!visualView)return;
  if(proposal&&!document.hasFocus())return;
  const range=window.getSelection()?.rangeCount===1?window.getSelection().getRangeAt(0):undefined,original=proposal?.range;
  if(range&&original&&range.startContainer===original.startContainer&&range.startOffset===original.startOffset&&range.endContainer===original.endContainer&&range.endOffset===original.endOffset)return;
  window.clearTimeout(selectionTimer);proposal=undefined;report({type:'jot-docx-selection',selection:null});
 });
 const scheduleSelection=()=>{window.clearTimeout(selectionTimer);selectionTimer=window.setTimeout(publishSelection,40);};
 document.addEventListener('mouseup',scheduleSelection);document.addEventListener('touchend',scheduleSelection);document.addEventListener('keyup',scheduleSelection);
 window.addEventListener('message',event=>{
  const value=event.data;
  if(!visualView||event.source!==window.parent||event.origin!==parentOrigin||!value||value.protocol!==1||value.token!==sessionToken||Object.keys(value).length!==4)return;
  if(value.type==='jot-docx-commit'&&proposal&&value.serial===proposal.data.serial){
   const current=quoteFromRange(proposal.range,proposal.data.serial);
   if(current&&JSON.stringify(current)===JSON.stringify(proposal.data))report({type:'jot-docx-commit-ready',selection:current});
   else{proposal=undefined;report({type:'jot-docx-selection',selection:null});}
  }else if(value.type==='jot-docx-added'&&value.serial===proposal?.data.serial){
   proposal=undefined;window.getSelection()?.removeAllRanges();report({type:'jot-docx-selection',selection:null});
  }else if(value.type==='jot-docx-view-probe'&&visualView)restoreView(value.view);
  else regionController?.command(value);
 });
 const resize=delta=>{
  zoom=Math.min(3,Math.max(0.25,Math.round((zoom+delta)*100)/100));
  content.style.zoom=String(zoom);document.getElementById('zoom').textContent=Math.round(zoom*100)+'%';scheduleView();
 };
 document.getElementById('in').addEventListener('click',()=>resize(0.1));
 document.getElementById('out').addEventListener('click',()=>resize(-0.1));
 const query=document.getElementById('query'),previous=document.getElementById('previous'),next=document.getElementById('next'),counter=document.getElementById('matches');
 const batchPrevious=document.getElementById('search-batch-previous'),batchNext=document.getElementById('search-batch-next');
 let matches=[],active=0,searchTimer,fallbackRange,searchGeneration=0,searchBusy=false,batch=0,batchStarts=[null],hasNextBatch=false;
 const searchControls=()=>{
  query.closest('nav').setAttribute('aria-busy',String(searchBusy));
  previous.disabled=next.disabled=searchBusy||matches.length===0;
  batchPrevious.disabled=searchBusy||batch===0;batchNext.disabled=searchBusy||!hasNextBatch;
  regionController?.refresh?.();
 };
 const clearHighlights=()=>{
  globalThis.CSS?.highlights?.delete('jot-docx-search');globalThis.CSS?.highlights?.delete('jot-docx-search-active');
  const selection=window.getSelection();
  if(fallbackRange&&selection?.rangeCount===1&&selection.getRangeAt(0)===fallbackRange)selection.removeAllRanges();
  fallbackRange=undefined;
 };
 const cancelSearch=()=>{searchGeneration++;window.clearTimeout(searchTimer);searchBusy=false;searchControls();};
 const navigate=delta=>{
  if(searchBusy||closed||regionController?.busy)return;
  searchControls();
  if(!matches.length){ui(counter,query.value.trim()?'没有匹配':'尚未搜索',query.value.trim()?'No matches':'Not searched');return;}
  active=(active+delta+matches.length)%matches.length;ui(counter,`第 ${batch+1} 批 · ${active+1} / ${matches.length}`,`Batch ${batch+1} · ${active+1} / ${matches.length}`);
  const current=matches[active];
  if(globalThis.CSS?.highlights&&globalThis.Highlight){globalThis.CSS.highlights.set('jot-docx-search-active',new Highlight(current.range));}
  else{clearHighlights();const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(current.range);fallbackRange=current.range;}
  current.element.scrollIntoView({block:'center'});
 };
 const search=async(page=0)=>{
  if(closed||regionController?.busy)return;
  cancelSearch();const generation=searchGeneration,value=query.value,found=[];
  clearHighlights();matches=[];active=0;hasNextBatch=false;searchBusy=true;searchControls();ui(counter,'正在搜索…','Searching…');
  ui(document.getElementById('coverage'),'','');
  try{
   if(value.length>200)throw Error('SEARCH_QUERY_LIMIT');
   if(value.trim()){
    // Overlap covers a folded query while retaining surrogate pairs in source windows.
    const overlap=foldTextWithSourceOffsets(value.trim()).value.length*2+2;
    const walker=document.createTreeWalker(content,NodeFilter.SHOW_TEXT,{acceptNode(node){
     return node.textContent?.trim()&&!node.parentElement?.closest('style,script,[data-file-search-exclude]')?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;
    }});
    const cursor=batchStarts[page];let node=cursor?.node??walker.nextNode(),offset=cursor?.offset??0,chunks=0,nextCursor,more=false;
    if(cursor)walker.currentNode=cursor.node;
    outer:while(node){
     if(closed||generation!==searchGeneration)return;
     const original=node.textContent??'';
     if(offset>=original.length){node=walker.nextNode();offset=0;continue;}
     let end=Math.min(original.length,offset+16384);
     if(end<original.length&&original.charCodeAt(end-1)>=0xd800&&original.charCodeAt(end-1)<=0xdbff)end--;
     const hits=findTextSearchMatches(original.slice(offset,end),value,1001-found.length);
     for(const hit of hits){
      if(found.length===1000){more=true;break outer;}
      const range=document.createRange();range.setStart(node,offset+hit.from);range.setEnd(node,offset+hit.to);
      found.push({range,element:node.parentElement??content});
      if(found.length===1000)nextCursor={node,offset:offset+hit.to};
     }
     // Resume after the last complete match so window overlap cannot duplicate it.
     if(hits.length)offset+=hits[hits.length-1].to;
     else if(end===original.length){node=walker.nextNode();offset=0;}
     else{
      offset=Math.max(offset+1,end-overlap);
      if(original.charCodeAt(offset)>=0xdc00&&original.charCodeAt(offset)<=0xdfff)offset--;
     }
     if(++chunks%8===0){
      ui(counter,`正在搜索第 ${page+1} 批 · 已找到 ${found.length} 处`,`Searching batch ${page+1} · ${found.length} matches found`);
      await new Promise(resolve=>window.setTimeout(resolve,0));
     }
    }
    if(closed||generation!==searchGeneration)return;
    hasNextBatch=more;batchStarts.length=page+1;if(more)batchStarts.push(nextCursor);
   }
   if(closed||generation!==searchGeneration)return;
   matches=found;batch=page;
   ui(document.getElementById('coverage'),hasNextBatch?'当前批最多1000处，可继续搜索后续全部已渲染文字。':value.trim()?'已搜索至文档末尾。':'',hasNextBatch?'Up to 1000 matches in this batch. Continue to search all remaining rendered text.':value.trim()?'Searched to the end of the document.':'');
   if(globalThis.CSS?.highlights&&globalThis.Highlight&&matches.length)globalThis.CSS.highlights.set('jot-docx-search',new Highlight(...matches.map(match=>match.range)));
   searchBusy=false;navigate(0);
  }catch{
   if(closed||generation!==searchGeneration)return;
   clearHighlights();matches=[];hasNextBatch=false;ui(counter,'搜索未完成，请重新输入后重试。','Search did not complete. Enter the query again and retry.');
  }finally{if(!closed&&generation===searchGeneration){searchBusy=false;searchControls();}}
 };
 const resetSearch=()=>{
  cancelSearch();clearHighlights();matches=[];batch=0;batchStarts=[null];hasNextBatch=false;searchControls();
  ui(document.getElementById('coverage'),'','');ui(counter,'等待搜索','Waiting to search');
 };
 query.addEventListener('input',()=>{resetSearch();searchTimer=window.setTimeout(()=>void search(),180);});
 previous.addEventListener('click',()=>navigate(-1));next.addEventListener('click',()=>navigate(1));
 batchPrevious.addEventListener('click',()=>{if(batch>0&&!searchBusy)void search(batch-1);});
 batchNext.addEventListener('click',()=>{if(hasNextBatch&&!searchBusy)void search(batch+1);});
 document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!query.disabled){event.preventDefault();query.focus();query.select();}
  if(event.target!==query||query.disabled)return;
  if(event.key==='Escape'){event.preventDefault();query.value='';resetSearch();ui(counter,'尚未搜索','Not searched');}
  if(event.key==='Enter'){event.preventDefault();window.clearTimeout(searchTimer);if(!matches.length)void search();else navigate(event.shiftKey?-1:1);}
 });
 let outlineItems=[],outlinePage=0;
 const outlineInput=document.getElementById('outline-page'),outlinePrevious=document.getElementById('outline-previous'),outlineNext=document.getElementById('outline-next');
 const renderOutlinePage=page=>{
  const count=Math.ceil(outlineItems.length/100),list=document.getElementById('headings');
  outlinePage=Math.max(0,Math.min(count-1,page));list.replaceChildren();
  outlineInput.disabled=count===0;outlineInput.value=count?String(outlinePage+1):'0';outlineInput.max=String(Math.max(1,count));
  outlinePrevious.disabled=count===0||outlinePage===0;outlineNext.disabled=count===0||outlinePage+1>=count;
  ui(document.getElementById('outline-pages'),count?`第 ${outlinePage+1} / ${count} 页`:'0 / 0',count?`Page ${outlinePage+1} / ${count}`:'0 / 0');
  list.start=outlinePage*100+1;scheduleView();
  for(const item of outlineItems.slice(outlinePage*100,(outlinePage+1)*100)){
   const row=document.createElement('li'),button=document.createElement('button');button.type='button';
   const label=document.createElement('span');label.className='jot-docx-outline-label';label.textContent=item.title;
   button.title=item.title;button.append(label);row.style.marginInlineStart=(item.level-1)+'rem';
   button.addEventListener('click',()=>{if(item.element.isConnected){item.element.focus({preventScroll:true});item.element.scrollIntoView({block:'start'});}});
   row.append(button);list.append(row);
  }
 };
 const clearOutline=(zh,en)=>{outlineItems=[];renderOutlinePage(0);ui(document.getElementById('outline-status'),zh,en);};
 outlinePrevious.addEventListener('click',()=>renderOutlinePage(outlinePage-1));
 outlineNext.addEventListener('click',()=>renderOutlinePage(outlinePage+1));
 outlineInput.addEventListener('change',()=>{
  const value=Number(outlineInput.value);
  if(Number.isSafeInteger(value)&&value>=1)renderOutlinePage(value-1);else outlineInput.value=outlineItems.length?String(outlinePage+1):'0';
 });
 const buildOutline=()=>{
  outlineItems=[];
  for(const element of content.querySelectorAll('h1,h2,h3,h4,h5,h6,p')){
   const tag=/^H([1-6])$/.exec(element.tagName),style=String(element.className).match(/heading[\s_-]*([1-6])/i),level=Number(tag?.[1]??style?.[1]);
   const title=element.textContent?.replace(/\s+/g,' ').trim();
   if(!level||!title)continue;
   outlineItems.push({element,level,title});element.dataset.docxOutlineTarget=String(outlineItems.length);element.tabIndex=-1;
  }
  renderOutlinePage(0);
  ui(document.getElementById('outline-status'),outlineItems.length?`识别到 ${outlineItems.length} 个标题，每页最多100项。`:'此文档没有可识别的标题。',outlineItems.length?`${outlineItems.length} headings found, up to 100 per page.`:'No recognizable headings in this document.');
 };
 window.addEventListener('pagehide',()=>{
  reportView();viewGeneration++;clearTimeout(viewTimer);window.removeEventListener('scroll',scheduleView,true);window.removeEventListener('blur',reportView);for(const type of ['pointerdown','wheel','keydown'])window.removeEventListener(type,cancelViewRestore,true);
  if(started)report({type:'jot-docx-closed',reason:'pagehide'});cancelSearch();closed=true;batchStarts=[];
  window.clearTimeout(searchTimer);window.clearTimeout(selectionTimer);clearHighlights();matches=[];clearOutline('目录已关闭','Outline closed');
  visualView=undefined;proposal=undefined;focusRange=undefined;regionController=undefined;content.replaceChildren();styles.replaceChildren();
 },{once:true});
 content.addEventListener('click',event=>{if(event.target instanceof Element&&event.target.closest('a'))event.preventDefault();},true);
 document.addEventListener('submit',event=>event.preventDefault(),true);
 window.addEventListener('message',async event=>{
  const value=event.data;
  if(closed||started||event.source!==window.parent||event.origin!==parentOrigin||!value||value.type!=='jot-docx-init'||value.protocol!==1
   ||typeof value.token!=='string'||!/^[a-f0-9-]{36}$/.test(value.token)||Object.keys(value).some(key=>!['type','protocol','token','bytes','focus'].includes(key))
   ||!(value.bytes instanceof ArrayBuffer)||value.bytes.byteLength>32*1024*1024)return;
  started=true;sessionToken=value.token;
  ui(status,'正在渲染…','Rendering…');
  try{
   let nodes=0,textUnits=0;
   await window.docx.renderAsync(value.bytes,content,styles,{
    className:'jot-docx',breakPages:true,ignoreLastRenderedPageBreak:false,
    renderHeaders:true,renderFooters:true,renderFootnotes:true,renderEndnotes:true,
    renderComments:false,renderAltChunks:false,useBase64URL:true,
    h(element){
     if(closed)throw Error('DOCX_VIEW_CLOSED');
     if(++nodes>50000)throw Error('DOCX_VIEW_LIMIT');
     if(typeof element==='string'){textUnits+=element.length;if(textUnits>33554432)throw Error('DOCX_VIEW_LIMIT');}
     const node=window.docx.defaultOptions.h(element);
     if(node instanceof HTMLImageElement){node.loading='lazy';node.decoding='async';}
     return node;
    }
   });
   if(closed){content.replaceChildren();styles.replaceChildren();return;}
   const sections=content.querySelectorAll('section.jot-docx').length;
   visualView=indexVisualText();
   buildOutline();query.disabled=false;
   regionController=window.JotWordRegion({content,report,notice,isWorking:()=>searchBusy,onCaptureStart:cancelSearch});
   ui(status,'Word视觉内容','Word visual content');report({type:'jot-docx-ready',sections});
   if(value.focus)restoreFocus(value.focus);
  }catch(error){
   if(closed){content.replaceChildren();styles.replaceChildren();return;}
   window.clearTimeout(searchTimer);window.clearTimeout(selectionTimer);clearHighlights();matches=[];visualView=undefined;proposal=undefined;query.disabled=true;
   clearOutline('视觉内容未能渲染','Visual content could not be rendered');
   content.replaceChildren();styles.replaceChildren();ui(status,'视觉内容未能渲染','Visual content could not be rendered');
   report({type:'jot-docx-error',code:error instanceof Error&&error.message==='DOCX_VIEW_LIMIT'?'DOCX_VIEW_LIMIT':'DOCX_RENDER_FAILED'});
  }finally{value.bytes=null;}
 });
 boot();
})();
