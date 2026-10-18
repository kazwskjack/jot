import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationGoal,readConversationGoal} from '../conversation-goal.js';
test('native Cordis context uses active-service lookup instead of optional proxy property',()=>{
 const goal={id:'native',revision:1,phase:'active',activation:'armed'};
 const scope={get:name=>{assert.equal(name,'goals');return {get:()=>goal}}};
 Object.defineProperty(scope,'goals',{get(){throw new Error('optional service is not inherited')}});
 assert.equal(conversationGoal({ctx:scope},{}).goal,goal);
});
test('goal controls require exact CAS and cannot create or report completion',()=>{
 const agent={id:'s',status:'idle'},goal={id:'g',revision:2,objective:'collect',phase:'active',activation:'armed'};
 let calls=[];agent.ctx={goals:{get:()=>goal,pause:(a,ref)=>{calls.push(['pause',a,ref]);return {...goal,phase:'paused'}},clear:(a,ref)=>calls.push(['clear',a,ref])}};
 assert.equal(conversationGoal(agent,{}).goal.id,'g');
 assert.throws(()=>conversationGoal(agent,{action:'pause',id:'g',revision:1}),/goal_revision_changed/);
 assert.throws(()=>conversationGoal(agent,{action:'complete',id:'g',revision:2}),/goal_action_invalid/);
 assert.equal(calls.length,0);
 assert.equal(conversationGoal(agent,{action:'pause',id:'g',revision:2}).goal.phase,'paused');
 assert.deepEqual(calls[0][2],{id:'g',revision:2});
 assert.equal(conversationGoal(agent,{action:'stop',id:'g',revision:2}).goal,null);
});
test('absent goal is a valid read, malformed control is rejected',()=>{
 const agent={ctx:{goals:{get:()=>undefined}}};
 assert.deepEqual(conversationGoal(agent,{}),{goal:null});
 assert.throws(()=>conversationGoal(agent,{action:'pause',id:'g',revision:2}),/goal_revision_changed/);
});

