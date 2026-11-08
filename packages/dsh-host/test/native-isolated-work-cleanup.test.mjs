import assert from 'node:assert/strict';
import test from 'node:test';

test('fixture cleanup remains available when setup throws before handles exist', async () => {
 const cleanupModule=await import('./native-isolated-work-cleanup.mjs').catch(()=>null);
 assert.ok(cleanupModule,'module-scoped fixture cleanup must be available before setup begins');
 assert.equal(typeof cleanupModule.createNativeIsolatedWorkCleanup,'function');

 const events=[];let modelClosed=false;
 const cleanup=cleanupModule.createNativeIsolatedWorkCleanup({
  workerProcesses:[],host:null,service:null,succeeded:false,cleanupOnlyResult:null,root:'unused',
  releaseBusyProbe:{resolve(){events.push('busy-released');}},
  releaseAcceptedModel:{resolve(){events.push('accepted-model-released');}},
  model:{listening:true,closeAllConnections(){},close(callback){modelClosed=true;this.listening=false;callback?.();}},
  cleanupTrace:event=>events.push(event),
 });

 await assert.rejects(async()=>{
  try{throw new Error('injected_early_setup_failure');}
  finally{await cleanup.run();}
 },/injected_early_setup_failure/);

 const markers=events.filter(event=>event&&typeof event==='object');
 assert.ok(events.includes('busy-released'));
 assert.ok(events.includes('accepted-model-released'));
 assert.ok(markers.some(event=>event.m08_08_cleanup_step==='released_fixture_gates'));
 assert.ok(markers.some(event=>event.m08_08_cleanup_step==='before_stopWorkers'));
 assert.ok(markers.some(event=>event.m08_08_stop_workers_enter?.handle_count===0));
 assert.ok(markers.some(event=>event.m08_08_cleanup_step==='official_host_stopped'));
 assert.ok(markers.some(event=>event.m08_08_cleanup_resolved?.step==='model.close'));
 assert.equal(modelClosed,true);
});
