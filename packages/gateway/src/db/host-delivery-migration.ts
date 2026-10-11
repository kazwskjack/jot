import type {DatabaseSync} from 'node:sqlite';
/** Rebuild only the legacy NOT NULL constraint. Startup has no live workers;
 * preserve the original schema, rows and custom indexes/triggers verbatim. */
export function migrateHostDeliveries(db:DatabaseSync):void {
 const column=(db.prepare('PRAGMA table_info(ga_channel_deliveries)').all() as Array<{name:string;notnull:number}>).find(c=>c.name==='run_id');
 if(!column?.notnull)return;
 if(db.isTransaction)throw new Error('host_delivery_migration_transaction_conflict');
 const original=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ga_channel_deliveries'").get() as {sql:string};
 const table=original.sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`\[]?ga_channel_deliveries["`\]]?/i,'CREATE TABLE ga_channel_deliveries_host_upgrade').replace(/\brun_id\s+TEXT\s+NOT\s+NULL\b/i,'run_id TEXT');
 if(table===original.sql||/\brun_id\s+TEXT\s+NOT\s+NULL\b/i.test(table))throw new Error('host_delivery_migration_schema_unsupported');
 const columns=(db.prepare('PRAGMA table_info(ga_channel_deliveries)').all() as Array<{name:string}>).map(c=>'"'+c.name.replaceAll('"','""')+'"').join(',');
 const objects=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='ga_channel_deliveries' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as Array<{sql:string}>;
 const foreignKeys=Number((db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys),legacy=Number((db.prepare('PRAGMA legacy_alter_table').get() as {legacy_alter_table:number}).legacy_alter_table);
 db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE');
 try{
  db.exec(table);db.exec(`INSERT INTO ga_channel_deliveries_host_upgrade(${columns}) SELECT ${columns} FROM ga_channel_deliveries`);
  db.exec('DROP TABLE ga_channel_deliveries; ALTER TABLE ga_channel_deliveries_host_upgrade RENAME TO ga_channel_deliveries');
  for(const object of objects)db.exec(object.sql);
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('host_delivery_migration_foreign_key_failure');
  db.exec('COMMIT');
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 finally{db.exec(`PRAGMA legacy_alter_table=${legacy}; PRAGMA foreign_keys=${foreignKeys}`);}
}
