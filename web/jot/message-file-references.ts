import {readLiteralMessageReferences,validateContentReference} from '../../packages/gateway/src/messages/content-reference.js';
import type {FileSourceReference} from './FileTextReferences';
import type {Message} from './types';

export function messageFileReferences(message:Message,owner:string):FileSourceReference[]{
 if(message.role!=='user'||message.status!=='complete'||!/^[a-f0-9]{64}$/.test(owner))return [];
 try{
  const saved=message.reference_snapshots;
  let values:Array<Record<string,unknown>>;
  if(Object.hasOwn(message,'reference_snapshots')){
   if(!saved||Object.keys(saved).sort().join(',')!=='items,protocol,state'||saved.protocol!==1||saved.state!=='ready'
    ||!Array.isArray(saved.items)||!saved.items.length||saved.items.length>10000)return [];
   values=saved.items;
  }else values=readLiteralMessageReferences(message.blocks);
  return values.map(snapshot=>{
   const {execution_authorized,image_artifact,...source}=validateContentReference(snapshot);
   return {...source,owner} as unknown as FileSourceReference;
  });
 }catch{return [];}
}
