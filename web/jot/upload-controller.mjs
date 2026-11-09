import {uploadRecoverySnapshot,restoreUploadRecovery} from './upload-recovery.mjs';
// Upload recovery preserves original request identities. Each stage retains its own body and idempotency key.
// An uncertain stage cannot be replaced with a new upload or attached as ready.
export const maxBatchFiles=500;const maxBatchBytes=2*1024*1024*1024;
export class UploadController {
 constructor(conversationId,api,onChange=()=>{},options={}){
  this.conversationId=conversationId;this.onChange=onChange;this.entries=[];
  this.recoveryReady=!options.recoveryRequired;this.currentScope=options.currentScope;this.recoveryError='';this.persistence=Promise.resolve();this.disposed=false;this.recoveryEpoch=0;
  this.api={...api,request:async(...args)=>{this.assertRecoveryScope();if(!this.store)return api.request(...args);const epoch=this.recoveryEpoch;await this.persist();this.assertRecoveryScope();if(epoch!==this.recoveryEpoch)throw Error('upload_recovery_scope_changed');return api.request(...args);}};
 }
 get blocked(){return this.disposed||!this.recoveryReady||!!this.recoveryError||!!this.store&&this.currentScope?.()!==this.store.scope;}
 assertRecoveryScope(){if(this.blocked)throw new Error(this.recoveryError||'upload_recovery_unavailable');}
 get recoveryBusy(){return this.entries.some(entry=>entry.running||entry.cancelRequested||entry.batch?.running||entry.batch?.cancelRunning);}
 async configureRecovery(store){
  if(this.recoveryBusy)throw Error('upload_recovery_busy');
  const epoch=this.recoveryEpoch;await this.persistence;
  if(store.conversation!==this.conversationId||this.currentScope?.()!==store.scope)throw Error('upload_recovery_scope_changed');
  const snapshot=await store.load();
  if(this.currentScope?.()!==store.scope||this.disposed||epoch!==this.recoveryEpoch)throw Error('upload_recovery_scope_changed');
  this.entries=snapshot?restoreUploadRecovery(snapshot,this.conversationId):[];
  this.store?.close();this.store=store;this.recoveryReady=true;this.recoveryError='';this.onChange();
 }
 dispose(){this.disposed=true;this.recoveryEpoch+=1;for(const entry of this.entries)entry.contentAbort?.abort();this.store?.close();}
 persist(){
  if(!this.store)return Promise.resolve();
  this.assertRecoveryScope();const store=this.store,epoch=this.recoveryEpoch,snapshot=uploadRecoverySnapshot(this.entries);
  const operation=this.persistence.then(()=>{if(this.disposed||epoch!==this.recoveryEpoch||this.currentScope?.()!==store.scope)throw Error('upload_recovery_scope_changed');return store.save(snapshot);});
  this.persistence=operation.catch(()=>{});
  return operation.catch(error=>{this.recoveryError=error instanceof Error?error.message:'upload_recovery_unavailable';this.onChange();throw error;});
 }
 async reselect(id,file){
  this.assertRecoveryScope();const entry=this.entries.find(value=>value.id===id);
  if(!entry||!entry.needsFile||entry.running||!(file instanceof File)||file.name!==entry.file.name||file.size!==entry.file.size
   ||file.webkitRelativePath&&file.webkitRelativePath!==entry.relativePath)throw Error('upload_recovery_file_mismatch');
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('');
  this.assertRecoveryScope();
  if(entry.sha&&entry.sha!==digest)throw Error('upload_recovery_file_mismatch');
  entry.sha=digest;entry.file=file;entry.needsFile=false;await this.persist();this.onChange();
 }
 async acceptRecovered(id){
  this.assertRecoveryScope();const entry=this.entries.find(value=>value.id===id);
  if(!entry||entry.status!=='recovered'||!entry.artifact)throw Error('upload_receipt_invalid');
  entry.status='ready';await this.persist();this.onChange();
 }

