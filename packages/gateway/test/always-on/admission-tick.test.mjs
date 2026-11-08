import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from './discovery-fixture.mjs';

function deferred(){let resolve;const promise=new Promise(yes=>resolve=yes);return{promise,resolve};}
function within(promise,ms=3000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('admission_tick_timeout')),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});}

async function tickAdmission(f,controller=f.controller()){
 const started=deferred(),finished=deferred();
 f.tasks.collectDiscoverySources();
 const tick=await f.tasks.tick((owner,scope)=>{
  started.resolve({owner,scope});
  return controller.admit(owner,scope).then(value=>{finished.resolve({value});return value;},error=>{finished.resolve({error});throw error;});
 });
 const candidate=await within(started.promise);
 return{tick,candidate,finished:finished.promise};
}

test('without an internal admission hook the original tick leaves discovery closed',async t=>{
 const f=fixture(t);f.file();await f.tasks.tick();
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_occurrences').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});

test('an initial no-signal discovery remains eligible under the existing admission policy',async t=>{
 const f=fixture(t);const result=await tickAdmission(f);
 const admission=(await result.finished).value;assert.equal(admission.admitted,true);
 assert.equal(f.db.prepare('SELECT signal_revision FROM wb_discovery_admissions').get().signal_revision,0);
});

test('the original tick admits only the immutable discovery-bound task and its original run',async t=>{
 const f=fixture(t);f.file();const result=await tickAdmission(f);
 const {value:admission}=await result.finished;assert.equal(admission.admitted,true);
 const binding=f.db.prepare('SELECT * FROM wb_discovery_task_bindings').get();
 const occurrence=f.db.prepare('SELECT * FROM wb_task_occurrences').get();
 const taskRun=f.db.prepare('SELECT * FROM wb_task_run_occurrences WHERE run_id=?').get(occurrence.run_id);
 assert.equal(occurrence.task_id,binding.task_id);assert.equal(taskRun.occurrence_id,occurrence.occurrence_id);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_run_bindings WHERE run_id=? AND owner_id='owner' AND kind='task'").get(occurrence.run_id).n,1);
 assert.equal(f.coordinator.claimNext('original-worker',30000).run_id,occurrence.run_id);
 assert.equal(admission.execution_authorized,false);
});

test('a slow discovery observation cannot hold the existing tick or ordinary due task',async t=>{
 const f=fixture(t);f.file();
 const ordinary=f.tasks.create('owner',{title:'ordinary due',agent_id:f.agent.agent_id,objective:'synthetic scheduled work',trigger:{kind:'once'}});
 f.tasks.collectDiscoverySources();
 const started=deferred(),release=deferred();let attempts=0;
 const tickPromise=f.tasks.tick(()=>{attempts++;started.resolve();return release.promise;});
 const completed=await within(tickPromise.then(()=>true),500).catch(()=>false);
 assert.equal(completed,true,'tick must return while discovery admission is waiting');await within(started.promise);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare('SELECT task_id FROM wb_task_occurrences').get().task_id,ordinary.task_id);
 assert.equal(attempts,1);release.resolve();
});

test('busy native state and cooldown are refused before any original run is queued',async t=>{
 const busy=fixture(t);busy.file();busy.native.observeNativeIdle=async id=>({protocol:1,session_id:id,basis:'live',native_idle:'busy',reason:'AGENT_RUNNING',observed_at:Date.now(),execution_authorized:false});
 const busyResult=await tickAdmission(busy);assert.equal((await busyResult.finished).value.reason,'AGENT_BUSY');
 assert.equal(busy.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);

 const cooling=fixture(t);cooling.file();cooling.policies.save('owner',cooling.scope,{expected_version:2,expected_role_version:1,expected_role_epoch:1,mode:'discover_only',cooldown_ms:60000,recent_input_ms:0,max_cycles:null},'set-cooldown');
 const observedAt=Date.now(),activity={observe:async scope=>({protocol:1,scope:{...scope},facts:{project_version:1,role_version:1,role_epoch:1,workspace_ready:true,role_active:true,run_busy:false,last_user_input_at:null,last_terminal_at:observedAt,native_idle:'idle',host_ready:true,session_count:1},source_sha256:'a'.repeat(64),observed_at:observedAt,reason:null,execution_authorized:false}),isCurrent:()=>true};
 const coolingResult=await tickAdmission(cooling,cooling.controller({activity}));
 assert.equal((await coolingResult.finished).value.reason,'COOLDOWN');assert.equal(cooling.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});

test('repeated ticks over an unchanged signal source never create a second run',async t=>{
 const f=fixture(t);f.file();let observations=0;const observe=f.native.observeNativeIdle;f.native.observeNativeIdle=async(...args)=>{observations++;return observe(...args);};
 const controller=f.controller(),first=await tickAdmission(f,controller);assert.equal((await first.finished).value.admitted,true);assert.equal(observations,1);
 const lease=f.coordinator.claimNext('terminal-worker',30000);assert.ok(lease);f.coordinator.start(lease);f.coordinator.interruptWithoutRuntime(lease,'TEST_INTERRUPTED');
 f.tasks.collectDiscoverySources();let attempts=0;await f.tasks.tick(()=>{attempts++;return Promise.resolve();});assert.equal(attempts,0);
 const replay=await controller.admit('owner',f.scope);assert.equal(replay.admitted,false);assert.equal(replay.execution_authorized,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
});

test('separate original ticks in competing processes admit one source revision exactly once',{timeout:40000},async t=>{
 const f=fixture(t);f.file();const children=[];
 async function start(){
  const child=spawn(process.execPath,[fileURLToPath(new URL('./admission-tick-worker.mjs',import.meta.url)),join(f.root,'db.sqlite'),f.root],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
  children.push(child);const messages=[],done=new Promise(resolve=>child.once('exit',resolve));child.on('message',message=>messages.push(message));
  const deadline=Date.now()+15000;while(!messages.some(message=>message.ready)&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(messages.some(message=>message.ready));return{child,messages,done};
 }
 try{
  const a=await start(),b=await start();a.child.send({go:true});b.child.send({go:true});
  assert.deepEqual(await Promise.all([a.done,b.done]),[0,0]);
  const results=[...a.messages,...b.messages].filter(message=>typeof message.admitted==='boolean');
  assert.equal(results.filter(message=>message.admitted).length,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM wb_discovery_admissions').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 }finally{for(const child of children)if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}}
});

test('policy pause, stop, and role revocation during observation never auto-resume or enqueue',async t=>{
 for(const action of ['pause','stop']){
  const f=fixture(t);f.file();const arrived=deferred(),release=deferred();f.native.observeNativeIdle=async id=>{arrived.resolve();await release.promise;return{protocol:1,session_id:id,basis:'live',native_idle:'idle',reason:null,observed_at:Date.now(),execution_authorized:false};};
  const attempt=await tickAdmission(f);await within(arrived.promise);try{f.policies.control('owner',f.scope,{action,expected_version:2},`${action}-during-observation`);}finally{release.resolve();}
  const result=await attempt.finished;assert.equal(result.value?.admitted,false);assert.equal(f.tasks.list('owner').items[0].status,'paused');assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
  let followup=0;await f.tasks.tick(()=>{followup++;return Promise.resolve();});assert.equal(followup,0);
 }
 {
  const f=fixture(t);f.file();const arrived=deferred(),release=deferred();f.native.observeNativeIdle=async id=>{arrived.resolve();await release.promise;return{protocol:1,session_id:id,basis:'live',native_idle:'idle',reason:null,observed_at:Date.now(),execution_authorized:false};};
  const attempt=await tickAdmission(f);await within(arrived.promise);try{f.db.prepare('UPDATE wb_agents SET capability_epoch=capability_epoch+1 WHERE agent_id=?').run(f.agent.agent_id);}finally{release.resolve();}
  const result=await attempt.finished;assert.equal(result.value?.admitted,false);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
 }
});

test('policy pause cancels the original discovery run and later ticks never auto-resume it',async t=>{
 const f=fixture(t);f.file();const first=await tickAdmission(f);assert.equal((await first.finished).value.admitted,true);
 const occurrence=f.db.prepare('SELECT * FROM wb_task_occurrences').get();
 f.policies.control('owner',f.scope,{action:'pause',expected_version:2},'pause-after-admission');
 const task=f.tasks.list('owner').items[0];assert.equal(task.status,'paused');
 let attempts=0;await f.tasks.tick(()=>{attempts++;return Promise.resolve();});
 assert.equal(attempts,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare('SELECT status FROM wb_task_occurrences WHERE occurrence_id=?').get(occurrence.occurrence_id).status,'cancelled');
});

test('an original OUTCOME_UNKNOWN run fences later discovery signals from replay',async t=>{
 const f=fixture(t);f.file();const first=await tickAdmission(f);assert.equal((await first.finished).value.admitted,true);
 const lease=f.coordinator.claimNext('unknown-worker',30000);assert.ok(lease);f.coordinator.start(lease);f.coordinator.interruptWithoutRuntime(lease,'OUTCOME_UNKNOWN');
 f.workbench.writeFile('owner','ws',{project_id:f.agent.project_id,path:'next.md',content:'next synthetic source',expected_version:0});f.tasks.collectDiscoverySources();let attempts=0;await f.tasks.tick(()=>{attempts++;return Promise.resolve();});
 assert.equal(attempts,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 assert.equal(f.db.prepare("SELECT reason_code FROM ga_runs WHERE id=?").get(lease.run_id).reason_code,'OUTCOME_UNKNOWN');
});
