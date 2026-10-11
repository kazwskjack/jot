import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {ChannelDeliveryService} from '../channels/delivery.ts';
import {TaskNotifications} from './notifications.ts';
type Row=Record<string,any>;
type SignalKind='changed'|'failed'|'needs_confirmation';

function install(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_notification_scopes (
  occurrence_id TEXT PRIMARY KEY REFERENCES wb_task_occurrences(occurrence_id),owner_id TEXT NOT NULL,task_id TEXT NOT NULL,
  generation INTEGER NOT NULL,task_version INTEGER NOT NULL,agent_id TEXT NOT NULL,epoch INTEGER NOT NULL,settings_version INTEGER NOT NULL,
  events_json TEXT NOT NULL,bindings_json TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wb_task_page_change_notices (
  occurrence_id TEXT PRIMARY KEY REFERENCES wb_task_notification_scopes(occurrence_id),run_id TEXT NOT NULL,
  previous_hash TEXT NOT NULL,next_hash TEXT NOT NULL,url TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wb_task_notification_events (
  event_id TEXT PRIMARY KEY,occurrence_id TEXT NOT NULL REFERENCES wb_task_notification_scopes(occurrence_id),run_id TEXT NOT NULL,
  kind TEXT NOT NULL,source_ref TEXT NOT NULL,source_version INTEGER NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL,
  UNIQUE(occurrence_id,kind,source_ref));
  CREATE TABLE IF NOT EXISTS wb_task_notification_event_links (
  effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),event_id TEXT NOT NULL REFERENCES wb_task_notification_events(event_id));`);
 for(const table of ['wb_task_notification_scopes','wb_task_page_change_notices','wb_task_notification_events','wb_task_notification_event_links'])for(const op of ['update','delete'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${op} BEFORE ${op.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'task_notification_evidence_immutable'); END;`);
}

function scopeCurrent(db:DatabaseSync,occurrenceId:string):Row|undefined {
 if(!db.prepare('SELECT 1 FROM wb_task_notification_scopes WHERE occurrence_id=?').get(occurrenceId))return;
 return db.prepare(`SELECT s.*,t.title FROM wb_task_notification_scopes s
  JOIN wb_persistent_tasks t ON t.task_id=s.task_id AND t.owner_id=s.owner_id AND t.agent_id=s.agent_id
   AND t.version=s.task_version AND t.generation=s.generation AND t.status IN ('active','budget_exhausted')
  JOIN wb_task_occurrences o ON o.occurrence_id=s.occurrence_id AND o.task_id=s.task_id AND o.generation=s.generation
  JOIN wb_agents a ON a.agent_id=s.agent_id AND a.owner_id=s.owner_id AND a.status='active' AND a.capability_epoch=s.epoch
  JOIN wb_task_notification_settings n ON n.task_id=s.task_id AND n.owner_id=s.owner_id AND n.version=s.settings_version
  WHERE s.occurrence_id=?`).get(occurrenceId) as Row|undefined;
}

function sourceCurrent(db:DatabaseSync,event:Row,now:string):boolean {
 if(event.kind==='changed')return !!db.prepare('SELECT 1 FROM wb_task_page_change_notices WHERE occurrence_id=? AND run_id=? AND previous_hash!=next_hash').get(event.occurrence_id,event.run_id)&&event.source_ref===event.occurrence_id;
 if(event.kind==='failed')return !!db.prepare(`SELECT 1 FROM wb_task_current_occurrences o JOIN ga_runs r ON r.id=o.run_id
   WHERE o.occurrence_id=? AND r.id=? AND r.status='failed' AND COALESCE(r.reason_code,'')!='OUTCOME_UNKNOWN' AND r.version=?`).get(event.occurrence_id,event.run_id,event.source_version)&&event.source_ref===event.run_id;
 if(event.kind==='needs_confirmation')return !!db.prepare(`SELECT 1 FROM wb_task_current_occurrences o JOIN ga_runs r ON r.id=o.run_id
  JOIN wb_task_wait_interactions w ON w.run_id=r.id AND w.expected_run_version=r.version AND w.checkpoint_id=r.checkpoint_id
  JOIN ga_interactions i ON i.id=w.interaction_id AND i.run_id=r.id AND i.conversation_id=r.conversation_id
  JOIN ga_session_checkpoints cp ON cp.checkpoint_id=w.checkpoint_id AND cp.run_id=r.id
  WHERE o.occurrence_id=? AND r.id=? AND r.status IN ('waiting_user','waiting_approval') AND i.id=? AND i.version=?
   AND i.status='pending' AND i.expires_at>?`).get(event.occurrence_id,event.run_id,event.source_ref,event.source_version,now);
 return false;
}

