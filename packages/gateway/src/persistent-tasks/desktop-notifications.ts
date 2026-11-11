import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {TaskNotifications,normalizeNotificationEvents} from './notifications.ts';

type Row=Record<string,any>;
const scopeTable='wb_task_desktop_notification_scopes',pageTable='wb_task_desktop_page_notices',eventTable='wb_task_desktop_notification_events';
/** Host evidence only. Recording a desktop event neither sends it nor grants an external channel effect. */
export class DesktopTaskNotificationSource {
 private readonly settings:TaskNotifications;
 constructor(private readonly db:DatabaseSync,private readonly now:()=>string){
  this.settings=new TaskNotifications(db);
  db.exec(`CREATE TABLE IF NOT EXISTS ${scopeTable} (
   occurrence_id TEXT PRIMARY KEY REFERENCES wb_task_occurrences(occurrence_id),owner_id TEXT NOT NULL,task_id TEXT NOT NULL,
   generation INTEGER NOT NULL,task_version INTEGER NOT NULL,agent_id TEXT NOT NULL,epoch INTEGER NOT NULL,
   settings_version INTEGER NOT NULL,events_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ${pageTable} (
   occurrence_id TEXT PRIMARY KEY REFERENCES ${scopeTable}(occurrence_id),run_id TEXT NOT NULL,
   previous_hash TEXT NOT NULL,next_hash TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ${eventTable} (
   sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,
   occurrence_id TEXT NOT NULL REFERENCES ${scopeTable}(occurrence_id),run_id TEXT NOT NULL,
   kind TEXT NOT NULL CHECK(kind IN ('changed','completed','failed','needs_confirmation')),
   source_ref TEXT NOT NULL,source_version INTEGER NOT NULL,created_at TEXT NOT NULL,
   UNIQUE(occurrence_id,kind,source_ref,source_version));
   CREATE INDEX IF NOT EXISTS wb_task_desktop_notification_owner ON ${scopeTable}(owner_id,occurrence_id);`);
  for(const table of [scopeTable,pageTable,eventTable])for(const operation of ['update','delete'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${operation} BEFORE ${operation.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'desktop_notification_evidence_immutable'); END;`);
 }
 private has(name:string){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(name);}
 capture(owner:string,taskId:string,occurrenceId:string){
  if(!this.db.isTransaction)throw Error('task_notification_transaction_required');
  // Isolated/in-memory role adapters have no durable role proof; do not invent one.
  if(!this.has('wb_agents'))return;
  const row=this.db.prepare(`SELECT t.*,a.capability_epoch FROM wb_persistent_tasks t
   JOIN wb_agents a ON a.agent_id=t.agent_id AND a.owner_id=t.owner_id AND a.status='active'
   JOIN wb_task_occurrences o ON o.task_id=t.task_id AND o.generation=t.generation
   JOIN ga_runs r ON r.id=o.run_id AND r.conversation_id=o.conversation_id
   JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=t.owner_id
   WHERE t.owner_id=? AND t.task_id=? AND o.occurrence_id=? AND t.status IN ('active','budget_exhausted')`).get(owner,taskId,occurrenceId) as Row|undefined;
  if(!row)return;
  const settings=this.settings.get(owner,taskId);
  const events=normalizeNotificationEvents(settings.events);
  if(!events.length)return;
  this.db.prepare(`INSERT INTO ${scopeTable} VALUES(?,?,?,?,?,?,?,?,?,?)`).run(occurrenceId,owner,taskId,row.generation,row.version,row.agent_id,row.capability_epoch,settings.version,JSON.stringify(events),this.now());
 }
 private live(){return `SELECT s.*,t.title FROM ${scopeTable} s
  JOIN wb_persistent_tasks t ON t.task_id=s.task_id AND t.owner_id=s.owner_id AND t.agent_id=s.agent_id
   AND t.version=s.task_version AND t.generation=s.generation AND t.status IN ('active','budget_exhausted')
  JOIN wb_agents a ON a.agent_id=s.agent_id AND a.owner_id=s.owner_id AND a.status='active' AND a.capability_epoch=s.epoch
  JOIN wb_task_occurrences o ON o.occurrence_id=s.occurrence_id AND o.task_id=s.task_id AND o.generation=s.generation
  LEFT JOIN wb_task_notification_settings n ON n.task_id=s.task_id AND n.owner_id=s.owner_id
  WHERE COALESCE(n.version,0)=s.settings_version AND COALESCE(n.events_json,'["completed"]')=s.events_json`;}
 recordPageChange(occurrenceId:string,previous:string,next:string,url:string){
  if(!this.db.isTransaction)throw Error('task_notification_transaction_required');
  if(!this.has('wb_agents'))return;
  const scope=this.db.prepare(`WITH live AS (${this.live()}) SELECT * FROM live WHERE occurrence_id=?`).get(occurrenceId) as Row|undefined;
  if(!scope||!(JSON.parse(scope.events_json) as string[]).includes('changed'))return;
  const row=this.db.prepare(`SELECT o.*,t.baseline_hash,t.trigger_json FROM wb_task_occurrences o JOIN wb_persistent_tasks t ON t.task_id=o.task_id WHERE o.occurrence_id=?`).get(occurrenceId) as Row;
  if(!/^[a-f0-9]{64}$/.test(previous)||!/^[a-f0-9]{64}$/.test(next)||previous===next||row.baseline_hash!==previous||JSON.parse(row.trigger_json).kind!=='page_change'||!JSON.parse(row.evidence_json).some((e:Row)=>e.kind==='page_snapshot'&&e.reference===url&&e.hash===next))throw Error('task_notification_source_invalid');
  this.db.prepare(`INSERT INTO ${pageTable} VALUES(?,?,?,?,?)`).run(occurrenceId,row.run_id,previous,next,this.now());
 }
 private sources(){
  const selected=(kind:string)=>`EXISTS(SELECT 1 FROM json_each(s.events_json) WHERE value='${kind}')`;
  const current=`JOIN live s ON s.occurrence_id=o.occurrence_id JOIN ga_runs r ON r.id=o.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=s.owner_id`;
  const sources=[`SELECT p.occurrence_id,p.run_id,'changed' AS kind,p.occurrence_id AS source_ref,0 AS source_version,p.created_at FROM ${pageTable} p
   JOIN live s ON s.occurrence_id=p.occurrence_id JOIN wb_task_current_occurrences o ON o.occurrence_id=p.occurrence_id AND o.run_id=p.run_id
   JOIN ga_runs r ON r.id=p.run_id JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=s.owner_id
   WHERE p.previous_hash!=p.next_hash AND ${selected('changed')}`,
   `SELECT o.occurrence_id,r.id,'failed',r.id,r.version,r.updated_at FROM wb_task_current_occurrences o ${current}
    WHERE r.status='failed' AND COALESCE(r.reason_code,'')!='OUTCOME_UNKNOWN' AND ${selected('failed')}`];
  if(this.has('wb_task_wait_interactions'))sources.push(`SELECT o.occurrence_id,r.id,'needs_confirmation',i.id,i.version,r.updated_at FROM wb_task_current_occurrences o ${current}
   JOIN wb_task_wait_interactions w ON w.run_id=r.id AND w.expected_run_version=r.version AND w.checkpoint_id=r.checkpoint_id
   JOIN ga_interactions i ON i.id=w.interaction_id AND i.run_id=r.id AND i.conversation_id=r.conversation_id
   JOIN ga_session_checkpoints cp ON cp.checkpoint_id=w.checkpoint_id AND cp.run_id=r.id AND cp.conversation_id=r.conversation_id
   WHERE r.status IN ('waiting_user','waiting_approval') AND i.status='pending' AND i.expires_at>? AND ${selected('needs_confirmation')}`);
  if(this.has('wb_task_finalizations'))sources.push(`SELECT o.occurrence_id,r.id,'completed',f.intent_id,0,f.created_at FROM wb_task_current_occurrences o ${current}
   JOIN wb_task_finalizations f ON f.occurrence_id=o.occurrence_id AND f.run_id=r.id AND f.owner_id=s.owner_id
   JOIN ga_messages m ON m.id=f.message_id AND m.run_id=r.id AND m.conversation_id=r.conversation_id AND m.role='assistant'
   WHERE r.status='succeeded' AND ${selected('completed')}`);
  return sources;
 }
 maintain(){
  if(!this.has('wb_agents')||!this.has('wb_task_current_occurrences'))return {recorded:0};
  return withImmediateTransaction(this.db,()=>{
   const sources=this.sources(),time=this.now();
   const rows=this.db.prepare(`WITH live AS (${this.live()}),sources AS (${sources.join(' UNION ALL ')})
    SELECT source.* FROM sources source WHERE NOT EXISTS(SELECT 1 FROM ${eventTable} e WHERE e.occurrence_id=source.occurrence_id AND e.kind=source.kind AND e.source_ref=source.source_ref AND e.source_version=source.source_version)
    ORDER BY source.created_at,source.occurrence_id,source.kind,source.source_ref,source.source_version LIMIT 50`).all(...(this.has('wb_task_wait_interactions')?[time]:[])) as Row[];
   for(const row of rows){
    const eventId='desktop-notice-'+createHash('sha256').update(JSON.stringify([row.occurrence_id,row.kind,row.source_ref,row.source_version])).digest('hex');
    this.db.prepare(`INSERT INTO ${eventTable}(event_id,occurrence_id,run_id,kind,source_ref,source_version,created_at) VALUES(?,?,?,?,?,?,?)`).run(eventId,row.occurrence_id,row.run_id,row.kind,row.source_ref,row.source_version,row.created_at);
   }
   return {recorded:rows.length};
  });
 }
}
