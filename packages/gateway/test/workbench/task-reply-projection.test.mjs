import test from 'node:test';import assert from 'node:assert/strict';
import {buildServer} from '../../src/server.ts';
import {TaskReplyDrafts} from '../../src/persistent-tasks/reply-drafts.ts';
import {TaskReplyPolicies} from '../../src/persistent-tasks/reply-policy.ts';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {InteractionService} from '../../src/interactions/service.ts';
import {TaskReplyProjection} from '../../src/persistent-tasks/reply-projection.ts';
async function fixture(t){
 const f=await buildServer({databasePath:':memory:',workspaces:['shared'],workbenchRoot:'.test-tmp/reply-projection'});t.after(async()=>{await f.app.close();f.db.close();});let clock=Math.floor(Date.now()/1000);
 const agent=f.workbench.createAgent('alice',{name:'Reader',workspace_id:'shared'}),target=f.conversations.create('alice',{workspace_id:'shared',model:{provider:'harness',model:'automatic'}}),task=f.persistentTasks.create('alice',{agent_id:agent.agent_id,title:'Notes',objective:'Read',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'}});
 new TaskReplyPolicies(f.db).update('alice',task.task_id,{expected_version:0,policy:{mode:'review',target:{kind:'conversation',conversation_id:target.conversation_id},direction:{topic:'Release notes',tone:'Brief',evidence_required:true,forbidden:[]},limits:{max_per_24_hours:2,min_interval_seconds:60,expires_at:new Date((clock+86400)*1000).toISOString()},quiet_hours:null}});
 const occurrence=f.persistentTasks.runNow('alice',task.task_id,'test-projection-run'),proof=new TaskExecutionEvidence(f.db).record(occurrence.run_id,'test-projection-proof','web.read',{url:'https://example.test/notes',text:'Release available'}),drafts=new TaskReplyDrafts(f.db,f.events),projection=new TaskReplyProjection(f.db,f.events,{now:()=>clock});let count=0;
 const approved=()=>{const draft=drafts.propose('alice',occurrence.run_id,`test-projection-draft-${++count}`,{text:` Release ${count}\n`,evidence:[proof]}),card=drafts.requestReview('alice',draft.draft_id);new InteractionService(f.db,f.events,drafts).decide(card.interaction_id,'alice',{expected_version:1,decision:'approve',action_digest:card.action_digest},`test-projection-approval-${count}`);return draft;};
 return {...f,agent,target,occurrence,projection,approved,advance:()=>{clock+=60;}};
}
test('reply projection atomically creates one runless assistant message with an owned receipt and no new execution',async t=>{
 const f=await fixture(t),draft=f.approved(),receipt=f.projection.project('alice',draft.draft_id);assert.equal(receipt.status,'delivered');assert.deepEqual(f.projection.project('alice',draft.draft_id),receipt);assert.throws(()=>f.projection.project('bob',draft.draft_id),/reply_draft_not_found/);
 const message=f.db.prepare('SELECT * FROM ga_messages WHERE id=?').get(receipt.message_id);assert.equal(message.conversation_id,f.target.conversation_id);assert.equal(message.run_id,null);assert.equal(message.role,'assistant');assert.equal(JSON.parse(message.content_json).blocks[0].text,draft.text);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 const snapshot=await f.app.inject({url:`/v1/conversations/${f.target.conversation_id}/snapshot`,headers:{'x-user-id':'alice'}});assert.equal(snapshot.statusCode,200,snapshot.body);assert.equal(snapshot.json().messages[0].run_id,null);assert.equal(snapshot.json().runs.length,0);
 const events=f.events.replay(f.target.conversation_id,0,100);assert.equal(events.length,1);assert.equal(events[0].type,'message.created');assert.equal(events[0].run_id,null);assert.equal(events[0].payload.run_id,null);
});
test('two projected replies survive history and do not trigger user or execution-result monitors',async t=>{
 const f=await fixture(t);for(const kind of ['conversation_message','conversation_result'])f.persistentTasks.create('alice',{agent_id:f.agent.agent_id,title:kind,objective:'Watch',trigger:{kind,conversation_id:f.target.conversation_id}});
 const a=f.approved();f.projection.project('alice',a.draft_id);f.advance();f.projection.project('alice',f.approved().draft_id);await f.persistentTasks.tick();assert.equal(f.db.prepare("SELECT count(*) n FROM ga_messages WHERE conversation_id=? AND role='assistant'").get(f.target.conversation_id).n,2);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});
test('failed event insertion rolls back the projected message, receipt and attempt slot',async t=>{
 const f=await fixture(t),draft=f.approved();f.db.exec(`CREATE TRIGGER test_projection_event_failure BEFORE INSERT ON ga_events WHEN NEW.conversation_id='${f.target.conversation_id}' BEGIN SELECT RAISE(ABORT,'test_projection_event_failure'); END;`);assert.throws(()=>f.projection.project('alice',draft.draft_id),/test_projection_event_failure/);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_projection_receipts').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_messages WHERE conversation_id=?').get(f.target.conversation_id).n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_reply_send_reservations').get().n,0);
});
