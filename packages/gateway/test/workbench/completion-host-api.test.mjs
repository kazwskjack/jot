import test from 'node:test';
import assert from 'node:assert/strict';
import {completionFixture} from './task-completion-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};
const proof={host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}};
async function ready(t){const f=await completionFixture(t),card=(await f.list())[0];
 assert.equal((await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))})).statusCode,202);
 const intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));return {...f,intent};
}
const send=(f,path,payload={},token='test-b99992d64419ae59')=>f.app.inject({method:'POST',url:`/internal/v1/workbench/${path}`,headers:{authorization:`Bearer ${token}`},payload:{run_id:f.runId,session_ref:'session-fixture',intent_id:f.intent.intent_id,...payload}});

test('a current accepted certificate authorizes read-only recovery before any completion intent and revoked or foreign recovery cannot load it',async t=>{
 const f=await completionFixture(t),card=(await f.list())[0];
 const request=(payload={},token='test-b99992d64419ae59')=>f.app.inject({method:'POST',url:'/internal/v1/workbench/completion-recovery',headers:{authorization:`Bearer ${token}`},payload:{run_id:f.runId,session_ref:'session-fixture',...payload}});
 assert.notEqual((await request()).statusCode,200);
 assert.equal((await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))})).statusCode,202);
 const response=await request();assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().recovery.checkpoint.goal_id,'goal-fixture');assert.ok(response.json().recovery.certificate_id);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_completion_intents').get().n,0);
 for(const [payload,token] of [[{},'wrong'],[{session_ref:'foreign-session'}],[{owner_id:'alice'}]])assert.notEqual((await request(payload,token)).statusCode,200);
 f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
 assert.notEqual((await request()).statusCode,200);
});
test('only an authenticated bound host can read the current completion intent and confirm its exact native receipt',async t=>{
 const f=await ready(t),read=await send(f,'completion-intent');assert.equal(read.statusCode,200,read.body);assert.deepEqual(read.json().intent,f.intent);
 const readonly=await f.app.inject({method:'POST',url:'/internal/v1/workbench/completion-recovery',headers:{authorization:'Bearer test-b99992d64419ae59'},payload:{run_id:f.runId,session_ref:'session-fixture'}});
 assert.equal(readonly.statusCode,409,'an existing intent must be recovered through its pinned identity');
 const response=await send(f,'completion-confirm',{proof});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().confirmed,true);
 assert.equal((await send(f,'completion-confirm',{proof})).body,response.body);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
});
test('bad host credentials, foreign Session/intent and caller authority fields cannot authorize completion',async t=>{
 const f=await ready(t);
 for(const [payload,token] of [[{},'wrong'],[{session_ref:'foreign-session'}],[{intent_id:'foreign-intent'}],[{owner_id:'alice'}]]){
  const response=await send(f,'completion-intent',payload,token);assert.ok([401,403,409,422].includes(response.statusCode),response.body);
 }
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,0);
});
test('a host cannot prepare a new effect after revocation but may recover an exact already-committed completion receipt',async t=>{
 const f=await ready(t),response=await send(f,'completion-confirm',{proof});assert.equal(response.statusCode,200,response.body);
 f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
 const denied=await send(f,'completion-intent');assert.ok([403,409].includes(denied.statusCode),denied.body);
 assert.equal((await send(f,'completion-confirm',{proof})).body,response.body);
});
