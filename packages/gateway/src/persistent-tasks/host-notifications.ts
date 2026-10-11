import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {normalizeNotificationPolicy,notificationQuietUntil} from './notification-policy.ts';
type Row=Record<string,any>;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
export function installHostNotifications(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_host_notification_authorizations (
 effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),episode_id TEXT NOT NULL REFERENCES wb_task_monitor_failure_episodes(episode_id),
 binding_id TEXT NOT NULL REFERENCES ga_owner_channel_bindings(channel_binding_id),binding_version INTEGER NOT NULL,
 channel TEXT NOT NULL,principal TEXT NOT NULL,payload_sha256 TEXT NOT NULL,UNIQUE(episode_id,binding_id));
 CREATE TRIGGER IF NOT EXISTS wb_task_host_notification_no_update BEFORE UPDATE ON wb_task_host_notification_authorizations BEGIN SELECT RAISE(ABORT,'host_notification_authorization_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_task_host_notification_no_delete BEFORE DELETE ON wb_task_host_notification_authorizations BEGIN SELECT RAISE(ABORT,'host_notification_authorization_immutable'); END;`);
}
export function enqueueHostFailure(db:DatabaseSync,episodeId:string,now:string){
 if(!db.isTransaction)throw new Error('host_notification_transaction_required');
 const episode=db.prepare('SELECT * FROM wb_task_monitor_failure_episodes WHERE episode_id=?').get(episodeId) as Row;
 if(!episode.notification_scope_json)return;
 const scope=JSON.parse(episode.notification_scope_json),settings=db.prepare('SELECT * FROM wb_task_notification_settings WHERE task_id=? AND owner_id=? AND version=?').get(episode.task_id,episode.owner_id,scope.settings_version) as Row|undefined;
 if(!settings)return;
 const text='暂时无法检查这项任务，系统会按重试策略继续检查。请在工作台查看原因和恢复选项。',payload=JSON.stringify({kind:'text',text}),seconds=Math.floor(Date.parse(now)/1000);
 for(const saved of scope.bindings){
  const binding=db.prepare("SELECT * FROM ga_owner_channel_bindings WHERE channel_binding_id=? AND owner_id=? AND version=? AND status='verified' AND channel IN ('wecom','email')").get(saved.channel_binding_id,episode.owner_id,saved.version) as Row|undefined;if(!binding)continue;
  const effect='delivery-host-'+hash(JSON.stringify([episodeId,saved.channel_binding_id])).slice(0,32);
  db.prepare(`INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at) VALUES(?,NULL,?,?,?,NULL,?,'pending',?,?)`).run(effect,episodeId,binding.channel,binding.principal,payload,now,now);
  db.prepare('INSERT INTO wb_task_host_notification_authorizations VALUES(?,?,?,?,?,?,?)').run(effect,episodeId,binding.channel_binding_id,binding.version,binding.channel,binding.principal,hash(payload));
  const quiet=notificationQuietUntil(normalizeNotificationPolicy(JSON.parse(settings.delivery_policy_json)),seconds);
  if(quiet){db.prepare('INSERT INTO wb_task_notification_quiet_queue VALUES(?,?)').run(effect,quiet);db.prepare('INSERT INTO wb_task_notification_deferrals VALUES(?,?)').run(effect,quiet);db.prepare("UPDATE ga_channel_deliveries SET last_reason_code='TASK_NOTIFICATION_QUIET_HOURS' WHERE effect_id=?").run(effect);}
 }
}
export function hostDeliverySourceResolved(db:DatabaseSync,effect:Row):boolean{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_host_notification_authorizations' AND type='table'").get())return false;
 return !!db.prepare(`SELECT 1 FROM wb_task_host_notification_authorizations h JOIN wb_task_monitor_failure_resolutions r ON r.episode_id=h.episode_id WHERE h.effect_id=? AND r.reason='recovered'`).get(effect.effect_id);
}
/** A NULL run can only send with a trusted, still-current host episode grant. */
export function hostDeliveryAuthorized(db:DatabaseSync,effect:Row):boolean|undefined{
 if(effect.run_id!==null)return;
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_host_notification_authorizations' AND type='table'").get())return false;
 const source=db.prepare(`SELECT h.*,e.* FROM wb_task_host_notification_authorizations h JOIN wb_task_monitor_failure_episodes e ON e.episode_id=h.episode_id WHERE h.effect_id=?`).get(effect.effect_id) as Row|undefined;
 if(!source||!source.notification_scope_json||effect.message_id!==source.episode_id||effect.artifact_ref!==null||effect.destination!==source.channel||effect.recipient!==source.principal||hash(String(effect.payload_json))!==source.payload_sha256)return false;
 const scope=JSON.parse(source.notification_scope_json);
 if(!scope.bindings.some((b:Row)=>b.channel_binding_id===source.binding_id&&b.version===source.binding_version))return false;
 return !!db.prepare(`SELECT 1 FROM wb_task_monitor_failure_active active
  JOIN wb_persistent_tasks t ON t.task_id=active.task_id AND t.owner_id=? AND t.generation=? AND t.version=? AND t.status='active' AND t.agent_id=?
  JOIN wb_agents a ON a.agent_id=t.agent_id AND a.owner_id=t.owner_id AND a.capability_epoch=? AND a.status='active'
  JOIN wb_task_notification_settings n ON n.task_id=t.task_id AND n.owner_id=t.owner_id AND n.version=?
  JOIN ga_owner_channel_bindings b ON b.channel_binding_id=? AND b.owner_id=t.owner_id AND b.version=? AND b.status='verified' AND b.channel=? AND b.principal=?
  WHERE active.episode_id=? AND NOT EXISTS(SELECT 1 FROM wb_task_monitor_failure_resolutions r WHERE r.episode_id=active.episode_id)
   AND EXISTS(SELECT 1 FROM json_each(n.events_json) event WHERE event.value='failed')
   AND EXISTS(SELECT 1 FROM json_each(n.bindings_json) binding WHERE json_extract(binding.value,'$.channel_binding_id')=b.channel_binding_id AND json_extract(binding.value,'$.version')=b.version)`)
  .get(source.owner_id,source.generation,source.task_version,scope.agent_id,scope.epoch,scope.settings_version,source.binding_id,source.binding_version,source.channel,source.principal,source.episode_id);
}
