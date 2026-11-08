import {requireStableMattermostAttachmentSource} from './mattermost-attachment-control.ts';
import {requireMattermostConfiguredAccount} from './mattermost-thread-scope.ts';
import {requireMattermostOriginalPost} from './mattermost-text-control.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { RunRepository } from '../runs/repository.ts';
import { withImmediateTransaction } from '../db/database.ts';
import { OwnerChannelBindings } from './owner-bindings.ts';
import { proveCachedChannelEvent, readVerifiedChannelBinding, requireVerifiedChannelThread } from './authority-proofs.ts';

import type {ArtifactService} from '../artifacts/service.ts';
import {inspectPinnedAttachmentManifest} from '../artifacts/pinned-manifest.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {normalizeChannelAttachmentManifestV2,channelAttachmentManifestDigestV2,encodeChannelAttachmentInputV2,type ChannelAttachmentSourceV2} from './attachment-manifest-v2.ts';
import type {DurableChannelAttachmentProducerV2} from '../../contracts/channel-intake-v2.proposed.ts';
import {normalizeChannelStageRequestV2,channelUploadStageKeyV2,channelStageRequestDigestV2} from './attachment-stage-v2.ts';
import {enableChannelAttachmentProtocolV2} from './attachment-protocol-migration-v2.ts';

const CHANNEL = /^[a-z][a-z0-9_-]{0,63}$/;
const OPAQUE_PROVIDER_ID = /^[^\u0000-\u001f\u007f]{1,512}$/u;

type VerifiedBinding = ReturnType<typeof readVerifiedChannelBinding>;
type ChannelMessage = { channel: string; principal: string; threadId: string; messageId: string; text: string; attachments: [] };

function channelMessage(input: unknown): ChannelMessage {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('channel_message_invalid');
  const raw = input as Record<string, unknown>;
  const channel = typeof raw.channel === 'string' ? raw.channel.trim().toLowerCase() : '';
  const principal = typeof raw.principal === 'string' ? raw.principal : '';
  const messageId = typeof raw.message_id === 'string' ? raw.message_id : '';
  const threadId = raw.thread_id === undefined ? '' : typeof raw.thread_id === 'string' ? raw.thread_id : null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const attachments = raw.attachments;
  if (!CHANNEL.test(channel) || !OPAQUE_PROVIDER_ID.test(principal) || principal !== principal.trim()
    || !OPAQUE_PROVIDER_ID.test(messageId) || messageId !== messageId.trim()
    || threadId === null || (threadId !== '' && (!OPAQUE_PROVIDER_ID.test(threadId) || threadId !== threadId.trim()))
    || !text || text.length > 4000) {
    throw new Error('channel_message_invalid');
  }
  if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 10)) {
    throw new Error('channel_attachments_invalid');
  }
  if (Array.isArray(attachments) && attachments.length) throw new Error('channel_attachment_staging_missing');
  return { channel, principal, threadId, messageId, text, attachments: [] };
}

export class ChannelIntakeService implements DurableChannelAttachmentProducerV2 {
  private readonly db: DatabaseSync;
  private readonly runs: RunRepository;
  private readonly workspaceId: string;
  private readonly bindings: OwnerChannelBindings;

  constructor(db: DatabaseSync, runs: RunRepository, workspaceId: string, bindings?: OwnerChannelBindings) {
    this.db = db;
    this.runs = runs;
    this.workspaceId = workspaceId;
    this.bindings = bindings ?? new OwnerChannelBindings(db);
  }

  usesDatabase(db: DatabaseSync): boolean {
    return this.db === db && this.runs.usesDatabase(db) && this.bindings.usesDatabase(db);
  }

