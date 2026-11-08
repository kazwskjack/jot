import { createHash } from 'node:crypto';
import { emailPrincipal } from './email-provider.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactService } from '../artifacts/service.ts';
import { withImmediateTransaction } from '../db/database.ts';
import { provePendingPinnedChannelArtifact, provePinnedChannelArtifact } from './authority-proofs.ts';
import { canonicalJson } from '../db/canonical-json.ts';
import {TaskNotifications} from '../persistent-tasks/notifications.ts';
import {defaultNotificationPolicy,normalizeNotificationPolicy,notificationQuietUntil} from '../persistent-tasks/notification-policy.ts';
import {signalDeliveryAuthorized,signalDeliverySourceResolved} from '../persistent-tasks/notification-signals.ts';
import {hostDeliveryAuthorized,hostDeliverySourceResolved} from '../persistent-tasks/host-notifications.ts';
import {replyDeliveryCheck} from '../persistent-tasks/reply-delivery.ts';
import {resolveNotificationArchive,resolveNotificationDigestArchive,ensureNotificationArchiveSchema} from './notification-archive.ts';
import {historicalFinalSendCheck} from './historical-final-send.ts';
import {mattermostOwnerAccount,type MattermostOwnerAccount} from './mattermost-owner-proof.ts';
import {requireMattermostBindingThread,requireMattermostConfiguredAccount} from './mattermost-thread-scope.ts';
import {readFileSync} from 'node:fs';
import {encodeSlackArtifactRef,decodeSlackArtifactRef,MAX_SLACK_ARTIFACT_BYTES} from './slack-artifact-ref.ts';
import {resolveTwilioSmsReplyContext} from './sms.ts';

const MAX_PUSH_PROVIDER_RETRIES=2;
const FIRST_PUSH_PROVIDER_RETRY_DELAY_SECONDS=30;

export type MattermostDeliveryTarget=Readonly<{effect_id:string;generation:number;owner_id:string;channel_binding_id:string;binding_version:number;principal:string;instance:string;bot_user_id:string;channel_id:string;root_id:''}>;

export interface ExternalDeliveryInput {
  runId: string;
  messageId: string;
  destination: string;
  recipient: string;
  artifactRef: string | null;
  text?: string | null;
}

export interface PinnedArtifactDeliveryInput {
  runId: string;
  messageId: string;
  destination: string;
  recipient: string;
  ownerId: string;
  artifactId: string;
  version: number;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export class ChannelDeliveryService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  usesDatabase(db:DatabaseSync):boolean{return this.db===db;}
  constructor(db: DatabaseSync,
    now: () => number = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.now = now;
    ensureNotificationArchiveSchema(db);
    new TaskNotifications(db);
    db.exec(`CREATE TABLE IF NOT EXISTS wb_task_delivery_authorizations (
      effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),owner_id TEXT NOT NULL,task_id TEXT NOT NULL,
      occurrence_id TEXT NOT NULL,generation INTEGER NOT NULL,task_version INTEGER NOT NULL,agent_id TEXT NOT NULL,epoch INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,channel TEXT NOT NULL,principal TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS wb_task_delivery_authorizations_no_update BEFORE UPDATE ON wb_task_delivery_authorizations
       BEGIN SELECT RAISE(ABORT,'task_delivery_authorization_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_task_delivery_authorizations_no_delete BEFORE DELETE ON wb_task_delivery_authorizations
       BEGIN SELECT RAISE(ABORT,'task_delivery_authorization_immutable'); END;
      CREATE TABLE IF NOT EXISTS wb_task_notification_deferrals (
       effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),not_before INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_channel_delivery_provider_retries (
       effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),retry_count INTEGER NOT NULL CHECK(retry_count>0));
      CREATE TABLE IF NOT EXISTS wb_task_notification_send_reservations (
       effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),bucket_hash TEXT NOT NULL,reserved_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS wb_task_notification_send_bucket ON wb_task_notification_send_reservations(bucket_hash,reserved_at);
      CREATE TRIGGER IF NOT EXISTS wb_task_notification_send_no_update BEFORE UPDATE ON wb_task_notification_send_reservations
       BEGIN SELECT RAISE(ABORT,'notification_send_reservation_immutable'); END;
      CREATE TABLE IF NOT EXISTS wb_task_notification_quiet_queue (
       effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),quiet_end INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_task_notification_digests (
       digest_id TEXT PRIMARY KEY,anchor_effect_id TEXT NOT NULL UNIQUE REFERENCES ga_channel_deliveries(effect_id),
       payload_text TEXT NOT NULL,payload_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wb_task_notification_digest_members (
       effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),digest_id TEXT NOT NULL REFERENCES wb_task_notification_digests(digest_id),
       generation INTEGER NOT NULL,ordinal INTEGER NOT NULL,UNIQUE(digest_id,ordinal));
      CREATE TRIGGER IF NOT EXISTS wb_task_notification_digest_member_no_update BEFORE UPDATE ON wb_task_notification_digest_members
       BEGIN SELECT RAISE(ABORT,'notification_digest_member_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_task_notification_digest_no_delete BEFORE DELETE ON wb_task_notification_digests
       BEGIN SELECT RAISE(ABORT,'notification_digest_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS wb_task_notification_digest_member_no_delete BEFORE DELETE ON wb_task_notification_digest_members
       BEGIN SELECT RAISE(ABORT,'notification_digest_member_immutable'); END;
      CREATE TABLE IF NOT EXISTS ga_slack_artifact_delivery_pins(
       effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
       source_run_id TEXT NOT NULL,source_message_id TEXT NOT NULL,recipient TEXT NOT NULL,channel_binding_id TEXT NOT NULL,
       binding_version INTEGER NOT NULL,artifact_id TEXT NOT NULL,artifact_version INTEGER NOT NULL,server_path TEXT NOT NULL,
       sha256 TEXT NOT NULL CHECK(length(sha256)=64),size_bytes INTEGER NOT NULL CHECK(size_bytes>0),display_name TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS ga_slack_artifact_delivery_pins_no_update BEFORE UPDATE ON ga_slack_artifact_delivery_pins
       BEGIN SELECT RAISE(ABORT,'slack_artifact_delivery_pin_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ga_slack_artifact_delivery_pins_no_delete BEFORE DELETE ON ga_slack_artifact_delivery_pins
       BEGIN SELECT RAISE(ABORT,'slack_artifact_delivery_pin_immutable'); END;`);
    ensureNotificationArchiveSchema(db);
  }

