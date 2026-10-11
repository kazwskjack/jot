import test from 'node:test';import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';
import {TaskReplyPolicies} from '../../src/persistent-tasks/reply-policy.ts';
import {TaskReplyDrafts} from '../../src/persistent-tasks/reply-drafts.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {TaskReplySendGate} from '../../src/persistent-tasks/reply-send-gate.ts';
import {ModelBudgetLedger} from '../../src/workbench/model-budget.ts';
import {TaskReplyDispatch} from '../../src/persistent-tasks/reply-dispatch.ts';
import {TaskReplyHistory} from '../../src/persistent-tasks/reply-history.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
const route={provider:'fixture',model:'reply-judge',revision:'v1',context_window:2000,max_output_tokens:300,rates:{input:1,output:2,cache_read:1,cache_write:1}};
const usage={inputTokens:80,outputTokens:20,totalTokens:100};
async function fixture(t,result={text:'Release available.'},kind='conversation',databasePath=':memory:'){
 const f=await buildServer({databasePath,workspaces:['shared'],workbenchRoot:'.test-tmp/reply-semantic'});t.after(async()=>{await f.app.close();f.db.close();});
 const agent=f.workbench.createAgent('alice',{name:'Reader',workspace_id:'shared'}),target=f.conversations.create('alice',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}}),task=f.persistentTasks.create('alice',{agent_id:agent.agent_id,title:'Notes',objective:'Read',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 let destination={kind:'conversation',conversation_id:target.conversation_id};
 if(kind==='channel'){const bindings=new OwnerChannelBindings(f.db,{enabled:['wecom']}),challenge=bindings.create('alice','wecom','test-semantic-binding');bindings.acceptProof('wecom','test-semantic-recipient',challenge.code);destination={kind:'channel',channel_binding_id:challenge.channel_binding_id};}
 new TaskReplyPolicies(f.db).update('alice',task.task_id,{expected_version:0,policy:{mode:'bounded_auto_reply',target:destination,direction:{topic:'Release notes',tone:'Brief',evidence_required:true,forbidden:['payment promises']},limits:{max_per_24_hours:2,min_interval_seconds:60,expires_at:new Date(Date.now()+86400000).toISOString()},quiet_hours:null}});
 const occurrence=f.persistentTasks.runNow('alice',task.task_id,'test-semantic-run');f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(occurrence.run_id);
 const ref=new TaskExecutionEvidence(f.db).record(occurrence.run_id,'test-source','web.read',result);
 const draft=new TaskReplyDrafts(f.db).propose('alice',occurrence.run_id,'test-draft',{text:'Release available.',evidence:[ref]});
 const ledger=new ModelBudgetLedger(f.db,{routes:[route]}),budget=ledger.createScope('alice','test-semantic',{tokens:8000,nano_usd:16000,model_calls:4});ledger.bindRun('alice',occurrence.run_id,[budget.scope_id]);
 const {TaskReplySemanticChecks}=await import('../../src/persistent-tasks/reply-semantic.ts');
 const checks=new TaskReplySemanticChecks(f.db),assessment={topic_matches:true,tone_matches:true,evidence_supported:true,forbidden_clear:true,risk:'low',requires_user_confirmation:false,claims:[{reply_start:0,reply_end:draft.text.length,reference:ref.reference,quote:'Release available.'}]};
 const verify=invoke=>checks.verify('alice',draft.draft_id,{ledger,route:{provider:route.provider,model:route.model},guard:()=>{},invoke});
 return {...f,task,occurrence,draft,ledger,budget,checks,assessment,verify};
}
test('host semantic call uses exact owned sources, settled root accounting and immutable replay without sending',async t=>{
 const f=await fixture(t);let calls=0;
 const receipt=await f.verify(async request=>{calls++;assert.match(request.instructions,/untrusted/i);assert.equal(request.direction.topic,'Release notes');assert.equal(request.sources[0].result.text,'Release available.');assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'in_flight');return {value:f.assessment,usage};});
 assert.equal(receipt.verdict,'eligible');assert.equal(receipt.payload_sha256,f.draft.payload_sha256);assert.equal(f.ledger.balance('alice',f.budget.scope_id).used.model_calls,'1');
 assert.equal(receipt.assessment.tone_matches,true);assert.match(receipt.assessment_sha256,/^[a-f0-9]{64}$/);
 assert.equal(JSON.parse(f.db.prepare('SELECT request_json FROM wb_model_budget_attempts').get().request_json).purpose,'reply-verification');
 assert.deepEqual(await f.verify(async()=>{calls++;throw new Error('must not call');}),receipt);assert.equal(calls,1);
 assert.equal(new TaskReplySendGate(f.db).check('alice',f.draft.draft_id).allowed,true);
 assert.throws(()=>f.db.prepare("UPDATE wb_task_reply_semantic_checks SET verdict='blocked'").run(),/immutable/);
 await assert.rejects(f.checks.verify('bob',f.draft.draft_id,{}),/reply_draft_not_found/);
});
test('uncertain scope, forbidden content, risk, unsupported quotes and uncovered reply text cannot become eligible',async t=>{
 for(const alter of [v=>({...v,risk:'medium'}),v=>({...v,topic_matches:false}),v=>({...v,forbidden_clear:false}),v=>({...v,requires_user_confirmation:true}),v=>({...v,extra:'send'}),v=>({...v,claims:[{...v.claims[0],quote:'Invented'}]}),v=>({...v,claims:[{...v.claims[0],reply_end:5}]})]){
  const f=await fixture(t);const receipt=await f.verify(async()=>({value:alter(f.assessment),usage}));assert.equal(receipt.verdict,'blocked');assert.equal(f.ledger.balance('alice',f.budget.scope_id).used.model_calls,'1');
 }
});
test('missing full evidence cannot call the judge or allocate a model attempt',async t=>{
 const f=await fixture(t,{text:'x'.repeat(300000)});let calls=0;const receipt=await f.verify(async()=>{calls++;return {value:f.assessment,usage};});
 assert.equal(receipt.verdict,'unavailable');assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,0);
});
test('revocation while evaluating preserves incurred usage but does not save an eligible result',async t=>{
 const f=await fixture(t);await assert.rejects(f.verify(async()=>{f.db.prepare("UPDATE wb_persistent_tasks SET status='paused' WHERE task_id=?").run(f.task.task_id);return {value:f.assessment,usage};}),/reply_authority_revoked/);
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'settled');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_semantic_checks').get().n,0);
});
test('unknown provider usage retains the hold and prevents a free second evaluation',async t=>{
 const f=await fixture(t);await assert.rejects(f.verify(async()=>({value:f.assessment,usage:undefined})),/auxiliary_usage_unknown/);
 let called=false;await assert.rejects(f.verify(async()=>{called=true;return {value:f.assessment,usage};}),/reply_semantic_check_pending/);assert.equal(called,false);assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'unknown');
});
test('a second host instance cannot duplicate an in-flight check and restarting the assessor replays its settled receipt',async t=>{
 const f=await fixture(t),{TaskReplySemanticChecks}=await import('../../src/persistent-tasks/reply-semantic.ts');let finish;
 const pending=f.verify(()=>new Promise(resolve=>{finish=resolve;}));
 while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
 const other=new TaskReplySemanticChecks(f.db);let calls=0;
 await assert.rejects(other.verify('alice',f.draft.draft_id,{ledger:f.ledger,route,guard:()=>{},invoke:async()=>{calls++;return {value:f.assessment,usage};}}),/reply_semantic_check_pending/);
 finish({value:f.assessment,usage});const receipt=await pending;
 assert.deepEqual(await other.verify('alice',f.draft.draft_id,{ledger:f.ledger,route,guard:()=>{},invoke:async()=>{calls++;return {value:f.assessment,usage};}}),receipt);assert.equal(calls,0);
});
test('tone disagreement and incomplete risk schema do not become eligible',async t=>{
 for(const alter of [v=>({...v,tone_matches:false}),v=>({...v,tone_matches:undefined})]){
  const f=await fixture(t);const receipt=await f.verify(async()=>({value:alter({...f.assessment,tone_matches:true}),usage}));assert.equal(receipt.verdict,'blocked');
 }
 const f=await fixture(t);const receipt=await f.verify(async()=>({value:{...f.assessment,tone_matches:true},usage}));assert.equal(receipt.verdict,'eligible');
});
test('an unavailable judge route does not leave a pending check or prevent a later configured route',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(f.checks.verify('alice',f.draft.draft_id,{ledger:f.ledger,route:{provider:'fixture',model:'missing'},guard:()=>{},invoke:async()=>{calls++;return {value:f.assessment,usage};}}),/budget_route_unavailable/);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_semantic_attempts').get().n,0);
 const receipt=await f.verify(async()=>({value:f.assessment,usage}));assert.equal(receipt.verdict,'eligible');
});
test('host context preflight fails before claiming or charging a candidate',async t=>{
 const f=await fixture(t);let calls=0;
 await assert.rejects(f.checks.verify('alice',f.draft.draft_id,{ledger:f.ledger,route:{provider:route.provider,model:route.model},guard:()=>{},preflight:()=>{throw new Error('reply_judge_input_too_large');},invoke:async()=>{calls++;return {value:f.assessment,usage};}}),/reply_judge_input_too_large/);
 assert.equal(calls,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_semantic_attempts').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,0);
});

test('read-only eligibility requires the exact settled assessment and surviving owned sources',async t=>{
 const f=await fixture(t);
 assert.equal(f.checks.eligibility('alice',f.draft.draft_id).allowed,false);
 await f.verify(async()=>({value:f.assessment,usage}));
 const before=f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n;
 assert.deepEqual(f.checks.eligibility('alice',f.draft.draft_id),{allowed:true,reason:null});
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,before);
 assert.throws(()=>f.checks.eligibility('bob',f.draft.draft_id),/reply_draft_not_found/);
 f.db.prepare('DELETE FROM wb_task_reply_web_evidence').run();
 assert.equal(f.checks.eligibility('alice',f.draft.draft_id).allowed,false);
});