 add(file,maxBytes,relativePath=file?.webkitRelativePath||file?.name){
  this.assertRecoveryScope();
  if(!Number.isInteger(maxBytes)||maxBytes<1)throw new Error('upload_limit_unavailable');
  if(!(file instanceof File)||!file.name||file.size<1||file.size>maxBytes)throw new Error('upload_size_invalid');
  const entry={id:crypto.randomUUID(),clientFileId:crypto.randomUUID(),file,fileIdentity:{name:file.name,size:file.size,type:file.type},relativePath,maxBytes,status:'selected',stage:'init',keys:{init:crypto.randomUUID(),content:crypto.randomUUID(),complete:crypto.randomUUID(),cancel:crypto.randomUUID()},error:''};
  this.entries.push(entry);this.onChange();return entry;
 }
 async prepareBatch(ids){
  this.assertRecoveryScope();
  const entries=ids.map(id=>this.entries.find(value=>value.id===id));if(!entries.length||entries.some(value=>!value))throw new Error('upload_not_found');
  const current=entries[0].batch,group=current&&entries.every(entry=>entry.batch===current)?current:{key:crypto.randomUUID(),cancelKey:crypto.randomUUID(),entries,stage:'batch-init',batchId:null,requestBody:null,running:null};
  if(group.requestBody&&(entries.length!==group.entries.length||entries.some((entry,index)=>entry!==group.entries[index])))throw Error('upload_batch_identity_changed');
  group.entries=entries;
  if(entries.length>maxBatchFiles||entries.reduce((total,entry)=>total+entry.file.size,0)>maxBatchBytes){for(const entry of entries){entry.status='rejected';entry.stage='batch-init';entry.error='upload_batch_limit_exceeded';}this.onChange();throw new Error('upload_batch_limit_exceeded');}
  for(const entry of entries){entry.batch=group;entry.stage='batch-init';entry.status='uploading';entry.error='';}
  this.onChange();
  try{
   if(!group.requestBody){const files=[];for(const entry of entries){if(!entry.sha)entry.sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await entry.file.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('');files.push({client_file_id:entry.clientFileId,file_name:entry.file.name,relative_path:entry.relativePath,media_type:(entry.fileIdentity?.type??entry.file.type)||'application/octet-stream',size_bytes:entry.file.size,sha256:entry.sha});}group.requestBody={files};}
   await this.initializeBatch(group);return group;
  }catch(error){if(!group.requestBody){for(const entry of entries){entry.status='rejected';entry.error=error instanceof Error?error.message:'upload_batch_prepare_failed';}}throw error;}
  finally{this.onChange();}
 }
 async initializeBatch(group){
  if(group.batchId)return group;if(group.running)return group.running;
  const running=(async()=>{
   try{
    const receipt=await this.api.request(`/conversations/${encodeURIComponent(this.conversationId)}/upload-batches`,'POST',group.requestBody,group.key);
    const expiry=Date.parse(receipt?.expires_at),files=receipt?.files;
    if(typeof receipt?.batch_id!=='string'||!receipt.batch_id||!Number.isFinite(expiry)||!Array.isArray(files)||files.length!==group.entries.length)throw new Error('upload_receipt_invalid');
    const mapped=new Map();for(const file of files){if(!file||typeof file.client_file_id!=='string'||mapped.has(file.client_file_id)||typeof file.upload_id!=='string'||!file.upload_id||!Number.isInteger(file.max_bytes)||file.max_bytes<1)throw new Error('upload_receipt_invalid');mapped.set(file.client_file_id,file);}
    for(const entry of group.entries){const file=mapped.get(entry.clientFileId);if(!file||file.max_bytes<entry.file.size)throw new Error('upload_receipt_invalid');}
    group.batchId=receipt.batch_id;group.expiresAt=receipt.expires_at;group.stage='content';
    for(const entry of group.entries){const file=mapped.get(entry.clientFileId);entry.batchId=group.batchId;entry.receipt={upload_id:file.upload_id,max_bytes:file.max_bytes,expires_at:group.expiresAt,batch_id:group.batchId};entry.stage='content';entry.status='selected';entry.error='';}
    if(expiry<=Date.now()){
     for(const entry of group.entries){entry.expired=true;entry.status='rejected';}
     await this.persist();throw Object.assign(Error('UPLOAD_EXPIRED'),{status:410});
    }
    await this.persist();return group;
   }catch(error){group.stage='batch-init';for(const entry of group.entries){entry.status=error?.status>=400&&error.status<500&&error.status!==409&&error.status!==408?'rejected':'uncertain';entry.stage='batch-init';entry.error=error instanceof Error?error.message:'upload_unconfirmed';}throw error;}
  })();
  group.running=running;try{return await running;}finally{if(group.running===running)group.running=null;this.onChange();}
 }
 remove(id){this.assertRecoveryScope();const entry=this.entries.find(value=>value.id===id);if(entry?.batchId&&!['ready','recovered','cancelled'].includes(entry.status)&&!entry.expired)throw new Error('upload_batch_cancel_required');if(entry&&['uploading','cancelling','uncertain'].includes(entry.status)&&!entry.expired)throw new Error('upload_unconfirmed');this.entries=this.entries.filter(value=>value.id!==id);this.onChange();if(this.store)return this.persist();}
 get unresolved(){return this.entries.some(entry=>['uploading','cancelling','uncertain'].includes(entry.status)||entry.needsFile&&!['cancelled','ready','recovered'].includes(entry.status));}
 references(){if(this.entries.length)this.assertRecoveryScope();if(this.entries.some(entry=>entry.status!=='ready'))throw new Error('upload_not_ready');return this.entries.map(entry=>entry.artifact.artifact_id);}
 clearSent(expected=this.references()){if(!expected.length)return;this.assertRecoveryScope();const sent=new Set(expected);this.entries=this.entries.filter(entry=>entry.status!=='ready'||!sent.has(entry.artifact.artifact_id));this.onChange();if(this.store)return this.persist();}
 async upload(id){
  this.assertRecoveryScope();
  const entry=this.entries.find(value=>value.id===id);if(!entry)throw new Error('upload_not_found');
  if(entry.stage==='cancel')throw new Error('upload_cancel_required');
  if(entry.stage==='batch-cancel')return this.cancelBatch(entry.batch?.batchId||entry.batch?.key);
  if(entry.running||['uploading','cancelling','cancelled'].includes(entry.status))throw new Error('upload_busy');if(['ready','recovered'].includes(entry.status))return Promise.resolve(entry.artifact);
  const run=async()=>{if(entry.stage==='batch-init'&&entry.batch){if(!entry.batch.requestBody)await this.prepareBatch(entry.batch.entries.map(value=>value.id));else await this.initializeBatch(entry.batch);}return this.performUpload(entry);};
  const running=run().finally(()=>{if(entry.running===running)entry.running=null;});entry.running=running;return running;
 }
 async completeUpload(entry){
  const value=await this.api.request(`/uploads/${encodeURIComponent(entry.receipt.upload_id)}/complete`,'POST',{sha256:entry.sha},entry.keys.complete);
  if(!value||typeof value.artifact_id!=='string'||!value.artifact_id||value.conversation_id!==this.conversationId||value.sha256!==entry.sha||value.size_bytes!==entry.file.size||value.version!==1||value.status!=='ready'||value.origin!=='upload')throw new Error('upload_receipt_invalid');
  entry.artifact=value;entry.stage='done';entry.status=entry.restored?'recovered':'ready';await this.persist();return value;
 }
 async performUpload(entry){
  entry.status='uploading';entry.error='';this.onChange();
  try{
   if(entry.needsFile&&['init','content'].includes(entry.stage))throw Error('upload_recovery_file_required');
   if(!entry.sha)entry.sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await entry.file.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('');
   if(entry.stage==='init'&&!entry.initBody)entry.initBody={file_name:entry.file.name,media_type:(entry.fileIdentity?.type??entry.file.type)||'application/octet-stream',size_bytes:entry.file.size,sha256:entry.sha};
   if(entry.stage==='init'){
    const receipt=await this.api.request(`/conversations/${encodeURIComponent(this.conversationId)}/uploads`,'POST',entry.initBody,entry.keys.init);
    if(!receipt||typeof receipt.upload_id!=='string'||!receipt.upload_id||!Number.isInteger(receipt.max_bytes)||receipt.max_bytes<entry.file.size||!Number.isFinite(Date.parse(receipt.expires_at)))throw new Error('upload_receipt_invalid');
    entry.receipt=receipt;entry.stage='content';this.onChange();
   }
   if(entry.stage==='content'){
    if(entry.needsFile)throw Error('upload_recovery_file_required');
    const abort=new AbortController();entry.contentAbort=abort;
    try{await this.api.request(`/uploads/${encodeURIComponent(entry.receipt.upload_id)}/content`,'PUT',entry.file,entry.keys.content,abort.signal);if(entry.cancelRequested)return;entry.stage='complete';this.onChange();}
    finally{if(entry.contentAbort===abort)entry.contentAbort=null;}
   }
   if(entry.stage==='complete'){
    return await this.completeUpload(entry);
   }
  }catch(error){
   if(entry.status==='cancelled')return;
   if(entry.cancelRequested){entry.status='cancelling';entry.error='';return;}
   if(entry.stage==='cancel'){entry.status='uncertain';entry.error=error instanceof Error?error.message:'upload_cancel_unconfirmed';throw error;}
   entry.expired=error?.status===410&&error.message==='UPLOAD_EXPIRED';
   entry.status=error?.status>=400&&error.status<500&&error.status!==409&&error.status!==408?'rejected':'uncertain';entry.error=error instanceof Error?error.message:'upload_unconfirmed';throw error;
  }finally{this.onChange();}
 }

