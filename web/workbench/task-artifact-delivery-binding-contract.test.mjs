import test from 'node:test';
import assert from 'node:assert/strict';
import {taskArtifactDeliveryAvailability,reconcileTaskArtifactDeliverySelection,updateTaskArtifactDeliverySelection} from './task-artifact-delivery-options.mjs';

const bindings=[
 {channel_binding_id:'wecom-01',channel:'wecom',status:'verified',version:5},
 {channel_binding_id:'email-02',channel:'email',status:'verified',version:3},
 {channel_binding_id:'webpush-03',channel:'webpush',status:'verified',version:2},
 {channel_binding_id:'pending-04',channel:'wecom',status:'pending',version:1},
];
const draft={channel_binding_ids:['wecom-01','email-02','webpush-03','pending-04'],events:['completed']};

test('real ChannelBinding DTO permits only the verified WeCom file target',()=>{
 assert.deepEqual(taskArtifactDeliveryAvailability(bindings[0],draft),{available:true,reason:null});
 assert.deepEqual(taskArtifactDeliveryAvailability(bindings[1],draft),{available:false,reason:'file-unsupported'});
 assert.deepEqual(taskArtifactDeliveryAvailability(bindings[2],draft),{available:false,reason:'file-unsupported'});
 assert.deepEqual(taskArtifactDeliveryAvailability(bindings[3],draft),{available:false,reason:'unverified'});
 assert.deepEqual(taskArtifactDeliveryAvailability(bindings[0],{...draft,events:['failed']}),{available:false,reason:'completed-disabled'});
});

test('reconciliation and selection retain the exact binding version from the DTO',()=>{
 const selected=[
  {channel_binding_id:'wecom-01',binding_version:5},
  {channel_binding_id:'wecom-01',binding_version:4},
  {channel_binding_id:'email-02',binding_version:3},
  {channel_binding_id:'pending-04',binding_version:1},
 ];
 assert.deepEqual(reconcileTaskArtifactDeliverySelection(selected,bindings,draft),[
  {channel_binding_id:'wecom-01',binding_version:5},
 ]);
 assert.deepEqual(updateTaskArtifactDeliverySelection([],bindings,draft,'wecom-01',true),[
  {channel_binding_id:'wecom-01',binding_version:5},
 ]);
 const rebound=bindings.map(binding=>binding.channel_binding_id==='wecom-01'?{...binding,version:6}:binding);
 assert.deepEqual(reconcileTaskArtifactDeliverySelection(selected,rebound,draft),[]);
});