  async acceptSlackAttachmentsV2(input:Record<string,unknown>,options:{providerSignatureVerified:true},
    materialize:(scope:{ownerId:string})=>Promise<ReadonlyArray<{provider_file_id:string;file_name:string;media_type:string;size_bytes:number;sha256:string;bytes:Buffer}>>,
    artifacts:ArtifactService){
    if(options?.providerSignatureVerified!==true)throw Error('channel_signature_invalid');
    const channel=typeof input.channel==='string'?input.channel.trim().toLowerCase():'';
    const principal=typeof input.principal==='string'?input.principal:'';
    const threadId=typeof input.thread_id==='string'?input.thread_id:'';
    const messageId=typeof input.message_id==='string'?input.message_id:'';
    const text=typeof input.text==='string'?input.text.trim():'';
    const declared=input.attachments;
    if(channel!=='slack'||!OPAQUE_PROVIDER_ID.test(principal)||principal!==principal.trim()
      ||!OPAQUE_PROVIDER_ID.test(threadId)||threadId!==threadId.trim()
      ||!OPAQUE_PROVIDER_ID.test(messageId)||messageId!==messageId.trim()||text.length>4000
      ||!Array.isArray(declared)||!declared.length||declared.length>10)throw Error('channel_attachment_stage_invalid');
    const binding=withImmediateTransaction(this.db,()=>{
      const verified=readVerifiedChannelBinding(this.db,channel,principal);
      requireVerifiedChannelThread(this.db,verified,threadId);
      return verified;
    });
    const files=await materialize({ownerId:binding.owner_id});
    if(!Array.isArray(files)||files.length!==declared.length)throw Error('slack_file_metadata_invalid');
    const attachments=files.map((file,index)=>{
      const metadata=declared[index] as Record<string,unknown>;
      if(!file||!Buffer.isBuffer(file.bytes)||file.bytes.length!==file.size_bytes
        ||!/^([a-f0-9]{64})$/.test(file.sha256)||file.bytes.length<1||file.bytes.length>20*1024*1024
        ||metadata.provider_file_id!==file.provider_file_id||metadata.file_name!==file.file_name
        ||metadata.media_type!==file.media_type||metadata.size_bytes!==file.size_bytes)throw Error('slack_file_metadata_invalid');
      return {index,provider_file_id:file.provider_file_id,file_name:file.file_name,media_type:file.media_type,
        size_bytes:file.size_bytes,sha256:file.sha256};
    });
    const request={protocol:2,event:{channel,principal,thread_id:threadId,message_id:messageId},text,attachments};
    const stage=this.reserveAttachmentBatchV2(request,artifacts,binding);
    if(stage.state==='finalized'){
      const receipt=this.lookupAttachmentBatchV2(binding.owner_id,binding.channel_binding_id,stage.stage_key,artifacts);
      if(receipt.state==='admitted')return receipt;
      throw Error('channel_attachment_receipt_unproven');
    }
    for(const [index,file] of files.entries()){
      await this.writeAttachmentBatchPartV2(binding.owner_id,binding.channel_binding_id,stage.stage_key,index,
        (async function*(){yield file.bytes;})(),artifacts);
    }
    return this.acceptAttachmentBatchV2(binding.owner_id,binding.channel_binding_id,stage.stage_key,artifacts);
  }

