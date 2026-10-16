import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';import {createHash,randomBytes} from 'node:crypto';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {buildServer} from '../../src/server.ts';import {EventStore} from '../../src/events/event-store.ts';import {RunRepository} from '../../src/runs/repository.ts';import {RunCommandService} from '../../src/runs/commands.ts';import {HarnessCoordinator} from '../../src/harness/coordinator.ts';
async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jot-steering-binding-')),token=randomBytes(32).toString('hex'),f=await buildServer({databasePath:join(root,'db.sqlite'),uploadRoot:join(root,'files'),templateRoot:fileURLToPath(new URL('../../file-engine/templates',import.meta.url)),workbenchRoot:join(root,'workspaces'),workspaces:['ws'],internalChannelToken:token,csrfToken:randomBytes(24).toString('hex')});
 t.after(async()=>{await f.app.close();f.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});const stamp=new Date().toISOString();
 f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('conv-a','owner-a','ws','Fixture','{}',1,stamp,stamp);f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('conv-a','owner-a','native-a',stamp,stamp);
 const events=new EventStore(f.db),runs=new RunRepository(f.db,events),source=runs.enqueue('conv-a','owner-a',{client_message_id:'original-input',content:[{type:'text',text:'Original synthetic request'}]}),coordinator=new HarnessCoordinator(f.db,runs,events),lease=coordinator.claimNext('original-worker',30000);coordinator.start(lease);
 const control=new RunCommandService(f.db,events).steer(source.run_id,'owner-a',{text:'  Original synthetic supplement  ',client_message_id:'supplement-a',expected_run_version:runs.get(source.run_id,'owner-a').version},'supplement-a'),payload={run_id:source.run_id,command_id:control.command_id,session_ref:'native-a',execution_lease:{owner:lease.owner,generation:lease.generation}},messageId='message-'+control.command_id,content={blocks:[{block_id:messageId+':text',kind:'text',text:'  Original synthetic supplement  '}],attachments:[]};
 const request=(body=payload,authorization='Bearer '+token)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/ordinary-steering-binding',headers:{authorization},payload:body});
 const apply=()=>{f.db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,'user','complete',?,?,?,?)").run(messageId,'conv-a',source.run_id,JSON.stringify(content),'supplement-a',stamp,stamp);f.db.prepare("UPDATE ga_run_commands SET status='applied',applied_at=? WHERE id=?").run(stamp,control.command_id);};
 return{...f,source,control,payload,messageId,content,request,apply};
}
test('steering binding derives an immutable command/parent receipt without text or database mutation',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n,response=await f.request();assert.equal(response.statusCode,200,response.body);const b=response.json().binding;
 assert.equal(b.execution_authorized,false);assert.equal(b.kind,'ordinary_steer');assert.equal(b.run_id,f.source.run_id);assert.equal(b.request_id,f.control.command_id);assert.equal(b.command_id,f.control.command_id);assert.equal(b.input_message_id,f.messageId);assert.equal(b.original_input_message_id,f.source.message_id);assert.equal(b.owner_id,'owner-a');assert.equal(b.session_id,'native-a');assert.deepEqual(b.execution_lease,f.payload.execution_lease);assert.equal(b.input_sha256,createHash('sha256').update(JSON.stringify(f.content)).digest('hex'));assert.equal(b.native_content_sha256,createHash('sha256').update(JSON.stringify([{type:'text',text:'Original synthetic supplement'}])).digest('hex'));assert.ok(!response.body.includes('Original synthetic'));assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_messages').get().n,1);
 f.apply();assert.deepEqual((await f.request()).json().binding,b);
});
test('steering binding requires internal authentication and exact non-spoofable metadata',async t=>{
 const f=await fixture(t);for(const auth of ['','Bearer wrong'])assert.equal((await f.request(f.payload,auth)).statusCode,401);
 for(const body of [{...f.payload,owner_id:'owner-a'},{...f.payload,text:'substitute'},{...f.payload,command_id:'../other'},{...f.payload,execution_lease:{...f.payload.execution_lease,owner_id:'owner-a'}}])assert.equal((await f.request(body)).statusCode,422);
});
test('foreign command, Session, stale lease and revoked command states refuse',async t=>{
 const f=await fixture(t);for(const body of [{...f.payload,command_id:'cmd-other'},{...f.payload,session_ref:'native-other'},{...f.payload,execution_lease:{owner:'other-worker',generation:2}}])assert.equal((await f.request(body)).statusCode,409);
 for(const status of ['superseded','rejected']){f.db.prepare('UPDATE ga_run_commands SET status=? WHERE id=?').run(status,f.control.command_id);assert.equal((await f.request()).statusCode,409);}
 f.db.prepare("UPDATE ga_run_commands SET status='pending',kind='cancel' WHERE id=?").run(f.control.command_id);assert.equal((await f.request()).statusCode,409);
});
test('missing or conflicting applied product messages cannot attest a steering input',async t=>{
 const f=await fixture(t);f.db.prepare("UPDATE ga_run_commands SET status='applied' WHERE id=?").run(f.control.command_id);assert.equal((await f.request()).statusCode,409);f.apply();assert.equal((await f.request()).statusCode,200);f.db.prepare("UPDATE ga_messages SET content_json='{}' WHERE id=?").run(f.messageId);assert.equal((await f.request()).statusCode,409);
});
test('client-message collisions and malformed command payloads refuse without creating input',async t=>{
 const f=await fixture(t),original=f.db.prepare('SELECT payload_json FROM ga_run_commands WHERE id=?').get(f.control.command_id).payload_json;
 for(const change of [{text:' '},{client_message_id:'original-input'},{owner_id:'forged'}]){f.db.prepare('UPDATE ga_run_commands SET payload_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(original),...change}),f.control.command_id);assert.equal((await f.request()).statusCode,409);}
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_messages').get().n,1);
});


test('expired leases, owner-binding changes and stopped parent runs cannot attest commands',async t=>{
 const f=await fixture(t);f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()-1),f.source.run_id);assert.equal((await f.request()).statusCode,409);f.db.prepare('UPDATE ga_worker_leases SET expires_at=? WHERE resource_id=?').run(String(Date.now()+30000),f.source.run_id);
 f.db.prepare("UPDATE ga_harness_session_bindings SET owner_id='other-owner'").run();assert.equal((await f.request()).statusCode,409);f.db.prepare("UPDATE ga_harness_session_bindings SET owner_id='owner-a'").run();
 for(const status of ['cancelling','cancelled','succeeded','interrupted']){f.db.prepare('UPDATE ga_runs SET status=? WHERE id=?').run(status,f.source.run_id);assert.equal((await f.request()).statusCode,409);}
});
test('commands cannot claim a run version that has never existed',async t=>{
 const f=await fixture(t),row=f.db.prepare('SELECT payload_json FROM ga_run_commands WHERE id=?').get(f.control.command_id);f.db.prepare('UPDATE ga_run_commands SET payload_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.payload_json),expected_run_version:999999}),f.control.command_id);assert.equal((await f.request()).statusCode,409);
});
test('malformed stored payloads never expose their content or parser diagnostics',async t=>{
 const f=await fixture(t);f.db.prepare('UPDATE ga_run_commands SET payload_json=? WHERE id=?').run('{private synthetic text',f.control.command_id);const response=await f.request();assert.equal(response.statusCode,409);assert.deepEqual(response.json(),{error:{code:'ORDINARY_STEERING_BINDING_REJECTED'}});
});
