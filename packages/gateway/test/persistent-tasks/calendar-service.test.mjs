import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductDatabase } from '../../src/db/database.ts';
import { ConversationRepository } from '../../src/conversations/repository.ts';
import { PersistentTaskService } from '../../src/persistent-tasks/service.ts';

function fixture(at='2026-10-01T00:00:00Z',databasePath=':memory:',serviceOptions={}) {
  const db=openProductDatabase(databasePath);
  const conversations=new ConversationRepository(db);
  const conversation=conversations.create('alice',{workspace_id:'ws',model:{provider:'harness',model:'automatic'}});
  const agent={agent_id:'calendar-agent',status:'active',workspace_id:'ws',project_id:conversation.project_id,conversation_id:conversation.conversation_id};
  const workbench={getAgent(owner,id){if(owner!=='alice'||id!==agent.agent_id)throw new Error('agent_not_found');return agent;},bindRun(){}};
  let now=new Date(at);
  const options={now:()=>now,...serviceOptions};
  const service=new PersistentTaskService(db,workbench,options);
  return {db,service,agent,workbench,databasePath,setTime(at){now=new Date(at);},restart(){return new PersistentTaskService(db,workbench,options);},
    connect(){const connection=openProductDatabase(databasePath);return {db:connection,service:new PersistentTaskService(connection,workbench,options),close(){connection.close();}};},close(){db.close();}};
}
const input={title:'Calendar check',objective:'Check synthetic data',agent_id:'calendar-agent',trigger:{kind:'daily',time:'08:00',timezone:'Asia/Hong_Kong'}};

test('explicit misfire strategies persist distinct bounded recovery decisions across connections',async()=>{
 for(const policy of ['coalesce','skip','catch_up']){
  const root=mkdtempSync(join(resolve('.test-tmp'),'misfire-')),f=fixture('2026-01-05T09:00:00Z',join(root,'db.sqlite'));
  let peer;
  try{
   const task=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC',missed_triggers:policy}});
   f.setTime('2026-01-05T09:05:00Z');peer=f.connect();await peer.service.tick();await f.service.tick();
   assert.equal(peer.service.get('alice',task.task_id).trigger.missed_triggers,policy);
   const items=peer.service.occurrences('alice',task.task_id).items;
   assert.equal(items.length,policy==='skip'?0:1);
   assert.equal(peer.service.get('alice',task.task_id).next_due_at,policy==='catch_up'?'2026-01-05T09:01:00.000Z':'2026-01-05T09:06:00.000Z');
   if(policy==='catch_up'){
    assert.equal(items[0].scheduled_for,'2026-01-05T09:00:00.000Z');
    f.db.prepare("UPDATE ga_runs SET status='outcome_unknown',reason_code='OUTCOME_UNKNOWN' WHERE id=?").run(items[0].run_id);
    await peer.service.tick();assert.equal(peer.service.occurrences('alice',task.task_id).items.length,1);
   }
  }finally{peer?.close();f.close();rmSync(root,{recursive:true,force:true});}
 }
});

test('calendar misfire recovery keeps DST gap and fold identity across physical reconnect',async()=>{
 for(const scenario of [{at:'2026-03-08T06:59:00Z',time:'02:30',due:'2026-03-08T07:00:00.000Z',later:'2026-03-08T07:05:00Z',next:'2026-03-09T06:30:00.000Z'},
  {at:'2026-11-01T05:29:00Z',time:'01:30',due:'2026-11-01T05:30:00.000Z',later:'2026-11-01T06:30:00Z',next:'2026-11-02T06:30:00.000Z'}]){
  const root=mkdtempSync(join(resolve('.test-tmp'),'misfire-dst-')),f=fixture(scenario.at,join(root,'db.sqlite'));let peer;
  try{
   const task=f.service.create('alice',{...input,trigger:{kind:'daily',time:scenario.time,timezone:'America/New_York',missed_triggers:'catch_up'}});
   assert.equal(task.next_due_at,scenario.due);f.setTime(scenario.later);peer=f.connect();await peer.service.tick();
   const occurrence=peer.service.occurrences('alice',task.task_id).items[0];assert.equal(occurrence.scheduled_for,scenario.due);
   f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(occurrence.run_id);peer.close();peer=f.connect();await peer.service.tick();
   assert.equal(peer.service.occurrences('alice',task.task_id).items.length,1);assert.equal(peer.service.get('alice',task.task_id).next_due_at,scenario.next);
  }finally{peer?.close();f.close();rmSync(root,{recursive:true,force:true});}
 }
});

