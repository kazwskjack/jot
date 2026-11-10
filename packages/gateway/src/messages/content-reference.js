import {officePreviewFormat} from '../artifacts/office-preview-format.js';
// Validates Jot snapshots of the retained PilotDeck content-reference schema.
// All references remain user-provided context with execution_authorized=false.
const exact=(value,required,optional=[])=>!!value&&typeof value==='object'&&!Array.isArray(value)
 &&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(value);
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const invalid=()=>Error('content_reference_invalid');
const relative=value=>text(value,4096)&&value.length>0&&!/[\\:\u0000-\u001f\u007f]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');

// Validate the original Office source, then reuse the native PDF selection shape without rewriting stored data.
function officePrintPdfSource(value){
 const print=value?.print_view,ref=value?.reference,source=ref?.source,renderer=ref?.renderer;
 const path=value?.file?.path;
 const mime=officePreviewFormat(path)?.mediaType;
 if(!exact(print,['protocol','sha256','size','pageCount','proof'])||print.protocol!==1||!sha(print.sha256)
  ||!Number.isSafeInteger(print.size)||print.size<100||print.size>20*1024*1024
  ||!positive(print.pageCount)||print.pageCount>50000||typeof print.proof!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(print.proof)
  ||typeof mime!=='string'||source?.mimeType!==mime||value.file.size>20*1024*1024
  ||!exact(renderer,['id','backend','locatorQuality'])||renderer.id!=='office-pdf'||renderer.backend!=='libreoffice'
  ||renderer.locatorQuality!==(ref.selectionMode==='text'?'approximate':'visual'))throw invalid();
 const locator=ref.locator;
 if(Array.isArray(locator?.pageNumbers)&&locator.pageNumbers.some(page=>page>print.pageCount)
  ||locator?.pageNumber>print.pageCount)throw invalid();
 const {print_view,...original}=value;
 return {...original,reference:{...ref,source:{...source,mimeType:'application/pdf'},
  renderer:{id:'pdf',backend:'builtin',locatorQuality:ref.selectionMode==='text'?'semantic':'visual'}}};
}

export function validateTextReferenceSource(value,conversation){
 if(value?.print_view!==undefined||value?.reference?.renderer?.id==='office-pdf'){validateTextReferenceSource(officePrintPdfSource(value),conversation);return;}
 if(['docx','pptx'].includes(value?.reference?.renderer?.id)){validateOfficeTextReferenceSource(value,conversation);return;}
 if(!exact(value,['conversationId','runId','activityId','resultSha','file','reference'],['rotation'])
  ||value.rotation!==undefined&&![0,90,180,270].includes(value.rotation)||value.conversationId!==conversation||!id(value.runId)||!id(value.activityId)||!sha(value.resultSha))throw invalid();
 const source=value.file,ref=value.reference;
 if(!exact(source,['path','version','sha256','size'])||!relative(source.path)||!Number.isSafeInteger(source.version)||source.version<0||!sha(source.sha256)||!Number.isSafeInteger(source.size)||source.size<0
  ||!exact(ref,['schemaVersion','kind','id','selectionMode','source','renderer','locator','selectedText','createdAt'],['surroundingText','truncated'])
  ||ref.schemaVersion!==1||ref.kind!=='content-reference'||ref.selectionMode!=='text'||!id(ref.id)
  ||!text(ref.createdAt,100)||!Number.isFinite(Date.parse(ref.createdAt))||!text(ref.selectedText,100000)||!ref.selectedText.trim()
  ||ref.surroundingText!==undefined&&!text(ref.surroundingText,101000)||ref.truncated!==undefined&&typeof ref.truncated!=='boolean')throw invalid();
 const file=ref.source,renderer=ref.renderer,locator=ref.locator;
 if(!exact(file,['relativePath','fileName','mimeType','revision'])||file.relativePath!==source.path||file.fileName!==source.path.split('/').at(-1)||file.mimeType!=='application/pdf'
  ||!exact(file.revision,['id','sha256','size'])||file.revision.id!==String(source.version)||file.revision.sha256!==source.sha256||file.revision.size!==source.size
  ||!exact(renderer,['id','backend','locatorQuality'])||renderer.id!=='pdf'||renderer.backend!=='builtin'||renderer.locatorQuality!=='semantic'
  ||!exact(locator,['surface','pageNumbers','quote','rects'])||locator.surface!=='page'||!Array.isArray(locator.pageNumbers)||!locator.pageNumbers.length
  ||locator.pageNumbers.some((page,index)=>!positive(page)||index>0&&page<=locator.pageNumbers[index-1])
  ||!exact(locator.quote,['exact'],['prefix','suffix'])||locator.quote.exact!==ref.selectedText
  ||locator.quote.prefix!==undefined&&!text(locator.quote.prefix,500)||locator.quote.suffix!==undefined&&!text(locator.quote.suffix,500)
  ||!Array.isArray(locator.rects)||locator.rects.length!==locator.pageNumbers.length)throw invalid();
 for(const rect of locator.rects){
  if(!exact(rect,['x','y','width','height'])||Object.values(rect).some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)
   ||rect.x+rect.width>1+1e-9||rect.y+rect.height>1+1e-9)throw invalid();
 }
}

