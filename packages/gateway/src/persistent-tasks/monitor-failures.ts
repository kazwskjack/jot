import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {installHostNotifications,enqueueHostFailure} from './host-notifications.ts';
type Row=Record<string,any>;

/** Trusted scheduler faults before a model run exists. These are not execution
 * occurrences or business results; notification transport must use a separate
 * non-run authorization path rather than fabricate a ga_run. */
export class TaskMonitorFailures {
 private readonly db:DatabaseSync;
 private readonly now:()=>string;
 constructor(db:DatabaseSync,now:()=>string){
  this.db=db;this.now=now;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_monitor_failure_episodes (
   episode_id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES wb_persistent_tasks(task_id),owner_id TEXT NOT NULL,
   generation INTEGER NOT NULL,task_version INTEGER NOT NULL,reason_code TEXT NOT NULL,
   notification_scope_json TEXT,started_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_task_monitor_failure_active (
   task_id TEXT PRIMARY KEY REFERENCES wb_persistent_tasks(task_id),episode_id TEXT NOT NULL UNIQUE REFERENCES wb_task_monitor_failure_episodes(episode_id));
   CREATE TABLE IF NOT EXISTS wb_task_monitor_failure_resolutions (
   episode_id TEXT PRIMARY KEY REFERENCES wb_task_monitor_failure_episodes(episode_id),reason TEXT NOT NULL,resolved_at TEXT NOT NULL);`);
  for(const table of ['wb_task_monitor_failure_episodes','wb_task_monitor_failure_resolutions'])for(const op of ['update','delete'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${op} BEFORE ${op.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'monitor_failure_evidence_immutable'); END;`);
  installHostNotifications(db);
 }
 private assertTransaction(){if(!this.db.isTransaction)throw new Error('monitor_failure_transaction_required');}
 record(task:Row,reason:string){
  this.assertTransaction();
  const active=this.db.prepare(`SELECT e.* FROM wb_task_monitor_failure_active a JOIN wb_task_monitor_failure_episodes e ON e.episode_id=a.episode_id WHERE a.task_id=?`).get(task.task_id) as Row|undefined;
  if(active?.generation===task.generation)return;
  if(active)this.resolve(task.task_id,'generation_changed');
  let scope:string|null=null;
  const settings=this.db.prepare('SELECT * FROM wb_task_notification_settings WHERE task_id=? AND owner_id=?').get(task.task_id,task.owner_id) as Row|undefined;
  if(settings&&JSON.parse(settings.events_json).includes('failed')&&JSON.parse(settings.bindings_json).length){
   // No channel principal or credential is copied to the fault ledger.
   const role=this.db.prepare("SELECT capability_epoch FROM wb_agents WHERE agent_id=? AND owner_id=? AND status='active'").get(task.agent_id,task.owner_id) as Row|undefined;
   if(role)scope=JSON.stringify({settings_version:settings.version,agent_id:task.agent_id,epoch:role.capability_epoch,bindings:JSON.parse(settings.bindings_json)});
  }
  const id='monitor-failure-'+randomUUID();
  this.db.prepare('INSERT INTO wb_task_monitor_failure_episodes VALUES(?,?,?,?,?,?,?,?)').run(id,task.task_id,task.owner_id,task.generation,task.version,reason,scope,this.now());
  this.db.prepare('INSERT INTO wb_task_monitor_failure_active VALUES(?,?)').run(task.task_id,id);
  enqueueHostFailure(this.db,id,this.now());
 }
 resolve(taskId:string,reason='recovered'){
  this.assertTransaction();const active=this.db.prepare('SELECT episode_id FROM wb_task_monitor_failure_active WHERE task_id=?').get(taskId) as Row|undefined;if(!active)return;
  this.db.prepare('INSERT INTO wb_task_monitor_failure_resolutions VALUES(?,?,?)').run(active.episode_id,reason,this.now());
  this.db.prepare('DELETE FROM wb_task_monitor_failure_active WHERE task_id=?').run(taskId);
 }
 resolveRevoked(){
  this.assertTransaction();
  const rows=this.db.prepare(`SELECT a.task_id FROM wb_task_monitor_failure_active a JOIN wb_task_monitor_failure_episodes e ON e.episode_id=a.episode_id
   JOIN wb_persistent_tasks t ON t.task_id=e.task_id WHERE t.status!='active' OR t.generation!=e.generation`).all() as Row[];
  for(const row of rows)this.resolve(row.task_id,'task_revoked');
 }
}