test('old runtime connections cannot consume explicit misfire tasks as coalesced work',()=>{
 const root=mkdtempSync(join(resolve('.test-tmp'),'misfire-old-')),f=fixture('2026-01-05T09:00:00Z',join(root,'db.sqlite'));let old;
 try{
  const task=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC',missed_triggers:'catch_up'}});
  old=openProductDatabase(f.databasePath);old.function('jot_persistent_trigger_protocol_v1',{deterministic:true},()=>1);
  assert.throws(()=>old.prepare('UPDATE wb_persistent_tasks SET next_due_at=? WHERE task_id=?').run('2026-01-05T10:00:00Z',task.task_id),/task_trigger_protocol_unsupported/);
  assert.equal(f.service.get('alice',task.task_id).next_due_at,task.next_due_at);
  assert.equal(f.service.get('alice',task.task_id).runs_used,0);
  assert.throws(()=>f.service.create('alice',{...input,trigger:{...input.trigger,missed_triggers:'unbounded'}}),/invalid_missed_triggers/);
 }finally{old?.close();f.close();rmSync(root,{recursive:true,force:true});}
});

test('catch-up preserves capacity-deferred dues and paused work across reopen',async()=>{
 const root=mkdtempSync(join(resolve('.test-tmp'),'misfire-capacity-')),f=fixture('2026-01-05T09:00:00Z',join(root,'db.sqlite'),{maxTasksPerTick:1});let peer;
 try{
  const request={...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC',missed_triggers:'catch_up'}};
  const first=f.service.create('alice',{...request,priority:100}),second=f.service.create('alice',{...request,priority:10});
  f.setTime('2026-01-05T09:05:00Z');await f.service.tick();
  assert.equal(f.service.get('alice',second.task_id).next_due_at,second.next_due_at);assert.equal(f.service.get('alice',second.task_id).runs_used,0);
  const paused=f.service.pause('alice',first.task_id,first.version);peer=f.connect();await peer.service.tick();await peer.service.tick();
  assert.equal(peer.service.get('alice',first.task_id).status,'paused');assert.equal(peer.service.get('alice',first.task_id).version,paused.version);
  assert.equal(peer.service.occurrences('alice',first.task_id).items.length,1);assert.equal(peer.service.occurrences('alice',second.task_id).items.length,1);
 }finally{peer?.close();f.close();rmSync(root,{recursive:true,force:true});}
});

test('two connections fence stale asynchronous dispatch after edit pause or archive',async()=>{
 for(const action of ['edit','pause','archive']){
  const root=mkdtempSync(join(resolve('.test-tmp'),'schedule-control-')),databasePath=join(root,'db.sqlite');
  let release,entered;const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const f=fixture('2026-10-01T00:00:00Z',databasePath,{pageReader:async()=>{entered();await gate;return {text:'changed',url:'https://example.com/'};}}),peer=f.connect();
  try{
   const task=f.service.create('alice',{...input,trigger:{kind:'page_change',url:'https://example.com/'}});
   f.db.prepare("UPDATE wb_persistent_tasks SET baseline_hash='old' WHERE task_id=?").run(task.task_id);
   const ticking=f.service.tick();await ready;
   const changed=action==='edit'?peer.service.update('alice',task.task_id,{expected_version:task.version,title:'Edited elsewhere'}):peer.service[action]('alice',task.task_id,task.version);
   assert.throws(()=>f.service.update('alice',task.task_id,{expected_version:task.version,title:'stale'}),/version_conflict/);
   release();await ticking;
   assert.equal(f.service.occurrences('alice',task.task_id).items.length,0,action);
   assert.equal(f.service.get('alice',task.task_id).version,changed.version);
  }finally{release();peer.close();f.close();rmSync(root,{recursive:true,force:true});}
 }
});

test('active pause rollback and committed reopen retain one cancellation and no replay',async()=>{
 const root=mkdtempSync(join(resolve('.test-tmp'),'schedule-restart-')),databasePath=join(root,'db.sqlite'),f=fixture('2026-10-01T00:00:00Z',databasePath);
 let peer=f.connect();
 try{
  const task=f.service.create('alice',input);await f.service.tick();
  const occurrence=f.service.occurrences('alice',task.task_id).items[0];
  f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(occurrence.run_id);
  peer.db.exec('BEGIN IMMEDIATE');peer.service.pause('alice',task.task_id,task.version);peer.db.exec('ROLLBACK');
  assert.equal(f.service.get('alice',task.task_id).status,'active');
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_run_commands WHERE run_id=?').get(occurrence.run_id).n,0);
  const paused=peer.service.pause('alice',task.task_id,task.version);
  assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(occurrence.run_id).status,'cancelling');
  const count=f.db.prepare('SELECT count(*) n FROM ga_run_commands WHERE run_id=?').get(occurrence.run_id).n;assert.equal(count,1);
  peer.close();peer=f.connect();await peer.service.tick();
  peer.service.archive('alice',task.task_id,paused.version);await peer.service.tick();
  assert.equal(peer.service.occurrences('alice',task.task_id).items.length,1);
  assert.equal(peer.db.prepare('SELECT count(*) n FROM ga_run_commands WHERE run_id=?').get(occurrence.run_id).n,count);
  assert.throws(()=>peer.service.assertRunActive(occurrence.run_id),/task_generation_revoked/);
 }finally{peer.close();f.close();rmSync(root,{recursive:true,force:true});}
});

