import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildServer} from '../../src/server.ts';

const model={provider:'local-scripted',model:'work-model',reasoning_effort:'high'};
const chatPolicy={protocol:1,mode:'chat',model:{provider:'local-scripted',model:'fast-model'},thinking:'disabled',preset_id:'jot-chat',preset_revision:'chat-v1',context_revision:'bounded-v1'};
const idle=session_id=>({protocol:1,session_id,basis:'live',native_idle:'idle',reason:null,observed_at:1,execution_authorized:false});
const readyClient=(patch={})=>({conversationModeReadiness:async()=>({protocol:1,ready:true,policy:chatPolicy}),conversationGoal:async()=>({goal:null}),observeNativeIdle:async session=>idle(session),...patch});
async function fixture(t,client,options={}){
 const service=await buildServer({databasePath:':memory:',workspaces:['ws'],conversationModeClient:client,chatModeEnabled:!!client,...options});
 t.after(async()=>{await service.app.close();service.db.close();});
 const headers={'x-user-id':'mode-owner'},post=(payload)=>service.app.inject({method:'POST',url:'/v1/conversations',headers,payload:{workspace_id:'ws',model,...payload}});
 const patch=(id,payload,owner='mode-owner')=>service.app.inject({method:'PATCH',url:`/v1/conversations/${id}`,headers:{'x-user-id':owner},payload});
 return{...service,headers,post,patch};
}

test('legacy and explicit Work creation keep Work while unavailable Chat fails before creating a conversation',async t=>{
 const f=await fixture(t);
 for(const payload of [{},{mode:'work'}]){const response=await f.post(payload);assert.equal(response.statusCode,201,response.body);assert.equal(response.json().mode,'work');}
 const count=f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n;
 const denied=await f.post({mode:'chat'});assert.equal(denied.statusCode,503,denied.body);assert.equal(denied.json().error.code,'CHAT_MODE_UNAVAILABLE');
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n,count);
 const capabilities=await f.app.inject({method:'GET',url:'/v1/capabilities',headers:f.headers});
 assert.equal(capabilities.json().conversation_modes.chat.ready,false);
 assert.equal((await f.post({mode:'invented'})).statusCode,400);
 assert.equal((await f.post({mode:'work',mode_policy:chatPolicy})).statusCode,400);
});

test('owned CAS mode switches use distinct native identities and accepted runs freeze the server Chat policy',async t=>{
 let ready=true;const f=await fixture(t,readyClient({conversationModeReadiness:async()=>ready?{protocol:1,ready:true,policy:chatPolicy}:{protocol:1,ready:false}}));
 const created=(await f.post({mode:'work'})).json(),id=created.conversation_id;
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(id,'mode-owner','original-work-session','now','now');
 const switched=await f.patch(id,{expected_version:created.version,mode:'chat'});assert.equal(switched.statusCode,200,switched.body);assert.equal(switched.json().mode,'chat');
 assert.equal(f.db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(id).session_id,'original-work-session');
 const bindings=f.db.prepare('SELECT mode,session_id FROM ga_conversation_mode_sessions WHERE conversation_id=? ORDER BY mode').all(id);assert.deepEqual(bindings.map(b=>b.mode),['chat','work']);assert.notEqual(bindings[0].session_id,bindings[1].session_id);
 assert.equal((await f.patch(id,{expected_version:created.version,mode:'work'})).statusCode,409);
 assert.equal((await f.patch(id,{expected_version:switched.json().version,mode:'work'},'other-owner')).statusCode,404);
 const send=()=>f.app.inject({method:'POST',url:`/v1/conversations/${id}/messages`,headers:f.headers,payload:{client_message_id:'chat-original',content:[{type:'text',text:'Synthetic question'}]}});
 const accepted=await send();assert.equal(accepted.statusCode,202,accepted.body);
 const row=f.db.prepare('SELECT execution_policy_json,model_policy_json,native_session_ref FROM ga_runs WHERE id=?').get(accepted.json().run_id);
 assert.equal(row.native_session_ref,bindings[0].session_id);assert.deepEqual(JSON.parse(row.model_policy_json).model,chatPolicy.model);
 assert.equal(JSON.parse(row.execution_policy_json).mode,'chat');assert.equal(JSON.parse(row.execution_policy_json).thinking,'disabled');
 assert.equal((await f.patch(id,{expected_version:switched.json().version,mode:'work'})).statusCode,409);
 ready=false;const replay=await send();assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().run_id,accepted.json().run_id);
 const next=await f.app.inject({method:'POST',url:`/v1/conversations/${id}/messages`,headers:f.headers,payload:{client_message_id:'chat-next',content:[{type:'text',text:'Next synthetic question'}]}});assert.equal(next.statusCode,503,next.body);
 assert.throws(()=>f.db.prepare('UPDATE ga_runs SET execution_policy_json=NULL WHERE id=?').run(accepted.json().run_id),/execution_policy_immutable/);
});

