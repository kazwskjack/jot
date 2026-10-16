import test from 'node:test';import assert from 'node:assert/strict';
import {ConversationGoalController,goalPresentation,goalPrompt,goalControlError,latestGoalRun,goalExecutionHint} from './goal-controller.mjs';
import {GoalReceiptStore} from './goal-receipts.mjs';
const memory=()=>{const data=new Map();return {get length(){return data.size;},key:i=>[...data.keys()][i]??null,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
const view=(revision=1,phase='active',activation='armed')=>({goal:{id:'goal-1',revision,objective:'Collect source-backed evidence',phase,activation,roundsStarted:2,maxGoalRounds:Number.MAX_SAFE_INTEGER}});
test('a new controller restores a lost reply without sending, then explicitly retries the identical command',async()=>{
 const storage=memory(),store=()=>new GoalReceiptStore(storage,'a'.repeat(64),'ordinary'),calls=[];
 const api={request:async(path,method,body,key)=>{if(method==='GET')return view();calls.push(structuredClone({body,key}));throw Error('lost');}};
 const first=new ConversationGoalController('ordinary',api);first.configureRecovery(store(),async()=>true);await first.refresh();await assert.rejects(()=>first.control('pause'));first.dispose();
 const second=new ConversationGoalController('ordinary',api);second.configureRecovery(store(),async()=>true);assert.equal(second.pending,true);assert.equal(calls.length,1);api.request=async(path,method,body,key)=>{calls.push({body,key});return view(2,'paused','disarmed');};await second.retry();assert.deepEqual(calls[0],calls[1]);assert.equal(second.pending,false);assert.deepEqual(store().pending(),[]);
});
test('durability and owner checks must succeed before any POST; auth failures preserve the original request',async()=>{
 const storage=memory(),store=new GoalReceiptStore(storage,'a'.repeat(64),'ordinary');let posts=0,owner=true;
 const c=new ConversationGoalController('ordinary',{request:async(path,method)=>{if(method==='GET')return view();posts++;throw Object.assign(Error('AUTH_REQUIRED'),{status:401});}});c.configureRecovery(store,async()=>owner);await c.refresh();storage.setItem=()=>{throw Error('quota');};await assert.rejects(()=>c.control('pause'));assert.equal(posts,0);
 const d=new ConversationGoalController('ordinary',c.api);d.configureRecovery(new GoalReceiptStore(memory(),'a'.repeat(64),'ordinary'),async()=>owner);await d.refresh();await assert.rejects(()=>d.control('pause'));assert.equal(d.pending,true);owner=false;await assert.rejects(()=>d.retry(),/goal_recovery_scope_changed/);assert.equal(posts,1);assert.equal(d.pending,true);
});
test('wrong pause/stop receipts and failed acknowledgement writes retain the exact request',async()=>{
 for(const action of ['pause','stop']){const c=new ConversationGoalController('ordinary',{request:async(path,method)=>method==='GET'?view():view(9,'paused','disarmed')});await c.refresh();await assert.rejects(()=>c.control(action),/goal_control_receipt_invalid/);assert.equal(c.pending,true);}
 const storage=memory(),store=new GoalReceiptStore(storage,'a'.repeat(64),'ordinary'),c=new ConversationGoalController('ordinary',{request:async(path,method)=>method==='GET'?view():view(2,'paused','disarmed')});c.configureRecovery(store,async()=>true);await c.refresh();const write=storage.setItem;storage.setItem=(k,v)=>{if(v.includes('acknowledged'))throw Error('quota');write(k,v);};await assert.rejects(()=>c.control('pause'));assert.equal(c.pending,true);assert.equal(c.goal.phase,'active');assert.equal(store.pending().length,1);
});
test('required recovery cannot be bypassed and disposal while verifying the owner never sends',async()=>{
 const store=new GoalReceiptStore(memory(),'a'.repeat(64),'ordinary');let posts=0,finish;
 const c=new ConversationGoalController('ordinary',{request:async(path,method)=>{if(method==='POST')posts++;return view();}},()=>{},true);await c.refresh();await assert.rejects(()=>c.control('pause'),/goal_recovery_unavailable/);assert.equal(posts,0);
 c.configureRecovery(store,()=>new Promise(resolve=>finish=resolve));const pending=c.control('pause');c.dispose();finish(true);await assert.rejects(()=>pending,/goal_control_disposed/);assert.equal(posts,0);assert.equal(store.pending().length,1);
});
test('owner changes after a reply preserve recovery metadata and do not apply another owner response',async()=>{
 const store=new GoalReceiptStore(memory(),'a'.repeat(64),'ordinary');let checks=0;
 const c=new ConversationGoalController('ordinary',{request:async(path,method)=>method==='GET'?view():view(2,'paused','disarmed')});c.configureRecovery(store,async()=>++checks===1);await c.refresh();await assert.rejects(()=>c.control('pause'),/goal_recovery_scope_changed/);assert.equal(c.goal.phase,'active');assert.equal(c.pending,true);assert.equal(store.pending().length,1);
});
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

test('202 resume acceptance preserves the native phase and follows a separate original-run identity',async()=>{
 const accepted={accepted:true,control_id:'goal-control-fixture',run_id:'run-resume',conversation_id:'ordinary'},calls=[],c=new ConversationGoalController('ordinary',{request:async(path,method,body,key)=>{calls.push({path,method,body,key});if(path.endsWith('/resume-readiness'))return{enabled:true,ready:true,reason:'READY'};if(method==='GET')return view(3,'paused','disarmed');return accepted;}});
 await c.refresh();await c.refreshReadiness();const result=await c.control('resume');assert.deepEqual(result,accepted);assert.equal(c.goal.phase,'paused');assert.equal(c.pending,false);assert.equal(c.executing,true);assert.equal(c.execution.run_id,'run-resume');await assert.rejects(()=>c.control('resume'),/goal_control_pending/);
 c.observeRun({run_id:'foreign',conversation_id:'another',goal_control_id:'goal-control-fixture',status:'succeeded'});assert.equal(c.executing,true);
 c.observeRun({run_id:'run-resume',conversation_id:'ordinary',goal_control_id:'goal-control-fixture',status:'succeeded'});assert.equal(c.executing,false);assert.equal(c.goal.phase,'paused');assert.equal(goalPresentation(c.goal).label,'目标已暂停');
});
test('a lost resume response retries the exact CAS/key and does not infer acceptance from a newer native view',async()=>{
 const accepted={accepted:true,control_id:'goal-control-fixture',run_id:'run-resume',conversation_id:'ordinary'},calls=[];let lost=true;const c=new ConversationGoalController('ordinary',{request:async(path,method,body,key)=>{if(path.endsWith('/resume-readiness'))return{enabled:true,ready:true,reason:'READY'};if(method==='GET')return view(3,'paused','disarmed');calls.push(structuredClone({body,key}));if(lost){lost=false;throw Error('reply_lost');}return accepted;}});
 await c.refresh();await c.refreshReadiness();await assert.rejects(()=>c.control('resume'));assert.equal(c.pending,true);assert.equal(c.execution,null);await c.refresh();assert.equal(c.pending,true);await c.retry();assert.deepEqual(calls[0],calls[1]);assert.equal(c.execution.control_id,accepted.control_id);assert.equal(c.pending,false);
});
test('disabled, malformed and foreign resume readiness or receipts cannot enable execution',async()=>{
 const c=new ConversationGoalController('ordinary',{request:async()=>view(3,'paused','disarmed')});await c.refresh();await assert.rejects(()=>c.control('resume'),/goal_resume_unavailable/);
 c.api.request=async()=>({enabled:false,ready:true,reason:'READY'});await assert.rejects(()=>c.refreshReadiness());assert.equal(c.resumeReadiness,undefined);
 c.api.request=async(path,method)=>path.endsWith('/resume-readiness')?{enabled:true,ready:true,reason:'READY'}:method==='GET'?view(3,'paused','disarmed'):{accepted:true,control_id:'goal-control-fixture',run_id:'run-a',conversation_id:'foreign'};await c.refreshReadiness();await assert.rejects(()=>c.control('resume'));assert.equal(c.pending,true);assert.equal(c.execution,null);
});

test('a synchronous readiness transport failure does not permanently poison the coalesced request',async()=>{
 const c=new ConversationGoalController('ordinary',{request:()=>{throw Error('transport_setup_failed');}});await assert.rejects(()=>c.refreshReadiness(),/transport_setup_failed/);
 c.api.request=()=>({enabled:true,ready:true,reason:'READY'});assert.deepEqual(await c.refreshReadiness(),{enabled:true,ready:true,reason:'READY'});
});

test('continuation display selects this conversation active control before a newer finished receipt',()=>{
 const active={conversation_id:'ordinary',run_id:'run-a',goal_control_id:'goal-control-a',status:'queued',created_at:'2026-01-01'},finished={...active,run_id:'run-b',status:'succeeded',created_at:'2026-01-02'};
 assert.equal(latestGoalRun([{...active,conversation_id:'foreign'},finished,active],'ordinary'),active);
 assert.equal(latestGoalRun([{...active,status:'failed'},finished],'ordinary'),finished);assert.equal(latestGoalRun([active],'foreign'),undefined);
});

test('confirmed refusal exposes a fixed user-readable reason without raw transport details',()=>{
 const c=new ConversationGoalController('ordinary',{request:async()=>({goal:null})});c.observeRun({run_id:'resume-failed',conversation_id:'ordinary',goal_control_id:'goal-control-fixture',status:'interrupted',error_code:'GOAL_CONTEXT_RECOVERY_REQUIRED'});assert.equal(c.execution.error_code,'GOAL_CONTEXT_RECOVERY_REQUIRED');assert.equal(goalExecutionHint(c.execution),'本次未启动：会话有待恢复内容，目标已保留。');assert.equal(goalExecutionHint({...c.execution,error_code:'secret transport details'}),'续跑未完成，请核对执行记录后重试。');
});
