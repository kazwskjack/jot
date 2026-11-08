import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactService, PinnedArtifactCleanupInput } from '../artifacts/service.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import type { ChannelDeliveryService } from './delivery.ts';
import type { MattermostDeliveryTarget } from './delivery.ts';
import type { MattermostOwnerAccount } from './mattermost-owner-proof.ts';
import {fileDeliveryContext,type DeliveryEffectContext,type FileDeliveryEffectContext} from './delivery-effect-context.ts';
import {MAX_SLACK_ARTIFACT_BYTES} from './slack-artifact-ref.ts';

export interface DeliveryProvider {
  send(text: string, recipient: string, context?: DeliveryEffectContext):
    Promise<Record<string, unknown> & { provider_message_id?: unknown }>;
  sendWithKey?(text:string,recipient:string,effectId:string):Promise<Record<string,unknown>&{provider_message_id?:unknown}>;
  sendFile(path: string, recipient: string, displayName: string,context?:FileDeliveryEffectContext,beforePost?:()=>Promise<boolean>):
    Promise<Record<string, unknown> & { provider_message_id?: unknown }>;
}

interface DeliveryRuntime {
  registerDeliveryReceipt(runtimeRunId: string, clientRunId: string, receiptRef: string,
    recipientRef: string, status: 'delivered'): Promise<Record<string, unknown>>;
}

interface DeliveryResolvers {
  artifacts?: ArtifactService;
  cleanupArtifact?(input: PinnedArtifactCleanupInput): void | Promise<void>;
  mattermostAccount?:MattermostOwnerAccount;
  resolveRuntime(clientRunId: string): { runtimeRunId: string; clientRunId: string };
}

function stableProviderMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function cleanupSpool(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

export class ChannelDeliveryWorker {
  private readonly store: ChannelDeliveryService;
  private readonly providers: Record<string,DeliveryProvider>;
  private readonly runtime: DeliveryRuntime;
  private readonly resolvers: DeliveryResolvers;
  private readonly owner: string;
  constructor(store: ChannelDeliveryService, provider: DeliveryProvider|{providers:Record<string,DeliveryProvider>},
    runtime: DeliveryRuntime, resolvers: DeliveryResolvers,
    owner = 'general-agent-delivery-j') {
    this.store = store; this.providers = 'providers' in provider?provider.providers:{wecom:provider}; this.runtime = runtime;
    this.resolvers = resolvers; this.owner = owner;
  }

  async processNext(): Promise<boolean> {
    const item = this.store.claim(this.owner, 90, Object.keys(this.providers), this.resolvers.artifacts);
    if (!item) return false;
    let receipt = item.provider_receipt as Record<string, unknown> | null;
    if (item.phase === 'send') {
      const provider=this.providers[String(item.destination)];if(!provider)throw new Error('delivery_channel_not_configured');
      if(!this.store.authorizeSend(String(item.effect_id),Number(item.generation)))return true;
      const payload = item.payload_json ? JSON.parse(String(item.payload_json)) as Record<string, unknown> : null;
      if (payload?.kind === 'text') {
        const text = this.store.prepareTextDelivery(String(item.effect_id),Number(item.generation));
        if (!text) throw new Error('delivery_text_invalid');
        // Digest membership freezes under a transaction, then every member's
        // authorization is checked again immediately before the one send call.
        if(!this.store.authorizeSend(String(item.effect_id),Number(item.generation)))return true;
        const target=this.mattermostTarget(item);
        let sent: Record<string, unknown> & { provider_message_id?: unknown };
        try {
          sent = item.destination==='sms'
            ? await (provider.sendWithKey?.(text,String(item.recipient),String(item.effect_id))
              ?? Promise.reject(new Error('sms_delivery_key_required')))
            : await provider.send(text, target?.channel_id??String(item.recipient),{effectId:String(item.effect_id),generation:Number(item.generation),
              idempotencyKey:String(item.effect_id)});
        } catch (error) {
          if(this.recordMattermostFailure(item,error))return true;
          if(item.destination==='sms'&&error instanceof Error&&error.message==='sms_reply_context_missing'){
            this.store.recordSmsAuthorizationRejected(String(item.effect_id),Number(item.generation));
            return true;
          }
          if (/timeout|abort|socket|network/i.test(String(error instanceof Error ? error.message : error))) {
            this.store.recordProviderUnknown(String(item.effect_id), Number(item.generation));
            return true;
          }
          throw error;
        }
        if (typeof sent.provider_message_id === 'string' && sent.provider_message_id) {
          receipt = sent;
        } else if(item.destination==='webpush'&&sent.accepted===true){
          receipt={provider_message_id:`webpush-accepted:${String(item.effect_id)}:${String(item.generation)}`,accepted:true};
        } else if(item.destination==='webpush'&&sent.outcome_unknown===true){
          this.store.recordProviderUnknown(String(item.effect_id),Number(item.generation));
          return true;
        } else if(item.destination==='webpush'&&sent.retryable===true&&sent.status===429&&sent.code==='PUSH_PROVIDER_RATE_LIMITED'){
          this.store.recordProviderRetry(String(item.effect_id),Number(item.generation));
          return true;
        } else if(item.destination==='webpush'&&sent.accepted===false){
          const code=typeof sent.code==='string'&&['PUSH_SUBSCRIPTION_EXPIRED','PUSH_VAPID_GENERATION_STALE','PUSH_ENDPOINT_UNAVAILABLE','PUSH_PROVIDER_REJECTED','PUSH_PAYLOAD_INVALID','PUSH_FILE_DELIVERY_UNSUPPORTED'].includes(sent.code)
            ?sent.code:'PUSH_PROVIDER_REJECTED';
          this.store.recordProviderRejected(String(item.effect_id),Number(item.generation),code);
          return true;
        } else if (sent.ok === true && item.destination==='wecom') {
          // The deployed legacy WeCom adapter reports errcode=0 as {ok:true}
          // but has no msgid for application text. The API has already accepted
          // the message, so persist a deterministic local receipt rather than
          // incorrectly converting a confirmed send into outcome_unknown.
          receipt = { ...sent,
            provider_message_id: `wecom-text:${String(item.effect_id)}:${String(item.generation)}` };
        } else {
          this.store.recordProviderUnknown(String(item.effect_id), Number(item.generation));
          return true;
        }
      } else {
        if(item.destination!=='wecom'&&item.destination!=='mattermost'&&item.destination!=='slack')throw new Error('channel_delivery_artifact_unsupported');
        if (!this.resolvers.artifacts || item.artifact_ref === null || payload?.kind !== 'artifact'
          || item.destination === 'weixin') throw new Error('channel_delivery_artifact_pin_required');
        const partCount = Array.isArray(payload.manifest) ? payload.manifest.length : 0;
        if (!partCount || partCount > 50) throw new Error('delivery_artifact_parts_invalid');
        const providerIds: string[] = [];
        for (let index = 0; index < partCount; index += 1) {
          const firstProof = this.store.authorizePinnedArtifactSend(String(item.effect_id),
            Number(item.generation), this.resolvers.artifacts);
          if (!firstProof) return true;
          const maxArtifactBytes=item.destination==='slack'?MAX_SLACK_ARTIFACT_BYTES:104857600;
          if (firstProof.parts.length !== partCount || firstProof.size_bytes > maxArtifactBytes) {
            throw new Error('delivery_artifact_parts_invalid');
          }
          const part = firstProof.parts[index];
          if (!part || !Buffer.isBuffer(part.content) || part.content.length !== part.size_bytes) {
            throw new Error('channel_artifact_content_mismatch');
          }
          const spoolDirectory = mkdtempSync(join(tmpdir(), 'jot-channel-artifact-'));
          try {
            const spoolPath = join(spoolDirectory, 'verified-part.bin');
            writeFileSync(spoolPath, part.content, { flag: 'wx', mode: 0o600 });
            const sendProof = this.store.authorizePinnedArtifactSend(String(item.effect_id),
              Number(item.generation), this.resolvers.artifacts);
            if (!sendProof) return true;
            const sendPart = sendProof.parts[index];
            if (sendProof.effect_id!==String(item.effect_id)||sendProof.generation!==Number(item.generation)
              ||!sendPart || sendProof.manifest_sha256 !== firstProof.manifest_sha256
              || sendPart.sha256 !== part.sha256 || sendPart.size_bytes !== part.size_bytes
              || !sendPart.content.equals(part.content)) throw new Error('channel_artifact_content_mismatch');
            let partReceipt: Record<string, unknown>;
            const target=this.mattermostTarget(item);
            const beforePost=target?async()=>{
              const currentTarget=this.mattermostTarget(item,true);
              return !!currentTarget&&this.sameMattermostTarget(target,currentTarget)
                &&this.sameMattermostArtifact(item,sendProof,sendPart);
            }:item.destination==='slack'?async()=>this.store.authorizeSend(String(item.effect_id),Number(item.generation)):undefined;
            try {
              const context=fileDeliveryContext(String(item.effect_id),Number(item.generation),{
                artifactId:sendProof.artifact_id,version:sendProof.version,manifestSha256:sendProof.manifest_sha256,
                partIndex:sendPart.part_index,partSha256:sendPart.sha256,partSizeBytes:sendPart.size_bytes,displayName:sendPart.display_name});
              partReceipt = await provider.sendFile(spoolPath, target?.channel_id??String(item.recipient), sendPart.display_name,context,beforePost);
            } catch (error) {
              if(this.recordMattermostFailure(item,error))return true;
              if(item.destination==='slack'&&error instanceof Error&&error.message==='slack_delivery_authorization_revoked')return true;
              if (/timeout|abort|socket|network/i.test(String(error instanceof Error ? error.message : error))) {
                this.store.recordProviderUnknown(String(item.effect_id), Number(item.generation));
                return true;
              }
              throw error;
            }
            if (!stableProviderMessageId(partReceipt?.provider_message_id)) {
              this.store.recordProviderUnknown(String(item.effect_id), Number(item.generation));
              return true;
            }
            providerIds.push(partReceipt.provider_message_id);
            this.store.recordProviderPart(String(item.effect_id), Number(item.generation),
              index + 1, partCount, partReceipt);
          } finally {
            cleanupSpool(spoolDirectory);
          }
        }
        receipt = { provider_message_id: `group:${createHash('sha256')
          .update(providerIds.join('\0')).digest('hex').slice(0, 32)}`,
          receipts: providerIds.map((provider_message_id, index) => ({
            part_index: index + 1, provider_message_id,
          })), total: partCount };
      }
      this.store.recordProviderSent(String(item.effect_id), Number(item.generation), receipt);
    }
    try {
      if (!receipt || typeof receipt.provider_message_id !== 'string') {
        throw new Error('provider_receipt_invalid');
      }
      const payload = item.payload_json ? JSON.parse(String(item.payload_json)) as Record<string, unknown> : null;
      if (payload?.kind !== 'text') {
        const binding = this.resolvers.resolveRuntime(String(item.run_id));
        const runtimeReceipt = await this.runtime.registerDeliveryReceipt(
          binding.runtimeRunId, binding.clientRunId,
          `${String(item.destination)}:${receipt.provider_message_id}`, String(item.recipient), 'delivered');
        if (runtimeReceipt.ok !== true) throw new Error('RUNTIME_RECEIPT_REJECTED');
      }
      // Receipt-only legacy rows can finish runtime recovery, but without a pin
      // there is no exact artifact version/manifest that may be marked delivered.
      if (payload?.kind === 'artifact' && item.destination!=='slack' && this.resolvers.cleanupArtifact) {
        const cleanupInput = { ...payload, run_id: String(item.run_id) } as PinnedArtifactCleanupInput;
        if (String(item.artifact_ref) !== cleanupInput.artifact_id) {
          throw new Error('channel_delivery_artifact_source_mismatch');
        }
        await this.resolvers.cleanupArtifact(cleanupInput);
      }
      this.store.recordDelivered(String(item.effect_id));
    } catch {
      this.store.recordReceiptFailure(String(item.effect_id), 'RUNTIME_RECEIPT_UNAVAILABLE');
    }
    return true;
  }

  private mattermostTarget(item:Record<string,any>,afterProviderSideEffect=false):MattermostDeliveryTarget|undefined{
    if(item.destination!=='mattermost')return undefined;
    if(!this.resolvers.mattermostAccount)throw new Error('mattermost_delivery_authority_invalid');
    return this.store.mattermostDeliveryTarget(String(item.effect_id),Number(item.generation),this.resolvers.mattermostAccount,afterProviderSideEffect);
  }
  private sameMattermostTarget(left:MattermostDeliveryTarget,right:MattermostDeliveryTarget):boolean{
    return ['effect_id','generation','owner_id','channel_binding_id','binding_version','principal','instance','bot_user_id','channel_id','root_id']
      .every(key=>left[key as keyof MattermostDeliveryTarget]===right[key as keyof MattermostDeliveryTarget]);
  }
  private sameMattermostArtifact(item:Record<string,any>,proof:{owner_id:string;conversation_id:string;artifact_id:string;version:number;sha256:string;size_bytes:number;manifest_sha256:string;parts:ReadonlyArray<{part_index:number;display_name:string;sha256:string;size_bytes:number;mime_type:string}>},part:{part_index:number;display_name:string;sha256:string;size_bytes:number;mime_type:string}):boolean{
    const effect=this.store.get(String(item.effect_id));let pin:Record<string,any>;
    try{pin=JSON.parse(String(effect.payload_json));}catch{return false;}
    const currentPart=Array.isArray(pin.manifest)?pin.manifest.find(value=>value?.part_index===part.part_index):undefined;
    return effect.status==='sending'&&Number(effect.generation)===Number(item.generation)&&effect.run_id===item.run_id
      &&effect.message_id===item.message_id&&effect.artifact_ref===proof.artifact_id&&pin.kind==='artifact'&&pin.schema_version===1
      &&pin.owner_id===proof.owner_id&&pin.conversation_id===proof.conversation_id&&pin.artifact_id===proof.artifact_id
      &&pin.version===proof.version&&pin.sha256===proof.sha256&&pin.size_bytes===proof.size_bytes
      &&pin.manifest_sha256===proof.manifest_sha256&&Array.isArray(pin.manifest)&&pin.manifest.length===proof.parts.length
      &&createHash('sha256').update(canonicalJson(pin.manifest)).digest('hex')===proof.manifest_sha256
      &&currentPart?.display_name===part.display_name&&currentPart.sha256===part.sha256
      &&currentPart.size_bytes===part.size_bytes&&currentPart.mime_type===part.mime_type;
  }
  private recordMattermostFailure(item:Record<string,any>,error:unknown):boolean{
    if(item.destination!=='mattermost')return false;
    const code=error instanceof Error?error.message:'';
    const current=this.store.get(String(item.effect_id));
    if(current.status!=='sending'||Number(current.generation)!==Number(item.generation))return true;
    if(code==='mattermost_provider_rejected'&&!current.provider_receipt_json)this.store.recordProviderRejected(String(item.effect_id),Number(item.generation),'MATTERMOST_PROVIDER_REJECTED');
    else this.store.recordProviderUnknown(String(item.effect_id),Number(item.generation));
    return true;
  }
}
