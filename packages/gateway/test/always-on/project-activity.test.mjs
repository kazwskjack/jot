import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,symlinkSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {DatabaseSync} from 'node:sqlite';
import {openProductDatabase} from '../../src/db/database.ts';import {WorkbenchService} from '../../src/workbench/service.ts';
import {createServer} from 'node:http';import {createAdapterHandler} from '../../../session-adapter/index.js';import {SessionControllerClient} from '../../src/harness/session-controller-client.ts';
const Observer=(await import('../../src/always-on/project-activity.ts').catch(()=>({}))).ProjectActivityObserver;

test('only an issued fresh idle observation can be revalidated inside admission transaction',async t=>{
 const f=fixture(t),observer=f.observer(),receipt=await observer.observe(f.scope);
 assert.equal(typeof observer.isCurrent,'function');
 f.db.exec('BEGIN IMMEDIATE');try{assert.equal(observer.isCurrent(receipt),true);assert.equal(observer.isCurrent({...receipt}),false);}finally{f.db.exec('ROLLBACK');}
 f.db.prepare('UPDATE wb_agents SET version=version+1 WHERE agent_id=?').run(f.agent.agent_id);
 assert.equal(observer.isCurrent(receipt),false);
});
function fixture(t,{ready=true,bound=true}={}){
 const root=mkdtempSync(join(tmpdir(),'jot-project-observation-')),db=openProductDatabase(join(root,'db.sqlite')),workbench=new WorkbenchService(db,{root:join(root,'shared'),workspaceIds:['ws']});
 t.after(()=>{db.close();rmSync(root,{recursive:true,force:true});});
 const agent=workbench.createAgent('owner',{name:'Synthetic observer',instructions:'private instructions'}),scope={owner_id:'owner',project_id:agent.project_id,workspace_id:'ws',agent_id:agent.agent_id};
 if(ready)workbench.projectRoot('owner','ws',agent.project_id);
 const bind=(conversation,id)=>db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(conversation,'owner',id,'now','now');
 if(bound)bind(agent.conversation_id,'session-1');
 const calls=[],native={nativeIdleObservationReadiness:async()=>({protocol:1,ready:true,execution_authorized:false}),observeNativeIdle:async id=>{calls.push(id);assert.equal(db.isTransaction,false);return {protocol:1,session_id:id,basis:'live',native_idle:'idle',reason:null,observed_at:10000,execution_authorized:false};}};
 return {root,db,workbench,scope,agent,native,calls,bind,observer:()=>new Observer({db,workbench,native,now:()=>10000,maxAgeMs:1000})};
}
test('project observation reads owned existing sources without SQL or filesystem writes',async t=>{
 const f=fixture(t),before=f.db.prepare('SELECT total_changes() AS n').get().n,files=readdirSync(join(f.root,'shared'));
 const result=await f.observer().observe(f.scope);assert.equal(result.reason,null);assert.equal(result.facts.native_idle,'idle');assert.equal(result.facts.role_version,1);assert.equal(result.facts.session_count,1);assert.equal(result.execution_authorized,false);assert.ok(Object.isFrozen(result.facts));assert.match(result.source_sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual(f.calls,['session-1']);assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);assert.deepEqual(readdirSync(join(f.root,'shared')),files);assert.ok(!JSON.stringify(result).includes('private instructions'));
});
test('absent workspace is observed without creating a directory',async t=>{const f=fixture(t,{ready:false}),result=await f.observer().observe(f.scope);assert.equal(result.reason,'WORKSPACE_UNAVAILABLE');assert.deepEqual(readdirSync(join(f.root,'shared')),[]);assert.deepEqual(f.calls,[]);});
test('empty native bindings are unknown rather than idle',async t=>{const f=fixture(t,{bound:false}),result=await f.observer().observe(f.scope);assert.equal(result.reason,'SESSION_BINDING_MISSING');assert.equal(result.facts.native_idle,'unknown');assert.deepEqual(f.calls,[]);});
test('foreign or changed scope is rejected before Host observation',async t=>{const f=fixture(t);for(const patch of [{owner_id:'other'},{project_id:'other'},{workspace_id:'other'},{agent_id:'other'},{extra:true}])await assert.rejects(()=>f.observer().observe({...f.scope,...patch}),/discovery_scope_unavailable/);assert.deepEqual(f.calls,[]);});
test('disabled role and queued runs prevent positive idle advice',async t=>{
 const f=fixture(t);f.db.prepare("UPDATE wb_agents SET status='disabled' WHERE agent_id=?").run(f.agent.agent_id);assert.equal((await f.observer().observe(f.scope)).reason,'ROLE_UNAVAILABLE');
 f.db.prepare("UPDATE wb_agents SET status='active' WHERE agent_id=?").run(f.agent.agent_id);f.db.prepare('INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run('run',f.agent.conversation_id,'queued','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');assert.equal((await f.observer().observe(f.scope)).reason,'AGENT_BUSY');assert.deepEqual(f.calls,[]);
});
test('all scoped conversations including archived ones are observed, not other owners',async t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,project_id,title,model,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?,?,?,?)').run('archived','owner','ws',f.agent.project_id,'private title','{}','now','now','now');f.bind('archived','session-2');
 f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,project_id,title,model,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('foreign','other','ws',f.agent.project_id,'hidden','{}','now','now');
 const result=await f.observer().observe(f.scope);assert.equal(result.facts.session_count,2);assert.deepEqual(f.calls.sort(),['session-1','session-2']);assert.ok(!JSON.stringify(result).includes('private title'));
});
test('native busy, unknown, malformed, stale and unavailable facts stay non-authorizing',async t=>{
 const f=fixture(t);for(const [patch,reason]of [[{native_idle:'busy',reason:'AGENT_RUNNING'},'AGENT_BUSY'],[{native_idle:'unknown',reason:'STATE_UNAVAILABLE'},'NATIVE_IDLE_UNCONFIRMED'],[{session_id:'other'},'NATIVE_IDLE_UNCONFIRMED'],[{observed_at:8999},'OBSERVATION_STALE'],[{observed_at:10001},'OBSERVATION_STALE'],[{execution_authorized:true},'NATIVE_IDLE_UNCONFIRMED']]){f.native.observeNativeIdle=async id=>({protocol:1,session_id:id,basis:'live',native_idle:'idle',reason:null,observed_at:10000,execution_authorized:false,...patch});assert.equal((await f.observer().observe(f.scope)).reason,reason);}
 f.native.nativeIdleObservationReadiness=async()=>{throw Error('private error');};assert.equal((await f.observer().observe(f.scope)).reason,'HOST_UNAVAILABLE');
});
test('role or binding drift while observing Host invalidates the snapshot',async t=>{
 const f=fixture(t),original=f.native.observeNativeIdle;f.native.observeNativeIdle=async id=>{f.db.prepare('UPDATE wb_agents SET version=version+1 WHERE agent_id=?').run(f.agent.agent_id);return original(id);};assert.equal((await f.observer().observe(f.scope)).reason,'SOURCE_CHANGED');
 f.native.observeNativeIdle=async id=>{f.db.prepare("UPDATE ga_harness_session_bindings SET session_id='session-new' WHERE conversation_id=?").run(f.agent.conversation_id);return original(id);};assert.equal((await f.observer().observe(f.scope)).reason,'SOURCE_CHANGED');
});
test('observer aborts before accessing Host and cannot run inside a caller write transaction',async t=>{
 const f=fixture(t),signal=AbortSignal.abort();await assert.rejects(()=>f.observer().observe(f.scope,signal));assert.deepEqual(f.calls,[]);
 f.db.exec('BEGIN IMMEDIATE');try{await assert.rejects(()=>f.observer().observe(f.scope),/discovery_observation_transaction_active/);}finally{f.db.exec('ROLLBACK');}
});
test('observations must still be fresh after all Host and final source reads',async t=>{
 const f=fixture(t);let reads=0;const observer=new Observer({db:f.db,workbench:f.workbench,native:f.native,maxAgeMs:1000,now:()=>++reads<3?10000:11001});assert.equal((await observer.observe(f.scope)).reason,'OBSERVATION_STALE');
});
test('another database connection can write during Host IO and new input invalidates the original source',async t=>{
 const f=fixture(t),other=new DatabaseSync(join(f.root,'db.sqlite'));const original=f.native.observeNativeIdle;
 f.native.observeNativeIdle=async id=>{other.prepare('INSERT INTO ga_messages(id,conversation_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('input',f.agent.conversation_id,'user','committed','[]','1970-01-01T00:00:09.000Z','1970-01-01T00:00:09.000Z');return original(id);};
 try{assert.equal((await f.observer().observe(f.scope)).reason,'SOURCE_CHANGED');}finally{other.close();}
});
test('existing workspace symlink substitution cannot report readiness',async t=>{
 const f=fixture(t),dir=f.workbench.projectRoot('owner','ws',f.agent.project_id);rmSync(dir,{recursive:true});symlinkSync(f.root,dir,'junction');assert.equal((await f.observer().observe(f.scope)).reason,'WORKSPACE_UNAVAILABLE');assert.deepEqual(f.calls,[]);
});
test('lost Host readiness never invokes any Session observation',async t=>{
 const f=fixture(t);for(const ready of [{protocol:1,ready:false,execution_authorized:false},{protocol:1,ready:true,execution_authorized:false,extra:1},null]){f.native.nativeIdleObservationReadiness=async()=>ready;assert.equal((await f.observer().observe(f.scope)).reason,'HOST_UNAVAILABLE');}assert.deepEqual(f.calls,[]);
});
test('read-only workspace inspection validates ownership and does not create defaults',t=>{
 const f=fixture(t,{ready:false}),before=f.db.prepare('SELECT total_changes() AS n').get().n;
 assert.equal(f.workbench.projectWorkspaceReady('owner','ws',f.agent.project_id),false);assert.throws(()=>f.workbench.projectWorkspaceReady('other','ws',f.agent.project_id),/project_not_found/);assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n,before);
});
test('native child Session bindings are included without exposing their private snapshots',async t=>{
 const f=fixture(t);for(const id of ['root-run','child-run'])f.db.prepare('INSERT INTO ga_runs(id,conversation_id,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,f.agent.conversation_id,'succeeded','1970-01-01T00:00:01.000Z','1970-01-01T00:00:02.000Z');
 f.db.prepare('INSERT INTO wb_native_child_reservations(reservation_id,owner_id,root_run_id,task_id,occurrence_id,child_session_ref,request_id,input_hash,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('reservation','owner','root-run','task','occurrence','session-child','request','hash','{"private":"source text"}','now');
 f.db.prepare('INSERT INTO wb_native_child_runs(run_id,reservation_id,owner_id,root_run_id,task_id,occurrence_id,role_id,child_session_ref,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('child-run','reservation','owner','root-run','task','occurrence',f.agent.agent_id,'session-child','now');
 const result=await f.observer().observe(f.scope);assert.equal(result.reason,null);assert.equal(result.facts.session_count,2);assert.deepEqual(f.calls,['session-1','session-child']);assert.equal(result.facts.last_terminal_at,2000);assert.ok(!JSON.stringify(result).includes('source text'));
});
test('stored user inputs supply cooldown evidence while malformed dates are not guessed',async t=>{
 const f=fixture(t);f.db.prepare('INSERT INTO ga_messages(id,conversation_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('input',f.agent.conversation_id,'user','committed','[{"type":"text","text":"private input"}]','1970-01-01T00:00:09.000Z','1970-01-01T00:00:09.000Z');assert.equal((await f.observer().observe(f.scope)).facts.last_user_input_at,9000);
 for(const stamp of ['not a date','2026-02-31T00:00:00.000Z','2026-01-01T00:00:00.000Z']){f.db.prepare('UPDATE ga_messages SET created_at=? WHERE id=?').run(stamp,'input');await assert.rejects(()=>f.observer().observe(f.scope),/discovery_source_unconfirmed/);}
});
test('same-count input replacement at the same timestamp still changes source identity',async t=>{
 const f=fixture(t),stamp='1970-01-01T00:00:09.000Z',insert=id=>f.db.prepare('INSERT INTO ga_messages(id,conversation_id,role,status,content_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,f.agent.conversation_id,'user','committed','[]',stamp,stamp);insert('old-input');const original=f.native.observeNativeIdle;
 f.native.observeNativeIdle=async id=>{f.db.prepare("DELETE FROM ga_messages WHERE id='old-input'").run();insert('new-input');return original(id);};assert.equal((await f.observer().observe(f.scope)).reason,'SOURCE_CHANGED');
});
test('existing non-opaque owner identities retain the original Workbench ownership contract',async t=>{
 const f=fixture(t),owner='用户@example.test',agent=f.workbench.createAgent(owner,{name:'Owned role'});f.workbench.projectRoot(owner,'ws',agent.project_id);f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(agent.conversation_id,owner,'session-owned','now','now');
 const result=await f.observer().observe({owner_id:owner,project_id:agent.project_id,workspace_id:'ws',agent_id:agent.agent_id});assert.equal(result.reason,null);assert.deepEqual(f.calls,['session-owned']);
});
test('real project sources reach the authenticated HTTP adapter through the real Gateway client',async t=>{
 const f=fixture(t),token='test-project-observation-token-value',agent={id:'session-1',session:{id:'session-1'},status:'idle',inbox:{nextTurn:[],nextStep:[]},ctx:{get:()=>({get:()=>null})}};
 const handler=createAdapterHandler({token,nativeIdleObservation:true,agents:{get:id=>{assert.equal(id,'session-1');assert.equal(f.db.isTransaction,false);return agent;}},controller:{projections:()=>assert.fail('live observation must not load projections'),create:()=>assert.fail('must not create Agent'),prompt:()=>assert.fail('must not prompt')}});
 const server=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const result=await handler({method:req.method,url:new URL(req.url,'http://127.0.0.1'),headers:req.headers,body:JSON.parse(Buffer.concat(chunks).toString())});res.writeHead(result.status,{'content-type':'application/json'});res.end(JSON.stringify(result.value));}catch{res.writeHead(500);res.end('{}');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{const native=new SessionControllerClient('http://127.0.0.1:'+server.address().port,token),observer=new Observer({db:f.db,workbench:f.workbench,native,maxAgeMs:5000}),result=await observer.observe(f.scope);assert.equal(result.reason,null);assert.equal(result.facts.native_idle,'idle');assert.equal(result.execution_authorized,false);}finally{await new Promise(resolve=>server.close(resolve));}
});
