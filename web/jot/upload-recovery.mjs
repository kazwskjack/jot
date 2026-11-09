const exact=(value,required,optional=[])=>!!value&&typeof value==='object'&&!Array.isArray(value)
 &&required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>required.includes(key)||optional.includes(key));
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const key=value=>typeof value==='string'&&/^[!-~]{8,128}$/.test(value);
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=value=>Number.isSafeInteger(value)&&value>0;
const equal=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const invalid=()=>Error('upload_recovery_invalid');

const relative=value=>typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\\:\u0000-\u001f\u007f]/.test(value)&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');
function validateGenerated(entry,conversation,scope){
 const value=entry.generated;
 if(!exact(value,['schema','scope','capture','blob','delivery'])||value.schema!==1||!['draft','sending'].includes(value.delivery)||value.delivery==='sending'&&!entry.artifact||!sha(value.scope)||scope!==undefined&&value.scope!==scope
  ||typeof Blob!=='function'||!(value.blob instanceof Blob)||value.blob.type!=='image/png'||value.blob.size!==entry.file.size)throw invalid();
 const capture=value.capture;
 if(!exact(capture,['owner','conversationId','runId','activityId','resultSha','file','reference','imageBytes','rotation'])
  ||capture.owner!==value.scope||capture.conversationId!==conversation||!identifier(capture.runId)||!identifier(capture.activityId)||!sha(capture.resultSha)
  ||!positive(capture.imageBytes)||capture.imageBytes!==entry.file.size||![0,90,180,270].includes(capture.rotation))throw invalid();
 const source=capture.file,ref=capture.reference;
 if(!exact(source,['path','version','sha256','size'])||!relative(source.path)||!Number.isSafeInteger(source.version)||source.version<0||!sha(source.sha256)||!Number.isSafeInteger(source.size)||source.size<0
  ||!exact(ref,['schemaVersion','kind','id','selectionMode','source','renderer','locator','image','createdAt'],['nearbyText'])
  ||ref.schemaVersion!==1||ref.kind!=='content-reference'||ref.selectionMode!=='region'||!identifier(ref.id)||typeof ref.createdAt!=='string'||!Number.isFinite(Date.parse(ref.createdAt))
  ||ref.nearbyText!==undefined&&(typeof ref.nearbyText!=='string'||ref.nearbyText.length>100000))throw invalid();
 const file=ref.source,renderer=ref.renderer,locator=ref.locator,image=ref.image;
 if(!exact(file,['relativePath','fileName','mimeType','revision'])||file.relativePath!==source.path||file.fileName!==source.path.split('/').at(-1)||file.mimeType!=='application/pdf'
  ||!exact(file.revision,['id','size','sha256'])||file.revision.id!==String(source.version)||file.revision.size!==source.size||file.revision.sha256!==source.sha256
  ||!exact(renderer,['id','backend','locatorQuality'])||renderer.id!=='pdf'||renderer.backend!=='builtin'||renderer.locatorQuality!=='visual'
  ||!exact(locator,['surface','pageNumber','rect'])||locator.surface!=='page'||!positive(locator.pageNumber)
  ||!exact(locator.rect,['x','y','width','height'])||Object.values(locator.rect).some(number=>typeof number!=='number'||!Number.isFinite(number)||number<0||number>1)
  ||!locator.rect.width||!locator.rect.height||locator.rect.x+locator.rect.width>1+1e-9||locator.rect.y+locator.rect.height>1+1e-9
  ||!exact(image,['name','mimeType','width','height','sha256'])||image.name!==entry.file.name||image.mimeType!=='image/png'||!positive(image.width)||!positive(image.height)||!sha(image.sha256)
  ||entry.sha!==undefined&&entry.sha!==image.sha256||entry.file.type!=='image/png')throw invalid();
 return value;
}

export function generatedUpload(file,capture,scope,conversation){
 if(!capture?.reference?.image)throw invalid();
 const {dataUrl,...image}=capture.reference.image;
 const payload=JSON.stringify({...capture,reference:{...capture.reference,image}});
 if(payload.length>131072)throw invalid();
 const generated={schema:1,scope,capture:JSON.parse(payload),blob:file,delivery:'draft'};
 validateGenerated({file:{name:file.name,size:file.size,type:file.type},generated},conversation,scope);return generated;
}

