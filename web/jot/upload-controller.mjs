// Same-tab upload recovery. Each stage retains its own body and idempotency key.
// An uncertain stage cannot be replaced with a new upload or attached as ready.
export class UploadController {
 constructor(conversationId,api,onChange=()=>{}){this.conversationId=conversationId;this.api=api;this.onChange=onChange;this.entries=[];}
 add(file,maxBytes){
  if(!Number.isInteger(maxBytes)||maxBytes<1)throw new Error('upload_limit_unavailable');
  if(!(file instanceof File)||!file.name||file.size<1||file.size>maxBytes)throw new Error('upload_size_invalid');
  const entry={id:crypto.randomUUID(),file,maxBytes,status:'selected',stage:'init',keys:{init:crypto.randomUUID(),content:crypto.randomUUID(),complete:crypto.randomUUID()},error:''};
  this.entries.push(entry);this.onChange();return entry;
 }
 remove(id){const entry=this.entries.find(value=>value.id===id);if(entry&&['uploading','uncertain'].includes(entry.status))throw new Error('upload_unconfirmed');this.entries=this.entries.filter(value=>value.id!==id);this.onChange();}
 get unresolved(){return this.entries.some(entry=>['uploading','uncertain'].includes(entry.status));}
 references(){if(this.entries.some(entry=>entry.status!=='ready'))throw new Error('upload_not_ready');return this.entries.map(entry=>entry.artifact.artifact_id);}
 clearSent(){this.references();this.entries=[];this.onChange();}
 async upload(id){
  const entry=this.entries.find(value=>value.id===id);if(!entry)throw new Error('upload_not_found');
  if(entry.status==='uploading')throw new Error('upload_busy');if(entry.status==='ready')return entry.artifact;
  entry.status='uploading';entry.error='';this.onChange();
  try{
   if(!entry.sha){entry.sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await entry.file.arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('');entry.initBody={file_name:entry.file.name,media_type:entry.file.type||'application/octet-stream',size_bytes:entry.file.size,sha256:entry.sha};}
   if(entry.stage==='init'){
    const receipt=await this.api.request(`/conversations/${encodeURIComponent(this.conversationId)}/uploads`,'POST',entry.initBody,entry.keys.init);
    if(!receipt||typeof receipt.upload_id!=='string'||!receipt.upload_id||!Number.isInteger(receipt.max_bytes)||receipt.max_bytes<entry.file.size||!Number.isFinite(Date.parse(receipt.expires_at)))throw new Error('upload_receipt_invalid');
    entry.receipt=receipt;entry.stage='content';
   }
   if(entry.stage==='content'){await this.api.request(`/uploads/${encodeURIComponent(entry.receipt.upload_id)}/content`,'PUT',entry.file,entry.keys.content);entry.stage='complete';}
   if(entry.stage==='complete'){
    const value=await this.api.request(`/uploads/${encodeURIComponent(entry.receipt.upload_id)}/complete`,'POST',{sha256:entry.sha},entry.keys.complete);
    if(!value||typeof value.artifact_id!=='string'||!value.artifact_id||value.conversation_id!==this.conversationId||value.sha256!==entry.sha||value.size_bytes!==entry.file.size||value.version!==1||value.status!=='ready'||value.origin!=='upload')throw new Error('upload_receipt_invalid');
    entry.artifact=value;entry.stage='done';entry.status='ready';return value;
   }
  }catch(error){
   entry.status=error?.status>=400&&error.status<500&&error.status!==409&&error.status!==408?'rejected':'uncertain';entry.error=error instanceof Error?error.message:'upload_unconfirmed';throw error;
  }finally{this.onChange();}
 }
}