function validateOfficeTextReferenceSource(value,conversation){
 if(!exact(value,['conversationId','runId','activityId','resultSha','file','reference','text_view'])
  ||value.text_view!==1&&!(value.text_view===2&&value.reference?.renderer?.id==='docx')||value.conversationId!==conversation
  ||!id(value.conversationId)||!identifier(value.runId)||!identifier(value.activityId)||!sha(value.resultSha))throw invalid();
 const file=value.file,ref=value.reference;
 if(!exact(file,['path','version','sha256','size'])||!relative(file.path)||!Number.isSafeInteger(file.version)||file.version<0
  ||!sha(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0
  ||!exact(ref,['schemaVersion','kind','id','selectionMode','source','renderer','locator','selectedText','createdAt'],['surroundingText','truncated'])
  ||ref.schemaVersion!==1||ref.kind!=='content-reference'||ref.selectionMode!=='text'||!identifier(ref.id)
  ||!text(ref.createdAt,100)||!Number.isFinite(Date.parse(ref.createdAt))||!text(ref.selectedText,100000)||!ref.selectedText.trim()
  ||ref.surroundingText!==undefined&&!text(ref.surroundingText,101000)||ref.truncated!==undefined&&typeof ref.truncated!=='boolean')throw invalid();
 const source=ref.source,renderer=ref.renderer,locator=ref.locator;
 const docx=renderer?.id==='docx',mime=docx?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/vnd.openxmlformats-officedocument.presentationml.presentation';
 if(!exact(source,['relativePath','fileName','mimeType','revision'])||source.relativePath!==file.path||source.fileName!==file.path.split('/').at(-1)||source.mimeType!==mime
  ||!exact(source.revision,['id','sha256','size'])||source.revision.id!==String(file.version)||source.revision.sha256!==file.sha256||source.revision.size!==file.size
  ||!exact(renderer,['id','backend','locatorQuality'])||!['docx','pptx'].includes(renderer.id)||renderer.backend!=='builtin'||renderer.locatorQuality!=='semantic'
  ||!exact(locator,docx?['surface','quote','occurrenceIndex']:['surface','quote','occurrenceIndex','slideNumbers'],docx?['headingPath','rects']:['rects'])
  ||locator.surface!==(docx?'document':'slide')||!Number.isSafeInteger(locator.occurrenceIndex)||locator.occurrenceIndex<0
  ||!exact(locator.quote,['exact'],['prefix','suffix'])||locator.quote.exact!==ref.selectedText
  ||locator.quote.prefix!==undefined&&!text(locator.quote.prefix,500)||locator.quote.suffix!==undefined&&!text(locator.quote.suffix,500))throw invalid();
 if(docx){
  if(locator.headingPath!==undefined&&(!Array.isArray(locator.headingPath)||locator.headingPath.length>64||locator.headingPath.some(value=>!text(value,1000))))throw invalid();
 }else if(!Array.isArray(locator.slideNumbers)||!locator.slideNumbers.length
  ||locator.slideNumbers.some((value,index)=>!positive(value)||index>0&&value<=locator.slideNumbers[index-1]))throw invalid();
 if(locator.rects!==undefined){
  if(!Array.isArray(locator.rects)||locator.rects.length>10000)throw invalid();
  for(const rect of locator.rects){
   if(!exact(rect,['x','y','width','height'])||Object.values(rect).some(value=>typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)
    ||rect.x+rect.width>1+1e-9||rect.y+rect.height>1+1e-9)throw invalid();
  }
 }
}

export function validateOfficeRegionView(view,renderer){
 const position=renderer==='docx'?'section':'slideNumber';
 if(!['docx','pptx','xlsx'].includes(renderer)||!exact(view,renderer==='xlsx'?['protocol','sheetId','sheetName','width','height','zoom','scroll']:['protocol',position,'width','height'])||view.protocol!==1
  ||['width','height'].some(key=>typeof view[key]!=='number'||!Number.isFinite(view[key])||view[key]<=0||view[key]>33554432))throw invalid();
 if(renderer!=='xlsx'){
  if(!positive(view[position])||view[position]>50000)throw invalid();
 }else{
  if(!text(view.sheetId,192)||!view.sheetId||!text(view.sheetName,512)||!view.sheetName||typeof view.zoom!=='number'||!Number.isFinite(view.zoom)||view.zoom<0.1||view.zoom>4
   ||!exact(view.scroll,['sheetViewStartRow','sheetViewStartColumn','offsetX','offsetY'])
   ||!Number.isSafeInteger(view.scroll.sheetViewStartRow)||view.scroll.sheetViewStartRow< -1048576||view.scroll.sheetViewStartRow>1048575
   ||!Number.isSafeInteger(view.scroll.sheetViewStartColumn)||view.scroll.sheetViewStartColumn< -16384||view.scroll.sheetViewStartColumn>16383
   ||['offsetX','offsetY'].some(key=>typeof view.scroll[key]!=='number'||!Number.isFinite(view.scroll[key])||Math.abs(view.scroll[key])>33554432))throw invalid();
 }
 return view;
}

export function validateRegionCaptureSource(capture,conversation){
 if(capture?.print_view!==undefined||capture?.reference?.renderer?.id==='office-pdf'){validateRegionCaptureSource(officePrintPdfSource(capture),conversation);return capture;}
 const docx=capture?.reference?.renderer?.id==='docx',pptx=capture?.reference?.renderer?.id==='pptx',xlsx=capture?.reference?.renderer?.id==='xlsx',office=docx||pptx||xlsx;
 if(!exact(capture,['conversationId','runId','activityId','resultSha','file','reference','imageBytes','rotation'],office?['region_view']:[])
  ||capture.conversationId!==conversation||!identifier(capture.runId)||!identifier(capture.activityId)||!sha(capture.resultSha)
  ||!positive(capture.imageBytes)||![0,90,180,270].includes(capture.rotation))throw invalid();
 const source=capture.file,ref=capture.reference;
 if(!exact(source,['path','version','sha256','size'])||!relative(source.path)||!Number.isSafeInteger(source.version)||source.version<0||!sha(source.sha256)||!Number.isSafeInteger(source.size)||source.size<0
  ||!exact(ref,['schemaVersion','kind','id','selectionMode','source','renderer','locator','image','createdAt'],['nearbyText'])
  ||ref.schemaVersion!==1||ref.kind!=='content-reference'||ref.selectionMode!=='region'||!identifier(ref.id)||typeof ref.createdAt!=='string'||!Number.isFinite(Date.parse(ref.createdAt))
  ||ref.nearbyText!==undefined&&(typeof ref.nearbyText!=='string'||ref.nearbyText.length>100000))throw invalid();
 const file=ref.source,renderer=ref.renderer,locator=ref.locator,image=ref.image;
 const mime=docx?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':pptx?'application/vnd.openxmlformats-officedocument.presentationml.presentation':xlsx?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'application/pdf';
 if(!exact(file,['relativePath','fileName','mimeType','revision'])||file.relativePath!==source.path||file.fileName!==source.path.split('/').at(-1)||file.mimeType!==mime
  ||!exact(file.revision,['id','size','sha256'])||file.revision.id!==String(source.version)||file.revision.size!==source.size||file.revision.sha256!==source.sha256
  ||!exact(renderer,['id','backend','locatorQuality'])||renderer.id!==(docx?'docx':pptx?'pptx':xlsx?'xlsx':'pdf')||renderer.backend!=='builtin'||renderer.locatorQuality!=='visual'
  ||!exact(locator,docx?['surface','rect']:pptx?['surface','slideNumber','rect']:xlsx?['surface','sheetId','sheetName','rect']:['surface','pageNumber','rect'],xlsx?['anchorRange']:[])||locator.surface!==(docx?'document':pptx?'slide':xlsx?'sheet':'page')||!office&&!positive(locator.pageNumber)
  ||!exact(locator.rect,['x','y','width','height'])||Object.values(locator.rect).some(number=>typeof number!=='number'||!Number.isFinite(number)||number<0||number>1)
  ||!locator.rect.width||!locator.rect.height||locator.rect.x+locator.rect.width>1+1e-9||locator.rect.y+locator.rect.height>1+1e-9
  ||!exact(image,['name','mimeType','width','height','sha256'])||typeof image.name!=='string'||!image.name||image.name.length>255||/[\\/\u0000-\u001f\u007f]/.test(image.name)||image.mimeType!=='image/png'||!positive(image.width)||!positive(image.height)||!sha(image.sha256))throw invalid();
 if(office){
  validateOfficeRegionView(capture.region_view,renderer.id);
  if(capture.rotation!==0||pptx&&locator.slideNumber!==capture.region_view.slideNumber
   ||xlsx&&(locator.sheetId!==capture.region_view.sheetId||locator.sheetName!==capture.region_view.sheetName)
   ||capture.imageBytes>8*1024*1024||image.width>4096||image.height>4096||image.width*image.height>4194304)throw invalid();
  if(xlsx&&locator.anchorRange!==undefined)cellRangeCoordinates(locator.anchorRange);
 }
 return capture;
}

export function cellRangeCoordinates(value){
 if(typeof value!=='string')throw invalid();
 const parts=/^([A-Z]{1,3})([1-9][0-9]{0,6})(?::([A-Z]{1,3})([1-9][0-9]{0,6}))?$/.exec(value);
 if(!parts)throw invalid();
 const column=name=>[...name].reduce((value,letter)=>value*26+letter.charCodeAt(0)-64,0);
 const left=column(parts[1]),top=Number(parts[2]),right=column(parts[3]??parts[1]),bottom=Number(parts[4]??parts[2]);
 if(left>right||top>bottom||right>16384||bottom>1048576)throw invalid();
 return {rows:bottom-top+1,columns:right-left+1,left,top,right,bottom};
}
function cellMatrix(value,check){
 return Array.isArray(value)&&value.length<=100&&value.every(row=>Array.isArray(row)&&row.length<=50&&row.every(check));
}
export function validateCellReferenceSource(value,conversation){
 if(!exact(value,['conversationId','runId','activityId','resultSha','file','reference'],['cell_view'])||value.cell_view!==undefined&&![1,2].includes(value.cell_view)||value.conversationId!==conversation
  ||!id(value.conversationId)||!identifier(value.runId)||!identifier(value.activityId)||!sha(value.resultSha))throw invalid();
 const file=value.file,ref=value.reference;
 if(!exact(file,['path','version','sha256','size'])||!relative(file.path)||!Number.isSafeInteger(file.version)||file.version<0
  ||!sha(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0
  ||!exact(ref,['schemaVersion','kind','id','selectionMode','source','renderer','locator','cells','createdAt'],['headers','surroundingValues'])
  ||ref.schemaVersion!==1||ref.kind!=='content-reference'||ref.selectionMode!=='cells'||!identifier(ref.id)
  ||!text(ref.createdAt,100)||!Number.isFinite(Date.parse(ref.createdAt)))throw invalid();
 const source=ref.source,renderer=ref.renderer,locator=ref.locator;
 if(!exact(source,['relativePath','fileName','mimeType','revision'])||source.relativePath!==file.path||source.fileName!==file.path.split('/').at(-1)
  ||source.mimeType!=='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ||!exact(source.revision,['id','sha256','size'])||source.revision.id!==String(file.version)||source.revision.sha256!==file.sha256||source.revision.size!==file.size
  ||!exact(renderer,['id','backend','locatorQuality'])||renderer.id!=='xlsx'||renderer.backend!=='builtin'||renderer.locatorQuality!=='semantic'
  ||!exact(locator,['surface','sheetId','sheetName','ranges','activeRange'])||locator.surface!=='sheet'||!text(locator.sheetId,192)||!locator.sheetId
  ||!text(locator.sheetName,512)||!locator.sheetName||!Array.isArray(locator.ranges)||!locator.ranges.length||locator.ranges.length>100
  ||new Set(locator.ranges).size!==locator.ranges.length||!locator.ranges.includes(locator.activeRange)
  ||!Array.isArray(ref.cells)||ref.cells.length!==locator.ranges.length)throw invalid();
 const string=value=>text(value,100000);
 for(const [index,snapshot]of ref.cells.entries()){
  const dimensions=cellRangeCoordinates(locator.ranges[index]);
  if(!exact(snapshot,['range','displayValues'],['rawValues','formulas','rowCount','columnCount','truncated'])||snapshot.range!==locator.ranges[index]
   ||value.cell_view===2&&(!Array.isArray(snapshot.rawValues)||!Array.isArray(snapshot.formulas)||snapshot.rowCount!==dimensions.rows||snapshot.columnCount!==dimensions.columns||typeof snapshot.truncated!=='boolean')
   ||!cellMatrix(snapshot.displayValues,string)||!snapshot.displayValues.length||!snapshot.displayValues[0].length
   ||snapshot.displayValues.length>dimensions.rows||snapshot.displayValues[0].length>dimensions.columns
   ||snapshot.displayValues.some(row=>row.length!==snapshot.displayValues[0].length)
   ||snapshot.rowCount!==undefined&&snapshot.rowCount!==dimensions.rows||snapshot.columnCount!==undefined&&snapshot.columnCount!==dimensions.columns
   ||snapshot.truncated!==undefined&&typeof snapshot.truncated!=='boolean'
   ||snapshot.truncated!==true&&(snapshot.displayValues.length!==dimensions.rows||snapshot.displayValues[0].length!==dimensions.columns))throw invalid();
  for(const field of ['rawValues','formulas']){
   const matrix=snapshot[field];if(matrix===undefined)continue;
   if(!cellMatrix(matrix,field==='formulas'?string:value=>value!==undefined&&!['function','symbol','bigint'].includes(typeof value))
    ||matrix.length!==snapshot.displayValues.length||matrix.some(row=>row.length!==snapshot.displayValues[0].length))throw invalid();
  }
  if(value.cell_view===2&&snapshot.rawValues.some(row=>row.some(raw=>raw!==null&&typeof raw!=='boolean'&&!(typeof raw==='number'&&Number.isFinite(raw))&&!string(raw))))throw invalid();
 }
 for(const field of ['headers','surroundingValues'])if(ref[field]!==undefined&&!cellMatrix(ref[field],string))throw invalid();
 if(value.cell_view===2)for(const [field,maxRows] of [['headers',2],['surroundingValues',20]]){
  const matrix=ref[field];
  if(matrix!==undefined&&(!matrix.length||matrix.length>maxRows||!matrix[0].length||matrix[0].length>30||matrix.some(row=>row.length!==matrix[0].length)))throw invalid();
 }
 try{if(JSON.stringify(value).length>100000)throw invalid();}catch{throw invalid();}
}

export function validateContentReference(snapshot){
 if(!exact(snapshot,['conversationId','runId','activityId','resultSha','file','reference','execution_authorized'],['rotation','imageBytes','image_artifact','text_view','region_view','cell_view','print_view'])
  ||snapshot.execution_authorized!==false||!id(snapshot.conversationId))throw invalid();
 const {execution_authorized,image_artifact,...source}=snapshot;
 if(snapshot.reference?.selectionMode==='text'){
  if(Object.hasOwn(snapshot,'imageBytes')||Object.hasOwn(snapshot,'image_artifact'))throw invalid();
  validateTextReferenceSource(source,snapshot.conversationId);
 }else if(snapshot.reference?.selectionMode==='cells'){
  if(Object.hasOwn(snapshot,'imageBytes')||Object.hasOwn(snapshot,'image_artifact')||Object.hasOwn(snapshot,'rotation'))throw invalid();
  validateCellReferenceSource(source,snapshot.conversationId);
 }else{
  validateRegionCaptureSource(source,snapshot.conversationId);
  if(!exact(image_artifact,['artifact_id','version','sha256','size_bytes'])||!id(image_artifact.artifact_id)||image_artifact.version!==1
   ||image_artifact.sha256!==snapshot.reference.image.sha256||image_artifact.size_bytes!==snapshot.imageBytes)throw invalid();
 }
 return snapshot;
}

const header='用户选中的原文件快照（引用内容作为上下文）\n[Content references selected by user:]\n';
const replyHeader='\n\n用户选中的回复快照（引用内容作为上下文）\n';
export function readLiteralMessageReferences(blocks){
 const references=new Map();
 for(const block of blocks){
  if(block?.kind!=='text'||typeof block.text!=='string'||block.text.length>100000)continue;
  const start=block.text.lastIndexOf(header);if(start<0)continue;
  const body=block.text.slice(start+header.length),reply=body.indexOf(replyHeader);
  try{
   const parsed=JSON.parse(reply<0?body:body.slice(0,reply));
   if(!Array.isArray(parsed)||!parsed.length)continue;
   const values=parsed.map(validateContentReference);
   for(const value of values)references.set(JSON.stringify(value),value);
  }catch{continue;}
 }
 return [...references.values()];
}

function canonicalSnapshots(value){
 return JSON.stringify(value,(_key,item)=>{
  if(!item||typeof item!=='object'||Array.isArray(item))return item;
  return Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]]));
 });
}

