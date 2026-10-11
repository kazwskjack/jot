import type {DatabaseSync} from 'node:sqlite';
type Row=Record<string,any>;
type Options={now?:string;retentionDays?:number;limit?:number;afterDeliveryId?:string};
const terminal=['delivered','cancelled','failed'];
function options(input:Options){
 const now=Date.parse(input.now??new Date().toISOString()),days=input.retentionDays??90,limit=input.limit??100;
 if(!Number.isFinite(now)||!Number.isInteger(days)||days<30||days>3650||!Number.isInteger(limit)||limit<1||limit>1000||(input.afterDeliveryId!==undefined&&(typeof input.afterDeliveryId!=='string'||input.afterDeliveryId.length>200)))throw new Error('invalid_notification_retention');
 return {now:new Date(now).toISOString(),cutoff:new Date(now-days*86400000).toISOString(),days,limit,after:input.afterDeliveryId??''};
}
function collect(db:DatabaseSync,input:Options,cachesOnly=false,deliveryId?:string){
 const cfg=options(input),has=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type IN ('table','view')").get(name);
 const deferrals=has('wb_task_notification_deferrals'),quiet=has('wb_task_notification_quiet_queue'),digests=has('wb_task_notification_digest_members');
 const cacheCondition=[deferrals?'EXISTS(SELECT 1 FROM wb_task_notification_deferrals d WHERE d.effect_id=e.effect_id)':'0',quiet?'EXISTS(SELECT 1 FROM wb_task_notification_quiet_queue q WHERE q.effect_id=e.effect_id)':'0'].join(' OR ');
 const rows=db.prepare(`SELECT e.effect_id,e.run_id,e.status,e.updated_at,e.lease_owner,e.lease_expires_at,
  COALESCE(length(CAST(e.payload_json AS BLOB)),0) AS payload_bytes,COALESCE(length(CAST(e.provider_receipt_json AS BLOB)),0) AS receipt_bytes,
  CASE WHEN json_valid(e.provider_receipt_json) THEN json_type(e.provider_receipt_json,'$.provider_message_id')='text' AND length(trim(json_extract(e.provider_receipt_json,'$.provider_message_id')))>0 ELSE 0 END AS receipt_valid
  FROM ga_channel_deliveries e WHERE e.effect_id${deliveryId?'=':'>'}? ${cachesOnly?`AND (${cacheCondition})`:''} ORDER BY e.effect_id LIMIT ?`).all(deliveryId??cfg.after,cfg.limit+1) as Row[];
 const taskAuth=has('wb_task_delivery_authorizations'),currentOccurrences=has('wb_task_current_occurrences'),hostAuth=has('wb_task_host_notification_authorizations');
 const candidates=rows.slice(0,cfg.limit).map(row=>{
  const blockers:string[]=[];
  if(!terminal.includes(row.status))blockers.push('nonterminal_delivery');
  const updated=Date.parse(row.updated_at);if(!Number.isFinite(updated)||updated>Date.parse(cfg.now))blockers.push('invalid_delivery_timestamp');else if(updated>=Date.parse(cfg.cutoff))blockers.push('within_retention_period');
  if(row.lease_owner!==null||row.lease_expires_at!==null)blockers.push('delivery_lease_present');
  if(row.status==='delivered'&&!row.receipt_valid)blockers.push('confirmed_receipt_missing');
  if(row.status!=='delivered'&&row.receipt_bytes)blockers.push('partial_provider_receipt_requires_review');
  if(row.run_id!==null){
   const run=db.prepare('SELECT status,reason_code FROM ga_runs WHERE id=?').get(row.run_id) as Row|undefined;
   if(!run||!['succeeded','partial','failed','cancelled','interrupted'].includes(run.status)||run.reason_code==='OUTCOME_UNKNOWN')blockers.push('source_run_not_terminal');
   if(taskAuth&&currentOccurrences&&db.prepare(`SELECT 1 FROM wb_task_delivery_authorizations d JOIN wb_task_current_occurrences o ON o.occurrence_id=d.occurrence_id
    JOIN ga_runs r ON r.id=o.run_id WHERE d.effect_id=? AND (r.status NOT IN ('succeeded','partial','failed','cancelled','interrupted') OR r.reason_code='OUTCOME_UNKNOWN')`).get(row.effect_id))blockers.push('current_occurrence_not_terminal');
  }else{
   const source=hostAuth?db.prepare(`SELECT h.episode_id,r.episode_id AS resolved,a.episode_id AS active FROM wb_task_host_notification_authorizations h LEFT JOIN wb_task_monitor_failure_resolutions r ON r.episode_id=h.episode_id LEFT JOIN wb_task_monitor_failure_active a ON a.episode_id=h.episode_id WHERE h.effect_id=?`).get(row.effect_id) as Row|undefined:undefined;
   if(!source||!source.resolved||source.active)blockers.push('host_fault_not_resolved');
  }
  if(digests&&db.prepare(`SELECT 1 FROM wb_task_notification_digest_members own JOIN wb_task_notification_digest_members member ON member.digest_id=own.digest_id
   JOIN ga_channel_deliveries e ON e.effect_id=member.effect_id LEFT JOIN ga_runs run ON run.id=e.run_id WHERE own.effect_id=? AND
    (e.status NOT IN ('delivered','cancelled','failed') OR julianday(e.updated_at) IS NULL OR julianday(e.updated_at)>=julianday(?) OR e.lease_owner IS NOT NULL OR e.lease_expires_at IS NOT NULL
     OR (e.status='delivered' AND CASE WHEN json_valid(e.provider_receipt_json) THEN COALESCE(json_type(e.provider_receipt_json,'$.provider_message_id')!='text' OR length(trim(json_extract(e.provider_receipt_json,'$.provider_message_id')))=0,1) ELSE 1 END)
     OR (e.status!='delivered' AND e.provider_receipt_json IS NOT NULL)
     OR (e.run_id IS NOT NULL AND (run.id IS NULL OR run.status NOT IN ('succeeded','partial','failed','cancelled','interrupted') OR run.reason_code='OUTCOME_UNKNOWN'))
     OR (e.run_id IS NULL ${hostAuth?`AND NOT EXISTS(SELECT 1 FROM wb_task_host_notification_authorizations h JOIN wb_task_monitor_failure_resolutions resolution ON resolution.episode_id=h.episode_id WHERE h.effect_id=e.effect_id AND NOT EXISTS(SELECT 1 FROM wb_task_monitor_failure_active active WHERE active.episode_id=h.episode_id))`:''})
     ${taskAuth&&currentOccurrences?`OR EXISTS(SELECT 1 FROM wb_task_delivery_authorizations auth JOIN wb_task_current_occurrences occurrence ON occurrence.occurrence_id=auth.occurrence_id JOIN ga_runs leaf ON leaf.id=occurrence.run_id WHERE auth.effect_id=e.effect_id AND (leaf.status NOT IN ('succeeded','partial','failed','cancelled','interrupted') OR leaf.reason_code='OUTCOME_UNKNOWN'))`:''})`).get(row.effect_id,cfg.cutoff))blockers.push('digest_not_fully_cold_and_terminal');
  return {delivery_id:String(row.effect_id),status:String(row.status),payload_bytes:Number(row.payload_bytes),receipt_bytes:Number(row.receipt_bytes),eligible_for_backup:blockers.length===0,cache_prunable:blockers.length===0,protected:true as const,deletable:false as const,backup_verified:false as const,reasons:[...blockers,'archive_restore_verification_missing']};
 });
 return {schema_version:1,mode:'dry-run' as const,observed_at:cfg.now,retention_days:cfg.days,cutoff:cfg.cutoff,scanned_deliveries:candidates.length,next_after_delivery_id:rows.length>cfg.limit?candidates.at(-1)!.delivery_id:null,candidates};
}
/** Exact single-row fence usable inside the archiver's write transaction. */
export function notificationArchiveEligibility(db:DatabaseSync,id:string,input:Options={}){
 if(typeof id!=='string'||!id||id.length>200)throw new Error('invalid_notification_retention');
 return collect(db,input,false,id).candidates[0];
}
export function buildNotificationRetentionPlan(db:DatabaseSync,input:Options={}){
 if(db.isTransaction)throw new Error('notification_retention_requires_own_transaction');
 db.exec('BEGIN');try{const report=collect(db,input);db.exec('COMMIT');return report;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
/** Only disposable waiting indexes. Never remove an effect, receipt, payload,
 * authorization, source, digest or provider-attempt reservation here. */
export function pruneNotificationCaches(db:DatabaseSync,input:Options={}){
 if(db.isTransaction)throw new Error('notification_retention_requires_own_transaction');
 db.exec('BEGIN IMMEDIATE');try{
  const report=collect(db,input,true);let removed_deferrals=0,removed_quiet_entries=0;
  for(const item of report.candidates)if(item.cache_prunable){
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_notification_deferrals'").get())removed_deferrals+=Number(db.prepare('DELETE FROM wb_task_notification_deferrals WHERE effect_id=?').run(item.delivery_id).changes);
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_notification_quiet_queue'").get())removed_quiet_entries+=Number(db.prepare('DELETE FROM wb_task_notification_quiet_queue WHERE effect_id=?').run(item.delivery_id).changes);
  }
  db.exec('COMMIT');return {removed_deferrals,removed_quiet_entries,next_after_delivery_id:report.next_after_delivery_id,scanned_deliveries:report.scanned_deliveries};
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
