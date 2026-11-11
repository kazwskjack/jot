import {createHash} from 'node:crypto';
import {normalizeNotificationJournal,notificationJournalScope} from './notification-journal.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
/** Uses the original backend's already-owned connection; never opens or closes a database. */
export class DesktopNotificationJournalStore{
 constructor(db){
  if(!db||typeof db.prepare!=='function'||typeof db.exec!=='function')throw Error('desktop_notification_journal_unavailable');
  if(db.isTransaction)throw Error('desktop_notification_journal_transaction_conflict');
  this.db=db;
  db.exec(`CREATE TABLE IF NOT EXISTS desktop_notification_journals(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>0),snapshot_json TEXT NOT NULL,snapshot_sha256 TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS desktop_notification_journal_imports(scope TEXT NOT NULL,legacy_sha256 TEXT NOT NULL,imported_revision INTEGER NOT NULL,legacy_json TEXT NOT NULL,PRIMARY KEY(scope,legacy_sha256));
   CREATE TRIGGER IF NOT EXISTS desktop_notification_import_no_update BEFORE UPDATE ON desktop_notification_journal_imports BEGIN SELECT RAISE(ABORT,'desktop_notification_import_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS desktop_notification_import_no_delete BEFORE DELETE ON desktop_notification_journal_imports BEGIN SELECT RAISE(ABORT,'desktop_notification_import_immutable'); END;`);
 }
 read(scope){
  notificationJournalScope(scope);
  const row=this.db.prepare('SELECT * FROM desktop_notification_journals WHERE scope=?').get(scope);
  if(!row){if(this.db.prepare('SELECT 1 FROM desktop_notification_journal_imports WHERE scope=? LIMIT 1').get(scope))throw Error('desktop_notification_journal_corrupt');return {protocol:1,scope,revision:0,journal:null};}
  if(!Number.isSafeInteger(row.revision)||row.revision<1||typeof row.snapshot_json!=='string'||row.snapshot_json.length>131072||digest(row.snapshot_json)!==row.snapshot_sha256)throw Error('desktop_notification_journal_corrupt');
  return {protocol:1,scope,revision:row.revision,journal:normalizeNotificationJournal(JSON.parse(row.snapshot_json))};
 }
 transaction(operation){
  if(this.db.isTransaction)throw Error('desktop_notification_journal_transaction_conflict');
  this.db.exec('BEGIN IMMEDIATE');try{const result=operation();this.db.exec('COMMIT');return result;}catch(error){try{this.db.exec('ROLLBACK');}catch{throw Error('desktop_notification_journal_rollback_failed',{cause:error});}throw error;}
 }
 write(scope,revision,journal){
  notificationJournalScope(scope);if(!Number.isSafeInteger(revision)||revision<0||revision>=Number.MAX_SAFE_INTEGER)throw Error('desktop_notification_journal_conflict');
  const normalized=normalizeNotificationJournal(journal),raw=JSON.stringify(normalized),sha=digest(raw);
  return this.transaction(()=>{
   const current=this.read(scope);if(current.revision!==revision)throw Error('desktop_notification_journal_conflict');
   this.db.prepare('INSERT INTO desktop_notification_journals VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,snapshot_json=excluded.snapshot_json,snapshot_sha256=excluded.snapshot_sha256').run(scope,revision+1,raw,sha);
   return this.read(scope);
  });
 }
 adopt(scope,journal){
  notificationJournalScope(scope);const normalized=normalizeNotificationJournal(journal),raw=JSON.stringify(normalized),sha=digest(raw);
  return this.transaction(()=>{
   const current=this.read(scope),prior=this.db.prepare('SELECT legacy_json FROM desktop_notification_journal_imports WHERE scope=? AND legacy_sha256=?').get(scope,sha);
   if(prior){if(prior.legacy_json!==raw||!current.journal)throw Error('desktop_notification_journal_corrupt');return current;}
   if(current.journal&&JSON.stringify(current.journal)!==raw)throw Error('desktop_notification_migration_conflict');
   if(!current.journal)this.db.prepare('INSERT INTO desktop_notification_journals VALUES(?,?,?,?)').run(scope,1,raw,sha);
   const saved=this.read(scope);
   this.db.prepare('INSERT INTO desktop_notification_journal_imports VALUES(?,?,?,?)').run(scope,sha,saved.revision,raw);
   return saved;
  });
 }
}
