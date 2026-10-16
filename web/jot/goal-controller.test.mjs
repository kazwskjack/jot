import test from 'node:test';import assert from 'node:assert/strict';
import {ConversationGoalController,goalPresentation,goalPrompt,goalControlError} from './goal-controller.mjs';
const view=(revision=1,phase='active',activation='armed')=>({goal:{id:'goal-1',revision,objective:'Collect source-backed evidence',phase,activation,roundsStarted:2,maxGoalRounds:Number.MAX_SAFE_INTEGER}});
test('ordinary Goal reads address only the selected conversation and preserve unavailable state',async()=>{
 const calls=[],c=new ConversationGoalController('conversation /1',{request:async(...args)=>{calls.push(args);return view();}});
 await c.refresh();assert.equal(c.goal.id,'goal-1');assert.equal(calls[0][0],'/conversations/conversation%20%2F1/goal');assert.equal(calls[0][1],'GET');
 c.api.request=async()=>{throw Error('unavailable');};await assert.rejects(()=>c.refresh());assert.equal(c.goal.id,'goal-1');assert.equal(c.available,false);assert.equal(c.pending,false);
});
test('unknown control receipt retries the frozen CAS command and key, never a new action',async()=>{
 const calls=[];let fail=true;const c=new ConversationGoalController('ordinary',{request:async(path,method,body,key)=>{if(method==='GET')return view();calls.push(structuredClone({path,method,body,key}));if(fail){fail=false;throw Error('lost_reply');}return view(2,'paused','disarmed');}});
 await c.refresh();await assert.rejects(()=>c.control('pause'));assert.equal(c.pending,true);assert.equal(c.goal.phase,'active');
 await assert.rejects(()=>c.control('stop'),/goal_control_pending/);await c.retry();assert.deepEqual(calls[0],calls[1]);assert.deepEqual(calls[0].body,{action:'pause',id:'goal-1',revision:1});assert.equal(c.goal.phase,'paused');assert.equal(c.pending,false);
});
test('revision conflicts require a fresh read and never retry against a new revision',async()=>{
 let calls=0;const c=new ConversationGoalController('ordinary',{request:async(path,method)=>{if(method==='GET')return view();calls++;throw Object.assign(Error('GOAL_REVISION_CHANGED'),{status:409});}});
 await c.refresh();await assert.rejects(()=>c.control('pause'));assert.equal(c.pending,false);assert.equal(c.available,false);await assert.rejects(()=>c.control('stop'),/goal_state_unavailable/);assert.equal(calls,1);
});
test('an in-progress idempotency response retains the original control request',async()=>{
 const calls=[];let fail=true;const c=new ConversationGoalController('ordinary',{request:async(path,method,body,key)=>{if(method==='GET')return view();calls.push({body,key});if(fail){fail=false;throw Object.assign(Error('IDEMPOTENCY_IN_PROGRESS'),{status:409});}return view(2,'paused','disarmed');}});await c.refresh();await assert.rejects(()=>c.control('pause'));assert.equal(c.pending,true);await c.retry();assert.deepEqual(calls[0],calls[1]);
});
test('a late GET cannot overwrite the acknowledged control result',async()=>{
 let finish;const c=new ConversationGoalController('ordinary',{request:async(path,method)=>method==='POST'?view(2,'paused','disarmed'):view()});await c.refresh();
 c.api.request=async(path,method)=>method==='POST'?view(2,'paused','disarmed'):new Promise(resolve=>finish=resolve);const pending=c.refresh();await c.control('pause');finish(view());await pending;assert.equal(c.goal.revision,2);assert.equal(c.goal.phase,'paused');
});
test('background refresh cannot invalidate an in-flight acknowledged control',async()=>{
 let finish,reads=0;const c=new ConversationGoalController('ordinary',{request:async(path,method)=>{if(method==='GET'){reads++;return view();}return new Promise(resolve=>finish=resolve);}});await c.refresh();
 const pending=c.control('pause');await c.refresh();finish(view(2,'paused','disarmed'));await pending;assert.equal(reads,1);assert.equal(c.pending,false);assert.equal(c.goal.phase,'paused');
});
test('slow Goal reads coalesce instead of starving state behind overlapping polls',async()=>{
 let reads=0,finish;const c=new ConversationGoalController('ordinary',{request:async()=>{reads++;return new Promise(resolve=>finish=resolve);}});
 const first=c.refresh(),second=c.refresh();assert.equal(reads,1);finish(view());await Promise.all([first,second]);assert.equal(c.goal.id,'goal-1');assert.equal(c.loading,false);
});
test('malformed and unknown views cannot enable controls or silently mean no Goal',async()=>{
 const c=new ConversationGoalController('ordinary',{request:async()=>({unexpected:true})});await assert.rejects(()=>c.refresh(),/goal_view_invalid/);assert.equal(c.goal,undefined);assert.equal(c.available,false);
 c.api.request=async()=>({goal:null});await c.refresh();assert.equal(c.goal,null);assert.equal(c.available,true);await assert.rejects(()=>c.control('resume'),/goal_state_unavailable/);
});
test('cold active Goals are waiting for explicit continuation and blocked/complete are never shown running',()=>{
 assert.equal(goalPresentation(view().goal).label,'目标进行中');assert.equal(goalPresentation(view(1,'active','disarmed').goal).label,'目标待继续');
 assert.equal(goalPresentation(view(1,'paused','disarmed').goal).label,'目标已暂停');assert.equal(goalPresentation(view(1,'blocked','disarmed').goal).label,'目标需要处理');assert.equal(goalPresentation(view(1,'complete','disarmed').goal).label,'目标已完成');
 assert.deepEqual(goalPresentation(view(1,'complete','disarmed').goal).actions,['stop']);assert.equal(goalPresentation(view().goal).limitLabel,undefined);
});
test('native Goal prompt preserves user text, does not complete a Goal and uses the native tools',()=>{
 assert.equal(goalPrompt('A\nB',false),'A\nB');const text=goalPrompt('A\nB',true);assert.ok(text.endsWith('A\nB'));assert.match(text,/get_goal/);assert.match(text,/create_goal/);assert.match(text,/9007199254740991/);assert.doesNotMatch(text,/goal_id|session_id/);
});
test('Goal controls distinguish a recovery refusal from unknown or still-processing operations',()=>{
 assert.equal(goalControlError({status:409,message:'GOAL_CONTEXT_RECOVERY_REQUIRED'}),'会话有待恢复内容，请先恢复当前任务。');
 assert.equal(goalControlError({status:409,message:'IDEMPOTENCY_IN_PROGRESS'}),'操作仍在处理中，请重试原操作。');assert.equal(goalControlError({status:409,message:'GOAL_REVISION_CHANGED'}),'目标或运行状态已变化，请刷新后确认。');
 assert.equal(goalControlError({status:503,message:'private-diagnostic'}),'操作结果尚未确认，请核对后重试原操作。');
});
