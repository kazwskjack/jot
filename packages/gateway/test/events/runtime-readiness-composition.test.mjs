import test from 'node:test';
import assert from 'node:assert/strict';
import {openProductDatabase,withImmediateTransaction} from '../../src/db/database.ts';
import {SessionControllerClient} from '../../src/harness/session-controller-client.ts';
import {composeScopedRuntimeReadiness,createBrowserDriverReadinessSource} from '../../src/events/runtime-readiness-composition.ts';
import {acceptedExecutionPolicy} from '../../src/conversations/mode-policy.ts';
import {snapshotAcceptedModelPolicy} from '../../src/conversations/model-policy.ts';
import {canonicalJson} from '../../src/db/canonical-json.ts';
import {workAdmissionDigest} from '../../src/always-on/work-admission-records.ts';
import {workGrantFixture} from '../always-on/work-grant-fixture.mjs';
import {WorkGrants} from '../../src/always-on/work-grants.ts';

const observedAt='2026-10-21T05:00:00.000Z';
const fixedNow=new Date(observedAt);

function fixture(){
  const db=openProductDatabase(':memory:');
  const addConversation=({id,owner='alice',workspace='workspace-a',session})=>{
    const created='2026-10-21T04:00:00.000Z';
    db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id,owner,workspace,'Readiness fixture','local-model',created,created);
    if(session){
      db.prepare('INSERT INTO ga_harness_session_bindings(conversation_id,owner_id,session_id,created_at,updated_at) VALUES(?,?,?,?,?)')
        .run(id,owner,session,created,created);
      db.prepare('INSERT INTO ga_conversation_mode_sessions(conversation_id,owner_id,mode,session_id,created_at) VALUES(?,?,?,?,?)')
        .run(id,owner,'work',session,created);
    }
  };
  const addRun=({id,conversationId,sessionId=null,owner='alice',workspace='workspace-a',status='running',leaseOwner='readiness-worker'})=>{
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO ga_runs(id,conversation_id,status,version,created_at,updated_at,native_session_ref,native_owner_id,native_conversation_id)
      VALUES(?,?,?,1,?,?,?,?,?)`).run(id,conversationId,status,now,now,sessionId,owner,conversationId);
    db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,1,?,?)')
      .run(id,leaseOwner,String(Date.now()+60000),now);
  };
  return{db,addConversation,addRun,close:()=>db.close()};
}

function nativeIdle(sessionId,at=Date.parse(observedAt)){
  return{protocol:1,session_id:sessionId,basis:'live',native_idle:'idle',reason:null,observed_at:at,execution_authorized:false};
}

function addOrdinaryPolicyRun(db,{runId,conversationId,sessionId,owner='alice',valid=true}){
  const now=new Date().toISOString();
  const model={provider:'local',model:'local-model'};
  db.prepare('UPDATE ga_conversations SET model=? WHERE id=?').run(JSON.stringify(model),conversationId);
  const policy=withImmediateTransaction(db,()=>{
    const modelPolicy=snapshotAcceptedModelPolicy(db,conversationId,owner);
    return{modelPolicy,executionPolicy:acceptedExecutionPolicy('work',1,modelPolicy,'jot-general')};
  });
  const inputMessageId=`input-${runId}`;
  db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,'user','complete',?,?,?)")
    .run(inputMessageId,conversationId,runId,JSON.stringify({blocks:[{type:'text',text:'hello'}]}),now,now);
  db.prepare(`INSERT INTO ga_runs(id,conversation_id,input_message_id,status,version,created_at,updated_at,model_policy_json,execution_policy_json,native_session_ref,native_owner_id,native_conversation_id)
    VALUES(?,?,?,'running',1,?,?,?,?,?,?,?)`)
    .run(runId,conversationId,inputMessageId,now,now,policy.modelPolicy,valid?policy.executionPolicy:'{}',sessionId,owner,conversationId);
  db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,1,?,?)')
    .run(runId,'readiness-worker',String(Date.now()+60000),now);
}

async function admittedTaskPolicyFixture(t){
  const f=await workGrantFixture(t),grants=new WorkGrants(f.db,f.budget),grant=grants.authorize('owner',f.scope,f.cycle.cycle_id,f.input,'readiness-policy');
  t.after(f.close);
  const admission=f.tasks.enqueueDiscoveryWork('owner',grant.grant_id,()=>{
    grants.guard('owner',f.scope,grant.grant_id);
    return{activity_sha256:'a'.repeat(64),native_sha256:'b'.repeat(64),capacity_sha256:'c'.repeat(64),
      source_verified_sha256:'d'.repeat(64),snapshot_verified_sha256:'e'.repeat(64),budget_policy_revision:1,observed_at:Date.now()};
  });
  const sessionId='task-policy-session',created=new Date().toISOString();
  f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(admission.conversation_id,'owner',sessionId,created,created);
  f.db.prepare('INSERT INTO ga_conversation_mode_sessions VALUES(?,?,?,?,?)').run(admission.conversation_id,'owner','work',sessionId,created);
  f.db.prepare('UPDATE ga_runs SET native_session_ref=?,native_owner_id=?,native_conversation_id=? WHERE id=?')
    .run(sessionId,'owner',admission.conversation_id,admission.run_id);
  const lease=f.coordinator.claimNext('policy-readiness-worker',30000);assert.equal(lease.run_id,admission.run_id);f.coordinator.start(lease);
  return{f,admission,sessionId,scope:{run_id:admission.run_id,owner_id:'owner',workspace_id:f.scope.workspace_id}};
}

function taskGoalStatus(hostStatus='running',runStatus='running'){
  return{state:{protocol:1,host_status:hostStatus,
    goal:{goal_id:'goal-readiness',goal_revision:1,phase:'active',activation:'armed',rounds_started:1,max_goal_rounds:3},
    task:{run_status:runStatus,business_state:'ready',steps:{total:1,completed:0,evidence_verified:0,all_completed:false,all_execution_evidence_verified:false},
      budget:{configured:false,balances:[],pending_unknown:null,pending_in_flight:null}}}};
}

function clientFor(respond){
  const calls=[];
  const client=new SessionControllerClient('http://127.0.0.1:18841','t'.repeat(32),async(input,init)=>{
    const url=new URL(String(input));
    const body=JSON.parse(String(init.body));
    calls.push({url,init,body});
    const response=await respond({url,init,body});
    return response instanceof Response?response:new Response(JSON.stringify(response.body),{status:response.status??200});
  });
  return{client,calls};
}

const observe=(db,sources,options={})=>composeScopedRuntimeReadiness(db,
  {run_id:'run-readiness-scope',owner_id:'alice',workspace_id:'workspace-a'},sources,{now:()=>fixedNow,...options});
const nativeResult=result=>result.readiness.components.find(item=>item.component==='native');

test('run-bound status sources receive the exact run owner and workspace without exposing identities',async t=>{
  const f=fixture();t.after(f.close);
  const scope={run_id:'run-private-a',owner_id:'alice',workspace_id:'workspace-a'};
  let received;
  const result=await composeScopedRuntimeReadiness(f.db,scope,{
    consumer:async(value,signal)=>{
      received=value;
      assert.equal(signal.aborted,false);
      return{protocol:1,scope:value,status:'ready',required:true,observed_at:observedAt};
    },
  },{now:()=>fixedNow});

  assert.deepEqual(received,scope);
  assert.equal(Object.isFrozen(received),true);
  assert.equal(result.readiness.components.find(item=>item.component==='consumer').status,'ready');
  assert.equal(result.readiness.components.find(item=>item.component==='consumer').observed_at,observedAt);
  assert.equal(result.readiness.components.find(item=>item.component==='driver').status,'unknown');
  assert.equal(result.execution_authorized,false);
  assert.equal(JSON.stringify(result).includes('run-private-a'),false);
  assert.deepEqual(result.scope,{owner_id:'alice',workspace_id:'workspace-a'});
});

test('missing readiness ports identify their actual producers and hold the absent driver unknown',async t=>{
  const f=fixture();t.after(f.close);
  const result=await observe(f.db,{});
  const gap=component=>result.source_gaps.find(item=>item.component===component);
  const consumer=gap('consumer'),storage=gap('storage'),driver=gap('driver');

  assert.match(consumer.source_symbol,/HarnessWorker\.observeConsumerReadiness/);
  assert.match(consumer.source_symbol,/runtimeReadinessSources\.consumer/);
  assert.match(storage.source_symbol,/TrustedWorkRunWorkspaceResolver\.inspectForRun/);
  assert.match(storage.source_symbol,/nativeWork\.resolver/);
  assert.match(driver.source_symbol,/SessionControllerClient\.observeBrowserDriver/);
  assert.match(driver.source_symbol,/createBrowserDriverReadinessSource/);
  assert.match(driver.source_symbol,/NativeGitClient\.execute\(\)/);
  assert.doesNotMatch(driver.source_symbol,/HOLD/);
  assert.match(driver.source_symbol,/NativeGitClient\.execute\(\)/);
  assert.deepEqual([result.readiness.components.find(item=>item.component==='driver').status,
    result.readiness.components.find(item=>item.component==='driver').reason],['unknown','source_missing']);
  assert.equal(result.execution_authorized,false);
});

test('a run-bound source that echoes another run cannot report readiness',async t=>{
  const f=fixture();t.after(f.close);
  const scope={run_id:'run-private-a',owner_id:'alice',workspace_id:'workspace-a'};
  const result=await composeScopedRuntimeReadiness(f.db,scope,{
    consumer:async value=>({protocol:1,scope:{...value,run_id:'run-private-b'},status:'ready',required:true,observed_at:observedAt}),
  },{now:()=>fixedNow});
  const consumer=result.readiness.components.find(item=>item.component==='consumer');

  assert.deepEqual([consumer.status,consumer.reason],['unknown','consumer_scope_mismatch']);
  assert.equal(result.readiness.execution_ready,false);
  assert.equal(result.execution_authorized,false);
});

test('native observations use the exact run session and ignore other sessions in the workspace',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'current-run-conversation',session:'session-current-run'});
  f.addConversation({id:'other-workspace-conversation',session:'session-other-run'});
  f.addRun({id:'run-readiness-scope',conversationId:'current-run-conversation',sessionId:'session-current-run'});
  const {client,calls}=clientFor(({url})=>({body:nativeIdle(decodeURIComponent(url.pathname.split('/')[3]))}));

  const result=await observe(f.db,{native:client});

  assert.deepEqual(calls.map(({url})=>decodeURIComponent(url.pathname.split('/')[3])),['session-current-run']);
  assert.equal(nativeResult(result).status,'ready');
  assert.equal(result.execution_authorized,false);
  assert.equal(JSON.stringify(result).includes('session-current-run'),false);
  assert.equal(JSON.stringify(result).includes('session-other-run'),false);
});

test('storage readiness inspects only the exact active run lease without mutating Gateway state',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'storage-current',session:'storage-session'});
  f.addRun({id:'storage-run',conversationId:'storage-current',sessionId:'storage-session'});
  const scope={run_id:'storage-run',owner_id:'alice',workspace_id:'workspace-a'};
  const calls=[];
  const {createRuntimeReadinessStorageSource}=await import('../../src/events/runtime-readiness-composition.ts');
  const source=createRuntimeReadinessStorageSource(f.db,{inspectForRun:async(runId,lease)=>{
    calls.push({runId,lease});
    return{sessionRef:'storage-session',inspection:{snapshot_id:'snapshot-a',manifest_sha256:'a'.repeat(64),execution_authorized:false}};
  }},()=>fixedNow);
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;

  const sample=await source(scope,new AbortController().signal);

  assert.equal(sample.status,'ready');
  assert.deepEqual(sample.scope,scope);
  assert.equal(sample.execution_authorized,undefined);
  assert.deepEqual(calls,[{runId:'storage-run',lease:{owner:'readiness-worker',generation:1}}]);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
});

test('storage readiness is unknown when the run lease changes during inspection',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'storage-changing',session:'storage-session'});
  f.addRun({id:'storage-run',conversationId:'storage-changing',sessionId:'storage-session'});
  const scope={run_id:'storage-run',owner_id:'alice',workspace_id:'workspace-a'};
  const {createRuntimeReadinessStorageSource}=await import('../../src/events/runtime-readiness-composition.ts');
  const source=createRuntimeReadinessStorageSource(f.db,{inspectForRun:async()=>{
    f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1 WHERE resource_id=?').run('storage-run');
    return{sessionRef:'storage-session',inspection:{snapshot_id:'snapshot-a',manifest_sha256:'a'.repeat(64),execution_authorized:false}};
  }},()=>fixedNow);

  const sample=await source(scope,new AbortController().signal);

  assert.deepEqual([sample.status,sample.reason],['unknown','storage_scope_changed']);
});

test('storage source snapshots its caller scope before awaiting the inspector',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'storage-snapshot-scope',session:'storage-session'});
  f.addRun({id:'storage-run',conversationId:'storage-snapshot-scope',sessionId:'storage-session'});
  const scope={run_id:'storage-run',owner_id:'alice',workspace_id:'workspace-a'};
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const {createRuntimeReadinessStorageSource}=await import('../../src/events/runtime-readiness-composition.ts');
  const source=createRuntimeReadinessStorageSource(f.db,{inspectForRun:async()=>await pending},()=>fixedNow);
  const samplePromise=source(scope,new AbortController().signal);
  scope.workspace_id='replacement-workspace';
  release({sessionRef:'storage-session',inspection:{snapshot_id:'snapshot-a',manifest_sha256:'a'.repeat(64),execution_authorized:false}});

  const sample=await samplePromise;

  assert.equal(sample.status,'ready');
  assert.deepEqual(sample.scope,{run_id:'storage-run',owner_id:'alice',workspace_id:'workspace-a'});
});

test('storage readiness skips an inspector when cancellation wins before dispatch',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'storage-cancel-before',session:'storage-session'});
  f.addRun({id:'storage-run',conversationId:'storage-cancel-before',sessionId:'storage-session'});
  const scope={run_id:'storage-run',owner_id:'alice',workspace_id:'workspace-a'};
  let calls=0;
  const {createRuntimeReadinessStorageSource}=await import('../../src/events/runtime-readiness-composition.ts');
  const source=createRuntimeReadinessStorageSource(f.db,{inspectForRun:async()=>{
    calls++;
    return{sessionRef:'storage-session',inspection:{snapshot_id:'snapshot-a',manifest_sha256:'a'.repeat(64),execution_authorized:false}};
  }},()=>fixedNow);
  const controller=new AbortController();
  const pending=source(scope,controller.signal);
  controller.abort();

  const sample=await pending;

  assert.deepEqual([sample.status,sample.reason],['unknown','storage_observation_cancelled']);
  assert.equal(calls,0);
});

test('a cancelled storage inspector stays fenced until its physical inspection settles',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'storage-cancel-in-flight',session:'storage-session'});
  f.addRun({id:'storage-run',conversationId:'storage-cancel-in-flight',sessionId:'storage-session'});
  const scope={run_id:'storage-run',owner_id:'alice',workspace_id:'workspace-a'};
  let release,calls=0;
  const inspection=new Promise(resolve=>{release=resolve;});
  const {createRuntimeReadinessStorageSource}=await import('../../src/events/runtime-readiness-composition.ts');
  const source=createRuntimeReadinessStorageSource(f.db,{inspectForRun:async()=>{calls++;return inspection;}},()=>fixedNow);
  const controller=new AbortController();
  const firstPromise=source(scope,controller.signal);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);
  controller.abort();
  let secondPromise;
  try{
    const first=await Promise.race([firstPromise,new Promise(resolve=>setTimeout(()=>resolve(null),25))]);
    assert.ok(first,'storage readiness must honor caller cancellation');
    assert.deepEqual([first.status,first.reason],['unknown','storage_observation_cancelled']);
    secondPromise=source(scope,new AbortController().signal);
    const second=await Promise.race([secondPromise,new Promise(resolve=>setTimeout(()=>resolve(null),25))]);
    assert.deepEqual([second?.status,second?.reason],['unknown','storage_inspection_busy']);
    assert.equal(calls,1);
  }finally{
    release({sessionRef:'storage-session',inspection:{snapshot_id:'snapshot-a',manifest_sha256:'a'.repeat(64),execution_authorized:false}});
    await firstPromise.catch(()=>{});
    await secondPromise?.catch(()=>{});
  }
  await new Promise(resolve=>setImmediate(resolve));
  const third=await source(scope,new AbortController().signal);
  assert.equal(third.status,'ready');
  assert.equal(calls,2);
});

test('Host and policy readiness come from the exact existing run/session/lease sources',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'workbench-current',session:'workbench-session'});
  addOrdinaryPolicyRun(f.db,{runId:'run-workbench-current',conversationId:'workbench-current',sessionId:'workbench-session'});
  const scope={run_id:'run-workbench-current',owner_id:'alice',workspace_id:'workspace-a'};
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;let hostCalls=0;

  const result=await composeScopedRuntimeReadiness(f.db,scope,{workbench:{goalStatus:async(sessionId,signal)=>{
    hostCalls++;assert.equal(sessionId,'workbench-session');assert.equal(signal.aborted,false);return taskGoalStatus();
  }}},{now:()=>fixedNow});

  assert.equal(hostCalls,1);
  for(const component of ['host','policy'])assert.equal(result.readiness.components.find(item=>item.component===component).status,'ready');
  assert.equal(result.source_gaps.some(gap=>gap.component==='host'||gap.component==='policy'),false);
  assert.equal(result.readiness.execution_ready,false);
  assert.equal(result.execution_authorized,false);
  assert.equal(JSON.stringify(result).includes('run-workbench-current'),false);
  assert.equal(JSON.stringify(result).includes('workbench-session'),false);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
});

test('an admitted task-bound Workbench run can validate its immutable policy without authorizing execution',async t=>{
  const{f,admission,sessionId,scope}=await admittedTaskPolicyFixture(t);
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;

  const result=await composeScopedRuntimeReadiness(f.db,scope,{}, {now:()=>fixedNow});
  const policy=result.readiness.components.find(item=>item.component==='policy');

  assert.equal(policy.status,'ready');
  assert.equal(policy.reason??undefined,undefined);
  assert.equal(result.source_gaps.some(gap=>gap.component==='policy'),false);
  assert.equal(result.readiness.execution_ready,false);
  assert.equal(result.execution_authorized,false);
  assert.equal(JSON.stringify(result).includes(admission.task_id),false);
  assert.equal(JSON.stringify(result).includes(sessionId),false);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
});

test('task-bound policy stays unknown if task identity drifts after its snapshot',async t=>{
  for(const drift of ['binding','occurrence','admission']){
    const{f,admission,scope}=await admittedTaskPolicyFixture(t);
    const mutate=()=>{
      if(drift==='binding'){
        const row=f.db.prepare('SELECT context_json FROM wb_run_bindings WHERE run_id=?').get(scope.run_id);
        const context=JSON.parse(row.context_json);context.memory_retrieval_id='changed-after-snapshot';
        f.db.prepare('UPDATE wb_run_bindings SET context_json=? WHERE run_id=?').run(JSON.stringify(context),scope.run_id);
      }else if(drift==='occurrence'){
        f.db.prepare('UPDATE wb_task_occurrences SET run_id=? WHERE occurrence_id=?').run('drifted-task-run',admission.occurrence_id);
      }else{
        f.db.exec('DROP TRIGGER wb_work_admission_no_update');
        const row=f.db.prepare('SELECT record_json FROM wb_discovery_work_admissions WHERE run_id=?').get(scope.run_id);
        const record=JSON.parse(row.record_json);record.created_at='changed-after-snapshot';
        f.db.prepare('UPDATE wb_discovery_work_admissions SET record_json=?,record_sha256=?,created_at=? WHERE run_id=?')
          .run(canonicalJson(record),workAdmissionDigest(record),record.created_at,scope.run_id);
      }
    };
    const originalExec=f.db.exec.bind(f.db);let injected=false;
    const db=new Proxy(f.db,{get(target,key){
      if(key==='exec')return sql=>{
        const result=originalExec(sql);
        if(sql==='ROLLBACK'&&!injected){injected=true;mutate();}
        return result;
      };
      const value=Reflect.get(target,key,target);
      return typeof value==='function'?value.bind(target):value;
    }});

    const result=await composeScopedRuntimeReadiness(db,scope,{}, {now:()=>fixedNow});
    const policy=result.readiness.components.find(item=>item.component==='policy');

    assert.equal(injected,true,drift);
    assert.deepEqual([policy.status,policy.reason],['unknown','policy_scope_changed'],drift);
    assert.equal(result.readiness.execution_ready,false,drift);
    assert.equal(result.execution_authorized,false,drift);
  }
});

test('task-bound policy stays unknown when its binding or admission is missing or either immutable snapshot is forged',async t=>{
  for(const mode of ['missing-binding','missing-admission','forged-admission','forged-policy']){
    const{f,scope,admission}=await admittedTaskPolicyFixture(t);
    if(mode==='missing-binding'){
      f.db.prepare('DELETE FROM wb_run_bindings WHERE run_id=?').run(scope.run_id);
    }else if(mode==='missing-admission'){
      f.db.exec('DROP TRIGGER wb_work_admission_no_delete');
      f.db.prepare('DELETE FROM wb_discovery_work_admissions WHERE run_id=?').run(scope.run_id);
    }else if(mode==='forged-admission'){
      f.db.exec('DROP TRIGGER wb_work_admission_no_update');
      f.db.prepare("UPDATE wb_discovery_work_admissions SET record_sha256=? WHERE run_id=?").run('f'.repeat(64),scope.run_id);
    }else{
      f.db.exec('DROP TRIGGER ga_execution_policy_immutable');
      f.db.prepare("UPDATE ga_runs SET execution_policy_json='{}' WHERE id=?").run(scope.run_id);
    }
    const result=await composeScopedRuntimeReadiness(f.db,scope,{}, {now:()=>fixedNow});
    const policy=result.readiness.components.find(item=>item.component==='policy');
    assert.equal(policy.status,'unknown',mode);
    assert.equal(result.readiness.execution_ready,false);
    assert.equal(result.execution_authorized,false);
  }
});

test('task-bound policy stays unknown across foreign scope, stale lease or generation, and changed mode',async t=>{
  for(const mode of ['foreign-scope','stale-lease','stale-generation','changed-mode']){
    const{f,scope,admission}=await admittedTaskPolicyFixture(t);
    let observedScope=scope;
    if(mode==='foreign-scope')observedScope={...scope,workspace_id:'workspace-foreign'};
    if(mode==='stale-lease')f.db.prepare("UPDATE ga_worker_leases SET expires_at='1' WHERE resource_id=?").run(scope.run_id);
    if(mode==='stale-generation')f.db.prepare('UPDATE wb_persistent_tasks SET generation=generation+1 WHERE task_id=?').run(admission.task_id);
    if(mode==='changed-mode'){
      f.db.exec('DROP TRIGGER ga_mode_session_immutable');
      f.db.prepare("UPDATE ga_conversation_mode_sessions SET mode='chat' WHERE conversation_id=? AND mode='work'")
        .run(admission.conversation_id);
    }
    const result=await composeScopedRuntimeReadiness(f.db,observedScope,{}, {now:()=>fixedNow});
    const policy=result.readiness.components.find(item=>item.component==='policy');
    assert.equal(policy.status,'unknown',mode);
    assert.equal(result.readiness.execution_ready,false);
    assert.equal(result.execution_authorized,false);
  }
});

test('Host readiness is unknown if its exact lease binding changes during the status read',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'workbench-changing',session:'workbench-session'});
  addOrdinaryPolicyRun(f.db,{runId:'run-workbench-changing',conversationId:'workbench-changing',sessionId:'workbench-session'});
  const scope={run_id:'run-workbench-changing',owner_id:'alice',workspace_id:'workspace-a'};

  const result=await composeScopedRuntimeReadiness(f.db,scope,{workbench:{goalStatus:async()=>{
    f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1 WHERE resource_id=?').run(scope.run_id);
    return taskGoalStatus();
  }}},{now:()=>fixedNow});
  const host=result.readiness.components.find(item=>item.component==='host');

  assert.deepEqual([host.status,host.reason],['unknown','workbench_scope_changed']);
  assert.equal(result.source_gaps.some(gap=>gap.component==='host'&&gap.code==='workbench_scope_changed'),true);
  assert.equal(result.readiness.execution_ready,false);
  assert.equal(result.execution_authorized,false);
});

test('native observations use only current owner/workspace bindings and retain freshness without exposing session IDs',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'mine',session:'session-private-a'});
  f.addConversation({id:'foreign-owner',owner:'bob',session:'session-private-b'});
  f.addConversation({id:'foreign-workspace',workspace:'workspace-b',session:'session-private-c'});
  f.addRun({id:'run-readiness-scope',conversationId:'mine'});
  const {client,calls}=clientFor(({url})=>({body:nativeIdle(decodeURIComponent(url.pathname.split('/')[3]))}));
  const before=f.db.prepare('SELECT total_changes() AS n').get().n;

  const result=await observe(f.db,{native:client});

  assert.deepEqual(calls.map(({url,init,body})=>[init.method,url.pathname,body]),[
    ['POST','/v1/sessions/session-private-a/idle-observation',{protocol:1}],
  ]);
  assert.deepEqual(result.scope,{owner_id:'alice',workspace_id:'workspace-a'});
  assert.deepEqual(result.freshness.native,{
    observed_at_earliest:observedAt,observed_at_latest:observedAt,max_age_ms:60000,session_count:1,bindings_stable:true,
  });
  assert.deepEqual([nativeResult(result).status,nativeResult(result).reason],['ready',null]);
  assert.equal(result.readiness.execution_ready,false);
  assert.equal(result.execution_authorized,false);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
  for(const sessionId of ['session-private-a','session-private-b','session-private-c'])assert.equal(JSON.stringify(result).includes(sessionId),false);
});

test('foreign or absent bindings do not invoke the native observation port',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'foreign',owner:'bob',session:'session-foreign'});
  f.addConversation({id:'mine-without-session'});
  f.addRun({id:'run-readiness-scope',conversationId:'mine-without-session'});
  const {client,calls}=clientFor(()=>assert.fail('unbound native Session must not be observed'));

  const result=await observe(f.db,{native:client});

  assert.equal(calls.length,0);
  assert.deepEqual([nativeResult(result).status,nativeResult(result).reason],['unknown','native_session_binding_missing']);
  assert.equal(result.execution_authorized,false);
  assert.equal(JSON.stringify(result).includes('session-foreign'),false);
});

test('owner, workspace, or session binding changes during the read discard the native observation',async t=>{
  const mutations=[
    ['owner',db=>db.prepare("UPDATE ga_conversations SET owner_id='bob' WHERE id='mine'").run()],
    ['workspace',db=>db.prepare("UPDATE ga_conversations SET workspace_id='workspace-b' WHERE id='mine'").run()],
    ['session',db=>{
      db.prepare("UPDATE ga_harness_session_bindings SET session_id='session-after' WHERE conversation_id='mine'").run();
    }],
  ];
  for(const [kind,mutate] of mutations){
    const f=fixture();
    try{
      f.addConversation({id:'mine',session:'session-before'});
      f.addRun({id:'run-readiness-scope',conversationId:'mine'});
      const {client}=clientFor(({url})=>{
        mutate(f.db);
        return{body:nativeIdle(decodeURIComponent(url.pathname.split('/')[3]))};
      });

      const result=await observe(f.db,{native:client});

      assert.deepEqual([nativeResult(result).status,nativeResult(result).reason],['unknown','native_scope_changed'],kind);
      assert.equal(result.freshness.native.bindings_stable,false,kind);
      assert.equal(result.execution_authorized,false,kind);
      assert.equal(JSON.stringify(result).includes('session-before'),false,kind);
      assert.equal(JSON.stringify(result).includes('session-after'),false,kind);
    }finally{f.close();}
  }
});

test('the source observation time is preserved and the original collector marks stale evidence unknown',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'mine',session:'session-stale'});
  f.addRun({id:'run-readiness-scope',conversationId:'mine'});
  const staleAt=Date.parse(observedAt)-60001;
  const {client}=clientFor(({url})=>({body:nativeIdle(decodeURIComponent(url.pathname.split('/')[3]),staleAt)}));

  const result=await observe(f.db,{native:client});

  assert.equal(result.freshness.native.observed_at_earliest,'2026-10-21T04:58:59.999Z');
  assert.deepEqual([nativeResult(result).status,nativeResult(result).reason],['unknown','observation_stale']);
  assert.equal(result.execution_authorized,false);
  assert.equal(JSON.stringify(result).includes('session-stale'),false);
});

test('native source errors and unsupported observations stay unknown and redact transport details',async t=>{
  const failures=[
    ['transport',()=>new Response(JSON.stringify({error:'private adapter detail'}),{status:503})],
    ['unsupported',()=>({body:{protocol:1,session_id:'session-private',basis:'unsupported',native_idle:'idle',reason:null,observed_at:Date.parse(observedAt),execution_authorized:false}})],
  ];
  for(const [kind,respond] of failures){
    const f=fixture();
    try{
      f.addConversation({id:'mine',session:'session-private'});
      f.addRun({id:'run-readiness-scope',conversationId:'mine'});
      const {client}=clientFor(respond);

      const result=await observe(f.db,{native:client});

      assert.equal(nativeResult(result).status,'unknown',kind);
      assert.equal(result.readiness.execution_ready,false,kind);
      assert.equal(result.execution_authorized,false,kind);
      assert.equal(JSON.stringify(result).includes('private adapter detail'),false,kind);
      assert.equal(JSON.stringify(result).includes('session-private'),false,kind);
    }finally{f.close();}
  }
});

test('cancellation leaves native readiness unknown and never exposes the session ID',async t=>{
  const f=fixture();t.after(f.close);
  f.addConversation({id:'mine',session:'session-cancelled'});
  f.addRun({id:'run-readiness-scope',conversationId:'mine'});
  let started;
  const startedPromise=new Promise(resolve=>{started=resolve;});
  const {client}=clientFor(({init})=>new Promise((_resolve,reject)=>{
    started();
    init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});
  }));
  const controller=new AbortController();
  const pending=observe(f.db,{native:client},{signal:controller.signal});
  await startedPromise;
  controller.abort(new Error('private cancellation detail'));

  const result=await pending;

  assert.deepEqual([nativeResult(result).status,nativeResult(result).reason],['unknown','observation_cancelled']);
  assert.equal(result.execution_authorized,false);
  assert.equal(JSON.stringify(result).includes('private cancellation detail'),false);
  assert.equal(JSON.stringify(result).includes('session-cancelled'),false);
});

function driverFixture(){
  const db=openProductDatabase(':memory:');
  const now=new Date().toISOString();
  db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('driver-conversation','owner-a','workspace-a','Driver fixture','local-model',now,now);
  db.prepare(`INSERT INTO ga_runs(id,conversation_id,status,version,created_at,updated_at,native_session_ref,native_owner_id,native_conversation_id)
    VALUES(?,?,'running',1,?,?,?,?,?)`).run('driver-run','driver-conversation',now,now,'driver-session','owner-a','driver-conversation');
  db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?)')
    .run('driver-run','driver-worker',3,String(Date.now()+60_000),now);
  return{db,close:()=>db.close()};
}

const driverScope={run_id:'driver-run',owner_id:'owner-a',workspace_id:'workspace-a'};

test('driver source reads only the exact active run/session/lease and composes passive readiness',async t=>{
  const f=driverFixture();t.after(f.close);let received;
  const source=createBrowserDriverReadinessSource(f.db,{observeBrowserDriver:async(sessionId,scope,signal)=>{
    received={sessionId,scope,signal};
    return{protocol:1,scope,status:'ready',required:true,observed_at:new Date().toISOString(),execution_authorized:false};
  }});
  const value=await source(driverScope,new AbortController().signal);
  assert.equal(received.sessionId,'driver-session');
  assert.deepEqual(received.scope,{run_id:'driver-run',owner_id:'owner-a',workspace_id:'workspace-a',session_id:'driver-session',lease_owner:'driver-worker',lease_generation:3});
  assert.equal(Object.isFrozen(received.scope),true);
  assert.equal(value.status,'ready');assert.equal(value.required,true);assert.equal(value.execution_authorized,undefined);
  const composed=await composeScopedRuntimeReadiness(f.db,driverScope,{driver:source});
  assert.equal(composed.readiness.components.find(item=>item.component==='driver').status,'ready');
  assert.equal(composed.execution_authorized,false);
  assert.doesNotMatch(JSON.stringify(composed),/driver-session|driver-run/);
});

test('driver source stays unknown for missing, expired or changed bindings and never calls Host unbound',async t=>{
  const f=driverFixture();t.after(f.close);let calls=0,changeLease=false,wrongScope=false;
  const source=createBrowserDriverReadinessSource(f.db,{observeBrowserDriver:async(_sessionId,scope)=>{
    calls++;
    if(changeLease)f.db.prepare('UPDATE ga_worker_leases SET generation=generation+1 WHERE resource_id=?').run('driver-run');
    return{protocol:1,scope:{...scope,...(wrongScope?{session_id:'session-other'}:{})},status:'ready',required:true,
      observed_at:new Date().toISOString(),execution_authorized:false};
  }});
  f.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=?').run('driver-run');
  assert.equal((await source(driverScope,new AbortController().signal)).status,'unknown');assert.equal(calls,0);
  f.db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?)')
    .run('driver-run','driver-worker',3,String(Date.now()-1),new Date().toISOString());
  assert.equal((await source(driverScope,new AbortController().signal)).status,'unknown');assert.equal(calls,0);
  f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()+60_000),'driver-run');
  wrongScope=true;assert.equal((await source(driverScope,new AbortController().signal)).status,'unknown');wrongScope=false;
  changeLease=true;assert.equal((await source(driverScope,new AbortController().signal)).status,'unknown');
  assert.equal(calls,2);
});

test('unobserved and stale Host driver results remain unknown',async t=>{
  const f=driverFixture();t.after(f.close);let response;
  const source=createBrowserDriverReadinessSource(f.db,{observeBrowserDriver:async(_sessionId,scope)=>({...response,scope})},()=>new Date('2026-10-25T08:00:00.000Z'));
  response={protocol:1,status:'unknown',required:true,observed_at:'2026-10-25T08:00:00.000Z',execution_authorized:false,reason:'driver_observation_unconfirmed'};
  assert.equal((await source(driverScope,new AbortController().signal)).status,'unknown');
  response={...response,status:'ready',observed_at:'2026-10-25T07:58:59.000Z'};
  assert.equal((await source(driverScope,new AbortController().signal)).status,'unknown');
});

test('an unconfirmed wired driver reports its real source and stays non-ready',async t=>{
  const f=driverFixture();t.after(f.close);
  const source=createBrowserDriverReadinessSource(f.db,{observeBrowserDriver:async(_sessionId,scope)=>({
    protocol:1,scope,status:'unknown',required:true,observed_at:observedAt,reason:'driver_observation_unconfirmed',execution_authorized:false,
  })},()=>fixedNow);

  const result=await composeScopedRuntimeReadiness(f.db,driverScope,{driver:source},{now:()=>fixedNow});
  const driver=result.readiness.components.find(item=>item.component==='driver');
  const gap=result.source_gaps.find(item=>item.component==='driver');

  assert.deepEqual([driver.status,driver.reason],['unknown','driver_observation_unconfirmed']);
  assert.match(gap.source_symbol,/SessionControllerClient\.observeBrowserDriver/);
  assert.doesNotMatch(gap.source_symbol,/No run-bound.*producer is wired/);
  assert.equal(result.readiness.execution_ready,false);
  assert.equal(result.execution_authorized,false);
});
