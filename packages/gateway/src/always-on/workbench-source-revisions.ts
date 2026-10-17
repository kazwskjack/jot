import type {DatabaseSync} from 'node:sqlite';

const table='wb_project_source_revisions';
const bump=(ref:'OLD'|'NEW')=>`INSERT INTO ${table}(owner_id,workspace_id,project_id,revision) SELECT ${ref}.owner_id,${ref}.workspace_id,${ref}.project_id,0 WHERE NOT EXISTS(SELECT 1 FROM ${table} WHERE owner_id=${ref}.owner_id AND workspace_id=${ref}.workspace_id AND project_id=${ref}.project_id); UPDATE ${table} SET revision=revision+1 WHERE owner_id=${ref}.owner_id AND workspace_id=${ref}.workspace_id AND project_id=${ref}.project_id;`;
const definitions:ReadonlyArray<Readonly<{name:string;type:'table'|'trigger';sql:string}>>=[
 {name:table,type:'table',sql:`CREATE TABLE ${table}(owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),PRIMARY KEY(owner_id,workspace_id,project_id))`},
 {name:'wb_project_source_revision_insert',type:'trigger',sql:`CREATE TRIGGER wb_project_source_revision_insert AFTER INSERT ON wb_files BEGIN ${bump('NEW')} END`},
 {name:'wb_project_source_revision_delete',type:'trigger',sql:`CREATE TRIGGER wb_project_source_revision_delete AFTER DELETE ON wb_files BEGIN ${bump('OLD')} END`},
 {name:'wb_project_source_revision_update',type:'trigger',sql:`CREATE TRIGGER wb_project_source_revision_update AFTER UPDATE ON wb_files BEGIN ${bump('OLD')} INSERT INTO ${table}(owner_id,workspace_id,project_id,revision) SELECT NEW.owner_id,NEW.workspace_id,NEW.project_id,0 WHERE (NEW.owner_id IS NOT OLD.owner_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.project_id IS NOT OLD.project_id) AND NOT EXISTS(SELECT 1 FROM ${table} WHERE owner_id=NEW.owner_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id); UPDATE ${table} SET revision=revision+1 WHERE owner_id=NEW.owner_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id AND (NEW.owner_id IS NOT OLD.owner_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.project_id IS NOT OLD.project_id); END`},
 {name:'wb_project_source_revision_monotonic',type:'trigger',sql:`CREATE TRIGGER wb_project_source_revision_monotonic BEFORE UPDATE ON ${table} WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.project_id IS NOT OLD.project_id OR NEW.revision IS NOT OLD.revision+1 BEGIN SELECT RAISE(ABORT,'source_revision_immutable'); END`},
 {name:'wb_project_source_revision_no_delete',type:'trigger',sql:`CREATE TRIGGER wb_project_source_revision_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'source_revision_immutable'); END`},
 {name:'wb_project_source_revision_no_replace',type:'trigger',sql:`CREATE TRIGGER wb_project_source_revision_no_replace BEFORE INSERT ON ${table} WHEN NEW.revision<>0 OR EXISTS(SELECT 1 FROM ${table} WHERE owner_id=NEW.owner_id AND workspace_id=NEW.workspace_id AND project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'source_revision_immutable'); END`},
];
const validated=new WeakMap<DatabaseSync,number>();
const normal=(sql:string)=>sql.replace(/\bIF NOT EXISTS\s+/gi,'').replace(/\s+/g,' ').trim().replace(/;$/,'');
export type WorkbenchSourceRevision=Readonly<{revision:number;schema_version:number}>;
function schemaVersion(db:DatabaseSync){const value=db.prepare('PRAGMA schema_version').get()!.schema_version;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('source_revision_unavailable');return value;}
function validateSchema(db:DatabaseSync,version:number){
 if(validated.get(db)===version)return;
 const rows=db.prepare(`SELECT name,type,sql FROM sqlite_schema WHERE name IN (${definitions.map(()=>'?').join(',')})`).all(...definitions.map(value=>value.name));
 if(rows.length!==definitions.length||definitions.some(expected=>!rows.some(row=>row.name===expected.name&&row.type===expected.type&&typeof row.sql==='string'&&normal(row.sql)===normal(expected.sql))))throw Error('source_revision_schema_invalid');
 // SQLite can reuse a schema version after an enclosing transaction rolls back.
 // A JS cache must never publish validation of uncommitted migration state.
 if(!db.isTransaction)validated.set(db,version);
}
/** Startup migration only, after wb_files exists. Existing rows begin at zero;
 * every later current-file write is covered without an inventory backfill. */
export function installWorkbenchSourceRevisions(db:DatabaseSync):void{
 db.exec('SAVEPOINT wb_source_revisions_install');
 try{for(const definition of definitions)db.exec(definition.sql.replace(/^CREATE (TABLE|TRIGGER) /,'CREATE $1 IF NOT EXISTS ')+';');validateSchema(db,schemaVersion(db));db.exec('RELEASE wb_source_revisions_install');}
 catch(error){db.exec('ROLLBACK TO wb_source_revisions_install; RELEASE wb_source_revisions_install');throw error;}
}
/** Read-only observation, never task, cycle or execution authority. */
export function readWorkbenchSourceRevision(db:DatabaseSync,owner:string,workspace:string,project:string):WorkbenchSourceRevision{
 if(db.isTransaction)throw Error('source_transaction_active');
 const schema_version=schemaVersion(db);validateSchema(db,schema_version);
 const row=db.prepare(`SELECT revision FROM ${table} WHERE owner_id=? AND workspace_id=? AND project_id=?`).get(owner,workspace,project),revision=row?.revision??0;
 if(typeof revision!=='number'||!Number.isSafeInteger(revision)||revision<0)throw Error('source_revision_unavailable');
 return {revision,schema_version};
}
