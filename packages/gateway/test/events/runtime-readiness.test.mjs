import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateRuntimeReadiness } from '../../src/events/runtime-readiness.ts';
import { openProductDatabase } from '../../src/db/database.ts';

const components = ['db','schema','host','native','consumer','policy','storage','driver'];
const ready = () => components.map(component => ({component,status:'ready',required:true}));

test('execution readiness requires every runtime dependency and keeps health separate', () => {
  const result = aggregateRuntimeReadiness(ready());
  assert.equal(result.execution_ready, true);
  assert.deepEqual(result.components.map(item => item.component), components);
  assert.ok(result.components.every(item => item.status === 'ready'));
});

test('disabled, unknown, and failed required dependencies never aggregate to ready', () => {
  for (const status of ['disabled','unknown','failed']) {
    const evidence = ready();
    evidence[components.indexOf('native')] = {component:'native',status,required:true,reason:'probe_unavailable'};
    const result = aggregateRuntimeReadiness(evidence);
    assert.equal(result.execution_ready, false, `${status} must not be promoted`);
    assert.equal(result.components.find(item => item.component === 'native').status, status);
  }
});

test('missing or duplicated observations fail closed and invalid details are bounded', () => {
  const missing = ready().filter(item => item.component !== 'driver');
  assert.equal(aggregateRuntimeReadiness(missing).execution_ready, false);
  const duplicate = [...ready(), {component:'db',status:'ready',required:true}];
  const duplicateResult = aggregateRuntimeReadiness(duplicate);
  assert.equal(duplicateResult.execution_ready, false);
  assert.equal(duplicateResult.components.find(item => item.component === 'db').status, 'unknown');
  const invalid = ready();
  invalid[0] = {component:'db',status:'ready',required:true,reason:'Bearer secret-token'};
  const invalidResult = aggregateRuntimeReadiness(invalid);
  assert.equal(invalidResult.execution_ready, false);
  assert.doesNotMatch(JSON.stringify(invalidResult), /secret-token|Bearer/);
});

test('explicitly optional disabled dependencies are reported without blocking required core readiness', () => {
  const evidence = ready();
  evidence[components.indexOf('consumer')] = {component:'consumer',status:'disabled',required:false,reason:'feature_disabled'};
  const result = aggregateRuntimeReadiness(evidence);
  assert.equal(result.execution_ready, true);
  assert.equal(result.components.find(item => item.component === 'consumer').status, 'disabled');
});

const statusComponents=components.slice(2);
const observationTime=new Date('2026-10-21T04:00:00.000Z');
const currentPorts=(overrides={})=>Object.fromEntries(statusComponents.map(component=>[
  component,overrides[component]??(async()=>({status:'ready',required:true,observed_at:observationTime.toISOString()})),
]));
async function collect(db,ports,options={}){
  const {collectRuntimeReadinessObservations}=await import('../../src/events/runtime-readiness-observations.ts');
  assert.equal(typeof collectRuntimeReadinessObservations,'function');
  return collectRuntimeReadinessObservations(db,ports,{now:()=>observationTime,...options});
}

test('read-only collector requires current database, schema, and every required status-port fact',async()=>{
  const db=openProductDatabase(':memory:');
  try{
    const calls=[];
    const ports=currentPorts(Object.fromEntries(statusComponents.map(component=>[
      component,async signal=>{signal.throwIfAborted();calls.push(component);return{status:'ready',required:true,observed_at:observationTime.toISOString()};},
    ])));
    const changesBefore=db.prepare('SELECT total_changes() AS n').get().n;
    const result=await collect(db,ports);
    assert.equal(result.execution_ready,true);
    assert.deepEqual(result.components.map(item=>item.component),components);
    assert.deepEqual(calls,statusComponents);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n,changesBefore);
    assert.equal(db.isTransaction,false);
  }finally{db.close();}
});

