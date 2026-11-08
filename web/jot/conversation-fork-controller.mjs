const idempotencyKey=()=>{
 const key=globalThis.crypto?.randomUUID?.();
 if(typeof key!=='string'||!key)throw new Error('fork_idempotency_key_unavailable');
 return key;
};

function validateRequest(source,message){
 if(!source||typeof source.conversation_id!=='string'||!source.conversation_id||!Number.isSafeInteger(source.version)||source.version<1
  ||!message||typeof message.message_id!=='string'||!message.message_id||message.status!=='complete')throw new Error('fork_selection_invalid');
 return{path:`/conversations/${encodeURIComponent(source.conversation_id)}/fork`,method:'POST',body:{expected_version:source.version,through_message_id:message.message_id}};
}

function validateReceipt(value,pending){
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.conversation_id!=='string'||!value.conversation_id||value.conversation_id===pending.sourceConversationId
  ||typeof value.fork_id!=='string'||!value.fork_id||value.state!=='ready'||!value.source||value.source.conversation_id!==pending.sourceConversationId
  ||value.source.through_message_id!==pending.throughMessageId||typeof value.source.head_sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.source.head_sha256))throw new Error('fork_receipt_invalid');
 return value;
}

const pendingSchema='jot.conversation-fork.pending.v1';
const pendingStorageKey=sourceConversationId=>`jot:conversation-fork:${encodeURIComponent(sourceConversationId)}`;
function validPendingRecord(record,sourceConversationId){
 if(!record||typeof record!=='object'||Array.isArray(record)||Object.keys(record).sort().join(',')!=='body,key,method,path,schema,sourceConversationId'
  ||record.schema!==pendingSchema||record.sourceConversationId!==sourceConversationId||record.method!=='POST'
  ||typeof record.key!=='string'||!/^[\x21-\x7E]{8,128}$/.test(record.key)||!record.body||typeof record.body!=='object'||Array.isArray(record.body)
  ||Object.keys(record.body).sort().join(',')!=='expected_version,through_message_id'
  ||!Number.isSafeInteger(record.body.expected_version)||record.body.expected_version<1
  ||typeof record.body.through_message_id!=='string'||!record.body.through_message_id)return false;
 let expected;try{expected=validateRequest({conversation_id:sourceConversationId,version:record.body.expected_version},{message_id:record.body.through_message_id,status:'complete'});}catch{return false;}
 return record.path===expected.path;
}

export function conversationForkRetrySource(source,selection,messageId){
 if(!source||!selection||selection.sourceConversationId!==source.conversation_id||selection.throughMessageId!==messageId
  ||!Number.isSafeInteger(selection.expectedVersion)||selection.expectedVersion<1)return source;
 return{...source,version:selection.expectedVersion};
}

const noEffectStatuses=new Map([
 ['FORK_SOURCE_CHANGED',409],['FORK_BOUNDARY_NOT_FOUND',409],
 ['FORK_ATTACHMENT_COUNT_INVALID',413],['FORK_ATTACHMENT_AGGREGATE_SIZE_INVALID',413]
]);
export function isKnownNoEffectConversationForkError(error){
 const status=noEffectStatuses.get(error?.message);
 return status!==undefined&&status===error?.status;
}

/** A browser-side exact-request writer. Unknown outcomes stay pending; retry
 * reuses the original boundary, body and idempotency key without guessing. */
export class ConversationForkWriter{
 #request;
 #pending;
 #storage;
 #storageKey;
 #sourceConversationId;
 #persistent;
 #storageBlocked=false;
 /**
  * @param {typeof import('./client').request} request
  * @param {{storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>|null,sourceConversationId?:string}} [options]
  */
 constructor(request,{storage=null,sourceConversationId}={}){
  if(typeof request!=='function')throw new TypeError('fork_request_required');this.#request=request;this.#pending=null;
  this.#storage=storage;this.#sourceConversationId=sourceConversationId??null;this.#persistent=typeof sourceConversationId==='string'&&!!sourceConversationId;
  this.#storageKey=this.#persistent?pendingStorageKey(sourceConversationId):null;
  if(this.#persistent)this.#restore();
 }
 get pending(){return this.#pending!==null;}
 get pendingSelection(){if(!this.#pending)return null;return Object.freeze({sourceConversationId:this.#pending.sourceConversationId,expectedVersion:this.#pending.body.expected_version,throughMessageId:this.#pending.throughMessageId});}
 async fork(source,message){
  if(this.#pending)throw new Error('fork_retry_required');
  if(this.#persistent&&source?.conversation_id!==this.#sourceConversationId)throw new Error('fork_selection_invalid');
  const request=validateRequest(source,message);
  this.#pending={...request,key:idempotencyKey(),sourceConversationId:source.conversation_id,throughMessageId:message.message_id};
  return this.#send();
 }
 async retry(){if(!this.#pending)throw new Error('fork_retry_unavailable');return this.#send();}
 #restore(){
  if(!this.#storage||typeof this.#storage.getItem!=='function'){this.#storageBlocked=true;return;}
  try{
   const raw=this.#storage.getItem(this.#storageKey);if(!raw)return;
   const record=JSON.parse(raw);if(!validPendingRecord(record,this.#sourceConversationId)){this.#storageBlocked=true;return;}
   this.#pending={path:record.path,method:record.method,body:record.body,key:record.key,sourceConversationId:record.sourceConversationId,throughMessageId:record.body.through_message_id};
  }catch{this.#storageBlocked=true;}
 }
 #persist(pending){
  if(!this.#persistent)return true;
  if(this.#storageBlocked||!this.#storage||typeof this.#storage.getItem!=='function'||typeof this.#storage.setItem!=='function')return false;
  const record={schema:pendingSchema,sourceConversationId:pending.sourceConversationId,path:pending.path,method:pending.method,body:pending.body,key:pending.key};
  try{
   const existing=this.#storage.getItem(this.#storageKey);
   if(existing){const saved=JSON.parse(existing);return validPendingRecord(saved,this.#sourceConversationId)&&saved.path===record.path&&saved.method===record.method&&saved.key===record.key&&JSON.stringify(saved.body)===JSON.stringify(record.body);}
   this.#storage.setItem(this.#storageKey,JSON.stringify(record));return true;
  }catch{return false;}
 }
 #clear(pending){
  if(!this.#persistent||!this.#storage||typeof this.#storage.getItem!=='function'||typeof this.#storage.removeItem!=='function')return;
  try{
   const raw=this.#storage.getItem(this.#storageKey);if(!raw)return;const saved=JSON.parse(raw);
   if(validPendingRecord(saved,this.#sourceConversationId)&&saved.path===pending.path&&saved.method===pending.method&&saved.key===pending.key&&JSON.stringify(saved.body)===JSON.stringify(pending.body))this.#storage.removeItem(this.#storageKey);
  }catch{}
 }
 async #send(){
  const pending=this.#pending;if(!pending)throw new Error('fork_retry_unavailable');
  if(!this.#persist(pending))throw new Error('FORK_INTENT_STORAGE_UNAVAILABLE');
  let receipt;
  try{receipt=await this.#request(pending.path,pending.method,structuredClone(pending.body),pending.key);}
  catch(error){
   if(isKnownNoEffectConversationForkError(error)){this.#pending=null;this.#clear(pending);}
   throw error;
  }
  const valid=validateReceipt(receipt,pending);this.#pending=null;this.#clear(pending);return valid;
 }
}
