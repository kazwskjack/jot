import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openProductDatabase, withImmediateTransaction } from '../../src/db/database.ts';
import { EventStore } from '../../src/events/event-store.ts';
import { ConversationRepository } from '../../src/conversations/repository.ts';
import { RunRepository } from '../../src/runs/repository.ts';
import { WorkbenchService } from '../../src/workbench/service.ts';
import { PersistentTaskService } from '../../src/persistent-tasks/service.ts';

function fixture(options={}) {
  const base='.test-tmp';mkdirSync(base,{recursive:true});
  const directory=mkdtempSync(join(base,'dialogue-'));const path=join(directory,'synthetic.sqlite');
  const f={directory,path,now:new Date('2026-10-02T00:00:00Z')};
  f.open=()=>{f.db=openProductDatabase(path);f.events=new EventStore(f.db);f.conversations=new ConversationRepository(f.db);
    f.runs=new RunRepository(f.db,f.events);f.workbench=new WorkbenchService(f.db,{workspaceIds:['ws'],root:join(directory,'workspace')});
    f.service=new PersistentTaskService(f.db,f.workbench,{events:f.events,now:()=>f.now,...options});};
  f.open();f.agent=f.workbench.createAgent('alice',{name:'Observer',instructions:'Read new authorized conversation facts'});
  f.source=f.conversations.create('alice',{workspace_id:'ws',model:{provider:'harness',model:'automatic'}});
  f.create=(kind='conversation_message',extra={})=>f.service.create('alice',{title:'Respond to evidence',agent_id:f.agent.agent_id,objective:'Review the new source',trigger:{kind,conversation_id:f.source.conversation_id},...extra});
  f.message=(id=f.source.conversation_id,owner='alice')=>f.runs.enqueue(id,owner,{client_message_id:crypto.randomUUID(),content:[{type:'text',text:'New synthetic evidence'}]});
  f.finish=(run,status='succeeded')=>withImmediateTransaction(f.db,()=>{f.runs.appendAssistant(run,'Published synthetic answer');f.runs.finalizePublication(run,status,null);});
  f.items=t=>f.service.occurrences('alice',t.task_id).items;
  f.reopen=()=>{f.db.close();f.open();};
  f.close=()=>{f.db.close();rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});};
  return f;
}

