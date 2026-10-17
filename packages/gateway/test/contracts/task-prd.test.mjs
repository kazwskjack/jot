import test from 'node:test';
import assert from 'node:assert/strict';
import {ContractValidator} from '../../src/contracts/validator.ts';

test('original task PRD routes have synchronized public request and response contracts',()=>{
 const validator=new ContractValidator();
 assert.deepEqual(validator.compilationErrors,[]);
 for(const [method,action,id] of [['GET','sources','listTaskPrdSources'],['POST','preview','previewTaskPrd'],['POST','bind','bindTaskPrd']])
  assert.equal(validator.operationFor(method,`/v1/persistent-tasks/:taskId/prd/${action}`),id);
 const source={kind:'logical_file',path:'requirements.md',version:1,sha256:'a'.repeat(64)};
 assert.equal(validator.validateRequest('previewTaskPrd',{source}).valid,true);
 assert.equal(validator.validateRequest('bindTaskPrd',{source,preview_sha256:'b'.repeat(64)}).valid,true);
 for(const input of [{source:{...source,owner_id:'foreign'}},{source:{...source,root:'/untrusted'}},{source:{...source,version:0}},{source:{...source,sha256:'bad'}},{source,execute:true}])
  assert.equal(validator.validateRequest('previewTaskPrd',input).valid,false);
 assert.equal(validator.validateRequest('bindTaskPrd',{source}).valid,false);
 const preview={task_id:'task-fixture',task_version:1,role:{agent_id:'role-fixture',version:1,capability_epoch:1},source:{...source,name:'requirements.md',size:5},content:'Goals',objective:'Goals',preview_sha256:'b'.repeat(64),execution_authorized:false};
 assert.equal(validator.validateResponse('previewTaskPrd',200,preview).valid,true);
 assert.equal(validator.validateResponse('previewTaskPrd',200,{...preview,execution_authorized:true}).valid,false);
 assert.equal(validator.validateResponse('previewTaskPrd',200,{...preview,source:{...preview.source,server_path:'/private'}}).valid,false);
});
