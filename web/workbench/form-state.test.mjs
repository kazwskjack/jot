import test from 'node:test';
import assert from 'node:assert/strict';
import {taskInput, agentInput, teamInput, featureReason, executionReason, canResumeTask, selectInitialConversation} from './form-state.mjs';
import * as formState from './form-state.mjs';

const valid={title:'  周报  ',agent_id:'a1',objective:'  整理资料 ',kind:'interval',interval_seconds:'60',max_runs:'5'};
test('task form produces typed interval and bounded execution budget',()=>{
 assert.deepEqual(taskInput(valid),{title:'周报',agent_id:'a1',objective:'整理资料',trigger:{kind:'interval',interval_seconds:60},budget:{max_runs:5}});
});
test('task form rejects empty role, invalid interval and invalid budget',()=>{
 for(const change of [{agent_id:''},{interval_seconds:'0'},{interval_seconds:'1.5'},{max_runs:'-1'},{max_runs:'abc'}])assert.throws(()=>taskInput({...valid,...change}));
});
test('page change accepts HTTP sources and rejects other protocols',()=>{
 assert.deepEqual(taskInput({...valid,kind:'page_change',url:' https://example.com/news '} ).trigger,{kind:'page_change',url:'https://example.com/news',interval_seconds:60});
 for(const url of ['file:///private','javascript:alert(1)','invalid'])assert.throws(()=>taskInput({...valid,kind:'page_change',url}));
});
test('agent editing keeps version and only selected allowed tools',()=>{
 assert.deepEqual(agentInput({name:' 分析员 ',instructions:' 核对来源 ',workspace_id:'w',allowed_tools:['read','search'],version:3}),{name:'分析员',instructions:'核对来源',workspace_id:'w',allowed_tools:['read','search'],expected_version:3});
 assert.throws(()=>agentInput({name:'',instructions:'职责',workspace_id:'w'}));
});
test('missing or false capabilities are disabled with an explicit reason',()=>{
 assert.ok(featureReason(null,'agent_roles'));
 assert.ok(featureReason({enabled:true,agent_roles:false},'agent_roles'));
 assert.equal(featureReason({enabled:true,agent_roles:true},'agent_roles'),'');
});
test('explicit conversation takes precedence and never silently opens another role',()=>{
 const items=[{conversation_id:'ordinary'},{conversation_id:'role'}];
 assert.equal(selectInitialConversation(items,'role','ordinary'),'role');
 assert.throws(()=>selectInitialConversation(items,'missing','ordinary'));
 assert.equal(selectInitialConversation(items,'','ordinary'),'ordinary');
});
test('team editing submits only mutable fields accepted by the patch route',()=>{
 assert.deepEqual(teamInput({team_id:'team',name:' 团队 ',workspace_id:'w',project_id:'p',member_ids:['a'],version:4}),{name:'团队',member_ids:['a'],expected_version:4});
 assert.deepEqual(teamInput({name:'团队',workspace_id:'w',member_ids:['a']}),{name:'团队',workspace_id:'w',member_ids:['a']});
});
test('once scheduling preserves an explicit timezone and rejects ambiguous local time',()=>{
 assert.equal(taskInput({...valid,kind:'once',run_at:'2026-10-02T20:00:00+08:00'}).trigger.run_at,'2026-10-02T12:00:00.000Z');
 assert.throws(()=>taskInput({...valid,kind:'once',run_at:'2026-10-02T20:00'}));
});
test('execution controls stay disabled until the host reports verified readiness',()=>{
 assert.ok(executionReason({enabled:true,execution_ready:false}));
 assert.ok(executionReason({enabled:true}));
 assert.ok(executionReason(null));
 assert.equal(executionReason({enabled:true,execution_ready:true}),'');
});
test('raising the budget makes an exhausted task resumable without enabling exhausted runs',()=>{
 assert.equal(canResumeTask({status:'budget_exhausted',runs_used:2,budget:{max_runs:4}}),true);
 assert.equal(canResumeTask({status:'budget_exhausted',runs_used:2,budget:{max_runs:2}}),false);
 assert.equal(canResumeTask({status:'archived',runs_used:1,budget:{max_runs:4}}),false);
});
test('daily scheduling preserves wall-clock time and IANA timezone without interval fields',()=>{
 assert.deepEqual(taskInput({...valid,kind:'daily',time:'09:30',timezone:'Asia/Hong_Kong',weekdays:[1]}).trigger,{kind:'daily',time:'09:30',timezone:'Asia/Hong_Kong'});
});
test('calendar scheduling rejects malformed wall-clock times and unknown timezones',()=>{
 for(const change of [{time:''},{time:'9:30'},{time:'24:00'},{time:'12:60'},{time:'09:30:00'},{timezone:''},{timezone:'Mars/Olympus'},{timezone:'+08:00'}]){
  assert.throws(()=>taskInput({...valid,kind:'daily',time:'09:30',timezone:'Asia/Hong_Kong',...change}));
 }
});
test('weekly scheduling submits selected weekdays in stable Sunday-zero order',()=>{
 assert.deepEqual(taskInput({...valid,kind:'weekly',time:'17:45',timezone:'America/New_York',weekdays:[5,1,0,1]}).trigger,{kind:'weekly',time:'17:45',timezone:'America/New_York',weekdays:[0,1,5]});
});
test('weekly scheduling requires integer weekdays in the range zero to six',()=>{
 for(const weekdays of [undefined,[],[-1],[7],[1.5],['1'],[null],'1'])assert.throws(()=>taskInput({...valid,kind:'weekly',time:'09:30',timezone:'Asia/Hong_Kong',weekdays}));
});
test('new calendar forms use the local IANA timezone and a nonempty weekly default',()=>{
 assert.equal(typeof formState.blankTaskForm,'function');
 const form=formState.blankTaskForm('a');
 assert.equal(form.timezone,Intl.DateTimeFormat().resolvedOptions().timeZone);
 assert.equal(form.agent_id,'a');
 assert.match(form.time,/^\d{2}:\d{2}$/);
 assert.equal(form.weekdays.length,1);
 assert.ok(form.weekdays[0]>=0&&form.weekdays[0]<=6);
});
test('editing a weekly task round-trips time, timezone, days and budget',()=>{
 assert.equal(typeof formState.taskFormFromTask,'function');
 const task={title:'周报',agent_id:'a',objective:'整理',trigger:{kind:'weekly',time:'08:15',timezone:'Europe/Berlin',weekdays:[2,4]},budget:{max_runs:7}};
 const form=formState.taskFormFromTask(task);
 assert.deepEqual(taskInput(form),{title:'周报',agent_id:'a',objective:'整理',trigger:{kind:'weekly',time:'08:15',timezone:'Europe/Berlin',weekdays:[2,4]},budget:{max_runs:7}});
 form.weekdays.push(6);
 assert.deepEqual(task.trigger.weekdays,[2,4]);
});
test('calendar summary and next execution retain the task timezone',()=>{
 assert.equal(typeof formState.taskTriggerSummary,'function');
 assert.equal(typeof formState.scheduleTime,'function');
 const summary=formState.taskTriggerSummary({kind:'weekly',time:'08:15',timezone:'Europe/Berlin',weekdays:[0,2]});
 for(const value of ['周日','周二','08:15','Europe/Berlin'])assert.ok(summary.includes(value));
 const due=formState.scheduleTime('2026-10-02T12:00:00.000Z','Asia/Hong_Kong');
 assert.ok(due.includes('20:00'));
 assert.ok(due.includes('Asia/Hong_Kong'));
 assert.equal(formState.scheduleTime(null,'Asia/Hong_Kong'),'—');
});
test('interval forms honor advertised default and validation limits',()=>{
 const limits={default_interval_seconds:120,min_interval_seconds:120,max_interval_seconds:3600};
 assert.equal(formState.blankTaskForm('a',limits).interval_seconds,'120');
 assert.deepEqual(taskInput({...valid,interval_seconds:'120'},limits).trigger,{kind:'interval',interval_seconds:120});
 assert.throws(()=>taskInput({...valid,interval_seconds:'60'},limits));
 assert.throws(()=>taskInput({...valid,interval_seconds:'3601'},limits));
});