export async function generatedUploadFile(entry,scope,conversation){
 const generated=validateGenerated(entry,conversation,scope),image=generated.capture.reference.image;
 const bytes=await generated.blob.arrayBuffer();
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
 const header=new Uint8Array(bytes,0,Math.min(24,bytes.byteLength));
 if(digest!==image.sha256||entry.sha!==undefined&&digest!==entry.sha||header.length<24
  ||![137,80,78,71,13,10,26,10].every((value,index)=>header[index]===value)
  ||String.fromCharCode(...header.subarray(12,16))!=='IHDR')throw Error('generated_capture_integrity_failed');
 const dimensions=new DataView(bytes);
 if(dimensions.getUint32(16)!==image.width||dimensions.getUint32(20)!==image.height)throw Error('generated_capture_integrity_failed');
 return {file:new File([generated.blob],entry.file.name,{type:entry.file.type,lastModified:0}),sha:digest};
}

export function uploadRecoverySnapshot(entries){
 const groups=[...new Set(entries.map(entry=>entry.batch).filter(Boolean))];
 const all=[...new Set([...entries,...groups.flatMap(group=>group.entries)])];
 const generated=new Map(all.filter(entry=>entry.generated!==undefined).map(entry=>[entry.id,entry.generated]));
 const snapshot=JSON.parse(JSON.stringify({
  active_ids:entries.map(entry=>entry.id),
  entries:all.map(entry=>({id:entry.id,clientFileId:entry.clientFileId,
   file:entry.fileIdentity??{name:entry.file.name,size:entry.file.size,type:entry.file.type},relativePath:entry.relativePath,maxBytes:entry.maxBytes,
   keys:entry.keys,sha:entry.sha,initBody:entry.initBody,receipt:entry.receipt,artifact:entry.artifact,
   status:entry.status,stage:entry.stage,batchKey:entry.batch?.key,cancelPending:entry.cancelPending===true,expired:entry.expired===true,cancelObserved:entry.cancelObserved===true})),
  groups:groups.map(group=>({key:group.key,cancelKey:group.cancelKey,entryIds:group.entries.map(entry=>entry.id),
   stage:group.stage,batchId:group.batchId,requestBody:group.requestBody,expiresAt:group.expiresAt,cancelPending:group.cancelPending===true,cancelObserved:group.cancelObserved===true})),
 }));
 for(const entry of snapshot.entries){if(generated.has(entry.id)){const original=generated.get(entry.id);entry.generated={...original,capture:structuredClone(original.capture),blob:original.blob};}}
 return snapshot;
}