test('eligibility rejects a blocked verdict, revoked authority and damaged persisted assessment',async t=>{
 const blocked=await fixture(t);await blocked.verify(async()=>({value:{...blocked.assessment,risk:'high'},usage}));
 assert.equal(blocked.checks.eligibility('alice',blocked.draft.draft_id).reason,'REPLY_REQUIRES_REVIEW');
 const revoked=await fixture(t);await revoked.verify(async()=>({value:revoked.assessment,usage}));
 revoked.db.prepare("UPDATE wb_persistent_tasks SET status='paused' WHERE task_id=?").run(revoked.task.task_id);
 assert.equal(revoked.checks.eligibility('alice',revoked.draft.draft_id).allowed,false);
 const corrupt=await fixture(t);await corrupt.verify(async()=>({value:corrupt.assessment,usage}));
 corrupt.db.exec('DROP TRIGGER wb_task_reply_semantic_checks_no_update');
 const receipt=JSON.parse(corrupt.db.prepare('SELECT receipt_json FROM wb_task_reply_semantic_checks').get().receipt_json);
 receipt.assessment.claims[0].quote='Invented';
 corrupt.db.prepare('UPDATE wb_task_reply_semantic_checks SET receipt_json=?').run(JSON.stringify(receipt));
 assert.throws(()=>corrupt.checks.eligibility('alice',corrupt.draft.draft_id),/reply_semantic_corrupt/);
});