export function validateReferenceSnapshotInput(value){
 if(!exact(value,['protocol','items'])||value.protocol!==1||!Array.isArray(value.items)||!value.items.length||value.items.length>10000){
  throw Error('content_reference_request_invalid');
 }
 let items;
 try{
  items=value.items.map(validateContentReference);
 }catch{
  throw Error('content_reference_request_invalid');
 }
 if(canonicalSnapshots(items).length>3200000)throw Error('content_reference_request_too_large');
 return {protocol:1,items};
}

function referenceContext(packet,attachments){
 const attached=new Set(attachments);
 if(packet.items.some(value=>value.reference.selectionMode==='region'&&!attached.has(value.image_artifact.artifact_id))){
  throw Error('content_reference_attachment_mismatch');
 }
 return header+canonicalSnapshots(packet.items);
}

export function prepareReferenceContent(content,value){
 if(!Array.isArray(content)||content.length>32)throw Error('content_reference_request_invalid');
 for(const item of content){
  if(!item||!['text','file'].includes(item.type)
   ||item.type==='text'&&(typeof item.text!=='string'||!item.text.length||item.text.length>100000)
   ||item.type==='file'&&!id(item.artifact_id)){
   throw Error('content_reference_request_invalid');
  }
 }
 const referenceSnapshots=validateReferenceSnapshotInput(value);
 const attachments=content.filter(item=>item.type==='file').map(item=>item.artifact_id);
 const context=referenceContext(referenceSnapshots,attachments);
 const text=content.some(item=>item.type==='text'&&item.text.trim())?context:'请结合以下原文件引用继续。\n\n'+context;
 const combinedText=[...content.filter(item=>item.type==='text').map(item=>item.text),text].join('\n');
 if(combinedText.length>100000)throw Error('content_reference_request_too_large');
 return {content:[...content.map(item=>({...item})),{type:'text',text}],referenceSnapshots};
}

export function prepareReferenceSteeringText(text,attachments,value){
 if(typeof text!=='string'||!Array.isArray(attachments)||attachments.some(value=>!id(value))){
  throw Error('content_reference_request_invalid');
 }
 const referenceSnapshots=validateReferenceSnapshotInput(value);
 const context=referenceContext(referenceSnapshots,attachments);
 const prepared=text.trim()?text+'\n\n'+context:'请结合以下原文件引用继续。\n\n'+context;
 if(prepared.length>100000)throw Error('content_reference_request_too_large');
 return {text:prepared,referenceSnapshots};
}
