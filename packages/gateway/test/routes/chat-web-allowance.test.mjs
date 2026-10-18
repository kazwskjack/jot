import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
const chat={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:'bounded-text-v1'};
test('Chat Web reservation retains bearer/lease authority with CSRF enabled and never repeats a consumed call',async t=>{
 const token=randomBytes(32).toString('hex'),f=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,csrfToken:randomBytes(32).toString('hex')});t.after(async()=>{await f.app.close();f.db.close();});
 const c=f.conversations.create('web-owner',{workspace_id:'ws',mode:'chat',model:{provider:'fixture',model:'work'}},{chatPolicy:chat}),accepted=f.runs.enqueue(c.conversation_id,'web-owner',{client_message_id:'web-current',content:[{type:'text',text:'Synthetic web question.'}]},{modePolicy:chat});
 const coordinator=new HarnessCoordinator(f.db,f.runs,f.events),lease=coordinator.claimNext('web-worker',30000);coordinator.start(lease);
 const row=f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(accepted.run_id),body={run_id:accepted.run_id,session_ref:row.native_session_ref,execution_lease:{owner:lease.owner,generation:lease.generation},call_id:'search-a',group:{protocol:1,kind:'search',native_turn:1,native_step:1,assistant_seq:10,assistant_message_id:'assistant-a',calls:[{call_id:'search-a',name:'web_search',arguments:{queries:['synthetic fixture']}}]}};
 const reserve=(payload=body,authorization=`Bearer ${token}`)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/ordinary-chat-web',headers:{authorization},payload});
 const first=await reserve();assert.equal(first.statusCode,200,first.body);assert.equal(first.json().reservation.first_dispatch,true);
 assert.equal((await reserve()).json().reservation.first_dispatch,false);
 const exhausted=await reserve({...body,call_id:'search-later',group:{...body.group,native_step:2,assistant_seq:20,assistant_message_id:'assistant-later',calls:[{call_id:'search-later',name:'web_search',arguments:{queries:['another round']}}]}});assert.equal(exhausted.statusCode,409);assert.equal(exhausted.json().error.code,'CHAT_WEB_ALLOWANCE_CONSUMED');
 assert.equal((await reserve(body,'Bearer invalid')).statusCode,401);assert.equal((await reserve({...body,owner_id:'foreign'})).statusCode,422);
 assert.equal((await reserve({...body,session_ref:'foreign'})).statusCode,409);assert.equal((await reserve({...body,call_id:'unknown'})).statusCode,409);
 f.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(accepted.run_id);assert.equal((await reserve()).statusCode,409);
});