test('bounded host dispatch uses the original projection and rolls back all effects on fact failure',async t=>{
 const f=await fixture(t),history=new TaskReplyHistory(f.db);
 assert.equal(history.history('alice',f.task.task_id).items[0].status,'blocked');
 await f.verify(async()=>({value:f.assessment,usage}));
 assert.equal(history.history('alice',f.task.task_id).items[0].status,'waiting_dispatch');
 assert.equal(new TaskReplyDispatch(f.db,f.events).processNext(),false);
 const host=new TaskReplyDispatch(f.db,f.events,{enabled:true});
 f.db.exec("CREATE TRIGGER test_bounded_dispatch_failure BEFORE INSERT ON wb_task_reply_dispatch_outcomes BEGIN SELECT RAISE(ABORT,'test_bounded_dispatch_failure'); END;");
 assert.throws(()=>host.processNext(),/test_bounded_dispatch_failure/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_projection_receipts').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);
 f.db.exec('DROP TRIGGER test_bounded_dispatch_failure');
 assert.equal(host.processNext(),true);assert.equal(host.processNext(),false);
 assert.equal(new TaskReplyDispatch(f.db,f.events,{enabled:true}).processNext(),false);
 const item=history.history('alice',f.task.task_id).items[0];assert.equal(item.status,'delivered');
 const message=f.db.prepare('SELECT * FROM ga_messages WHERE id=?').get(item.message_id);
 assert.equal(message.run_id,null);assert.equal(message.role,'assistant');assert.equal(JSON.parse(message.content_json).blocks[0].text,f.draft.text);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,1);
});

