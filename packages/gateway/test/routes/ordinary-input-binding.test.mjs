import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jot-input-binding-')),token=randomBytes(32).toString('hex');
 const f=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],internalChannelToken:token,csrfToken:randomBytes(24).toString('hex')});
 t.after(async()=>{await f.app.close();f.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const stamp=new Date().toISOString();f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('conv-a','owner-a','ws','Fixture','{}',1,stamp,stamp);
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('conv-a','owner-a','native-a',stamp,stamp);
 const events=new EventStore(f.db),runs=new RunRepository(f.db,events),source=runs.enqueue('conv-a','owner-a',{client_message_id:'original-input',content:[{type:'text',text:'Never expose or re-prompt this original input'}]}),coordinator=new HarnessCoordinator(f.db,runs,events),lease=coordinator.claimNext('original-worker',30000);coordinator.start(lease);
 const payload={run_id:source.run_id,session_ref:'native-a',execution_lease:{owner:lease.owner,generation:lease.generation}};
 const request=(body=payload,authorization='Bearer '+token)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/ordinary-input-binding',headers:{authorization},payload:body});
 return {...f,source,lease,payload,request};
}

test('original input binding is a read-only original-run/owner/Session/lease receipt, not execution permission',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n,response=await f.request();assert.equal(response.statusCode,200,response.body);
 const stored=f.db.prepare('SELECT content_json FROM ga_messages WHERE id=?').get(f.source.message_id);
 assert.deepEqual(response.json(),{binding:{protocol:1,run_id:f.source.run_id,request_id:f.source.run_id,input_message_id:f.source.message_id,conversation_id:'conv-a',owner_id:'owner-a',session_id:'native-a',execution_lease:f.payload.execution_lease,input_sha256:createHash('sha256').update(stored.content_json).digest('hex'),execution_authorized:false}});
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.ok(!response.body.includes('Never expose'));
 assert.deepEqual((await f.request()).json(),response.json());
});

test('binding requires the existing service credential and an exact request without caller-supplied owner',async t=>{
 const f=await fixture(t);for(const token of ['', 'Bearer wrong'])assert.equal((await f.request(f.payload,token)).statusCode,401);
 for(const body of [{...f.payload,owner_id:'owner-a'},{...f.payload,operation:'resume'},{...f.payload,execution_lease:{...f.payload.execution_lease,owner_id:'owner-a'}},{...f.payload,run_id:[]},{...f.payload,session_ref:'../other'}])assert.equal((await f.request(body)).statusCode,422);
});

test('foreign session, stale lease, archived conversation and non-running original inputs cannot obtain a binding',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request({...f.payload,session_ref:'foreign'})).statusCode,409);
 assert.equal((await f.request({...f.payload,execution_lease:{owner:'foreign-worker',generation:1}})).statusCode,409);
 assert.equal((await f.request({...f.payload,execution_lease:{...f.payload.execution_lease,generation:2}})).statusCode,409);
 for(const status of ['queued','starting','waiting_user','waiting_approval','cancelling','cancelled','succeeded','failed','interrupted']){f.db.prepare('UPDATE ga_runs SET status=? WHERE id=?').run(status,f.source.run_id);assert.equal((await f.request()).statusCode,409,status);}
 f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(f.source.run_id);f.db.prepare("UPDATE ga_conversations SET archived_at='now'").run();assert.equal((await f.request()).statusCode,409);
 f.db.prepare('UPDATE ga_conversations SET archived_at=NULL').run();f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),f.source.run_id);assert.equal((await f.request()).statusCode,409);
});

test('message lineage corruption and a workbench role cannot be borrowed by ordinary recovery',async t=>{
 const f=await fixture(t);
 f.db.prepare("UPDATE ga_messages SET role='assistant' WHERE id=?").run(f.source.message_id);assert.equal((await f.request()).statusCode,409);
 f.db.prepare("UPDATE ga_messages SET role='user',run_id='foreign-run' WHERE id=?").run(f.source.message_id);assert.equal((await f.request()).statusCode,409);
 f.db.prepare('UPDATE ga_messages SET run_id=? WHERE id=?').run(f.source.run_id,f.source.message_id);
 f.db.prepare("INSERT INTO wb_agents VALUES('role-a','owner-a','Fixture','','ws','project-a','conv-a','active',1,1,'[]','now','now')").run();assert.equal((await f.request()).statusCode,409);
 f.db.prepare('DELETE FROM wb_agents WHERE agent_id=?').run('role-a');f.db.prepare("INSERT INTO wb_run_bindings VALUES(?, 'owner-a','role-a',1,'task','{}','now')").run(f.source.run_id);assert.equal((await f.request()).statusCode,409);
});


test('a message-free Goal continuation cannot obtain an ordinary human input binding',async t=>{
 const f=await fixture(t);f.db.prepare('UPDATE ga_runs SET input_message_id=NULL WHERE id=?').run(f.source.run_id);assert.equal((await f.request()).statusCode,409);
});
