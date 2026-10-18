import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {SessionBindingRepository} from '../../src/harness/session-bindings.ts';
import {EventStore} from '../../src/events/event-store.ts';
const token=randomBytes(32).toString('hex');
async function fixture(overrides={}){
 const service=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,...overrides});
 const owner='model-owner',model={provider:'fixture',model:'chosen',reasoning_effort:'high'};
 const conversation=service.conversations.create(owner,{workspace_id:'ws',title:'Model fixture',model});
 const input={client_message_id:'model-input',content:[{type:'text',text:'Synthetic task'}]};
 const source=service.runs.enqueue(conversation.conversation_id,owner,input);
 const session=new SessionBindingRepository(service.db).getOrCreate(owner,conversation.conversation_id);
 const coordinator=new HarnessCoordinator(service.db,service.runs,new EventStore(service.db));
 const lease=coordinator.claimNext('fixture-worker',60000);coordinator.start(lease);
 const body={run_id:source.run_id,session_ref:session.session_id,execution_lease:{owner:lease.owner,generation:lease.generation}};
 const request=(payload=body,authorization=`Bearer ${token}`)=>service.app.inject({method:'POST',url:'/internal/v1/workbench/ordinary-model-policy',headers:{authorization},payload});
 return{service,owner,model,conversation,input,source,body,request,close:async()=>{await service.app.close();service.db.close();}};
}
test('original input freezes its model and conversation version rather than following later metadata',async()=>{
 const f=await fixture();try{
  f.service.db.prepare('UPDATE ga_conversations SET model=?,version=version+1 WHERE id=?').run(JSON.stringify({...f.model,model:'later'}),f.conversation.conversation_id);
  const result=await f.request();assert.equal(result.statusCode,200);
  assert.deepEqual(result.json().policy.model,f.model);assert.equal(result.json().policy.conversation_version,f.conversation.version);
  assert.equal(result.json().policy.execution_authorized,false);assert.equal(result.json().policy.run_id,f.source.run_id);
  const original=f.service.runs.enqueue(f.conversation.conversation_id,f.owner,f.input);assert.equal(original.run_id,f.source.run_id);
  assert.deepEqual((await f.request()).json(),result.json());
 }finally{await f.close();}
});

test('a resolved default is bound once and exact lost-receipt retries do not change it',async()=>{
 const f=await fixture();try{
  const first=(await f.request()).json().policy;
  assert.equal(first.resolved_model,null);
  const payload={...f.body,action:'bind',policy_sha256:first.policy_sha256,model:f.model};
  const bound=await f.request(payload);assert.equal(bound.statusCode,200);assert.deepEqual(bound.json().policy.resolved_model,f.model);
  assert.deepEqual((await f.request(payload)).json(),bound.json());
  assert.equal((await f.request({...payload,model:{...f.model,model:'another'}})).statusCode,409);
  assert.equal((await f.request({...payload,policy_sha256:'0'.repeat(64)})).statusCode,409);
  assert.equal((await f.request({...payload,model:{...f.model,reasoning_effort:'low'}})).statusCode,409);
  assert.throws(()=>f.service.db.prepare('UPDATE ga_runs SET model_resolution_json=NULL WHERE id=?').run(f.source.run_id),/model_resolution_immutable/);
 }finally{await f.close();}
});

test('the internal model policy route keeps bearer authentication with browser CSRF enabled',async()=>{
 const f=await fixture({csrfToken:randomBytes(32).toString('hex'),allowedOrigins:['https://jot.example']});try{
  const read=await f.request();assert.equal(read.statusCode,200);
  const bound=await f.request({...f.body,action:'bind',policy_sha256:read.json().policy.policy_sha256,model:f.model});assert.equal(bound.statusCode,200);
  assert.equal((await f.request(f.body,'Bearer fixture-wrong')).statusCode,401);
 }finally{await f.close();}
});

test('legacy inputs without a frozen model refuse execution policy instead of copying current metadata',async()=>{
 const f=await fixture();try{
  const conversation=f.service.conversations.create(f.owner,{workspace_id:'ws',title:'Legacy',model:f.model}),id=conversation.conversation_id,now=new Date().toISOString();
  f.service.db.prepare('INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-message',id,'legacy-run','user','complete',JSON.stringify({blocks:[],attachments:[]}),'legacy-client',now,now);
  f.service.db.prepare('INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('legacy-run',id,'legacy-message','queued',1,now,now);
  const session=new SessionBindingRepository(f.service.db).getOrCreate(f.owner,id),coordinator=new HarnessCoordinator(f.service.db,f.service.runs,new EventStore(f.service.db));
  const lease=coordinator.claimNext('legacy-worker',60000);assert.equal(lease.run_id,'legacy-run');coordinator.start(lease);
  assert.equal((await f.request({run_id:lease.run_id,session_ref:session.session_id,execution_lease:{owner:lease.owner,generation:lease.generation}})).statusCode,409);
  assert.equal(f.service.db.prepare('SELECT model_policy_json FROM ga_runs WHERE id=?').get(lease.run_id).model_policy_json,null);
 }finally{await f.close();}
});
test('model policy requires internal authentication, exact original Session and live Worker lease',async()=>{
 const f=await fixture();try{
  assert.equal((await f.request(f.body,'Bearer fixture-wrong')).statusCode,401);
  assert.equal((await f.request({...f.body,owner_id:f.owner})).statusCode,422);
  assert.equal((await f.request({...f.body,session_ref:'another-session'})).statusCode,409);
  assert.equal((await f.request({...f.body,execution_lease:{...f.body.execution_lease,generation:f.body.execution_lease.generation+1}})).statusCode,409);
  f.service.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(f.source.run_id);
  assert.equal((await f.request()).statusCode,409);
 }finally{await f.close();}
});
test('accepted model policy cannot be overwritten or erased through an ordinary SQL update',async()=>{
 const f=await fixture();try{
  const row=f.service.db.prepare('SELECT model_policy_json FROM ga_runs WHERE id=?').get(f.source.run_id);
  assert.ok(row.model_policy_json);
  assert.throws(()=>f.service.db.prepare('UPDATE ga_runs SET model_policy_json=NULL WHERE id=?').run(f.source.run_id),/model_policy_immutable/);
  assert.throws(()=>f.service.db.prepare('UPDATE ga_runs SET model_policy_json=? WHERE id=?').run('{}',f.source.run_id),/model_policy_immutable/);
  assert.equal(f.service.db.prepare('SELECT model_policy_json FROM ga_runs WHERE id=?').get(f.source.run_id).model_policy_json,row.model_policy_json);
 }finally{await f.close();}
});
