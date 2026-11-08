import assert from 'node:assert/strict';
import test from 'node:test';
import {buildServer} from '../../src/server.ts';

test('run diagnostics tolerate absent optional budget tables after the owner check',async t=>{
 const service=await buildServer({databasePath:':memory:',workspaces:['ws']});
 t.after(async()=>{await service.app.close();service.db.close();});
 const ownerHeaders={'x-user-id':'alice'};
 const conversation=(await service.app.inject({method:'POST',url:'/v1/conversations',headers:ownerHeaders,
  payload:{workspace_id:'ws',model:{provider:'fixture',model:'fixture'}}})).json();
 const accepted=(await service.app.inject({method:'POST',url:`/v1/conversations/${conversation.conversation_id}/messages`,headers:ownerHeaders,
  payload:{client_message_id:'diagnostics-owner-fixture',content:[{type:'text',text:'private-diagnostic-prompt'}]}})).json();

 service.db.exec('DROP TABLE IF EXISTS wb_model_budget_events; DROP TABLE IF EXISTS wb_model_budget_attempts');
 const owned=await service.app.inject({method:'GET',url:`/v1/runs/${accepted.run_id}/diagnostics`,headers:ownerHeaders});
 assert.equal(owned.statusCode,200,owned.body);
 assert.equal(owned.json().run_id,accepted.run_id);
 assert.equal(owned.json().status,'queued');
 assert.deepEqual(owned.json().attempts,[]);
 assert.ok(owned.json().missing.includes('model_attempts_unavailable'));
 assert.ok(owned.json().missing.includes('budget_events_unavailable'));
 assert.doesNotMatch(owned.body,/private-diagnostic-prompt/);

 // Missing optional tables must not let an unauthorized request through or reveal run state.
 const foreign=await service.app.inject({method:'GET',url:`/v1/runs/${accepted.run_id}/diagnostics`,headers:{'x-user-id':'bob'}});
 assert.equal(foreign.statusCode,404,foreign.body);
 assert.doesNotMatch(foreign.body,new RegExp(accepted.run_id));
 assert.doesNotMatch(foreign.body,/private-diagnostic-prompt/);

 const missing=await service.app.inject({method:'GET',url:'/v1/runs/missing-diagnostics-run/diagnostics',headers:ownerHeaders});
 assert.equal(missing.statusCode,404,missing.body);
});
