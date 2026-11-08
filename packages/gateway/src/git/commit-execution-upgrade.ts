import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {retainOriginalGitDatabase} from './database-identity.ts';
import {assertWorkspacePublicationMaintenance,assertOriginalWorkspaceQuiescence,originalWorkspaceMaintenanceSnapshot} from '../workbench/workspace-coordination-upgrade.ts';

const original='wb_git_index_executions',replacement=original+'_commit_upgrade';
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const fail=(reason:string):never=>{throw Error('git_commit_upgrade_'+reason);};
export type GitCommitExecutionSchema='absent'|'legacy'|'commit'|'unsupported';

/** The original execution table owns commit rows under protocol 5. The original
 * index journal interprets protocols 1–4. */
export function gitCommitExecutionDefinition(table:string,commit:boolean,ifMissing=false){
 if(![original,replacement].includes(table))fail('definition_invalid');
 return `CREATE TABLE ${ifMissing?'IF NOT EXISTS ':''}${quote(table)}(
  execution_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,
  intent_id TEXT NOT NULL UNIQUE REFERENCES wb_git_mutation_intents(intent_id),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,
  review_version INTEGER NOT NULL,review_sha256 TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN(${commit?"'stage','unstage','commit'":"'stage','unstage'"})),
  witness_sha256 TEXT NOT NULL,repository_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,protocol INTEGER NOT NULL DEFAULT 1,binding_sha256 TEXT,
  UNIQUE(owner_id,project_id,request_id)${commit?",CHECK(action!='commit' OR protocol=5)":''})`;
}
function normalized(sql:string){
 const source=sql.replace(/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/i,'CREATE TABLE ').replaceAll(quote(original),original).replace(/;$/,'');
 let result='',quoted=false;
 for(const character of source){
  if(character==="'")quoted=!quoted;
  if(quoted||character==="'"||!/\s/.test(character))result+=character;
 }
 return result;
}
export function gitCommitExecutionSchema(db:DatabaseSync):GitCommitExecutionSchema{
 const row=db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(original);
 if(!row)return 'absent';
 if(row.type!=='table'||typeof row.sql!=='string')return 'unsupported';
 if(normalized(row.sql)===normalized(gitCommitExecutionDefinition(original,false)))return 'legacy';
 if(normalized(row.sql)===normalized(gitCommitExecutionDefinition(original,true)))return 'commit';
 return 'unsupported';
}
function executionRowids(db:DatabaseSync){
 const hash=createHash('sha256');let count=0;
 for(const row of db.prepare('SELECT CAST(rowid AS TEXT) AS original_rowid,execution_id FROM '+quote(original)+' ORDER BY rowid').iterate()){
  hash.update(canonicalJson(row)+'\0');count++;
 }
 return {count,sha256:hash.digest('hex')};
}
function changeSchema(db:DatabaseSync,commit:boolean){
 if(db.isTransaction)fail('transaction_active');
 const identity=retainOriginalGitDatabase(db),initial=gitCommitExecutionSchema(db),target=commit?'commit':'legacy';
 if(initial==='absent'||initial==='unsupported')fail('schema_unsupported');
 assertWorkspacePublicationMaintenance(db);
 const foreignKeys=Number(db.prepare('PRAGMA foreign_keys').get()!.foreign_keys);
 const legacy=Number(db.prepare('PRAGMA legacy_alter_table').get()!.legacy_alter_table);
 if(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(replacement))fail('replacement_exists');
 try{
  db.exec('PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON;');
  db.exec('BEGIN IMMEDIATE');identity.assertCurrent();assertOriginalWorkspaceQuiescence(db);
  if(gitCommitExecutionSchema(db)!==initial)fail('schema_changed');
  if(!commit&&db.prepare("SELECT 1 FROM wb_git_index_executions WHERE action='commit' OR protocol>=5 LIMIT 1").get())fail('rollback_requires_commit_reader');
  const before=originalWorkspaceMaintenanceSnapshot(db),rowids=executionRowids(db);
  if(initial!==target){
   for(const object of before.schema.filter(object=>object.type==='trigger'))db.exec('DROP TRIGGER '+quote(String(object.name)));
   for(const object of before.schema.filter(object=>object.type==='view'))db.exec('DROP VIEW '+quote(String(object.name)));
   db.exec(gitCommitExecutionDefinition(replacement,commit));
   const columns=db.prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid').all(original).map(column=>quote(String(column.name))).join(',');
   db.exec('INSERT INTO '+quote(replacement)+'(rowid,'+columns+') SELECT rowid,'+columns+' FROM '+quote(original));
   db.exec('DROP TABLE '+quote(original));db.exec('ALTER TABLE '+quote(replacement)+' RENAME TO '+quote(original));
   for(const object of before.schema.filter(object=>object.type==='index'&&object.tbl_name===original&&object.sql))db.exec(String(object.sql));
   for(const kind of ['view','trigger'])for(const object of before.schema.filter(object=>object.type===kind&&object.sql))db.exec(String(object.sql));
  }
  const after=originalWorkspaceMaintenanceSnapshot(db);
  if(gitCommitExecutionSchema(db)!==target||canonicalJson(before.rows)!==canonicalJson(after.rows))fail('rows_changed');
  if(canonicalJson(rowids)!==canonicalJson(executionRowids(db)))fail('rowids_changed');
  if(before.schema.length!==after.schema.length)fail('objects_changed');
  for(let index=0;index<before.schema.length;index++){
   const left=before.schema[index]!,right=after.schema[index]!;
   if(left.type!==right.type||left.name!==right.name||left.tbl_name!==right.tbl_name||left.name!==original&&left.sql!==right.sql)fail('objects_changed');
  }
  if(db.prepare('PRAGMA foreign_key_check').all().length)fail('foreign_keys_changed');
  identity.assertCurrent();assertOriginalWorkspaceQuiescence(db);
  if(Number(db.prepare('PRAGMA writable_schema').get()!.writable_schema)!==0||db.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())fail('connection_changed');
  db.exec('COMMIT');
  return Object.freeze({protocol:1,schema:target,changed:initial!==target,database_sha256:identity.sha256,
   inventory_sha256:createHash('sha256').update(canonicalJson(before.rows)).digest('hex'),retained:before.rows,execution_rowids_sha256:rowids.sha256,
   execution_authorized:false,offline_pool_drain_observed:false});
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 finally{db.exec('PRAGMA legacy_alter_table='+legacy+'; PRAGMA foreign_keys='+foreignKeys+';');}
}
export function upgradeGitCommitExecutionSchema(db:DatabaseSync){return changeSchema(db,true);}
export function rollbackGitCommitExecutionSchema(db:DatabaseSync){return changeSchema(db,false);}
