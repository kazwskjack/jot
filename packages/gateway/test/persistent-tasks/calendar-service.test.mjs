import assert from 'node:assert/strict';
import test from 'node:test';
import { openProductDatabase } from '../../src/db/database.ts';
import { ConversationRepository } from '../../src/conversations/repository.ts';
import { PersistentTaskService } from '../../src/persistent-tasks/service.ts';

function fixture(at='2026-10-01T00:00:00Z') {
  const db=openProductDatabase(':memory:');
  const conversations=new ConversationRepository(db);
  const conversation=conversations.create('alice',{workspace_id:'ws',model:{provider:'harness',model:'automatic'}});
  const agent={agent_id:'calendar-agent',status:'active',workspace_id:'ws',project_id:conversation.project_id,conversation_id:conversation.conversation_id};
  const workbench={getAgent(owner,id){if(owner!=='alice'||id!==agent.agent_id)throw new Error('agent_not_found');return agent;},bindRun(){}};
  let now=new Date(at);
  const options={now:()=>now};
  const service=new PersistentTaskService(db,workbench,options);
  return {db,service,setTime(at){now=new Date(at);},restart(){return new PersistentTaskService(db,workbench,options);},close(){db.close();}};
}
const input={title:'Calendar check',objective:'Check synthetic data',agent_id:'calendar-agent',trigger:{kind:'daily',time:'08:00',timezone:'Asia/Hong_Kong'}};

test('preview validates and shares creation due time without persisting or charging budget',()=>{
  const f=fixture();try{
    assert.equal(typeof f.service.previewTrigger,'function');
    assert.deepEqual(f.service.previewTrigger(input.trigger),{next_due_at:'2026-10-01T00:00:00.000Z',timezone:'Asia/Hong_Kong'});
    assert.equal(f.service.list('alice').items.length,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
    assert.equal(f.service.create('alice',input).next_due_at,'2026-10-01T00:00:00.000Z');
    assert.deepEqual(f.service.previewTrigger({kind:'interval',interval_seconds:60}),{next_due_at:'2026-10-01T00:00:00.000Z',timezone:null});
    assert.throws(()=>f.service.previewTrigger({...input.trigger,time:'25:00'}),/invalid_calendar_time/);
  }finally{f.close();}
});

test('offline calendar ticks coalesce one frozen UTC occurrence and advance strictly beyond recovery time',async()=>{
  const f=fixture();try{
    const task=f.service.create('alice',input);
    f.setTime('2026-10-05T12:00:00Z');
    const restored=f.restart();await restored.tick();await restored.tick();
    const items=restored.occurrences('alice',task.task_id).items;
    assert.equal(items.length,1);
    assert.equal(items[0].scheduled_for,'2026-10-01T00:00:00.000Z');
    assert.equal(items[0].trigger_key,'schedule:1:2026-10-01T00:00:00.000Z');
    assert.equal(restored.get('alice',task.task_id).next_due_at,'2026-10-06T00:00:00.000Z');
    f.db.prepare("UPDATE ga_runs SET status='succeeded'").run();await restored.tick();
    assert.equal(restored.occurrences('alice',task.task_id).items.length,1);
    f.setTime('2026-10-06T00:00:00Z');await restored.tick();
    assert.equal(restored.occurrences('alice',task.task_id).items.length,2);
  }finally{f.close();}
});

test('calendar DST fold does not dispatch the second repeated wall time after restart',async()=>{
  const f=fixture('2026-11-01T05:30:00Z');try{
    const task=f.service.create('alice',{...input,trigger:{kind:'daily',time:'01:30',timezone:'America/New_York'}});
    await f.service.tick();f.db.prepare("UPDATE ga_runs SET status='succeeded'").run();
    f.setTime('2026-11-01T06:30:00Z');await f.restart().tick();
    assert.equal(f.service.occurrences('alice',task.task_id).items.length,1);
    assert.equal(f.service.get('alice',task.task_id).next_due_at,'2026-11-02T06:30:00.000Z');
  }finally{f.close();}
});

test('schedule update uses CAS, cancels old run and replaces the due time and schedule revision',async()=>{
  const f=fixture();try{
    let task=f.service.create('alice',input);await f.service.tick();
    const occurrence=f.service.occurrences('alice',task.task_id).items[0];
    task=f.service.update('alice',task.task_id,{expected_version:1,trigger:{kind:'weekly',time:'09:00',timezone:'UTC',weekdays:[1]}});
    assert.equal(task.schedule_revision,2);assert.equal(task.next_due_at,'2026-10-05T09:00:00.000Z');
    assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(occurrence.run_id).status,'cancelled');
    assert.throws(()=>f.service.assertRunActive(occurrence.run_id),/task_generation_revoked/);
    assert.throws(()=>f.service.update('alice',task.task_id,{expected_version:1,title:'stale'}),/version_conflict/);
    f.setTime('2026-10-05T09:00:00Z');await f.service.tick();
    const fresh=f.service.occurrences('alice',task.task_id).items.find(item=>item.run_id!==occurrence.run_id);
    assert.equal(fresh.trigger_key,'schedule:2:2026-10-05T09:00:00.000Z');
    const cancelled=f.service.cancelOccurrence('alice',task.task_id,fresh.occurrence_id,1,'calendar-cancel');
    assert.equal(cancelled.status,'cancelled');assert.equal(f.service.get('alice',task.task_id).status,'active');
    assert.equal(f.service.get('alice',task.task_id).next_due_at,'2026-10-12T09:00:00.000Z');
  }finally{f.close();}
});

test('calendar admission failure retains the frozen UTC key through backoff',async()=>{
  const f=fixture();try{
    const task=f.service.create('alice',input);
    f.db.exec("CREATE TRIGGER fail_calendar_binding BEFORE INSERT ON wb_task_occurrences BEGIN SELECT RAISE(ABORT,'fixture_admission_failed'); END;");
    await f.service.tick();assert.equal(f.service.get('alice',task.task_id).next_due_at,'2026-10-01T00:00:00.000Z');
    assert.equal(f.service.get('alice',task.task_id).runs_used,0);
    f.db.exec('DROP TRIGGER fail_calendar_binding');f.setTime('2026-10-03T00:00:00Z');await f.service.tick();
    assert.equal(f.service.occurrences('alice',task.task_id).items[0].trigger_key,'schedule:1:2026-10-01T00:00:00.000Z');
    assert.equal(f.service.get('alice',task.task_id).next_due_at,'2026-10-04T00:00:00.000Z');
  }finally{f.close();}
});
