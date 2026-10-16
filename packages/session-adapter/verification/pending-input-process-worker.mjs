// Synthetic local-model fixture. Never used by a product Host.
import assert from 'node:assert/strict';
import {join,relative,isAbsolute,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const [rootArg,stage,outcome]=process.argv.slice(2),root=resolve(rootArg??''),base=fileURLToPath(new URL('../../../.test-tmp/',import.meta.url)),rel=relative(base,root);
assert.ok(rel&&!isAbsolute(rel)&&!rel.startsWith('..'));assert.ok(['seed','recover','inspect'].includes(stage));assert.ok(['execute','cancel'].includes(outcome));
const runtime=process.env.JOT_DSH_RUNTIME_MODULES,scoped=join(root,'node_modules','@deepseek-ai');assert.ok(runtime&&isAbsolute(runtime));
const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop'],modules={};
for(const name of names)modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
const ctx=new modules.cordis.Context();let handle,calls=0;
const original={id:'persisted-original-input',role:'user',source:{kind:'user',rpcId:'original-product-run'},content:[{type:'text',text:'Complete this original synthetic input.'}]};
const send=body=>new Promise((resolve,reject)=>process.send(body,error=>error?reject(error):resolve()));
try{
 for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(root,'sessions'),compression:'none'}:{});
 class LocalAdapter extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;yield{type:'text-delta',index:0,text:'Persisted original completed.'};yield{type:'usage',usage:{inputTokens:5,outputTokens:1,totalTokens:6}};yield{type:'finish',reason:{kind:'stop'}};}}
 ctx.llm.registerAdapter(['local-pending'],new LocalAdapter());const sessionId='cold-pending-input';
 if(stage==='inspect'){
  assert.equal(ctx.agents.get(sessionId),undefined);const cold=await ctx.sessionQuery.readSession(sessionId);assert.equal(calls,0);assert.equal(ctx.agents.get(sessionId),undefined);
  const users=cold.events.filter(e=>e.type==='user/message');assert.equal(users.length,outcome==='execute'?1:0);if(users.length)assert.equal(users[0].data.id,original.id);
  const detached=modules['dsh-session'].Session.create(sessionId,cold.events,cold.session,cold.inheritedEventCount),projection=ctx.sessionProjections.snapshot(detached,['inbox']).values.inbox;
  assert.equal(projection['next-turn'].length,0);assert.equal(projection['next-step'].length,0);assert.equal(ctx.agents.get(sessionId),undefined);
  await send({kind:'inspected',calls,users:users.length,pending:0,attached:false});
 }else{
  if(stage==='seed')handle=await ctx.agents.create({sessionId,agentOptions:{provider:'local-pending',model:'scripted'}});
  else{assert.equal(ctx.agents.get(sessionId),undefined);handle=await ctx.agents.resume({resumeSessionId:sessionId,agentOptions:{provider:'local-pending',model:'scripted'}});}
  const agent=handle.agent;assert.equal(agent.jotPendingInputProtocol,1);
  if(stage==='seed'){
   agent.send(original,'next-turn',false);await ctx.sessionPersistence.flush(agent.session);
   const stored=await ctx.sessionPersistence.open(sessionId,'read');try{const saved=await stored.read(0,agent.session.seq);assert.deepEqual(saved.events,agent.session.snapshotEvents(0));}finally{await stored.close();}
   assert.equal(calls,0);await send({kind:'seeded',calls,sessionId,inputId:original.id,sourceRpcId:original.source.rpcId,seq:agent.session.seq});
   // Parent terminates this exact isolated process after the durable receipt.
   setInterval(()=>{},1000);await new Promise(()=>{});
  }else{
   await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);assert.deepEqual(agent.inbox.nextTurn,[original]);assert.deepEqual(agent.inbox.nextStep,[]);
   await agent.runMaintenance(async signal=>{const seq=agent.session.seq;agent.jotResumePending({requestId:original.source.rpcId,messageIds:[original.id],seq});assert.equal(agent.session.seq,seq);assert.deepEqual(agent.inbox.nextTurn,[original]);assert.equal(calls,0);if(outcome==='cancel'){agent.cancel({kind:'user'});assert.equal(signal.aborted,true);}});
   await agent.whenIdle();await ctx.sessionPersistence.flush(agent.session);const history=(await ctx.sessionQuery.readSession(sessionId)).events,users=history.filter(e=>e.type==='user/message');
   assert.equal(calls,outcome==='execute'?1:0);assert.equal(users.length,calls);if(users.length)assert.deepEqual(users[0].data,original);assert.equal(agent.inbox.hasPending,false);
   await send({kind:'recovered',calls,users:users.length,inputId:original.id,sourceRpcId:original.source.rpcId});
  }
 }
}finally{if(handle)await handle.dispose();await ctx.fiber.dispose();if(process.connected)process.disconnect();}