export function validateUploadRecovery(snapshot,conversation,scope){
 if(!exact(snapshot,['active_ids','entries','groups'])||!Array.isArray(snapshot.active_ids)||!Array.isArray(snapshot.entries)||!Array.isArray(snapshot.groups))throw invalid();
 const entries=new Map(),groups=new Map();
 for(const entry of snapshot.entries){
  if(!exact(entry,['id','clientFileId','file','relativePath','maxBytes','keys','status','stage','cancelPending','expired'],['sha','initBody','receipt','artifact','batchKey','cancelObserved','generated'])
   ||!identifier(entry.id)||entries.has(entry.id)||!identifier(entry.clientFileId)||!positive(entry.maxBytes)
   ||!exact(entry.file,['name','size','type'])||typeof entry.file.name!=='string'||!entry.file.name||entry.file.name.length>255
   ||/[\\/\u0000-\u001f\u007f]/.test(entry.file.name)||!positive(entry.file.size)||entry.file.size>entry.maxBytes
   ||typeof entry.file.type!=='string'||entry.file.type.length>255||/[\u0000-\u001f\u007f]/.test(entry.file.type)
   ||typeof entry.relativePath!=='string'||!entry.relativePath||entry.relativePath.length>1024
   ||entry.relativePath.split('/').some(part=>!part||part==='.'||part==='..'||/[\\\u0000-\u001f\u007f]/.test(part))
   ||entry.relativePath.split('/').at(-1)!==entry.file.name||/^[A-Za-z]:/.test(entry.relativePath)
   ||!exact(entry.keys,['init','content','complete','cancel'])||!Object.values(entry.keys).every(key)
   ||!['selected','uploading','cancelling','uncertain','rejected','ready','recovered','cancelled'].includes(entry.status)
   ||!['init','batch-init','content','complete','done','cancel','batch-cancel','cancelled'].includes(entry.stage)
   ||entry.cancelObserved!==undefined&&typeof entry.cancelObserved!=='boolean'||typeof entry.cancelPending!=='boolean'||typeof entry.expired!=='boolean'||entry.sha!==undefined&&!sha(entry.sha))throw invalid();
  if(entry.generated!==undefined)validateGenerated(entry,conversation,scope);
  if(!['init','batch-init','cancelled'].includes(entry.stage)&&!sha(entry.sha))throw invalid();
  if(entry.initBody!==undefined&&(!sha(entry.sha)||!exact(entry.initBody,['file_name','media_type','size_bytes','sha256'])||!equal(entry.initBody,{file_name:entry.file.name,media_type:entry.file.type||'application/octet-stream',size_bytes:entry.file.size,sha256:entry.sha})))throw invalid();
  if(entry.receipt!==undefined&&(!exact(entry.receipt,['upload_id','max_bytes','expires_at'],['batch_id'])
   ||!identifier(entry.receipt.upload_id)||!positive(entry.receipt.max_bytes)||entry.receipt.max_bytes<entry.file.size
   ||typeof entry.receipt.expires_at!=='string'||!Number.isFinite(Date.parse(entry.receipt.expires_at))
   ||entry.receipt.batch_id!==undefined&&!identifier(entry.receipt.batch_id)))throw invalid();
  if(!['init','batch-init','cancelled'].includes(entry.stage)&&!entry.receipt)throw invalid();
  if(entry.artifact!==undefined){
   const file=entry.artifact;
   if(!file||!identifier(file.artifact_id)||file.conversation_id!==conversation||file.sha256!==entry.sha
    ||file.size_bytes!==entry.file.size||file.version!==1||file.status!=='ready'||file.origin!=='upload')throw invalid();
  }
  if(['ready','recovered'].includes(entry.status)&&(!entry.artifact||entry.stage!=='done'))throw invalid();
  entries.set(entry.id,entry);
 }
 for(const group of snapshot.groups){
  if(!exact(group,['key','cancelKey','entryIds','stage','batchId','requestBody','cancelPending'],['expiresAt','cancelObserved'])
   ||!key(group.key)||groups.has(group.key)||!key(group.cancelKey)||!Array.isArray(group.entryIds)||group.entryIds.length<1||group.entryIds.length>500
   ||new Set(group.entryIds).size!==group.entryIds.length||group.entryIds.some(id=>!entries.has(id)||entries.get(id).batchKey!==group.key)
   ||!['batch-init','content','cancelled'].includes(group.stage)||typeof group.cancelPending!=='boolean'
   ||group.cancelObserved!==undefined&&typeof group.cancelObserved!=='boolean'
   ||group.batchId!==null&&!identifier(group.batchId)||group.expiresAt!==undefined&&(typeof group.expiresAt!=='string'||!Number.isFinite(Date.parse(group.expiresAt))))throw invalid();
  const members=group.entryIds.map(id=>entries.get(id));
  if(members.reduce((total,entry)=>total+entry.file.size,0)>2*1024*1024*1024
   ||new Set(members.map(entry=>entry.clientFileId)).size!==members.length
   ||new Set(members.map(entry=>entry.relativePath)).size!==members.length)throw invalid();
  if(group.requestBody!==null){
   const expected={files:group.entryIds.map(id=>{const entry=entries.get(id);return {client_file_id:entry.clientFileId,file_name:entry.file.name,
    relative_path:entry.relativePath,media_type:entry.file.type||'application/octet-stream',size_bytes:entry.file.size,sha256:entry.sha};})};
   if(!group.entryIds.every(id=>sha(entries.get(id).sha))||!equal(group.requestBody,expected))throw invalid();
  }
  if(group.batchId!==null&&(!group.requestBody||!group.expiresAt))throw invalid();
  for(const id of group.entryIds){const entry=entries.get(id);if(entry.receipt&&(entry.receipt.batch_id!==group.batchId||entry.receipt.expires_at!==group.expiresAt))throw invalid();}
  groups.set(group.key,group);
 }
 for(const entry of entries.values())if(entry.batchKey!==undefined&&(!groups.has(entry.batchKey)||!groups.get(entry.batchKey).entryIds.includes(entry.id)))throw invalid();
 const active=new Set(snapshot.active_ids);
 if(active.size!==snapshot.active_ids.length||snapshot.active_ids.some(id=>!entries.has(id)))throw invalid();
 const retained=new Set([...active,...snapshot.groups.flatMap(group=>group.entryIds)]);
 if(entries.size!==retained.size||snapshot.groups.some(group=>!group.entryIds.some(id=>active.has(id))))throw invalid();
 return snapshot;
}