  reserveAttachmentBatchV2(input:unknown,artifacts:ArtifactService,expectedBinding?:Pick<VerifiedBinding,'owner_id'|'channel_binding_id'|'version'>){
    if(!this.usesDatabase(this.db)||!artifacts.usesDatabase(this.db))throw Error('channel_attachment_database_mismatch');
    if(!input||typeof input!=='object'||!('event' in input)||!input.event||typeof input.event!=='object'||!('channel' in input.event)||!('principal' in input.event))throw Error('channel_attachment_stage_invalid');
    const event=input.event;
    return withImmediateTransaction(this.db,()=>{
      const binding=readVerifiedChannelBinding(this.db,String(event.channel),String(event.principal));
      if(expectedBinding&&(binding.owner_id!==expectedBinding.owner_id||binding.channel_binding_id!==expectedBinding.channel_binding_id
        ||binding.version!==expectedBinding.version))throw Error('channel_attachment_authority_mismatch');
      const source=normalizeChannelStageRequestV2(input,{owner_id:binding.owner_id,channel_binding_id:binding.channel_binding_id,binding_version:binding.version,conversation_id:`conv-${randomUUID()}`});
      enableChannelAttachmentProtocolV2(this.db);
      requireVerifiedChannelThread(this.db,binding,source.event.thread_id);
      requireStableMattermostAttachmentSource(this.db,source);
      const key=channelUploadStageKeyV2(source.event),previous=artifacts.readChannelUploadBatch(key);
      if(previous){
        if(previous.request_sha256!==channelStageRequestDigestV2(source))throw Object.assign(Error('channel_attachment_event_conflict'),{statusCode:409});
        return artifacts.reserveChannelUploadBatch(previous.source);
      }
      if(this.db.prepare('SELECT 1 FROM ga_channel_message_events WHERE channel=? AND principal=? AND provider_thread_id=? AND provider_message_id=?').get(source.event.channel,source.event.principal,source.event.thread_id,source.event.message_id))throw Object.assign(Error('channel_attachment_event_conflict'),{statusCode:409});
      const current=source.event.thread_id
        ?this.db.prepare('SELECT m.conversation_id,m.channel_binding_id,m.binding_version,c.owner_id FROM ga_channel_threads m LEFT JOIN ga_conversations c ON c.id=m.conversation_id WHERE m.channel=? AND m.principal=? AND m.provider_thread_id=?').get(binding.channel,binding.principal,source.event.thread_id)
        :this.db.prepare('SELECT m.conversation_id,m.channel_binding_id,m.binding_version,c.owner_id FROM ga_channel_bindings m LEFT JOIN ga_conversations c ON c.id=m.conversation_id WHERE m.channel=? AND m.principal=?').get(binding.channel,binding.principal);
      if(current&&current.channel_binding_id===binding.channel_binding_id&&Number(current.binding_version)===binding.version){
        if(current.owner_id!==binding.owner_id||typeof current.conversation_id!=='string')throw Error('channel_attachment_context_mismatch');
        return artifacts.reserveChannelUploadBatch({...source,conversation_id:current.conversation_id});
      }
      return artifacts.reserveChannelUploadBatch(source);
    });
  }

  async writeAttachmentBatchPartV2(owner:string,bindingId:string,key:string,index:number,bytes:AsyncIterable<Uint8Array>,artifacts:ArtifactService,signal?:AbortSignal){
    if(!artifacts.usesDatabase(this.db))throw Error('channel_attachment_database_mismatch');
    withImmediateTransaction(this.db,()=>this.batchScopeV2(owner,bindingId,key,artifacts));
    await artifacts.writeChannelUploadPart(key,index,bytes,signal);
  }

  lookupAttachmentBatchV2(owner:string,bindingId:string,key:string,artifacts:ArtifactService){
    const unproven={protocol:2 as const,state:'unproven' as const,original_admission:'unproven' as const,automatic_replay:false as const};
    if(!artifacts.usesDatabase(this.db))return unproven;
    return withImmediateTransaction(this.db,()=>{
      try{
        const binding=this.bindings.resolve(owner,bindingId),verified=readVerifiedChannelBinding(this.db,binding.channel,binding.principal);
        if(verified.owner_id!==owner||verified.channel_binding_id!==bindingId||verified.version!==binding.version)return unproven;
        if(!artifacts.readChannelUploadBatch(key))return{protocol:2 as const,state:'not_observed' as const,original_admission:'unproven' as const,automatic_replay:false as const};
        const stage=this.batchScopeV2(owner,bindingId,key,artifacts),receipt=this.proveAttachmentReceiptV2(stage.source);
        return receipt??{protocol:2 as const,state:'stage_observed' as const,stage,automatic_replay:false as const};
      }catch{return unproven;}
    });
  }

