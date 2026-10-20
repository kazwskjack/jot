import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,rename,copyFile,link} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {retainOriginalGitDatabase} from '../../src/git/database-identity.ts';
test('original database identity is physical, stable across connections, and rejects replacement or hard links',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jot-db-identity-')),path=join(root,'product.sqlite');let db,other;
 try{db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=WAL;CREATE TABLE proof(value);');const identity=retainOriginalGitDatabase(db);other=new DatabaseSync(path);assert.equal(retainOriginalGitDatabase(other).sha256,identity.sha256);identity.assertCurrent();other.close();other=undefined;
  await link(path,join(root,'alias.sqlite'));assert.throws(()=>identity.assertCurrent(),/native_git_database_changed/);await rm(join(root,'alias.sqlite'));identity.assertCurrent();
  db.close();db=undefined;await rename(path,join(root,'old.sqlite'));await copyFile(join(root,'old.sqlite'),path);assert.throws(()=>identity.assertCurrent(),/native_git_database_changed/);
 }finally{other?.close();db?.close();await rm(root,{recursive:true,force:true});}
});
test('in-memory and closed SQLite connections cannot prove shared physical authority',()=>{
 const db=new DatabaseSync(':memory:');assert.throws(()=>retainOriginalGitDatabase(db),/native_git_database_changed/);db.close();assert.throws(()=>retainOriginalGitDatabase(db),/native_git_database_changed/);
});