 async cancel(id){
  this.assertRecoveryScope();
  const entry=this.entries.find(value=>value.id===id);if(!entry)throw new Error('upload_not_found');
  if(entry.stage==='batch-cancel')return this.cancelBatch(entry.batch?.batchId||entry.batch?.key);
  if(entry.status==='selected'&&!entry.receipt){entry.status='cancelled';entry.stage='cancelled';await this.persist();this.onChange();return;}
  if(['ready','recovered'].includes(entry.status)){await this.remove(id);return;}
  if(!entry.receipt?.upload_id||!['content','cancel'].includes(entry.stage))throw new Error('upload_cancel_unavailable');
  if(entry.cancelRequested)throw new Error('upload_cancel_busy');
  const running=entry.running;entry.cancelPending=true;entry.cancelRequested=true;entry.status='cancelling';entry.error='';entry.contentAbort?.abort();this.onChange();
  try{
   await this.api.request(`/uploads/${encodeURIComponent(entry.receipt.upload_id)}`,'DELETE',{},entry.keys.cancel);
   await running?.catch(()=>{});
   entry.status='cancelled';entry.stage='cancelled';entry.error='';entry.cancelPending=false;await this.persist();
  }catch(error){
   await running?.catch(()=>{});
   entry.status='uncertain';entry.stage='cancel';entry.error=error instanceof Error?error.message:'upload_cancel_unconfirmed';throw error;
  }finally{entry.cancelRequested=false;entry.contentAbort=null;this.onChange();}
 }
 async cancelBatch(id){
  this.assertRecoveryScope();
  const group=this.entries.find(entry=>entry.batch&&(entry.batch.batchId===id||entry.batch.key===id))?.batch;if(!group)throw new Error('upload_batch_not_found');
  if(group.cancelRunning)return group.cancelRunning;
  const cancel=async()=>{
   if(!group.batchId){if(group.requestBody)await this.initializeBatch(group);else{for(const entry of group.entries){entry.status='cancelled';entry.stage='cancelled';}await this.persist();return;}}
   const pending=group.entries.filter(entry=>!['ready','recovered','cancelled'].includes(entry.status));if(!pending.length)return;
   for(const entry of pending){entry.cancelRequested=true;entry.status='cancelling';entry.error='';entry.contentAbort?.abort();}this.onChange();
   try{
    group.cancelPending=true;
    await this.api.request(`/upload-batches/${encodeURIComponent(group.batchId)}`,'DELETE',{},group.cancelKey);
    await Promise.all(pending.map(entry=>entry.running?.catch(()=>{})));
    for(const entry of pending){
     if(['ready','recovered'].includes(entry.status))continue;
     if(entry.stage==='complete'){
      try{await this.completeUpload(entry);}
      catch(error){if(error?.status===409){entry.status='cancelled';entry.stage='cancelled';entry.error='';continue;}throw error;}
     }else{entry.status='cancelled';entry.stage='cancelled';entry.error='';}
    }
    group.stage='cancelled';group.cancelPending=false;await this.persist();
   }catch(error){
    await Promise.all(pending.map(entry=>entry.running?.catch(()=>{})));
    for(const entry of pending){if(['ready','recovered','cancelled'].includes(entry.status))continue;entry.status='uncertain';if(entry.stage!=='complete')entry.stage='batch-cancel';entry.error=error instanceof Error?error.message:'upload_cancel_unconfirmed';}throw error;
   }finally{for(const entry of pending){entry.cancelRequested=false;entry.contentAbort=null;}this.onChange();}
  };
  const running=cancel().finally(()=>{if(group.cancelRunning===running)group.cancelRunning=null;});group.cancelRunning=running;return running;
 }
}
