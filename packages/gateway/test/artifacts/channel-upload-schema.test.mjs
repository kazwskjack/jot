import test from 'node:test';import assert from 'node:assert/strict';import{DatabaseSync}from'node:sqlite';
import{installChannelUploadStages}from'../../src/artifacts/channel-upload-schema.ts';
test('original upload v1 migration preserves rows, FK and writer fencing while allowing only internal pre-conversation reservations',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE ga_conversations(id TEXT PRIMARY KEY);INSERT INTO ga_conversations VALUES('original-conversation');
 CREATE TABLE ga_uploads(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,owner_id TEXT NOT NULL,status TEXT NOT NULL,server_path TEXT NOT NULL,filename TEXT NOT NULL,declared_size INTEGER NOT NULL,received_size INTEGER NOT NULL DEFAULT 0,declared_sha256 TEXT,actual_sha256 TEXT,mime_type TEXT,created_at TEXT NOT NULL,completed_at TEXT,writer_token TEXT,writer_lease_until TEXT);
 INSERT INTO ga_uploads VALUES('original-upload','original-conversation','alice','uploading','synthetic','one.txt',3,1,'sha',NULL,'text/plain','now',NULL,'original-writer','future');`);
 const before=db.prepare('SELECT * FROM ga_uploads').get();installChannelUploadStages(db);installChannelUploadStages(db);
 const after=db.prepare('SELECT * FROM ga_uploads').get();for(const [key,value]of Object.entries(before))assert.equal(after[key],value);
 assert.equal(db.prepare('PRAGMA table_info(ga_uploads)').all().find(c=>c.name==='conversation_id').notnull,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 assert.throws(()=>db.prepare("UPDATE ga_uploads SET conversation_id='unknown' WHERE id='original-upload'").run(),/FOREIGN KEY/);
 }finally{db.close();}
});
