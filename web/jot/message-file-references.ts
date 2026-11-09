import {readLiteralMessageReferences,validateContentReference} from '../../packages/gateway/src/messages/content-reference.js';
import type {FileSourceReference} from './FileTextReferences';
import type {Message} from './types';

export function messageFileReferences(message:Message,owner:string):FileSourceReference[]{
 if(message.role!=='user'||message.status!=='complete'||!/^[a-f0-9]{64}$/.test(owner))return [];
 const values=readLiteralMessageReferences(message.blocks);
 return values.map(snapshot=>{
  const {execution_authorized,image_artifact,...source}=validateContentReference(snapshot);
  return {...source,owner} as unknown as FileSourceReference;
 });
}