test('missing, stale, and not-started ports stay unknown while source exceptions are redacted failures',async()=>{
  const db=openProductDatabase(':memory:');
  try{
    const ports=currentPorts({
      host:async()=>({status:'ready',required:true,observed_at:'2026-10-21T02:00:00.000Z'}),
      native:async()=>({status:'not_started',required:true}),
      policy:async()=>{throw Error('private path C:\\vault\\policy.key');},
      driver:async()=>({status:'ready',required:true,observed_at:observationTime.toISOString(),reason:'Bearer private-driver-token'}),
    });
    delete ports.storage;
    const result=await collect(db,ports);
    assert.equal(result.execution_ready,false);
    assert.deepEqual(
      ['host','native','storage','policy','driver'].map(component=>{
        const item=result.components.find(value=>value.component===component);return[item.status,item.reason];
      }),
      [['unknown','observation_stale'],['unknown','source_not_started'],['unknown','source_missing'],['failed','source_failed'],['unknown','source_invalid']],
    );
    assert.doesNotMatch(JSON.stringify(result),/vault|policy\.key|private path|Bearer|driver-token/);
  }finally{db.close();}
});

test('a fresh explicitly optional disabled source remains disabled without blocking required evidence',async()=>{
  const db=openProductDatabase(':memory:');
  try{
    const ports=currentPorts({consumer:async()=>({status:'disabled',required:false,observed_at:observationTime.toISOString(),reason:'consumer_disabled'})});
    const result=await collect(db,ports);
    assert.equal(result.execution_ready,true);
    assert.deepEqual(
      [result.components.find(item=>item.component==='consumer').status,result.components.find(item=>item.component==='consumer').required],
      ['disabled',false],
    );
  }finally{db.close();}
});

test('schema mismatches fail closed and cancellation prevents further status reads',async()=>{
  const db=openProductDatabase(':memory:');
  try{
    db.exec('DROP TABLE ga_events');
    const schemaResult=await collect(db,currentPorts());
    assert.equal(schemaResult.components.find(item=>item.component==='db').status,'ready');
    assert.deepEqual(
      [schemaResult.components.find(item=>item.component==='schema').status,schemaResult.components.find(item=>item.component==='schema').reason],
      ['failed','schema_incompatible'],
    );

    const controller=new AbortController(),calls=[];
    const ports=currentPorts(Object.fromEntries(statusComponents.map(component=>[
      component,async()=>{calls.push(component);if(component==='host')controller.abort();return{status:'ready',required:true,observed_at:observationTime.toISOString()};},
    ])));
    const cancelled=await collect(db,ports,{signal:controller.signal});
    assert.equal(cancelled.execution_ready,false);
    assert.equal(cancelled.components.find(item=>item.component==='host').reason,'observation_cancelled');
    assert.equal(cancelled.components.find(item=>item.component==='native').reason,'observation_cancelled');
    assert.deepEqual(calls,['host']);
  }finally{db.close();}
});

test('pre-cancelled collection invokes no external status source',async()=>{
  const db=openProductDatabase(':memory:');
  try{
    const controller=new AbortController();controller.abort();
    let calls=0;
    const ports=currentPorts(Object.fromEntries(statusComponents.map(component=>[component,async()=>{calls++;return{status:'ready',required:true,observed_at:observationTime.toISOString()};}])));
    const result=await collect(db,ports,{signal:controller.signal});
    assert.equal(result.execution_ready,false);
    assert.equal(calls,0);
    assert.ok(result.components.every(item=>item.status==='unknown'&&item.reason==='observation_cancelled'));
  }finally{db.close();}
});

test('an existing transaction makes database and schema evidence unknown without changing it',async()=>{
  const db=openProductDatabase(':memory:');
  try{
    db.exec('BEGIN DEFERRED');
    const result=await collect(db,currentPorts());
    assert.equal(result.execution_ready,false);
    assert.deepEqual(
      ['db','schema'].map(component=>{const item=result.components.find(value=>value.component===component);return[item.status,item.reason];}),
      [['unknown','database_transaction_open'],['unknown','schema_unavailable']],
    );
    assert.equal(db.isTransaction,true);
  }finally{
    if(db.isTransaction)db.exec('ROLLBACK');
    db.close();
  }
});

test('process health or an execution config flag cannot stand in for component facts',async()=>{
  const db=openProductDatabase(':memory:');
  try{
    let healthCalls=0;
    const result=await collect(db,{healthz:async()=>{healthCalls++;return{status:'ready',required:true,observed_at:observationTime.toISOString()};},executionReady:true});
    assert.equal(result.execution_ready,false);
    assert.equal(healthCalls,0);
    assert.equal(result.components.find(item=>item.component==='host').reason,'source_missing');
  }finally{db.close();}
});
