import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';

/** Version-2 extension of the original upload table. No second staging store. */
const definition=(batchDefinition:string)=>`CREATE TABLE ga_uploads (
 id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES ga_conversations(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL,status TEXT NOT NULL,server_path TEXT NOT NULL,filename TEXT NOT NULL,
 declared_size INTEGER NOT NULL,received_size INTEGER NOT NULL DEFAULT 0,declared_sha256 TEXT,
 actual_sha256 TEXT,mime_type TEXT,created_at TEXT NOT NULL,completed_at TEXT,
 writer_token TEXT,writer_lease_until TEXT,
 channel_stage_key TEXT,channel_request_sha256 TEXT,channel_source_json TEXT,
 channel_part_index INTEGER,channel_expires_at TEXT,channel_cleanup_after TEXT${batchDefinition}
)`;
const original=['id','conversation_id','owner_id','status','server_path','filename','declared_size','received_size','declared_sha256','actual_sha256','mime_type','created_at','completed_at','writer_token','writer_lease_until'];
const extension=['channel_stage_key','channel_request_sha256','channel_source_json','channel_part_index','channel_expires_at'];
const batch=['batch_id','client_file_id','relative_path','expires_at'];
export function installChannelUploadStages(db:DatabaseSync){
 withImmediateTransaction(db,()=>{
  const columns=db.prepare('PRAGMA table_info(ga_uploads)').all();
  if(columns.some(c=>![...original,...extension,...batch,'channel_cleanup_after'].includes(String(c.name)))||original.some(name=>!columns.some(c=>c.name===name)))throw Error('channel_upload_schema_unrecognized');
  const batchCount=batch.filter(name=>columns.some(c=>c.name===name)).length;
  if(batchCount!==0&&batchCount!==batch.length)throw Error('channel_upload_schema_partial');
  const count=extension.filter(name=>columns.some(c=>c.name===name)).length;
  if(count!==0&&count!==extension.length)throw Error('channel_upload_schema_partial');
  const conversation=columns.find(c=>c.name==='conversation_id');
  if(count===0||conversation?.notnull===1){
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE tbl_name='ga_uploads' AND type IN('trigger','index') AND sql IS NOT NULL").get())throw Error('channel_upload_schema_custom_objects');
   const batchForeignKey=db.prepare('PRAGMA foreign_key_list(ga_uploads)').all().some(row=>row.from==='batch_id'&&row.table==='ga_upload_batches'&&row.to==='id'&&row.on_delete==='CASCADE')
    ?' REFERENCES ga_upload_batches(id) ON DELETE CASCADE':'';
   const batchDefinition=batchCount?`,batch_id TEXT${batchForeignKey},client_file_id TEXT,relative_path TEXT,expires_at TEXT`:'';
   db.exec('ALTER TABLE ga_uploads RENAME TO ga_uploads_channel_v1');db.exec(definition(batchDefinition));
   const selected=[...original,...(count?extension:[]),...(batchCount?batch:[])];
   db.exec(`INSERT INTO ga_uploads(${selected.join(',')}) SELECT ${selected.join(',')} FROM ga_uploads_channel_v1`);
   db.exec('DROP TABLE ga_uploads_channel_v1');
  }
  if(!db.prepare('PRAGMA table_info(ga_uploads)').all().some(row=>row.name==='channel_cleanup_after'))db.exec('ALTER TABLE ga_uploads ADD COLUMN channel_cleanup_after TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ga_channel_upload_part ON ga_uploads(channel_stage_key,channel_part_index) WHERE channel_stage_key IS NOT NULL;
   CREATE TRIGGER IF NOT EXISTS ga_channel_upload_source_immutable BEFORE UPDATE ON ga_uploads
   WHEN OLD.channel_stage_key IS NOT NULL AND (
    NEW.id IS NOT OLD.id OR NEW.owner_id IS NOT OLD.owner_id OR NEW.filename IS NOT OLD.filename
    OR NEW.declared_size IS NOT OLD.declared_size OR NEW.declared_sha256 IS NOT OLD.declared_sha256 OR NEW.mime_type IS NOT OLD.mime_type
    OR NEW.channel_stage_key IS NOT OLD.channel_stage_key OR NEW.channel_request_sha256 IS NOT OLD.channel_request_sha256
    OR NEW.channel_source_json IS NOT OLD.channel_source_json OR NEW.channel_part_index IS NOT OLD.channel_part_index OR NEW.channel_expires_at IS NOT OLD.channel_expires_at
    OR (NEW.conversation_id IS NOT OLD.conversation_id AND (OLD.conversation_id IS NOT NULL OR NEW.conversation_id IS NOT json_extract(OLD.channel_source_json,'$.conversation_id'))))
   BEGIN SELECT RAISE(ABORT,'channel_upload_source_immutable'); END;`);
 });
}
