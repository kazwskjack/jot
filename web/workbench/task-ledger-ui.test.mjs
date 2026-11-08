import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTaskSubtaskInput,taskLedgerError,taskSubtaskCounts,taskSubtaskFailure} from './task-ledger-ui.mjs';

const row=(subtask_id,status,extra={})=>({subtask_id,status,...extra});

test('ledger counts reflect each persisted status and keep unknown states visible',()=>{
 const counts=taskSubtaskCounts([
  row('a','pending'),row('b','running'),row('c','blocked'),row('d','completed'),
  row('e','failed'),row('f','cancelled'),row('g','future_state'),
 ]);
 assert.deepEqual(counts,{total:7,pending:1,running:1,blocked:1,completed:1,failed:1,cancelled:1,other:1});
 assert.equal(taskSubtaskCounts([]).total,0);
});

test('new ledger input is normalized without inventing evidence or a server ID',()=>{
 const input=buildTaskSubtaskInput(null,{title:'  Collect sources  ',acceptance:'  Cite each source  ',priority:'70',status:'pending',dependencies:['sub-a','sub-b','sub-a']});
 assert.deepEqual(input,{title:'Collect sources',acceptance:'Cite each source',priority:70,status:'pending',dependencies:['sub-a','sub-b']});
 assert.equal('subtask_id' in input,false);assert.equal('expected_version' in input,false);assert.equal('evidence' in input,false);
});

test('edits bind to the displayed row version and refuse self-dependency or unsupported completion claims',()=>{
 const existing={subtask_id:'sub-a',version:4,evidence:[]};
 assert.deepEqual(buildTaskSubtaskInput(existing,{title:'Review',acceptance:'Review evidence',priority:50,status:'blocked',dependencies:['sub-b']}),
  {subtask_id:'sub-a',expected_version:4,title:'Review',acceptance:'Review evidence',priority:50,status:'blocked',dependencies:['sub-b']});
 assert.throws(()=>buildTaskSubtaskInput(existing,{title:'Review',acceptance:'Review evidence',priority:50,status:'pending',dependencies:['sub-a']}),/不能依赖自身/);
 assert.throws(()=>buildTaskSubtaskInput(existing,{title:'Review',acceptance:'Review evidence',priority:50,status:'completed',dependencies:[]}),/evidence_required/);
});

test('invalid labels, priority and status cannot be sent to the Gateway',()=>{
 const valid={title:'A',acceptance:'B',priority:50,status:'pending',dependencies:[]};
 for(const draft of [{...valid,title:'  '},{...valid,acceptance:''},{...valid,priority:101},{...valid,priority:'1.5'},{...valid,status:'unknown'},{...valid,status:'running'},{...valid,status:'completed'},{...valid,dependencies:['']}])
  assert.throws(()=>buildTaskSubtaskInput(null,draft));
});

test('Gateway ledger errors explain stale writes, missing evidence and dependency validation',()=>{
 assert.match(taskLedgerError(new Error('VERSION_CONFLICT')),/核对最新账本/);
 assert.match(taskLedgerError(new Error('evidence_required')),/执行证据/);
 assert.match(taskLedgerError(new Error('dependency_evidence_unverified')),/已核验/);
 assert.match(taskLedgerError(new Error('invalid_acceptance')),/验收条件/);
});

test('local validation failures stay known while submitted unknown writes require reconciliation',()=>{
 assert.deepEqual(taskSubtaskFailure(new Error('invalid_acceptance'),false),{message:'请填写不超过 2000 个字符的验收条件。',uncertain:false,refresh:false});
 assert.deepEqual(taskSubtaskFailure({message:'VERSION_CONFLICT',status:409},true),{message:'子任务已被更新；请核对最新账本后再保存。',uncertain:false,refresh:true});
 assert.deepEqual(taskSubtaskFailure(new Error('network timeout'),true),{message:'保存结果尚未确认。账本已刷新，请先核对列表，避免重复提交。',uncertain:true,refresh:true});
});
