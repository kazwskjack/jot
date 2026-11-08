/** M19.09 proposal1 only. Not registered, implemented, migrated or activation authority. */
import type {ChannelId} from './types.ts';
import type {AttachmentManifest} from '../src/artifacts/pinned-manifest.ts';
import type {ArtifactService} from '../src/artifacts/service.ts';
export type {ChannelAttachmentSourceV2} from '../src/channels/attachment-manifest-v2.ts';
export type ChannelEventKeyV2=Readonly<{channel:ChannelId;principal:string;thread_id:string;message_id:string}>;
export type ChannelAttachmentDeclarationV2=Readonly<{
 index:number;provider_file_id:string;file_name:string;media_type:string;size_bytes:number;sha256:string;
}>;
/** Inputs contain no owner, conversation, binding, filesystem path, URL or authority boolean. */
export type ChannelStageRequestV2=Readonly<{
 protocol:2;event:ChannelEventKeyV2;text:string;attachments:readonly ChannelAttachmentDeclarationV2[];
}>;
/** These facts are derived and re-proven by the original Gateway, never trusted on resubmission. */
export type ChannelStageScopeV2=Readonly<{
 owner_id:string;conversation_id:string;channel_binding_id:string;binding_version:number;event:ChannelEventKeyV2;
}>;
export type ChannelStagePartV2=Readonly<{
 index:number;provider_file_id:string;upload_id:string;artifact_id:string;version:1;
 file_name:string;media_type:string;size_bytes:number;sha256:string;
}>;
export type ChannelAttachmentStageV2=Readonly<{
 protocol:2;state:'staging'|'staged';stage_key:string;source_sha256:string;manifest_sha256:string;
 scope:ChannelStageScopeV2;text:string;parts:readonly ChannelStagePartV2[];expires_at:string;
}>;
export type ChannelAdmissionReceiptV2=Readonly<{
 protocol:2;state:'admitted';event_sha256:string;manifest_sha256:string;
 receipt:Readonly<{accepted:true;message_id:string;run_id:string;conversation_id:string}>;
}>;
export type ChannelReceiptQueryV2=Readonly<{
 protocol:2;event:ChannelEventKeyV2;stage_key:string;event_sha256:string;manifest_sha256:string;
}>;
export type ChannelReceiptLookupV2=ChannelAdmissionReceiptV2|Readonly<{
 protocol:2;state:'not_observed'|'unproven';original_admission:'unproven';automatic_replay:false;
}>;
/** Explicit new stored message representation: no artifact IDs inserted into legacy attachments[]. */
export type StoredChannelInputV2=Readonly<{
 protocol:2;kind:'channel_input';blocks:readonly Readonly<{block_id:string;kind:'text';text:string}>[];
 attachment_manifest:AttachmentManifest;attachment_manifest_sha256:string;
}>;
/** Semantic signatures for review, not actual SDK exports or callable producer implementation. */
export interface ProposedChannelAttachmentProducerV2 {
 reserve(input:ChannelStageRequestV2,signal?:AbortSignal):Promise<ChannelAttachmentStageV2>;
 writePart(stageKey:string,index:number,bytes:AsyncIterable<Uint8Array>,signal?:AbortSignal):Promise<void>;
 seal(stageKey:string,sourceSha256:string,signal?:AbortSignal):Promise<ChannelAttachmentStageV2>;
 admit(stageKey:string,eventSha256:string,manifestSha256:string):ChannelAdmissionReceiptV2;
 lookup(input:ChannelReceiptQueryV2):ChannelReceiptLookupV2;
}

/** Implemented private subset for an existing mapped conversation and original
 * ready uploads. No reserve/writePart/seal, public registration or activation.
 * event_sha256 equals the complete normalized source manifest hash in this v2.
 * Owner and binding are trusted composition inputs, always re-proven in SQL. */
export interface ExistingChannelAttachmentProducerV2 {
 acceptAttachmentsV2(source:unknown,artifacts:ArtifactService,signal?:AbortSignal):Promise<ChannelAdmissionReceiptV2>;
 lookupAttachmentReceiptV2(owner:string,bindingId:string,source:unknown):ChannelReceiptLookupV2;
}

/** Original ga_uploads durable batch subset. Gateway derives all scope fields. */
export type DurableChannelUploadStageV2=NonNullable<ReturnType<ArtifactService['readChannelUploadBatch']>>;
export interface DurableChannelAttachmentProducerV2 extends ExistingChannelAttachmentProducerV2 {
 reserveAttachmentBatchV2(request:unknown,artifacts:ArtifactService):DurableChannelUploadStageV2;
 writeAttachmentBatchPartV2(owner:string,bindingId:string,stageKey:string,index:number,bytes:AsyncIterable<Uint8Array>,artifacts:ArtifactService,signal?:AbortSignal):Promise<void>;
 acceptAttachmentBatchV2(owner:string,bindingId:string,stageKey:string,artifacts:ArtifactService,signal?:AbortSignal):Promise<ChannelAdmissionReceiptV2>;
 lookupAttachmentBatchV2(owner:string,bindingId:string,stageKey:string,artifacts:ArtifactService):ChannelReceiptLookupV2|Readonly<{protocol:2;state:'stage_observed';stage:DurableChannelUploadStageV2;automatic_replay:false}>;
 lookupAttachmentBatchRequestV2(request:unknown,artifacts:ArtifactService):ChannelReceiptLookupV2|Readonly<{protocol:2;state:'stage_observed';stage:DurableChannelUploadStageV2;automatic_replay:false}>;
}