test('new task form sends an exact initial model budget only with the advertised capability',()=>{
 const form={...valid,model_budget_enabled:true,model_tokens:'200',model_dollars:'0.000002',model_calls:'2'};
 const input=taskInput(form,undefined,true);assert.deepEqual(input.model_budget,{tokens:200,nano_usd:2000,model_calls:2});assert.deepEqual(input.budget,{max_runs:5});
 assert.throws(()=>taskInput(form,undefined,false),/模型预算/);
 assert.throws(()=>taskInput({...form,model_dollars:'0.0000000001'},undefined,true));
 assert.equal(Object.hasOwn(taskInput({...form,model_budget_enabled:false},undefined,true),'model_budget'),false);
});
test('server limits initialize an opt-in creation form and task editing cannot silently change model ceilings',()=>{
 const form=formState.blankTaskForm('a',undefined,{tokens:5000,nano_usd:50000,model_calls:50});
 assert.equal(form.model_budget_enabled,false);assert.equal(form.model_tokens,'5000');assert.equal(form.model_dollars,'0.00005');assert.equal(form.model_calls,'50');
 const edit=formState.taskFormFromTask({title:'Task',agent_id:'a',objective:'Controlled',trigger:{kind:'once'},budget:{max_runs:5}});
 assert.equal(edit.model_budget_enabled,false);assert.equal(Object.hasOwn(taskInput(edit,undefined,true),'model_budget'),false);
});
test('new task form preserves an unlimited server monetary default through explicit opt-in submission',()=>{
 const form=formState.blankTaskForm('a',undefined,{tokens:5000,nano_usd:null,model_calls:50});assert.equal(form.model_dollars,'不限额');
 const input=taskInput({...valid,...form,title:'Owned task',objective:'Read controlled source',model_budget_enabled:true},undefined,true);assert.equal(input.model_budget.nano_usd,null);
});
