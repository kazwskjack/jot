import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';

const base=resolve(fileURLToPath(new URL('../../.test-tmp/browser-approval/',import.meta.url)));
const origin='https://browser-approval.fixture.invalid',csrf='browser-approval-csrf-fixture';
mkdirSync(base,{recursive:true});

async function fixture(t,{allowedTools=['browser_action'],owner='alice'}={}){
 const root=mkdtempSync(join(base,'case-')),token=randomBytes(32).toString('hex');let service,closed=false;
 const close=async()=>{if(closed)return;closed=true;if(service){await service.app.close();service.db.close();}const child=relative(base,resolve(root));assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});};
 t.after(close);
 service=await buildServer({databasePath:':memory:',workspaces:['main'],workbenchRoot:join(root,'shared'),uploadRoot:join(root,'uploads'),templateRoot:resolve(fileURLToPath(new URL('../../file-engine/templates/',import.meta.url))),internalChannelToken:token,csrfToken:csrf,allowedOrigins:[origin],modelBudgetRoutes:[{provider:'fixture',model:'bounded',revision:'browser-rates-v1',context_window:100,max_output_tokens:20,rates:{input:2,output:10,cache_read:1,cache_write:3}}]});
 const agent=service.workbench.createAgent(owner,{name:'Browser approval fixture',instructions:'Use browser actions only with owner approval.',allowed_tools:allowedTools});
 const input={client_message_id:'browser-approval-input',content:[{type:'text',text:'Inspect the controlled fixture.'}]};
 const admitted=await service.app.inject({method:'POST',url:`/v1/conversations/${agent.conversation_id}/messages`,headers:{'x-user-id':owner,origin,'x-csrf-token':csrf,'idempotency-key':'browser-approval-input'},payload:input});
 assert.equal(admitted.statusCode,202,admitted.body);
 const runId=String(service.db.prepare('SELECT id FROM ga_runs WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1').get(agent.conversation_id).id);
 service.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(runId);
 const sessionRef='browser-session-fixture',lease={owner:'browser-worker-fixture',generation:1},now=new Date().toISOString();
 service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(agent.conversation_id,owner,sessionRef,now,now);
 service.db.prepare('INSERT INTO ga_worker_leases VALUES(?,?,?,?,?)').run(runId,lease.owner,lease.generation,String(Date.now()+60000),now);
 const internal=(payload,authorization=`Bearer ${token}`)=>service.app.inject({method:'POST',url:'/internal/v1/workbench/browser-approval',headers:authorization?{authorization}:{},payload});
 const userPost=(url,payload,key=randomUUID())=>service.app.inject({method:'POST',url,headers:{'x-user-id':owner,origin,'x-csrf-token':csrf,'idempotency-key':key},payload});
 const scope={run_id:runId,session_ref:sessionRef,execution_lease:lease};
 return {...service,root,token,owner,agent,runId,sessionRef,lease,scope,internal,userPost,close};
}

function actionPayload(callId='browser-call-1',url='https://browser-approval.fixture.invalid/'){
 return {tool:'browser_action',operation_id:'browser-operation-fixture',call_id:callId,request_hash:'a'.repeat(64),url,action:'read'};
}
function expectedActionDigest(runId,sessionRef,callId,payload){
 const canonical=`{"action_payload":{"action":"read","call_id":${JSON.stringify(payload.call_id)},"operation_id":"browser-operation-fixture","request_hash":"${'a'.repeat(64)}","tool":"browser_action","url":${JSON.stringify(payload.url)}},"call_id":${JSON.stringify(callId)},"run_id":${JSON.stringify(runId)},"session_ref":${JSON.stringify(sessionRef)}}`;
 return 'sha256:'+createHash('sha256').update(canonical).digest('hex');
}

test('browser approval uses the existing owner interaction card and decision route for the exact current run',async t=>{
 const f=await fixture(t);try{
  const payload=actionPayload(),request=await f.internal({...f.scope,action:'request',call_id:payload.call_id,action_payload:payload,action_summary:'Browser read: https://browser-approval.fixture.invalid/'});
  assert.equal(request.statusCode,200,request.body);const card=request.json().interaction;
  const retry=await f.internal({...f.scope,action:'request',call_id:payload.call_id,action_payload:payload,action_summary:'Browser read: https://browser-approval.fixture.invalid/'});
  assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().interaction.interaction_id,card.interaction_id);
  assert.equal((await f.internal({...f.scope,action:'request',call_id:payload.call_id,action_payload:actionPayload(payload.call_id,'https://changed.fixture.invalid/'),action_summary:'Changed action'})).statusCode,409);
  assert.deepEqual({kind:card.kind,purpose:card.purpose,status:card.status,version:card.version,action_digest:card.action_digest,risk:card.risk},
   {kind:'approval',purpose:'browser_action',status:'pending',version:1,action_digest:expectedActionDigest(f.runId,f.sessionRef,payload.call_id,payload),risk:'medium'});
  assert.equal(card.action_summary,'Browser read: https://browser-approval.fixture.invalid/');
  assert.equal(f.db.prepare("SELECT count(*) n FROM ga_interactions WHERE run_id=?").get(f.runId).n,1);
  const listed=await f.app.inject({method:'GET',url:`/v1/conversations/${f.agent.conversation_id}/interactions`,headers:{'x-user-id':f.owner}});
  assert.equal(listed.statusCode,200);assert.equal(listed.json().items[0].interaction_id,card.interaction_id);
  const snapshot=await f.app.inject({method:'GET',url:`/v1/conversations/${f.agent.conversation_id}/snapshot`,headers:{'x-user-id':f.owner}});
  assert.equal(snapshot.statusCode,200);assert.equal(snapshot.json().interactions[0].purpose,'browser_action');
  assert.ok(f.events.replay(f.agent.conversation_id,0,100).some(event=>event.type==='interaction.requested'&&event.payload.interaction_id===card.interaction_id));
  const decision=await f.userPost(`/v1/interactions/${card.interaction_id}/decision`,{expected_version:card.version,action_digest:card.action_digest,decision:'approve'},'browser-approval-approve');
  assert.equal(decision.statusCode,202,decision.body);assert.equal(decision.json().accepted,true);
  const observed=await f.internal({...f.scope,action:'observe',interaction_id:card.interaction_id,call_id:payload.call_id,action_payload:payload});
  assert.equal(observed.statusCode,200,observed.body);assert.deepEqual(observed.json(),{state:'approved'});
  assert.equal(f.db.prepare("SELECT count(*) n FROM ga_run_commands WHERE run_id=? AND kind='interaction_decision'").get(f.runId).n,1);
 }finally{await f.close();}
});