  /** Lost reservation ACK recovery from the original provider declaration;
   * derives scope again without allocating a conversation ID or upload row. */
  lookupAttachmentBatchRequestV2(input:unknown,artifacts:ArtifactService){
    const unproven={protocol:2 as const,state:'unproven' as const,original_admission:'unproven' as const,automatic_replay:false as const};
    if(!artifacts.usesDatabase(this.db)||!input||typeof input!=='object'||!('event' in input)||!input.event||typeof input.event!=='object'||!('channel' in input.event)||!('principal' in input.event))return unproven;
    const event=input.event;
    return withImmediateTransaction(this.db,()=>{
      try{
        const binding=readVerifiedChannelBinding(this.db,String(event.channel),String(event.principal));
        const source=normalizeChannelStageRequestV2(input,{owner_id:binding.owner_id,channel_binding_id:binding.channel_binding_id,binding_version:binding.version,conversation_id:'unreserved-conversation'});
        requireVerifiedChannelThread(this.db,binding,source.event.thread_id);
        requireStableMattermostAttachmentSource(this.db,source);
        const key=channelUploadStageKeyV2(source.event),stage=artifacts.readChannelUploadBatch(key);
        if(stage&&stage.request_sha256!==channelStageRequestDigestV2(source))return unproven;
        return this.lookupAttachmentBatchV2(binding.owner_id,binding.channel_binding_id,key,artifacts);
      }catch{return unproven;}
    });
  }

  async acceptAttachmentBatchV2(owner:string,bindingId:string,key:string,artifacts:ArtifactService,signal?:AbortSignal){
    signal?.throwIfAborted();if(!this.usesDatabase(this.db)||!artifacts.usesDatabase(this.db))throw Error('channel_attachment_database_mismatch');
    const cached=withImmediateTransaction(this.db,()=>{const stage=this.batchScopeV2(owner,bindingId,key,artifacts);enableChannelAttachmentProtocolV2(this.db);return this.proveAttachmentReceiptV2(stage.source);});
    if(cached)return cached;
    const stage=artifacts.prepareChannelUploadBatch(key,signal);
    return withImmediateTransaction(this.db,()=>{
      signal?.throwIfAborted();const current=this.batchScopeV2(owner,bindingId,key,artifacts),known=this.proveAttachmentReceiptV2(current.source);if(known)return known;
      if(current.manifest_sha256!==stage.manifest_sha256)throw Error('channel_attachment_stage_unproven');
      const binding=readVerifiedChannelBinding(this.db,current.source.event.channel,current.source.event.principal);
      const conversationId=this.conversation(binding,current.source.event.thread_id,current.source.conversation_id);
      if(conversationId!==current.source.conversation_id)throw Object.assign(Error('channel_attachment_context_changed'),{statusCode:409});
      artifacts.finalizeChannelUploadBatch(key,conversationId);
      return this.commitAttachmentSourceV2(current.source);
    });
  }

  private batchScopeV2(owner:string,bindingId:string,key:string,artifacts:ArtifactService){
    const stage=artifacts.readChannelUploadBatch(key);if(!stage)throw Error('channel_attachment_stage_unavailable');
    const source=stage.source,binding=readVerifiedChannelBinding(this.db,source.event.channel,source.event.principal);
    requireVerifiedChannelThread(this.db,binding,source.event.thread_id);
    requireStableMattermostAttachmentSource(this.db,source);
    if(source.owner_id!==owner||source.channel_binding_id!==bindingId||binding.owner_id!==owner||binding.channel_binding_id!==bindingId||binding.version!==source.binding_version)throw Error('channel_attachment_authority_mismatch');
    return stage;
  }

