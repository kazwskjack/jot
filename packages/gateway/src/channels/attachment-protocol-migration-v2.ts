import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
const versionedMessage=`CASE WHEN json_valid(input_message.content_json) THEN json_type(input_message.content_json,'$.protocol') IS NOT NULL
 AND NOT(json_type(input_message.content_json,'$.protocol')='integer' AND json_extract(input_message.content_json,'$.protocol')=1) ELSE 0 END`;
export const CHANNEL_VERSIONED_INPUT_SQL=`EXISTS(SELECT 1 FROM ga_messages input_message WHERE input_message.id=r.input_message_id AND ${versionedMessage})`;
const versionedLease=`(EXISTS(SELECT 1 FROM ga_channel_message_events e WHERE e.run_id=NEW.resource_id AND e.content_protocol=2)
 OR EXISTS(SELECT 1 FROM ga_runs r WHERE r.id=NEW.resource_id AND ${CHANNEL_VERSIONED_INPUT_SQL}))`;
const insertLease=`CREATE TRIGGER ga_channel_v2_lease_insert BEFORE INSERT ON ga_worker_leases
 WHEN ${versionedLease}
 AND NEW.channel_protocol_generation IS NOT NEW.generation
 BEGIN SELECT RAISE(ABORT,'channel_attachment_reader_upgrade_required'); END`;
const updateLease=`CREATE TRIGGER ga_channel_v2_lease_update BEFORE UPDATE OF owner,generation,channel_protocol_generation ON ga_worker_leases
 WHEN ${versionedLease}
 AND NEW.channel_protocol_generation IS NOT NEW.generation
 BEGIN SELECT RAISE(ABORT,'channel_attachment_reader_upgrade_required'); END`;
const immutableEvent=`CREATE TRIGGER ga_channel_v2_event_immutable BEFORE UPDATE ON ga_channel_message_events
 WHEN OLD.content_protocol=2 BEGIN SELECT RAISE(ABORT,'channel_attachment_event_immutable'); END`;
const definitions=[['ga_channel_v2_lease_insert',insertLease],['ga_channel_v2_lease_update',updateLease],['ga_channel_v2_event_immutable',immutableEvent]] as const;
export function channelAttachmentProtocolV2Installed(db:DatabaseSync){return db.prepare('PRAGMA table_info(ga_channel_message_events)').all().some(row=>row.name==='content_protocol');}
export function validateChannelAttachmentProtocolV2(db:DatabaseSync){
 if(!channelAttachmentProtocolV2Installed(db))return;
 const event=db.prepare('PRAGMA table_info(ga_channel_message_events)').all().find(row=>row.name==='content_protocol'),lease=db.prepare('PRAGMA table_info(ga_worker_leases)').all().find(row=>row.name==='channel_protocol_generation');
 if(event?.type!=='INTEGER'||event.notnull!==1||String(event.dflt_value)!=='1'||lease?.type!=='INTEGER')throw Error('channel_attachment_protocol_schema_invalid');
 const normalize=(sql:string)=>sql.replace(/\s+/g,' ').trim();
 for(const [name,sql]of definitions){const actual=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);if(!actual||normalize(String(actual.sql))!==normalize(sql))throw Error('channel_attachment_protocol_schema_invalid');}
 if(db.prepare('SELECT 1 FROM ga_channel_message_events WHERE content_protocol NOT IN(1,2) LIMIT 1').get())throw Error('channel_attachment_protocol_schema_invalid');
}
/** Original schema only. Old authority validators reject the added event column;
 * lease-generation triggers also fence already-running old workers. */
export function enableChannelAttachmentProtocolV2(db:DatabaseSync){
 withImmediateTransaction(db,()=>{
  if(channelAttachmentProtocolV2Installed(db)){validateChannelAttachmentProtocolV2(db);return;}
  if(db.prepare("SELECT 1 FROM ga_channel_message_events WHERE CASE WHEN json_valid(attachments_json) THEN json_extract(attachments_json,'$.protocol')=2 ELSE 0 END LIMIT 1").get())throw Error('channel_attachment_protocol_upgrade_unproven');
  db.exec('ALTER TABLE ga_channel_message_events ADD COLUMN content_protocol INTEGER NOT NULL DEFAULT 1 CHECK(content_protocol IN(1,2))');
  if(!db.prepare('PRAGMA table_info(ga_worker_leases)').all().some(row=>row.name==='channel_protocol_generation'))db.exec('ALTER TABLE ga_worker_leases ADD COLUMN channel_protocol_generation INTEGER');
  for(const [,sql]of definitions)db.exec(sql);validateChannelAttachmentProtocolV2(db);
 });
}
/** An explicit offline operator action; it never discards v2 provenance to make
 * an older binary start. Original v2 records/tombstones require a v2 reader. */
export function downgradeUnusedChannelAttachmentProtocolV2(db:DatabaseSync,now=Date.now()){
 return withImmediateTransaction(db,()=>{
  if(!channelAttachmentProtocolV2Installed(db))return{protocol:1 as const,state:'unchanged' as const};
  validateChannelAttachmentProtocolV2(db);
  if(db.prepare('SELECT 1 FROM ga_channel_message_events WHERE content_protocol=2 LIMIT 1').get()||db.prepare('SELECT 1 FROM ga_uploads WHERE channel_stage_key IS NOT NULL LIMIT 1').get()||db.prepare(`SELECT 1 FROM ga_messages input_message WHERE ${versionedMessage} LIMIT 1`).get())throw Error('channel_attachment_downgrade_requires_v2_reader');
  if(db.prepare('SELECT 1 FROM ga_worker_leases WHERE CAST(expires_at AS INTEGER)>? LIMIT 1').get(now)||db.prepare("SELECT 1 FROM ga_runs WHERE status IN('starting','running','waiting_user','waiting_approval','cancelling') LIMIT 1").get())throw Error('channel_attachment_downgrade_requires_quiescence');
  for(const [name]of definitions)db.exec('DROP TRIGGER '+name);
  db.exec('ALTER TABLE ga_channel_message_events DROP COLUMN content_protocol');
  db.exec('ALTER TABLE ga_worker_leases DROP COLUMN channel_protocol_generation');
  return{protocol:1 as const,state:'downgraded_unused' as const};
 });
}
