import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import * as checkpoints from '../checkpoint.js';
const json=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function fixture(){
 const header={id:'source-session',agentPreset:'synthetic',cwd:'/example/workspace'},events=[{seq:0,type:'turn/start',data:{}},{seq:1,type:'turn/end',data:{}}];
 const sha=createHash('sha256').update(json({...header,delegationDepth:0})+'\n');for(const event of events)sha.update(json(event)+'\n');
 const receipt={session_ref:'source-session',seq_exclusive:2,turn_end_seq:1,goal_id:'original-goal',goal_revision:3,log_sha256:sha.digest('hex')};
 let opened=0,closed=0;
 const persistence={async open(id,access){
  opened++;assert.equal(id,receipt.session_ref);assert.equal(access,'read');
  return{id,access,header:structuredClone(header),async read(offset,size){return{events:events.slice(offset,offset+size)}},async close(){closed++;}};
 }};
 return{header,events,receipt,persistence,get opened(){return opened},get closed(){return closed}};
}
test('held checkpoint verifies the original canonical prefix without waiting for Agent idle or altering later history',async()=>{
 assert.equal(typeof checkpoints.verifyHeldSessionCheckpoint,'function');const f=fixture();f.events.push({seq:2,type:'later/event',data:{}});let checks=0;
 await checkpoints.verifyHeldSessionCheckpoint({persistence:f.persistence,header:f.header,checkpoint:f.receipt,assertCurrent(){checks++}});
 assert.equal(f.opened,1);assert.equal(f.closed,1);assert.ok(checks>=4);assert.equal(f.events.length,3);
});
test('held checkpoint refuses a recreated same-name history, changed header or non-turn boundary and closes each reader',async()=>{
 assert.equal(typeof checkpoints.verifyHeldSessionCheckpoint,'function');
 for(const mutate of [f=>{f.events[0].data={different:true}},f=>{f.header.cwd='/example/other'},f=>{f.events[1].type='not-turn-end'}]){
  const f=fixture(),header=structuredClone(f.header);mutate(f);
  await assert.rejects(checkpoints.verifyHeldSessionCheckpoint({persistence:f.persistence,header,checkpoint:f.receipt,assertCurrent(){}}),/checkpoint_storage_conflict|checkpoint_boundary_invalid/);assert.equal(f.closed,1);
 }
});
test('held checkpoint freezes the original receipt before await and rejects expired or asynchronous custody',async()=>{
 assert.equal(typeof checkpoints.verifyHeldSessionCheckpoint,'function');const f=fixture(),receipt={...f.receipt},open=f.persistence.open.bind(f.persistence);
 f.persistence.open=async(...args)=>{receipt.log_sha256='0'.repeat(64);return open(...args)};
 await checkpoints.verifyHeldSessionCheckpoint({persistence:f.persistence,header:f.header,checkpoint:receipt,assertCurrent(){}});assert.equal(f.closed,1);
 for(const guard of [()=>{throw Error('original_custody_revoked')},async()=>{}]){
  const f=fixture();await assert.rejects(checkpoints.verifyHeldSessionCheckpoint({persistence:f.persistence,header:f.header,checkpoint:f.receipt,assertCurrent:guard}),/original_custody_revoked|checkpoint_custody_invalid/);assert.equal(f.opened,0);
 }
});
