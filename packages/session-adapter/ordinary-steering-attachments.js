import {createHash} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
import {verifyNativeInputAttachments} from './native-input-attachments.js';
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_k,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
const fail=()=>{throw Error('ordinary_steering_attachment_unconfirmed');};
const kind=mime=>mime.startsWith('image/')&&mime!=='image/svg+xml'?'image':mime.startsWith('text/')||['application/json','application/xml'].includes(mime)?'text':mime==='application/pdf'||/officedocument|msword|excel|powerpoint/.test(mime)?'document':'file';

/** Product source metadata only, never an execution grant or normalized digest. */
export function validateOrdinarySteeringAttachmentSource(source){
 const manifest=source?.attachment_manifest;
 if(source?.protocol!==2||source.kind!=='ordinary_steer_attachments'||source.execution_authorized!==false||!digest(source.attachment_manifest_sha256)||!digest(source.text_sha256)||!manifest||typeof manifest!=='object'||Array.isArray(manifest)||Object.keys(manifest).sort().join(',')!=='attachments,protocol'||manifest.protocol!==1||!Array.isArray(manifest.attachments)||!manifest.attachments.length||manifest.attachments.length>10)fail();
 let total=0;const seen=new Set();for(const row of manifest.attachments){if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).sort().join(',')!=='artifact_id,file_name,kind,media_type,sha256,size_bytes,version'||!id(row.artifact_id)||seen.has(row.artifact_id)||!Number.isSafeInteger(row.version)||row.version<1||!digest(row.sha256)||!Number.isSafeInteger(row.size_bytes)||row.size_bytes<0||typeof row.media_type!=='string'||!row.media_type||row.media_type.length>200||typeof row.file_name!=='string'||!row.file_name||row.file_name.length>255||row.kind!==kind(row.media_type))fail();seen.add(row.artifact_id);total+=row.size_bytes;if(!Number.isSafeInteger(total)||total>200*1024*1024)fail();}
 if(hash(canonical(manifest))!==source.attachment_manifest_sha256)fail();return freeze(structuredClone(manifest));
}

/** Prepare only: use original official services to derive expected content.
 * The caller must bind/verify the actual native message under a new admission
 * version before entry. This helper never prompts, steers, leases or admits. */
export async function prepareOrdinarySteeringAttachments({ctx,agent,authority,content,signal,assertActive=()=>{}}){
 const check=()=>{signal?.throwIfAborted();assertActive();if(!agent||agent.id!==authority?.session_id||agent.session?.id!==authority.session_id)fail();};check();
 const{manifest,parts,position}=validateOrdinarySteeringAttachmentWire(authority,content);
 if(manifest.attachments.some(pin=>pin.kind==='image')){
  const selections=ctx?.sessionController?.agents;
  if(typeof selections?.selectionFor!=='function'||typeof ctx?.llm?.resolveModelInfo!=='function')fail();const current=selections.selectionFor(agent)?.current;if(!current)fail();const model=await ctx.llm.resolveModelInfo(current.provider,current.model);check();if(!model||model.inputModalities!==undefined&&(!Array.isArray(model.inputModalities)||!model.inputModalities.includes('image')))fail();
 }
 const admitted=position?[parts[0]]:[],files=new Map();for(let index=0;index<manifest.attachments.length;index++){
  check();const pin=manifest.attachments[index],part=parts[index+position];if(pin.kind==='image'){admitted.push(part);continue;}
  if(typeof ctx?.fileUploads?.resolve!=='function')fail();const ref=ctx.fileUploads.resolve(agent,part.receiptId);check();if(!ref||Object.keys(ref).sort().join(',')!=='attachmentId,bytes,name'||ref.attachmentId!=='sha256:'+pin.sha256||ref.bytes!==pin.size_bytes||typeof ref.name!=='string'||!ref.name||ref.name.length>255)fail();const saved=freeze(structuredClone(ref));files.set(index+position,saved);admitted.push({type:'file',attachment:saved});
 }
 const attachments=typeof ctx?.get==='function'?ctx.get('attachments'):ctx?.attachments;
 if(typeof attachments?.admitPromptContent!=='function')fail();const normalized=await attachments.admitPromptContent(freeze(admitted));check();if(!Array.isArray(normalized)||normalized.length!==parts.length)fail();
 for(let index=0;index<normalized.length;index++){
  const part=normalized[index];if(!part||typeof part!=='object')fail();if(index<position){if(!isDeepStrictEqual(part,parts[index]))fail();continue;}
  const pin=manifest.attachments[index-position];if(Object.keys(part).sort().join(',')!=='attachment,type'||part.type!==(pin.kind==='image'?'image':'file'))fail();if(pin.kind!=='image'){if(!isDeepStrictEqual(part.attachment,files.get(index)))fail();}else{const ref=part.attachment;if(!ref||!['image/png','image/jpeg','image/webp','image/gif'].includes(ref.mediaType)||!Number.isSafeInteger(ref.width)||ref.width<1||!Number.isSafeInteger(ref.height)||ref.height<1)fail();}
 }
 await verifyNativeInputAttachments([{content:normalized}],{attachments,signal});check();
 const saved=freeze(structuredClone(normalized));return freeze({protocol:1,attachment_manifest_sha256:authority.attachment_manifest_sha256,native_content_sha256:hash(JSON.stringify(saved)),content:saved});
}

