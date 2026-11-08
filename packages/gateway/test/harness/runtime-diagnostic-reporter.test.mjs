import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {openProductDatabase} from '../../src/db/database.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {ConversationRepository} from '../../src/conversations/repository.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {OfficialSessionRunner} from '../../src/harness/official-session-runner.ts';

const timing={event:'jot_preparation_timing',run_hash:'a'.repeat(64),mode:'work',phase:'preparation_total',
  started_at:new Date().toISOString(),offset_ms:0,duration_ms:12,outcome:'succeeded'};

function fixture(t){
  const db=openProductDatabase(':memory:'),events=new EventStore(db),conversations=new ConversationRepository(db),runs=new RunRepository(db,events);
  t.after(()=>db.close());
  const conversation=conversations.create('private-owner',{workspace_id:'private-workspace',model:{provider:'fixture',model:'fixture'}});
  const accepted=runs.enqueue(conversation.conversation_id,'private-owner',{client_message_id:'fixture-input',content:[{type:'text',text:'private-prompt'}]});
  db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(accepted.run_id);
  db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,1,?,?)')
    .run(accepted.run_id,'reporter-worker',String(Date.now()+60000),new Date().toISOString());
  db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(conversation.conversation_id,'private-owner','private-session',new Date().toISOString(),new Date().toISOString());
  return{db,events,conversation,runId:accepted.run_id};
}

const idle=sessionId=>({protocol:1,session_id:sessionId,basis:'live',native_idle:'idle',reason:null,observed_at:Date.now(),execution_authorized:false});

test('preparation reporter samples exact run-bound sources and keeps the logged diagnostic redacted',async t=>{
  const f=fixture(t),calls=[],lines=[];let consumerScope,ready=false;
  const {createRunRuntimeDiagnosticReporter}=await import('../../src/harness/runtime-diagnostic-reporter.ts');
  const report=createRunRuntimeDiagnosticReporter(f.db,f.events,{
    native:{observeNativeIdle:async sessionId=>{calls.push(sessionId);return idle(sessionId);}},
    workbench:{goalStatus:async()=>assert.fail('non-Workbench run must not query Host goal status')},
    consumer:async scope=>{assert.equal(ready,true);consumerScope=scope;return{protocol:1,scope,status:'ready',required:true,observed_at:new Date().toISOString()};},
  },line=>lines.push(JSON.parse(line)));
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;
  const client={create:async()=>({}),prompt:async()=>({}),async *follow(){
    yield{type:'snapshot',cursor:0,records:[],hasMore:false};
    yield{type:'event',event:{type:'assistant/message',seq:1,data:{message:{content:[{type:'text',text:'fixture answer'}]}}}};
    yield{type:'event',event:{type:'turn/end',seq:2,data:{reason:{kind:'completed'}}}};
  }};
  const runner=new OfficialSessionRunner(client,{cwd:'/fixture',agentPreset:'fixture',onPreparationTiming:report});

  const result=await runner.run({enabled:true,taskRequestId:f.runId,sessionRef:'private-session',message:'private-question',
    deferCompletionProbe:true,onReady:()=>{ready=true;}});
  assert.equal(result.completed,true);
  assert.equal(ready,true);
  await setImmediate();

  assert.deepEqual(calls,['private-session']);
  assert.deepEqual(consumerScope,{run_id:f.runId,owner_id:'private-owner',workspace_id:'private-workspace'});
  assert.equal(lines.length,1);
  assert.equal(lines[0].observation,'observed');
  assert.equal(lines[0].execution_authorized,false);
  assert.equal(lines[0].readiness.execution_ready,false);
  assert.equal(lines[0].readiness.components.find(item=>item.component==='native').status,'ready');
  assert.equal(lines[0].readiness.components.find(item=>item.component==='consumer').status,'ready');
  assert.ok(lines[0].limitations.includes('driver_status_port_missing'));
  assert.doesNotMatch(JSON.stringify(lines),new RegExp(`private-owner|private-workspace|private-session|${f.runId}|Bearer`));
  const timingRows=f.db.prepare("SELECT payload_json FROM ga_events WHERE run_id=? AND type='runtime.preparation_timing'").all(f.runId);
  assert.ok(timingRows.some(row=>JSON.parse(row.payload_json).phase==='preparation_total'));
  assert.ok(timingRows.length>1);
  const afterReport=f.db.prepare('SELECT total_changes() AS n').get().n;
  await setImmediate();
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,afterReport);
  assert.ok(afterReport>before);
});

test('preparation reporter discards evidence if the run scope changes during collection',async t=>{
  const f=fixture(t),lines=[];
  const {createRunRuntimeDiagnosticReporter}=await import('../../src/harness/runtime-diagnostic-reporter.ts');
  const report=createRunRuntimeDiagnosticReporter(f.db,f.events,{native:{observeNativeIdle:async sessionId=>{
    f.db.prepare('UPDATE ga_conversations SET workspace_id=? WHERE id=?').run('replacement-workspace',f.conversation.conversation_id);
    return idle(sessionId);
  }}},line=>lines.push(JSON.parse(line)));

  report(timing,{runId:f.runId});
  await setImmediate();

  assert.equal(lines.length,1);
  assert.equal(lines[0].observation,'discarded');
  assert.equal(lines[0].reason,'run_scope_changed');
  assert.equal(lines[0].readiness,undefined);
  assert.doesNotMatch(JSON.stringify(lines),/private-owner|private-workspace|private-session|replacement-workspace/);
});