function waitForWorkerMessage(child,type) {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{cleanup();reject(new Error(`worker_timeout:${type}`));},15000);
    const onMessage=message=>{
      if(message?.type==='worker-error'){cleanup();reject(new Error(message.error));}
      else if(message?.type===type){cleanup();resolve(message);}
    };
    const onExit=code=>{cleanup();reject(new Error(`worker_exited:${code}:${type}`));};
    const cleanup=()=>{clearTimeout(timeout);child.off('message',onMessage);child.off('exit',onExit);};
    child.on('message',onMessage);child.once('exit',onExit);
  });
}

function waitForWorkerExit(child) {
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{cleanup();reject(new Error('worker_exit_timeout'));},15000);
    const onExit=(code,signal)=>{cleanup();resolve({code,signal});};
    const onError=error=>{cleanup();reject(error);};
    const onMessage=message=>{if(message?.type==='worker-error'){cleanup();reject(new Error(String(message.error)));}};
    const cleanup=()=>{clearTimeout(timeout);child.off('exit',onExit);child.off('error',onError);child.off('message',onMessage);};
    child.once('exit',onExit);child.once('error',onError);child.on('message',onMessage);
  });
}

function startTickWorker(databasePath,now,agent,control={}) {
  return fork(fileURLToPath(new URL('./cron-tick-worker.mjs',import.meta.url)),[databasePath,now,JSON.stringify(agent),JSON.stringify(control)],
    {execArgv:process.execArgv.filter(value=>!value.startsWith('--test')),stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
}

test('misfire decisions survive process exit on both sides of commit without replay',async()=>{
 for(const policy of ['coalesce','skip','catch_up'])for(const mode of ['before_commit','after_commit']){
  const root=mkdtempSync(join(resolve('.test-tmp'),'misfire-crash-')),f=fixture('2026-01-05T09:00:00Z',join(root,'db.sqlite'));let worker,peer;
  try{
   const task=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC',missed_triggers:policy}});
   const next=policy==='catch_up'?'2026-01-05T09:01:00.000Z':'2026-01-05T09:06:00.000Z';
   f.setTime('2026-01-05T09:05:00Z');worker=startTickWorker(f.databasePath,'2026-01-05T09:05:00Z',f.agent,{mode,taskId:task.task_id,expectedNextDue:next});
   await waitForWorkerMessage(worker,'ready');const exited=waitForWorkerExit(worker);worker.send({type:'tick'});assert.equal((await exited).code,mode==='before_commit'?71:72);
   peer=f.connect();assert.equal(peer.service.get('alice',task.task_id).next_due_at,mode==='before_commit'?task.next_due_at:next);
   if(mode==='before_commit')assert.equal(peer.service.occurrences('alice',task.task_id).items.length,0);
   await peer.service.tick();await peer.service.tick();
   assert.equal(peer.service.occurrences('alice',task.task_id).items.length,policy==='skip'?0:1);
   assert.equal(peer.service.get('alice',task.task_id).next_due_at,next);
   assert.equal(peer.service.get('alice',task.task_id).runs_used,policy==='skip'?0:1);
  }finally{if(worker?.connected)worker.kill();peer?.close();f.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
 }
});

test('active pause and stop recover across process commit boundaries without duplicate cancel effects',async()=>{
 for(const action of ['pause','archive'])for(const mode of ['before_commit','after_commit']){
  const root=mkdtempSync(join(resolve('.test-tmp'),'control-crash-')),f=fixture('2026-01-05T09:00:00Z',join(root,'db.sqlite'));let worker,peer;
  try{
   const task=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC'}});await f.service.tick();const occurrence=f.service.occurrences('alice',task.task_id).items[0];
   f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(occurrence.run_id);
   const status=action==='pause'?'paused':'archived';worker=startTickWorker(f.databasePath,'2026-01-05T09:00:00Z',f.agent,{mode,action,taskId:task.task_id,version:task.version,expectedStatus:status});
   await waitForWorkerMessage(worker,'ready');const exited=waitForWorkerExit(worker);worker.send({type:'tick'});assert.equal((await exited).code,mode==='before_commit'?71:72);
   peer=f.connect();assert.equal(peer.service.get('alice',task.task_id).status,mode==='before_commit'?'active':status);
   if(mode==='before_commit')peer.service[action]('alice',task.task_id,task.version);
   await peer.service.tick();await peer.service.tick();
   assert.equal(peer.service.get('alice',task.task_id).status,status);
   assert.equal(peer.db.prepare('SELECT count(*) n FROM ga_run_commands WHERE run_id=?').get(occurrence.run_id).n,1);
   assert.equal(peer.service.occurrences('alice',task.task_id).items.length,1);
  }finally{if(worker?.connected)worker.kill();peer?.close();f.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});}
 }
});

test('preview validates and shares creation due time without persisting or charging budget',()=>{
  const f=fixture();try{
    assert.equal(typeof f.service.previewTrigger,'function');
    assert.deepEqual(f.service.previewTrigger(input.trigger),{next_due_at:'2026-10-01T00:00:00.000Z',timezone:'Asia/Hong_Kong'});
    assert.equal(f.service.list('alice').items.length,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
    assert.deepEqual(f.service.previewTrigger({kind:'cron',expression:'0 9 * * MON',timezone:'UTC'}),{next_due_at:'2026-10-05T09:00:00.000Z',timezone:'UTC'});
    assert.throws(()=>f.service.previewTrigger({kind:'cron',expression:'0 9 * *',timezone:'UTC'}),/invalid_cron_expression/);
    assert.throws(()=>f.service.previewTrigger({kind:'delay',delay_seconds:0}),/invalid_delay/);
    assert.throws(()=>f.service.previewTrigger({kind:'delay',delay_seconds:60,unexpected:true}),/invalid_delay/);
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


test('cron scheduling enqueues one original occurrence and coalesces missed due times after restart', async () => {
  const f=fixture('2026-01-05T09:00:00Z');
  try {
    const task=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'0 9 * * *',timezone:'UTC'}});
    assert.equal(task.next_due_at,'2026-01-05T09:00:00.000Z');
    await f.service.tick();
    const first=f.service.occurrences('alice',task.task_id).items;
    assert.equal(first.length,1);
    assert.equal(first[0].scheduled_for,'2026-01-05T09:00:00.000Z');
    assert.equal(first[0].trigger_key,'schedule:1:2026-01-05T09:00:00.000Z');
    assert.equal(f.service.get('alice',task.task_id).next_due_at,'2026-01-06T09:00:00.000Z');

    f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first[0].run_id);
    f.setTime('2026-01-08T10:00:00Z');
    const restarted=f.restart();
    await restarted.tick();
    const recovered=restarted.occurrences('alice',task.task_id).items;
    assert.equal(recovered.length,2);
    const coalesced=recovered.find(item=>item.trigger_key==='schedule:1:2026-01-06T09:00:00.000Z');
    assert.equal(coalesced.scheduled_for,'2026-01-06T09:00:00.000Z');
    assert.equal(restarted.get('alice',task.task_id).next_due_at,'2026-01-09T09:00:00.000Z');
  } finally { f.close(); }
});

test('per-tick capacity leaves later Cron dues persisted until a slot is available', async () => {
  const f=fixture('2026-01-05T09:00:00Z',':memory:',{maxTasksPerTick:1});
  try {
    const first=f.service.create('alice',{...input,title:'First due',trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC'}});
    const second=f.service.create('alice',{...input,title:'Second due',trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC'}});
    const firstTick=await f.service.tick();
    assert.equal(firstTick.dispatched,1);
    const pending=[first,second].filter(task=>f.service.occurrences('alice',task.task_id).items.length===0);
    assert.equal(pending.length,1);
    const untouched=f.service.get('alice',pending[0].task_id);
    assert.equal(untouched.next_due_at,'2026-01-05T09:00:00.000Z');

    const secondTick=await f.service.tick();
    assert.equal(secondTick.dispatched,1);
    for(const task of [first,second]) {
      const occurrences=f.service.occurrences('alice',task.task_id).items;
      assert.equal(occurrences.length,1);
      assert.equal(occurrences[0].scheduled_for,'2026-01-05T09:00:00.000Z');
      assert.equal(f.service.get('alice',task.task_id).next_due_at,'2026-01-05T09:01:00.000Z');
    }
  } finally { f.close(); }
});

test('relative delay resolves once, survives edits/restart and fires only one original occurrence', async () => {
  const f=fixture('2026-01-05T09:00:00Z');
  try {
    const request={...input,trigger:{kind:'delay',delay_seconds:120}};
    let task=f.service.create('alice',request,'delay-create-original');
    assert.equal(task.next_due_at,'2026-01-05T09:02:00.000Z');

    f.setTime('2026-01-05T09:01:00Z');
    task=f.service.update('alice',task.task_id,{expected_version:task.version,title:'Delay edited'});
    assert.equal(task.next_due_at,'2026-01-05T09:02:00.000Z');
    const replay=f.service.create('alice',request,'delay-create-original');
    assert.equal(replay.task_id,task.task_id);
    assert.equal(replay.next_due_at,'2026-01-05T09:02:00.000Z');

    task=f.service.pause('alice',task.task_id,task.version);
    assert.equal(task.next_due_at,'2026-01-05T09:02:00.000Z');
    task=f.service.resume('alice',task.task_id,task.version);
    assert.equal(task.next_due_at,'2026-01-05T09:02:00.000Z');

    f.setTime('2026-01-05T09:01:30Z');
    task=f.service.update('alice',task.task_id,{expected_version:task.version,trigger:{kind:'delay',delay_seconds:60}});
    assert.equal(task.schedule_revision,2);
    assert.equal(task.next_due_at,'2026-01-05T09:02:30.000Z');

    f.setTime('2026-01-05T09:02:30Z');
    const restarted=f.restart();
    await restarted.tick();
    const first=restarted.occurrences('alice',task.task_id).items;
    assert.equal(first.length,1);
    assert.equal(first[0].scheduled_for,'2026-01-05T09:02:30.000Z');
    assert.equal(restarted.get('alice',task.task_id).next_due_at,null);
    f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(first[0].run_id);
    f.setTime('2026-01-05T09:04:00Z');
    await restarted.tick();
    assert.equal(restarted.occurrences('alice',task.task_id).items.length,1);
  } finally { f.close(); }
});

test('independent SQLite connections compete for the same Cron due without duplicate occurrences', async () => {
  const testTmp=resolve(process.cwd(),'.test-tmp');mkdirSync(testTmp,{recursive:true});
  const directory=mkdtempSync(join(testTmp,`cron-race-${randomUUID()}-`));
  const databasePath=join(directory,'fixture.sqlite');
  const f=fixture('2026-01-05T09:00:00Z',databasePath);
  const workers=[];
  let editor;
  try {
    const task=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC'}});
    const agentRecord=f.agent;
    workers.push(startTickWorker(databasePath,'2026-01-05T09:00:00Z',agentRecord),startTickWorker(databasePath,'2026-01-05T09:00:00Z',agentRecord));
    await Promise.all(workers.map(worker=>waitForWorkerMessage(worker,'ready')));
    const race=async()=>{
      const results=workers.map(worker=>waitForWorkerMessage(worker,'tick-done'));
      for(const worker of workers)worker.send({type:'tick'});
      return Promise.all(results);
    };
    const first=await race();
    assert.equal(first.reduce((sum,result)=>sum+result.dispatched,0),1);
    let occurrences=f.service.occurrences('alice',task.task_id).items;
    assert.equal(occurrences.length,1);
    assert.equal(occurrences[0].scheduled_for,'2026-01-05T09:00:00.000Z');
    assert.equal(f.service.get('alice',task.task_id).next_due_at,'2026-01-05T09:01:00.000Z');

    f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(occurrences[0].run_id);
    f.setTime('2026-01-05T09:01:00Z');
    const timeUpdates=workers.map(worker=>waitForWorkerMessage(worker,'time-set'));
    for(const worker of workers)worker.send({type:'set-time',now:'2026-01-05T09:01:00Z'});
    await Promise.all(timeUpdates);
    const second=await race();
    assert.equal(second.reduce((sum,result)=>sum+result.dispatched,0),1);
    occurrences=f.service.occurrences('alice',task.task_id).items;
    assert.equal(occurrences.length,2);
    assert.equal(occurrences.filter(item=>item.trigger_key==='schedule:1:2026-01-05T09:01:00.000Z').length,1);
    assert.equal(f.service.get('alice',task.task_id).next_due_at,'2026-01-05T09:02:00.000Z');

    editor=f.connect();
    const version=f.service.get('alice',task.task_id).version;
    const edited=editor.service.update('alice',task.task_id,{expected_version:version,title:'Edited on second connection'});
    assert.equal(edited.version,version+1);
    assert.equal(edited.next_due_at,'2026-01-05T09:02:00.000Z');
    assert.throws(()=>f.service.update('alice',task.task_id,{expected_version:version,title:'Stale edit'}),/version_conflict/);
  } finally {
    if(editor)editor.close();
    const closing=workers.map(worker=>worker.connected?waitForWorkerMessage(worker,'closed'):Promise.resolve());
    for(const worker of workers)if(worker.connected)worker.send({type:'close'});
    await Promise.allSettled(closing);
    await Promise.all(workers.map(worker=>worker.exitCode!==null?Promise.resolve():new Promise(resolve=>worker.once('exit',resolve))));
    f.close();
    rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});
  }
});

test('process exit immediately before or after the Cron transaction commit recovers atomically', async () => {
  const testTmp=resolve(process.cwd(),'.test-tmp');mkdirSync(testTmp,{recursive:true});
  for (const scenario of [
    {mode:'before_commit',exitCode:71,committed:false},
    {mode:'after_commit',exitCode:72,committed:true}
  ]) {
    const initialTime='2026-01-05T09:00:00Z';
    const directory=mkdtempSync(join(testTmp,`cron-crash-${randomUUID()}-`));
    const f=fixture(initialTime,join(directory,'shared.sqlite'));
    let recovered;
    let worker;
    try {
      const task=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC'}});
      const triggerKey=`schedule:1:${task.next_due_at}`;
      worker=startTickWorker(f.databasePath,initialTime,f.agent,{mode:scenario.mode,taskId:task.task_id,triggerKey});
      await waitForWorkerMessage(worker,'ready');
      const exitPromise=waitForWorkerExit(worker);
      worker.send({type:'tick'});
      await waitForWorkerMessage(worker,'tick-started');
      const exit=await exitPromise;
      assert.equal(exit.code,scenario.exitCode,scenario.mode);
      assert.equal(exit.signal,null,scenario.mode);

      recovered=f.connect();
      let after=recovered.service.get('alice',task.task_id);
      let occurrences=recovered.service.occurrences('alice',task.task_id).items;
      if(!scenario.committed) {
        assert.equal(occurrences.length,0);
        assert.equal(after.next_due_at,task.next_due_at);
        assert.equal(after.runs_used,0);
        await recovered.service.tick();
        occurrences=recovered.service.occurrences('alice',task.task_id).items;
        assert.equal(occurrences.length,1);
        assert.equal(occurrences[0].trigger_key,triggerKey);
      } else {
        assert.equal(occurrences.length,1);
        assert.equal(occurrences[0].trigger_key,triggerKey);
        assert.equal(after.next_due_at,'2026-01-05T09:01:00.000Z');
        assert.equal(after.runs_used,1);
        await recovered.service.tick();
        assert.equal(recovered.service.occurrences('alice',task.task_id).items.length,1);
        recovered.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(occurrences[0].run_id);
        f.setTime('2026-01-05T09:01:00Z');
        await recovered.service.tick();
        occurrences=recovered.service.occurrences('alice',task.task_id).items;
        assert.equal(occurrences.length,2);
        assert.equal(occurrences.filter(item=>item.trigger_key==='schedule:1:2026-01-05T09:01:00.000Z').length,1);
      }
    } finally {
      if(recovered)recovered.close();
      if(worker?.connected)worker.kill();
      f.close();
      rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});
    }
  }
});

test('Cron pause, resume and occurrence cancellation preserve the remaining schedule', async () => {
  const f=fixture('2026-01-05T09:00:00Z');
  try {
    let task=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC'}});
    task=f.service.pause('alice',task.task_id,task.version);
    assert.equal(task.next_due_at,'2026-01-05T09:00:00.000Z');
    await f.service.tick();
    assert.equal(f.service.occurrences('alice',task.task_id).items.length,0);

    task=f.service.resume('alice',task.task_id,task.version);
    assert.equal(task.next_due_at,'2026-01-05T09:00:00.000Z');
    await f.service.tick();
    let occurrences=f.service.occurrences('alice',task.task_id).items;
    assert.equal(occurrences.length,1);
    assert.equal(f.service.get('alice',task.task_id).next_due_at,'2026-01-05T09:01:00.000Z');

    task=f.service.pause('alice',task.task_id,f.service.get('alice',task.task_id).version);
    assert.equal(f.db.prepare('SELECT status FROM ga_runs WHERE id=?').get(occurrences[0].run_id).status,'cancelled');
    assert.equal(task.next_due_at,'2026-01-05T09:01:00.000Z');
    await f.service.tick();
    task=f.service.resume('alice',task.task_id,task.version);
    assert.equal(task.next_due_at,'2026-01-05T09:01:00.000Z');
    f.setTime('2026-01-05T09:01:00Z');
    await f.service.tick();
    occurrences=f.service.occurrences('alice',task.task_id).items;
    assert.equal(occurrences.length,2);
    const second=occurrences.find(item=>item.scheduled_for==='2026-01-05T09:01:00.000Z');
    const cancelled=f.service.cancelOccurrence('alice',task.task_id,second.occurrence_id,1,'cron-cancel');
    assert.equal(cancelled.status,'cancelled');
    assert.equal(f.service.get('alice',task.task_id).status,'active');
    f.setTime('2026-01-05T09:02:00Z');
    await f.service.tick();
    occurrences=f.service.occurrences('alice',task.task_id).items;
    assert.equal(occurrences.length,3);
    assert.equal(occurrences.filter(item=>item.trigger_key==='schedule:1:2026-01-05T09:02:00.000Z').length,1);
  } finally { f.close(); }
});

test('a SQLite online backup restores Cron and delay definitions, due times and occurrences', async () => {
  const testTmp=resolve(process.cwd(),'.test-tmp');mkdirSync(testTmp,{recursive:true});
  const directory=mkdtempSync(join(testTmp,`cron-backup-${randomUUID()}-`));
  const databasePath=join(directory,'source.sqlite');
  const backupPath=join(directory,'backup.sqlite');
  const f=fixture('2026-01-05T09:00:00Z',databasePath);
  let restored;
  try {
    const cron=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC'}});
    const delay=f.service.create('alice',{...input,title:'Delayed check',trigger:{kind:'delay',delay_seconds:300}});
    await f.service.tick();
    f.db.exec(`VACUUM INTO '${backupPath.replaceAll("'","''")}'`);

    const db=openProductDatabase(backupPath);
    restored={db,service:new PersistentTaskService(db,{getAgent(_owner,id){if(id!==f.agent.agent_id)throw Error('agent_not_found');return f.agent;},bindRun(){ }},{now:()=>new Date('2026-01-05T09:00:00Z')}),close(){db.close();}};
    assert.deepEqual(restored.service.get('alice',cron.task_id).trigger,{kind:'cron',expression:'* * * * *',timezone:'UTC'});
    assert.equal(restored.service.get('alice',cron.task_id).next_due_at,'2026-01-05T09:01:00.000Z');
    assert.equal(restored.service.occurrences('alice',cron.task_id).items.length,1);
    assert.deepEqual(restored.service.get('alice',delay.task_id).trigger,{kind:'delay',delay_seconds:300});
    assert.equal(restored.service.get('alice',delay.task_id).next_due_at,'2026-01-05T09:05:00.000Z');
    await restored.service.tick();
    assert.equal(restored.service.occurrences('alice',cron.task_id).items.length,1);
  } finally { restored?.close();f.close();rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20}); }
});