  /** Private candidate for existing original conversation/uploads only. No route
   * calls this until the initial-input consumer supports stored protocol 2. */
  async acceptAttachmentsV2(input:unknown,artifacts:ArtifactService,signal?:AbortSignal){
    signal?.throwIfAborted();
    if(!this.usesDatabase(this.db)||!artifacts.usesDatabase(this.db))throw Error('channel_attachment_database_mismatch');
    const {source,pinned}=normalizeChannelAttachmentManifestV2(input);
    const cached=withImmediateTransaction(this.db,()=>{
      this.attachmentScopeV2(source);enableChannelAttachmentProtocolV2(this.db);
      const receipt=this.proveAttachmentReceiptV2(source);
      if(!receipt)this.attachmentScopeV2(source);
      return receipt;
    });
    // A known admission is receipt-only: no upload, filesystem read or enqueue.
    if(cached)return cached;
    const snapshot=await artifacts.snapshotPinnedInput(source.owner_id,source.conversation_id,pinned,signal);
    try{
      signal?.throwIfAborted();
      return withImmediateTransaction(this.db,()=>{
        signal?.throwIfAborted();
        return this.commitAttachmentSourceV2(source);
      });
    }finally{await snapshot.dispose();}
  }

  private commitAttachmentSourceV2(source:ChannelAttachmentSourceV2){
    enableChannelAttachmentProtocolV2(this.db);
    const concurrent=this.proveAttachmentReceiptV2(source);if(concurrent)return concurrent;
    const binding=this.attachmentScopeV2(source),{pinned}=normalizeChannelAttachmentManifestV2(source);
    inspectPinnedAttachmentManifest(this.db,source.owner_id,source.conversation_id,pinned);
    const result=this.runs.enqueueChannelAttachmentsV2(source);
    if(typeof result.message_id!=='string'||typeof result.run_id!=='string')throw Error('channel_message_enqueue_invalid');
    const hash=channelAttachmentManifestDigestV2(source);
    this.db.prepare(`INSERT INTO ga_channel_message_events(
      channel,principal,provider_thread_id,provider_message_id,conversation_id,message_id,run_id,
      attachments_json,event_sha256,created_at,channel_binding_id,binding_version,content_protocol
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,2)`).run(source.event.channel,source.event.principal,source.event.thread_id,
      source.event.message_id,source.conversation_id,result.message_id,result.run_id,
      canonicalJson({protocol:2,manifest_sha256:hash,source}),hash,new Date().toISOString(),binding.channel_binding_id,binding.version);
    const receipt=this.proveAttachmentReceiptV2(source);if(!receipt)throw Error('channel_attachment_receipt_unproven');return receipt;
  }

  /** Owner/binding-scoped SQL-only recovery. Unknown never admits or retries. */
  lookupAttachmentReceiptV2(owner:string,bindingId:string,input:unknown){
    const unproven={protocol:2 as const,state:'unproven' as const,original_admission:'unproven' as const,automatic_replay:false as const};
    let source:ChannelAttachmentSourceV2;
    try{source=normalizeChannelAttachmentManifestV2(input).source;}catch{return unproven;}
    if(source.owner_id!==owner||source.channel_binding_id!==bindingId)return unproven;
    return withImmediateTransaction(this.db,()=>{
      try{
        const binding=this.bindings.resolve(owner,bindingId);
        if(binding.channel!==source.event.channel||binding.principal!==source.event.principal||binding.version!==source.binding_version)return unproven;
        this.attachmentScopeV2(source);
        return this.proveAttachmentReceiptV2(source)??{protocol:2 as const,state:'not_observed' as const,original_admission:'unproven' as const,automatic_replay:false as const};
      }catch{return unproven;}
    });
  }