  bindTaskAuthorization(effectId:string,scope:{owner_id:string;task_id:string;occurrence_id:string;generation:number;task_version:number;agent_id:string;epoch:number},conversationId:string,principal:string):void{
    if(!this.db.isTransaction)throw new Error('task_delivery_transaction_required');
    const effect=this.get(effectId);
    if(!['wecom','email','webpush','mattermost'].includes(String(effect.destination))||effect.recipient!==principal||effect.status!=='pending')throw new Error('task_delivery_authorization_invalid');
    this.db.prepare('INSERT INTO wb_task_delivery_authorizations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(effectId,scope.owner_id,scope.task_id,scope.occurrence_id,scope.generation,scope.task_version,scope.agent_id,scope.epoch,conversationId,String(effect.destination),principal,new Date(this.now()*1000).toISOString());
    // Capture accumulation at enqueue, not only when a worker happens to poll.
    // The frozen task permission is still rechecked at actual send time.
    const settings=this.db.prepare('SELECT delivery_policy_json FROM wb_task_notification_settings WHERE task_id=? AND owner_id=?').get(scope.task_id,scope.owner_id) as {delivery_policy_json:string}|undefined;
    const quiet=settings?notificationQuietUntil(normalizeNotificationPolicy(JSON.parse(settings.delivery_policy_json)),this.now()):null;
    if(quiet){
      this.db.prepare('INSERT OR IGNORE INTO wb_task_notification_quiet_queue VALUES(?,?)').run(effectId,quiet);
      this.db.prepare('INSERT OR IGNORE INTO wb_task_notification_deferrals VALUES(?,?)').run(effectId,quiet);
      this.db.prepare("UPDATE ga_channel_deliveries SET last_reason_code='TASK_NOTIFICATION_QUIET_HOURS' WHERE effect_id=?").run(effectId);
    }
  }

  /** Checks immediately before each provider call. Already sent effects recover
   * receipts even after revocation; they must never be sent again. */
  authorizeSend(effectId:string,generation:number):boolean{
    return withImmediateTransaction(this.db,()=>{
      const effect=this.get(effectId);
      if(effect.status!=='sending'||Number(effect.generation)!==generation)throw new Error('delivery_lease_lost');
      const members=this.digestMembers(effectId);
      if(members.length&&members.some(member=>member.status!=='sending'||Number(member.generation)!==Number(member.digest_generation)))throw new Error('delivery_lease_lost');
      const subjects=members.length?members:[effect];
      if(subjects.some(member=>member.lease_expires_at===null||Number(member.lease_expires_at)<=this.now())){
        for(const member of subjects)this.db.prepare(`UPDATE ga_channel_deliveries SET status='outcome_unknown',last_reason_code='PROVIDER_SEND_STATE_AMBIGUOUS',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND generation=? AND status='sending'`)
          .run(new Date(this.now()*1000).toISOString(),member.effect_id,Number(member.generation));
        return false;
      }
      if(effect.destination==='sms'&&!resolveTwilioSmsReplyContext(this.db,effectId)){
        const now=new Date(this.now()*1000).toISOString();
        for(const member of subjects){
          const changed=this.db.prepare(`UPDATE ga_channel_deliveries SET status=?,last_reason_code='SMS_REPLY_AUTHORITY_INVALID',
            lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND generation=? AND status='sending'`)
            .run(member.provider_receipt_json?'outcome_unknown':'cancelled',now,member.effect_id,
              Number(member.digest_generation??member.generation)).changes;
          if(changed!==1)throw new Error('delivery_lease_lost');
        }
        return false;
      }
      const historical=subjects.map(member=>({member,check:historicalFinalSendCheck(this.db,member)}));
      if(historical.some(item=>item.check?.allowed===false)){
        for(const {member,check} of historical)this.db.prepare("UPDATE ga_channel_deliveries SET status=?,last_reason_code='HISTORICAL_FINAL_AUTHORITY_REVOKED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND generation=? AND status='sending'")
          .run(check?.uncertain||member.provider_receipt_json?'outcome_unknown':'cancelled',new Date(this.now()*1000).toISOString(),member.effect_id,Number(member.generation));
        return false;
      }
      if(effect.destination==='slack'&&effect.artifact_ref!==null){
        if(this.slackArtifactAuthorized(effect))return true;
        this.db.prepare("UPDATE ga_channel_deliveries SET status=?,last_reason_code='SLACK_ARTIFACT_AUTHORIZATION_REVOKED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND generation=? AND status='sending'")
          .run(effect.provider_receipt_json?'outcome_unknown':'cancelled',new Date(this.now()*1000).toISOString(),effectId,generation);
        return false;
      }
      if(effect.destination==='slack'){
        const authorized=this.db.prepare(`SELECT 1 FROM ga_channel_deliveries e
          JOIN ga_runs r ON r.id=e.run_id
          JOIN ga_conversations c ON c.id=r.conversation_id
          JOIN ga_messages m ON m.id=e.message_id AND m.run_id=r.id AND m.conversation_id=c.id AND m.role='assistant'
          JOIN ga_channel_message_events source ON source.channel='slack' AND source.run_id=r.id
            AND source.conversation_id=c.id AND source.message_id=r.input_message_id AND source.principal=e.recipient
          JOIN ga_channel_threads thread ON thread.channel='slack' AND thread.principal=e.recipient
            AND thread.provider_thread_id=source.provider_thread_id AND thread.conversation_id=c.id
            AND thread.channel_binding_id=source.channel_binding_id AND thread.binding_version=source.binding_version
          JOIN ga_owner_channel_bindings binding ON binding.channel_binding_id=source.channel_binding_id
            AND binding.channel='slack' AND binding.principal=e.recipient AND binding.owner_id=c.owner_id
            AND binding.version=source.binding_version AND binding.status='verified'
          WHERE e.effect_id=? AND e.destination='slack' AND e.artifact_ref IS NULL
            AND json_extract(e.payload_json,'$.kind')='text'
            AND (SELECT count(*) FROM ga_channel_message_events other
              WHERE other.channel='slack' AND other.run_id=r.id)=1`).get(effectId);
        if(authorized)return true;
        this.db.prepare("UPDATE ga_channel_deliveries SET status=?,last_reason_code='SLACK_REPLY_AUTHORIZATION_REVOKED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND generation=? AND status='sending'")
          .run(effect.provider_receipt_json?'outcome_unknown':'cancelled',new Date(this.now()*1000).toISOString(),effectId,generation);
        return false;
      }
      if(members.length){
        if(members.every(member=>this.taskSendPermitted(member)))return true;
        const reason=members.some(member=>hostDeliverySourceResolved(this.db,member)||signalDeliverySourceResolved(this.db,member,new Date(this.now()*1000).toISOString()))?'TASK_NOTIFICATION_SOURCE_RESOLVED':undefined;
        for(const member of members)this.rejectTaskDelivery(member.effect_id,Number(member.generation),reason);
        return false;
      }
      if(effect.destination==='mattermost'){
        if(this.taskSendPermitted(effect))return true;
        this.rejectTaskDelivery(effectId,generation);return false;
      }
      const reply=replyDeliveryCheck(this.db,effect,this.now);
      if(reply!==undefined){
        if(reply.allowed)return true;
        if(reply.not_before!==null){
          this.db.prepare('INSERT INTO wb_task_notification_deferrals VALUES(?,?) ON CONFLICT(effect_id) DO UPDATE SET not_before=excluded.not_before').run(effectId,reply.not_before);
          this.db.prepare("UPDATE ga_channel_deliveries SET status='pending',last_reason_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND generation=? AND status='sending'").run(reply.reason,new Date(this.now()*1000).toISOString(),effectId,generation);
        }else this.rejectTaskDelivery(effectId,generation,reply.reason??'REPLY_DELIVERY_REVOKED');
        return false;
      }
      const host=hostDeliveryAuthorized(this.db,effect);
      if(host!==undefined){
        if(host)return this.reserveTaskNotification(effectId,generation);
        this.rejectTaskDelivery(effectId,generation);return false;
      }
      const hasTaskTables=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name='wb_task_run_occurrences'").get();
      if(!hasTaskTables||!this.db.prepare('SELECT 1 FROM wb_task_run_occurrences WHERE run_id=?').get(String(effect.run_id)))return true;
      if(this.taskSendPermitted(effect))return this.reserveTaskNotification(effectId,generation);
      this.rejectTaskDelivery(effectId,generation);return false;
    });
  }

  recordSmsAuthorizationRejected(effectId:string,generation:number):void{
    withImmediateTransaction(this.db,()=>{
      const effect=this.get(effectId);
      if(Number(effect.generation)!==generation)throw new Error('delivery_lease_lost');
      const members=this.digestMembers(effectId);
      for(const member of members.length?members:[effect]){
        const memberGeneration=Number(member.digest_generation??member.generation);
        const changed=this.db.prepare(`UPDATE ga_channel_deliveries SET status=?,last_reason_code='SMS_REPLY_AUTHORITY_INVALID',
          lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND generation=? AND status='sending'`)
          .run(member.provider_receipt_json?'outcome_unknown':'cancelled',new Date(this.now()*1000).toISOString(),
            member.effect_id,memberGeneration).changes;
        if(changed!==1)throw new Error('delivery_lease_lost');
      }
    });
  }

  /** Re-prove the pinned bytes and effect authorization under one send preflight transaction. */
  authorizePinnedArtifactSend(effectId: string, generation: number, artifacts: ArtifactService) {
    return withImmediateTransaction(this.db, () => {
      const effect=this.get(effectId);
      if(effect.destination==='slack'&&effect.artifact_ref!==null)return this.proveSlackPinnedArtifact(effect,generation,artifacts);
      const proof = provePinnedChannelArtifact(this.db, this, artifacts, effectId);
      if (proof.generation !== generation) throw new Error('delivery_lease_lost');
      if (!this.authorizeSend(effectId, generation)) return null;
      return proof;
    });
  }

  private taskSendPermitted(effect:Record<string,any>):boolean {
      const artifact=effect.artifact_ref!==null;
      if(artifact&&!['wecom','mattermost'].includes(String(effect.destination)))return false;
      if(effect.destination==='mattermost'&&!this.db.prepare('SELECT 1 FROM wb_task_notification_grants WHERE effect_id=?').get(String(effect.effect_id)))return false;
      if(!artifact&&effect.destination!=='mattermost'){
        const host=hostDeliveryAuthorized(this.db,effect);if(host!==undefined)return host;
        const signal=signalDeliveryAuthorized(this.db,effect,new Date(this.now()*1000).toISOString());
        if(signal!==undefined)return signal;
      }
      const hasAuthorization=this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('wb_task_delivery_authorizations','wb_task_finalizations')").get() as {n:number};
      const permitted=hasAuthorization.n===2&&this.db.prepare(`SELECT 1 FROM wb_task_delivery_authorizations d
        JOIN wb_persistent_tasks t ON t.task_id=d.task_id AND t.owner_id=d.owner_id AND t.status IN ('active','budget_exhausted') AND t.generation=d.generation AND t.version=d.task_version
        JOIN wb_agents a ON a.agent_id=d.agent_id AND a.owner_id=d.owner_id AND a.status='active' AND a.capability_epoch=d.epoch
        JOIN ga_conversations c ON c.id=d.conversation_id AND c.owner_id=d.owner_id
        JOIN ga_runs r ON r.id=? AND r.conversation_id=c.id
        JOIN wb_task_finalizations f ON f.run_id=r.id AND f.owner_id=d.owner_id AND f.occurrence_id=d.occurrence_id AND f.message_id=?
        LEFT JOIN ga_channel_bindings b ON b.channel=d.channel AND b.principal=d.principal AND b.conversation_id=c.id
        LEFT JOIN wb_task_notification_grants g ON g.effect_id=d.effect_id
        LEFT JOIN ga_owner_channel_bindings ob ON ob.channel_binding_id=g.channel_binding_id AND ob.owner_id=d.owner_id
        LEFT JOIN wb_task_notification_settings n ON n.task_id=d.task_id AND n.owner_id=d.owner_id
        WHERE d.effect_id=? AND d.channel=? AND d.principal=? AND (
         (g.effect_id IS NULL AND b.principal IS NOT NULL) OR
         (g.owner_id=d.owner_id AND g.task_id=d.task_id AND ob.status='verified' AND ob.version=g.binding_version
          AND ob.channel=d.channel AND ob.principal=d.principal AND n.version=g.settings_version))`).get(String(effect.run_id),String(effect.message_id),String(effect.effect_id),String(effect.destination),String(effect.recipient));
      if(!permitted)return false;
      if(!artifact)return true;
      const grant=this.db.prepare(`SELECT g.owner_id,g.task_id,g.channel_binding_id,g.binding_version,g.settings_version,
          d.owner_id AS authorized_owner,d.task_id AS authorized_task,
          n.version,n.bindings_json,n.events_json,ob.status,ob.version AS current_binding_version,ob.channel,ob.principal
        FROM wb_task_notification_grants g
        JOIN wb_task_delivery_authorizations d ON d.effect_id=g.effect_id
        JOIN wb_task_notification_settings n ON n.task_id=g.task_id AND n.owner_id=g.owner_id
        JOIN ga_owner_channel_bindings ob ON ob.channel_binding_id=g.channel_binding_id AND ob.owner_id=g.owner_id
        WHERE g.effect_id=?`).get(String(effect.effect_id)) as Record<string,any>|undefined;
      if(!grant||grant.owner_id!==grant.authorized_owner||grant.task_id!==grant.authorized_task
        ||grant.settings_version!==grant.version||grant.binding_version!==grant.current_binding_version
        ||grant.status!=='verified'||!['wecom','mattermost'].includes(String(grant.channel))||grant.channel!==effect.destination
        ||grant.principal!==effect.recipient)return false;
      try{
        const bindings=JSON.parse(String(grant.bindings_json)) as Array<{channel_binding_id:string;version:number;artifact_delivery?:unknown}>;
        const events=JSON.parse(String(grant.events_json)) as unknown;
        return Array.isArray(events)&&events.includes('completed')&&Array.isArray(bindings)
          &&bindings.some(binding=>binding.channel_binding_id===grant.channel_binding_id
            &&binding.version===grant.binding_version&&binding.artifact_delivery===true);
      }catch{return false;}
  }

  mattermostDeliveryTarget(effectId:string,generation:number,configuredAccount:MattermostOwnerAccount,afterProviderSideEffect=false):MattermostDeliveryTarget{
    const effect=this.get(effectId);
    if(effect.destination!=='mattermost'||effect.status!=='sending'||Number(effect.generation)!==generation
      ||effect.lease_expires_at===null||Number(effect.lease_expires_at)<=this.now()
      ||(afterProviderSideEffect?!this.taskSendPermitted(effect):!this.authorizeSend(effectId,generation)))throw new Error('mattermost_delivery_authority_invalid');
    return withImmediateTransaction(this.db,()=>{
      const row=this.db.prepare(`SELECT d.owner_id,d.task_id,d.conversation_id,d.channel,d.principal,d.generation,d.task_version,d.agent_id,d.epoch,
          t.generation AS current_generation,t.version AS current_task_version,a.capability_epoch AS current_epoch,
          f.message_id AS final_message_id,m.role,m.status AS message_status,
          g.channel_binding_id,g.binding_version,g.settings_version,n.version AS current_settings_version,n.bindings_json,n.events_json,
          ob.channel_binding_id AS current_binding_id,ob.owner_id AS binding_owner,ob.channel AS binding_channel,
          ob.principal AS binding_principal,ob.status AS binding_status,ob.version AS current_binding_version,
          s.instance,s.bot_user_id,s.provider_thread_id
        FROM ga_channel_deliveries e
        JOIN wb_task_delivery_authorizations d ON d.effect_id=e.effect_id
        JOIN wb_persistent_tasks t ON t.task_id=d.task_id AND t.owner_id=d.owner_id AND t.status IN ('active','budget_exhausted') AND t.generation=d.generation AND t.version=d.task_version
        JOIN wb_agents a ON a.agent_id=d.agent_id AND a.owner_id=d.owner_id AND a.status='active' AND a.capability_epoch=d.epoch
        JOIN ga_conversations c ON c.id=d.conversation_id AND c.owner_id=d.owner_id
        JOIN ga_runs r ON r.id=e.run_id AND r.conversation_id=c.id
        JOIN ga_messages m ON m.id=e.message_id AND m.run_id=r.id AND m.conversation_id=c.id AND m.role='assistant' AND m.status='complete'
        JOIN wb_task_finalizations f ON f.run_id=r.id AND f.owner_id=d.owner_id AND f.occurrence_id=d.occurrence_id AND f.message_id=m.id
        JOIN wb_task_notification_grants g ON g.effect_id=e.effect_id AND g.owner_id=d.owner_id AND g.task_id=d.task_id
        JOIN wb_task_notification_settings n ON n.task_id=d.task_id AND n.owner_id=d.owner_id
        JOIN ga_owner_channel_bindings ob ON ob.channel_binding_id=g.channel_binding_id AND ob.owner_id=d.owner_id
        JOIN ga_mattermost_binding_scopes s ON s.channel_binding_id=ob.channel_binding_id AND s.owner_id=d.owner_id
        WHERE e.effect_id=? AND e.run_id=? AND e.message_id=? AND e.status='sending' AND e.generation=?
          AND e.destination='mattermost' AND e.recipient=d.principal AND d.channel='mattermost'
          AND g.channel_binding_id IS NOT NULL AND ob.channel='mattermost' AND ob.principal=d.principal
          AND ob.status='verified' AND ob.version=g.binding_version AND n.version=g.settings_version
          AND s.principal=d.principal`).get(effectId,effect.run_id,effect.message_id,generation) as Record<string,any>|undefined;
      if(!row||Number(row.generation)!==Number(row.current_generation)||Number(row.task_version)!==Number(row.current_task_version)
        ||row.epoch!==row.current_epoch||row.message_status!=='complete'||row.final_message_id!==effect.message_id
        ||row.binding_owner!==row.owner_id||row.binding_channel!=='mattermost'||row.binding_status!=='verified'
        ||Number(row.binding_version)!==Number(row.current_binding_version))throw new Error('mattermost_delivery_authority_invalid');
      try{
        const settings=JSON.parse(String(row.bindings_json)) as Array<{channel_binding_id:string;version:number;artifact_delivery?:unknown}>;
        const events=JSON.parse(String(row.events_json)) as unknown;
        const saved=settings.find(binding=>binding.channel_binding_id===row.channel_binding_id);
        if(!Array.isArray(events)||!events.includes('completed')||!saved||saved.version!==row.binding_version
          ||effect.artifact_ref!==null&&saved.artifact_delivery!==true)throw new Error('mattermost_delivery_authority_invalid');
        const binding={channel_binding_id:String(row.current_binding_id),owner_id:String(row.binding_owner),principal:String(row.binding_principal),version:Number(row.current_binding_version)};
        const scope=requireMattermostBindingThread(this.db,binding,String(row.provider_thread_id));
        const identity=requireMattermostConfiguredAccount(mattermostOwnerAccount(configuredAccount),String(row.principal),String(row.provider_thread_id));
        if(identity.channelId!==scope.channelId||identity.rootId!==''||identity.instance!==row.instance||identity.botUserId!==row.bot_user_id)
          throw new Error('mattermost_delivery_authority_invalid');
        return Object.freeze({effect_id:effectId,generation,owner_id:String(row.owner_id),channel_binding_id:String(row.channel_binding_id),
          binding_version:Number(row.binding_version),principal:String(row.principal),instance:String(row.instance),bot_user_id:String(row.bot_user_id),
          channel_id:identity.channelId,root_id:'' as const});
      }catch(error){
        if(error instanceof Error&&error.message==='mattermost_delivery_authority_invalid')throw error;
        throw new Error('mattermost_delivery_authority_invalid');
      }
    });
  }

  private slackArtifactAuthorized(effect:Record<string,any>):boolean {
    const pin=decodeSlackArtifactRef(String(effect.artifact_ref??''));if(!pin)return false;
    return !!this.db.prepare(`SELECT 1 FROM ga_channel_deliveries e
      JOIN ga_runs r ON r.id=e.run_id JOIN ga_conversations c ON c.id=r.conversation_id
      JOIN ga_messages m ON m.id=e.message_id AND m.run_id=r.id AND m.conversation_id=c.id AND m.role='assistant' AND m.status='complete'
      JOIN ga_run_artifacts ra ON ra.run_id=r.id AND ra.artifact_id=? AND ra.version=?
      JOIN ga_artifacts a ON a.id=ra.artifact_id AND a.conversation_id=c.id AND a.owner_id=c.owner_id
      JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=ra.version
      JOIN ga_channel_message_events source ON source.channel='slack' AND source.run_id=r.id
        AND source.conversation_id=c.id AND source.message_id=r.input_message_id AND source.principal=e.recipient
      JOIN ga_channel_threads thread ON thread.channel='slack' AND thread.principal=e.recipient
        AND thread.provider_thread_id=source.provider_thread_id AND thread.conversation_id=c.id
        AND thread.channel_binding_id=source.channel_binding_id AND thread.binding_version=source.binding_version
      JOIN ga_owner_channel_bindings binding ON binding.channel_binding_id=source.channel_binding_id
        AND binding.channel='slack' AND binding.principal=e.recipient AND binding.owner_id=c.owner_id
        AND binding.version=source.binding_version AND binding.status='verified'
      JOIN ga_slack_artifact_delivery_pins pin ON pin.effect_id=e.effect_id AND pin.owner_id=c.owner_id
        AND pin.conversation_id=c.id AND pin.source_run_id=r.id AND pin.source_message_id=r.input_message_id
        AND pin.recipient=e.recipient AND pin.channel_binding_id=source.channel_binding_id
        AND pin.binding_version=source.binding_version AND pin.artifact_id=a.id AND pin.artifact_version=v.version
        AND pin.server_path=v.server_path AND pin.sha256=v.sha256 AND pin.size_bytes=v.size_bytes
        AND pin.display_name=json_extract(v.metadata_json,'$.file_name')
      WHERE e.effect_id=? AND e.destination='slack' AND e.artifact_ref=?
        AND json_extract(e.payload_json,'$.kind')='artifact'
        AND (SELECT count(*) FROM ga_channel_message_events other WHERE other.channel='slack' AND other.run_id=r.id)=1
        AND EXISTS(SELECT 1 FROM json_each(json_extract(m.content_json,'$.attachments')) attached WHERE attached.value=a.id)
        AND json_extract(v.metadata_json,'$.status')='ready' AND NOT EXISTS(SELECT 1 FROM ga_artifact_parts p WHERE p.artifact_id=a.id)`)
      .get(pin.artifactId,pin.version,String(effect.effect_id),String(effect.artifact_ref));
  }

  private proveSlackPinnedArtifact(effect:Record<string,any>,generation:number,artifacts:ArtifactService){
    if(!this.db.isTransaction||!artifacts?.usesDatabase(this.db)||effect.status!=='sending'
      ||Number(effect.generation)!==generation||Number(effect.file_claim_protocol_generation)!==generation
      ||effect.lease_expires_at===null||Number(effect.lease_expires_at)<=this.now()
      ||!this.slackArtifactAuthorized(effect))throw new Error('channel_delivery_artifact_authority_missing');
    const pinRef=decodeSlackArtifactRef(String(effect.artifact_ref));if(!pinRef)throw new Error('channel_delivery_artifact_pin_invalid');
    const pin=this.db.prepare('SELECT * FROM ga_slack_artifact_delivery_pins WHERE effect_id=?').get(effect.effect_id) as Record<string,any>|undefined;
    let payload:Record<string,any>;
    try{payload=JSON.parse(String(effect.payload_json));}catch{throw new Error('channel_delivery_artifact_pin_invalid');}
    const manifest=payload?.manifest;
    if(!pin||payload?.kind!=='artifact'||payload.schema_version!==1||payload.artifact_id!==pinRef.artifactId
      ||Number(payload.version)!==pinRef.version||pin.artifact_id!==pinRef.artifactId||Number(pin.artifact_version)!==pinRef.version
      ||payload.owner_id!==pin.owner_id||payload.conversation_id!==pin.conversation_id||!Array.isArray(manifest)
      ||manifest.length!==1||payload.manifest_sha256!==sha256(canonicalJson(manifest))
      ||payload.sha256!==pin.sha256||Number(payload.size_bytes)!==Number(pin.size_bytes))throw new Error('channel_delivery_artifact_pin_invalid');
    const part=manifest[0];
    if(!part||part.part_index!==1||part.display_name!==pin.display_name||part.sha256!==pin.sha256
      ||Number(part.size_bytes)!==Number(pin.size_bytes)||typeof part.mime_type!=='string')throw new Error('channel_delivery_artifact_pin_invalid');
    let version:Record<string,any>,metadata:Record<string,any>,content:Buffer;
    try{
      version=artifacts.download(pinRef.artifactId,String(pin.owner_id),pinRef.version) as Record<string,any>;
      metadata=JSON.parse(String(version.metadata_json));content=readFileSync(String(version.server_path));
    }catch{throw new Error('channel_artifact_content_mismatch');}
    if(version.server_path!==pin.server_path||Number(version.version)!==pinRef.version||version.sha256!==pin.sha256
      ||Number(version.size_bytes)!==Number(pin.size_bytes)||version.mime_type!==part.mime_type
      ||metadata.status!=='ready'||metadata.file_name!==pin.display_name||content.length!==Number(pin.size_bytes)
      ||content.length>MAX_SLACK_ARTIFACT_BYTES||sha256(content)!==pin.sha256)throw new Error('channel_artifact_content_mismatch');
    return Object.freeze({effect_id:String(effect.effect_id),generation,channel_binding_id:String(pin.channel_binding_id),
      binding_version:Number(pin.binding_version),owner_id:String(pin.owner_id),conversation_id:String(pin.conversation_id),
      artifact_id:pinRef.artifactId,version:pinRef.version,sha256:String(pin.sha256),size_bytes:Number(pin.size_bytes),
      manifest_sha256:String(payload.manifest_sha256),parts:Object.freeze([Object.freeze({...part,content:Buffer.from(content)})])});
  }

  private rejectTaskDelivery(effectId:string,generation:number,groupReason?:string):void {
      const effect=this.get(effectId);
      const reason=groupReason??(hostDeliverySourceResolved(this.db,effect)||signalDeliverySourceResolved(this.db,effect,new Date(this.now()*1000).toISOString())?'TASK_NOTIFICATION_SOURCE_RESOLVED':'TASK_DELIVERY_AUTHORIZATION_REVOKED');
      this.db.prepare("UPDATE ga_channel_deliveries SET status=?,last_reason_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND generation=? AND status='sending'")
        .run(effect.provider_receipt_json?'outcome_unknown':'cancelled',reason,new Date(this.now()*1000).toISOString(),effectId,generation);
  }

  private digestMembers(effectId:string):Record<string,any>[] {
    return this.db.prepare(`SELECT e.*,m.generation AS digest_generation FROM wb_task_notification_digest_members source
      JOIN wb_task_notification_digest_members m ON m.digest_id=source.digest_id JOIN ga_channel_deliveries e ON e.effect_id=m.effect_id
      WHERE source.effect_id=? ORDER BY m.ordinal`).all(effectId) as Record<string,any>[];
  }

  /** Freeze a bounded, non-model digest. Original effects and task results are
   * retained; membership and shared receipt are committed atomically. */
  prepareTextDelivery(effectId:string,generation:number):string {
    return withImmediateTransaction(this.db,()=>{
      const effect=this.get(effectId);
      if(effect.status!=='sending'||Number(effect.generation)!==generation)throw new Error('delivery_lease_lost');
      const existing=this.db.prepare(`SELECT d.* FROM wb_task_notification_digest_members m JOIN wb_task_notification_digests d ON d.digest_id=m.digest_id WHERE m.effect_id=?`).get(effectId) as Record<string,any>|undefined;
      if(existing){
        const summary=resolveNotificationDigestArchive(this.db,existing);
        if(createHash('sha256').update(summary.payload_text).digest('hex')!==summary.payload_sha256)throw new Error('notification_digest_corrupt');
        return String(summary.payload_text);
      }
      const payload=effect.payload_json?JSON.parse(effect.payload_json):null;
      if(payload?.kind!=='text'||typeof payload.text!=='string'||!payload.text.trim())throw new Error('delivery_text_invalid');
      // A reviewed reply is one exact payload, never a notification digest.
      if(String(effect.effect_id).startsWith('reply-delivery-'))return payload.text;
      if(effect.run_id===null&&hostDeliveryAuthorized(this.db,effect)!==true)throw new Error('task_delivery_authorization_invalid');
      if(!this.db.prepare('SELECT 1 FROM wb_task_notification_quiet_queue WHERE effect_id=? AND quiet_end<=?').get(effectId,this.now()))return payload.text.trim();
      let source=this.db.prepare(`SELECT d.*,t.title,n.delivery_policy_json,g.channel_binding_id,g.binding_version FROM wb_task_delivery_authorizations d
        JOIN wb_persistent_tasks t ON t.task_id=d.task_id LEFT JOIN wb_task_notification_settings n ON n.task_id=d.task_id
        LEFT JOIN wb_task_notification_grants g ON g.effect_id=d.effect_id WHERE d.effect_id=?`).get(effectId) as Record<string,any>|undefined;
      const hasHostNotifications=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_host_notification_authorizations'").get();
      if(!source&&hasHostNotifications)source=this.db.prepare(`SELECT fault.owner_id,h.channel,h.principal,t.title,n.delivery_policy_json,h.binding_id AS channel_binding_id,h.binding_version
        FROM wb_task_host_notification_authorizations h JOIN wb_task_monitor_failure_episodes fault ON fault.episode_id=h.episode_id
        JOIN wb_persistent_tasks t ON t.task_id=fault.task_id JOIN wb_task_notification_settings n ON n.task_id=t.task_id AND n.owner_id=fault.owner_id WHERE h.effect_id=?`).get(effectId) as Record<string,any>|undefined;
      if(!source||!this.taskSendPermitted(effect))throw new Error('task_delivery_authorization_invalid');
      const candidates=this.db.prepare(`SELECT e.*,t.title,n.delivery_policy_json,g.channel_binding_id,g.binding_version FROM ga_channel_deliveries e
        JOIN wb_task_notification_quiet_queue q ON q.effect_id=e.effect_id AND q.quiet_end<=?
        JOIN wb_task_delivery_authorizations d ON d.effect_id=e.effect_id
        JOIN wb_persistent_tasks t ON t.task_id=d.task_id
        LEFT JOIN wb_task_notification_settings n ON n.task_id=d.task_id
        LEFT JOIN wb_task_notification_grants g ON g.effect_id=d.effect_id
        LEFT JOIN wb_task_notification_deferrals wait ON wait.effect_id=e.effect_id
        LEFT JOIN wb_task_notification_digest_members m ON m.effect_id=e.effect_id
        WHERE e.status='pending' AND e.provider_receipt_json IS NULL AND (e.lease_owner IS NULL OR e.lease_expires_at<=?)
         AND (wait.not_before IS NULL OR wait.not_before<=?) AND m.effect_id IS NULL
         AND d.owner_id=? AND d.channel=? AND d.principal=?
        ORDER BY e.created_at,e.effect_id LIMIT 50`).all(this.now(),this.now(),this.now(),source.owner_id,source.channel,source.principal) as Record<string,any>[];
      if(hasHostNotifications)candidates.push(...this.db.prepare(`SELECT e.*,t.title,n.delivery_policy_json,h.binding_id AS channel_binding_id,h.binding_version
        FROM ga_channel_deliveries e JOIN wb_task_notification_quiet_queue q ON q.effect_id=e.effect_id AND q.quiet_end<=?
        JOIN wb_task_host_notification_authorizations h ON h.effect_id=e.effect_id
        JOIN wb_task_monitor_failure_episodes fault ON fault.episode_id=h.episode_id JOIN wb_persistent_tasks t ON t.task_id=fault.task_id
        JOIN wb_task_notification_settings n ON n.task_id=t.task_id AND n.owner_id=fault.owner_id
        LEFT JOIN wb_task_notification_deferrals wait ON wait.effect_id=e.effect_id LEFT JOIN wb_task_notification_digest_members m ON m.effect_id=e.effect_id
        WHERE e.status='pending' AND e.provider_receipt_json IS NULL AND (e.lease_owner IS NULL OR e.lease_expires_at<=?)
         AND (wait.not_before IS NULL OR wait.not_before<=?) AND m.effect_id IS NULL AND fault.owner_id=? AND h.channel=? AND h.principal=?
        ORDER BY e.created_at,e.effect_id LIMIT 50`).all(this.now(),this.now(),this.now(),source.owner_id,source.channel,source.principal) as Record<string,any>[]);
      candidates.sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||String(a.effect_id).localeCompare(String(b.effect_id)));
      const included:Record<string,any>[]=[{...effect,title:source.title}];
      for(const candidate of candidates){
        if(candidate.effect_id===effectId||candidate.delivery_policy_json!==source.delivery_policy_json||candidate.channel_binding_id!==source.channel_binding_id||candidate.binding_version!==source.binding_version||!this.taskSendPermitted(candidate))continue;
        const data=candidate.payload_json?JSON.parse(candidate.payload_json):null;if(data?.kind!=='text'||typeof data.text!=='string'||!data.text.trim())continue;
        included.push(candidate);if(included.length===5)break;
      }
      if(included.length===1)return payload.text.trim();
      const excerpt=(text:string,bytes:number)=>{let result='';for(const char of text.replace(/\s+/g,' ').trim()){if(Buffer.byteLength(result+char)>bytes)return result+'…';result+=char;}return result;};
      const text=`安静时段有 ${included.length} 条任务提醒。以下为结果摘要，完整结果可在工作台查看。\n\n`+included.map((item,index)=>`${index+1}. ${excerpt(String(item.title),80)}\n${excerpt(JSON.parse(item.payload_json).text,200)}`).join('\n\n');
      if(Buffer.byteLength(text)>1800)throw new Error('notification_digest_too_large');
      const digestId='digest-'+createHash('sha256').update(JSON.stringify(included.map(item=>item.effect_id))).digest('hex').slice(0,32);
      this.db.prepare('INSERT INTO wb_task_notification_digests VALUES(?,?,?,?,?)').run(digestId,effectId,text,createHash('sha256').update(text).digest('hex'),new Date(this.now()*1000).toISOString());
      included.forEach((member,index)=>{
        const memberGeneration=index===0?generation:Number(member.generation)+1;
        if(index!==0)this.db.prepare(`UPDATE ga_channel_deliveries SET status='sending',generation=?,lease_owner=?,lease_expires_at=?,updated_at=? WHERE effect_id=? AND status='pending'`).run(memberGeneration,effect.lease_owner,effect.lease_expires_at,new Date(this.now()*1000).toISOString(),member.effect_id);
        this.db.prepare('INSERT INTO wb_task_notification_digest_members VALUES(?,?,?,?)').run(member.effect_id,digestId,memberGeneration,index);
      });
      return text;
    });
  }