test('every active product state and a legacy unknown identity block a switch without allocating Chat',async t=>{
 const f=await fixture(t,readyClient()),created=await f.post({mode:'work',title:'Synthetic mode test'});assert.equal(created.statusCode,201);const c=created.json(),id=c.conversation_id;
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(id,'mode-owner','guard-work','now','now');
 const source=f.runs.enqueue(id,'mode-owner',{client_message_id:'guard-input',content:[{type:'text',text:'Synthetic active input'}]});
 for(const status of ['queued','starting','running','waiting_user','waiting_approval','cancelling']){
  f.db.prepare('UPDATE ga_runs SET status=? WHERE id=?').run(status,source.run_id);
  const response=await f.patch(id,{expected_version:c.version,mode:'chat'});assert.equal(response.statusCode,409,status);assert.equal(response.json().error.code,'ACTIVE_RUN_MODE_CHANGE');
 }
 f.db.prepare("UPDATE ga_runs SET status='succeeded' WHERE id=?").run(source.run_id);
 f.db.prepare("INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,'interrupted','now','now')").run('ambiguous-legacy',id);
 const unknown=await f.patch(id,{expected_version:c.version,mode:'chat'});assert.equal(unknown.statusCode,409,unknown.body);assert.equal(unknown.json().error.code,'CONVERSATION_MODE_LEGACY_UNCONFIRMED');
 assert.equal(f.conversations.get(id,'mode-owner').mode,'work');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_conversation_mode_sessions WHERE mode='chat'").get().n,0);
});

test('active or armed Work Goals, unavailable native state and busy Agents never permit a switch',async t=>{
 let view={goal:null},observation=session=>idle(session);const f=await fixture(t,readyClient({conversationGoal:async()=>view,observeNativeIdle:async session=>observation(session)}));
 const c=(await f.post({title:'Synthetic native guard'})).json(),id=c.conversation_id;f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(id,'mode-owner','native-guard','now','now');
 for(const [phase,activation] of [['active','disarmed'],['paused','armed'],['complete','armed']]){
  view={goal:{id:'fixture-goal',revision:1,objective:'Synthetic goal',phase,activation}};
  const result=await f.patch(id,{expected_version:c.version,mode:'chat'});assert.equal(result.statusCode,409,result.body);assert.equal(result.json().error.code,'CONVERSATION_MODE_GOAL_ACTIVE');
 }
 view={goal:null};for(const state of [{native_idle:'busy',reason:'AGENT_RUNNING'},{native_idle:'unknown',reason:'STATE_UNAVAILABLE'}]){
  observation=session=>({...idle(session),...state});const result=await f.patch(id,{expected_version:c.version,mode:'chat'});assert.equal(result.statusCode,409,result.body);
 }
 observation=()=>{throw Error('synthetic-private-diagnostic');};const failed=await f.patch(id,{expected_version:c.version,mode:'chat'});assert.equal(failed.statusCode,409);assert.ok(!failed.body.includes('synthetic-private'));
 assert.equal(f.conversations.get(id,'mode-owner').mode,'work');
});

