import {createHash} from 'node:crypto';import {isAbsolute,resolve} from 'node:path';import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';import {canonicalJson} from '../db/canonical-json.ts';import {NotificationArchiveService} from './notification-archive.ts';import {notificationArchiveEligibility} from './notification-retention.ts';
type Config={root:string;retentionDays:number;batchSize:number};type Row=Record<string,any>;
function validate(config:Config){if(!config||typeof config.root!=='string'||!isAbsolute(config.root)||!Number.isInteger(config.retentionDays)||config.retentionDays<30||config.retentionDays>3650||!Number.isInteger(config.batchSize)||config.batchSize<1||config.batchSize>25)throw new Error('notification_archive_configuration_invalid');return {...config,root:resolve(config.root)};}
export function notificationArchiveMaintenanceConfig(env:Record<string,string|undefined>):Config|undefined{
 const enabled=env.GENERAL_AGENT_NOTIFICATION_ARCHIVE_ENABLED?.trim()??'';if(['','0'].includes(enabled))return undefined;if(enabled!=='1')throw new Error('notification_archive_configuration_invalid');
 return validate({root:env.GENERAL_AGENT_NOTIFICATION_ARCHIVE_ROOT?.trim()??'',retentionDays:Number(env.GENERAL_AGENT_NOTIFICATION_ARCHIVE_RETENTION_DAYS??90),batchSize:Number(env.GENERAL_AGENT_NOTIFICATION_ARCHIVE_BATCH_SIZE??10)});
}
/** Existing host maintenance only: bounded daily scans, durable cursor and no
 * deletion of delivery identities, quotas, authorizations or archive files. */
export class NotificationArchiveMaintenance{
 private readonly db:DatabaseSync;private readonly config:Config;private readonly archive:NotificationArchiveService;private readonly key:string;private readonly now:()=>Date;
 constructor(db:DatabaseSync,config:Config,options:{now?:()=>Date}={}){
  this.db=db;this.config=validate(config);this.now=options.now??(()=>new Date());this.archive=new NotificationArchiveService(db,this.config.root);
  const policy=canonicalJson({revision:1,root:this.config.root,retention_days:this.config.retentionDays});this.key=createHash('sha256').update(policy).digest('hex');
  db.exec('CREATE TABLE IF NOT EXISTS wb_task_notification_archive_maintenance(policy_id TEXT PRIMARY KEY,policy_json TEXT NOT NULL,cursor TEXT NOT NULL,cycle_now TEXT,next_due INTEGER NOT NULL,last_error TEXT,updated_at TEXT NOT NULL);');
  db.prepare("INSERT OR IGNORE INTO wb_task_notification_archive_maintenance VALUES(?,?,'',NULL,0,NULL,?)").run(this.key,policy,this.now().toISOString());
 }
 processNext(){
  if(this.db.isTransaction)throw new Error('notification_maintenance_transaction_forbidden');const date=this.now(),timestamp=Math.floor(date.valueOf()/1000);if(!Number.isSafeInteger(timestamp)||timestamp<0)throw new Error('notification_maintenance_clock_invalid');
  try{return withImmediateTransaction(this.db,()=>{
   const state=this.db.prepare('SELECT * FROM wb_task_notification_archive_maintenance WHERE policy_id=?').get(this.key) as Row;if(state.next_due>timestamp)return {processed:false,scanned:0,archived:0};
   const cycle=state.cycle_now??date.toISOString(),rows=this.db.prepare('SELECT effect_id FROM ga_channel_deliveries WHERE effect_id>? ORDER BY effect_id LIMIT ?').all(state.cursor,this.config.batchSize+1) as Row[],page=rows.slice(0,this.config.batchSize);let archived=0;
   for(const row of page){
    if(this.db.prepare('SELECT 1 FROM wb_task_notification_archives WHERE effect_id=?').get(row.effect_id))continue;
    if(!notificationArchiveEligibility(this.db,row.effect_id,{now:cycle,retentionDays:this.config.retentionDays})?.eligible_for_backup)continue;
    const member=this.db.prepare('SELECT digest_id FROM wb_task_notification_digest_members WHERE effect_id=?').get(row.effect_id) as Row|undefined;
    if(member){const count=this.db.prepare('SELECT count(*) n FROM wb_task_notification_digest_members m LEFT JOIN wb_task_notification_archives a ON a.effect_id=m.effect_id WHERE m.digest_id=? AND a.effect_id IS NULL').get(member.digest_id) as {n:number};this.archive.archiveDigest(member.digest_id,{now:cycle,retentionDays:this.config.retentionDays});archived+=Number(count.n);}
    else{this.archive.archive(row.effect_id,{now:cycle,retentionDays:this.config.retentionDays});archived++;}
   }
   const more=rows.length>this.config.batchSize;this.db.prepare('UPDATE wb_task_notification_archive_maintenance SET cursor=?,cycle_now=?,next_due=?,last_error=NULL,updated_at=? WHERE policy_id=?').run(more?page.at(-1)!.effect_id:'',more?cycle:null,more?0:timestamp+86400,date.toISOString(),this.key);
   return {processed:true,scanned:page.length,archived};
  });}catch(error){
   // Rollback keeps both hot payloads and the previous cursor. Back off instead
   // of retrying a corrupt archive every second; error details stay out of logs.
   try{this.db.prepare('UPDATE wb_task_notification_archive_maintenance SET next_due=?,last_error=?,updated_at=? WHERE policy_id=?').run(timestamp+3600,'notification_archive_maintenance_failed',date.toISOString(),this.key);}catch{/* Keep the original failure and committed state. */}throw error;
  }
 }
}
