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
