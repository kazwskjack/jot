import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {installWorkbenchSourceRevisions,readWorkbenchSourceRevision} from '../../src/always-on/workbench-source-revisions.ts';

test('rolled-back schema validation cannot cache a reused schema version and hide a damaged tracking trigger',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('CREATE TABLE wb_files(owner_id TEXT,workspace_id TEXT,project_id TEXT,path TEXT)');
  installWorkbenchSourceRevisions(db);const initial=readWorkbenchSourceRevision(db,'owner','ws','project');
  db.exec('BEGIN; DROP TRIGGER wb_project_source_revision_insert');installWorkbenchSourceRevisions(db);
  const transient=db.prepare('PRAGMA schema_version').get().schema_version;db.exec('ROLLBACK');
  assert.equal(db.prepare('PRAGMA schema_version').get().schema_version,initial.schema_version);
  db.exec('DROP TRIGGER wb_project_source_revision_insert; CREATE TRIGGER wb_project_source_revision_insert AFTER INSERT ON wb_files BEGIN SELECT 1; END');
  assert.equal(db.prepare('PRAGMA schema_version').get().schema_version,transient,'SQLite may reuse the rolled-back schema number');
  assert.throws(()=>readWorkbenchSourceRevision(db,'owner','ws','project'),/source_revision_schema_invalid/);
 }finally{db.close();}
});
