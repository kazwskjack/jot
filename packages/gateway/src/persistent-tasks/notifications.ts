import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {OwnerChannelBindings} from '../channels/owner-bindings.ts';
import {defaultNotificationPolicy,normalizeNotificationPolicy} from './notification-policy.ts';
type Row=Record<string,any>;
type Target={channel_binding_id:string;channel:string;principal:string;version:number;settings_version:number};
export const taskNotificationEvents=['changed','completed','failed','needs_confirmation'] as const;
export function normalizeNotificationEvents(value:unknown):string[]{
 if(!Array.isArray(value)||value.length>4||new Set(value).size!==value.length||value.some(item=>!taskNotificationEvents.includes(item as typeof taskNotificationEvents[number])))throw new Error('invalid_task_notification_settings');
 return [...value] as string[];
}
export class TaskNotifications{
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;new OwnerChannelBindings(db);
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_notification_settings (
   task_id TEXT PRIMARY KEY REFERENCES wb_persistent_tasks(task_id),owner_id TEXT NOT NULL,version INTEGER NOT NULL,bindings_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_task_notification_grants (
   effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),owner_id TEXT NOT NULL,task_id TEXT NOT NULL,
   channel_binding_id TEXT NOT NULL REFERENCES ga_owner_channel_bindings(channel_binding_id),binding_version INTEGER NOT NULL,settings_version INTEGER NOT NULL);
   CREATE TRIGGER IF NOT EXISTS wb_task_notification_grants_no_update BEFORE UPDATE ON wb_task_notification_grants BEGIN SELECT RAISE(ABORT,'task_notification_grant_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_task_notification_grants_no_delete BEFORE DELETE ON wb_task_notification_grants BEGIN SELECT RAISE(ABORT,'task_notification_grant_immutable'); END;`);
  if(!(db.prepare('PRAGMA table_info(wb_task_notification_settings)').all() as Row[]).some(row=>row.name==='delivery_policy_json'))db.exec("ALTER TABLE wb_task_notification_settings ADD COLUMN delivery_policy_json TEXT NOT NULL DEFAULT '{\"min_interval_seconds\":60,\"max_per_24_hours\":20,\"quiet_hours\":null}'");
  if(!(db.prepare('PRAGMA table_info(wb_task_notification_settings)').all() as Row[]).some(row=>row.name==='events_json'))db.exec("ALTER TABLE wb_task_notification_settings ADD COLUMN events_json TEXT NOT NULL DEFAULT '[\"completed\"]'");
 }
 private task(owner:string,id:string){const task=this.db.prepare('SELECT * FROM wb_persistent_tasks WHERE owner_id=? AND task_id=?').get(owner,id) as Row|undefined;if(!task)throw new Error('task_not_found');return task;}
 get(owner:string,id:string){this.task(owner,id);const row=this.db.prepare('SELECT * FROM wb_task_notification_settings WHERE owner_id=? AND task_id=?').get(owner,id) as Row|undefined;
  return {task_id:id,version:row?Number(row.version):0,channel_binding_ids:row?(JSON.parse(String(row.bindings_json)) as Target[]).map(binding=>binding.channel_binding_id):[],events:row?normalizeNotificationEvents(JSON.parse(String(row.events_json))):['completed'],delivery_policy:row?normalizeNotificationPolicy(JSON.parse(String(row.delivery_policy_json))):{...defaultNotificationPolicy}};}
 update(owner:string,id:string,input:Row){return withImmediateTransaction(this.db,()=>{
  const task=this.task(owner,id);
  if(Object.keys(input).some(key=>!['expected_version','channel_binding_ids','delivery_policy','events'].includes(key))||!Number.isSafeInteger(input.expected_version)||input.expected_version<0||!Array.isArray(input.channel_binding_ids)||input.channel_binding_ids.length>5||new Set(input.channel_binding_ids).size!==input.channel_binding_ids.length||input.channel_binding_ids.some((id:unknown)=>typeof id!=='string'||!id||id.length>128))throw new Error('invalid_task_notification_settings');
  const policy=input.delivery_policy===undefined?this.get(owner,id).delivery_policy:normalizeNotificationPolicy(input.delivery_policy);
  const events=input.events===undefined?this.get(owner,id).events:normalizeNotificationEvents(input.events);
  if(task.status==='archived')throw new Error('task_state_conflict');
  if(this.db.prepare(`SELECT 1 FROM wb_task_current_occurrences o JOIN ga_runs r ON r.id=o.run_id WHERE o.task_id=? AND (r.reason_code='OUTCOME_UNKNOWN' OR r.status NOT IN ('succeeded','partial','failed','cancelled','interrupted'))`).get(id))throw new Error('task_notification_run_active');
  const current=this.get(owner,id);if(current.version!==input.expected_version)throw new Error('version_conflict');
  const bindings=new OwnerChannelBindings(this.db),targets=input.channel_binding_ids.map((id:string)=>bindings.resolve(owner,id)),now=new Date().toISOString();
  this.db.prepare(`INSERT INTO wb_task_notification_settings(task_id,owner_id,version,bindings_json,created_at,updated_at,delivery_policy_json,events_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET version=excluded.version,bindings_json=excluded.bindings_json,updated_at=excluded.updated_at,delivery_policy_json=excluded.delivery_policy_json,events_json=excluded.events_json`).run(id,owner,current.version+1,JSON.stringify(targets.map(({channel_binding_id,version})=>({channel_binding_id,version}))),now,now,JSON.stringify(policy),JSON.stringify(events));
  // Permission changes invalidate queued delivery grants without resetting the
  // task's schedule, Goal, progress, generation or consumed model allowance.
  this.db.prepare('UPDATE wb_persistent_tasks SET version=version+1,projection_pending=1,updated_at=? WHERE task_id=? AND owner_id=?').run(now,id,owner);
  return this.get(owner,id);
 });}
 targets(owner:string,id:string,event='completed'):Target[]|undefined{
  this.task(owner,id);const settings=this.db.prepare('SELECT * FROM wb_task_notification_settings WHERE task_id=? AND owner_id=?').get(id,owner) as Row|undefined;
  if(!settings)return;
  if(!normalizeNotificationEvents(JSON.parse(settings.events_json)).includes(event))return [];
  return (JSON.parse(String(settings.bindings_json)) as Array<{channel_binding_id:string;version:number}>).map(saved=>{
   const row=this.db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE channel_binding_id=? AND owner_id=?').get(saved.channel_binding_id,owner) as Row|undefined;
   if(!row)throw new Error('channel_binding_not_found');
   return {channel_binding_id:saved.channel_binding_id,version:saved.version,channel:String(row.channel),principal:String(row.principal),settings_version:Number(settings.version)};
  });
 }
 grant(effectId:string,owner:string,taskId:string,target:Target){if(!this.db.isTransaction)throw new Error('task_notification_transaction_required');
  this.db.prepare('INSERT INTO wb_task_notification_grants VALUES(?,?,?,?,?,?)').run(effectId,owner,taskId,target.channel_binding_id,target.version,target.settings_version);}
 history(owner:string,id:string,cursor?:string){
  this.task(owner,id);
  const hasHost=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_host_notification_authorizations'").get();
  const owned=`SELECT e.*,d.occurrence_id,'execution' AS source FROM ga_channel_deliveries e JOIN wb_task_delivery_authorizations d ON d.effect_id=e.effect_id WHERE d.owner_id=? AND d.task_id=?`+
   (hasHost?` UNION ALL SELECT e.*,NULL AS occurrence_id,'monitor' AS source FROM ga_channel_deliveries e JOIN wb_task_host_notification_authorizations h ON h.effect_id=e.effect_id JOIN wb_task_monitor_failure_episodes fault ON fault.episode_id=h.episode_id WHERE fault.owner_id=? AND fault.task_id=?`:'');
  const args=hasHost?[owner,id,owner,id]:[owner,id];
  const anchor=cursor?this.db.prepare(`WITH owned AS (${owned}) SELECT created_at,effect_id FROM owned WHERE effect_id=?`).get(...args,cursor) as Row|undefined:undefined;
  if(cursor&&!anchor)throw new Error('task_not_found');
  const rows=this.db.prepare(`WITH owned AS (${owned}) SELECT * FROM owned ${anchor?'WHERE created_at<? OR (created_at=? AND effect_id<?)':''} ORDER BY created_at DESC,effect_id DESC LIMIT 51`).all(...args,...(anchor?[anchor.created_at,anchor.created_at,anchor.effect_id]:[])) as Row[];
  const has_more=rows.length>50,items=rows.slice(0,50).map(row=>{
   const size=this.db.prepare(`SELECT count(*) n FROM wb_task_notification_digest_members members JOIN wb_task_notification_digest_members own ON own.digest_id=members.digest_id WHERE own.effect_id=?`).get(row.effect_id) as {n:number};
   return {delivery_id:String(row.effect_id),channel:String(row.destination),status:String(row.status),reason:row.last_reason_code===null?null:String(row.last_reason_code),digest_size:size.n||1,source:row.source,occurrence_id:row.occurrence_id===null?null:String(row.occurrence_id),created_at:String(row.created_at),updated_at:String(row.updated_at)};
  });
  return {items,has_more,next_cursor:has_more?items.at(-1)!.delivery_id:null};
 }
 deliveries(owner:string,id:string,occurrenceId:string){this.task(owner,id);
  if(!this.db.prepare('SELECT 1 FROM wb_task_occurrences WHERE task_id=? AND occurrence_id=?').get(id,occurrenceId))throw new Error('occurrence_not_found');
  const hasDigests=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_notification_digest_members'").get();
  const digestCount=hasDigests?'COALESCE((SELECT count(*) FROM wb_task_notification_digest_members m JOIN wb_task_notification_digest_members own ON own.digest_id=m.digest_id WHERE own.effect_id=e.effect_id),1)':'1';
  const rows=this.db.prepare(`SELECT e.effect_id,e.destination,e.status,e.last_reason_code,e.created_at,e.updated_at,${digestCount} AS digest_size FROM ga_channel_deliveries e
    JOIN wb_task_delivery_authorizations d ON d.effect_id=e.effect_id WHERE d.owner_id=? AND d.task_id=? AND d.occurrence_id=? ORDER BY e.created_at,e.effect_id`).all(owner,id,occurrenceId) as Row[];
  return {items:rows.map(row=>({delivery_id:String(row.effect_id),channel:String(row.destination),status:String(row.status),reason:row.last_reason_code===null?null:String(row.last_reason_code),digest_size:Number(row.digest_size)||1,created_at:String(row.created_at),updated_at:String(row.updated_at)}))};
 }
}
