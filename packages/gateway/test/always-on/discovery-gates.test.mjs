import test from 'node:test';
import assert from 'node:assert/strict';
const evaluate=(await import('../../src/always-on/discovery-gates.ts').catch(()=>({}))).evaluateDiscoveryGates;
const scope={owner_id:'owner',project_id:'project',workspace_id:'workspace',agent_id:'role'};
function fixture(){return{
 policy:{protocol:1,enabled:true,scope:{...scope},revision:2,role_version:3,role_epoch:4,cooldown_ms:500,recent_input_ms:500},
 observation:{protocol:1,scope:{...scope},policy_revision:2,role_version:3,role_epoch:4,observed_at:9990,
  project_present:true,workspace_ready:true,role_active:true,host_ready:true,native_idle:'idle',run_busy:false,
  last_user_input_at:1000,last_completed_at:1000,budget:'allowed',background_slots:1,
  dormant_at_revision:null,signal_revision:5,cycle_slots:null,reservation:'available'},
 clock:{now:10000,max_age_ms:1000},
};}
const check=(f)=>evaluate(f.policy,f.observation,f.clock);
test('discovery gate is implemented as non-authorizing frozen advice',()=>{
 assert.equal(typeof evaluate,'function');const f=fixture(),before=JSON.stringify(f),result=check(f);
 assert.deepEqual(result,{protocol:1,eligible:true,reason:null,execution_authorized:false});
 assert.equal(Object.isFrozen(result),true);assert.equal(JSON.stringify(f),before);
});
for(const [field,value,reason] of [
 ['project_present',false,'PROJECT_MISSING'],['workspace_ready',false,'WORKSPACE_UNAVAILABLE'],
 ['role_active',false,'ROLE_UNAVAILABLE'],['host_ready',false,'HOST_UNAVAILABLE'],
 ['native_idle','unknown','NATIVE_IDLE_UNCONFIRMED'],['native_idle','busy','AGENT_BUSY'],['run_busy',true,'AGENT_BUSY'],
 ['last_user_input_at',9900,'RECENT_USER_INPUT'],['last_completed_at',9900,'COOLDOWN'],
 ['budget','unknown','BUDGET_UNCONFIRMED'],['budget','blocked','BUDGET_BLOCKED'],
 ['background_slots',0,'BACKGROUND_CAPACITY'],['dormant_at_revision',5,'DORMANT_NO_SIGNAL'],
 ['cycle_slots',0,'CYCLE_FULL'],['reservation','held','RESERVATION_HELD'],['reservation','unknown','RESERVATION_UNCONFIRMED'],
])test('discovery gate blocks '+reason+' ('+field+'='+value+')',()=>{
 const f=fixture();f.observation[field]=value;assert.equal(check(f).eligible,false);assert.equal(check(f).reason,reason);assert.equal(check(f).execution_authorized,false);
});
test('policy off takes precedence and no channel presence grants idle or execution authority',()=>{
 const f=fixture();f.policy.enabled=false;f.observation.run_busy=true;assert.equal(check(f).reason,'POLICY_DISABLED');
 f.policy.enabled=true;f.observation.run_busy=false;f.observation.native_idle='unknown';assert.equal(check(f).reason,'NATIVE_IDLE_UNCONFIRMED');
});
test('a new relevant signal can clear dormancy advice, not user disablement',()=>{
 const f=fixture();f.observation.dormant_at_revision=4;assert.equal(check(f).eligible,true);
 f.policy.enabled=false;assert.equal(check(f).reason,'POLICY_DISABLED');
});
test('existing unlimited cycle budget and cooldown boundary remain eligible',()=>{
 const f=fixture();f.observation.last_completed_at=9500;f.observation.last_user_input_at=9500;f.observation.cycle_slots=null;
 assert.equal(check(f).eligible,true);f.observation.cycle_slots=1;assert.equal(check(f).eligible,true);
});
for(const field of ['owner_id','project_id','workspace_id','agent_id'])test('observation cannot retarget '+field,()=>{
 const f=fixture();f.observation.scope[field]='foreign';assert.equal(check(f).reason,'SCOPE_CHANGED');
});
for(const field of ['policy_revision','role_version','role_epoch'])test('observation cannot reuse changed '+field,()=>{
 const f=fixture();f.observation[field]++;assert.equal(check(f).reason,'AUTHORITY_CHANGED');
});
test('stale or future observation cannot certify current readiness',()=>{
 const f=fixture();f.observation.observed_at=8999;assert.equal(check(f).reason,'OBSERVATION_STALE');
 f.observation.observed_at=10001;assert.equal(check(f).reason,'OBSERVATION_STALE');
});
test('malformed, missing, unknown-version or invalid numeric facts stay unconfirmed',()=>{
 for(const mutate of [f=>f.policy=null,f=>f.observation=null,f=>f.policy.protocol=2,f=>f.observation.protocol=2,
  f=>delete f.observation.native_idle,f=>f.observation.background_slots=NaN,f=>f.clock.now=Infinity,
  f=>f.observation.signal_revision=-1,f=>f.observation.last_completed_at=10001,f=>f.policy.cooldown_ms=-1,
  f=>f.observation.scope.owner_id='',f=>f.observation.budget='permission granted',f=>f.observation.native_idle={toString:()=> 'idle'},
  f=>f.observation.extra_authority=true,f=>f.policy.scope={...scope,foreign:true},f=>f.observation.dormant_at_revision=6]){
  const f=fixture();mutate(f);assert.deepEqual(check(f),{protocol:1,eligible:false,reason:'SNAPSHOT_INVALID',execution_authorized:false});
 }
});

test('nullable timestamps and cycle capacity are explicit facts, not missing-field defaults',()=>{
 const f=fixture();f.observation.last_user_input_at=null;f.observation.last_completed_at=null;assert.equal(check(f).eligible,true);
 delete f.observation.cycle_slots;assert.equal(check(f).reason,'SNAPSHOT_INVALID');
});
