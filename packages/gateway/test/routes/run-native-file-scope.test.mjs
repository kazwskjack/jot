import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildServer} from '../../src/server.ts';

test('internal file reads resolve a frozen original Session and refuse ambiguous or foreign ownership',async t=>{
 const token=randomBytes(32).toString('hex'),service=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token});
 t.after(async()=>{await service.app.close();service.db.close();});
 const owner='file-owner',conversation=service.conversations.create(owner,{workspace_id:'ws',title:'Synthetic',model:{provider:'local',model:'fixture'}});
 service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(conversation.conversation_id,owner,'original-file-session','now','now');
 service.runs.enqueue(conversation.conversation_id,owner,{client_message_id:'file-input',content:[{type:'text',text:'Synthetic file query'}]});
 service.db.prepare('UPDATE ga_harness_session_bindings SET session_id=? WHERE conversation_id=?').run('later-file-session',conversation.conversation_id);
 const read=(session_ref,authorization=`Bearer ${token}`)=>service.app.inject({method:'POST',url:'/internal/v1/file-tools',headers:{authorization},payload:{session_ref,call_id:'synthetic-read',arguments:{operation:'document.templates'}}});
 assert.equal((await read('original-file-session')).statusCode,200);
 assert.equal((await read('later-file-session')).statusCode,200);
 assert.equal((await read('unknown-file-session')).statusCode,401);
 assert.equal((await read('original-file-session','Bearer wrong-fixture')).statusCode,401);
 const foreign=service.conversations.create('foreign-owner',{workspace_id:'ws',title:'Synthetic foreign',model:{provider:'local',model:'fixture'}});
 service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(foreign.conversation_id,'foreign-owner','original-file-session','now','now');
 assert.equal((await read('original-file-session')).statusCode,401);
});
