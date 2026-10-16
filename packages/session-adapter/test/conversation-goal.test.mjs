import test from 'node:test';
import assert from 'node:assert/strict';
import {conversationGoal} from '../conversation-goal.js';
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
