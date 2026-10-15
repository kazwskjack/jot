import test from 'node:test';
import assert from 'node:assert/strict';
import {ContractValidator} from '../../src/contracts/validator.ts';

test('memory restore contract requires only exact positive source and current versions',()=>{
 const validator=new ContractValidator(),op=validator.operationFor('POST','/v1/workspaces/{workspace_id}/memory/{memory_id}/restore');assert.ok(op);
 assert.equal(validator.validateRequest(op,{expected_version:3,source_version:1}).valid,true);
 for(const input of [{expected_version:3,source_version:0},{expected_version:0,source_version:1},{expected_version:3,source_version:1,owner_id:'other'},{expected_version:3,source_version:1,run_id:'forged'},{expected_version:3,source_version:'1'},{source_version:1}])assert.equal(validator.validateRequest(op,input).valid,false);
});

test('memory history contract carries restore provenance without owner or execution authority',()=>{
 const validator=new ContractValidator(),op=validator.operationFor('GET','/v1/workspaces/{workspace_id}/memory/{memory_id}/history');assert.ok(op);
 const value={memory_id:'memory-example',current_version:3,next_before_version:null,items:[{version:3,content:'Original source',verified:false,provenance:[],source_revision:null,expires_at:null,supersedes:null,verified_at:null,status:'active',created_at:'2026-10-15T00:00:00Z',updated_at:'2026-10-15T00:00:00Z',restored_from_version:1,restored_over_version:2}]};
 assert.equal(validator.validateResponse(op,200,value).valid,true);
 for(const changed of [{...value,owner_id:'other'},{...value,items:[{...value.items[0],owner_id:'other'}]},{...value,items:[{...value.items[0],restored_from_version:0}]}])assert.equal(validator.validateResponse(op,200,changed).valid,false);
 assert.equal(validator.validateResponse(op,200,{...value,items:Array.from({length:51},()=>value.items[0])}).valid,false);
});

test('history and restore declare validation errors',()=>{
 const validator=new ContractValidator();
 for(const [method,suffix] of [['GET','history'],['POST','restore']]){
  const op=validator.operationFor(method,'/v1/workspaces/{workspace_id}/memory/{memory_id}/'+suffix);
  assert.equal(validator.validateResponse(op,422,{error:{code:'invalid_request',message:'Invalid revision',retryable:false},request_id:'request-example'}).valid,true);
 }
});
