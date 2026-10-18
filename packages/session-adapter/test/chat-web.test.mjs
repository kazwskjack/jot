import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {apply} from '../index.js';
import {WorkbenchBridge} from '../workbench.js';
const module=await import('../chat-web.js').catch(()=>({}));
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),hash=v=>createHash('sha256').update(canonical(v)).digest('hex');
const chat={protocol:1,mode:'chat',model:{provider:'fixture',model:'fast'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-native-v1',context_revision:'bounded-text-v1'};
function fixture(){
 assert.equal(typeof module.createChatWebSelector,'function','native Chat Web effect guard is not implemented');
 const binding={runId:'run-a',sessionRef:'session-a',executionLease:{owner:'worker-a',generation:1}},authority={protocol:1,run_id:'run-a',request_id:'run-a',input_message_id:'input-a',conversation_id:'conv-a',owner_id:'owner-a',session_id:'session-a',execution_lease:binding.executionLease,input_sha256:'a'.repeat(64),execution_authorized:false},policy={...chat,conversation_version:1,model_policy_sha256:'b'.repeat(64)},proof={...authority,policy,policy_sha256:hash(policy)};
 const events=[{seq:0,type:'user/message',data:{id:'context-a',source:{kind:'jot-chat-context',run_id:'run-a',execution_policy_sha256:hash(policy)}}},{seq:1,type:'user/message',data:{id:'native-a',source:{kind:'user',rpcId:'run-a'}}}],hooks=[],session={id:'session-a',header:{agentPreset:'jot-chat'},snapshotEvents:()=>structuredClone(events)},agent={id:session.id,session,ctx:{on:(name,fn)=>{assert.equal(name,'tools/execute');hooks.push(fn);return()=>{f.removes++;};}}};
 const seen=new Set(),groups=new Map(),f={binding,authority,proof,events,agent,hooks,calls:0,flushes:0,effects:0,removes:0};
 const bridge={request:async(path,_scope,payload)=>{f.calls++;if(path==='ordinary-input-binding')return{binding:structuredClone(authority)};if(path==='ordinary-execution-policy')return{execution:structuredClone(proof)};assert.equal(path,'ordinary-chat-web');const g=payload.group,key=g.kind;if(groups.has(key))assert.equal(groups.get(key),hash(g));groups.set(key,hash(g));const first=!seen.has(payload.call_id);seen.add(payload.call_id);return{reservation:{protocol:1,run_id:'run-a',session_id:'session-a',kind:g.kind,call_id:payload.call_id,group_sha256:hash(g),request_sha256:hash(g.calls.find(c=>c.call_id===payload.call_id).arguments),policy_sha256:hash(policy),first_dispatch:first,reason:first?'first_dispatch':'already_consumed'}};}};
 f.options={bridge,sessions:{flush:async()=>{f.flushes++;return true;}},chatPolicy:chat};
 f.prepare=async()=>{const select=module.createChatWebSelector(f.options);select.prepareAgent(agent);await select({agent,binding,signal:new AbortController().signal,check:async()=>{}});return select;};
 f.step=(step,calls)=>{events.push({seq:events.length,type:'assistant/message',data:{turn:1,step,message:{id:'assistant-'+step,role:'assistant',content:calls.map(([id,name,args])=>({type:'tool-call',id,name,arguments:JSON.stringify(args)}))}}});return calls.map(([id,name,args])=>{events.push({seq:events.length,type:'tool/call',data:{turn:1,step,callId:id,name,arguments:JSON.stringify(args)}});return{callId:id,name,arguments:args,agent,token:Symbol(),signal:new AbortController().signal};});};
 f.execute=async exec=>hooks.at(-1)(exec,async()=>{f.effects++;return{content:[{type:'text',text:'Synthetic Web result.'}]};});return f;
}
test('native group includes all same-step parallel members, is consumed before effects, and a retry never dispatches twice',async()=>{
 const f=fixture();await f.prepare();const calls=f.step(1,[['search-a','web_search',{queries:['synthetic one','synthetic two']}],['search-b','web_search',{queries:['synthetic three']}]]);
 await Promise.all(calls.map(f.execute));assert.equal(f.effects,2);assert.equal(f.flushes,2);
 await assert.rejects(f.execute(calls[0]),/CHAT_WEB_ALLOWANCE_CONSUMED/);assert.equal(f.effects,2);
 await f.prepare();await assert.rejects(f.execute(calls[0]),/CHAT_WEB_ALLOWANCE_CONSUMED/);assert.equal(f.effects,2);
});
test('changed native arguments, missing call provenance, and a foreign current context fail before effects',async()=>{
 for(const change of ['arguments','missing','context']){const f=fixture();await f.prepare();const [exec]=f.step(1,[['fetch-a','web_fetch',{url:'https://example.com/synthetic'}]]);if(change==='arguments')exec.arguments={url:'https://example.com/other'};if(change==='missing')f.events.pop();if(change==='context')f.events[0].data.source.run_id='other-run';await assert.rejects(f.execute(exec));assert.equal(f.effects,0);}
});
test('cancellation after durable reservation consumes the call without invoking the Web provider',async()=>{
 const f=fixture();await f.prepare();const [exec]=f.step(1,[['search-a','web_search',{queries:['synthetic']}]]),cancel=new AbortController();exec.signal=cancel.signal;const request=f.options.bridge.request;f.options.bridge.request=async(...args)=>{const result=await request(...args);if(args[0]==='ordinary-chat-web')cancel.abort(Error('synthetic cancellation'));return result;};
 await assert.rejects(f.execute(exec));assert.equal(f.effects,0);f.options.bridge.request=request;exec.signal=new AbortController().signal;await assert.rejects(f.execute(exec),/CHAT_WEB_ALLOWANCE_CONSUMED/);assert.equal(f.effects,0);
});
test('Work has no Chat Web hook or bridge traffic',async()=>{const f=fixture();f.agent.session.header.agentPreset='jot-general';await f.prepare();assert.equal(f.calls,0);assert.equal(f.hooks.length,0);});
test('Chat Web enforcement cannot be enabled without its original Chat context and execution configuration',()=>{for(const config of [{ordinaryChatWeb:true},{ordinaryChatWeb:'true'}])assert.throws(()=>apply({},config),/chat_web_config_invalid/);});
test('a newly created or restored Chat agent denies Web effects before original admission binds it',async()=>{const f=fixture(),select=module.createChatWebSelector(f.options);select.prepareAgent(f.agent);const [exec]=f.step(1,[['search-a','web_search',{queries:['synthetic']}]]);await assert.rejects(f.execute(exec));assert.equal(f.calls,0);assert.equal(f.effects,0);});
test('only the exact authenticated allowance denial is distinct from permission failure',async()=>{
 for(const [status,code,expected] of [[409,'CHAT_WEB_ALLOWANCE_CONSUMED','CHAT_WEB_ALLOWANCE_CONSUMED'],[401,'CHAT_WEB_ALLOWANCE_CONSUMED','workbench_run_forbidden'],[409,'CHAT_WEB_UNCONFIRMED','workbench_run_forbidden']]){
  const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:18880',token:randomBytes(32).toString('hex'),fetchImpl:async()=>new Response(JSON.stringify({error:{code}}),{status})});
  await assert.rejects(bridge.request('ordinary-chat-web',{runId:'run-a',sessionRef:'session-a'}),error=>error.message===expected);
 }
});
test('adapter and agent disposal remove their guard and fence an in-flight management reply',async()=>{
 const f=fixture(),selector=await f.prepare();assert.equal(typeof selector.dispose,'function','the Web guard must have an owned disposal boundary');assert.equal(typeof selector.disposeAgent,'function');
 const [exec]=f.step(1,[['search-a','web_search',{queries:['synthetic']}]]);let release,entered;const waiting=new Promise(done=>entered=done),request=f.options.bridge.request;
 f.options.bridge.request=async(...args)=>{const result=await request(...args);if(args[0]==='ordinary-chat-web'){entered();await new Promise(done=>release=done);}return result;};
 const pending=f.execute(exec);pending.catch(()=>{});await waiting;selector.dispose();assert.equal(f.removes,1);release();await assert.rejects(pending);assert.equal(f.effects,0);await assert.rejects(selector({agent:f.agent,binding:f.binding,signal:new AbortController().signal,check:async()=>{}}));
});
for(const scope of ['adapter','agent'])test('disposal during '+scope+' admission cannot revive a captured Web binding',async()=>{
 const f=fixture(),selector=module.createChatWebSelector(f.options);let entered,release;const waiting=new Promise(done=>entered=done),request=f.options.bridge.request;
 f.options.bridge.request=async(...args)=>{const result=await request(...args);if(args[0]==='ordinary-input-binding'){entered();await new Promise(done=>release=done);}return result;};
 const pending=selector({agent:f.agent,binding:f.binding,signal:new AbortController().signal,check:async()=>{}});pending.catch(()=>{});await waiting;if(scope==='adapter')selector.dispose();else selector.disposeAgent(f.agent);release();await assert.rejects(pending);assert.equal(f.removes,1);
});
