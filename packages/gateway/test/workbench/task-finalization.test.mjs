import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {completionFixture,candidate} from './task-completion-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {prepareTaskCompletion,confirmTaskCompletion} from '../../src/persistent-tasks/completion-handshake.ts';
import {buildServer} from '../../src/server.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {ChannelDeliveryWorker} from '../../src/channels/worker.ts';
const before={host_status:'idle',goal:{goal_id:'goal-fixture',goal_revision:8,phase:'paused',activation:'disarmed',rounds_started:1,max_goal_rounds:1}};
const after={host_status:'idle',goal:{...before.goal,goal_revision:9,phase:'complete'},checkpoint:{session_ref:'session-fixture',seq_exclusive:4,turn_end_seq:2,goal_id:'goal-fixture',goal_revision:9,log_sha256:'b'.repeat(64)}};
async function ready(t,confirmed=true){const f=await completionFixture(t),card=(await f.list())[0];
 const response=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['accept'],custom_text:''}))});assert.equal(response.statusCode,202,response.body);
 const intent=withImmediateTransaction(f.db,()=>prepareTaskCompletion(f.db,'alice',f.runId,before));
 if(confirmed)withImmediateTransaction(f.db,()=>confirmTaskCompletion(f.db,'alice',f.runId,intent.intent_id,after));return {...f,intent};
}
const publish=f=>f.coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id);

test('task notification rechecks saved authority before provider send and keeps receipt-only recovery independent',async t=>{
 for(const fault of ['none','pause','role','binding','owner','recipient','missing','receipt']){
  const f=await ready(t),now=new Date().toISOString();f.db.prepare('INSERT INTO ga_channel_bindings VALUES(?,?,?,?,?)').run('wecom','fixture-recipient',f.occurrence.conversation_id,now,now);
  const receipt=publish(f),store=new ChannelDeliveryService(f.db),effect=receipt.delivery_effect_ids[0];let sends=0;
  if(fault==='receipt'){const claimed=store.claim('fixture-prior',90);store.recordProviderSent(effect,claimed.generation,{provider_message_id:'already-sent'});}
  if(fault==='pause'||fault==='receipt')f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
  if(fault==='role')f.db.prepare('UPDATE wb_agents SET capability_epoch=capability_epoch+1 WHERE agent_id=?').run(f.task.agent_id);
  if(fault==='binding')f.db.prepare("DELETE FROM ga_channel_bindings WHERE channel='wecom'").run();
  if(fault==='owner')f.db.prepare('UPDATE ga_conversations SET owner_id=? WHERE id=?').run('other-owner',f.occurrence.conversation_id);
  if(fault==='recipient')f.db.prepare('UPDATE ga_channel_deliveries SET recipient=? WHERE effect_id=?').run('other-recipient',effect);
  if(fault==='missing')f.db.exec('DROP TABLE wb_task_delivery_authorizations');
  const worker=new ChannelDeliveryWorker(store,{send:async()=>{sends++;return {provider_message_id:'fixture-sent'};},sendFile:async()=>{throw new Error('unexpected_file');}},{registerDeliveryReceipt:async()=>{throw new Error('unexpected_runtime');}},{resolveArtifact:()=>{throw new Error('unexpected_artifact');},resolveRuntime:()=>{throw new Error('unexpected_runtime');}});
  await worker.processNext();assert.equal(sends,fault==='none'?1:0,fault);
  assert.equal(store.get(effect).status,['none','receipt'].includes(fault)?'delivered':'cancelled',fault);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
 }
});

test('task delivery stops later parts after revocation without hiding the first provider receipt',async t=>{
 const f=await ready(t),now=new Date().toISOString();f.db.prepare('INSERT INTO ga_channel_bindings VALUES(?,?,?,?,?)').run('wecom','fixture-recipient',f.occurrence.conversation_id,now,now);
 const receipt=publish(f),store=new ChannelDeliveryService(f.db),original=receipt.delivery_effect_ids[0];
 const scope=f.db.prepare('SELECT * FROM wb_task_delivery_authorizations WHERE effect_id=?').get(original);
 assert.throws(()=>f.db.prepare('UPDATE wb_task_delivery_authorizations SET generation=generation+1').run(),/task_delivery_authorization_immutable/);
 const file=withImmediateTransaction(f.db,()=>{f.db.prepare("UPDATE ga_channel_deliveries SET status='cancelled' WHERE effect_id=?").run(original);
  const item=store.enqueueExternal({runId:f.runId,messageId:receipt.message_id,destination:'wecom',recipient:'fixture-recipient',artifactRef:'fixture-group'});
  store.bindTaskAuthorization(item.effect_id,scope,f.occurrence.conversation_id,'fixture-recipient');return item;});
 let sent=0;
 const worker=new ChannelDeliveryWorker(store,{send:async()=>{throw new Error('unexpected_text');},sendFile:async()=>{sent++;f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);return {provider_message_id:'first-part-confirmed'};}},{registerDeliveryReceipt:async()=>{throw new Error('incomplete_group_must_not_settle');}},{resolveArtifact:()=>{throw new Error('unused');},resolveArtifacts:()=>[{path:'fixture-1',displayName:'1'},{path:'fixture-2',displayName:'2'}],resolveRuntime:()=>{throw new Error('unused');}});
 await worker.processNext();assert.equal(sent,1);const effect=store.get(file.effect_id);assert.equal(effect.status,'outcome_unknown');
 assert.equal(JSON.parse(effect.provider_receipt_json).receipts[0].provider_message_id,'first-part-confirmed');assert.equal(await worker.processNext(),false);
});

