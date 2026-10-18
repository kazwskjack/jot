import test from 'node:test';
import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';

test('model changes are rejected throughout pending execution without blocking owned metadata edits',async()=>{
 const service=await buildServer({databasePath:':memory:',workspaces:['ws']});
 const headers={'x-user-id':'model-owner'};
 const original={provider:'fixture',model:'original',reasoning_effort:'high'};
 try{
  const created=await service.app.inject({method:'POST',url:'/v1/conversations',headers,payload:{workspace_id:'ws',model:original,title:'Model boundary'}});
  assert.equal(created.statusCode,201);let conversation=created.json();
  const url=`/v1/conversations/${conversation.conversation_id}`;
  const sent=await service.app.inject({method:'POST',url:url+'/messages',headers,payload:{client_message_id:'model-message',content:[{type:'text',text:'Synthetic queued work'}]}});
  assert.equal(sent.statusCode,202);const runId=sent.json().run_id;
  assert.equal(service.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(runId).status,'queued');
  for(const status of ['queued','starting','running','waiting_user','waiting_approval','cancelling']){
   service.db.prepare('UPDATE ga_runs SET status=? WHERE id=?').run(status,runId);
   const change=await service.app.inject({method:'PATCH',url,headers,payload:{expected_version:conversation.version,model:{provider:'fixture',model:'replacement'}}});
   assert.equal(change.statusCode,409,`cannot change model during ${status}`);
   assert.equal(change.json().error.code,'ACTIVE_RUN_MODEL_CHANGE');
   const current=(await service.app.inject({method:'GET',url,headers})).json();
   assert.deepEqual(current.model,original);assert.equal(current.version,conversation.version);
  }
  const metadata=await service.app.inject({method:'PATCH',url,headers,payload:{expected_version:conversation.version,title:'Renamed safely'}});
  assert.equal(metadata.statusCode,200);conversation=metadata.json();assert.deepEqual(conversation.model,original);
  const foreign=await service.app.inject({method:'PATCH',url,headers:{'x-user-id':'another-owner'},payload:{expected_version:conversation.version,model:{provider:'fixture',model:'replacement'}}});
  assert.equal(foreign.statusCode,404);
  service.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(runId);
  const completed=await service.app.inject({method:'PATCH',url,headers,payload:{expected_version:conversation.version,model:{provider:'fixture',model:'replacement'}}});
  assert.equal(completed.statusCode,200);assert.equal(completed.json().model.model,'replacement');
  const stale=await service.app.inject({method:'PATCH',url,headers,payload:{expected_version:conversation.version,title:'Stale edit'}});
  assert.equal(stale.statusCode,409);
 }finally{await service.app.close();service.db.close();}
});

test('a confirmed model receipt replays after queue admission without reapplying settings',async()=>{
 const csrf='fixture-csrf-value',origin='https://jot.example';
 const service=await buildServer({databasePath:':memory:',workspaces:['ws'],csrfToken:csrf,allowedOrigins:[origin]});
 const headers={'x-user-id':'model-owner',origin,'x-csrf-token':csrf};
 try{
  const created=await service.app.inject({method:'POST',url:'/v1/conversations',headers:{...headers,'idempotency-key':'create-model-chat'},payload:{workspace_id:'ws',model:{provider:'fixture',model:'original'}}});
  assert.equal(created.statusCode,201);const conversation=created.json(),url=`/v1/conversations/${conversation.conversation_id}`;
  const request={method:'PATCH',url,headers:{...headers,'idempotency-key':'original-model-change'},payload:{expected_version:conversation.version,model:{provider:'fixture',model:'selected'}}};
  const accepted=await service.app.inject(request);assert.equal(accepted.statusCode,200);
  const sent=await service.app.inject({method:'POST',url:url+'/messages',headers:{...headers,'idempotency-key':'queue-after-model'},payload:{client_message_id:'after-model',content:[{type:'text',text:'Synthetic input after selection'}]}});
  assert.equal(sent.statusCode,202);
  const beforeReplay=(await service.app.inject({method:'GET',url,headers})).json();
  const replay=await service.app.inject(request);assert.equal(replay.statusCode,200);assert.equal(replay.body,accepted.body);
  const current=(await service.app.inject({method:'GET',url,headers})).json();
  assert.equal(current.model.model,'selected');assert.equal(current.version,beforeReplay.version);
  const other=await service.app.inject({...request,headers:{...headers,'idempotency-key':'new-model-change'},payload:{...request.payload,expected_version:current.version}});
  assert.equal(other.statusCode,409);assert.equal(other.json().error.code,'ACTIVE_RUN_MODEL_CHANGE');
  assert.equal(service.db.prepare('SELECT count(*) n FROM ga_runs WHERE conversation_id=?').get(conversation.conversation_id).n,1);
 }finally{await service.app.close();service.db.close();}
});
