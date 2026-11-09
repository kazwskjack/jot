const exact=(value,required,optional=[])=>!!value&&typeof value==='object'&&!Array.isArray(value)
 &&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const invalid=()=>Error('composer_draft_invalid');
const relative=value=>text(value,4096)&&value.length>0&&!/[\\:\u0000-\u001f\u007f]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');

export const emptyComposerDraft=()=>({text:'',replyQuotes:[],textReferences:[],goalMode:false});

function validateTextReference(value,conversation,scope){
 if(!exact(value,['owner','conversationId','runId','activityId','resultSha','file','reference'],['rotation'])||!sha(value.owner)||scope!==undefined&&value.owner!==scope
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

export function validateComposerDraft(value,conversation,scope){
 if(!exact(value,['text','replyQuotes','textReferences','goalMode'])||!text(value.text,100000)||typeof value.goalMode!=='boolean'
  ||!Array.isArray(value.replyQuotes)||!Array.isArray(value.textReferences)||JSON.stringify(value).length>262144)throw invalid();
 const quoteIds=new Set(),referenceIds=new Set();
 for(const quote of value.replyQuotes){
  if(!exact(quote,['id','conversationId','messageId','selectedText','surroundingText','prefix','suffix','truncated'])
   ||!id(quote.id)||quoteIds.has(quote.id)||quote.conversationId!==conversation||!id(quote.messageId)||!text(quote.selectedText,8000)||!quote.selectedText.trim()
   ||!text(quote.surroundingText,8600)||!text(quote.prefix,80)||!text(quote.suffix,80)||typeof quote.truncated!=='boolean')throw invalid();
  quoteIds.add(quote.id);
 }
 for(const reference of value.textReferences){
  validateTextReference(reference,conversation,scope);
  if(referenceIds.has(reference.reference.id))throw invalid();
  referenceIds.add(reference.reference.id);
 }
 return value;
}