  private reserveTaskNotification(effectId:string,generation:number):boolean {
    // Called inside the same Immediate transaction as permission validation.
    // This is a provider-attempt reservation, not proof of delivery. A crash or
    // ambiguous send keeps its slot, so another worker cannot burst past quota.
    if(this.db.prepare('SELECT 1 FROM wb_task_notification_send_reservations WHERE effect_id=?').get(effectId))return true;
    let auth=this.db.prepare(`SELECT d.owner_id,d.channel,d.principal,n.delivery_policy_json FROM wb_task_delivery_authorizations d
      LEFT JOIN wb_task_notification_settings n ON n.task_id=d.task_id AND n.owner_id=d.owner_id WHERE d.effect_id=?`).get(effectId) as Record<string,any>;
    if(!auth)auth=this.db.prepare(`SELECT e.owner_id,h.channel,h.principal,n.delivery_policy_json FROM wb_task_host_notification_authorizations h
      JOIN wb_task_monitor_failure_episodes e ON e.episode_id=h.episode_id JOIN wb_task_notification_settings n ON n.task_id=e.task_id AND n.owner_id=e.owner_id WHERE h.effect_id=?`).get(effectId) as Record<string,any>;
    if(!auth)throw new Error('task_delivery_authorization_invalid');
    const policy=auth.delivery_policy_json?normalizeNotificationPolicy(JSON.parse(auth.delivery_policy_json)):defaultNotificationPolicy;
    const current=this.now(),quiet=notificationQuietUntil(policy,current);
    const bucket=createHash('sha256').update(JSON.stringify([auth.owner_id,auth.channel,auth.principal])).digest('hex');
    const rows=this.db.prepare('SELECT reserved_at FROM wb_task_notification_send_reservations WHERE bucket_hash=? AND reserved_at>? ORDER BY reserved_at').all(bucket,current-86400) as Array<{reserved_at:number}>;
    const last=rows.at(-1)?.reserved_at;
    const rate=Math.max(last===undefined?current:last+policy.min_interval_seconds,rows.length>=policy.max_per_24_hours?rows[rows.length-policy.max_per_24_hours]!.reserved_at+86400:current);
    const until=Math.max(quiet??current,rate);
    if(until>current){
      if(quiet)this.db.prepare('INSERT OR IGNORE INTO wb_task_notification_quiet_queue VALUES(?,?)').run(effectId,quiet);
      this.db.prepare('INSERT INTO wb_task_notification_deferrals VALUES(?,?) ON CONFLICT(effect_id) DO UPDATE SET not_before=excluded.not_before').run(effectId,until);
      this.db.prepare(`UPDATE ga_channel_deliveries SET status='pending',last_reason_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND generation=? AND status='sending'`)
        .run(quiet?'TASK_NOTIFICATION_QUIET_HOURS':'TASK_NOTIFICATION_RATE_LIMIT',new Date(current*1000).toISOString(),effectId,generation);
      return false;
    }
    this.db.prepare('INSERT INTO wb_task_notification_send_reservations VALUES(?,?,?)').run(effectId,bucket,current);
    this.db.prepare('DELETE FROM wb_task_notification_deferrals WHERE effect_id=?').run(effectId);
    this.db.prepare('UPDATE ga_channel_deliveries SET last_reason_code=NULL WHERE effect_id=?').run(effectId);
    return true;
  }

