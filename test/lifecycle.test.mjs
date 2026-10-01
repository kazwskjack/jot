import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Agent} from '../src/agent.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('the worker pool queues other conversations and cancellation never executes a queued request',async()=>{
  const store=new Store(':memory:');let release,started=0;
  const provider=async(messages,tools,signal)=>{started++;await new Promise((resolve,reject)=>{release=resolve;signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});return {role:'assistant',content:'done'};};
  const agent=new Agent(store,{provider,tools:{definitions:[]},maxWorkers:1});
  const first=store.accept(store.createConversation().id,'first','1').run;
  const second=store.accept(store.createConversation().id,'second','2').run;
  try {
    const a=agent.execute(first),b=agent.execute(second);await tick();
    assert.equal(store.run(second.id).status,'queued');assert.equal(started,1);
    agent.cancel(second.id);await b;assert.equal(store.run(second.id).status,'cancelled');
    release();await a;assert.equal(started,1);assert.equal(store.run(first.id).status,'succeeded');
  }finally{release?.();await agent.close();store.close();}
});

test('each approval is bound to its exact request and an old response cannot authorize the next action',async()=>{
  const store=new Store(':memory:');let turn=0,executed=0;
  const agent=new Agent(store,{provider:async()=>++turn===1?{role:'assistant',content:null,tool_calls:['one','two'].map(id=>({id,type:'function',function:{name:'file_write',arguments:'{}'}}))}:{role:'assistant',content:'done'},tools:{definitions:[],execute:async(name,args,ctx)=>{await ctx.approve('Create one file',{tool:name,name:'approved.txt'});executed++;return {ok:true};}}});
  const run=store.accept(store.createConversation().id,'write','1').run;
  try {
    const pending=agent.execute(run);await tick();let approval=store.snapshot(run.conversation_id).approval;
    assert.ok(approval.approval_id);assert.equal(agent.approve(run.id,true,'wrong'),false);assert.equal(executed,0);
    assert.equal(agent.approve(run.id,true,approval.approval_id),true);await tick();
    const next=store.snapshot(run.conversation_id).approval;assert.notEqual(next.approval_id,approval.approval_id);
    assert.equal(agent.approve(run.id,true,approval.approval_id),false);assert.equal(executed,1);
    assert.equal(agent.approve(run.id,false,next.approval_id),true);await pending;assert.equal(executed,1);
  }finally{await agent.close();store.close();}
});

test('unexpected provider failures do not publish credentials or commit a successful answer',async()=>{
  const store=new Store(':memory:');const agent=new Agent(store,{provider:async()=>{throw new Error('network failed with Bearer TOP_SECRET');},tools:{definitions:[]}});
  const run=store.accept(store.createConversation().id,'hello','1').run;
  try {await agent.execute(run);assert.equal(store.run(run.id).status,'failed');assert.equal(store.messages(run.conversation_id).length,1);assert.doesNotMatch(JSON.stringify(store.snapshot(run.conversation_id)),/TOP_SECRET/);}
  finally{await agent.close();store.close();}
});

test('server restart interrupts unfinished requests and never replays a browser action',()=>{
  const store=new Store(':memory:');
  try {const run=store.accept(store.createConversation().id,'click','1').run;store.state(run.id,'waiting_approval');store.recover();assert.equal(store.run(run.id).status,'interrupted');assert.equal(store.accept(run.conversation_id,'click','1').duplicate,true);}
  finally{store.close();}
});

test('a repeated model tool call ID returns its recorded result without repeating a side effect',async()=>{
  const store=new Store(':memory:');let turn=0,writes=0;
  const call={id:'once',type:'function',function:{name:'file_write',arguments:'{"name":"a.txt","text":"ok"}'}};
  const agent=new Agent(store,{provider:async()=>++turn<3?{role:'assistant',content:null,tool_calls:[call]}:{role:'assistant',content:'done'},tools:{definitions:[],execute:async()=>({written:++writes})}});
  const run=store.accept(store.createConversation().id,'write once','1').run;
  try {await agent.execute(run);assert.equal(writes,1);assert.equal(store.run(run.id).status,'succeeded');}
  finally{await agent.close();store.close();}
});

test('an uncertain click is not replayed when its tool call ID appears again',async()=>{
  const store=new Store(':memory:');let turn=0,clicks=0;
  const call={id:'maybe-clicked',type:'function',function:{name:'browser_action',arguments:'{"action":"click"}'}};
  const agent=new Agent(store,{provider:async()=>++turn<3?{role:'assistant',content:null,tool_calls:[call]}:{role:'assistant',content:'Could not verify the click.'},tools:{definitions:[],execute:async()=>{clicks++;throw new Error('browser_action_outcome_unknown');}}});
  const run=store.accept(store.createConversation().id,'click once','1').run;
  try {await agent.execute(run);assert.equal(clicks,1);}
  finally{await agent.close();store.close();}
});

test('the configured pool supports parallel conversations but never exceeds five workers',async()=>{
  const store=new Store(':memory:');let active=0,peak=0;const releases=[];
  const provider=async(messages,tools,signal)=>{active++;peak=Math.max(peak,active);try{await new Promise((resolve,reject)=>{releases.push(resolve);signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});return {role:'assistant',content:'done'};}finally{active--;}};
  const agent=new Agent(store,{provider,tools:{definitions:[]},maxWorkers:99});
  const runs=Array.from({length:6},(_,i)=>store.accept(store.createConversation().id,'task',''+i).run);
  try {
    const pending=runs.map(run=>agent.execute(run));await tick();assert.equal(active,5);assert.equal(store.run(runs[5].id).status,'queued');
    releases.shift()();await tick();assert.equal(store.run(runs[5].id).status,'running');
    for(const release of releases)release();await Promise.all(pending);assert.equal(peak,5);
  }finally{for(const release of releases)release();await agent.close();store.close();}
});
