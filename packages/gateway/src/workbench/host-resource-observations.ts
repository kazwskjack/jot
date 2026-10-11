import type {DatabaseSync} from 'node:sqlite';

export function readHostResourceObservations(db:DatabaseSync,owner:string,runId:string){
 const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(!table('wb_host_resource_observations')||!table('wb_model_budget_bindings'))throw new Error('host_resource_unavailable');
 const owned=db.prepare('SELECT 1 FROM wb_model_budget_bindings b JOIN ga_runs r ON r.id=b.run_id JOIN ga_conversations c ON c.id=r.conversation_id WHERE b.run_id=? AND b.owner_id=? AND c.owner_id=b.owner_id').get(runId,owner);
 if(!owned)throw new Error('budget_run_forbidden');
 const rows=db.prepare('SELECT attempt_id,state,outcome,measurement_json,started_at,completed_at FROM wb_host_resource_observations WHERE run_id=? AND owner_id=? ORDER BY started_at DESC,attempt_id DESC LIMIT 51').all(runId,owner);
 const items=rows.slice(0,50).map(row=>{
  const measurement=row.measurement_json?JSON.parse(String(row.measurement_json)):null;
  if(measurement&&(Object.keys(measurement).sort().join(',')!=='attribution,cpu_system_us,cpu_user_us,gpu,remote_inference,rss_end_bytes,rss_start_bytes,source,wall_ms'||measurement.source!=='gateway_process_interval'||measurement.attribution!=='shared_process_interval'||measurement.gpu!==null||measurement.remote_inference!==null||!['wall_ms','cpu_user_us','cpu_system_us','rss_start_bytes','rss_end_bytes'].every(key=>Number.isSafeInteger(measurement[key])&&measurement[key]>=0)))throw new Error('host_resource_invalid');
  return {attempt_id:row.attempt_id,state:row.state,outcome:row.outcome,measurement,started_at:row.started_at,completed_at:row.completed_at};
 });
 return {attribution:'shared_process_interval' as const,items,has_more:rows.length>50};
}

/** These are process-interval observations, not exclusive model resource costs.
 * Concurrent work shares the CPU/RSS samples; they must never be summed as a
 * task's dedicated CPU/GPU usage or converted to provider token charges. */
export class HostResourceObservations {
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){
  this.db=db;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_host_resource_observations (
   run_id TEXT NOT NULL,attempt_id TEXT NOT NULL,owner_id TEXT NOT NULL,
   state TEXT NOT NULL CHECK(state IN ('pending','complete')),
   outcome TEXT CHECK(outcome IN ('succeeded','failed')),measurement_json TEXT,
   started_at TEXT NOT NULL,completed_at TEXT,
   PRIMARY KEY(run_id,attempt_id),
   FOREIGN KEY(run_id,attempt_id) REFERENCES wb_model_budget_attempts(run_id,attempt_id));
   CREATE TRIGGER IF NOT EXISTS wb_host_resource_no_update BEFORE UPDATE ON wb_host_resource_observations
   WHEN OLD.state='complete' OR NEW.run_id!=OLD.run_id OR NEW.attempt_id!=OLD.attempt_id OR NEW.owner_id!=OLD.owner_id
    OR NEW.started_at!=OLD.started_at OR NEW.state!='complete' OR NEW.outcome IS NULL OR NEW.measurement_json IS NULL OR NEW.completed_at IS NULL
   BEGIN SELECT RAISE(ABORT,'host_resource_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_host_resource_no_delete BEFORE DELETE ON wb_host_resource_observations
   BEGIN SELECT RAISE(ABORT,'host_resource_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_host_resource_no_replace BEFORE INSERT ON wb_host_resource_observations
   WHEN EXISTS(SELECT 1 FROM wb_host_resource_observations WHERE run_id=NEW.run_id AND attempt_id=NEW.attempt_id)
   BEGIN SELECT RAISE(ABORT,'host_resource_immutable'); END;`);
 }
 async observe<T>(owner:string,runId:string,attemptId:string,invoke:()=>Promise<T>):Promise<T>{
  if(this.db.isTransaction)throw new Error('host_resource_transaction_forbidden');
  this.db.prepare('INSERT INTO wb_host_resource_observations(run_id,attempt_id,owner_id,state,started_at) VALUES(?,?,?,?,?)').run(runId,attemptId,owner,'pending',new Date().toISOString());
  const started=process.hrtime.bigint(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss;
  let outcome='failed';
  try{const result=await invoke();outcome='succeeded';return result;}
  finally{
   try{
    const elapsed=Number(process.hrtime.bigint()-started)/1_000_000,delta=process.cpuUsage(cpu),endRss=process.memoryUsage().rss;
    const measurement={source:'gateway_process_interval',attribution:'shared_process_interval',wall_ms:Math.ceil(elapsed),cpu_user_us:delta.user,cpu_system_us:delta.system,rss_start_bytes:rss,rss_end_bytes:endRss,gpu:null,remote_inference:null};
    if(![measurement.wall_ms,delta.user,delta.system,rss,endRss].every(value=>Number.isSafeInteger(value)&&value>=0))throw new Error();const changed=this.db.prepare("UPDATE wb_host_resource_observations SET state='complete',outcome=?,measurement_json=?,completed_at=? WHERE run_id=? AND attempt_id=? AND owner_id=? AND state='pending'").run(outcome,JSON.stringify(measurement),new Date().toISOString(),runId,attemptId,owner);if(changed.changes!==1)throw new Error();
   }catch{
    // Keep the durable pending row. A missing process observation is not zero,
    // but it must not erase valid provider usage or trigger another model call.
   }
  }
 }
 report(owner:string,runId:string){return readHostResourceObservations(this.db,owner,runId);}
}
