import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {notificationArchiveEligibility} from './notification-retention.ts';
type Row=Record<string,any>;
export function ensureNotificationArchiveSchema(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_notification_archives(effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),archive_id TEXT NOT NULL,root TEXT NOT NULL,anchor_sha256 TEXT NOT NULL,compressed_sha256 TEXT NOT NULL,original_bytes INTEGER NOT NULL,compressed_bytes INTEGER NOT NULL,hot_payload_json TEXT NOT NULL,hot_receipt_json TEXT,local_state TEXT NOT NULL CHECK(local_state IN ('compacted','materialized')),created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS wb_task_notification_archive_no_delete BEFORE DELETE ON wb_task_notification_archives BEGIN SELECT RAISE(ABORT,'notification_archive_anchor_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_task_notification_archive_no_edit BEFORE UPDATE ON wb_task_notification_archives
 WHEN NEW.effect_id IS NOT OLD.effect_id OR NEW.archive_id IS NOT OLD.archive_id OR NEW.root IS NOT OLD.root OR NEW.anchor_sha256 IS NOT OLD.anchor_sha256 OR NEW.compressed_sha256 IS NOT OLD.compressed_sha256 OR NEW.original_bytes IS NOT OLD.original_bytes OR NEW.compressed_bytes IS NOT OLD.compressed_bytes OR NEW.hot_payload_json IS NOT OLD.hot_payload_json OR NEW.hot_receipt_json IS NOT OLD.hot_receipt_json OR NEW.created_at IS NOT OLD.created_at
 BEGIN SELECT RAISE(ABORT,'notification_archive_anchor_immutable'); END;`);
 db.exec(`CREATE TABLE IF NOT EXISTS wb_task_notification_digest_archives(digest_id TEXT PRIMARY KEY REFERENCES wb_task_notification_digests(digest_id),archive_id TEXT NOT NULL,root TEXT NOT NULL,anchor_sha256 TEXT NOT NULL,compressed_sha256 TEXT NOT NULL,original_bytes INTEGER NOT NULL,compressed_bytes INTEGER NOT NULL,hot_text TEXT NOT NULL,member_count INTEGER NOT NULL,local_state TEXT NOT NULL CHECK(local_state IN ('compacted','materialized')),restore_text TEXT,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS wb_task_notification_digest_archive_no_delete BEFORE DELETE ON wb_task_notification_digest_archives BEGIN SELECT RAISE(ABORT,'notification_digest_archive_immutable'); END;
 CREATE TRIGGER IF NOT EXISTS wb_task_notification_digest_archive_no_edit BEFORE UPDATE ON wb_task_notification_digest_archives
 WHEN NEW.digest_id IS NOT OLD.digest_id OR NEW.archive_id IS NOT OLD.archive_id OR NEW.root IS NOT OLD.root OR NEW.anchor_sha256 IS NOT OLD.anchor_sha256 OR NEW.compressed_sha256 IS NOT OLD.compressed_sha256 OR NEW.original_bytes IS NOT OLD.original_bytes OR NEW.compressed_bytes IS NOT OLD.compressed_bytes OR NEW.hot_text IS NOT OLD.hot_text OR NEW.member_count IS NOT OLD.member_count OR NEW.created_at IS NOT OLD.created_at
 BEGIN SELECT RAISE(ABORT,'notification_digest_archive_immutable'); END;`);
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_notification_digests'").get())db.exec(`DROP TRIGGER IF EXISTS wb_task_notification_digest_no_update;
 CREATE TRIGGER IF NOT EXISTS wb_task_notification_digest_archive_update BEFORE UPDATE ON wb_task_notification_digests
 WHEN NEW.digest_id IS NOT OLD.digest_id OR NEW.anchor_effect_id IS NOT OLD.anchor_effect_id OR NEW.payload_sha256 IS NOT OLD.payload_sha256 OR NEW.created_at IS NOT OLD.created_at OR
 (NEW.payload_text IS NOT OLD.payload_text AND NOT EXISTS(SELECT 1 FROM wb_task_notification_digest_archives a WHERE a.digest_id=OLD.digest_id AND (NEW.payload_text=a.hot_text OR NEW.payload_text=a.restore_text)))
 BEGIN SELECT RAISE(ABORT,'notification_digest_immutable'); END;`);
}
const maximum=16*1024*1024;
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
function anchor(row:Row){const {payload_json,provider_receipt_json,...identity}=row;return sha(canonicalJson(identity));}
function safeFile(root:string,id:string){
 if(!/^[a-f0-9]{64}$/.test(id)||resolve(root)!==root)throw new Error('notification_archive_path_denied');
 const path=resolve(root,id+'.json.gz');if(!path.startsWith(root+sep))throw new Error('notification_archive_path_denied');
 for(let current=path;;){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('notification_archive_path_denied');const parent=dirname(current);if(parent===current)break;current=parent;}
 return path;
}
function contents(record:Row,row:Row){
 if(anchor(row)!==record.anchor_sha256)throw new Error('notification_archive_anchor_changed');
 try{
  const path=safeFile(record.root,record.archive_id);if(statSync(path).size!==record.compressed_bytes||record.compressed_bytes>maximum)throw new Error();const compressed=readFileSync(path);if(sha(compressed)!==record.compressed_sha256)throw new Error();
  const bytes=gunzipSync(compressed,{maxOutputLength:maximum});if(bytes.length!==record.original_bytes||sha(bytes)!==record.archive_id)throw new Error();
  const data=JSON.parse(bytes.toString('utf8'));if(canonicalJson(data)!==bytes.toString('utf8')||Object.keys(data).sort().join(',')!=='anchor_sha256,effect_id,payload_json,provider_receipt_json,schema_version'||data.schema_version!==1||data.effect_id!==row.effect_id||data.anchor_sha256!==record.anchor_sha256||![data.payload_json,data.provider_receipt_json].every(value=>value===null||typeof value==='string'))throw new Error();return data as Row;
 }catch(error){if(error instanceof Error&&error.message==='notification_archive_path_denied')throw error;throw new Error('notification_archive_corrupt');}
}
function digestInfo(db:DatabaseSync,id:string){
 const row=db.prepare('SELECT * FROM wb_task_notification_digests WHERE digest_id=?').get(id) as Row|undefined;if(!row)throw new Error('notification_archive_not_found');
 const members=db.prepare('SELECT * FROM wb_task_notification_digest_members WHERE digest_id=? ORDER BY ordinal').all(id) as Row[];
 const {payload_text,...identity}=row;
 const identities=members.map(member=>{const effect=db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get(member.effect_id) as Row|undefined;if(!effect)throw new Error('notification_archive_anchor_changed');return {member,effect_anchor:anchor(effect)};});
 return {row,members,anchor:sha(canonicalJson({identity,members:identities}))};
}
function digestContents(db:DatabaseSync,record:Row){
 const info=digestInfo(db,record.digest_id);if(info.anchor!==record.anchor_sha256||info.members.length!==record.member_count)throw new Error('notification_archive_anchor_changed');
 try{
  const path=safeFile(record.root,record.archive_id),size=statSync(path).size;if(size!==record.compressed_bytes||size>maximum)throw new Error();
  const compressed=readFileSync(path);if(sha(compressed)!==record.compressed_sha256)throw new Error();const bytes=gunzipSync(compressed,{maxOutputLength:maximum});if(bytes.length!==record.original_bytes||sha(bytes)!==record.archive_id)throw new Error();
  const data=JSON.parse(bytes.toString('utf8'));if(canonicalJson(data)!==bytes.toString('utf8')||Object.keys(data).sort().join(',')!=='anchor_sha256,digest_id,kind,payload_sha256,payload_text,schema_version'||data.schema_version!==1||data.kind!=='notification_digest'||data.digest_id!==record.digest_id||data.anchor_sha256!==info.anchor||typeof data.payload_text!=='string'||sha(data.payload_text)!==info.row.payload_sha256||data.payload_sha256!==info.row.payload_sha256)throw new Error();
  return {info,data};
 }catch(error){if(error instanceof Error&&error.message==='notification_archive_path_denied')throw error;throw new Error('notification_archive_corrupt');}
}
export function resolveNotificationDigestArchive(db:DatabaseSync,row:Row):Row{
 const record=db.prepare('SELECT * FROM wb_task_notification_digest_archives WHERE digest_id=?').get(row.digest_id) as Row|undefined;
 if(!record||record.local_state!=='compacted')return row;
 if(row.payload_text!==record.hot_text)throw new Error('notification_archive_anchor_changed');
 return {...row,payload_text:digestContents(db,record).data.payload_text};
}
/** Host snapshot verification. An override is for an offline bundle copy only;
 * it never rewrites live anchors or grants send authority. */
export function notificationArchiveFiles(db:DatabaseSync,rootOverride?:string|((original:string)=>string)){
 const mappedRoot=(record:Row)=>rootOverride?{root:resolve(typeof rootOverride==='function'?rootOverride(String(record.root)):rootOverride)}:{};
 const files:Array<{archive_id:string;root:string;compressed_sha256:string;compressed_bytes:number}>=[];
 const has=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(has('wb_task_notification_archives'))for(const record of db.prepare('SELECT * FROM wb_task_notification_archives').all() as Row[]){
  const row=db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get(record.effect_id) as Row|undefined;if(!row)throw new Error('notification_archive_anchor_changed');const selected={...record,...mappedRoot(record)},data=contents(selected,row);
  if(row.payload_json!==(record.local_state==='compacted'?record.hot_payload_json:data.payload_json)||row.provider_receipt_json!==(record.local_state==='compacted'?record.hot_receipt_json:data.provider_receipt_json))throw new Error('notification_archive_anchor_changed');
  files.push({archive_id:record.archive_id,root:String(selected.root),compressed_sha256:record.compressed_sha256,compressed_bytes:Number(record.compressed_bytes)});
 }
 if(has('wb_task_notification_digest_archives'))for(const record of db.prepare('SELECT * FROM wb_task_notification_digest_archives').all() as Row[]){
  const selected={...record,...mappedRoot(record)},{info,data}=digestContents(db,selected);if(info.row.payload_text!==(record.local_state==='compacted'?record.hot_text:data.payload_text))throw new Error('notification_archive_anchor_changed');
  files.push({archive_id:record.archive_id,root:String(selected.root),compressed_sha256:record.compressed_sha256,compressed_bytes:Number(record.compressed_bytes)});
 }
 return files;
}
/** Read-through is offline and read-only. It never creates a delivery attempt. */
export function resolveNotificationArchive(db:DatabaseSync,row:Row):Row{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_notification_archives'").get())return row;
 const record=db.prepare('SELECT * FROM wb_task_notification_archives WHERE effect_id=?').get(row.effect_id) as Row|undefined;if(!record||record.local_state!=='compacted')return row;
 if(row.payload_json!==record.hot_payload_json||row.provider_receipt_json!==record.hot_receipt_json)throw new Error('notification_archive_anchor_changed');const data=contents(record,row);return {...row,payload_json:data.payload_json,provider_receipt_json:data.provider_receipt_json};
}
/** Privileged explicit maintenance, not a browser API or a sending capability.
 * Hot identity, source, generation, authorization and deduplication remain. */
export class NotificationArchiveService{
 private readonly db:DatabaseSync;private readonly root:string;
 constructor(db:DatabaseSync,root:string){this.db=db;this.root=resolve(root);safeFile(this.root,'0'.repeat(64));mkdirSync(this.root,{recursive:true,mode:0o700});
  ensureNotificationArchiveSchema(db);
 }
 archive(id:string,options:{now?:string;retentionDays?:number}={}){return withImmediateTransaction(this.db,()=>{
  const row=this.db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get(id) as Row|undefined;if(!row)throw new Error('delivery_not_found');
  const prior=this.db.prepare('SELECT * FROM wb_task_notification_archives WHERE effect_id=?').get(id) as Row|undefined;
  if(prior){if(prior.root!==this.root)throw new Error('notification_archive_path_denied');const data=contents(prior,row);if(prior.local_state==='compacted'?(row.payload_json!==prior.hot_payload_json||row.provider_receipt_json!==prior.hot_receipt_json):(row.payload_json!==data.payload_json||row.provider_receipt_json!==data.provider_receipt_json))throw new Error('notification_archive_anchor_changed');return this.receipt(prior);}
  if(!notificationArchiveEligibility(this.db,id,options)?.eligible_for_backup)throw new Error('notification_archive_protected');
  const serialized=canonicalJson({schema_version:1,effect_id:id,anchor_sha256:anchor(row),payload_json:row.payload_json,provider_receipt_json:row.provider_receipt_json});const originalBytes=Buffer.byteLength(serialized,'utf8');if(originalBytes>maximum)throw new Error('notification_archive_too_large');
  const archiveId=sha(serialized),compressed=gzipSync(serialized),path=safeFile(this.root,archiveId);
  // A failed DB transaction may leave this content-addressed orphan. It is not
  // registered as verified and the hot content is not removed in that case.
  if(!existsSync(path))writeFileSync(path,compressed,{flag:'wx',mode:0o600});
  const hotPayload=canonicalJson({kind:'archived_notification',archive_id:archiveId}),receipt=row.provider_receipt_json?JSON.parse(row.provider_receipt_json):null;
  const hotReceipt=receipt?JSON.stringify({provider_message_id:receipt.provider_message_id}):null;
  const record={effect_id:id,archive_id:archiveId,root:this.root,anchor_sha256:anchor(row),compressed_sha256:sha(compressed),original_bytes:originalBytes,compressed_bytes:compressed.length,hot_payload_json:hotPayload,hot_receipt_json:hotReceipt,local_state:'compacted',created_at:new Date().toISOString()};contents(record,row);
  this.db.prepare('INSERT INTO wb_task_notification_archives VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,archiveId,this.root,record.anchor_sha256,record.compressed_sha256,originalBytes,compressed.length,hotPayload,hotReceipt,'compacted',record.created_at);
  this.db.prepare('UPDATE ga_channel_deliveries SET payload_json=?,provider_receipt_json=? WHERE effect_id=?').run(hotPayload,hotReceipt,id);return this.receipt(record);
 });}
 private receipt(record:Row){return {delivery_id:record.effect_id,archive_id:record.archive_id,verified:true,compacted:record.local_state==='compacted',original_bytes:Number(record.original_bytes),compressed_bytes:Number(record.compressed_bytes)};}
 restore(id:string){return withImmediateTransaction(this.db,()=>{
  const row=this.db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get(id) as Row|undefined,record=this.db.prepare('SELECT * FROM wb_task_notification_archives WHERE effect_id=?').get(id) as Row|undefined;if(!row||!record)throw new Error('notification_archive_not_found');
  if(record.root!==this.root)throw new Error('notification_archive_path_denied');const data=contents(record,row);if(record.local_state==='materialized'){if(row.payload_json!==data.payload_json||row.provider_receipt_json!==data.provider_receipt_json)throw new Error('notification_archive_anchor_changed');return {delivery_id:id,restored:false};}
  if(row.payload_json!==record.hot_payload_json||row.provider_receipt_json!==record.hot_receipt_json)throw new Error('notification_archive_anchor_changed');
  this.db.prepare('UPDATE ga_channel_deliveries SET payload_json=?,provider_receipt_json=? WHERE effect_id=?').run(data.payload_json,data.provider_receipt_json,id);this.db.prepare("UPDATE wb_task_notification_archives SET local_state='materialized' WHERE effect_id=?").run(id);return {delivery_id:id,restored:true};
 });}
 archiveDigest(id:string,options:{now?:string;retentionDays?:number}={}){return withImmediateTransaction(this.db,()=>{
  const info=digestInfo(this.db,id),prior=this.db.prepare('SELECT * FROM wb_task_notification_digest_archives WHERE digest_id=?').get(id) as Row|undefined;
  if(prior){if(prior.root!==this.root)throw new Error('notification_archive_path_denied');const {data}=digestContents(this.db,prior);if(info.row.payload_text!==(prior.local_state==='compacted'?prior.hot_text:data.payload_text))throw new Error('notification_archive_anchor_changed');for(const member of info.members)this.archive(member.effect_id,options);return this.digestReceipt(prior);}
  if(!info.members.length||!info.members.some(member=>member.effect_id===info.row.anchor_effect_id)||info.members.some(member=>!notificationArchiveEligibility(this.db,member.effect_id,options)?.eligible_for_backup))throw new Error('notification_archive_protected');
  if(sha(info.row.payload_text)!==info.row.payload_sha256)throw new Error('notification_archive_corrupt');
  const serialized=canonicalJson({schema_version:1,kind:'notification_digest',digest_id:id,anchor_sha256:info.anchor,payload_text:info.row.payload_text,payload_sha256:info.row.payload_sha256}),originalBytes=Buffer.byteLength(serialized);if(originalBytes>maximum)throw new Error('notification_archive_too_large');
  const archiveId=sha(serialized),compressed=gzipSync(serialized),path=safeFile(this.root,archiveId);if(!existsSync(path))writeFileSync(path,compressed,{flag:'wx',mode:0o600});
  const record={digest_id:id,archive_id:archiveId,root:this.root,anchor_sha256:info.anchor,compressed_sha256:sha(compressed),original_bytes:originalBytes,compressed_bytes:compressed.length,hot_text:canonicalJson({kind:'archived_notification_digest',archive_id:archiveId}),member_count:info.members.length,local_state:'compacted',created_at:new Date().toISOString()};digestContents(this.db,record);
  for(const member of info.members)this.archive(member.effect_id,options);
  this.db.prepare('INSERT INTO wb_task_notification_digest_archives VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)').run(id,archiveId,this.root,record.anchor_sha256,record.compressed_sha256,originalBytes,compressed.length,record.hot_text,record.member_count,'compacted',record.created_at);
  this.db.prepare('UPDATE wb_task_notification_digests SET payload_text=? WHERE digest_id=?').run(record.hot_text,id);return this.digestReceipt(record);
 });}
 private digestReceipt(record:Row){return {digest_id:record.digest_id,archive_id:record.archive_id,verified:true,compacted:record.local_state==='compacted',member_count:Number(record.member_count),original_bytes:Number(record.original_bytes),compressed_bytes:Number(record.compressed_bytes)};}
 restoreDigest(id:string){return withImmediateTransaction(this.db,()=>{
  const record=this.db.prepare('SELECT * FROM wb_task_notification_digest_archives WHERE digest_id=?').get(id) as Row|undefined;if(!record)throw new Error('notification_archive_not_found');if(record.root!==this.root)throw new Error('notification_archive_path_denied');
  const {info,data}=digestContents(this.db,record);if(info.row.payload_text!==(record.local_state==='compacted'?record.hot_text:data.payload_text))throw new Error('notification_archive_anchor_changed');
  for(const member of info.members)this.restore(member.effect_id);
  if(record.local_state==='materialized')return {digest_id:id,restored:false};
  this.db.prepare('UPDATE wb_task_notification_digest_archives SET restore_text=? WHERE digest_id=?').run(data.payload_text,id);
  this.db.prepare('UPDATE wb_task_notification_digests SET payload_text=? WHERE digest_id=?').run(data.payload_text,id);
  this.db.prepare("UPDATE wb_task_notification_digest_archives SET restore_text=NULL,local_state='materialized' WHERE digest_id=?").run(id);return {digest_id:id,restored:true};
 });}
}