test('browser denial and expiry use the existing decision route and return terminal browser states',async t=>{
 const f=await fixture(t);try{
  const deniedPayload=actionPayload('browser-denied-call'),created=await f.internal({...f.scope,action:'request',call_id:deniedPayload.call_id,action_payload:deniedPayload,action_summary:'Browser read.'});
  assert.equal(created.statusCode,200,created.body);const deniedCard=created.json().interaction;
  const denial=await f.userPost(`/v1/interactions/${deniedCard.interaction_id}/decision`,{expected_version:1,action_digest:deniedCard.action_digest,decision:'deny'},'browser-approval-deny');
  assert.equal(denial.statusCode,202,denial.body);
  const denied=await f.internal({...f.scope,action:'observe',interaction_id:deniedCard.interaction_id,call_id:deniedPayload.call_id,action_payload:deniedPayload});
  assert.equal(denied.statusCode,200,denied.body);assert.deepEqual(denied.json(),{state:'denied'});
  const expiredPayload=actionPayload('browser-expired-call'),expiredRequest=await f.internal({...f.scope,action:'request',call_id:expiredPayload.call_id,action_payload:expiredPayload,action_summary:'Browser read.'});
  assert.equal(expiredRequest.statusCode,200,expiredRequest.body);const expiredCard=expiredRequest.json().interaction;
  f.db.prepare('UPDATE ga_interactions SET expires_at=? WHERE id=?').run(new Date(Date.now()-1000).toISOString(),expiredCard.interaction_id);
  const expired=await f.internal({...f.scope,action:'observe',interaction_id:expiredCard.interaction_id,call_id:expiredPayload.call_id,action_payload:expiredPayload});
  assert.equal(expired.statusCode,200,expired.body);assert.deepEqual(expired.json(),{state:'expired'});
 }finally{await f.close();}
});

test('browser approval fails closed on absent or replaced lease, wrong session, role, or exact action',async t=>{
 const f=await fixture(t);try{
  const payload=actionPayload(),body={...f.scope,action:'request',call_id:payload.call_id,action_payload:payload,action_summary:'Browser read.'};
  assert.notEqual((await f.internal({...body,execution_lease:undefined})).statusCode,200);
  const other=await f.app.inject({method:'POST',url:'/v1/agents',headers:{'x-user-id':'bob',origin,'x-csrf-token':csrf,'idempotency-key':'browser-other-agent'},payload:{name:'Other owner',instructions:'Other owner',workspace_id:'main'}});
  assert.equal(other.statusCode,201,other.body);const otherConversation=other.json().conversation_id,now=new Date().toISOString();
  f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(otherConversation,'bob','foreign-browser-session',now,now);
  assert.notEqual((await f.internal({...body,session_ref:'foreign-browser-session'})).statusCode,200);
  assert.notEqual((await f.internal({...body,call_id:'browser-call-mismatch'})).statusCode,200);
  const created=await f.internal(body);assert.equal(created.statusCode,200,created.body);const card=created.json().interaction;
  assert.notEqual((await f.internal({...f.scope,action:'observe',interaction_id:card.interaction_id,call_id:payload.call_id,action_payload:actionPayload(payload.call_id,'https://changed.fixture.invalid/')})).statusCode,200);
  f.db.prepare('UPDATE ga_worker_leases SET generation=2 WHERE resource_id=?').run(f.runId);
  assert.notEqual((await f.internal({...f.scope,action:'observe',interaction_id:card.interaction_id,call_id:payload.call_id,action_payload:payload})).statusCode,200);
 }finally{await f.close();}
});

test('browser approval requires the frozen role to allow browser_action',async t=>{
 const f=await fixture(t,{allowedTools:['universe_search']});try{
  const defaultRole=f.workbench.createAgent(f.owner,{name:'Default browser-disabled role'});assert.equal(defaultRole.allowed_tools.includes('browser_action'),false);
  const payload=actionPayload(),response=await f.internal({...f.scope,action:'request',call_id:payload.call_id,action_payload:payload,action_summary:'Browser read.'});
  assert.notEqual(response.statusCode,200);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_interactions').get().n,0);
 }finally{await f.close();}
});