test('one occurrence publishes its owner-reviewed text, consumes its certificate and commits native mapping/checkpoint and notification outbox together',async t=>{
 const f=await ready(t),now=new Date().toISOString();
 f.db.prepare('INSERT INTO ga_channel_bindings VALUES(?,?,?,?,?)').run('wecom','fixture-only-recipient',f.occurrence.conversation_id,now,now);
 const budget=f.modelBudgets.balancesForRun('alice',f.runId),receipt=publish(f);assert.equal(receipt.status,'succeeded');
 assert.equal(f.runs.get(f.runId,'alice').status,'succeeded');
 const messages=f.db.prepare("SELECT * FROM ga_messages WHERE role='assistant'").all();assert.equal(messages.length,1);assert.equal(JSON.parse(messages[0].content_json).blocks[0].text,candidate.text);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,1);
 assert.equal(f.db.prepare('SELECT status FROM ga_candidate_answers').get().status,'verified');
 assert.equal(f.db.prepare('SELECT goal_revision FROM wb_native_goal_bindings').get().goal_revision,9);
 assert.equal(f.db.prepare('SELECT goal_revision FROM ga_session_checkpoints WHERE checkpoint_id=?').get(f.runs.get(f.runId,'alice').checkpoint_id).goal_revision,9);
 assert.equal(f.db.prepare('SELECT business_state FROM wb_task_occurrences').get().business_state,'completed');
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].business_state,'completed');
 assert.equal(f.db.prepare('SELECT status FROM ga_channel_deliveries').get().status,'pending');assert.equal(receipt.delivery_effect_ids.length,1);
 assert.deepEqual(publish(f),receipt);assert.deepEqual(f.modelBudgets.balancesForRun('alice',f.runId),budget);
 assert.throws(()=>f.db.prepare('DELETE FROM wb_task_finalizations').run(),/task_finalization_immutable/);
});

test('a normal task list refresh preserves an accepted review so the finalizer can still consume it',async t=>{
 const f=await ready(t);
 assert.equal(f.persistentTasks.occurrences('alice',f.task.task_id).items[0].business_state,'acceptance_confirmed');
 assert.equal(publish(f).status,'succeeded');
});

test('a second Gateway recovers the original publication without another message, event or delivery',async t=>{
 const f=await ready(t),receipt=publish(f),events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n,other=await buildServer(f.fixtureConfig);
 try{const coordinator=new HarnessCoordinator(other.db,other.runs,other.events);assert.deepEqual(coordinator.finalizeReviewedTask('alice',f.runId,f.intent.intent_id),receipt);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
 }finally{await other.app.close();other.db.close();}
});

test('missing native proof, revoked task, foreign owner or mismatched intent cannot publish',async t=>{
 for(const fault of ['missing','stale','owner','intent']){
  const f=await ready(t,fault!=='missing');
  if(fault==='stale')f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
  assert.throws(()=>f.coordinator.finalizeReviewedTask(fault==='owner'?'mallory':'alice',f.runId,fault==='intent'?'foreign-intent':f.intent.intent_id),/task_completion_state_conflict|task_finalization_unconfirmed|task_business_certificate_not_found|task_finalization_conflict/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);
 }
});

test('a fault at finalization commit rolls message, event, candidate, mapping, checkpoint and outbox back together',async t=>{
 const f=await ready(t),now=new Date().toISOString();f.db.prepare('INSERT INTO ga_channel_bindings VALUES(?,?,?,?,?)').run('wecom','fixture-only-recipient',f.occurrence.conversation_id,now,now);
 new ChannelDeliveryService(f.db);
 const events=f.db.prepare('SELECT count(*) n FROM ga_events').get().n;
 f.db.exec("CREATE TRIGGER finalization_fault BEFORE INSERT ON wb_task_finalizations BEGIN SELECT RAISE(ABORT,'finalization_save_failed'); END");
 assert.throws(()=>publish(f),/finalization_save_failed/);
 assert.equal(f.runs.get(f.runId,'alice').status,'waiting_approval');assert.equal(f.db.prepare('SELECT goal_revision FROM wb_native_goal_bindings').get().goal_revision,8);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_session_checkpoints').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_candidate_answers').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_events').get().n,events);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_delivery_authorizations').get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,0);
 f.db.exec('DROP TRIGGER finalization_fault');assert.equal(publish(f).status,'succeeded');
});