export function validateOrdinarySteeringAttachmentWire(authority,content){
 const manifest=validateOrdinarySteeringAttachmentSource(authority);if(!Array.isArray(content)||content.length>11)fail();const parts=structuredClone(content);let position=0;
 if(parts[0]?.type==='text'){if(Object.keys(parts[0]).sort().join(',')!=='text,type'||typeof parts[0].text!=='string'||!parts[0].text.trim()||parts[0].text!==parts[0].text.trim()||parts[0].text.length>100000)fail();position=1;}
 if(parts.length-position!==manifest.attachments.length||hash(position?parts[0].text:'')!==authority.text_sha256)fail();
 // Byte/name/media checks precede official image admission and storage work.
 for(let index=0;index<manifest.attachments.length;index++){
  const pin=manifest.attachments[index],part=parts[index+position];if(!part||typeof part!=='object')fail();
  if(pin.kind==='image'){
   if(Object.keys(part).sort().join(',')!=='data,mediaType,name,type'||part.type!=='image'||part.mediaType!==pin.media_type||part.name!==pin.file_name||typeof part.data!=='string'||part.data.length>28*1024*1024||pin.size_bytes>20*1024*1024)fail();
   const bytes=Buffer.from(part.data,'base64');if(bytes.toString('base64')!==part.data||bytes.length!==pin.size_bytes||hash(bytes)!==pin.sha256)fail();
  }else if(Object.keys(part).sort().join(',')!=='receiptId,type'||part.type!=='file'||!id(part.receiptId))fail();
 }
 return freeze({manifest,parts,position});
}

/** Metadata preflight only. Original immutable admission and stored-byte checks
 * remain mandatory before recovery enters the original Agent. */
export function validateNormalizedOrdinarySteeringAttachments(authority,content){
 const manifest=validateOrdinarySteeringAttachmentSource(authority);if(!Array.isArray(content))fail();let position=0;
 if(content[0]?.type==='text'){if(Object.keys(content[0]).sort().join(',')!=='text,type'||typeof content[0].text!=='string'||!content[0].text.trim()||content[0].text!==content[0].text.trim())fail();position=1;}
 if(content.length-position!==manifest.attachments.length||hash(position?content[0].text:'')!==authority.text_sha256)fail();
 for(const [index,pin] of manifest.attachments.entries()){const part=content[index+position],ref=part?.attachment;if(!part||Object.keys(part).sort().join(',')!=='attachment,type'||part.type!==(pin.kind==='image'?'image':'file')||!ref||!/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId??'')||!Number.isSafeInteger(ref.bytes)||ref.bytes<0||typeof ref.name!=='string'||!ref.name||ref.name.length>255)fail();
  if(pin.kind==='image'){if(Object.keys(ref).sort().join(',')!=='attachmentId,bytes,height,mediaType,name,width'||!['image/png','image/jpeg','image/webp','image/gif'].includes(ref.mediaType)||!Number.isSafeInteger(ref.width)||ref.width<1||!Number.isSafeInteger(ref.height)||ref.height<1)fail();}
  else if(Object.keys(ref).sort().join(',')!=='attachmentId,bytes,name'||ref.attachmentId!=='sha256:'+pin.sha256||ref.bytes!==pin.size_bytes)fail();
 }
}