  enqueuePinnedArtifact(input: PinnedArtifactDeliveryInput, artifacts: ArtifactService): Record<string, any> {
    if(input?.artifactId&&['email','webpush','weixin'].includes(input.destination))throw new Error('channel_delivery_artifact_unsupported');
    if (!input || typeof input.runId !== 'string' || !input.runId.trim()
      || typeof input.messageId !== 'string' || !input.messageId.trim()
      || typeof input.recipient !== 'string' || !input.recipient.trim()
      || typeof input.ownerId !== 'string' || !input.ownerId.trim()
      || typeof input.artifactId !== 'string' || !input.artifactId.trim()
      || !Number.isSafeInteger(input.version) || input.version < 1
      || !['wecom','mattermost'].includes(input.destination)) {
      throw new Error('external_delivery_invalid');
    }
    if (!artifacts?.usesDatabase(this.db)) throw new Error('channel_authority_database_mismatch');
    return withImmediateTransaction(this.db, () => {
      const source = this.db.prepare(`SELECT a.kind,a.owner_id,a.conversation_id,v.sha256,v.size_bytes,v.mime_type,
          v.metadata_json,p.content_manifest_json
        FROM ga_artifacts a JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=?
        LEFT JOIN ga_artifact_producers p ON p.artifact_id=a.id AND p.version=v.version
        WHERE a.id=? AND a.owner_id=?`).get(input.version, input.artifactId, input.ownerId) as Record<string, any> | undefined;
      if (!source) throw new Error('artifact_not_found');
      let manifest: Array<Record<string, unknown>>;
      if (source.kind === 'task_output_file') {
        let metadata: Record<string, unknown>;
        try { metadata = JSON.parse(String(source.metadata_json)) as Record<string, unknown>; }
        catch { throw new Error('channel_delivery_artifact_pin_invalid'); }
        const displayName = metadata.file_name ?? metadata.filename ?? metadata.display_name;
        manifest = [{ part_index: 1, display_name: displayName, sha256: String(source.sha256),
          size_bytes: Number(source.size_bytes), mime_type: String(source.mime_type) }];
      } else if (source.kind === 'generated_document_group') {
        try { manifest = JSON.parse(String(source.content_manifest_json)) as Array<Record<string, unknown>>; }
        catch { throw new Error('channel_delivery_artifact_pin_invalid'); }
      } else {
        throw new Error('channel_delivery_artifact_unsupported');
      }
      const payload = { kind: 'artifact', schema_version: 1, owner_id: input.ownerId,
        conversation_id: String(source.conversation_id), artifact_id: input.artifactId, version: input.version,
        sha256: String(source.sha256), size_bytes: Number(source.size_bytes),
        manifest_sha256: sha256(canonicalJson(manifest)), manifest };
      const effectIdentity = JSON.stringify(['artifact-pin-v1', input.runId, input.messageId,
        input.destination, input.recipient, input.artifactId, sha256(canonicalJson(payload))]);
      const effectId = `delivery-${sha256(effectIdentity).slice(0, 32)}`;
      const now = new Date(this.now() * 1000).toISOString();
      this.db.prepare(`INSERT OR IGNORE INTO ga_channel_deliveries(
        effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(effectId, input.runId, input.messageId,
        input.destination, input.recipient, input.artifactId, JSON.stringify(payload), now, now);
      const existing = this.db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?')
        .get(effectId) as Record<string, any> | undefined;
      if (!existing || existing.run_id !== input.runId || existing.message_id !== input.messageId
        || existing.destination !== input.destination || existing.recipient !== input.recipient
        || existing.artifact_ref !== input.artifactId || existing.payload_json !== JSON.stringify(payload)) {
        throw new Error('delivery_identity_conflict');
      }
      if (existing.status === 'pending') {
        const proof = provePendingPinnedChannelArtifact(this.db, this, artifacts, effectId);
        if (proof.generation !== Number(existing.generation)) throw new Error('delivery_lease_lost');
      }
      return this.get(effectId);
    });
  }

  enqueuePinnedSlackArtifact(input:{runId:string;messageId:string;recipient:string;ownerId:string;artifactId:string;version:number}):Record<string,unknown>|null{
    if(typeof input?.runId!=='string'||!input.runId.trim()||typeof input.messageId!=='string'||!input.messageId.trim()
      ||typeof input.recipient!=='string'||!/^slack:[A-Za-z0-9._-]{1,80}:[A-Za-z0-9._-]{1,80}$/.test(input.recipient)
      ||typeof input.ownerId!=='string'||!input.ownerId.trim()||typeof input.artifactId!=='string'||!input.artifactId.trim()
      ||!Number.isSafeInteger(input.version)||input.version<1)throw new Error('slack_artifact_delivery_invalid');
    return withImmediateTransaction(this.db,()=>{
      const sources=this.db.prepare(`SELECT r.conversation_id,r.input_message_id,c.owner_id,e.channel_binding_id,e.binding_version
        FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
        JOIN ga_channel_message_events e ON e.channel='slack' AND e.run_id=r.id AND e.conversation_id=c.id
          AND e.message_id=r.input_message_id AND e.principal=?
        JOIN ga_channel_threads t ON t.channel='slack' AND t.principal=e.principal
          AND t.provider_thread_id=e.provider_thread_id AND t.conversation_id=c.id
          AND t.channel_binding_id=e.channel_binding_id AND t.binding_version=e.binding_version
        JOIN ga_owner_channel_bindings b ON b.channel_binding_id=e.channel_binding_id AND b.version=e.binding_version
          AND b.channel='slack' AND b.principal=e.principal AND b.owner_id=c.owner_id AND b.status='verified'
        JOIN ga_messages m ON m.id=? AND m.run_id=r.id AND m.conversation_id=c.id AND m.role='assistant' AND m.status='complete'
        JOIN ga_run_artifacts ra ON ra.run_id=r.id AND ra.artifact_id=? AND ra.version=?
        JOIN ga_artifacts a ON a.id=ra.artifact_id AND a.conversation_id=c.id AND a.owner_id=c.owner_id
        WHERE r.id=? AND c.owner_id=?
          AND EXISTS(SELECT 1 FROM json_each(json_extract(m.content_json,'$.attachments')) attached WHERE attached.value=a.id)
        LIMIT 2`).all(input.recipient,input.messageId,input.artifactId,input.version,input.runId,input.ownerId) as Array<Record<string,any>>;
      if(sources.length!==1)return null;
      const source=sources[0]!;
      const artifact=this.db.prepare(`SELECT a.id,v.server_path,v.sha256,v.size_bytes,v.mime_type,v.metadata_json FROM ga_artifacts a
        JOIN ga_artifact_versions v ON v.artifact_id=a.id WHERE a.id=? AND a.owner_id=? AND a.conversation_id=? AND v.version=?
          AND json_extract(v.metadata_json,'$.status')='ready'
          AND NOT EXISTS(SELECT 1 FROM ga_artifact_parts p WHERE p.artifact_id=a.id)`)
        .get(input.artifactId,input.ownerId,source.conversation_id,input.version) as Record<string,any>|undefined;
      if(!artifact||typeof artifact.server_path!=='string'||typeof artifact.sha256!=='string'||!/^[a-f0-9]{64}$/.test(artifact.sha256)
        ||!Number.isSafeInteger(Number(artifact.size_bytes))||Number(artifact.size_bytes)<1||Number(artifact.size_bytes)>MAX_SLACK_ARTIFACT_BYTES)
        throw new Error('slack_artifact_delivery_invalid');
      let metadata:Record<string,unknown>;
      try{metadata=JSON.parse(String(artifact.metadata_json)) as Record<string,unknown>;}catch{throw new Error('slack_artifact_delivery_invalid');}
      const displayName=metadata.file_name;
      if(typeof displayName!=='string'||!displayName.trim()||displayName.length>255||/[\\/\u0000-\u001f\u007f]/.test(displayName))
        throw new Error('slack_artifact_delivery_invalid');
      const manifest=[{part_index:1,display_name:displayName,sha256:String(artifact.sha256),size_bytes:Number(artifact.size_bytes),mime_type:String(artifact.mime_type)}];
      const payload={kind:'artifact',schema_version:1,owner_id:input.ownerId,conversation_id:String(source.conversation_id),
        artifact_id:input.artifactId,version:input.version,sha256:String(artifact.sha256),size_bytes:Number(artifact.size_bytes),
        manifest_sha256:sha256(canonicalJson(manifest)),manifest};
      const artifactRef=encodeSlackArtifactRef(input.artifactId,input.version),effectId=`delivery-${sha256(JSON.stringify([
        'slack-artifact-pin-v1',input.runId,input.messageId,input.recipient,artifactRef,sha256(canonicalJson(payload))])).slice(0,32)}`;
      const now=new Date(this.now()*1000).toISOString();
      this.db.prepare(`INSERT OR IGNORE INTO ga_channel_deliveries(
        effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(effectId,input.runId,input.messageId,'slack',input.recipient,artifactRef,JSON.stringify(payload),now,now);
      this.db.prepare('INSERT OR IGNORE INTO ga_slack_artifact_delivery_pins VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(effectId,input.ownerId,String(source.conversation_id),input.runId,String(source.input_message_id),input.recipient,
          String(source.channel_binding_id),Number(source.binding_version),input.artifactId,input.version,String(artifact.server_path),
          String(artifact.sha256),Number(artifact.size_bytes),displayName,now);
      const effect=this.get(effectId),pin=this.db.prepare('SELECT * FROM ga_slack_artifact_delivery_pins WHERE effect_id=?').get(effectId) as Record<string,any>|undefined;
      if(!pin||effect.run_id!==input.runId||effect.message_id!==input.messageId||effect.destination!=='slack'||effect.recipient!==input.recipient
        ||effect.artifact_ref!==artifactRef||effect.payload_json!==JSON.stringify(payload)||pin.owner_id!==input.ownerId
        ||pin.conversation_id!==source.conversation_id||pin.source_run_id!==input.runId||pin.source_message_id!==source.input_message_id
        ||pin.recipient!==input.recipient||pin.channel_binding_id!==source.channel_binding_id||Number(pin.binding_version)!==Number(source.binding_version)
        ||pin.artifact_id!==input.artifactId||Number(pin.artifact_version)!==input.version||pin.server_path!==artifact.server_path
        ||pin.sha256!==artifact.sha256||Number(pin.size_bytes)!==Number(artifact.size_bytes)||pin.display_name!==displayName
        ||!this.slackArtifactAuthorized(effect))throw new Error('slack_artifact_pin_conflict');
      return effect;
    });
  }

  enqueueExternal(input: ExternalDeliveryInput): Record<string, unknown> | null {
    if (input.destination === 'current_chat') return null;
    if (input.destination === 'slack' && input.artifactRef) throw new Error('external_delivery_invalid');
    if (input.artifactRef) throw new Error('channel_delivery_artifact_pin_required');
    if (input.destination === 'email') emailPrincipal(input.recipient);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (typeof input.runId!=='string'||!input.runId.trim()||!['wecom','email','webpush','mattermost','slack','sms'].includes(input.destination)
      || (input.destination==='slack'&&input.artifactRef!==null) || !input.recipient.trim()
      || (!input.artifactRef && !text) || (input.artifactRef && text)) {
      throw new Error('external_delivery_invalid');
    }
    const identity = JSON.stringify([input.runId, input.messageId, input.destination,
      input.recipient, input.artifactRef, text || null]);
    const effectId = `delivery-${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
    const now = new Date(this.now() * 1000).toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO ga_channel_deliveries(
      effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?, 'pending',?,?)`).run(effectId, input.runId, input.messageId,
      input.destination, input.recipient, input.artifactRef,
      text ? JSON.stringify({ kind: 'text', text }) : null, now, now);
    return this.get(effectId);
  }

  enqueueProjected(input: { request_id: string; run_id: string; client_run_id: string;
    artifact_ref: string; recipient_ref: string }): Record<string, any> {
    if (!/^delivery:[0-9a-z._:-]{1,128}$/i.test(input.request_id)
      || !input.client_run_id.trim() || !input.artifact_ref.trim() || !input.recipient_ref.trim()) {
      throw new Error('projected_delivery_invalid');
    }
    const now = new Date(this.now() * 1000).toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO ga_channel_deliveries(
      effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(input.request_id, input.client_run_id,
      input.request_id, 'wecom', input.recipient_ref, input.artifact_ref, null, now, now);
    return this.get(input.request_id);
  }

  claim(owner: string, leaseSeconds: number, channels: string[] = ['wecom'], artifacts?: ArtifactService): Record<string, any> | null {
    if (!owner || leaseSeconds < 1) throw new Error('delivery_lease_invalid');
    if(!Array.isArray(channels)||channels.some(channel=>!['wecom','email','webpush','mattermost','slack','sms'].includes(channel)))throw new Error('delivery_channels_invalid');
    return withImmediateTransaction(this.db, () => {
      const current = this.now();
      this.db.prepare(`UPDATE ga_channel_deliveries SET status='outcome_unknown',
        last_reason_code='PROVIDER_SEND_STATE_AMBIGUOUS',lease_owner=NULL,
        lease_expires_at=NULL,updated_at=? WHERE status='sending' AND lease_expires_at<=?`)
        .run(new Date(current * 1000).toISOString(), current);
      const row = this.db.prepare(`SELECT e.* FROM ga_channel_deliveries e
        LEFT JOIN wb_task_notification_deferrals d ON d.effect_id=e.effect_id
        LEFT JOIN wb_task_notification_digest_members m ON m.effect_id=e.effect_id
        LEFT JOIN wb_task_notification_digests summary ON summary.digest_id=m.digest_id
        WHERE e.status IN ('pending','historical_pending','receipt_pending')
          AND (e.status='receipt_pending'
            OR (e.artifact_ref IS NULL AND CASE WHEN json_valid(e.payload_json)=1
              THEN json_extract(e.payload_json,'$.kind')='text' ELSE 0 END)
            OR (e.artifact_ref IS NOT NULL AND e.destination<>'weixin' AND ?=1
              AND e.status='pending'
              AND CASE WHEN json_valid(e.payload_json)=1
                THEN json_extract(e.payload_json,'$.kind')='artifact'
                  AND json_extract(e.payload_json,'$.schema_version')=1
                ELSE 0 END))
          AND (e.status<>'historical_pending' OR EXISTS(
            SELECT 1 FROM ga_historical_final_delivery_grants g JOIN ga_historical_final_delivery_states s ON s.intent_id=g.intent_id
            WHERE g.effect_id=e.effect_id AND s.effect_id=e.effect_id AND s.status='queued'))
          AND NOT EXISTS(SELECT 1 FROM wb_task_notification_archives archived WHERE archived.effect_id=e.effect_id)
          AND (e.status='receipt_pending' OR e.destination IN (SELECT value FROM json_each(?)))
          AND (e.lease_owner IS NULL OR e.lease_expires_at<=?)
          AND (e.status='receipt_pending' OR d.not_before IS NULL OR d.not_before<=?)
          AND (m.effect_id IS NULL OR summary.anchor_effect_id=e.effect_id)
        ORDER BY e.created_at,e.effect_id LIMIT 1`).get(artifacts ? 1 : 0, JSON.stringify(channels),current,current) as Record<string, any> | undefined;
      if (!row) return null;
      const generation = Number(row.generation) + 1;
      const nextStatus = row.status === 'receipt_pending' ? 'receipt_pending' : 'sending';
      const updatedAt = new Date(current * 1000).toISOString();
      const artifactEffect=row.artifact_ref!==null;
      // A complete accepted provider receipt recovers only internal receipt and
      // exact-pin cleanup. Revocation still fences every new provider send.
      if(artifactEffect&&row.status!=='receipt_pending'&&String(row.destination)==='slack'&&!this.slackArtifactAuthorized(row)){
        this.db.prepare("UPDATE ga_channel_deliveries SET status='cancelled',last_reason_code='SLACK_ARTIFACT_AUTHORIZATION_REVOKED',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND status=? AND generation=?")
          .run(updatedAt,row.effect_id,row.status,Number(row.generation));return null;
      }
      if(artifactEffect&&row.status!=='receipt_pending'&&String(row.destination)!=='slack'
        &&(!['wecom','mattermost'].includes(String(row.destination))||!this.taskSendPermitted(row))){
        const reason=!['wecom','mattermost'].includes(String(row.destination))?'CHANNEL_ARTIFACT_DELIVERY_UNSUPPORTED':'TASK_ARTIFACT_DELIVERY_GRANT_REQUIRED';
        this.db.prepare('UPDATE ga_channel_deliveries SET status=?,last_reason_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND status=? AND generation=?')
          .run('cancelled',reason,updatedAt,row.effect_id,row.status,Number(row.generation));return null;
      }
      const artifactClaim = row.status !== 'receipt_pending' && artifactEffect;
      if (artifactClaim) {
        if(!artifacts)throw new Error('channel_delivery_artifact_pin_required');
        if(row.destination==='slack'){
          if(!this.slackArtifactAuthorized(row)){
            this.db.prepare("UPDATE ga_channel_deliveries SET status='cancelled',last_reason_code='SLACK_ARTIFACT_AUTHORIZATION_REVOKED',updated_at=? WHERE effect_id=? AND status='pending' AND generation=?")
              .run(updatedAt,row.effect_id,Number(row.generation));return null;
          }
        }else if(!['wecom','mattermost'].includes(String(row.destination))){
          this.db.prepare("UPDATE ga_channel_deliveries SET status='cancelled',last_reason_code='CHANNEL_ARTIFACT_DELIVERY_UNSUPPORTED',updated_at=? WHERE effect_id=? AND status='pending' AND generation=?")
            .run(updatedAt,row.effect_id,Number(row.generation));return null;
        }
        if(row.destination!=='slack'&&!this.taskSendPermitted(row)){
          this.db.prepare("UPDATE ga_channel_deliveries SET status='cancelled',last_reason_code='TASK_ARTIFACT_DELIVERY_GRANT_REQUIRED',updated_at=? WHERE effect_id=? AND status='pending' AND generation=?")
            .run(updatedAt,row.effect_id,Number(row.generation));return null;
        }
        if(row.destination!=='slack'){
          const pendingProof = provePendingPinnedChannelArtifact(this.db, this, artifacts, String(row.effect_id));
          if (pendingProof.generation !== Number(row.generation)) throw new Error('delivery_lease_lost');
        }
        const changed = this.db.prepare(`UPDATE ga_channel_deliveries SET status='sending',lease_owner=?,generation=?,
          file_claim_protocol_generation=?,lease_expires_at=?,updated_at=?
          WHERE effect_id=? AND status=? AND generation=?`).run(owner, generation, generation,
          current + leaseSeconds, updatedAt, row.effect_id, row.status, Number(row.generation)).changes;
        if (changed !== 1) throw new Error('delivery_lease_lost');
        if(row.destination==='slack')this.proveSlackPinnedArtifact(this.get(String(row.effect_id)),generation,artifacts);
        else provePinnedChannelArtifact(this.db, this, artifacts, String(row.effect_id));
      } else {
        const changed = this.db.prepare(`UPDATE ga_channel_deliveries SET status=?,lease_owner=?,generation=?,
          lease_expires_at=?,updated_at=? WHERE effect_id=? AND status=? AND generation=?`).run(nextStatus, owner,
          generation, current + leaseSeconds, updatedAt, row.effect_id, row.status, Number(row.generation)).changes;
        if (changed !== 1) throw new Error('delivery_lease_lost');
      }
      return { ...row, status: nextStatus, generation,
        ...(artifactClaim ? { file_claim_protocol_generation: generation } : {}),
        phase: row.status === 'receipt_pending' ? 'receipt_only' : 'send',
        provider_receipt: row.provider_receipt_json ? JSON.parse(row.provider_receipt_json) : null };
    });
  }

  recordProviderSent(effectId: string, generation: number, receipt: Record<string, unknown>): void {
    if (!receipt.provider_message_id) throw new Error('provider_receipt_invalid');
    withImmediateTransaction(this.db,()=>{
    const members=this.digestMembers(effectId);
    if(members.length&&Number(this.get(effectId).generation)!==generation)throw new Error('delivery_lease_lost');
    for(const member of members.length?members:[{effect_id:effectId,digest_generation:generation}]){
    const changed = this.db.prepare(`UPDATE ga_channel_deliveries SET status='receipt_pending',
      provider_receipt_json=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE effect_id=? AND generation=? AND status='sending'`).run(JSON.stringify(receipt),
        new Date(this.now() * 1000).toISOString(), member.effect_id, member.digest_generation).changes;
    if (changed !== 1) throw new Error('delivery_lease_lost');
    this.db.prepare('DELETE FROM wb_task_notification_deferrals WHERE effect_id=?').run(member.effect_id);
    }
    this.db.prepare('DELETE FROM wb_channel_delivery_provider_retries WHERE effect_id=?').run(effectId);
    });
  }

  recordProviderPart(effectId: string, generation: number, partIndex: number,
    total: number, receipt: Record<string, unknown>): void {
    if (!Number.isInteger(partIndex) || partIndex < 1 || !Number.isInteger(total)
      || total < partIndex || typeof receipt.provider_message_id !== 'string'
      || !receipt.provider_message_id) throw new Error('provider_part_receipt_invalid');
    const row = this.db.prepare(`SELECT provider_receipt_json FROM ga_channel_deliveries
      WHERE effect_id=? AND generation=? AND status='sending'`).get(effectId, generation) as
      { provider_receipt_json?: string } | undefined;
    if (!row) throw new Error('delivery_lease_lost');
    const previous = row.provider_receipt_json ? JSON.parse(row.provider_receipt_json) : null;
    const receipts = Array.isArray(previous?.receipts) ? previous.receipts : [];
    if (receipts.length + 1 !== partIndex) throw new Error('provider_part_order_invalid');
    receipts.push({ part_index: partIndex, provider_message_id: receipt.provider_message_id });
    this.db.prepare(`UPDATE ga_channel_deliveries SET provider_receipt_json=?,updated_at=?
      WHERE effect_id=? AND generation=? AND status='sending'`).run(
        JSON.stringify({ total, receipts }), new Date(this.now() * 1000).toISOString(),
        effectId, generation);
  }

  recordReceiptFailure(effectId: string, reasonCode: string): void {
    withImmediateTransaction(this.db,()=>{
    const members=this.digestMembers(effectId);
    for(const member of members.length?members:[{effect_id:effectId}]){
    this.db.prepare(`UPDATE ga_channel_deliveries SET status='receipt_pending',last_reason_code=?,
      lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE effect_id=? AND status='receipt_pending' AND provider_receipt_json IS NOT NULL`)
      .run(reasonCode, new Date(this.now() * 1000).toISOString(), member.effect_id);
    }
    });
  }

  recordProviderUnknown(effectId: string, generation: number): void {
    withImmediateTransaction(this.db,()=>{
    const members=this.digestMembers(effectId);
    if(members.length&&Number(this.get(effectId).generation)!==generation)throw new Error('delivery_lease_lost');
    for(const member of members.length?members:[{effect_id:effectId,digest_generation:generation}]){
    const changed = this.db.prepare(`UPDATE ga_channel_deliveries SET status='outcome_unknown',
      lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE effect_id=? AND generation=? AND status='sending'`).run(
        new Date(this.now() * 1000).toISOString(), member.effect_id, member.digest_generation).changes;
    if (changed !== 1) throw new Error('delivery_lease_lost');
    this.db.prepare('DELETE FROM wb_task_notification_deferrals WHERE effect_id=?').run(member.effect_id);
    }
    this.db.prepare('DELETE FROM wb_channel_delivery_provider_retries WHERE effect_id=?').run(effectId);
    });
  }

  recordProviderRetry(effectId:string,generation:number):void{
    withImmediateTransaction(this.db,()=>{
      const members=this.digestMembers(effectId);
      if(members.length&&Number(this.get(effectId).generation)!==generation)throw new Error('delivery_lease_lost');
      const previous=this.db.prepare('SELECT retry_count FROM wb_channel_delivery_provider_retries WHERE effect_id=?').get(effectId) as {retry_count?:number}|undefined;
      const retryCount=Number(previous?.retry_count??0)+1,current=this.now(),updatedAt=new Date(current*1000).toISOString();
      if(retryCount>MAX_PUSH_PROVIDER_RETRIES){
        for(const member of members.length?members:[{effect_id:effectId,digest_generation:generation}]){
          const memberGeneration=Number(member.digest_generation??generation);
          const changed=this.db.prepare(`UPDATE ga_channel_deliveries SET status='cancelled',last_reason_code='PUSH_PROVIDER_RETRY_EXHAUSTED',
            lease_owner=NULL,lease_expires_at=NULL,updated_at=?
            WHERE effect_id=? AND generation=? AND status='sending' AND provider_receipt_json IS NULL`)
            .run(updatedAt,member.effect_id,memberGeneration).changes;
          if(changed!==1)throw new Error('delivery_lease_lost');
          this.db.prepare('DELETE FROM wb_task_notification_deferrals WHERE effect_id=?').run(member.effect_id);
        }
        this.db.prepare('DELETE FROM wb_channel_delivery_provider_retries WHERE effect_id=?').run(effectId);
        return;
      }
      const delaySeconds=Math.min(300,FIRST_PUSH_PROVIDER_RETRY_DELAY_SECONDS*2**(retryCount-1)),notBefore=current+delaySeconds;
      this.db.prepare('INSERT INTO wb_channel_delivery_provider_retries VALUES(?,?) ON CONFLICT(effect_id) DO UPDATE SET retry_count=excluded.retry_count')
        .run(effectId,retryCount);
      for(const member of members.length?members:[{effect_id:effectId,digest_generation:generation}]){
        const memberGeneration=Number(member.digest_generation??generation);
        const changed=this.db.prepare(`UPDATE ga_channel_deliveries SET status='pending',last_reason_code='PUSH_PROVIDER_RATE_LIMITED',
          lease_owner=NULL,lease_expires_at=NULL,updated_at=?
          WHERE effect_id=? AND generation=? AND status='sending' AND provider_receipt_json IS NULL`)
          .run(updatedAt,member.effect_id,memberGeneration).changes;
        if(changed!==1)throw new Error('delivery_lease_lost');
        this.db.prepare('INSERT INTO wb_task_notification_deferrals VALUES(?,?) ON CONFLICT(effect_id) DO UPDATE SET not_before=excluded.not_before')
          .run(member.effect_id,notBefore);
      }
    });
  }

  recordProviderRejected(effectId:string,generation:number,reasonCode:string):void{
    const allowed=new Set(['PUSH_SUBSCRIPTION_EXPIRED','PUSH_VAPID_GENERATION_STALE','PUSH_ENDPOINT_UNAVAILABLE','PUSH_PROVIDER_REJECTED','PUSH_PAYLOAD_INVALID','PUSH_FILE_DELIVERY_UNSUPPORTED','MATTERMOST_PROVIDER_REJECTED']);
    if(!allowed.has(reasonCode))throw new Error('provider_rejection_invalid');
    withImmediateTransaction(this.db,()=>{
      const members=this.digestMembers(effectId);
      if(members.length&&Number(this.get(effectId).generation)!==generation)throw new Error('delivery_lease_lost');
      for(const member of members.length?members:[{effect_id:effectId,digest_generation:generation}]){
        const changed=this.db.prepare(`UPDATE ga_channel_deliveries SET status='cancelled',last_reason_code=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=?
          WHERE effect_id=? AND generation=? AND status='sending' AND provider_receipt_json IS NULL`)
          .run(reasonCode,new Date(this.now()*1000).toISOString(),member.effect_id,member.digest_generation).changes;
        if(changed!==1)throw new Error('delivery_lease_lost');
        this.db.prepare('DELETE FROM wb_task_notification_deferrals WHERE effect_id=?').run(member.effect_id);
      }
      this.db.prepare('DELETE FROM wb_channel_delivery_provider_retries WHERE effect_id=?').run(effectId);
    });
  }

  recordDelivered(effectId: string): void {
    withImmediateTransaction(this.db,()=>{
    const members=this.digestMembers(effectId);
    for(const member of members.length?members:[{effect_id:effectId}]){
    const changed = this.db.prepare(`UPDATE ga_channel_deliveries SET status='delivered',
      lease_owner=NULL,lease_expires_at=NULL,updated_at=?
      WHERE effect_id=? AND status='receipt_pending' AND provider_receipt_json IS NOT NULL`)
      .run(new Date(this.now() * 1000).toISOString(), member.effect_id).changes;
    if (changed !== 1) throw new Error('delivery_receipt_not_ready');
    }
    });
  }

  get(effectId: string): Record<string, any> {
    const read=()=>{
    const row = this.db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?')
      .get(effectId) as Record<string, any> | undefined;
    if (!row) throw new Error('delivery_not_found');
    return resolveNotificationArchive(this.db,row);
    };
    if(this.db.isTransaction)return read();this.db.exec('BEGIN');try{const row=read();this.db.exec('COMMIT');return row;}catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  enqueueText(input: { runId: string; messageId: string; destination: 'wecom'|'email'|'webpush'|'mattermost'|'slack'|'sms';
    recipient: string; text: string }): Record<string, unknown> | null {
    return this.enqueueExternal({ ...input, artifactRef: null, text: input.text });
  }
}
