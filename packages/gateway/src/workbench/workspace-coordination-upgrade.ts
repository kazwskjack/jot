import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {retainOriginalGitDatabase} from '../git/database-identity.ts';

type Row=Record<string,any>;
const original='wb_workspace_reservations',replacement='wb_workspace_reservations_publication_upgrade';
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
function normalized(sql:string){
 const text=sql.replace(/^(CREATE\s+TABLE)\s+IF\s+NOT\s+EXISTS\s+/i,'$1 ').replaceAll('"'+original+'"',original);
 let output='',quoted='';
 for(let index=0;index<text.length;index++){
  const character=text[index]!;
  if(quoted){
   output+=character;
   if(character===quoted){if(text[index+1]===quoted){output+=text[++index];}else quoted='';}
  }else if(character==="'"||character==='"'||character==='`'){quoted=character;output+=character;}
  else if(!/[ \t\n\r\f]/.test(character))output+=character;
 }
 return output.replace(/;$/,'');
}
function definition(name:string,publication:boolean){return `CREATE TABLE ${quote(name)}(
 reservation_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,
 operation_kind TEXT NOT NULL CHECK(operation_kind IN(${publication?"'git_index','work_publication'":"'git_index'"})),operation_id TEXT NOT NULL,
 binding_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,record_sha256 TEXT NOT NULL,UNIQUE(operation_kind,operation_id))`;}
