import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';

const output=new URL('../../.test-tmp/task-ledger-api-tests/',import.meta.url);
await mkdir(output,{recursive:true});
await build({entryPoints:[new URL('./client.ts',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')],bundle:true,platform:'node',format:'esm',outfile:new URL('client.mjs',output).pathname.replace(/^\/([A-Z]:)/,'$1')});
const {workbenchApi}=await import(new URL('client.mjs',output));

test('subtask management writes to the original persistent task route with the current CAS payload',async t=>{
 const original=globalThis.fetch,calls=[];t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({subtask_id:'sub-1',task_id:'task /1',title:'Review',acceptance:'Cite sources',status:'pending',priority:50,dependencies:[],evidence:[],version:2,created_at:'now',updated_at:'now'}),{headers:{'content-type':'application/json'}});};
 const input={title:'Review',acceptance:'Cite sources',priority:50,status:'pending',dependencies:[]};
 const result=await workbenchApi.upsertSubtask('task /1',input);
 assert.equal(result.subtask_id,'sub-1');assert.equal(calls[0].url,'/workbench-api/v1/persistent-tasks/task%20%2F1/subtasks');
 assert.equal(calls[0].init.method,'POST');assert.deepEqual(JSON.parse(calls[0].init.body),input);
 assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.cache,'no-store');
});