test('a real process exit after publication commit recovers one final answer without redoing native completion',async t=>{
 const f=await ready(t),script=`import {buildServer} from ${JSON.stringify(new URL('../../src/server.ts',import.meta.url).href)};
  import {HarnessCoordinator} from ${JSON.stringify(new URL('../../src/harness/coordinator.ts',import.meta.url).href)};
  const f=await buildServer(${JSON.stringify(f.fixtureConfig)});new HarnessCoordinator(f.db,f.runs,f.events).finalizeReviewedTask('alice',${JSON.stringify(f.runId)},${JSON.stringify(f.intent.intent_id)});process.exit(73);`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:15000,encoding:'utf8'});assert.equal(child.status,73,child.stderr);
 const receipt=publish(f);assert.equal(receipt.status,'succeeded');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
});

for(const holdMs of [0,120])test('two ready Gateway processes racing the same occurrence recover one publication receipt; lock hold='+holdMs,async t=>{
 const f=await ready(t),locked=f.fixtureConfig.databasePath+'.synthetic-lock-held',refused=f.fixtureConfig.databasePath+'.synthetic-lock-refused',script=`import {buildServer} from ${JSON.stringify(new URL('../../src/server.ts',import.meta.url).href)};
  import {existsSync,writeFileSync} from 'node:fs';
  import {HarnessCoordinator} from ${JSON.stringify(new URL('../../src/harness/coordinator.ts',import.meta.url).href)};
  const f=await buildServer(${JSON.stringify(f.fixtureConfig)}),c=new HarnessCoordinator(f.db,f.runs,f.events);
  if(f.db.isTransaction)throw Error('publication fixture unexpectedly owns a transaction');
  const ordinal=Number(process.argv.at(-1));
  let began=false;const exec=f.db.exec.bind(f.db);f.db.exec=sql=>{const result=exec(sql);if(sql==='BEGIN IMMEDIATE'){began=true;if(${holdMs}&&ordinal===0){writeFileSync(${JSON.stringify(locked)},'synthetic lock held');const deadline=Date.now()+3000;while(!existsSync(${JSON.stringify(refused)})){if(Date.now()>deadline)throw Error('controlled contender did not confirm refusal');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,${holdMs});}}return result;};
  process.once('message',()=>{began=false;try{const receipt=c.finalizeReviewedTask('alice',${JSON.stringify(f.runId)},${JSON.stringify(f.intent.intent_id)});process.send({receipt},()=>process.exit(0));}
   catch(e){if(e.errcode===5&&!began){if(${holdMs}&&ordinal===1)writeFileSync(${JSON.stringify(refused)},'synthetic acquisition refused');process.send({contention:{phase:'before_begin',code:5}},()=>process.exit(0));}else process.send({error:e.stack??e.message},()=>process.exit(1));}});process.send({ready:true});`;
 const jobs=[];
 for(let index=0;index<2;index++){
  const child=spawn(process.execPath,['--input-type=module','-e',script,String(index)],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});let diagnostics='',receipt;
  child.stderr.on('data',chunk=>{diagnostics+=chunk;});
  let readyResolve,readyReject;const started=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const finished=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill();reject(new Error('publication child timeout'));},15000);
   child.on('error',error=>{clearTimeout(timer);readyReject(error);reject(error);});
   child.on('message',message=>{if(message.ready)readyResolve();if(message.receipt||message.contention)receipt=message;if(message.error)diagnostics+=message.error;});
   child.on('exit',code=>{clearTimeout(timer);if(code!==0){const error=new Error(diagnostics);readyReject(error);reject(error);}else resolve(receipt);});
  });
  started.catch(()=>{});finished.catch(()=>{});
  jobs.push({child,started,finished});
 }
 try{
 await Promise.all(jobs.map(j=>j.started));
 if(holdMs){jobs[0].child.send('go');const deadline=Date.now()+3000;while(!existsSync(locked)){if(Date.now()>deadline)throw Error('publisher did not confirm held lock');await new Promise(resolve=>setTimeout(resolve,2));}jobs[1].child.send('go');}
 else jobs.forEach(j=>j.child.send('go'));
 const results=await Promise.all(jobs.map(j=>j.finished));assert.ok(results.some(result=>result?.receipt),'a real competing publisher must commit');
 if(holdMs)assert.ok(results.some(result=>result?.contention),'controlled hold must exercise bounded acquisition refusal');
 const receipts=results.map(result=>{
  if(result.receipt)return result.receipt;
  assert.deepEqual(result.contention,{phase:'before_begin',code:5});
  // The winner has committed. Recover its existing immutable receipt using the
  // same original operation; no native completion or publication is repeated.
  const before=f.db.prepare('SELECT total_changes() n').get().n,receipt=publish(f);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);return receipt;
 });assert.deepEqual(receipts[0],receipts[1]);
 assert.equal(receipts[0].status,'succeeded');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE role='assistant'").get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_native_completions').get().n,1);
 }finally{
  await Promise.all(jobs.filter(job=>job.child.exitCode===null&&job.child.signalCode===null).map(job=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('publication race child cleanup timed out')),5000);job.child.once('exit',()=>{clearTimeout(timer);resolve();});job.child.kill();})));
 }
});
