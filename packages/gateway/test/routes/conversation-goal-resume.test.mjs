import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {buildServer} from '../../src/server.ts';import {EventStore} from '../../src/events/event-store.ts';import {RunRepository} from '../../src/runs/repository.ts';
const goal={id:'goal-fixture',revision:3,objective:'Continue the authorized goal',phase:'paused',activation:'disarmed'};
async function fixture(t,{enabled=true,loseAck=false}={}){
 const root=mkdtempSync(join(tmpdir(),'jot-public-resume-')),csrf=randomBytes(24).toString('hex'),origin='https://fixture.invalid',calls=[];let ready=true,offline=false;
 const client={conversationGoal:async(session,body)=>{calls.push({session,body});return{goal}},conversationGoalResumeReadiness:async()=>{if(offline)throw Error('private host failure');return{ready}}};
 const f=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],csrfToken:csrf,allowedOrigins:[origin],conversationGoalClient:client,conversationGoalResumeEnabled:enabled});t.after(async()=>{await f.app.close();f.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 let lose=loseAck;f.app.addHook('onSend',async(request,reply,payload)=>{if(lose&&reply.statusCode===202&&request.method==='POST'&&request.url.endsWith('/goal')){lose=false;throw Error('fixture_reply_lost');}return payload;});
 const headers={'x-user-id':'owner-a',origin,'x-csrf-token':csrf,'idempotency-key':'create-fixture'},created=await f.app.inject({method:'POST',url:'/v1/conversations',headers,payload:{workspace_id:'ws',model:{provider:'fixture',model:'fixture'}}});assert.equal(created.statusCode,201);const id=created.json().conversation_id,url=`/v1/conversations/${id}/goal`;
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(id,'owner-a','native-fixture','now','now');const runs=new RunRepository(f.db,new EventStore(f.db)),source=runs.enqueue(id,'owner-a',{client_message_id:'source-original',content:[{type:'text',text:'Original human input'}]});f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);
 const request={method:'POST',url,headers:{...headers,'idempotency-key':'resume-original'},payload:{action:'resume',id:goal.id,revision:goal.revision}};
 return{...f,id,url,headers,request,calls,source,setReady:v=>ready=v,setOffline:v=>offline=v};
}
test('public resume returns an atomic 202 original-run receipt without activating or prompting the native Agent',async t=>{
 const f=await fixture(t),readiness=await f.app.inject({method:'GET',url:f.url+'/resume-readiness',headers:f.headers});assert.equal(readiness.statusCode,200);assert.deepEqual(readiness.json(),{enabled:true,ready:true,reason:'READY'});
 const first=await f.app.inject(f.request);assert.equal(first.statusCode,202,first.body);const value=first.json();assert.equal(value.accepted,true);assert.ok(value.control_id);assert.equal(value.conversation_id,f.id);assert.equal(Object.hasOwn(value,'goal'),false);
 const replay=await f.app.inject(f.request);assert.equal(replay.statusCode,202);assert.deepEqual(replay.json(),value);assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].body,{});
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='user'").get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls').get().n,1);const run=f.db.prepare('SELECT * FROM ga_runs WHERE id=?').get(value.run_id);assert.equal(run.status,'queued');assert.equal(run.input_message_id,null);assert.equal(run.continuation_of,f.source.run_id);
 const readRun=await f.app.inject({method:'GET',url:'/v1/runs/'+value.run_id,headers:f.headers});assert.equal(readRun.statusCode,200);assert.equal(readRun.json().goal_control_id,value.control_id);
 const busy=await f.app.inject({method:'GET',url:f.url+'/resume-readiness',headers:f.headers});assert.equal(busy.json().ready,false);assert.equal(busy.json().reason,'RUN_BUSY');
});
test('lost acknowledgement after atomic commit replays the same 202 even when the Host is unavailable',async t=>{
 const f=await fixture(t,{loseAck:true});
 assert.equal((await f.app.inject(f.request)).statusCode,500);const row=f.db.prepare("SELECT response_status,receipt_protocol FROM ga_idempotency WHERE idempotency_key='resume-original'").get();assert.equal(row.response_status,202);assert.equal(row.receipt_protocol,'conversation-goal-resume-atomic-v1');f.setOffline(true);const recovered=await f.app.inject(f.request);assert.equal(recovered.statusCode,202);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls').get().n,1);assert.equal(f.calls.length,1);
});
test('typed reservation before admission and preflight outage can recover the original key without duplicate jobs',async t=>{
 const f=await fixture(t);f.setOffline(true);assert.equal((await f.app.inject(f.request)).statusCode,503);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls').get().n,0);assert.equal(f.db.prepare("SELECT response_status FROM ga_idempotency WHERE idempotency_key='resume-original'").get().response_status,null);
 f.setOffline(false);assert.equal((await f.app.inject(f.request)).statusCode,202);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls').get().n,1);
 assert.equal((await f.app.inject({...f.request,payload:{...f.request.payload,revision:4}})).statusCode,409);
});
test('disabled, unavailable, foreign, stale and CSRF-invalid requests never enqueue a continuation',async t=>{
 const disabled=await fixture(t,{enabled:false});assert.equal((await disabled.app.inject(disabled.request)).statusCode,409);assert.equal(disabled.calls.length,0);
 const f=await fixture(t);f.setReady(false);assert.equal((await f.app.inject(f.request)).statusCode,503);f.setReady(true);
 assert.equal((await f.app.inject({...f.request,headers:{...f.request.headers,'x-csrf-token':'invalid'}})).statusCode,403);
 assert.equal((await f.app.inject({...f.request,headers:{...f.request.headers,'x-user-id':'other'}})).statusCode,404);
 const stale=await f.app.inject({...f.request,headers:{...f.request.headers,'idempotency-key':'stale-resume'},payload:{...f.request.payload,revision:8}});assert.equal(stale.statusCode,409);assert.equal(stale.json().error.code,'GOAL_REVISION_CHANGED');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls').get().n,0);
});
