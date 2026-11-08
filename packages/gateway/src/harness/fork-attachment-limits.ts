import {attachmentKindForMime,validateAttachmentManifest} from '../artifacts/pinned-manifest.ts';
import type {ForkAttachment} from './conversation-fork.ts';
const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
/** One frozen set for the whole fork, before verification or byte staging. */
export function validateForkAttachmentSet(pins:readonly ForkAttachment[]):ForkAttachment[]{
 const unique=[...new Map(pins.map(pin=>[canonical(pin),pin])).values()];
 if(unique.length>10)throw Error('fork_attachment_count_invalid');
 let total=0;for(const pin of unique){
  validateAttachmentManifest({protocol:1,attachments:[{...pin,kind:attachmentKindForMime(pin.media_type)}]},{maxCount:10,maxAggregateBytes:200*1024*1024});
  total+=pin.size_bytes;if(!Number.isSafeInteger(total)||total>200*1024*1024)throw Error('fork_attachment_aggregate_size_invalid');
 }
 return unique;
}
export function validateFrozenForkAttachments(manifest:unknown){
 const messages=(manifest as {messages?:Array<{attachments?:ForkAttachment[];source_attachments?:ForkAttachment[]}>})?.messages;
 if(!Array.isArray(messages)||messages.some(message=>!message||!Array.isArray(message.attachments)||!Array.isArray(message.source_attachments??message.attachments)
  ||message.source_attachments!==undefined&&(message.source_attachments.length!==message.attachments.length||message.source_attachments.some((pin,i)=>!pin||!['sha256','size_bytes','file_name','media_type'].every(key=>(pin as unknown as Record<string,unknown>)[key]===(message.attachments![i] as unknown as Record<string,unknown>)?.[key])))))throw Error('fork_manifest_corrupt');
 const source=validateForkAttachmentSet(messages.flatMap(message=>message.source_attachments??message.attachments!));
 validateForkAttachmentSet(messages.flatMap(message=>message.attachments!));return source;
}
