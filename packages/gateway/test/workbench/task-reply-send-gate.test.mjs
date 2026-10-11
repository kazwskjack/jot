import test from 'node:test';import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';
import {TaskReplyDrafts} from '../../src/persistent-tasks/reply-drafts.ts';
import {TaskReplyPolicies} from '../../src/persistent-tasks/reply-policy.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {InteractionService} from '../../src/interactions/service.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {TaskReplySendGate} from '../../src/persistent-tasks/reply-send-gate.ts';
async function fixture(t,mode='review',quiet=null){
 const f=await buildServer({databasePath:':memory:',workspaces:['shared'],workbenchRoot:'.test-tmp/reply-send-gate'});t.after(async()=>{await f.app.close();f.db.close();});
 const now=Math.floor(Date.now()/1000);let clock=now;
 const agent=f.workbench.createAgent('alice',{name:'Reader',workspace_id:'shared'}),target=f.conversations.create('alice',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}}),task=f.persistentTasks.create('alice',{agent_id:agent.agent_id,title:'Notes',objective:'Read',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 new TaskReplyPolicies(f.db).update('alice',task.task_id,{expected_version:0,policy:{mode,target:{kind:'conversation',conversation_id:target.conversation_id},direction:{topic:'Release notes',tone:'Brief',evidence_required:true,forbidden:[]},limits:{max_per_24_hours:2,min_interval_seconds:60,expires_at:new Date((now+2*86400)*1000).toISOString()},quiet_hours:quiet}});
 const occurrence=f.persistentTasks.runNow('alice',task.task_id,'test-gate-run'),proof=new TaskExecutionEvidence(f.db).record(occurrence.run_id,'test-gate-proof','web.read',{url:'https://example.test/notes',text:'Release available'}),drafts=new TaskReplyDrafts(f.db,f.events),interactions=new InteractionService(f.db,f.events,drafts),gate=new TaskReplySendGate(f.db,{now:()=>clock});
 let count=0;const draft=()=>drafts.propose('alice',occurrence.run_id,`test-gate-draft-${++count}`,{text:'Release available',evidence:[proof]});
 const approve=d=>{const card=drafts.requestReview('alice',d.draft_id);interactions.decide(card.interaction_id,'alice',{expected_version:1,decision:'approve',action_digest:card.action_digest},`test-gate-review-${count}`);};
 const reserve=d=>withImmediateTransaction(f.db,()=>gate.reserve('alice',d.draft_id));
 return {...f,agent,task,target,occurrence,drafts,gate,draft,approve,reserve,now,setClock:value=>{clock=value;}};
}
test('only the exact approved reply can reserve an attempt; draft and autonomous modes remain fenced',async t=>{
 for(const [mode,reason] of [['draft','REPLY_DRAFT_ONLY'],['bounded_auto_reply','REPLY_SEMANTIC_CHECK_REQUIRED'],['review','REPLY_REVIEW_REQUIRED']]){const f=await fixture(t,mode),d=f.draft();assert.deepEqual(f.gate.check('alice',d.draft_id),{allowed:false,reason,not_before:null});assert.equal(f.reserve(d).allowed,false);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);}
 const f=await fixture(t),d=f.draft();f.approve(d);assert.equal(f.gate.check('alice',d.draft_id).allowed,true);assert.throws(()=>f.gate.reserve('alice',d.draft_id),/reply_send_transaction_required/);assert.throws(()=>f.gate.check('bob',d.draft_id),/reply_draft_not_found/);
});
test('attempt slots remain reserved, obey cooldown and daily quota, and replay without consuming another slot',async t=>{
 const f=await fixture(t),a=f.draft();f.approve(a);const first=f.reserve(a);assert.equal(first.allowed,true);assert.deepEqual(f.reserve(a),first);
 const b=f.draft();f.approve(b);assert.deepEqual(f.gate.check('alice',b.draft_id),{allowed:false,reason:'REPLY_RATE_LIMIT',not_before:f.now+60});f.setClock(f.now+60);assert.equal(f.reserve(b).allowed,true);
 const c=f.draft();f.approve(c);f.setClock(f.now+120);assert.deepEqual(f.gate.check('alice',c.draft_id),{allowed:false,reason:'REPLY_RATE_LIMIT',not_before:f.now+86400});assert.equal(f.reserve(c).allowed,false);f.setClock(f.now+86400);assert.equal(f.reserve(c).allowed,true);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,3);assert.throws(()=>f.db.exec('DELETE FROM wb_task_reply_send_reservations'),/reply_send_reservation_immutable/);
});
test('separate tasks cannot bypass the same owner and target cooldown',async t=>{
 const f=await fixture(t),a=f.draft();f.approve(a);assert.equal(f.reserve(a).allowed,true);
 const task=f.persistentTasks.create('alice',{agent_id:f.agent.agent_id,title:'Second reader',objective:'Read',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}}),policy=new TaskReplyPolicies(f.db).get('alice',f.task.task_id).policy;
 new TaskReplyPolicies(f.db).update('alice',task.task_id,{expected_version:0,policy});const occurrence=f.persistentTasks.runNow('alice',task.task_id,'test-second-task-run'),proof=new TaskExecutionEvidence(f.db).record(occurrence.run_id,'test-second-task-proof','web.read',{url:'https://example.test/notes',text:'Another release'}),b=f.drafts.propose('alice',occurrence.run_id,'test-second-task-draft',{text:'Another release',evidence:[proof]}),card=f.drafts.requestReview('alice',b.draft_id);
 new InteractionService(f.db,f.events,f.drafts).decide(card.interaction_id,'alice',{expected_version:1,decision:'approve',action_digest:card.action_digest},'test-second-task-review');assert.deepEqual(f.gate.check('alice',b.draft_id),{allowed:false,reason:'REPLY_RATE_LIMIT',not_before:f.now+60});
});
test('quiet hours defer reviewed replies without spending a slot and revocation also blocks an existing reservation',async t=>{
 const f=await fixture(t,'review',{start:'00:00',end:'23:59',timezone:'UTC'}),d=f.draft();f.approve(d);const midnight=Math.floor(Date.now()/86400000)*86400;f.setClock(midnight+12*3600);assert.deepEqual(f.gate.check('alice',d.draft_id),{allowed:false,reason:'REPLY_QUIET_HOURS',not_before:midnight+23*3600+59*60});assert.equal(f.reserve(d).allowed,false);
 f.setClock(midnight+23*3600+59*60);assert.equal(f.reserve(d).allowed,true);f.conversations.update(f.target.conversation_id,'alice',{expected_version:1,archived:true});assert.equal(f.reserve(d).reason,'REPLY_TARGET_CHANGED');
});
test('outbox transaction failure rolls back the attempt reservation rather than consuming quota',async t=>{
 const f=await fixture(t),d=f.draft();f.approve(d);assert.throws(()=>withImmediateTransaction(f.db,()=>{assert.equal(f.gate.reserve('alice',d.draft_id).allowed,true);throw new Error('test-outbox-write-failure');}),/test-outbox-write-failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);assert.equal(f.reserve(d).allowed,true);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_channel_deliveries').get().n,0);
});
