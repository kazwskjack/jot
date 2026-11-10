import {validateTextReferenceSource,validateCellReferenceSource} from '../../packages/gateway/src/messages/content-reference.js';
const exact=(value,required,optional=[])=>!!value&&typeof value==='object'&&!Array.isArray(value)
 &&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length<=max;
const invalid=()=>Error('composer_draft_invalid');

export const emptyComposerDraft=()=>({text:'',replyQuotes:[],textReferences:[],goalMode:false});

export function validateTextReference(value,conversation,scope){
 if(!value||!sha(value.owner)||scope!==undefined&&value.owner!==scope)throw invalid();
 const {owner,...source}=value;
 try{if(source.reference?.selectionMode==='cells')validateCellReferenceSource(source,conversation);else validateTextReferenceSource(source,conversation);}catch{throw invalid();}
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