/** undefined means ordinary completion delivery; false is a stale signal. */
export function signalDeliveryAuthorized(db:DatabaseSync,effect:Row,now:string):boolean|undefined {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_notification_event_links'").get())return;
 const event=db.prepare(`SELECT n.* FROM wb_task_notification_event_links l JOIN wb_task_notification_events n ON n.event_id=l.event_id WHERE l.effect_id=?`).get(effect.effect_id) as Row|undefined;
 if(!event)return;
 const scope=scopeCurrent(db,event.occurrence_id);
 if(!scope||event.run_id!==effect.run_id||effect.message_id!==event.event_id||!(JSON.parse(scope.events_json) as string[]).includes(event.kind)||!sourceCurrent(db,event,now))return false;
 return !!db.prepare(`SELECT 1 FROM wb_task_delivery_authorizations d
  JOIN ga_runs r ON r.id=? AND r.conversation_id=d.conversation_id
  JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=d.owner_id
  JOIN wb_task_run_occurrences o ON o.run_id=r.id AND o.occurrence_id=d.occurrence_id
  JOIN wb_task_notification_grants g ON g.effect_id=d.effect_id AND g.owner_id=d.owner_id AND g.task_id=d.task_id
  JOIN ga_owner_channel_bindings b ON b.channel_binding_id=g.channel_binding_id AND b.owner_id=d.owner_id
   AND b.status='verified' AND b.version=g.binding_version AND b.channel=d.channel AND b.principal=d.principal
  WHERE d.effect_id=? AND d.owner_id=? AND d.task_id=? AND d.occurrence_id=? AND d.generation=? AND d.task_version=?
   AND d.agent_id=? AND d.epoch=? AND d.channel=? AND d.principal=? AND g.settings_version=?
   AND EXISTS(SELECT 1 FROM json_each(?) saved WHERE json_extract(saved.value,'$.channel_binding_id')=g.channel_binding_id AND json_extract(saved.value,'$.version')=g.binding_version)`).get(event.run_id,effect.effect_id,scope.owner_id,scope.task_id,scope.occurrence_id,scope.generation,scope.task_version,scope.agent_id,scope.epoch,effect.destination,effect.recipient,scope.settings_version,scope.bindings_json);
}
export function signalDeliverySourceResolved(db:DatabaseSync,effect:Row,now:string):boolean {
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_notification_event_links'").get())return false;
 const event=db.prepare(`SELECT n.* FROM wb_task_notification_event_links l JOIN wb_task_notification_events n ON n.event_id=l.event_id WHERE l.effect_id=?`).get(effect.effect_id) as Row|undefined;
 return !!event&&!!scopeCurrent(db,event.occurrence_id)&&!sourceCurrent(db,event,now);
}