test('a legacy SQLite connection fails closed on new trigger rows without changing their durable state', () => {
  const testTmp=resolve(process.cwd(),'.test-tmp');mkdirSync(testTmp,{recursive:true});
  const directory=mkdtempSync(join(testTmp,`cron-legacy-guard-${randomUUID()}-`));
  const databasePath=join(directory,'fixture.sqlite');
  const f=fixture('2026-01-05T09:00:00Z',databasePath);
  let legacyDb;
  try {
    const cron=f.service.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC'}});
    const delay=f.service.create('alice',{...input,title:'Delayed check',trigger:{kind:'delay',delay_seconds:300}});
    const calendar=f.service.create('alice',{...input,title:'Calendar check'});
    // openProductDatabase alone models the old runtime connection: the base
    // release does not register the candidate's trigger protocol function.
    legacyDb=openProductDatabase(databasePath);
    legacyDb.exec('CREATE TABLE rollback_probe(value TEXT NOT NULL)');
    for(const task of [cron,delay]) {
      const before=legacyDb.prepare('SELECT next_due_at,runs_used FROM wb_persistent_tasks WHERE task_id=?').get(task.task_id);
      const intervalFallback=new Date(Date.parse(before.next_due_at)+300_000).toISOString();
      legacyDb.exec('BEGIN IMMEDIATE');
      try {
        legacyDb.prepare('INSERT INTO rollback_probe VALUES(?)').run(task.task_id);
        assert.throws(
          ()=>legacyDb.prepare(`UPDATE wb_persistent_tasks SET next_due_at=?,retry_after_at=NULL,last_error=NULL,
            failure_count=0,runs_used=runs_used+1,projection_pending=1,updated_at=? WHERE task_id=?`)
            .run(intervalFallback,'2026-01-05T09:00:01.000Z',task.task_id),
          /task_trigger_protocol_unsupported/
        );
      } finally {
        if(legacyDb.isTransaction)legacyDb.exec('ROLLBACK');
      }
      assert.equal(legacyDb.prepare('SELECT count(*) n FROM rollback_probe WHERE value=?').get(task.task_id).n,0);
      const after=legacyDb.prepare('SELECT next_due_at,runs_used FROM wb_persistent_tasks WHERE task_id=?').get(task.task_id);
      assert.equal(after.next_due_at,before.next_due_at);
      assert.equal(after.runs_used,before.runs_used);
    }
    // Existing trigger kinds remain readable and writable without the guard function.
    legacyDb.prepare('UPDATE wb_persistent_tasks SET title=title WHERE task_id=?').run(calendar.task_id);
    assert.equal(f.service.get('alice',cron.task_id).runs_used,0);
    assert.equal(f.service.get('alice',delay.task_id).runs_used,0);
    assert.equal(f.service.occurrences('alice',cron.task_id).items.length,0);
    assert.equal(f.service.occurrences('alice',delay.task_id).items.length,0);
  } finally {
    if(legacyDb)legacyDb.close();
    f.close();
    rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});
  }
});