  private attachmentScopeV2(source:ChannelAttachmentSourceV2){
    if(!this.db.isTransaction)throw Error('channel_authority_transaction_required');
    const binding=readVerifiedChannelBinding(this.db,source.event.channel,source.event.principal);
    requireVerifiedChannelThread(this.db,binding,source.event.thread_id);
    requireStableMattermostAttachmentSource(this.db,source);
    if(binding.owner_id!==source.owner_id||binding.channel_binding_id!==source.channel_binding_id||binding.version!==source.binding_version)throw Error('channel_attachment_authority_mismatch');
    const conversation=this.db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(source.conversation_id);
    if(conversation?.owner_id!==binding.owner_id)throw Error('channel_attachment_context_mismatch');
    const mapping=source.event.thread_id
      ?this.db.prepare('SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_threads WHERE channel=? AND principal=? AND provider_thread_id=?').get(source.event.channel,source.event.principal,source.event.thread_id)
      :this.db.prepare('SELECT conversation_id,channel_binding_id,binding_version FROM ga_channel_bindings WHERE channel=? AND principal=?').get(source.event.channel,source.event.principal);
    if(!mapping||mapping.conversation_id!==source.conversation_id||mapping.channel_binding_id!==binding.channel_binding_id||Number(mapping.binding_version)!==binding.version)throw Error('channel_attachment_context_not_ready');
    return binding;
  }

  /** Separate v2 proof; original proveCachedChannelEvent stays text-only. */
  private proveAttachmentReceiptV2(source:ChannelAttachmentSourceV2){
    if(!this.db.isTransaction)throw Error('channel_authority_transaction_required');
    const event=this.db.prepare(`SELECT *
      FROM ga_channel_message_events WHERE channel=? AND principal=? AND provider_thread_id=? AND provider_message_id=?`)
      .get(source.event.channel,source.event.principal,source.event.thread_id,source.event.message_id);
    if(!event)return undefined;
    const hash=channelAttachmentManifestDigestV2(source);
    if(event.event_sha256!==hash||event.attachments_json!==canonicalJson({protocol:2,manifest_sha256:hash,source}))throw Object.assign(Error('channel_attachment_event_conflict'),{statusCode:409});
    if(event.content_protocol!==2)throw Error('channel_attachment_receipt_unproven');
    this.attachmentScopeV2(source);
    if(event.conversation_id!==source.conversation_id||event.channel_binding_id!==source.channel_binding_id||Number(event.binding_version)!==source.binding_version||typeof event.message_id!=='string'||typeof event.run_id!=='string')throw Error('channel_attachment_receipt_unproven');
    const linked=this.db.prepare(`SELECT c.owner_id,m.content_json FROM ga_conversations c
      JOIN ga_runs r ON r.id=? AND r.conversation_id=c.id AND r.input_message_id=?
      JOIN ga_messages m ON m.id=r.input_message_id AND m.run_id=r.id AND m.conversation_id=c.id AND m.role='user' AND m.status='complete'
      WHERE c.id=?`).get(event.run_id,event.message_id,source.conversation_id);
    if(!linked||linked.owner_id!==source.owner_id||typeof event.message_id!=='string'||typeof event.run_id!=='string')throw Error('channel_attachment_receipt_unproven');
    let content:unknown;try{content=JSON.parse(String(linked.content_json));}catch{throw Error('channel_attachment_receipt_unproven');}
    if(canonicalJson(content)!==canonicalJson(encodeChannelAttachmentInputV2(event.message_id,source)))throw Error('channel_attachment_receipt_unproven');
    return Object.freeze({protocol:2 as const,state:'admitted' as const,event_sha256:hash,manifest_sha256:hash,
      receipt:Object.freeze({accepted:true as const,message_id:event.message_id,run_id:event.run_id,conversation_id:source.conversation_id})});
  }