test('cold Goal reads use official projections without creating, prompting or arming a Session',async()=>{
 const {createAdapterHandler}=await import('../index.js');let reads=0;
 const handler=createAdapterHandler({token:'a'.repeat(32),agents:{get:()=>undefined},controller:{async projections(request,signal){reads++;assert.deepEqual(request,{sessionId:'cold'});assert.ok(signal instanceof AbortSignal);return{values:{goal:{goal:{id:'g',revision:3,objective:'Persisted objective',phase:'paused',maxGoalRounds:20},roundsStarted:2,createdAt:1,updatedAt:2}}};},create(){throw Error('must_not_create');},prompt(){throw Error('must_not_prompt');}}});
 const invoke=body=>handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/cold/conversation-goal'),headers:{authorization:'Bearer '+'a'.repeat(32)},body});
 const read=await invoke({});assert.equal(read.status,200);assert.equal(read.value.goal.phase,'paused');assert.equal(read.value.goal.activation,'disarmed');assert.equal(read.value.goal.roundsStarted,2);assert.equal(reads,1);
 const mutate=await invoke({action:'resume',id:'g',revision:3});assert.equal(mutate.status,409);assert.equal(reads,1);
});
test('cold Goal reads distinguish absent Sessions from unavailable or corrupt projections',async()=>{
 const {createAdapterHandler}=await import('../index.js');
 for(const [projection,status] of [[null,200],[{values:{goal:null}},200],[{values:{}},409],[{values:{goal:{goal:{phase:'invented'}}}},409]]){
  const handler=createAdapterHandler({token:'a'.repeat(32),agents:{get:()=>undefined},controller:{async projections(){return projection;}}});
  const result=await handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/cold/conversation-goal'),headers:{authorization:'Bearer '+'a'.repeat(32)},body:{}});assert.equal(result.status,status);if(status===200)assert.deepEqual(result.value,{goal:null});
 }
});
const storedGoal=()=>({values:{agentPreset:'jot-general',turnBoundary:{openTurnStartSeq:null},inbox:{'next-turn':[],'next-step':[]},goal:{goal:{id:'g',revision:3,objective:'Persisted objective',phase:'active',maxGoalRounds:20},roundsStarted:2,createdAt:1,updatedAt:2}}});
function coldFixture(){
 const calls=[],projection=storedGoal();let current;
 const agent={id:'cold',session:{id:'cold'},status:'idle',inbox:{nextTurn:[],nextStep:[]},runMaintenance:async task=>{calls.push('maintenance');return task(new AbortController().signal);},ctx:{goals:{get:()=>({...projection.values.goal.goal,activation:'disarmed'}),pause:(a,ref)=>{assert.equal(a,agent);assert.deepEqual(ref,{id:'g',revision:3});calls.push('pause');return {...projection.values.goal.goal,revision:4,phase:'paused',activation:'disarmed'};},clear:()=>calls.push('clear')}}};
 const history={meta:{id:'cold'},events:[]};
 const context={agents:{get:()=>current},controller:{projections:async()=>projection,inspect:async()=>history,resolveAgent:async id=>{assert.equal(id,'cold');calls.push('resolve');current=agent;return {agent};}},persistence:{flush:async session=>{assert.equal(session,agent.session);calls.push('flush');}},sessionId:'cold',signal:new AbortController().signal,ordinaryPresets:new Set(['jot-general'])};
 return {context,projection,history,agent,calls};
}
test('cold pause uses the official ordinary resolver, maintenance and persistence without a prompt',async()=>{
 const f=coldFixture();const result=await readConversationGoal({...f.context,body:{action:'pause',id:'g',revision:3}});assert.equal(result.goal.phase,'paused');assert.equal(result.goal.revision,4);assert.deepEqual(f.calls,['resolve','maintenance','pause','flush']);
});
test('cold controls reject pending input, non-ordinary presets and stale CAS before activating an Agent',async()=>{
 for(const problem of ['next-turn','next-step','preset','revision','phase','missing-inbox','open-turn','corrupt-history']){
  const f=coldFixture();if(problem==='next-turn'||problem==='next-step')f.projection.values.inbox[problem]=[{id:'pending'}];if(problem==='preset')f.projection.values.agentPreset='jot-workbench-budgeted';if(problem==='revision')f.projection.values.goal.goal.revision=4;if(problem==='phase')f.projection.values.goal.goal.phase='paused';if(problem==='missing-inbox')delete f.projection.values.inbox;if(problem==='open-turn')f.history.events=[{seq:0,type:'turn/start',data:{turn:1}}];if(problem==='corrupt-history')f.history.events=[{seq:3,type:'turn/end',data:{turn:1}}];
  await assert.rejects(()=>readConversationGoal({...f.context,body:{action:'pause',id:'g',revision:3}}));assert.deepEqual(f.calls,[],problem);
 }
});
test('cold controls recheck exact Agent identity, pending work and cancellation before mutation',async()=>{
 for(const problem of ['pending','busy','identity','cancelled']){
  const f=coldFixture();if(problem==='pending')f.agent.inbox.nextTurn=[{id:'pending'}];if(problem==='busy')f.agent.status='running';if(problem==='identity')f.agent.id='other';if(problem==='cancelled'){const abort=new AbortController();abort.abort();f.context.signal=abort.signal;}
  await assert.rejects(()=>readConversationGoal({...f.context,body:{action:'pause',id:'g',revision:3}}));assert.ok(!f.calls.includes('pause'));assert.ok(!f.calls.includes('flush'));
 }
});
test('cold controls require a durable flush and reject malformed controls before waking',async()=>{
 const f=coldFixture();delete f.context.persistence.flush;await assert.rejects(()=>readConversationGoal({...f.context,body:{action:'pause',id:'g',revision:3}}));assert.deepEqual(f.calls,[]);
 for(const body of [{action:['pause'],id:'g',revision:3},{action:'stop',id:'g',revision:3,extra:true},{action:'resume',id:'g',revision:3}]){const f=coldFixture();await assert.rejects(()=>readConversationGoal({...f.context,body}));assert.deepEqual(f.calls,[]);}
});
test('stop records one native clear rather than a pause followed by a second mutation',()=>{
 const calls=[],agent={ctx:{goals:{get:()=>({id:'g',revision:3,phase:'active'}),pause:()=>{calls.push('pause');return{id:'g',revision:4}},clear:(_agent,ref)=>{calls.push(['clear',ref]);}}}};
 assert.deepEqual(conversationGoal(agent,{action:'stop',id:'g',revision:3}),{goal:null});assert.deepEqual(calls,[['clear',{id:'g',revision:3}]]);
});
test('a parked-input refusal has a fixed recoverable protocol code and performs no activation',async()=>{
 const {createAdapterHandler}=await import('../index.js'),f=coldFixture();f.projection.values.inbox['next-turn']=[{id:'pending'}];
 const handler=createAdapterHandler({...f.context,token:'a'.repeat(32)}),result=await handler({method:'POST',url:new URL('http://127.0.0.1/v1/sessions/cold/conversation-goal'),headers:{authorization:'Bearer '+'a'.repeat(32)},body:{action:'stop',id:'g',revision:3}});
 assert.equal(result.status,409);assert.deepEqual(result.value,{error:'goal_cold_input_pending'});assert.deepEqual(f.calls,[]);
});

test('migration-required cached Goal hints cannot authorize cold controls or exact observation',async()=>{
 for(const body of [{},{action:'pause',id:'g',revision:3}]){
  const f=coldFixture();f.projection.kind='migration-required';
  await assert.rejects(()=>readConversationGoal({...f.context,body}),/goal_unavailable/);assert.deepEqual(f.calls,[]);
 }
});
