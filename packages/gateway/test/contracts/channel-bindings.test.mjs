import test from 'node:test';import assert from 'node:assert/strict';import {ContractValidator} from '../../src/contracts/validator.ts';
test('binding contracts reject principal and owner input and keep verification codes transient',()=>{
 const v=new ContractValidator(),create=v.operationFor('POST','/v1/channel-bindings');assert.ok(create);
 assert.equal(v.validateRequest(create,{channel:'wecom'}).valid,true);
 for(const input of [{channel:'wecom',principal:'victim'},{channel:'wecom',owner_id:'bob'},{channel:'smtp'}])assert.equal(v.validateRequest(create,input).valid,false);
 const receipt={channel_binding_id:'b',channel:'wecom',status:'pending',version:1,expires_at:'2026-10-03T00:10:00Z',requires_new_code:false,code:'a'.repeat(43)};
 assert.equal(v.validateResponse(create,201,receipt).valid,true);assert.equal(v.validateResponse(create,201,{...receipt,code:undefined,requires_new_code:true}).valid,true);
 assert.equal(v.validateResponse(create,201,{...receipt,code_hash:'private'}).valid,false);
 const list=v.operationFor('GET','/v1/channel-bindings');assert.ok(list);assert.equal(v.validateResponse(list,200,{items:[]}).valid,true);
 const revoke=v.operationFor('POST','/v1/channel-bindings/{binding_id}/revoke');assert.ok(revoke);assert.equal(v.validateRequest(revoke,{expected_version:1}).valid,true);assert.equal(v.validateRequest(revoke,{expected_version:1,principal:'other'}).valid,false);
});
test('task notification policy contracts preserve bounds and do not accept notification recipients',()=>{
 const v=new ContractValidator(),operation=v.operationFor('PATCH','/v1/persistent-tasks/{task_id}/notifications');
 const request={expected_version:0,channel_binding_ids:[],delivery_policy:{min_interval_seconds:60,max_per_24_hours:20,quiet_hours:{start:'22:00',end:'08:00',timezone:'UTC'}}};
 assert.equal(v.validateRequest(operation,request).valid,true);
 for(const input of [{...request,recipient:'foreign'},{...request,delivery_policy:{...request.delivery_policy,max_per_24_hours:101}},{...request,delivery_policy:{...request.delivery_policy,quiet_hours:{start:'25:00',end:'08:00',timezone:'UTC'}}}])assert.equal(v.validateRequest(operation,input).valid,false);
});
test('notification event contracts accept the four host-backed conditions and reject duplicates or arbitrary event names',()=>{
 const v=new ContractValidator(),operation=v.operationFor('PATCH','/v1/persistent-tasks/{task_id}/notifications');
 const input={expected_version:1,channel_binding_ids:[],events:['changed','completed','failed','needs_confirmation']};
 assert.equal(v.validateRequest(operation,input).valid,true);assert.equal(v.validateRequest(operation,{...input,events:[]}).valid,true);
 for(const events of [['unknown'],['failed','failed']])assert.equal(v.validateRequest(operation,{...input,events}).valid,false);
});
test('task-level delivery history has a public paginated contract without sender credentials',()=>{
 const v=new ContractValidator(),operation=v.operationFor('GET','/v1/persistent-tasks/{task_id}/deliveries');assert.ok(operation);
 const item={delivery_id:'delivery-host-a',channel:'wecom',status:'pending',reason:null,digest_size:1,source:'monitor',occurrence_id:null,created_at:'2026-10-03T10:00:00Z',updated_at:'2026-10-03T10:00:00Z'};
 assert.equal(v.validateResponse(operation,200,{items:[item],has_more:false,next_cursor:null}).valid,true);
 for(const extra of [{principal:'recipient'},{provider_receipt_json:'secret'},{payload_json:'private'}])assert.equal(v.validateResponse(operation,200,{items:[{...item,...extra}],has_more:false,next_cursor:null}).valid,false);
});
