import test from 'node:test';
import assert from 'node:assert/strict';
import {findOwnedTask,findOwnedOccurrence} from './desktop-open-task.mjs';

const identity={task_id:'task-owned',occurrence_id:'occurrence-owned'};
const task={task_id:'task-owned',title:'Owned task'};
const occurrence={task_id:'task-owned',occurrence_id:'occurrence-owned'};

test('desktop navigation resolves only a task present in the owned task list',()=>{
 assert.equal(findOwnedTask([task],identity),task);
 assert.equal(findOwnedTask([{task_id:'task-other'}],identity),null);
});

test('desktop navigation resolves an occurrence only within its exact task',()=>{
 assert.equal(findOwnedOccurrence([occurrence],identity),occurrence);
 assert.equal(findOwnedOccurrence([{task_id:'task-other',occurrence_id:identity.occurrence_id}],identity),null);
 assert.equal(findOwnedOccurrence([{task_id:identity.task_id,occurrence_id:'occurrence-other'}],identity),null);
});

test('desktop navigation ignores malformed or missing identity data',()=>{
 assert.equal(findOwnedTask([task],{task_id:'',occurrence_id:identity.occurrence_id}),null);
 assert.equal(findOwnedOccurrence([occurrence],{task_id:identity.task_id,occurrence_id:null}),null);
 assert.equal(findOwnedTask(null,identity),null);
 assert.equal(findOwnedOccurrence(null,identity),null);
});