/** Host-owned source ledger. No model tool or public route can insert signals. */
export class TaskNotificationSignals {
 private readonly db:DatabaseSync;private readonly now:()=>string;
 constructor(db:DatabaseSync,now:()=>string=()=>new Date().toISOString()){this.db=db;this.now=now;new TaskNotifications(db);install(db);}
 capture(owner:string,taskId:string,occurrenceId:string){
  if(!this.db.isTransaction)throw new Error('task_notification_transaction_required');
  const settings=this.db.prepare('SELECT bindings_json,events_json FROM wb_task_notification_settings WHERE owner_id=? AND task_id=?').get(owner,taskId) as Row|undefined;
  // A task without an external notification configuration does not require
  // the SQL role adapter. Never infer sender authority from an in-memory role.
  if(!settings||!JSON.parse(settings.bindings_json).length||!JSON.parse(settings.events_json).length)return;
  const row=this.db.prepare(`SELECT t.*,a.capability_epoch,n.version AS settings_version,n.events_json,n.bindings_json
   FROM wb_persistent_tasks t JOIN wb_agents a ON a.agent_id=t.agent_id AND a.owner_id=t.owner_id
   JOIN wb_task_notification_settings n ON n.task_id=t.task_id AND n.owner_id=t.owner_id
   JOIN wb_task_occurrences o ON o.task_id=t.task_id AND o.generation=t.generation
   WHERE t.owner_id=? AND t.task_id=? AND o.occurrence_id=?`).get(owner,taskId,occurrenceId) as Row|undefined;
  if(!row)return;
  this.db.prepare('INSERT INTO wb_task_notification_scopes VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(occurrenceId,owner,taskId,row.generation,row.version,row.agent_id,row.capability_epoch,row.settings_version,row.events_json,row.bindings_json,this.now());
 }
 recordPageChange(occurrenceId:string,previous:string,next:string,url:string){
  if(!this.db.isTransaction)throw new Error('task_notification_transaction_required');
  const scope=scopeCurrent(this.db,occurrenceId);if(!scope||!(JSON.parse(scope.events_json) as string[]).includes('changed'))return;
  const row=this.db.prepare(`SELECT o.*,t.baseline_hash,t.trigger_json FROM wb_task_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id WHERE o.occurrence_id=?`).get(occurrenceId) as Row;
  if(!/^[a-f0-9]{64}$/.test(previous)||!/^[a-f0-9]{64}$/.test(next)||previous===next||row.baseline_hash!==previous||JSON.parse(row.trigger_json).kind!=='page_change'||!JSON.parse(row.evidence_json).some((e:Row)=>e.kind==='page_snapshot'&&e.reference===url&&e.hash===next))throw new Error('task_notification_source_invalid');
  this.db.prepare('INSERT INTO wb_task_page_change_notices VALUES(?,?,?,?,?,?)').run(occurrenceId,row.run_id,previous,next,url,this.now());
 }
 private emit(event:Row):number {
  return withImmediateTransaction(this.db,()=>{
   const scope=scopeCurrent(this.db,event.occurrence_id);if(!scope||!(JSON.parse(scope.events_json) as string[]).includes(event.kind)||!sourceCurrent(this.db,event,this.now()))return 0;
   if(this.db.prepare('SELECT 1 FROM wb_task_notification_events WHERE occurrence_id=? AND kind=? AND source_ref=?').get(event.occurrence_id,event.kind,event.source_ref))return 0;
   const eventId='notice-'+createHash('sha256').update(JSON.stringify([scope.occurrence_id,event.kind,event.source_ref])).digest('hex').slice(0,32);
   let detail='';
   if(event.kind==='changed'){const proof=this.db.prepare('SELECT url FROM wb_task_page_change_notices WHERE occurrence_id=?').get(scope.occurrence_id) as {url:string};detail=`监控的页面有变化：${proof.url}`;}
   else if(event.kind==='failed')detail='这次执行失败，请在工作台查看原因和恢复选项。';
   else {const binding=this.db.prepare('SELECT purpose FROM wb_task_wait_interactions WHERE interaction_id=?').get(event.source_ref) as {purpose:string};detail=binding.purpose==='task_input'?'需要你补充信息，任务已保留当前进度。':'有一个结果或操作需要你确认，任务已保留当前进度。';}
   const body=`任务「${scope.title}」\n${detail}\n请在工作台打开本次执行查看详情。`;
   this.db.prepare('INSERT INTO wb_task_notification_events VALUES(?,?,?,?,?,?,?,?)').run(eventId,scope.occurrence_id,event.run_id,event.kind,event.source_ref,event.source_version,body,this.now());
   const store=new ChannelDeliveryService(this.db,()=>Math.floor(Date.parse(this.now())/1000)),notifications=new TaskNotifications(this.db);
   const conversation=this.db.prepare('SELECT conversation_id FROM ga_runs WHERE id=?').get(event.run_id) as {conversation_id:string};let emitted=0;
   for(const saved of JSON.parse(scope.bindings_json) as Array<{channel_binding_id:string;version:number}>){
    const binding=this.db.prepare("SELECT * FROM ga_owner_channel_bindings WHERE channel_binding_id=? AND owner_id=? AND status='verified' AND version=?").get(saved.channel_binding_id,scope.owner_id,saved.version) as Row|undefined;
    if(!binding||!['wecom','email'].includes(String(binding.channel)))continue;
    const delivery=store.enqueueText({runId:event.run_id,messageId:eventId,destination:binding.channel as 'wecom'|'email',recipient:binding.principal,text:body})!;
    store.bindTaskAuthorization(String(delivery.effect_id),scope as any,conversation.conversation_id,binding.principal);
    notifications.grant(String(delivery.effect_id),scope.owner_id,scope.task_id,{channel_binding_id:saved.channel_binding_id,version:saved.version,settings_version:scope.settings_version,channel:binding.channel,principal:binding.principal});
    this.db.prepare('INSERT INTO wb_task_notification_event_links VALUES(?,?)').run(String(delivery.effect_id),eventId);emitted++;
   }
   return emitted;
  });
 }
 maintain():{emitted:number} {
  if(!this.db.prepare('SELECT 1 FROM wb_task_notification_scopes LIMIT 1').get())return {emitted:0};
  // Bound scans by undelivered causal sources, not by the first historical tasks.
  const rows=this.db.prepare(`WITH live AS (SELECT s.* FROM wb_task_notification_scopes s
    JOIN wb_persistent_tasks t ON t.task_id=s.task_id AND t.owner_id=s.owner_id AND t.version=s.task_version AND t.generation=s.generation AND t.status IN ('active','budget_exhausted')
    JOIN wb_task_occurrences o ON o.occurrence_id=s.occurrence_id AND o.generation=s.generation
    JOIN wb_agents a ON a.agent_id=s.agent_id AND a.owner_id=s.owner_id AND a.status='active' AND a.capability_epoch=s.epoch
    JOIN wb_task_notification_settings n ON n.task_id=s.task_id AND n.owner_id=s.owner_id AND n.version=s.settings_version)
   SELECT p.occurrence_id,p.run_id,'changed' AS kind,p.occurrence_id AS source_ref,0 AS source_version FROM wb_task_page_change_notices p JOIN live s ON s.occurrence_id=p.occurrence_id
    WHERE NOT EXISTS(SELECT 1 FROM wb_task_notification_events e WHERE e.occurrence_id=p.occurrence_id AND e.kind='changed')
   UNION ALL SELECT o.occurrence_id,r.id,'failed',r.id,r.version FROM wb_task_current_occurrences o JOIN ga_runs r ON r.id=o.run_id
    JOIN live s ON s.occurrence_id=o.occurrence_id WHERE r.status='failed' AND COALESCE(r.reason_code,'')!='OUTCOME_UNKNOWN'
     AND EXISTS(SELECT 1 FROM json_each(s.events_json) WHERE value='failed') AND NOT EXISTS(SELECT 1 FROM wb_task_notification_events e WHERE e.occurrence_id=o.occurrence_id AND e.kind='failed' AND e.source_ref=r.id)
   UNION ALL SELECT o.occurrence_id,r.id,'needs_confirmation',i.id,i.version FROM wb_task_current_occurrences o JOIN ga_runs r ON r.id=o.run_id
    JOIN live s ON s.occurrence_id=o.occurrence_id JOIN wb_task_wait_interactions w ON w.run_id=r.id AND w.expected_run_version=r.version AND w.checkpoint_id=r.checkpoint_id JOIN ga_interactions i ON i.id=w.interaction_id
    JOIN ga_session_checkpoints cp ON cp.checkpoint_id=w.checkpoint_id AND cp.run_id=r.id
    WHERE r.status IN ('waiting_user','waiting_approval') AND i.status='pending' AND i.expires_at>?
     AND EXISTS(SELECT 1 FROM json_each(s.events_json) WHERE value='needs_confirmation') AND NOT EXISTS(SELECT 1 FROM wb_task_notification_events e WHERE e.occurrence_id=o.occurrence_id AND e.kind='needs_confirmation' AND e.source_ref=i.id)
   LIMIT 50`).all(this.now()) as Row[];
  let emitted=0;for(const row of rows)emitted+=this.emit(row);return {emitted};
 }
}
