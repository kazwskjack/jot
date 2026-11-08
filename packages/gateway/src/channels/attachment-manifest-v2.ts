import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {AttachmentResolver} from '../artifacts/resolver.ts';
import {validateAttachmentManifest} from '../artifacts/pinned-manifest.ts';
import {readVerifiedChannelBinding,requireVerifiedChannelThread} from './authority-proofs.ts';
type Row=Record<string,unknown>;
const row=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Row,keys:string)=>Object.keys(value).sort().join(',')===keys;
const opaque=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=512&&value===value.trim()&&!/[\u0000-\u001f\u007f]/u.test(value);
function fail(code='channel_attachment_manifest_invalid'):never{throw Error(code);}
/** New envelope only. This deliberately does not change the original v1 parser/proof. */
export function normalizeChannelAttachmentManifestV2(input:unknown){
 if(!row(input)||!exact(input,'attachments,binding_version,channel_binding_id,conversation_id,event,owner_id,protocol,text')||input.protocol!==2||!opaque(input.owner_id)||!opaque(input.channel_binding_id)||!opaque(input.conversation_id)||!Number.isSafeInteger(input.binding_version)||Number(input.binding_version)<1||typeof input.text!=='string'||input.text!==input.text.trim()||input.text.length>4000||!row(input.event))fail();
 const event=input.event;
 if(!exact(event,'channel,message_id,principal,thread_id')||typeof event.channel!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(event.channel)||!opaque(event.principal)||!opaque(event.message_id)||typeof event.thread_id!=='string'||event.thread_id!==''&&!opaque(event.thread_id))fail();
 if(!Array.isArray(input.attachments)||!input.attachments.length||input.attachments.length>10)fail();
 const providers=new Set<string>();
 const parts=input.attachments.map((value,index)=>{
  if(!row(value)||!exact(value,'artifact_id,file_name,index,kind,media_type,provider_file_id,sha256,size_bytes,version')||value.index!==index||value.version!==1||!opaque(value.provider_file_id)||providers.has(value.provider_file_id))fail();
  providers.add(value.provider_file_id);
  const pin=validateAttachmentManifest({protocol:1,attachments:[{artifact_id:value.artifact_id,version:value.version,sha256:value.sha256,size_bytes:value.size_bytes,media_type:value.media_type,file_name:value.file_name,kind:value.kind}]},{maxCount:1,maxAggregateBytes:100*1024*1024}).attachments[0]!;
  if(/[\\/\u0000-\u001f\u007f]/u.test(pin.file_name)||/[\u0000-\u001f\u007f]/u.test(pin.media_type))fail();
  return Object.freeze({index,provider_file_id:value.provider_file_id,...pin});
 });
 const pinned=validateAttachmentManifest({protocol:1,attachments:parts.map(({index,provider_file_id,...pin})=>pin)},{maxCount:10,maxAggregateBytes:200*1024*1024});
 return {source:Object.freeze({protocol:2 as const,owner_id:input.owner_id,channel_binding_id:input.channel_binding_id,binding_version:Number(input.binding_version),conversation_id:input.conversation_id,event:Object.freeze({channel:event.channel,principal:event.principal,thread_id:event.thread_id,message_id:event.message_id}),text:input.text,attachments:Object.freeze(parts)}),pinned};
}
export type ChannelAttachmentSourceV2=ReturnType<typeof normalizeChannelAttachmentManifestV2>['source'];
export function channelAttachmentManifestDigestV2(input:unknown):string{return createHash('sha256').update(canonicalJson(normalizeChannelAttachmentManifestV2(input).source)).digest('hex');}
/** Fresh message encoding only. Never projects pinned IDs into legacy attachments[]. */
export function encodeChannelAttachmentInputV2(messageId:string,input:unknown){
 if(!opaque(messageId))fail();
 const {source,pinned}=normalizeChannelAttachmentManifestV2(input);
 return Object.freeze({protocol:2 as const,kind:'channel_input' as const,
  blocks:Object.freeze([Object.freeze({block_id:`${messageId}:0`,kind:'text' as const,text:source.text})]),
  attachment_manifest:pinned,attachment_manifest_sha256:channelAttachmentManifestDigestV2(source)});
}
/** Executable reference/bytes verification layer only. No upload reservation, admission or receipt is fabricated. */
export async function verifyChannelAttachmentManifestV2(db:DatabaseSync,artifactRoot:string,input:unknown,signal?:AbortSignal){
 signal?.throwIfAborted();const {source,pinned}=normalizeChannelAttachmentManifestV2(input);
 const proveScope=()=>withImmediateTransaction(db,()=>{
  const binding=readVerifiedChannelBinding(db,source.event.channel,source.event.principal);
  requireVerifiedChannelThread(db,binding,source.event.thread_id);
  if(binding.owner_id!==source.owner_id||binding.channel_binding_id!==source.channel_binding_id||binding.version!==source.binding_version)fail('channel_attachment_authority_mismatch');
  const conversation=db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(source.conversation_id);
  if(conversation?.owner_id!==binding.owner_id)fail('channel_attachment_context_mismatch');
  const threaded=source.event.thread_id!=='';
  const mapping=threaded?db.prepare('SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_threads WHERE channel=? AND principal=? AND provider_thread_id=?').get(source.event.channel,source.event.principal,source.event.thread_id):db.prepare('SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_bindings WHERE channel=? AND principal=?').get(source.event.channel,source.event.principal);
  if(!mapping||mapping.conversation_id!==source.conversation_id||mapping.channel_binding_id!==binding.channel_binding_id||mapping.binding_version!==binding.version)fail('channel_attachment_context_not_ready');
  const cached=db.prepare('SELECT attachments_json FROM ga_channel_message_events WHERE channel=? AND principal=? AND provider_thread_id=? AND provider_message_id=?').get(source.event.channel,source.event.principal,source.event.thread_id,source.event.message_id);
  if(cached){if(cached.attachments_json==='[]')fail('channel_attachment_v1_event_conflict');fail('channel_attachment_admission_recovery_unavailable');}
 });
 proveScope();
 const resolver=new AttachmentResolver(db,artifactRoot),lease='channel-v2-verify-'+randomUUID();
 try{
  await resolver.resolvePinnedForMessage(source.owner_id,source.conversation_id,pinned,lease,signal);
  signal?.throwIfAborted();proveScope();
  return Object.freeze({protocol:2 as const,state:'verified_references' as const,admission_ready:false as const,execution_authorized:false as const,manifest_sha256:createHash('sha256').update(canonicalJson(source)).digest('hex'),source});
 }finally{resolver.releaseLease(lease);}
}
