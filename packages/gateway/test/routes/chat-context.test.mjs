import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
const chat={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:'bounded-text-v1'};
test('Chat context bridge reads only the exact original snapshot under bearer and live run/Session/lease authority',async t=>{
 const token=randomBytes(32).toString('hex'),f=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,csrfToken:randomBytes(32).toString('hex')});t.after(async()=>{await f.app.close();f.db.close();});
 const c=f.conversations.create('context-owner',{workspace_id:'ws',mode:'chat',model:{provider:'fixture',model:'work'}},{chatPolicy:chat}),accepted=f.runs.enqueue(c.conversation_id,'context-owner',{client_message_id:'context-current',content:[{type:'text',text:'Synthetic context question'}]},{modePolicy:chat});
 const coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('context-worker',30000);coordinator.start(lease);
 const row=f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(accepted.run_id),body={run_id:accepted.run_id,session_ref:row.native_session_ref,execution_lease:{owner:lease.owner,generation:lease.generation}};
 const read=(payload=body,authorization=`Bearer ${token}`)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/ordinary-chat-context',headers:{authorization},payload});
 const before=f.db.prepare('SELECT total_changes() n').get().n,response=await read();assert.equal(response.statusCode,200,response.body);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 const proof=response.json().context;assert.equal(proof.execution_authorized,false);assert.equal(proof.snapshot.context_revision,chat.context_revision);assert.equal(proof.snapshot.messages.length,0);
 assert.equal(proof.context_sha256,createHash('sha256').update(row.chat_context_json).digest('hex'));assert.equal(proof.context_sha256,row.chat_context_sha256);
 assert.equal((await read(body,'Bearer wrong-fixture')).statusCode,401);assert.equal((await read({...body,owner_id:'context-owner'})).statusCode,422);
 assert.equal((await read({...body,session_ref:'foreign-session'})).statusCode,409);assert.equal((await read({...body,execution_lease:{...body.execution_lease,generation:lease.generation+1}})).statusCode,409);
 f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(accepted.run_id);assert.equal((await read()).statusCode,409);
});
