import test from 'node:test';import assert from 'node:assert/strict';
const implementation=await import('./run-cancel.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return{};throw e;});
test('unknown cancellation freezes original target, version, body and key across current run changes',async()=>{
 assert.equal(typeof implementation.RunCancelWriter,'function');const calls=[];let lost=true;
 const writer=new implementation.RunCancelWriter(async(path,method,body,key)=>{calls.push(structuredClone({path,method,body,key}));if(lost){lost=false;throw Error('lost');}return{accepted:true,command_id:'cmd-original',run_id:'run-original'};},()=>{},()=> 'original-cancel-key');
 await assert.rejects(()=>writer.cancel({run_id:'run-original',version:3,status:'running'}),/lost/);assert.equal(writer.pending,true);assert.throws(()=>writer.cancel({run_id:'run-other',version:9}),/原停止/);
 await writer.retry();assert.deepEqual(calls[1],calls[0]);assert.equal(calls[0].path,'/runs/run-original/cancel');assert.deepEqual(calls[0].body,{expected_run_version:3});assert.equal(writer.pending,false);
});
test('malformed successful cancellations remain unknown and known conflict clears only the original receipt',async()=>{
 assert.equal(typeof implementation.RunCancelWriter,'function');let reply={accepted:true,command_id:'cmd-wrong',run_id:'other'};
 const writer=new implementation.RunCancelWriter(async()=>{if(reply instanceof Error)throw reply;return reply;});
 await assert.rejects(()=>writer.cancel({run_id:'run-original',version:1,status:'queued'}),/停止结果尚未确认/);assert.equal(writer.pending,true);
 reply=Object.assign(Error('IDEMPOTENCY_IN_PROGRESS'),{status:409});await assert.rejects(()=>writer.retry());assert.equal(writer.pending,true);
 reply=Object.assign(Error('RUN_VERSION_CONFLICT'),{status:409});await assert.rejects(()=>writer.retry());assert.equal(writer.pending,false);
});
