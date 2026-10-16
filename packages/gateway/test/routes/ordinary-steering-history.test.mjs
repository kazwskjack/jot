import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';
import {EventStore} from '../../src/events/event-store.ts';
import {RunRepository} from '../../src/runs/repository.ts';
import {RunCommandService} from '../../src/runs/commands.ts';
import {HarnessCoordinator} from '../../src/harness/coordinator.ts';

async function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'jot-history-')),token=randomBytes(32).toString('hex');
 const f=await buildServer({databasePath:join(root,'db.sqlite'),uploadRoot:join(root,'files'),templateRoot:fileURLToPath(new URL('../../file-engine/templates',import.meta.url)),workbenchRoot:join(root,'workspaces'),workspaces:['ws'],internalChannelToken:token,csrfToken:randomBytes(24).toString('hex')});
 t.after(async()=>{await f.app.close();f.db.close();rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 const now=new Date().toISOString();
 f.db.prepare('INSERT INTO ga_conversations(id,owner_id,workspace_id,title,model,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('history-conv','history-owner','ws','Fixture','{}',1,now,now);
 f.db.prepare('INSERT INTO ga_harness_session_bindings VALUES(?,?,?,?,?)').run('history-conv','history-owner','history-native',now,now);
 const events=new EventStore(f.db),runs=new RunRepository(f.db,events),source=runs.enqueue('history-conv','history-owner',{client_message_id:'history-original',content:[{type:'text',text:'Synthetic original private body'}]}),c=new HarnessCoordinator(f.db,runs,events),lease=c.claimNext('history-worker',30000);c.start(lease);
 const command=new RunCommandService(f.db,events).steer(source.run_id,'history-owner',{text:'  Synthetic private supplement  ',client_message_id:'history-supplement',expected_run_version:runs.get(source.run_id,'history-owner').version},'history-supplement');
 f.db.prepare("UPDATE ga_runs SET status='interrupted',version=version+1 WHERE id=?").run(source.run_id);
 const payload={owner_id:'history-owner',conversation_id:'history-conv',session_ref:'history-native',run_id:source.run_id,command_id:command.command_id,expected_run_version:runs.get(source.run_id,'history-owner').version};
 const messageId='message-'+command.command_id,content={blocks:[{block_id:messageId+':text',kind:'text',text:'  Synthetic private supplement  '}],attachments:[]};
 const request=(body=payload,auth='Bearer '+token)=>f.app.inject({method:'POST',url:'/internal/v1/workbench/ordinary-steering-history',headers:{authorization:auth},payload:body});
 const apply=()=>{f.db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,'user','complete',?,?,?,?)").run(messageId,'history-conv',source.run_id,JSON.stringify(content),'history-supplement',now,now);f.db.prepare("UPDATE ga_run_commands SET status='applied' WHERE id=?").run(command.command_id);};
 return{...f,source,command,payload,messageId,content,request,apply};
}
test('terminal history reads only product facts and never turns source lineage into native acceptance',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT total_changes() n').get().n,r=await f.request();assert.equal(r.statusCode,200,r.body);const b=r.json().history;
 assert.deepEqual(Object.keys(b).sort(),['protocol','kind','owner_id','conversation_id','session_id','run_id','run_version','run_status','command_id','command_status','original_input_message_id','input_message_id','original_input_sha256','command_sha256','input_sha256','native_content_sha256','product_message_present','native_acceptance','execution_authorized'].sort());
 assert.equal(b.kind,'ordinary_steer_history');assert.equal(b.execution_authorized,false);assert.equal(b.native_acceptance,'unverified');assert.equal(b.command_status,'pending');assert.equal(b.run_status,'interrupted');assert.equal(b.run_version,f.payload.expected_run_version);assert.equal(b.product_message_present,false);assert.equal(b.input_sha256,createHash('sha256').update(JSON.stringify(f.content)).digest('hex'));assert.ok(!r.body.includes('Synthetic'));assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 f.apply();const applied=(await f.request()).json().history;assert.equal(applied.product_message_present,true);assert.equal(applied.command_status,'applied');assert.equal(applied.native_acceptance,'unverified');assert.equal(applied.command_sha256,b.command_sha256);
});
test('history requires strict internal authentication and explicit scope without lease or text',async t=>{
 const f=await fixture(t);for(const auth of ['','Bearer wrong'])assert.equal((await f.request(f.payload,auth)).statusCode,401);
 for(const body of [{...f.payload,execution_lease:{owner:'history-worker',generation:1}},{...f.payload,text:'forged'},{...f.payload,expected_run_version:String(f.payload.expected_run_version)},{...f.payload,command_id:'../command'}])assert.equal((await f.request(body)).statusCode,422);
 for(const change of [{owner_id:'foreign'},{conversation_id:'foreign'},{session_ref:'foreign'},{run_id:'foreign'},{command_id:'foreign'},{expected_run_version:f.payload.expected_run_version+1}])assert.equal((await f.request({...f.payload,...change})).statusCode,409);
});
test('cancelled and failed history stays terminal and does not acquire or renew a lease',async t=>{
 const f=await fixture(t);f.db.prepare('DELETE FROM ga_worker_leases').run();const before=f.db.prepare('SELECT total_changes() n').get().n;
 for(const status of ['cancelled','failed','succeeded','partial','interrupted']){f.db.prepare('UPDATE ga_runs SET status=? WHERE id=?').run(status,f.source.run_id);const changed=f.db.prepare('SELECT total_changes() n').get().n,r=await f.request();assert.equal(r.statusCode,200,r.body);assert.equal(r.json().history.run_status,status);assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changed);}
 assert.ok(f.db.prepare('SELECT total_changes() n').get().n>=before);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,1);
 for(const status of ['queued','running','cancelling','waiting_user']){f.db.prepare('UPDATE ga_runs SET status=? WHERE id=?').run(status,f.source.run_id);assert.equal((await f.request()).statusCode,409);}
});
test('missing or conflicting product acknowledgement cannot certify historical command facts',async t=>{
 const f=await fixture(t);f.db.prepare("UPDATE ga_run_commands SET status='applied' WHERE id=?").run(f.command.command_id);assert.equal((await f.request()).statusCode,409);f.apply();assert.equal((await f.request()).statusCode,200);f.db.prepare("UPDATE ga_messages SET content_json='{}' WHERE id=?").run(f.messageId);assert.equal((await f.request()).statusCode,409);
});
test('invalid payload, original lineage and archived ownership refuse without leaking diagnostics',async t=>{
 const f=await fixture(t),raw=f.db.prepare('SELECT payload_json FROM ga_run_commands WHERE id=?').get(f.command.command_id).payload_json;
 for(const value of ['{private synthetic body',JSON.stringify({...JSON.parse(raw),text:' '}),JSON.stringify({...JSON.parse(raw),expected_run_version:999999}),JSON.stringify({...JSON.parse(raw),client_message_id:'history-original'})]){f.db.prepare('UPDATE ga_run_commands SET payload_json=? WHERE id=?').run(value,f.command.command_id);const r=await f.request();assert.equal(r.statusCode,409);assert.deepEqual(r.json(),{error:{code:'ORDINARY_STEERING_HISTORY_REJECTED'}});}
 f.db.prepare('UPDATE ga_run_commands SET payload_json=? WHERE id=?').run(raw,f.command.command_id);f.db.prepare("UPDATE ga_conversations SET archived_at='archived'").run();assert.equal((await f.request()).statusCode,409);f.db.prepare('UPDATE ga_conversations SET archived_at=NULL').run();f.db.prepare("UPDATE ga_messages SET role='assistant' WHERE id=?").run(f.source.message_id);assert.equal((await f.request()).statusCode,409);
});
test('role, task and message-free Goal histories cannot be mistaken for ordinary input',async t=>{
 const f=await fixture(t);
 f.db.prepare("INSERT INTO wb_agents VALUES('history-role','history-owner','Fixture','','ws','history-project','history-conv','active',1,1,'[]','now','now')").run();assert.equal((await f.request()).statusCode,409);
 f.db.prepare("DELETE FROM wb_agents WHERE agent_id='history-role'").run();
 f.db.prepare("INSERT INTO wb_run_bindings VALUES(?,'history-owner','history-role',1,'task','{}','now')").run(f.source.run_id);assert.equal((await f.request()).statusCode,409);
 f.db.prepare('DELETE FROM wb_run_bindings WHERE run_id=?').run(f.source.run_id);
 f.db.prepare('UPDATE ga_runs SET input_message_id=NULL WHERE id=?').run(f.source.run_id);assert.equal((await f.request()).statusCode,409);
 f.db.prepare('UPDATE ga_runs SET input_message_id=? WHERE id=?').run(f.source.message_id,f.source.run_id);
 f.db.prepare(`INSERT INTO ga_conversation_goal_controls(control_id,owner_id,conversation_id,session_id,source_run_id,run_id,goal_id,goal_revision,idempotency_key,request_sha256,state,created_at,updated_at)
 VALUES('history-control','history-owner','history-conv','history-native',?,?,'history-goal',1,'history-key',?,'queued','now','now')`).run(f.source.run_id,f.source.run_id,'a'.repeat(64));assert.equal((await f.request()).statusCode,409);
});
