import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createAdapterHandler} from '../index.js';
const token='t'.repeat(32),cwd=path.resolve(tmpdir(),'isolated-work');
function fixture(change={}){
 let agent,creates=0,attaches=0,guards=0;
 const cached=change.cached?{id:'work-session',header:{cwd:change.cached,agentPreset:change.cachedPreset??'jot-workbench-budgeted'}}:undefined;
 const trusted={kind:'task',model_budget:{protocol:1,enforced:true},work_binding:{kind:'isolated_work',original_run_id:'work-run',occurrence_id:'work-occurrence'},task_binding:{root_run_id:'work-run',occurrence_id:'work-occurrence',continuation_of:null,objective:'Frozen plan'},native_workspace:{protocol:1,cwd},...change.context};
 const bridge={async request(path,binding,payload){guards++;if(change.guardError)throw Error('guard_unavailable');if(path==='goal-binding'){assert.equal(binding.runId,'work-run');assert.equal(binding.sessionRef,'work-session');assert.deepEqual(binding.executionLease,{owner:'worker',generation:1});assert.deepEqual(payload,{action:'get'});if(change.goalBindingError)throw Error('mapping_unavailable');if(change.afterMapping)change.afterMapping(trusted);return Object.hasOwn(change,'goalBindingResponse')?change.goalBindingResponse:{binding:null};}return{context:change.invalidContext?null:trusted};},async attach(){attaches++;},async guardBudget(){}};
 const handler=createAdapterHandler({token,agents:{get:()=>agent},sessions:{get:()=>agent?.session??cached},controller:{
  async inspect(){if(change.inspectFailure)throw change.inspectFailure;if(change.inspectError)throw Error('read_failed');return change.history??null;},
  async create(){creates++;agent={id:'work-session',session:{id:'work-session',header:{cwd:change.createdCwd??cwd,agentPreset:change.createdPreset??'jot-workbench-budgeted'}}};return{sessionId:'work-session'};}
 },workbenchBridge:bridge,budgetModelSelector:async(agent,check)=>check(),sessionNotFoundError:change.sessionNotFoundError});
 const invoke=(extra={})=>handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions'),headers:{authorization:`Bearer ${token}`},body:{session_id:'work-session',cwd,agent_preset:'jot-workbench-budgeted',workbench_context:{run_id:'work-run',execution_lease:{owner:'worker',generation:1},work_workspace:{protocol:1}},...extra}});
 return{invoke,counts:()=>({creates,attaches}),guards:()=>guards};
}
for(const change of [{history:{meta:{id:'work-session',cwd:path.resolve('wrong')},events:[]}},{cached:path.resolve('wrong')},{context:{native_workspace:undefined}},{context:{native_workspace:{protocol:1,cwd:path.resolve('wrong')}}},{context:{work_binding:undefined}},{context:{task_binding:{root_run_id:'planning-run',occurrence_id:'work-occurrence'}}},{inspectError:true}])test('isolated native work rejects unavailable or changed saved location before create',async()=>{
 const f=fixture(change),response=await f.invoke();assert.equal(response.status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
test('isolated work refuses native Controller location substitution before Goal attach',async()=>{
 const f=fixture({createdCwd:path.resolve('wrong')}),response=await f.invoke();assert.equal(response.status,409);assert.deepEqual(f.counts(),{creates:1,attaches:0});
});
for(const history of [null,{meta:{id:'work-session',cwd,agentPreset:'jot-workbench-budgeted'},events:[]}])test('isolated work checks cold native history and actual native header then attaches',async()=>{
 const f=fixture({history}),response=await f.invoke();assert.equal(response.status,201);assert.deepEqual(f.counts(),{creates:1,attaches:1});
});
test('authenticated native work without a work marker refuses activation before Controller create',async()=>{
 const f=fixture(),response=await f.invoke({workbench_context:{run_id:'work-run',execution_lease:{owner:'worker',generation:1}}});
 assert.equal(response.status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
test('ordinary workbench create still uses the original guard and attachment',async()=>{
 const f=fixture({context:{work_binding:undefined,native_workspace:undefined}}),response=await f.invoke({workbench_context:{run_id:'ordinary-run',execution_lease:{owner:'worker',generation:1}}});
 assert.equal(response.status,201);assert.deepEqual(f.counts(),{creates:1,attaches:1});assert.equal(f.guards(),1);
});
for(const change of [{guardError:true},{invalidContext:true}])test('unavailable original guard blocks even an unmarked workbench create before activation',async()=>{
 const f=fixture(change),response=await f.invoke({workbench_context:{run_id:'ordinary-run',execution_lease:{owner:'worker',generation:1}}});
 assert.equal(response.status,503);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
for(const agent_preset of [undefined,'jot-general'])test('isolated work cannot select an ordinary or absent preset to bypass original model accounting',async()=>{
 const f=fixture(),response=await f.invoke({agent_preset});assert.equal(response.status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
for(const model_budget of [undefined,{protocol:1,enforced:false},{protocol:2,enforced:true}])test('isolated work requires its trusted original enforced model budget before native creation',async()=>{
 const f=fixture({context:{model_budget}}),response=await f.invoke();assert.equal(response.status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
for(const change of [{cached:cwd,cachedPreset:'jot-general',history:{meta:{id:'work-session',cwd,agentPreset:'jot-workbench-budgeted'},events:[]}},{history:{meta:{id:'work-session',cwd,agentPreset:'jot-general'},events:[]}}])test('saved ordinary native preset at the correct cwd cannot be reused as isolated work',async()=>{
 const f=fixture(change),response=await f.invoke();assert.equal(response.status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
test('actual native header must preserve the selected budget preset before Goal attachment',async()=>{
 const f=fixture({createdPreset:'jot-general'}),response=await f.invoke();assert.equal(response.status,409);assert.deepEqual(f.counts(),{creates:1,attaches:0});
});

test('an exact official Controller absence type admits a fresh isolated Session',async()=>{
 class OfficialAbsence extends Error{}
 const f=fixture({inspectFailure:new OfficialAbsence('absent'),sessionNotFoundError:OfficialAbsence});const response=await f.invoke();assert.equal(response.status,201);assert.deepEqual(f.counts(),{creates:1,attaches:1});
});
for(const inspectFailure of [Error('absent'),Object.assign(Error('absent'),{name:'ApiSessionNotFound'}),Object.assign(Error('absent'),{constructor:{name:'ApiSessionNotFound'}})])test('an unknown inspect error cannot impersonate official absence',async()=>{
 class OfficialAbsence extends Error{}
 const f=fixture({inspectFailure,sessionNotFoundError:OfficialAbsence});assert.equal((await f.invoke()).status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
test('official typed absence cannot erase a cached Session whose header was not inspected',async()=>{
 class OfficialAbsence extends Error{}
 const f=fixture({cached:cwd,inspectFailure:new OfficialAbsence('absent'),sessionNotFoundError:OfficialAbsence});assert.equal((await f.invoke()).status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
for(const task_binding of [{root_run_id:'work-run',occurrence_id:'work-occurrence',continuation_of:'parent-run',objective:'Frozen plan'},{root_run_id:'work-run',occurrence_id:'work-occurrence',objective:'Frozen plan'}])test('missing native history cannot create a replacement for a continuation or incomplete original lineage without composer',async()=>{
 const f=fixture({context:{task_binding}});assert.equal((await f.invoke()).status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
for(const goalBindingResponse of [{binding:{goal_id:'existing-original-goal',goal_revision:3}},{},null,{binding:undefined}])test('missing native history with an existing or unconfirmed original Goal cannot recreate a Session without composer',async()=>{
 const f=fixture({goalBindingResponse});assert.equal((await f.invoke()).status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
test('missing native history refuses unavailable original mapping before Session creation',async()=>{
 const f=fixture({goalBindingError:true});assert.equal((await f.invoke()).status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
test('fresh work rechecks original authority after awaited missing-Goal mapping',async()=>{
 const f=fixture({afterMapping:context=>{context.task_binding.continuation_of='substituted-parent';}});assert.equal((await f.invoke()).status,409);assert.deepEqual(f.counts(),{creates:0,attaches:0});
});
