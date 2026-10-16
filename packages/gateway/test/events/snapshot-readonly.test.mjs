import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {openProductDatabase} from '../../src/db/database.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {ConversationListCursor} from '../../src/conversations/list-cursor.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';
import {buildSnapshot} from '../../src/events/snapshot.ts';

function fixture(t){
 const root=resolve('.test-tmp');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'snapshot-readonly-')),path=join(dir,'product.sqlite');
 const db=openProductDatabase(path),repository=new ConversationRepository(db),conversation=repository.create('alice',{workspace_id:'shared',title:'Snapshot',model:{provider:'test',model:'test'}});
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});});return {db,path,conversation};
}
const changes=db=>Number(db.prepare('SELECT total_changes() n').get().n);

test('initialized snapshot reads WAL while another connection owns the write lock without writes',t=>{
 const f=fixture(t),writer=new DatabaseSync(f.path);writer.exec('BEGIN IMMEDIATE');
 try{writer.prepare("UPDATE ga_conversations SET title='uncommitted' WHERE id=?").run(f.conversation.conversation_id);
  const before=changes(f.db),snapshot=buildSnapshot(f.db,f.conversation.conversation_id,'alice');
  assert.equal(snapshot.conversation.title,'Snapshot');assert.equal(changes(f.db),before);
 }finally{writer.exec('ROLLBACK');writer.close();}
});

test('initialized snapshot and durable cursor reopen read-only without mutation; foreign owner is rejected',t=>{
 const f=fixture(t),boundary={rank:1,pin:'',updated:'2026-10-17',id:f.conversation.conversation_id},cursor=new ConversationListCursor(f.db).encode('alice',undefined,'active',boundary);
 const db=new DatabaseSync(f.path,{readOnly:true});
 try{const before=changes(db);assert.equal(buildSnapshot(db,f.conversation.conversation_id,'alice').conversation.conversation_id,f.conversation.conversation_id);
  assert.deepEqual(new ConversationListCursor(db).decode('alice',undefined,'active',cursor),boundary);
  assert.throws(()=>buildSnapshot(db,f.conversation.conversation_id,'bob'),/conversation_not_found/);
  assert.throws(()=>new ConversationListCursor(db).decode('bob',undefined,'active',cursor),/invalid_conversation_cursor/);
  assert.equal(changes(db),before);assert.equal(db.isTransaction,false);
 }finally{db.close();}
});

test('completed default-project initialization is read-only under a competing writer',t=>{
 const f=fixture(t),writer=new DatabaseSync(f.path);writer.exec('BEGIN IMMEDIATE');
 try{const before=changes(f.db);assert.equal(new ProjectRepository(f.db).ensureDefault('alice').project_id,f.conversation.project_id);assert.equal(changes(f.db),before);}
 finally{writer.exec('ROLLBACK');writer.close();}
});

test('snapshot still migrates a legacy NULL project and keeps the initialized cursor key',t=>{
 const f=fixture(t);f.db.prepare('UPDATE ga_conversations SET project_id=NULL WHERE id=?').run(f.conversation.conversation_id);
 const key=f.db.prepare('SELECT key_hex FROM ga_conversation_cursor_key').get().key_hex;
 assert.equal(buildSnapshot(f.db,f.conversation.conversation_id,'alice').conversation.project_id,f.conversation.project_id);
 assert.equal(f.db.prepare('SELECT key_hex FROM ga_conversation_cursor_key').get().key_hex,key);
});

test('two first-initializer processes retain one cursor key and owner default project',async t=>{
 const root=resolve('.test-tmp');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'snapshot-initialize-')),path=join(dir,'product.sqlite');
 const db=openProductDatabase(path);t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const repositoryUrl=new URL('../../src/conversations/repository.ts',import.meta.url).href;
 const projectsUrl=new URL('../../src/projects/repository.ts',import.meta.url).href;
 const source=`import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';import {ConversationRepository} from ${JSON.stringify(repositoryUrl)};import {ProjectRepository} from ${JSON.stringify(projectsUrl)};
 const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=75;');process.send('ready');process.once('message',()=>{try{new ConversationRepository(db);const project=new ProjectRepository(db).ensureDefault('alice');const key=db.prepare('SELECT key_hex FROM ga_conversation_cursor_key WHERE id=1').get().key_hex;process.send({project:project.project_id,key_hash:createHash('sha256').update(key).digest('hex')});db.close();process.disconnect();}catch{db.close();process.exit(1);}});`;
 const workers=[0,1].map(()=>{
  const child=spawn(process.execPath,['--input-type=module','-e',source,path],{stdio:['ignore','ignore','ignore','ipc']});
  const ready=new Promise((resolve,reject)=>{child.on('message',value=>{if(value==='ready')resolve();});child.once('error',reject);child.once('exit',code=>{if(code!==0)reject(Error('initialization worker exited '+code));});});
  const result=new Promise((resolve,reject)=>{let value;child.on('message',message=>{if(message!=='ready')value=message;});child.once('error',reject);child.once('exit',code=>code===0&&value?resolve(value):reject(Error('initialization worker failed: '+code)));});
  return {child,ready,result};
 });
 await Promise.all(workers.map(worker=>worker.ready));workers.forEach(worker=>worker.child.send('go'));
 const results=await Promise.all(workers.map(worker=>worker.result));assert.deepEqual(results[0],results[1]);
 assert.equal(db.prepare('SELECT count(*) n FROM ga_conversation_cursor_key').get().n,1);
 assert.equal(db.prepare("SELECT count(*) n FROM ga_projects WHERE owner_id='alice' AND is_default=1").get().n,1);
});

test('an existing malformed cursor key is rejected without replacement or writes',t=>{
 const f=fixture(t);f.db.exec('DROP TRIGGER ga_conversation_cursor_key_no_update');f.db.prepare("UPDATE ga_conversation_cursor_key SET key_hex='invalid'").run();
 const before=changes(f.db);assert.throws(()=>new ConversationListCursor(f.db),/conversation_cursor_key_invalid/);assert.equal(changes(f.db),before);
 assert.equal(f.db.prepare('SELECT key_hex FROM ga_conversation_cursor_key').get().key_hex,'invalid');
});
