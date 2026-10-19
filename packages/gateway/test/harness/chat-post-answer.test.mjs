import test from 'node:test';
import assert from 'node:assert/strict';
import {completedChatFixture} from '../support/chat-maintenance-fixture.mjs';
import {SessionControllerClient} from '../../src/harness/session-controller-client.ts';
const impl=await import('../../src/harness/chat-post-answer.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});

test('a committed Chat answer notifies only the current owned original scope, without DB writes or foreground authority',async t=>{
 assert.equal(typeof impl.notifyCommittedChatAnswer,'function');const f=completedChatFixture(t,{contextRevision:'checkpoint-text-v2'});let calls=0;const client={notifyChatPostAnswer:async(sessionId,history)=>{calls++;assert.equal(sessionId,f.scope.session_ref);const {session_ref,...expected}=f.scope;assert.deepEqual(history,expected);assert.equal(Object.hasOwn(history,'execution_lease'),false);return{protocol:1,kind:'chat_post_answer',status:'accepted',run_id:history.run_id,session_id:sessionId,run_version:history.expected_run_version,execution_authorized:false};}},before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.equal(await impl.notifyCommittedChatAnswer(f.db,f.run.run_id,client),'accepted');assert.equal(calls,1);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);f.newInput();assert.equal(await impl.notifyCommittedChatAnswer(f.db,f.run.run_id,client),'skipped');assert.equal(calls,1);
});

test('old context, unfinished, foreign or damaged publication cannot notify; failed delivery leaves the canonical answer untouched',async t=>{
 assert.equal(typeof impl.notifyCommittedChatAnswer,'function');for(const mode of ['legacy','unfinished','missing','archived','answer','failed-delivery']){const f=completedChatFixture(t,{contextRevision:mode==='legacy'?'bounded-text-v1':'checkpoint-text-v2'});let calls=0;const client={notifyChatPostAnswer:async()=>{calls++;throw Error('notification unavailable');}};if(mode==='unfinished')f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.run.run_id);if(mode==='archived')f.db.prepare("UPDATE ga_conversations SET archived_at='now' WHERE id=?").run(f.c.conversation_id);if(mode==='answer')f.db.prepare("UPDATE ga_messages SET status='partial' WHERE run_id=? AND role='assistant'").run(f.run.run_id);const before=f.db.prepare('SELECT total_changes() n').get().n;
  assert.equal(await impl.notifyCommittedChatAnswer(f.db,mode==='missing'?'missing-run':f.run.run_id,client),mode==='failed-delivery'?'unconfirmed':'skipped',mode);assert.equal(calls,mode==='failed-delivery'?1:0,mode);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE run_id=? AND role='assistant'").get(f.run.run_id).n,1);
 }
});

test('the trusted Session client sends an exact notification and rejects a forged acceptance or caller lease',async()=>{
 const scope={owner_id:'owner',conversation_id:'conversation',run_id:'run',expected_run_version:4};let requests=0,bad=false;const client=new SessionControllerClient('http://127.0.0.1:18841','test-original-chat-notification-token-2026',async(url,options)=>{requests++;assert.equal(new URL(url).pathname,'/v1/sessions/session/chat-post-answer');assert.deepEqual(JSON.parse(options.body),{history:scope});return new Response(JSON.stringify({protocol:1,kind:'chat_post_answer',status:'accepted',run_id:bad?'other':'run',session_id:'session',run_version:4,execution_authorized:false}),{status:202});});
 assert.equal(typeof client.notifyChatPostAnswer,'function');assert.equal((await client.notifyChatPostAnswer('session',scope)).status,'accepted');bad=true;await assert.rejects(()=>client.notifyChatPostAnswer('session',scope));await assert.rejects(()=>client.notifyChatPostAnswer('session',{...scope,execution_lease:{owner:'old',generation:1}}));assert.equal(requests,2);
});

test('automatic notifications remain off by default and require the existing Chat, recovery and steering chain',()=>{
 assert.equal(typeof impl.chatPostAnswerEnabled,'function');assert.equal(impl.chatPostAnswerEnabled({}),false);assert.equal(impl.chatPostAnswerEnabled({GENERAL_AGENT_CHAT_COMPACTION_AUTO_ENABLED:'false'}),false);const env={GENERAL_AGENT_CHAT_COMPACTION_AUTO_ENABLED:'true',GENERAL_AGENT_CHAT_ENABLED:'true',GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED:'true',GENERAL_AGENT_ORDINARY_STEERING_ENABLED:'true'};assert.equal(impl.chatPostAnswerEnabled(env),true);for(const key of Object.keys(env)){const bad={...env,[key]:'no'};assert.throws(()=>impl.chatPostAnswerEnabled(bad),/chat_post_answer_config_invalid/);}
});