test('a version change during native preflight refuses the original mode mutation',async t=>{
 let id;const f=await fixture(t,readyClient({conversationGoal:async()=>{f.db.prepare('UPDATE ga_conversations SET version=version+1 WHERE id=?').run(id);return{goal:null};}}));
 const c=(await f.post({title:'Synthetic preflight race'})).json();id=c.conversation_id;f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(id,'mode-owner','race-work','now','now');
 const changed=await f.patch(id,{expected_version:c.version,mode:'chat'});assert.equal(changed.statusCode,409,changed.body);
 assert.equal(f.conversations.get(id,'mode-owner').mode,'work');assert.equal(f.db.prepare("SELECT count(*) n FROM ga_conversation_mode_sessions WHERE mode='chat'").get().n,0);
});

test('timed out native observation cannot issue a later Goal read or mutate the conversation',async t=>{
 const entered=Promise.withResolvers(),later=Promise.withResolvers();let goals=0;
 const f=await fixture(t,readyClient({observeNativeIdle:async()=>{entered.resolve();return later.promise;},conversationGoal:async()=>{goals++;return{goal:null};}}));
 const c=(await f.post({title:'Synthetic deadline'})).json();f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(c.conversation_id,'mode-owner','deadline-work','now','now');
 const originalTimeout=AbortSignal.timeout,deadline=new AbortController();AbortSignal.timeout=ms=>ms===5000?deadline.signal:originalTimeout.call(AbortSignal,ms);t.after(()=>{AbortSignal.timeout=originalTimeout;});
 const pending=f.patch(c.conversation_id,{expected_version:c.version,mode:'chat'});await entered.promise;deadline.abort(Error('fixture-deadline'));
 assert.equal((await pending).statusCode,409);later.resolve(idle('deadline-work'));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(goals,0);assert.equal(f.conversations.get(c.conversation_id,'mode-owner').mode,'work');
});

test('mode receipt and accepted input commit atomically and replay without consulting an unavailable Host',async t=>{
 const csrf=randomBytes(24).toString('hex'),origin='https://fixture.invalid';let offline=false,loseMode=true,loseSend=true,calls=0;
 const f=await fixture(t,readyClient({conversationModeReadiness:async()=>{calls++;if(offline)throw Error('fixture-offline');return{protocol:1,ready:true,policy:chatPolicy};}}),{csrfToken:csrf,allowedOrigins:[origin]});
 f.app.addHook('onSend',async(request,reply,payload)=>{if(request.method==='PATCH'&&reply.statusCode===200&&loseMode){loseMode=false;throw Error('fixture_mode_ack_lost');}if(request.url.endsWith('/messages')&&reply.statusCode===202&&loseSend){loseSend=false;throw Error('fixture_input_ack_lost');}return payload;});
 const headers={...f.headers,origin,'x-csrf-token':csrf,'idempotency-key':'mode-create-fixture'};
 const created=await f.app.inject({method:'POST',url:'/v1/conversations',headers,payload:{workspace_id:'ws',title:'Synthetic receipt',model}});assert.equal(created.statusCode,201,created.body);const c=created.json();
 const mutation={method:'PATCH',url:`/v1/conversations/${c.conversation_id}`,headers:{...headers,'idempotency-key':'mode-switch-fixture'},payload:{expected_version:c.version,mode:'chat'}};
 assert.equal((await f.app.inject(mutation)).statusCode,500);assert.equal(f.db.prepare("SELECT response_status FROM ga_idempotency WHERE idempotency_key='mode-switch-fixture'").get().response_status,200);
 offline=true;const switched=await f.app.inject(mutation);assert.equal(switched.statusCode,200,switched.body);assert.equal(switched.json().mode,'chat');assert.equal(calls,1);
 offline=false;const send={method:'POST',url:`/v1/conversations/${c.conversation_id}/messages`,headers:{...headers,'idempotency-key':'mode-input-fixture'},payload:{client_message_id:'receipt-input',content:[{type:'text',text:'Synthetic receipt question'}]}};
 assert.equal((await f.app.inject(send)).statusCode,500);offline=true;const accepted=await f.app.inject(send);assert.equal(accepted.statusCode,202,accepted.body);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);assert.equal(calls,2);
 assert.equal((await f.app.inject({...send,payload:{...send.payload,client_message_id:'changed-input'}})).statusCode,409);
});

