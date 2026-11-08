import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Agent} from '../src/agent.mjs';
import {encodeSseEvent} from '../src/server.mjs';
import {toolActivitySummary} from '../src/activity-summary.mjs';

const tool=(id,name,args)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});

test('tool activity summary preserves labels and shape without argument values',()=>{
 const marker='M22-04-SYNTHETIC-SECRET-7d91';
 const summary=toolActivitySummary({run_id:'run-1',phase:'read_page',label:'read_page',status:'running',args:{url:'https://private.example.invalid/profile?token='+marker,query:marker,nested:{secret:marker}}});
 assert.deepEqual(summary,{run_id:'run-1',phase:'read_page',label:'read_page',status:'running',args:{kind:'object',field_count:3},args_summary_version:1});
 assert.deepEqual(toolActivitySummary(summary),summary);
 assert.equal(JSON.stringify(summary).includes(marker),false);
});

test('ordinary Agent stores a safe activity summary and executes with the original arguments',async()=>{
 const store=new Store(':memory:');
 const conversation=store.createConversation('test');
 const {run}=store.accept(conversation.id,'read the page','ordinary-1');
 const marker='M22-04-AGENT-SECRET-1b2c';
 const original={url:'https://private.example.invalid/profile?token='+marker,query:marker};
 let step=0,executed;
 const agent=new Agent(store,{provider:async()=>++step===1?{role:'assistant',content:null,tool_calls:[tool('read-1','read_page',original)]}:{role:'assistant',content:'Done.'},tools:{definitions:[{type:'function',function:{name:'read_page'}}],execute:async(name,args)=>{executed={name,args};return{ok:true};}}});
 try{
  await agent.execute(run);
  assert.deepEqual(executed,{name:'read_page',args:original});
  const activity=store.events(conversation.id,0).find(event=>event.type==='activity'&&event.data.phase==='read_page');
  assert.ok(activity);
  assert.equal(activity.data.label,'read_page');
  assert.deepEqual(activity.data.args,{kind:'object',field_count:2});
  const persisted=store.db.prepare("SELECT data FROM events WHERE conversation_id=? AND type='activity'").all(conversation.id).map(row=>row.data).join('\n');
  assert.equal(persisted.includes(marker),false);
  assert.equal(persisted.includes(original.url),false);
 }finally{await agent.close();store.close();}
});

test('ordinary Agent does not expose an unregistered model tool name as an activity label',async()=>{
 const store=new Store(':memory:');
 const conversation=store.createConversation('test');
 const {run}=store.accept(conversation.id,'try the supplied tool','ordinary-unknown-1');
 const marker='M22-04-UNKNOWN-TOOL-SECRET-6c8a';
 let executedName;
 const agent=new Agent(store,{provider:async()=>({role:'assistant',content:null,tool_calls:[tool('unknown-1',marker,{value:'safe'})]}),tools:{definitions:[{type:'function',function:{name:'read_page'}}],execute:async(name)=>{executedName=name;throw Error('tool_not_available');}}});
 try{
  await agent.execute(run);
  assert.equal(executedName,marker);
  const activity=store.events(conversation.id,0).find(event=>event.type==='activity'&&event.data.phase==='tool');
  assert.ok(activity);assert.equal(activity.data.phase,'tool');assert.equal(activity.data.label,'tool');
  const persisted=store.db.prepare("SELECT data FROM events WHERE conversation_id=? AND type='activity'").all(conversation.id).map(row=>row.data).join('\n');
  assert.equal(persisted.includes(marker),false);
 }finally{await agent.close();store.close();}
});

test('SSE replay encodes the same safe activity summary the UI receives',()=>{
 const store=new Store(':memory:');
 try{
  const conversation=store.createConversation('test');
  const marker='M22-04-SSE-SECRET-3a4e';
  store.event(conversation.id,'activity',toolActivitySummary({run_id:'run-sse',phase:'read_page',label:'read_page',args:{url:'https://private.example.invalid/?token='+marker}}));
  const wire=store.events(conversation.id,0).map(encodeSseEvent).join('');
  const frame=wire.split('\n').find(line=>line.startsWith('data: '));
  assert.ok(frame);
  const event=JSON.parse(frame.slice('data: '.length));
  assert.equal(event.type,'activity');
  assert.equal(event.data.phase,'read_page');
  assert.deepEqual(event.data.args,{kind:'object',field_count:1});
  assert.equal(wire.includes(marker),false);
  assert.equal(wire.includes('https://private.example.invalid'),false);
 }finally{store.close();}
});

