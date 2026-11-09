import {validateTextReference} from './composer-draft-recovery.mjs';
import {validateRegionCapture} from './upload-recovery.mjs';
import {CONTENT_REFERENCE_PROMPT_MARKER} from './vendor/pilotdeck-content-reference';
import type {FileSourceReference} from './FileTextReferences';
import type {Message} from './types';

const header=`用户选中的原文件快照（引用内容作为上下文）\n${CONTENT_REFERENCE_PROMPT_MARKER}\n`;
const replyHeader='\n\n用户选中的回复快照（引用内容作为上下文）\n';
const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(value);
const exact=(value:any,required:string[],optional:string[]=[])=>!!value&&typeof value==='object'&&!Array.isArray(value)
 &&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));

function referenceSnapshot(snapshot:any,owner:string):FileSourceReference{
 if(!exact(snapshot,['conversationId','runId','activityId','resultSha','file','reference','execution_authorized'],['rotation','imageBytes','image_artifact'])
  ||snapshot.execution_authorized!==false||!id(snapshot.conversationId))throw Error('message_reference_invalid');
 const {execution_authorized,image_artifact,...source}=snapshot,value={...source,owner};
 if(snapshot.reference?.selectionMode==='text'){
  if(Object.hasOwn(snapshot,'imageBytes')||Object.hasOwn(snapshot,'image_artifact'))throw Error('message_reference_invalid');
  validateTextReference(value,snapshot.conversationId,owner);
 }else{
  validateRegionCapture(value,snapshot.conversationId,owner);
  if(!exact(image_artifact,['artifact_id','version','sha256','size_bytes'])||!id(image_artifact.artifact_id)||image_artifact.version!==1
   ||image_artifact.sha256!==snapshot.reference.image.sha256||image_artifact.size_bytes!==snapshot.imageBytes)throw Error('message_reference_invalid');
 }
 return value as FileSourceReference;
}

// Historical request text remains literal, user-provided material. Source opening uses the original authorized reader.
export function messageFileReferences(message:Message,owner:string):FileSourceReference[]{
 if(message.role!=='user'||message.status!=='complete')return [];
 const references=new Map<string,FileSourceReference>();
 for(const block of message.blocks){
  if(block.kind!=='text'||typeof block.text!=='string'||block.text.length>100000)continue;
  const start=block.text.lastIndexOf(header);if(start<0)continue;
  const body=block.text.slice(start+header.length),reply=body.indexOf(replyHeader);
  try{
   const parsed:unknown=JSON.parse(reply<0?body:body.slice(0,reply));
   if(!Array.isArray(parsed)||!parsed.length)continue;
   const values=parsed.map(value=>referenceSnapshot(value,owner));
   for(const value of values){
    const key=JSON.stringify(value);
    references.set(key,value);
   }
  }catch{continue;}
 }
 return [...references.values()];
}
