import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {workCycleOriginCheck} from './work-cycle-schema.ts';

type Column={name:string;notnull:number};
type SchemaObject={type:string;name:string;tbl_name:string;sql:string|null};
const original='wb_discovery_work_cycles',replacement='wb_work_cycles_origin_upgrade';
const sourceColumns=new Map([['admission_id','TEXT'],['report_sha256','TEXT'],['policy_version','INTEGER'],['signal_revision','INTEGER'],['signal_sha256','TEXT']]);
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const fail=(reason:string):never=>{throw Error('work_cycle_origin_migration_'+reason);};
function columns(db:DatabaseSync){return db.prepare('PRAGMA table_info('+quote(original)+')').all() as Column[];}
function required(db:DatabaseSync){
 const fields=columns(db);
 if(!fields.length)return false;
 if([...sourceColumns.keys()].some(name=>!fields.some(field=>field.name===name)))fail('schema_unsupported');
 const count=fields.filter(field=>sourceColumns.has(field.name)&&field.notnull).length;
 if(count!==0&&count!==sourceColumns.size)fail('schema_unsupported');
 return count>0;
}
function objects(db:DatabaseSync){
 return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as SchemaObject[];
}
function inventory(db:DatabaseSync){
 const hash=createHash('sha256');let rows=0;
 for(const row of db.prepare('SELECT CAST(rowid AS TEXT) AS __origin_rowid__,* FROM '+quote(original)+' ORDER BY rowid').iterate()){
  hash.update(canonicalJson(row)+'\0');rows++;
 }
 return {rows,sha256:hash.digest('hex')};
}

/** Startup metadata migration, following the original delivery-table rebuild.
 * Keep original values, rowids and all dependent schema objects in one commit. */
export function migrateWorkCycleOrigins(db:DatabaseSync):void{
 if(!required(db))return;
 if(db.isTransaction)fail('transaction_conflict');
 const foreignKeys=Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys);
 const legacy=Number(db.prepare('PRAGMA legacy_alter_table').get()!.legacy_alter_table);
 try{
  db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON; BEGIN IMMEDIATE');
  // Another startup may have completed the same upgrade before this write lock.
  if(!required(db)){db.exec('COMMIT');return;}
  if(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(replacement))fail('schema_unsupported');
  const fields=columns(db),beforeObjects=objects(db);
  if(fields.some(field=>['rowid','oid','_rowid_','__origin_rowid__'].includes(field.name.toLowerCase())))fail('schema_unsupported');
  const saved=beforeObjects.find(object=>object.type==='table'&&object.name===original)?.sql;
  if(!saved||/WITHOUT\s+ROWID/i.test(saved))fail('schema_unsupported');
  let definition=saved.replace(/^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"wb_discovery_work_cycles"|`wb_discovery_work_cycles`|\[wb_discovery_work_cycles\]|wb_discovery_work_cycles)(?=\s*\()/i,'$1'+quote(replacement));
  if(definition===saved)fail('schema_unsupported');
  for(const [name,type] of sourceColumns){
   const pattern=new RegExp('\\b'+name+'\\s+'+type+'\\s+NOT\\s+NULL\\b','gi');
   if([...definition.matchAll(pattern)].length!==1)fail('schema_unsupported');
   definition=definition.replace(pattern,name+' '+type);
  }
  const closing=definition.lastIndexOf(')');
  if(closing<0||!/^[;\s]*$/.test(definition.slice(closing+1)))fail('schema_unsupported');
  definition=definition.slice(0,closing)+','+workCycleOriginCheck+definition.slice(closing);
  const before=inventory(db),changes=Number(db.prepare('SELECT total_changes() n').get()!.n);
  const names=fields.map(field=>quote(field.name)).join(',');
  db.exec(definition);
  db.exec('INSERT INTO '+quote(replacement)+'(rowid,'+names+') SELECT rowid,'+names+' FROM '+quote(original));
  db.exec('DROP TABLE '+quote(original)+'; ALTER TABLE '+quote(replacement)+' RENAME TO '+quote(original));
  for(const object of beforeObjects){
   if(object.tbl_name===original&&['index','trigger'].includes(object.type)&&object.sql)db.exec(object.sql);
  }
  const afterObjects=objects(db);
  if(afterObjects.length!==beforeObjects.length)fail('schema_changed');
  for(let index=0;index<beforeObjects.length;index++){
   const beforeObject=beforeObjects[index]!,afterObject=afterObjects[index]!;
   if(beforeObject.type!==afterObject.type||beforeObject.name!==afterObject.name||beforeObject.tbl_name!==afterObject.tbl_name
    ||beforeObject.name!==original&&beforeObject.sql!==afterObject.sql)fail('schema_changed');
  }
  if(db.prepare('PRAGMA foreign_key_check').get()||canonicalJson(inventory(db))!==canonicalJson(before)
   ||Number(db.prepare('SELECT total_changes() n').get()!.n)!==changes+before.rows)fail('integrity_failed');
  db.exec('COMMIT');
 }catch(error){
  if(db.isTransaction)db.exec('ROLLBACK');
  throw error;
 }finally{
  db.exec('PRAGMA legacy_alter_table='+legacy+'; PRAGMA foreign_keys='+foreignKeys);
 }
}