function exists(db:DatabaseSync,name:string){return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name);}
export function workspacePublicationSchema(db:DatabaseSync):'legacy'|'publication'|'unsupported'{
 const row=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(original) as {sql:string}|undefined;
 if(!row)return 'unsupported';for(const [kind,enabled] of [['legacy',false],['publication',true]] as const)if(normalized(row.sql)===normalized(definition(original,enabled)))return kind;return 'unsupported';
}
function fail(code:string):never{throw Error('workspace_publication_upgrade_'+code);}
function quiescent(db:DatabaseSync){
 const any=(sql:string)=>!!db.prepare(sql).get();
 if(any('SELECT 1 FROM ga_worker_leases LIMIT 1')||any("SELECT 1 FROM ga_runs WHERE status IN('queued','starting','running','waiting_user','waiting_approval','cancelling') LIMIT 1")
  ||any('SELECT 1 FROM wb_workspace_reservations r LEFT JOIN wb_workspace_reservation_releases x ON x.reservation_id=r.reservation_id WHERE x.reservation_id IS NULL LIMIT 1'))fail('busy');
 if(exists(db,'wb_isolated_file_pending')&&any('SELECT 1 FROM wb_isolated_file_pending LIMIT 1'))fail('busy');
 if(exists(db,'wb_model_budget_attempts')&&any("SELECT 1 FROM wb_model_budget_attempts WHERE state IN('reserved','in_flight','unknown') OR bound_exceeded=1 LIMIT 1"))fail('busy');
 if(exists(db,'wb_agent_messages')&&any("SELECT 1 FROM wb_agent_messages WHERE status IN('processing','outcome_unknown') LIMIT 1"))fail('busy');
 if(exists(db,'wb_git_index_executions')){
  for(const name of ['wb_git_index_outcomes','wb_git_index_dispositions','wb_git_index_producers','wb_git_index_producer_finishes'])if(!exists(db,name))fail('storage_unconfirmed');
  if(any('SELECT 1 FROM wb_git_index_executions e WHERE NOT EXISTS(SELECT 1 FROM wb_git_index_outcomes o WHERE o.execution_id=e.execution_id) AND NOT EXISTS(SELECT 1 FROM wb_git_index_dispositions d WHERE d.execution_id=e.execution_id) LIMIT 1')
   ||any('SELECT 1 FROM wb_git_index_producers p WHERE NOT EXISTS(SELECT 1 FROM wb_git_index_producer_finishes f WHERE f.execution_id=p.execution_id) LIMIT 1'))fail('busy');
 }
 if(exists(db,'wb_native_child_reservations')){
  for(const name of ['wb_native_child_closures','wb_native_creation_aborts'])if(!exists(db,name))fail('storage_unconfirmed');
  if(any('SELECT 1 FROM wb_native_child_reservations r WHERE NOT EXISTS(SELECT 1 FROM wb_native_child_closures c WHERE c.reservation_id=r.reservation_id) AND NOT EXISTS(SELECT 1 FROM wb_native_creation_aborts a WHERE a.reservation_id=r.reservation_id) LIMIT 1'))fail('busy');
 }
 if(exists(db,'wb_native_child_activations')){
  if(!exists(db,'wb_native_activation_closures'))fail('storage_unconfirmed');
  if(any('SELECT 1 FROM wb_native_child_activations a WHERE NOT EXISTS(SELECT 1 FROM wb_native_activation_closures c WHERE c.run_id=a.run_id) LIMIT 1'))fail('busy');
 }
}
function objects(db:DatabaseSync){return db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Row[];}
function dependencies(db:DatabaseSync){
 const tables=(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(row=>row.name),selected=new Set([original]);let changed=true;
 while(changed){changed=false;for(const table of tables){if(selected.has(table))continue;const refs=db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(table) as Row[];if(refs.some(row=>selected.has(String(row.table)))){selected.add(table);changed=true;}}}return [...selected].sort();
}
function inventory(db:DatabaseSync,tables:readonly string[]){return tables.map(table=>{
 const columns=db.prepare('SELECT name,pk FROM pragma_table_info(?) ORDER BY cid').all(table) as {name:string;pk:number}[],pk=columns.filter(row=>row.pk).sort((a,b)=>a.pk-b.pk),order=(pk.length?pk:columns).map(row=>quote(row.name)).join(',');
 const hash=createHash('sha256');let count=0;for(const row of db.prepare('SELECT * FROM '+quote(table)+' ORDER BY '+order).iterate()){hash.update(canonicalJson(row)+'\0');count++;}
 return{table,rows:count,sha256:hash.digest('hex')};
});}
export type WorkspaceUpgradePhase='captured'|'copied'|'recreated'|'verified';
/** Trusted OFFLINE maintenance only. Durable DB checks do not prove that idle
 * native processes or external pools stopped. No automatic bootstrap, live
 * force override, producer lease, publication permission or repair is supplied. */
export function upgradeWorkspacePublicationCoordination(db:DatabaseSync,options:{onPhase?:(phase:WorkspaceUpgradePhase)=>void}={}){
 if(db.isTransaction)fail('transaction');if(Object.keys(options).some(key=>key!=='onPhase')||options.onPhase!==undefined&&(typeof options.onPhase!=='function'||options.onPhase.constructor.name==='AsyncFunction'))fail('invalid');
 const identity=retainOriginalGitDatabase(db),kind=workspacePublicationSchema(db);if(kind==='unsupported')fail('schema_unsupported');
 if(kind==='publication')return{protocol:1 as const,state:'already_current' as const,execution_authorized:false as const,offline_pool_drain_observed:false as const};
 const foreignKeys=Number((db.prepare('PRAGMA foreign_keys').get() as Row).foreign_keys),legacy=Number((db.prepare('PRAGMA legacy_alter_table').get() as Row).legacy_alter_table);
 if(foreignKeys!==1||Number((db.prepare('PRAGMA writable_schema').get() as Row).writable_schema)!==0||db.prepare("SELECT 1 FROM sqlite_temp_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())fail('connection_unconfirmed');
 if(db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(replacement))fail('replacement_exists');
 quiescent(db);if(db.prepare('PRAGMA foreign_key_check').all().length)fail('integrity');
 const phase=(name:WorkspaceUpgradePhase)=>{const result=options.onPhase?.(name) as unknown;if(result!==undefined){if(result&&typeof(result as {then?:unknown}).then==='function')Promise.resolve(result).catch(()=>{});fail('async_callback');}};
 // SQLite's documented generalized table-change sequence. Only this isolated
 // maintenance connection changes FK policy; all flags are restored on failure.
 db.exec('PRAGMA foreign_keys=OFF');
 try{
  db.exec('BEGIN IMMEDIATE');identity.assertCurrent();if(workspacePublicationSchema(db)!=='legacy')fail('schema_changed');quiescent(db);
  const beforeObjects=objects(db),tables=dependencies(db),before=inventory(db,tables),beforeChanges=Number((db.prepare('SELECT total_changes() n').get() as Row).n);
  phase('captured');
  // Keep original definitions, including triggers attached to OTHER tables and
  // dependent views, rather than leaving broken references during the rename.
  for(const object of beforeObjects.filter(row=>row.type==='trigger'))db.exec('DROP TRIGGER '+quote(object.name));
  for(const object of beforeObjects.filter(row=>row.type==='view'))db.exec('DROP VIEW '+quote(object.name));
  db.exec(definition(replacement,true));db.exec('INSERT INTO '+quote(replacement)+' SELECT * FROM '+quote(original));phase('copied');
  db.exec('DROP TABLE '+quote(original));db.exec('ALTER TABLE '+quote(replacement)+' RENAME TO '+quote(original));
  for(const object of beforeObjects.filter(row=>row.type==='index'&&row.tbl_name===original))db.exec(object.sql);
  for(const type of ['view','trigger'])for(const object of beforeObjects.filter(row=>row.type===type))db.exec(object.sql);
  phase('recreated');identity.assertCurrent();
  if(workspacePublicationSchema(db)!=='publication'||db.prepare('PRAGMA foreign_key_check').all().length||canonicalJson(inventory(db,tables))!==canonicalJson(before))fail('integrity');
  const afterObjects=objects(db);if(afterObjects.length!==beforeObjects.length)fail('schema_changed');
  for(let index=0;index<beforeObjects.length;index++){
   const a=beforeObjects[index]!,b=afterObjects[index]!;if(a.name!==b.name||a.type!==b.type||a.tbl_name!==b.tbl_name||a.name!==original&&a.sql!==b.sql)fail('schema_changed');
  }
  const parentRows=before.find(row=>row.table===original)!.rows;
  if(Number((db.prepare('SELECT total_changes() n').get() as Row).n)!==beforeChanges+parentRows)fail('unexpected_write');
  phase('verified');identity.assertCurrent();
  // Recheck after the optional synchronous observer as well.
  if(canonicalJson(objects(db))!==canonicalJson(afterObjects)||db.prepare('PRAGMA foreign_key_check').all().length||canonicalJson(inventory(db,tables))!==canonicalJson(before)||Number((db.prepare('SELECT total_changes() n').get() as Row).n)!==beforeChanges+parentRows)fail('integrity');
  db.exec('COMMIT');
  return{protocol:1 as const,state:'upgraded' as const,database_sha256:identity.sha256,retained:before,execution_authorized:false as const,offline_pool_drain_observed:false as const};
 }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
 finally{db.exec('PRAGMA legacy_alter_table='+legacy);db.exec('PRAGMA foreign_keys='+foreignKeys);}
}
