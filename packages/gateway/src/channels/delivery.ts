import { createHash } from 'node:crypto';
import { emailPrincipal } from './email-provider.ts';
import type { DatabaseSync } from 'node:sqlite';
import { withImmediateTransaction } from '../db/database.ts';
import {TaskNotifications} from '../persistent-tasks/notifications.ts';
import {defaultNotificationPolicy,normalizeNotificationPolicy,notificationQuietUntil} from '../persistent-tasks/notification-policy.ts';
import {signalDeliveryAuthorized,signalDeliverySourceResolved} from '../persistent-tasks/notification-signals.ts';
import {hostDeliveryAuthorized,hostDeliverySourceResolved} from '../persistent-tasks/host-notifications.ts';
import {replyDeliveryCheck} from '../persistent-tasks/reply-delivery.ts';
import {resolveNotificationArchive,resolveNotificationDigestArchive,ensureNotificationArchiveSchema} from './notification-archive.ts';

export interface ExternalDeliveryInput {
  runId: string;
  messageId: string;
  destination: string;
  recipient: string;
  artifactRef: string | null;
  text?: string | null;
}

export class ChannelDeliveryService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
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
       BEGIN SELECT RAISE(ABORT,'notification_digest_member_immutable'); END;`);
    ensureNotificationArchiveSchema(db);
  }

  bindTaskAuthorization(effectId:string,scope:{owner_id:string;task_id:string;occurrence_id:string;generation:number;task_version:number;agent_id:string;epoch:number},conversationId:string,principal:string):void{
    if(!this.db.isTransaction)throw new Error('task_delivery_transaction_required');
    const effect=this.get(effectId);
    if(!['wecom','email'].includes(String(effect.destination))||effect.recipient!==principal||effect.status!=='pending')throw new Error('task_delivery_authorization_invalid');
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
      if(members.length){
        if(members.every(member=>this.taskSendPermitted(member)))return true;
        const reason=members.some(member=>hostDeliverySourceResolved(this.db,member)||signalDeliverySourceResolved(this.db,member,new Date(this.now()*1000).toISOString()))?'TASK_NOTIFICATION_SOURCE_RESOLVED':undefined;
        for(const member of members)this.rejectTaskDelivery(member.effect_id,Number(member.generation),reason);
        return false;
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

  private taskSendPermitted(effect:Record<string,any>):boolean {
      const host=hostDeliveryAuthorized(this.db,effect);if(host!==undefined)return host;
      const signal=signalDeliveryAuthorized(this.db,effect,new Date(this.now()*1000).toISOString());
      if(signal!==undefined)return signal;
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
      return !!permitted;
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

  enqueueExternal(input: ExternalDeliveryInput): Record<string, unknown> | null {
    if (input.destination === 'current_chat') return null;
    if (input.destination === 'email') emailPrincipal(input.recipient);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    if (typeof input.runId!=='string'||!input.runId.trim()||!['wecom','email'].includes(input.destination) || !input.recipient.trim()
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

  claim(owner: string, leaseSeconds: number, channels: string[] = ['wecom']): Record<string, any> | null {
    if (!owner || leaseSeconds < 1) throw new Error('delivery_lease_invalid');
    if(!Array.isArray(channels)||channels.some(channel=>!['wecom','email'].includes(channel)))throw new Error('delivery_channels_invalid');
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
        WHERE e.status IN ('pending','receipt_pending')
          AND NOT EXISTS(SELECT 1 FROM wb_task_notification_archives archived WHERE archived.effect_id=e.effect_id)
          AND (e.status='receipt_pending' OR e.destination IN (SELECT value FROM json_each(?)))
          AND (e.lease_owner IS NULL OR e.lease_expires_at<=?)
          AND (e.status='receipt_pending' OR d.not_before IS NULL OR d.not_before<=?)
          AND (m.effect_id IS NULL OR summary.anchor_effect_id=e.effect_id)
        ORDER BY e.created_at,e.effect_id LIMIT 1`).get(JSON.stringify(channels),current,current) as Record<string, any> | undefined;
      if (!row) return null;
      const generation = Number(row.generation) + 1;
      const nextStatus = row.status === 'pending' ? 'sending' : 'receipt_pending';
      this.db.prepare(`UPDATE ga_channel_deliveries SET status=?,lease_owner=?,generation=?,
        lease_expires_at=?,updated_at=? WHERE effect_id=?`).run(nextStatus, owner,
        generation, current + leaseSeconds, new Date(current * 1000).toISOString(), row.effect_id);
      return { ...row, status: nextStatus, generation,
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
    }
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
    }
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

  enqueueText(input: { runId: string; messageId: string; destination: 'wecom'|'email';
    recipient: string; text: string }): Record<string, unknown> | null {
    return this.enqueueExternal({ ...input, artifactRef: null, text: input.text });
  }
}
