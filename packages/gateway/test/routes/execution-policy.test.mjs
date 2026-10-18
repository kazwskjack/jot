import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {buildServer} from '../../src/server.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';

test('execution policy bridge is read-only, bearer-authenticated and exact-run/Session/lease bound with CSRF enabled',async t=>{
 const token=randomBytes(32).toString('hex'),service=await buildServer({databasePath:':memory:',workspaces:['ws'],internalChannelToken:token,csrfToken:randomBytes(32).toString('hex'),allowedOrigins:['https://fixture.invalid']});
 t.after(async()=>{await service.app.close();service.db.close();});
 const owner='execution-owner',c=service.conversations.create(owner,{workspace_id:'ws',title:'Synthetic execution policy',model:{provider:'local-scripted',model:'work',reasoning_effort:'high'}});
 service.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run(c.conversation_id,owner,'execution-session','now','now');
 const source=service.runs.enqueue(c.conversation_id,owner,{client_message_id:'execution-original',content:[{type:'text',text:'Synthetic policy question'}]}),coordinator=new HarnessCoordinator(service.db,service.runs,service.events),lease=coordinator.claimNext('execution-worker',30000);coordinator.start(lease);
 const body={run_id:source.run_id,session_ref:'execution-session',execution_lease:{owner:lease.owner,generation:lease.generation}};
 const read=(payload=body,authorization=`Bearer ${token}`)=>service.app.inject({method:'POST',url:'/internal/v1/workbench/ordinary-execution-policy',headers:{authorization},payload});
 const before=service.db.prepare('SELECT total_changes() n').get().n,response=await read();assert.equal(response.statusCode,200,response.body);assert.equal(service.db.prepare('SELECT total_changes() n').get().n,before);
 const proof=response.json().execution;assert.equal(proof.execution_authorized,false);assert.equal(proof.policy.mode,'work');assert.equal(proof.owner_id,owner);
 assert.equal(proof.policy_sha256,createHash('sha256').update(service.db.prepare('SELECT execution_policy_json FROM ga_runs WHERE id=?').get(source.run_id).execution_policy_json).digest('hex'));
 assert.equal((await read(body,'Bearer wrong-fixture')).statusCode,401);assert.equal((await read({...body,owner_id:owner})).statusCode,422);
 assert.equal((await read({...body,session_ref:'foreign-session'})).statusCode,409);
 assert.equal((await read({...body,execution_lease:{...body.execution_lease,generation:lease.generation+1}})).statusCode,409);
 service.db.prepare("UPDATE ga_runs SET status='cancelled' WHERE id=?").run(source.run_id);assert.equal((await read()).statusCode,409);
});