test('new user message triggers once from persisted events after database restart',async()=>{
  const f=fixture();try{const t=f.create();assert.equal(t.next_due_at,null);const message=f.message();f.reopen();
    assert.equal((await f.service.tick()).dispatched,1);const [o]=f.items(t);assert.notEqual(o.conversation_id,f.source.conversation_id);
    assert.match(o.trigger_key,/^dialogue:/);assert.ok(o.evidence.some(e=>e.reference.includes(f.source.conversation_id)));
    const content=f.db.prepare('SELECT content_json FROM ga_messages WHERE run_id=? AND role=\'user\'').get(o.run_id).content_json;
    assert.match(content,/New synthetic evidence/);assert.ok(o.evidence.some(e=>e.reference.includes(message.run_id)));
    f.reopen();await f.service.tick();assert.equal(f.items(t).length,1);assert.equal(f.service.get('alice',t.task_id).runs_used,1);
  }finally{f.close();}
});
test('preexisting conversation messages are not replayed by a newly saved trigger',async()=>{
  const f=fixture();try{f.message();const t=f.create();await f.service.tick();assert.equal(f.items(t).length,0);f.message();await f.service.tick();assert.equal(f.items(t).length,1);}finally{f.close();}
});
test('authorizes same owner unrelated conversation and denies another owner on create and edit',async()=>{
  const f=fixture();try{assert.notEqual(f.source.conversation_id,f.agent.conversation_id);const t=f.create();
    const other=f.conversations.create('bob',{workspace_id:'ws',model:{provider:'harness',model:'automatic'}});
    assert.throws(()=>f.create('conversation_message',{trigger:{kind:'conversation_message',conversation_id:other.conversation_id}}),/conversation_not_found/);
    assert.throws(()=>f.service.update('alice',t.task_id,{expected_version:1,trigger:{kind:'conversation_result',conversation_id:other.conversation_id}}),/conversation_not_found/);
    f.message();await f.service.tick();assert.equal(f.items(t).length,1);
  }finally{f.close();}
});
test('ownership change before consumption revokes source access and creates no occurrence',async()=>{
  const f=fixture();try{const t=f.create();f.message();f.db.prepare('UPDATE ga_conversations SET owner_id=\'bob\' WHERE id=?').run(f.source.conversation_id);
    await f.service.tick();assert.equal(f.items(t).length,0);assert.equal(f.service.get('alice',t.task_id).last_error,'conversation_not_found');
  }finally{f.close();}
});
test('result trigger waits for product finalization and ignores candidate/runtime/assistant intermediate events',async()=>{
  const f=fixture();try{const t=f.create('conversation_result');const {run_id}=f.message();
    withImmediateTransaction(f.db,()=>{f.runs.saveCandidate(run_id,'Candidate only');f.runs.applyRuntimeOutcome(run_id,{status:'succeeded',runtime_revision:1,reason_code:null});f.runs.appendAssistant(run_id,'Published synthetic answer');});
    await f.service.tick();assert.equal(f.items(t).length,0);withImmediateTransaction(f.db,()=>f.runs.finalizePublication(run_id,'partial',null));
    await f.service.tick();assert.equal(f.items(t).length,1);assert.ok(f.items(t)[0].evidence.some(e=>e.reference.includes(run_id)));
    withImmediateTransaction(f.db,()=>f.events.append(f.source.conversation_id,run_id,'run.state',f.runs.get(run_id,'alice')));
    f.finish(f.items(t)[0].run_id);await f.service.tick();assert.equal(f.items(t).length,1);
  }finally{f.close();}
});
test('busy definitions coalesce queued events across restart without spending extra budget',async()=>{
  const f=fixture();try{const t=f.create('conversation_message',{budget:{max_runs:2}});f.message();await f.service.tick();
    const first=f.items(t)[0];f.message();f.message();await f.service.tick();assert.equal(f.items(t).length,1);
    f.reopen();f.message();await f.service.tick();assert.equal(f.service.get('alice',t.task_id).runs_used,1);
    f.finish(first.run_id);await f.service.tick();assert.equal(f.items(t).length,2);assert.equal(f.service.get('alice',t.task_id).status,'budget_exhausted');
    const next=f.items(t).find(o=>o.run_id!==first.run_id);assert.equal(next.evidence.length,3);
    f.finish(next.run_id);f.message();await f.service.tick();assert.equal(f.items(t).length,2);
  }finally{f.close();}
});
test('pause resume and edit discard pending old-generation signals',async()=>{
  const f=fixture();try{let t=f.create();f.message();await f.service.tick();const first=f.items(t)[0];f.message();await f.service.tick();
    t=f.service.pause('alice',t.task_id,t.version);assert.throws(()=>f.service.assertRunActive(first.run_id),/task_generation_revoked/);
    f.message();t=f.service.resume('alice',t.task_id,t.version);await f.service.tick();assert.equal(f.items(t).length,1);
    f.message();t=f.service.update('alice',t.task_id,{expected_version:t.version,objective:'Changed authorized review'});
    await f.service.tick();assert.equal(f.items(t).length,1);f.message();await f.service.tick();assert.equal(f.items(t).length,2);
  }finally{f.close();}
});
test('own task result and synthetic task input cannot trigger the same task after source edit',async()=>{
  const f=fixture();try{let t=f.create('conversation_result');const occurrence=f.service.runNow('alice',t.task_id,'own');
    t=f.service.update('alice',t.task_id,{expected_version:t.version,trigger:{kind:'conversation_result',conversation_id:occurrence.conversation_id}});
    f.finish(occurrence.run_id);await f.service.tick();assert.equal(f.items(t).length,1);
  }finally{f.close();}
});
test('task A to B to A result causation is durably blocked',async()=>{
  const f=fixture();try{let a=f.create('conversation_result');const root=f.message();f.finish(root.run_id);await f.service.tick();const first=f.items(a)[0];
    const b=f.create('conversation_result',{trigger:{kind:'conversation_result',conversation_id:first.conversation_id}});f.finish(first.run_id);await f.service.tick();const second=f.items(b)[0];
    assert.ok(second);a=f.service.update('alice',a.task_id,{expected_version:a.version,trigger:{kind:'conversation_result',conversation_id:second.conversation_id}});
    f.finish(second.run_id);f.reopen();await f.service.tick();assert.equal(f.items(a).length,1);
  }finally{f.close();}
});
test('outcome unknown remains busy and durable pending signal waits for reconciliation',async()=>{
  const f=fixture();try{const t=f.create();f.message();await f.service.tick();const first=f.items(t)[0];
    f.db.prepare('UPDATE ga_runs SET status=\'failed\',reason_code=\'OUTCOME_UNKNOWN\' WHERE id=?').run(first.run_id);f.message();await f.service.tick();assert.equal(f.items(t).length,1);
    f.db.prepare('UPDATE ga_runs SET status=\'failed\',reason_code=NULL WHERE id=?').run(first.run_id);await f.service.tick();assert.equal(f.items(t).length,2);
  }finally{f.close();}
});
test('failed run binding keeps source event pending and retries without losing or duplicating it',async()=>{
  const f=fixture();try{const t=f.create();f.message();const bind=f.workbench.bindRun;f.workbench.bindRun=()=>{throw new Error('binding_failed');};
    await f.service.tick();assert.equal(f.items(t).length,0);assert.equal(f.service.get('alice',t.task_id).runs_used,0);
    f.workbench.bindRun=bind;f.now=new Date('2026-10-02T00:01:00Z');await f.service.tick();assert.equal(f.items(t).length,1);
  }finally{f.close();}
});
test('task-generated user messages are not treated as Jot user messages by another definition',async()=>{
  const f=fixture();try{const a=f.create();const own=f.service.runNow('alice',a.task_id,'synthetic');
    const b=f.create('conversation_message',{trigger:{kind:'conversation_message',conversation_id:own.conversation_id}});
    // A consumer that restores an earlier cursor still must classify authoritative task origin.
    f.db.prepare('UPDATE wb_task_event_cursors SET last_seq=0 WHERE task_id=?').run(b.task_id);
    await f.service.tick();assert.equal(f.items(b).length,0);
    f.message(own.conversation_id);await f.service.tick();assert.equal(f.items(b).length,1);
  }finally{f.close();}
});
test('a result chain stops after four different tasks even when no task repeats',async()=>{
  const f=fixture();try{let previous=f.source.conversation_id;let previousRun=f.message().run_id;
    for(let i=0;i<5;i++){
      const t=f.create('conversation_result',{trigger:{kind:'conversation_result',conversation_id:previous}});
      f.finish(previousRun);await f.service.tick();const occurrences=f.items(t);
      if(i===4){assert.equal(occurrences.length,0);assert.equal(f.service.get('alice',t.task_id).runs_used,0);}
      else{assert.equal(occurrences.length,1);previous=occurrences[0].conversation_id;previousRun=occurrences[0].run_id;}
    }
  }finally{f.close();}
});
test('causation survives a task run continuation and blocks a return to its origin',async()=>{
  const f=fixture();try{let t=f.create('conversation_result');const first=f.service.runNow('alice',t.task_id,'continuation');
    t=f.service.update('alice',t.task_id,{expected_version:1,trigger:{kind:'conversation_result',conversation_id:first.conversation_id}});
    const next=f.message(first.conversation_id);f.db.prepare('UPDATE ga_runs SET continuation_of=? WHERE id=?').run(first.run_id,next.run_id);
    f.finish(next.run_id);await f.service.tick();assert.equal(f.items(t).length,1);
  }finally{f.close();}
});
test('event receipt prevents replay even after cursor restore and consumed run finishes',async()=>{
  const f=fixture();try{const t=f.create();f.message();await f.service.tick();f.finish(f.items(t)[0].run_id);
    f.db.prepare('UPDATE wb_task_event_cursors SET last_seq=0 WHERE task_id=?').run(t.task_id);f.reopen();await f.service.tick();assert.equal(f.items(t).length,1);
  }finally{f.close();}
});
test('retained cursor gaps fail closed instead of silently dropping source events',async()=>{
  const f=fixture();try{const t=f.create();f.message();f.message();
    f.db.prepare('DELETE FROM ga_events WHERE conversation_id=? AND seq<=2').run(f.source.conversation_id);
    await f.service.tick();assert.equal(f.items(t).length,0);assert.equal(f.service.get('alice',t.task_id).last_error,'event_cursor_expired');
    assert.equal(f.service.get('alice',t.task_id).runs_used,0);
  }finally{f.close();}
});
test('coalesced evidence and source prompt stay bounded under a burst of source messages',async()=>{
  const f=fixture();try{const t=f.create();for(let i=0;i<120;i++)f.message();await f.service.tick();
    const [occurrence]=f.items(t);assert.equal(f.items(t).length,1);assert.equal(occurrence.evidence.length,100);
    assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_event_receipts WHERE task_id=? AND outcome=\'admitted\'').get(t.task_id).n,120);
    const content=f.db.prepare('SELECT content_json FROM ga_messages WHERE run_id=? AND role=\'user\'').get(occurrence.run_id).content_json;
    assert.ok(content.length<60000);await f.service.tick();assert.equal(f.items(t).length,1);
  }finally{f.close();}
});
test('dialogue and calendar definitions share the same bounded priority admission batch',async()=>{
  const f=fixture({maxTasksPerTick:1});try{const event=f.create('conversation_message',{priority:0});
    const timed=f.create('conversation_message',{priority:100,trigger:{kind:'once'}});f.message();
    assert.equal((await f.service.tick()).dispatched,1);assert.equal(f.items(timed).length,1);assert.equal(f.items(event).length,0);
    await f.service.tick();assert.equal(f.items(event).length,1);
  }finally{f.close();}
});
