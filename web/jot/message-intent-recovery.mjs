import {prepareReferenceContent,prepareReferenceSteeringText} from '../../packages/gateway/src/messages/content-reference.js';
import {UploadRecoveryStore} from './upload-recovery.mjs';
import {validateComposerDraft} from './composer-draft-recovery.mjs';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(value);
const exact=(value,required,optional=[])=>!!value&&typeof value==='object'&&!Array.isArray(value)
 &&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const invalid=()=>Error('message_recovery_invalid');
const files=(value,max)=>Array.isArray(value)&&value.length<=max&&value.every(id)&&new Set(value).size===value.length;

export function validateMessageReceipt(receipt,pending,conversation){
 const valid=pending.kind==='steer'
  ?exact(receipt,['accepted','command_id','run_id'])&&receipt.accepted===true&&receipt.run_id===pending.runId&&id(receipt.command_id)
  :exact(receipt,['accepted','conversation_id','message_id','run_id'])&&receipt.accepted===true&&receipt.conversation_id===conversation&&id(receipt.message_id)&&id(receipt.run_id);
 if(!valid)throw Error('发送结果尚未确认，请重试原消息');
 return receipt;
}

export function messageIntentAttachments(pending){
 return pending?.kind==='steer'?[...(pending.body.attachments??[])]:pending?.body.content.filter(part=>part.type==='file').map(part=>part.artifact_id)??[];
}

export function validateMessageIntent(snapshot,conversation,scope){
 if(!exact(snapshot,['pending'],['draft']))throw invalid();
 if(Object.hasOwn(snapshot,'draft'))validateComposerDraft(snapshot.draft,conversation,scope);
 const pending=snapshot.pending;
 if(pending===null)return snapshot;
 if(!exact(pending,['kind','path','key','body'],['runId','receipt'])||!['message','steer'].includes(pending.kind)
  ||typeof pending.key!=='string'||!/^[\x21-\x7e]{8,128}$/.test(pending.key))throw invalid();
 const body=pending.body;
 if(pending.kind==='steer'){
  if(!id(pending.runId)||pending.path!==`/runs/${encodeURIComponent(pending.runId)}/steer`
   ||!exact(body,['delivery','text','client_message_id','expected_run_version'],['attachments','reference_snapshots'])||body.delivery!=='original'
   ||typeof body.text!=='string'||body.text.length>100000||!id(body.client_message_id)
   ||!Number.isSafeInteger(body.expected_run_version)||body.expected_run_version<1
   ||body.attachments!==undefined&&(!files(body.attachments,10)||!body.attachments.length)
   ||!body.text.trim()&&!body.attachments?.length&&!Object.hasOwn(body,'reference_snapshots'))throw invalid();
  if(Object.hasOwn(body,'reference_snapshots'))prepareReferenceSteeringText(body.text,body.attachments??[],body.reference_snapshots);
 }else{
  if(Object.hasOwn(pending,'runId')||pending.path!==`/conversations/${encodeURIComponent(conversation)}/messages`
   ||!exact(body,['client_message_id','content'],['client_time_zone','reference_snapshots'])||!id(body.client_message_id)
   ||body.client_time_zone!==undefined&&(typeof body.client_time_zone!=='string'||body.client_time_zone.length>256)
   ||!Array.isArray(body.content)||!body.content.length&&!Object.hasOwn(body,'reference_snapshots')||body.content.length>32)throw invalid();
  for(const part of body.content){
   if(part?.type==='text'){
    if(!exact(part,['type','text'])||typeof part.text!=='string'||!part.text.length||part.text.length>100000)throw invalid();
   }else if(part?.type==='file'){
    if(!exact(part,['type','artifact_id'])||!id(part.artifact_id))throw invalid();
   }else throw invalid();
  }
  if(!files(messageIntentAttachments(pending),32))throw invalid();
  if(Object.hasOwn(body,'reference_snapshots'))prepareReferenceContent(body.content,body.reference_snapshots);
 }
 if(Object.hasOwn(pending,'receipt'))validateMessageReceipt(pending.receipt,pending,conversation);
 return snapshot;
}

// Reuse the original strict-durability, revision-checked store with a separate key space.
export class MessageIntentRecoveryStore extends UploadRecoveryStore {
 static async open(factory,scope,conversation){
  const store=await super.open(factory,scope,conversation);
  store.key=`message-intent:${scope}/${conversation}`;
  return store;
 }
 validateSnapshot(snapshot){return validateMessageIntent(snapshot,this.conversation,this.scope);}
}
