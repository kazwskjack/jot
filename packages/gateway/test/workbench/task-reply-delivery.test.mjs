import test from 'node:test';import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';
import {TaskReplyDrafts} from '../../src/persistent-tasks/reply-drafts.ts';
import {TaskReplyPolicies} from '../../src/persistent-tasks/reply-policy.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {InteractionService} from '../../src/interactions/service.ts';
import {OwnerChannelBindings} from '../../src/channels/owner-bindings.ts';
import {ChannelDeliveryService} from '../../src/channels/delivery.ts';
import {ChannelDeliveryWorker} from '../../src/channels/worker.ts';
import {TaskReplyDelivery} from '../../src/persistent-tasks/reply-delivery.ts';
async function fixture(t,quiet=null,text='Release available'){
 const f=await buildServer({databasePath:':memory:',workspaces:['shared'],workbenchRoot:'.test-tmp/reply-delivery'});t.after(async()=>{await f.app.close();f.db.close();});let clock=Math.floor(Date.now()/1000);
 const bindings=new OwnerChannelBindings(f.db,{enabled:['wecom']}),challenge=bindings.create('alice','wecom','test-reply-channel');bindings.acceptProof('wecom','test-reply-recipient',challenge.code);const binding=bindings.resolve('alice',challenge.channel_binding_id);
 const agent=f.workbench.createAgent('alice',{name:'Reader',workspace_id:'shared'}),task=f.persistentTasks.create('alice',{agent_id:agent.agent_id,title:'Notes',objective:'Read',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 new TaskReplyPolicies(f.db).update('alice',task.task_id,{expected_version:0,policy:{mode:'review',target:{kind:'channel',channel_binding_id:binding.channel_binding_id},direction:{topic:'Release notes',tone:'Brief',evidence_required:true,forbidden:[]},limits:{max_per_24_hours:2,min_interval_seconds:60,expires_at:new Date((clock+2*86400)*1000).toISOString()},quiet_hours:quiet}});
 const occurrence=f.persistentTasks.runNow('alice',task.task_id,'test-reply-delivery-run'),proof=new TaskExecutionEvidence(f.db).record(occurrence.run_id,'test-delivery-proof','web.read',{url:'https://example.test/notes',text:'Release available'}),drafts=new TaskReplyDrafts(f.db,f.events),draft=drafts.propose('alice',occurrence.run_id,'test-delivery-draft',{text,evidence:[proof]}),card=drafts.requestReview('alice',draft.draft_id);
 new InteractionService(f.db,f.events,drafts).decide(card.interaction_id,'alice',{expected_version:1,decision:'approve',action_digest:card.action_digest},'test-delivery-review');
 const store=new ChannelDeliveryService(f.db,()=>clock),replies=new TaskReplyDelivery(f.db,{now:()=>clock});let sends=0;
 const worker=(behavior=async()=>({provider_message_id:'test-provider-receipt'}))=>new ChannelDeliveryWorker(store,{send:async(sentText,recipient)=>{sends++;assert.equal(sentText,text);assert.equal(recipient,'test-reply-recipient');return behavior();},sendFile:async()=>{throw Error('unexpected-file-send');}},{registerDeliveryReceipt:async()=>{throw Error('unexpected-runtime-receipt');}},{resolveArtifact:()=>{throw Error('unexpected-artifact');},resolveRuntime:()=>{throw Error('unexpected-runtime');}});
 return {...f,bindings,binding,draft,store,replies,worker,sends:()=>sends,setClock:value=>{clock=value;}};
}
test('reviewed channel reply uses the existing outbox and worker exactly once without a notification grant',async t=>{
 const f=await fixture(t),effect=f.replies.enqueue('alice',f.draft.draft_id);assert.equal(effect.status,'pending');assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_delivery_authorizations').get().n,0);
 assert.equal(await f.worker().processNext(),true);assert.equal(f.store.get(effect.effect_id).status,'delivered');assert.equal(f.sends(),1);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,1);assert.equal(f.replies.enqueue('alice',f.draft.draft_id).effect_id,effect.effect_id);assert.equal(await f.worker().processNext(),false);assert.throws(()=>f.replies.enqueue('bob',f.draft.draft_id),/reply_draft_not_found/);
});
test('revoked binding and changed text cancel before any provider call',async t=>{
 for(const change of ['revoke','tamper']){const f=await fixture(t),effect=f.replies.enqueue('alice',f.draft.draft_id);if(change==='revoke')f.bindings.revoke('alice',f.binding.channel_binding_id,f.binding.version);else f.db.prepare('UPDATE ga_channel_deliveries SET payload_json=? WHERE effect_id=?').run(JSON.stringify({kind:'text',text:'Changed payload'}),effect.effect_id);await f.worker().processNext();assert.equal(f.store.get(effect.effect_id).status,'cancelled');assert.equal(f.sends(),0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);}
});
test('network ambiguity retains the attempt slot and is never automatically sent again',async t=>{
 const f=await fixture(t),effect=f.replies.enqueue('alice',f.draft.draft_id);await f.worker(async()=>{throw Error('test-network-timeout');}).processNext();assert.equal(f.store.get(effect.effect_id).status,'outcome_unknown');assert.equal(f.sends(),1);assert.equal(await f.worker().processNext(),false);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,1);
});
test('quiet hours defer the original outbox effect without digesting or spending an attempt',async t=>{
 const f=await fixture(t,{start:'00:00',end:'23:59',timezone:'UTC'}),midnight=Math.floor(Date.now()/86400000)*86400;f.setClock(midnight+12*3600);const effect=f.replies.enqueue('alice',f.draft.draft_id);await f.worker().processNext();assert.equal(f.store.get(effect.effect_id).status,'pending');assert.equal(f.sends(),0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);assert.equal(await f.worker().processNext(),false);f.setClock(midnight+23*3600+59*60);await f.worker().processNext();assert.equal(f.store.get(effect.effect_id).status,'delivered');assert.equal(f.sends(),1);
});
test('failed reply grant insertion rolls back the outbox effect atomically',async t=>{
 const f=await fixture(t);f.db.exec("CREATE TRIGGER test_reply_grant_failure BEFORE INSERT ON wb_task_reply_delivery_grants BEGIN SELECT RAISE(ABORT,'test_reply_grant_failure'); END;");assert.throws(()=>f.replies.enqueue('alice',f.draft.draft_id),/test_reply_grant_failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_delivery_grants').get().n,0);
});
test('provider receives exactly the approved whitespace rather than a silently trimmed draft',async t=>{
 const f=await fixture(t,null,'  Release available\n'),effect=f.replies.enqueue('alice',f.draft.draft_id);await f.worker().processNext();assert.equal(f.store.get(effect.effect_id).status,'delivered');assert.equal(f.sends(),1);
});
test('confirmed provider receipt recovers after database failure and revocation without sending twice',async t=>{
 const f=await fixture(t),effect=f.replies.enqueue('alice',f.draft.draft_id);f.db.exec("CREATE TRIGGER test_reply_receipt_failure BEFORE UPDATE OF status ON ga_channel_deliveries WHEN NEW.status='delivered' BEGIN SELECT RAISE(ABORT,'test-receipt-failure'); END;");await f.worker().processNext();assert.equal(f.store.get(effect.effect_id).status,'receipt_pending');assert.equal(f.sends(),1);
 f.db.exec('DROP TRIGGER test_reply_receipt_failure');f.bindings.revoke('alice',f.binding.channel_binding_id,f.binding.version);await f.worker().processNext();assert.equal(f.store.get(effect.effect_id).status,'delivered');assert.equal(f.sends(),1);assert.equal(f.replies.enqueue('alice',f.draft.draft_id).status,'delivered');
});
test('reserved reply effect without a grant cannot fall through to ordinary delivery authorization',async t=>{
 const f=await fixture(t),effect=f.replies.enqueue('alice',f.draft.draft_id);f.db.prepare("INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at) VALUES('reply-delivery-test-ungranted',?,?,?, ?,NULL,?,'pending',?,?)").run(effect.run_id,'test-ungranted-message',effect.destination,effect.recipient,effect.payload_json,effect.created_at,effect.updated_at);
 const first=f.store.claim('test-reply-worker',90);assert.ok(first);if(first.effect_id===effect.effect_id){f.store.authorizeSend(first.effect_id,first.generation);f.store.recordProviderUnknown(first.effect_id,first.generation);}
 const ungranted=first.effect_id==='reply-delivery-test-ungranted'?first:f.store.claim('test-reply-worker',90);assert.equal(ungranted.effect_id,'reply-delivery-test-ungranted');assert.equal(f.store.authorizeSend(ungranted.effect_id,ungranted.generation),false);assert.equal(f.store.get(ungranted.effect_id).status,'cancelled');assert.equal(f.sends(),0);
});