test('blocked and unknown checks remain visible but never become autonomous dispatch candidates',async t=>{
 const blocked=await fixture(t);await blocked.verify(async()=>({value:{...blocked.assessment,risk:'high'},usage}));
 const item=new TaskReplyHistory(blocked.db).history('alice',blocked.task.task_id).items[0];
 assert.equal(item.status,'blocked');assert.equal(item.reason,'REPLY_REQUIRES_REVIEW');
 assert.equal(new TaskReplyDispatch(blocked.db,blocked.events,{enabled:true}).processNext(),false);
 const unknown=await fixture(t);await assert.rejects(unknown.verify(async()=>({value:unknown.assessment,usage:undefined})),/auxiliary_usage_unknown/);
 assert.equal(new TaskReplyHistory(unknown.db).history('alice',unknown.task.task_id).items[0].reason,'REPLY_SEMANTIC_CHECK_PENDING');
 assert.equal(new TaskReplyDispatch(unknown.db,unknown.events,{enabled:true}).processNext(),false);
 assert.equal(unknown.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);
});

test('bounded delivery rechecks surviving evidence before provider permission and never sends from history',async t=>{
 const f=await fixture(t,{text:'Release available.'},'channel');await f.verify(async()=>({value:f.assessment,usage}));
 const history=new TaskReplyHistory(f.db);assert.equal(history.history('alice',f.task.task_id).items[0].status,'waiting_dispatch');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
 assert.equal(new TaskReplyDispatch(f.db,f.events,{enabled:true}).processNext(),true);
 assert.equal(history.history('alice',f.task.task_id).items[0].status,'queued');
 const store=new ChannelDeliveryService(f.db),effect=store.claim('test-semantic-worker',90);
 f.db.prepare('DELETE FROM wb_task_reply_web_evidence').run();
 assert.equal(store.authorizeSend(effect.effect_id,effect.generation),false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);
});

test('bounded reservations retain rate limits and reject policy expiry even after reservation',async t=>{
 const f=await fixture(t);await f.verify(async()=>({value:f.assessment,usage}));
 const now=Math.floor(Date.now()/1000),gate=new TaskReplySendGate(f.db,{now:()=>now});
 const reserve=()=>withImmediateTransaction(f.db,()=>gate.reserve('alice',f.draft.draft_id));
 assert.equal(reserve().allowed,true);assert.deepEqual(reserve(),reserve());
 let clock=now;const timed=new TaskReplySendGate(f.db,{now:()=>clock});
 const candidates=[];
 for(let i=0;i<2;i++){
  const next=new TaskReplyDrafts(f.db).propose('alice',f.occurrence.run_id,`test-semantic-rate-${i}`,{text:f.draft.text,evidence:f.draft.evidence});
  await f.checks.verify('alice',next.draft_id,{ledger:f.ledger,route:{provider:route.provider,model:route.model},guard:()=>{},invoke:async()=>({value:f.assessment,usage})});candidates.push(next);
 }
 assert.deepEqual(timed.check('alice',candidates[0].draft_id),{allowed:false,reason:'REPLY_RATE_LIMIT',not_before:now+60});
 clock=now+60;assert.equal(withImmediateTransaction(f.db,()=>timed.reserve('alice',candidates[0].draft_id)).allowed,true);
 clock=now+120;assert.deepEqual(timed.check('alice',candidates[1].draft_id),{allowed:false,reason:'REPLY_RATE_LIMIT',not_before:now+86400});
 const expired=new TaskReplySendGate(f.db,{now:()=>now+86401});
 assert.equal(expired.check('alice',f.draft.draft_id).reason,'REPLY_POLICY_EXPIRED');
});

test('an assessed candidate whose target changed is cancelled without projecting or spending a slot',async t=>{
 const f=await fixture(t);await f.verify(async()=>({value:f.assessment,usage}));
 f.conversations.update(f.draft.target.conversation_id,'alice',{expected_version:1,archived:true});
 const host=new TaskReplyDispatch(f.db,f.events,{enabled:true});assert.equal(host.processNext(),true);assert.equal(host.processNext(),false);
 const outcome=f.db.prepare('SELECT status,reason_code FROM wb_task_reply_dispatch_outcomes').get();
 assert.equal(outcome.status,'cancelled');assert.equal(outcome.reason_code,'REPLY_TARGET_CHANGED');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_projection_receipts').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);
});

