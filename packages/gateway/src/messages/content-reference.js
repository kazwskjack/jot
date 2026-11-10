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

export function validateTextReferenceSource(value,conversation){
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

export function validateRegionCaptureSource(capture,conversation){
 if(!exact(capture,['conversationId','runId','activityId','resultSha','file','reference','imageBytes','rotation'])
  ||capture.conversationId!==conversation||!identifier(capture.runId)||!identifier(capture.activityId)||!sha(capture.resultSha)
  ||!positive(capture.imageBytes)||![0,90,180,270].includes(capture.rotation))throw invalid();
 const source=capture.file,ref=capture.reference;
 if(!exact(source,['path','version','sha256','size'])||!relative(source.path)||!Number.isSafeInteger(source.version)||source.version<0||!sha(source.sha256)||!Number.isSafeInteger(source.size)||source.size<0
  ||!exact(ref,['schemaVersion','kind','id','selectionMode','source','renderer','locator','image','createdAt'],['nearbyText'])
  ||ref.schemaVersion!==1||ref.kind!=='content-reference'||ref.selectionMode!=='region'||!identifier(ref.id)||typeof ref.createdAt!=='string'||!Number.isFinite(Date.parse(ref.createdAt))
  ||ref.nearbyText!==undefined&&(typeof ref.nearbyText!=='string'||ref.nearbyText.length>100000))throw invalid();
 const file=ref.source,renderer=ref.renderer,locator=ref.locator,image=ref.image;
 if(!exact(file,['relativePath','fileName','mimeType','revision'])||file.relativePath!==source.path||file.fileName!==source.path.split('/').at(-1)||file.mimeType!=='application/pdf'
  ||!exact(file.revision,['id','size','sha256'])||file.revision.id!==String(source.version)||file.revision.size!==source.size||file.revision.sha256!==source.sha256
  ||!exact(renderer,['id','backend','locatorQuality'])||renderer.id!=='pdf'||renderer.backend!=='builtin'||renderer.locatorQuality!=='visual'
  ||!exact(locator,['surface','pageNumber','rect'])||locator.surface!=='page'||!positive(locator.pageNumber)
  ||!exact(locator.rect,['x','y','width','height'])||Object.values(locator.rect).some(number=>typeof number!=='number'||!Number.isFinite(number)||number<0||number>1)
  ||!locator.rect.width||!locator.rect.height||locator.rect.x+locator.rect.width>1+1e-9||locator.rect.y+locator.rect.height>1+1e-9
  ||!exact(image,['name','mimeType','width','height','sha256'])||typeof image.name!=='string'||!image.name||image.name.length>255||/[\\/\u0000-\u001f\u007f]/.test(image.name)||image.mimeType!=='image/png'||!positive(image.width)||!positive(image.height)||!sha(image.sha256))throw invalid();
 return capture;
}

export function validateContentReference(snapshot){
 if(!exact(snapshot,['conversationId','runId','activityId','resultSha','file','reference','execution_authorized'],['rotation','imageBytes','image_artifact'])
  ||snapshot.execution_authorized!==false||!id(snapshot.conversationId))throw invalid();
 const {execution_authorized,image_artifact,...source}=snapshot;
 if(snapshot.reference?.selectionMode==='text'){
  if(Object.hasOwn(snapshot,'imageBytes')||Object.hasOwn(snapshot,'image_artifact'))throw invalid();
  validateTextReferenceSource(source,snapshot.conversationId);
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