test('Store projects legacy activity arguments so SSE and UI receive only the safe shape',()=>{
 const store=new Store(':memory:');
 try{
  const conversation=store.createConversation('legacy activity');
  const marker='M22-04-LEGACY-ACTIVITY-SECRET-5e2f';
  const raw={run_id:'legacy-run',phase:'read_page',label:'read_page',args:{url:'https://private.example.invalid/?token='+marker,query:marker}};
  store.event(conversation.id,'activity',raw);
  assert.equal(store.db.prepare("SELECT data FROM events WHERE conversation_id=? AND type='activity'").get(conversation.id).data.includes(marker),true);
  const event=store.events(conversation.id,0).find(item=>item.type==='activity');
  assert.ok(event);
  assert.equal(JSON.stringify(event).includes(marker),false);
  assert.deepEqual(event.data.args,{kind:'object',field_count:2});
  const wire=encodeSseEvent(event);
  assert.equal(wire.includes(marker),false);
  const frame=wire.split('\n').find(line=>line.startsWith('data: '));
  assert.ok(frame);
  const uiEvent=JSON.parse(frame.slice('data: '.length));
  assert.deepEqual(uiEvent.data.args,{kind:'object',field_count:2});
  assert.equal(JSON.stringify(uiEvent.data).includes(marker),false);
 }finally{store.close();}
});

test('Store does not treat raw summary-shaped activity arguments as an existing safe summary',()=>{
 const store=new Store(':memory:');
 try{
  const conversation=store.createConversation('legacy summary-shaped activity');
  store.event(conversation.id,'activity',{run_id:'legacy-shaped-run',phase:'read_page',label:'read_page',args:{kind:'object',field_count:123456}});
  const event=store.events(conversation.id,0).find(item=>item.type==='activity');
  assert.ok(event);
  assert.deepEqual(event.data.args,{kind:'object',field_count:2});
  assert.equal(JSON.stringify(event).includes('123456'),false);
 }finally{store.close();}
});

test('Store redacts new and historical tool result and error event payloads',()=>{
 const store=new Store(':memory:');
 try{
  const conversation=store.createConversation('tool event privacy');
  const marker='M22-04-TOOL-EVENT-SECRET-c93a';
  const writtenResult=store.event(conversation.id,'tool.result',{run_id:'run-result',call_id:'call-result',tool:'private tool name',result:{text:marker}});
  const writtenError=store.event(conversation.id,'tool.error',{run_id:'run-error',call_id:'call-error',tool:'private tool name',error:{message:marker,stack:marker}});
  store.event(conversation.id,'tool.result',{run_id:'run-result-error',call_id:'call-result-error',tool:'private tool name',result:{error:marker}});
  assert.equal(JSON.stringify([writtenResult,writtenError]).includes(marker),false);
  store.db.prepare('INSERT INTO events(conversation_id,type,data) VALUES(?,?,?)').run(conversation.id,'tool.result',JSON.stringify({run_id:'legacy-result',call_id:'legacy-call',tool:'private tool name',result:{text:marker}}));
  store.db.prepare('INSERT INTO events(conversation_id,type,data) VALUES(?,?,?)').run(conversation.id,'tool.error',JSON.stringify({run_id:'legacy-error',call_id:'legacy-call',tool:'private tool name',error:{message:marker,stack:marker}}));
  const persisted=store.db.prepare("SELECT data FROM events WHERE conversation_id=? AND type IN ('tool.result','tool.error') ORDER BY seq").all(conversation.id).map(row=>row.data);
  assert.equal(persisted.slice(0,3).join('\n').includes(marker),false);
  assert.equal(persisted.slice(3).join('\n').includes(marker),true,'historical source rows are retained without in-place rewriting');
  const events=store.events(conversation.id,0).filter(event=>event.type==='tool.result'||event.type==='tool.error');
  assert.equal(events.length,5);
  assert.equal(JSON.stringify(events).includes(marker),false);
  assert.equal(events.map(encodeSseEvent).join('').includes(marker),false);
  assert.deepEqual(events.map(event=>event.data.status),['succeeded','failed','failed','succeeded','failed']);
  assert.deepEqual(events.map(event=>event.data.tool),['tool','tool','tool','tool','tool']);
 }finally{store.close();}
});

test('ordinary Agent keeps raw tool results in model history while event storage stays private',async()=>{
 const store=new Store(':memory:');
 const conversation=store.createConversation('private tool result');
 const marker='M22-04-RAW-MODEL-CONTEXT-SECRET-8a62';let step=0,toolMessage;
 const agent=new Agent(store,{provider:async history=>{
  if(++step===1)return{role:'assistant',content:null,tool_calls:[tool('private-result','read_page',{url:'https://example.invalid/'})]};
  toolMessage=history.find(message=>message.role==='tool');return{role:'assistant',content:'Done.'};
 },tools:{definitions:[{type:'function',function:{name:'read_page'}}],execute:async()=>({text:marker})}});
 try{
  const {run}=store.accept(conversation.id,'read page','private-result-run');await agent.execute(run);
  assert.ok(toolMessage?.content.includes(marker));
  const persisted=store.db.prepare("SELECT data FROM events WHERE conversation_id=? AND type='tool.result'").get(conversation.id).data;
  assert.equal(persisted.includes(marker),false);
  assert.equal(JSON.stringify(store.events(conversation.id,0)).includes(marker),false);
 }finally{await agent.close();store.close();}
});