export function restoreUploadRecovery(snapshot,conversation,scope){
 validateUploadRecovery(snapshot,conversation,scope);
 const entries=new Map(snapshot.entries.map(value=>{
  const entry={...structuredClone(value),fileIdentity:structuredClone(value.file),needsFile:true,restored:true,error:'',...(value.generated!==undefined?{generatedCommitted:true}:{})};
  if(entry.status==='ready'||entry.status==='recovered'){entry.stage='complete';entry.status='uncertain';}
  if(entry.status==='uploading'||entry.status==='cancelling')entry.status='uncertain';
  if(entry.cancelPending){entry.stage='cancel';entry.status='uncertain';}
  return [entry.id,entry];
 }));
 for(const value of snapshot.groups){
  const group={...structuredClone(value),entries:value.entryIds.map(id=>entries.get(id)),running:null};
  for(const entry of group.entries){entry.batch=group;entry.batchId=group.batchId;
   if(group.cancelPending&&!['cancelled','ready','recovered'].includes(entry.status)){entry.stage=entry.stage==='complete'?'complete':'batch-cancel';entry.status='uncertain';}
  }
 }
 return snapshot.active_ids.map(id=>entries.get(id));
}

export class UploadRecoveryStore {
 static async open(factory,scope,conversation){
  if(!factory||!/^[a-f0-9]{64}$/.test(scope)||!identifier(conversation))throw Error('upload_recovery_unavailable');
  const store=new UploadRecoveryStore();store.scope=scope;store.conversation=conversation;store.key=`${scope}/${conversation}`;store.revision=0;
  store.db=await new Promise((resolve,reject)=>{
   let abandoned=false;const request=factory.open('jot-upload-recovery-v1',1);
   request.onupgradeneeded=()=>request.result.createObjectStore('snapshots');
   request.onsuccess=()=>{if(abandoned)request.result.close();else resolve(request.result);};
   request.onerror=request.onblocked=()=>{abandoned=true;reject(Error('upload_recovery_unavailable'));};
  });
  store.db.onversionchange=()=>store.close();return store;
 }
 close(){this.db.close();}
 transaction(mode,operation){
  return new Promise((resolve,reject)=>{
   let tx,result,failure;
   try{tx=this.db.transaction('snapshots',mode,mode==='readwrite'?{durability:'strict'}:{});
    if(mode==='readwrite'&&tx.durability!=='strict'){tx.abort();reject(Error('upload_recovery_unavailable'));return;}}
   catch{reject(Error('upload_recovery_unavailable'));return;}
   const fail=error=>{failure=error;try{tx.abort();}catch{}};
   tx.oncomplete=()=>resolve(result);tx.onerror=()=>{};tx.onabort=()=>reject(failure??Error('upload_recovery_unavailable'));
   try{operation(tx.objectStore('snapshots'),value=>result=value,fail);}catch(error){fail(error);}
  });
 }
 record(value){
  if(!exact(value,['schema','scope','conversation','revision','snapshot'])||value.schema!==1||value.scope!==this.scope||value.conversation!==this.conversation||!positive(value.revision))throw invalid();
  validateUploadRecovery(value.snapshot,this.conversation,this.scope);return value;
 }
 async load(){
  const record=await this.transaction('readonly',(records,done,fail)=>{const read=records.get(this.key);read.onsuccess=()=>{try{done(read.result===undefined?null:this.record(read.result));}catch(error){fail(error);}};});
  this.revision=record?.revision??0;return record?.snapshot??null;
 }
 async save(snapshot){
  validateUploadRecovery(snapshot,this.conversation,this.scope);const expected=this.revision;
  const revision=await this.transaction('readwrite',(records,done,fail)=>{const read=records.get(this.key);read.onsuccess=()=>{try{
   const prior=read.result===undefined?0:this.record(read.result).revision;
   if(prior!==expected||prior>=Number.MAX_SAFE_INTEGER)throw Error('upload_recovery_conflict');
   const next=prior+1;records.put({schema:1,scope:this.scope,conversation:this.conversation,revision:next,snapshot},this.key);done(next);
  }catch(error){fail(error);}};});
  this.revision=revision;
 }
}