  /** Read-only original text event recovery; never invokes admission or proof consumption. */
  lookupOriginalChannelEventReceipt(input:unknown){
    const unproven={state:'unproven' as const,automatic_replay:false as const};
    try{
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='attachments,channel,message_id,principal,text,thread_id')return unproven;
      const message=channelMessage(input);
      if(message.channel!=='mattermost'||message.attachments.length||message.text.startsWith('/jot-bind'))return unproven;
      requireMattermostConfiguredAccount(this.bindings.mattermostConfiguration(),message.principal,message.threadId);
      return withImmediateTransaction(this.db,()=>{
        const binding=readVerifiedChannelBinding(this.db,message.channel,message.principal);requireVerifiedChannelThread(this.db,binding,message.threadId);
        requireMattermostOriginalPost(this.db,message.principal,message.threadId,message.messageId);
        const event=this.db.prepare('SELECT 1 FROM ga_channel_message_events WHERE channel=? AND principal=? AND provider_thread_id=? AND provider_message_id=?').get(message.channel,message.principal,message.threadId,message.messageId);
        if(!event)return {state:'unobserved' as const,automatic_replay:false as const};
        const proof=proveCachedChannelEvent(this.db,message);
        return {state:'observed' as const,receipt:{accepted:true as const,message_id:proof.message_id,run_id:proof.run_id,conversation_id:proof.conversation_id},automatic_replay:false as const};
      });
    }catch{return unproven;}
  }

  accept(input: Record<string, unknown>) {
    const message = channelMessage(input);
    if(message.channel==='mattermost'){
      requireMattermostConfiguredAccount(this.bindings.mattermostConfiguration(),message.principal,message.threadId);
      if(message.attachments.length)throw Error('channel_attachment_staging_missing');
      if(message.text.startsWith('/jot-bind'))return this.bindings.acceptMattermost({principal:message.principal,thread_id:message.threadId,message_id:message.messageId,text:message.text});
    }
    if (message.channel!=='mattermost' && message.text.startsWith('/jot-bind')) {
      if ((message.channel !== 'matrix' && message.channel !== 'sms' && message.threadId) || message.attachments.length) throw new Error('channel_binding_proof_invalid');
      const match = /^\/jot-bind ([A-Za-z0-9_-]{43})$/.exec(message.text);
      if (!match) throw new Error('channel_binding_proof_invalid');
      return this.bindings.acceptProof(message.channel, message.principal, match[1]!,message.channel==='matrix'
        ?{provider_thread_id:message.threadId}:undefined);
    }
    const eventSha256 = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    return withImmediateTransaction(this.db, () => {
      let binding: VerifiedBinding;
      try {
        binding = readVerifiedChannelBinding(this.db, message.channel, message.principal);
        requireVerifiedChannelThread(this.db,binding,message.threadId);
        if(message.channel==='mattermost')requireMattermostOriginalPost(this.db,message.principal,message.threadId,message.messageId);
      } catch (error) {
        if (error instanceof Error && error.message === 'channel_authority_binding_missing') {
          throw new Error('channel_binding_not_verified');
        }
        throw error;
      }

      const cached = this.db.prepare(`SELECT 1 FROM ga_channel_message_events
        WHERE channel=? AND principal=? AND provider_thread_id=? AND provider_message_id=?`)
        .get(message.channel, message.principal, message.threadId, message.messageId);
      if (cached) {
        const proof = proveCachedChannelEvent(this.db, message);
        return { accepted: true, message_id: proof.message_id, run_id: proof.run_id,
          conversation_id: proof.conversation_id };
      }

      const conversationId = this.conversation(binding, message.threadId);
      const result = this.runs.enqueue(conversationId, binding.owner_id, {
        client_message_id: `${message.channel}:${message.messageId}`,
        content: [{ type: 'text', text: message.text }],
      });
      if (typeof result.message_id !== 'string' || typeof result.run_id !== 'string') {
        throw new Error('channel_message_enqueue_invalid');
      }
      this.db.prepare(`INSERT INTO ga_channel_message_events(
        channel,principal,provider_thread_id,provider_message_id,conversation_id,message_id,run_id,
        attachments_json,event_sha256,created_at,channel_binding_id,binding_version
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(message.channel, message.principal, message.threadId, message.messageId,
        conversationId, result.message_id, result.run_id, '[]', eventSha256, new Date().toISOString(),
        binding.channel_binding_id, binding.version);
      return result;
    });
  }

  private conversation(binding: VerifiedBinding, threadId: string,plannedId?:string): string {
    const threaded = threadId.length > 0;
    const table = threaded ? 'ga_channel_threads' : 'ga_channel_bindings';
    const predicate = threaded
      ? 'channel=? AND principal=? AND provider_thread_id=?'
      : 'channel=? AND principal=?';
    const values = threaded ? [binding.channel, binding.principal, threadId] : [binding.channel, binding.principal];
    const current = this.db.prepare(`SELECT m.conversation_id,m.channel_binding_id,m.binding_version,c.owner_id
      FROM ${table} m LEFT JOIN ga_conversations c ON c.id=m.conversation_id WHERE ${predicate}`)
      .get(...values) as Record<string, unknown> | undefined;
    if (!current) {
      const conversationId = this.createConversation(binding,plannedId);
      if (threaded) {
        const inserted = this.db.prepare(`INSERT INTO ga_channel_threads(
          channel,principal,provider_thread_id,conversation_id,created_at,updated_at,channel_binding_id,binding_version
        ) VALUES(?,?,?,?,?,?,?,?)`).run(binding.channel, binding.principal, threadId,
          conversationId, new Date().toISOString(), new Date().toISOString(), binding.channel_binding_id, binding.version);
        if (Number(inserted.changes) !== 1) throw new Error('channel_thread_generation_conflict');
      } else {
        const inserted = this.db.prepare(`INSERT INTO ga_channel_bindings(
          channel,principal,conversation_id,created_at,updated_at,channel_binding_id,binding_version
        ) VALUES(?,?,?,?,?,?,?)`).run(binding.channel, binding.principal, conversationId,
          new Date().toISOString(), new Date().toISOString(), binding.channel_binding_id, binding.version);
        if (Number(inserted.changes) !== 1) throw new Error('channel_root_generation_conflict');
      }
      return conversationId;
    }

    if (typeof current.channel_binding_id !== 'string' || !current.channel_binding_id
      || !Number.isSafeInteger(Number(current.binding_version)) || Number(current.binding_version) < 1) {
      throw new Error('channel_authority_legacy_mapping_unpinned');
    }
    if (current.channel_binding_id === binding.channel_binding_id
      && Number(current.binding_version) === binding.version) {
      if (current.owner_id !== binding.owner_id) throw new Error('channel_authority_owner_mismatch');
      if (typeof current.conversation_id !== 'string' || !current.conversation_id) {
        throw new Error('channel_authority_mapping_invalid');
      }
      if(plannedId!==undefined&&plannedId!==current.conversation_id)throw Object.assign(Error('channel_attachment_context_changed'),{statusCode:409});
      return current.conversation_id;
    }

    const oldConversationId = current.conversation_id;
    if (typeof oldConversationId !== 'string' || !oldConversationId) throw new Error('channel_authority_mapping_invalid');
    const oldBindingId = current.channel_binding_id;
    const oldBindingVersion = Number(current.binding_version);
    const conversationId = this.createConversation(binding,plannedId);
    const changed = this.db.prepare(`UPDATE ${table} SET conversation_id=?,channel_binding_id=?,binding_version=?,updated_at=?
      WHERE ${predicate} AND conversation_id=? AND channel_binding_id=? AND binding_version=?`)
      .run(conversationId, binding.channel_binding_id, binding.version, new Date().toISOString(),
        ...values, oldConversationId, oldBindingId, oldBindingVersion);
    if (Number(changed.changes) !== 1) {
      throw new Error(threaded ? 'channel_thread_generation_conflict' : 'channel_root_generation_conflict');
    }
    return conversationId;
  }

  private createConversation(binding: VerifiedBinding,plannedId?:string): string {
    const id = plannedId??`conv-${randomUUID()}`;
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO ga_conversations(
      id,owner_id,workspace_id,title,model,version,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(id, binding.owner_id, this.workspaceId,
      `${binding.channel}:${binding.principal}`, JSON.stringify({ provider: 'harness', model: 'automatic' }), 1, now, now);
    return id;
  }
}