test('a persisted provider response repairs a post-settlement check-write failure without another call',async t=>{
 const f=await fixture(t);let calls=0;
 f.db.exec("CREATE TRIGGER test_check_write_failure BEFORE INSERT ON wb_task_reply_semantic_checks BEGIN SELECT RAISE(ABORT,'test_check_write_failure'); END;");
 await assert.rejects(f.verify(async()=>{calls++;return {value:f.assessment,usage};}),/test_check_write_failure/);
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'settled');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_semantic_responses').get().n,1);
 f.db.exec('DROP TRIGGER test_check_write_failure');
 const {TaskReplySemanticChecks}=await import('../../src/persistent-tasks/reply-semantic.ts'),next=new TaskReplySemanticChecks(f.db);
 const receipt=next.recover('alice',f.draft.draft_id,{ledger:f.ledger,guard:()=>{}});assert.equal(receipt.verdict,'eligible');
 assert.deepEqual(next.recover('alice',f.draft.draft_id,{ledger:f.ledger,guard:()=>{}}),receipt);
 assert.equal(calls,1);assert.equal(f.ledger.balance('alice',f.budget.scope_id).used.model_calls,'1');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_model_budget_attempts').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_projection_receipts').get().n,0);
});

test('recovery never invents missing responses or missing usage, and cannot recover another owner',async t=>{
 const missing=await fixture(t);
 missing.db.exec("CREATE TRIGGER test_response_write_failure BEFORE INSERT ON wb_task_reply_semantic_responses BEGIN SELECT RAISE(ABORT,'test_response_write_failure'); END;");
 await assert.rejects(missing.verify(async()=>({value:missing.assessment,usage})),/auxiliary_usage_unknown/);
 assert.equal(missing.checks.recover('alice',missing.draft.draft_id,{ledger:missing.ledger,guard:()=>{}}).reason_code,'REPLY_RESPONSE_UNAVAILABLE');
 assert.equal(missing.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'unknown');
 const unknown=await fixture(t);await assert.rejects(unknown.verify(async()=>({value:unknown.assessment,usage:undefined})),/auxiliary_usage_unknown/);
 assert.throws(()=>unknown.checks.recover('alice',unknown.draft.draft_id,{ledger:unknown.ledger,guard:()=>{}}),/auxiliary_usage_unknown/);
 assert.equal(unknown.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'unknown');
 assert.throws(()=>unknown.checks.recover('bob',unknown.draft.draft_id,{ledger:unknown.ledger,guard:()=>{}}),/reply_draft_not_found/);
});

test('recovery preserves incurred costs after revocation without saving eligibility or sending',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.verify(async()=>{f.db.prepare("UPDATE wb_persistent_tasks SET status='paused' WHERE task_id=?").run(f.task.task_id);return {value:f.assessment,usage};}),/reply_authority_revoked/);
 assert.equal(f.checks.recover('alice',f.draft.draft_id,{ledger:f.ledger,guard:()=>{}}).reason_code,'REPLY_AUTHORITY_REVOKED');
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'settled');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_semantic_checks').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);
});

test('response records are immutable and their digest is checked before recovering a result',async t=>{
 const f=await fixture(t);
 f.db.exec("CREATE TRIGGER test_check_write_failure BEFORE INSERT ON wb_task_reply_semantic_checks BEGIN SELECT RAISE(ABORT,'test_check_write_failure'); END;");
 await assert.rejects(f.verify(async()=>({value:f.assessment,usage})),/test_check_write_failure/);
 assert.throws(()=>f.db.prepare("UPDATE wb_task_reply_semantic_responses SET response_json='{}'").run(),/immutable/);
 f.db.exec('DROP TRIGGER wb_task_reply_semantic_responses_no_update');f.db.prepare("UPDATE wb_task_reply_semantic_responses SET response_json='{}'").run();
 assert.throws(()=>f.checks.recover('alice',f.draft.draft_id,{ledger:f.ledger,guard:()=>{}}),/reply_semantic_corrupt/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_semantic_checks').get().n,0);
});

test('a recovery guard failure cannot roll back newly reconciled incurred usage',async t=>{
 const f=await fixture(t);
 f.db.exec("CREATE TRIGGER test_settlement_failure BEFORE UPDATE ON wb_model_budget_attempts WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'test_settlement_failure'); END;");
 await assert.rejects(f.verify(async()=>({value:f.assessment,usage})),/auxiliary_usage_unknown/);
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'unknown');
 f.db.exec('DROP TRIGGER test_settlement_failure');
 assert.throws(()=>f.checks.recover('alice',f.draft.draft_id,{ledger:f.ledger,guard:()=>{throw new Error('test_recovery_guard_expired');}}),/test_recovery_guard_expired/);
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'settled');
 assert.equal(f.ledger.balance('alice',f.budget.scope_id).used.model_calls,'1');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_semantic_checks').get().n,0);
 assert.equal(f.checks.recover('alice',f.draft.draft_id,{ledger:f.ledger,guard:()=>{}}).verdict,'eligible');
 assert.throws(()=>withImmediateTransaction(f.db,()=>f.checks.recover('alice',f.draft.draft_id,{ledger:f.ledger,guard:()=>{}})),/reply_recovery_transaction_forbidden/);
});

