import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServer } from '../../src/server.ts';
import { OwnerChannelBindings } from '../../src/channels/owner-bindings.ts';
import { ChannelIntakeService } from '../../src/channels/intake.ts';
import { HarnessCoordinator } from '../../src/harness/coordinator.ts';
import { HarnessWorker } from '../../src/harness/worker.ts';

const principal='sms:' + ('AC' + '0'.repeat(30) + '01') + ':+14155550123';
const threadId='+14155550999';

test('Harness queues the final reply to the SMS thread that admitted this run',async t=>{
  const service=await buildServer({databasePath:':memory:',workspaces:['sms-worker-workspace'],
    uploadRoot:'test-tmp/sms-worker-files',workbenchRoot:'test-tmp/sms-worker-workbench'});
  t.after(async()=>{await service.app.close();service.db.close();});
  const bindings=new OwnerChannelBindings(service.db,{enabled:['sms']});
  const challenge=bindings.create('alice','sms','sms-worker-binding');
  bindings.acceptProof('sms',principal,challenge.code);
  const intake=new ChannelIntakeService(service.db,service.runs,'sms-worker-workspace',bindings);
  const inbound=intake.accept({channel:'sms',principal,thread_id:threadId,
    message_id:'SM0123456789abcdef0123456789abcdef',text:'hello'});
  const deliveries=[];
  const worker=new HarnessWorker(service.db,new HarnessCoordinator(service.db,service.runs,service.events),{
    async run(){return{observed:true,completed:false,reason_code:'DSH_CHAT_ANSWER',runtime_status:'not_required',final_text:'reply'};},
  },{workerId:'sms-worker-fixture',leaseMs:30_000,channelDelivery:{enqueueText:input=>deliveries.push(input)}});

  assert.equal((await worker.processNext()).run_id,inbound.run_id);
  assert.equal(deliveries.length,1);
  assert.deepEqual(deliveries[0],{runId:inbound.run_id,messageId:deliveries[0].messageId,
    destination:'sms',recipient:principal,text:'reply'});
  assert.match(deliveries[0].messageId,/^msg-/);
});