test('restoring a pre-feature database backup preserves the legacy trigger path', () => {
  const testTmp=resolve(process.cwd(),'.test-tmp');mkdirSync(testTmp,{recursive:true});
  const directory=mkdtempSync(join(testTmp,`cron-pre-feature-rollback-${randomUUID()}-`));
  const databasePath=join(directory,'current.sqlite');
  const backupPath=join(directory,'pre-feature.sqlite');
  const restoredPath=join(directory,'restored.sqlite');
  const db=openProductDatabase(databasePath);
  const conversation=new ConversationRepository(db).create('alice',{workspace_id:'ws',model:{provider:'harness',model:'automatic'}});
  const agent={agent_id:'calendar-agent',status:'active',workspace_id:'ws',project_id:conversation.project_id,conversation_id:conversation.conversation_id};
  const workbench={getAgent(owner,id){if(owner!=='alice'||id!==agent.agent_id)throw Error('agent_not_found');return agent;},bindRun(){}};
  let restored;
  try {
    // Model the old release's existing task table and row before the upgrade.
    db.exec(`CREATE TABLE wb_persistent_tasks (
      task_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,agent_id TEXT NOT NULL,title TEXT NOT NULL,objective TEXT NOT NULL,
      trigger_json TEXT NOT NULL,priority INTEGER NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,generation INTEGER NOT NULL,
      schedule_revision INTEGER NOT NULL,max_runs INTEGER NOT NULL,runs_used INTEGER NOT NULL DEFAULT 0,next_due_at TEXT,
      baseline_hash TEXT,baseline_revision INTEGER NOT NULL DEFAULT 0,last_error TEXT,failure_count INTEGER NOT NULL DEFAULT 0,
      projection_pending INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX wb_tasks_due ON wb_persistent_tasks(status,next_due_at,priority);`);
    db.prepare(`INSERT INTO wb_persistent_tasks(task_id,owner_id,agent_id,title,objective,trigger_json,priority,status,version,
      generation,schedule_revision,max_runs,runs_used,next_due_at,baseline_revision,failure_count,projection_pending,created_at,updated_at)
      VALUES('legacy-daily','alice','calendar-agent','Legacy daily','Original task',?,0,'active',1,1,1,100,0,'2026-01-05T09:00:00.000Z',0,0,1,?,?)`)
      .run(JSON.stringify({kind:'daily',time:'09:00',timezone:'UTC'}),'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    db.exec(`VACUUM INTO '${backupPath.replaceAll("'","''")}'`);

    const upgraded=new PersistentTaskService(db,workbench,{now:()=>new Date('2026-01-05T09:00:00Z')});
    upgraded.create('alice',{...input,trigger:{kind:'cron',expression:'* * * * *',timezone:'UTC'}});
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='wb_task_trigger_protocol_guard'").get().n,1);

    // The rollback flow restores the upgrade-time database file, then opens it
    // through the same product database opener used by the legacy release.
    copyFileSync(backupPath,restoredPath);
    const restoredDb=openProductDatabase(restoredPath);
    restored={db:restoredDb,close(){restoredDb.close();}};
    assert.equal(restoredDb.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name='wb_task_trigger_protocol_guard'").get().n,0);
    const oldTask=restoredDb.prepare('SELECT trigger_json,next_due_at FROM wb_persistent_tasks WHERE task_id=?').get('legacy-daily');
    assert.deepEqual(JSON.parse(oldTask.trigger_json),{kind:'daily',time:'09:00',timezone:'UTC'});
    assert.equal(oldTask.next_due_at,'2026-01-05T09:00:00.000Z');
    restoredDb.prepare('UPDATE wb_persistent_tasks SET next_due_at=? WHERE task_id=?').run('2026-01-06T09:00:00.000Z','legacy-daily');
    assert.equal(restoredDb.prepare('SELECT next_due_at FROM wb_persistent_tasks WHERE task_id=?').get('legacy-daily').next_due_at,'2026-01-06T09:00:00.000Z');
  } finally {
    restored?.close();
    db.close();
    rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:20});
  }
});
