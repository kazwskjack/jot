import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';

async function fixture(t){
 const {messageAttachmentProjection}=await import('../../src/messages/pinned-attachments.ts');
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec('CREATE TABLE ga_conversations(id TEXT,owner_id TEXT);CREATE TABLE ga_runs(id TEXT,conversation_id TEXT);CREATE TABLE ga_run_commands(id TEXT,run_id TEXT,kind TEXT,status TEXT,payload_json TEXT);');
 db.prepare('INSERT INTO ga_conversations VALUES(?,?)').run('conversation','owner');db.prepare('INSERT INTO ga_runs VALUES(?,?)').run('run','conversation');
 const pin={artifact_id:'file',version:1,sha256:'a'.repeat(64),size_bytes:12,media_type:'text/plain',file_name:'sent.txt',kind:'text'};
 const payload={text:'  Original words  ',client_message_id:'client',expected_run_version:1,content_protocol:1,attachment_manifest:{protocol:1,attachments:[pin]}};
 const message={id:'message-command',run_id:'run',conversation_id:'conversation',role:'user',status:'complete',client_message_id:'client',content_json:JSON.stringify({blocks:[{block_id:'message-command:text',kind:'text',text:payload.text}],attachments:['file']})};
 db.prepare('INSERT INTO ga_run_commands VALUES(?,?,?,?,?)').run('command','run','steer','applied',JSON.stringify(payload));
 return{db,pin,payload,message,project:(m=message)=>messageAttachmentProjection(db,m)};
}

test('message refs derive exact sent metadata without requiring current artifact inventory or rewriting content',async t=>{
 const f=await fixture(t),before=f.message.content_json,{kind,...ref}=f.pin;
 assert.deepEqual(f.project(),{attachment_refs:[ref]});assert.equal(f.message.content_json,before);
});

for(const failure of ['command-missing','command-pending','foreign-run','foreign-conversation','client','content','invalid-manifest'])test('pinned provenance '+failure+' never returns a newer version or a legacy fallback',async t=>{
 const f=await fixture(t);
 if(failure==='command-missing')f.db.exec('DELETE FROM ga_run_commands');
 if(failure==='command-pending')f.db.exec("UPDATE ga_run_commands SET status='pending'");
 if(failure==='foreign-run')f.db.exec("UPDATE ga_run_commands SET run_id='other'");
 if(failure==='foreign-conversation')f.message.conversation_id='other';
 if(failure==='client')f.message.client_message_id='other';
 if(failure==='content')f.message.content_json=f.message.content_json.replace('Original words','Changed words');
 if(failure==='invalid-manifest'){f.payload.attachment_manifest.attachments[0].version=0;f.db.prepare('UPDATE ga_run_commands SET payload_json=?').run(JSON.stringify(f.payload));}
 assert.deepEqual(f.project(),{attachment_refs:[]});
});

test('ordinary first inputs and generated answers retain existing attachment behavior',async t=>{
 const f=await fixture(t);assert.deepEqual(f.project({...f.message,id:'msg-first'}),{});assert.deepEqual(f.project({...f.message,role:'assistant'}),{});
});

test('file-only messages retain their exact ordered manifest',async t=>{
 const f=await fixture(t);f.payload.text='';f.message.content_json=JSON.stringify({blocks:[],attachments:['file']});f.db.prepare('UPDATE ga_run_commands SET payload_json=?').run(JSON.stringify(f.payload));
 const {kind,...ref}=f.pin;assert.deepEqual(f.project(),{attachment_refs:[ref]});
});
