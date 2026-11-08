import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {readVerifiedChannelBinding,requireVerifiedChannelThread} from './authority-proofs.ts';
import {normalizeChannelAttachmentManifestV2,channelAttachmentManifestDigestV2,encodeChannelAttachmentInputV2} from './attachment-manifest-v2.ts';
/** Re-prove the accepted original event/message/run before initial native input.
 * Legacy content returns undefined; an unknown explicit protocol fails closed. */
export function readAcceptedChannelAttachmentInputV2(db:DatabaseSync,runId:string){
 return withImmediateTransaction(db,()=>{
  const row=db.prepare(`SELECT m.id,m.content_json,c.id AS conversation_id,c.owner_id FROM ga_runs r
   JOIN ga_messages m ON m.id=r.input_message_id AND m.run_id=r.id AND m.conversation_id=r.conversation_id AND m.role='user' AND m.status='complete'
   JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?`).get(runId);
  if(!row)throw Error('channel_attachment_input_unproven');
  const content:unknown=JSON.parse(String(row.content_json));
  if(!content||typeof content!=='object'||Array.isArray(content)||!('protocol' in content)&&!('kind' in content))return undefined;
  if(!('protocol' in content)||content.protocol!==2||!('kind' in content)||content.kind!=='channel_input')throw Error('channel_attachment_input_protocol_invalid');
  const events=db.prepare('SELECT * FROM ga_channel_message_events WHERE run_id=? AND message_id=? AND conversation_id=?').all(runId,row.id!,row.conversation_id!);
  if(events.length!==1)throw Error('channel_attachment_input_unproven');
  const event=events[0]!,envelope=JSON.parse(String(event.attachments_json)),{source,pinned}=normalizeChannelAttachmentManifestV2(envelope?.source),hash=channelAttachmentManifestDigestV2(source);
  if(event.content_protocol!==2||event.attachments_json!==canonicalJson({protocol:2,manifest_sha256:hash,source})||event.event_sha256!==hash||typeof row.id!=='string'
   ||source.owner_id!==row.owner_id||source.conversation_id!==row.conversation_id||source.event.channel!==event.channel||source.event.principal!==event.principal||source.event.thread_id!==event.provider_thread_id||source.event.message_id!==event.provider_message_id
   ||canonicalJson(content)!==canonicalJson(encodeChannelAttachmentInputV2(row.id,source)))throw Error('channel_attachment_input_unproven');
  const binding=readVerifiedChannelBinding(db,source.event.channel,source.event.principal);
  requireVerifiedChannelThread(db,binding,source.event.thread_id);
  if(binding.owner_id!==source.owner_id||binding.channel_binding_id!==source.channel_binding_id||binding.version!==source.binding_version||event.channel_binding_id!==source.channel_binding_id||Number(event.binding_version)!==source.binding_version)throw Error('channel_attachment_authority_mismatch');
  const mapping=source.event.thread_id?db.prepare('SELECT * FROM ga_channel_threads WHERE channel=? AND principal=? AND provider_thread_id=?').get(source.event.channel,source.event.principal,source.event.thread_id):db.prepare('SELECT * FROM ga_channel_bindings WHERE channel=? AND principal=?').get(source.event.channel,source.event.principal);
  if(!mapping||mapping.conversation_id!==source.conversation_id||mapping.channel_binding_id!==source.channel_binding_id||Number(mapping.binding_version)!==source.binding_version)throw Error('channel_attachment_context_mismatch');
  return Object.freeze({source,pinned,manifest_sha256:hash});
 });
}