test('a role conversation cannot become Chat and Chat model controls are fixed',async t=>{
 const f=await fixture(t,readyClient()),role=f.workbench.createAgent('mode-owner',{name:'Synthetic role',workspace_id:'ws',allowed_tools:[]});
 const before=f.conversations.get(role.conversation_id,'mode-owner');const denied=await f.patch(before.conversation_id,{expected_version:before.version,mode:'chat'});assert.equal(denied.statusCode,409,denied.body);assert.equal(denied.json().error.code,'CONVERSATION_MODE_SCOPE_INVALID');
 const created=await f.post({mode:'chat'});assert.equal(created.statusCode,201,created.body);const c=created.json();
 const modelChange=await f.patch(c.conversation_id,{expected_version:c.version,model:{provider:'other',model:'other'}});assert.equal(modelChange.statusCode,409);assert.equal(modelChange.json().error.code,'CHAT_MODEL_FIXED');
});

test('malformed readiness, extra policy fields and a disabled API cannot advertise Chat',async t=>{
 for(const response of [{protocol:1,ready:false},{protocol:1,ready:true,policy:{...chatPolicy,thinking:'enabled'}},{protocol:1,ready:true,policy:{...chatPolicy,secret:'synthetic-extra'}},null]){
  const f=await fixture(t,readyClient({conversationModeReadiness:async()=>response}));const denied=await f.post({mode:'chat'});assert.equal(denied.statusCode,503,denied.body);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversations').get().n,0);
 }
 const disabled=await fixture(t,readyClient(),{chatModeEnabled:false});assert.equal((await disabled.post({mode:'chat'})).statusCode,503);
});

test('Chat can observe its preserved Work Goal but cannot advertise or admit Work Goal resume',async t=>{
 const goal={id:'preserved-work-goal',revision:1,objective:'Synthetic Work goal',phase:'paused',activation:'disarmed'};
 const client=readyClient({conversationGoal:async()=>({goal}),conversationGoalResumeReadiness:async()=>({ready:true})});
 const f=await fixture(t,client,{conversationGoalClient:client,conversationGoalResumeEnabled:true}),c=(await f.post({title:'Preserved Work Goal'})).json();
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(c.conversation_id,'mode-owner','preserved-work-session','now','now');
 const switched=await f.patch(c.conversation_id,{expected_version:c.version,mode:'chat'});assert.equal(switched.statusCode,200,switched.body);
 const url=`/v1/conversations/${c.conversation_id}/goal`,view=await f.app.inject({method:'GET',url,headers:f.headers});assert.equal(view.statusCode,200);assert.deepEqual(view.json(),{goal});
 const readiness=await f.app.inject({method:'GET',url:url+'/resume-readiness',headers:f.headers});assert.equal(readiness.statusCode,409,readiness.body);
 const resume=await f.app.inject({method:'POST',url,headers:{...f.headers,'idempotency-key':'chat-goal-forbidden'},payload:{action:'resume',id:goal.id,revision:goal.revision}});assert.equal(resume.statusCode,409);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_conversation_goal_controls').get().n,0);
});

test('disabling new Chat admission still permits a verified return to the saved Work Session',async t=>{
 const f=await fixture(t,readyClient(),{chatModeEnabled:false}),c=(await f.post({})).json();
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(c.conversation_id,'mode-owner','saved-work','now','now');
 f.db.prepare("UPDATE ga_conversations SET mode='chat' WHERE id=?").run(c.conversation_id);
 f.db.prepare('INSERT INTO ga_conversation_mode_sessions(conversation_id,mode,owner_id,session_id,created_at) VALUES(?,?,?,?,?)').run(c.conversation_id,'chat','mode-owner','saved-chat','now');
 const switched=await f.patch(c.conversation_id,{expected_version:c.version,mode:'work'});
 assert.equal(switched.statusCode,200,switched.body);assert.equal(switched.json().mode,'work');
 assert.equal((await f.post({mode:'chat'})).statusCode,503);
 assert.equal(f.db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(c.conversation_id).session_id,'saved-work');
});