test('a malformed assessment remains a readable blocked fact rather than a false corruption error',async t=>{
 const f=await fixture(t);await f.verify(async()=>({value:{...f.assessment,unexpected:'ignore the directions'},usage}));
 const item=new TaskReplyHistory(f.db).history('alice',f.task.task_id).items[0];
 assert.equal(item.status,'blocked');assert.equal(item.reason,'REPLY_CHECK_MALFORMED');
 assert.equal(f.checks.recover('alice',f.draft.draft_id,{ledger:f.ledger,guard:()=>{}}).verdict,'blocked');
});

test('host CLI inspects without settling and explicitly recovers the same durable response after restart',async t=>{
 const root=resolve('.test-tmp'),dir=mkdtempSync(resolve(root,'reply-reconcile-')),database=resolve(dir,'gateway.sqlite');
 const f=await fixture(t,{text:'Release available.'},'conversation',database);
 t.after(()=>{const child=relative(root,dir);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(dir,{recursive:true,force:true});});
 f.db.exec("CREATE TRIGGER test_settlement_failure BEFORE UPDATE ON wb_model_budget_attempts WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'test_settlement_failure'); END;");
 await assert.rejects(f.verify(async()=>({value:f.assessment,usage})),/auxiliary_usage_unknown/);f.db.exec('DROP TRIGGER test_settlement_failure');
 const cli=resolve('src/persistent-tasks/reply-reconcile-main.ts');
 const run=(operation,owner='alice')=>spawnSync(process.execPath,[cli,operation,database,owner,f.draft.draft_id],{encoding:'utf8',env:{...process.env,NODE_NO_WARNINGS:'1'}});
 const inspect=run('inspect');assert.equal(inspect.status,0,inspect.stderr);const diagnosis=JSON.parse(inspect.stdout);
 assert.equal(diagnosis.budget_state,'unknown');assert.equal(diagnosis.provider_response_saved,true);assert.equal(diagnosis.sending_performed,false);
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'unknown');
 const applied=run('recover');assert.equal(applied.status,0,applied.stderr);assert.equal(JSON.parse(applied.stdout).verdict,'eligible');
 const replay=run('recover');assert.equal(replay.status,0,replay.stderr);assert.deepEqual(JSON.parse(replay.stdout),JSON.parse(applied.stdout));
 assert.equal(f.db.prepare('SELECT state FROM wb_model_budget_attempts').get().state,'settled');
 assert.equal(f.ledger.balance('alice',f.budget.scope_id).used.model_calls,'1');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_projection_receipts').get().n,0);
 for(const result of [inspect,applied,replay])assert.equal(result.stdout.includes('Release available.'),false);
 const foreign=run('recover','bob');assert.equal(foreign.status,1);assert.equal(foreign.stderr.trim(),'reply_reconciliation_failed');
});

test('finalization consumes the same bounded assessment that was captured, not a mutable provider object',async t=>{
 const f=await fixture(t);let conversions=0;
 const value={toJSON(){conversions++;return conversions===1?f.assessment:{...f.assessment,risk:'high'};}};
 const receipt=await f.verify(async()=>({value,usage}));assert.equal(receipt.verdict,'eligible');assert.equal(conversions,1);
 assert.deepEqual(f.checks.recover('alice',f.draft.draft_id,{ledger:f.ledger,guard:()=>{}}),receipt);
});

