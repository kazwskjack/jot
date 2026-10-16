import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildServer} from '../../src/server.ts';
const headers={'x-user-id':'owner-a'};
async function fixture(t,client){
 const root=mkdtempSync(join(tmpdir(),'jot-conversation-goal-'));
 const service=await buildServer({databasePath:join(root,'test.db'),workspaces:['ws'],conversationGoalClient:client});
 t.after(async()=>{await service.app.close();service.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const result=await service.app.inject({method:'POST',url:'/v1/conversations',headers,payload:{workspace_id:'ws',model:{provider:'fixture',model:'fixture'}}});assert.equal(result.statusCode,201);
 const id=result.json().conversation_id,path=`/v1/conversations/${id}/goal`;
 const bind=()=>service.db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'owner-a','native-fixture','now','now');
 return {...service,id,path,bind};
}
const goal={id:'native-goal',revision:4,objective:'Finish the authorized task',phase:'active',activation:'armed'};
test('ordinary Goal reads use the existing owned Session without creating a binding',async t=>{
 const calls=[];const f=await fixture(t,{conversationGoal:async(...args)=>{calls.push(args);return{goal};}});
 assert.deepEqual((await f.app.inject({method:'GET',url:f.path,headers})).json(),{goal:null});assert.equal(calls.length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_harness_session_bindings').get().n,0);
 f.bind();const result=await f.app.inject({method:'GET',url:f.path,headers});assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{goal});assert.equal(calls[0][0],'native-fixture');assert.deepEqual(calls[0][1],{});
 const foreign=await f.app.inject({method:'GET',url:f.path,headers:{'x-user-id':'owner-b'}});assert.equal(foreign.statusCode,404);assert.equal(calls.length,1);
});
test('Goal controls forward only exact user CAS actions and reject role conversations',async t=>{
 const calls=[];const f=await fixture(t,{conversationGoal:async(...args)=>{calls.push(args);return{goal:{...goal,revision:5,phase:'paused',activation:'disarmed'}};}});f.bind();
 for(const body of [{action:'complete',id:goal.id,revision:4},{action:'resume',id:goal.id,revision:0},{action:'pause',id:goal.id,revision:4,session_id:'foreign'},[],null]){
  const response=await f.app.inject({method:'POST',url:f.path,headers,payload:body});assert.equal(response.statusCode,400);}
 assert.equal(calls.length,0);const body={action:'pause',id:goal.id,revision:4};assert.equal((await f.app.inject({method:'POST',url:f.path,headers,payload:body})).statusCode,200);assert.deepEqual(calls[0].slice(0,2),['native-fixture',body]);
 const role=(await f.app.inject({method:'POST',url:'/v1/agents',headers,payload:{workspace_id:'ws',name:'Role',instructions:'test',allowed_tools:[]}})).json();assert.ok(role.conversation_id);
 for(const method of ['GET','POST']){const r=await f.app.inject({method,url:`/v1/conversations/${role.conversation_id}/goal`,headers,...(method==='POST'?{payload:body}:{})});assert.equal(r.statusCode,409);assert.equal(r.json().error.code,'GOAL_SCOPE_INVALID');}assert.equal(calls.length,1);
});
test('unavailable adapters and malformed Goal views expose fixed errors',async t=>{
 const f=await fixture(t,undefined);f.bind();assert.equal((await f.app.inject({method:'GET',url:f.path,headers})).statusCode,503);
 const broken=await fixture(t,{conversationGoal:async()=>{throw Error('private credential');}});broken.bind();const response=await broken.app.inject({method:'GET',url:broken.path,headers});assert.equal(response.statusCode,503);assert.ok(!response.body.includes('private credential'));
 const malformed=await fixture(t,{conversationGoal:async()=>({goal:{...goal,phase:'surprise'},hidden:'private'})});malformed.bind();const bad=await malformed.app.inject({method:'GET',url:malformed.path,headers});assert.equal(bad.statusCode,502);assert.equal(bad.json().error.code,'GOAL_STATE_INVALID');assert.ok(!bad.body.includes('private'));
});

test('authenticated Goal mutations retain normal CSRF and successful idempotent replay',async t=>{
 const root=mkdtempSync(join(tmpdir(),'jot-goal-auth-'));let calls=0;const csrf='c'.repeat(32),origin='http://localhost:3030';const service=await buildServer({databasePath:join(root,'test.db'),workspaces:['ws'],csrfToken:csrf,allowedOrigins:[origin],conversationGoalClient:{async conversationGoal(){calls++;return{goal:{...goal,phase:'paused',activation:'disarmed',revision:5}};}}});t.after(async()=>{await service.app.close();service.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const auth={...headers,origin,'x-csrf-token':csrf,'idempotency-key':'create-goal-conversation'};const created=await service.app.inject({method:'POST',url:'/v1/conversations',headers:auth,payload:{workspace_id:'ws',model:{provider:'fixture',model:'fixture'}}});assert.equal(created.statusCode,201);const id=created.json().conversation_id;service.db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'owner-a','native-auth-fixture','now','now');const url=`/v1/conversations/${id}/goal`,body={action:'pause',id:goal.id,revision:4};
 assert.equal((await service.app.inject({method:'POST',url,headers:{...headers,origin,'idempotency-key':'goal-control'},payload:body})).statusCode,403);assert.equal(calls,0);
 const request={method:'POST',url,headers:{...auth,'idempotency-key':'goal-control'},payload:body};const first=await service.app.inject(request),second=await service.app.inject(request);assert.equal(first.statusCode,200);assert.deepEqual(first.json(),second.json());assert.equal(calls,1);
 assert.equal((await service.app.inject({...request,payload:{...body,action:'stop'}})).statusCode,409);assert.equal(calls,1);
});
