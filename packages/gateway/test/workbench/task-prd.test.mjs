import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';
import {TaskPrdService} from '../../src/persistent-tasks/prd.ts';
import {ModelBudgetLedger} from '../../src/workbench/model-budget.ts';

const base=join(tmpdir(),'jot-task-prd');mkdirSync(base,{recursive:true});
const templates=fileURLToPath(new URL('../../file-engine/templates/',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
const content='# Goal\nDeliver source-backed report.\n# Scope\nRead only.\n# Acceptance\nCite exact source.\n# Dependencies\nReview before delivery.';
async function fixture(t){
 const root=mkdtempSync(join(base,'case-')),uploadRoot=join(root,'uploads');
 const f=await buildServer({databasePath:join(root,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot,templateRoot:templates});
 const prd=f.taskPrd;
 t.after(async()=>{await f.app.close();f.db.close();});
 const agent=f.workbench.createAgent('alice',{name:'PRD role'}),task=f.persistentTasks.create('alice',{title:'Original task',agent_id:agent.agent_id,objective:'Original objective',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'},budget:{max_runs:3}});
 f.persistentTasks.pause('alice',task.task_id,task.version);
 const file=f.workbench.writeFile('alice','ws',{project_id:agent.project_id,path:'requirements.md',content,expected_version:0});
 const selection={kind:'logical_file',path:file.path,version:file.version,sha256:file.sha256};
 const api=(method,path,payload,key='fixture-key',owner='alice')=>f.app.inject({method,url:'/v1/persistent-tasks/'+task.task_id+'/prd'+path,headers:{'x-user-id':owner,'idempotency-key':key},...(payload?{payload}:{})});
 return {...f,prd,root,uploadRoot,agent,task,selection,api};
}
test('PRD preview is read-only; confirmation freezes exact bytes on the original paused task',async t=>{
 const f=await fixture(t),before=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 const preview=await f.api('POST','/preview',{source:f.selection});assert.equal(preview.statusCode,200,preview.body);const p=preview.json();
 assert.equal(p.content,content);assert.match(p.objective,/Original objective/);assert.ok(p.objective.includes(content));assert.equal(p.execution_authorized,false);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);
 const bound=await f.api('POST','/bind',{source:f.selection,preview_sha256:p.preview_sha256});assert.equal(bound.statusCode,200,bound.body);assert.equal(bound.json().task_id,f.task.task_id);
 const task=f.persistentTasks.get('alice',f.task.task_id);assert.equal(task.status,'paused');assert.equal(task.objective,p.objective);assert.equal(task.runs_used,0);assert.equal(task.budget.max_runs,3);assert.equal(f.persistentTasks.list('alice').items.length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,before);
 f.workbench.writeFile('alice','ws',{project_id:f.agent.project_id,path:'requirements.md',content:'Changed later',expected_version:1});assert.ok(f.persistentTasks.get('alice',task.task_id).objective.includes(content));
 assert.throws(()=>f.db.prepare("UPDATE wb_task_prd_bindings SET content='changed'").run(),/immutable/);
 const replay=await f.api('POST','/bind',{source:f.selection,preview_sha256:p.preview_sha256});assert.deepEqual(replay.json(),bound.json());
 const restarted=new TaskPrdService(f.db,f.workbench,f.persistentTasks,f.artifacts,{uploadRoot:f.uploadRoot});assert.deepEqual(restarted.bind('alice',task.task_id,{source:f.selection,preview_sha256:p.preview_sha256},'fixture-key'),bound.json());
 assert.equal((await f.api('POST','/bind',{source:f.selection,preview_sha256:'a'.repeat(64)})).statusCode,409);
});
test('PRD confirmation refuses source, role and task changes and never cancels an existing run',async t=>{
 const f=await fixture(t),p=(await f.api('POST','/preview',{source:f.selection})).json();
 f.workbench.writeFile('alice','ws',{project_id:f.agent.project_id,path:'requirements.md',content:'changed',expected_version:1});assert.equal((await f.api('POST','/bind',{source:f.selection,preview_sha256:p.preview_sha256})).statusCode,409);
 const current=f.workbench.listFiles('alice','ws',f.agent.project_id).items[0],source={kind:'logical_file',path:current.path,version:current.version,sha256:current.sha256},p2=(await f.api('POST','/preview',{source})).json();
 f.workbench.updateAgent('alice',f.agent.agent_id,{expected_version:1,name:'renamed'});assert.equal((await f.api('POST','/bind',{source,preview_sha256:p2.preview_sha256},'role-drift')).statusCode,409);
 const task=f.persistentTasks.get('alice',f.task.task_id);f.persistentTasks.resume('alice',task.task_id,task.version);const run=f.persistentTasks.runNow('alice',task.task_id,'original-run');
 assert.equal((await f.api('POST','/preview',{source})).statusCode,409);assert.equal(f.runs.get(run.run_id,'alice').status,'queued');
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,0);
});
test('PRD sources respect owner/project scope and refuse extra authority or foreign source fields',async t=>{
 const f=await fixture(t),other=f.workbench.createAgent('bob',{name:'Foreign'});f.workbench.writeFile('bob','ws',{project_id:other.project_id,path:'foreign.md',content,expected_version:0});
 const listing=await f.api('GET','/sources');assert.equal(listing.statusCode,200);assert.equal(listing.json().sources.length,1);assert.equal(listing.json().sources[0].path,'requirements.md');
 assert.equal((await f.api('POST','/preview',{source:f.selection},'foreign','bob')).statusCode,404);
 assert.equal((await f.api('POST','/preview',{source:{...f.selection,owner_id:'bob'}})).statusCode,422);
 assert.equal((await f.api('POST','/preview',{source:{...f.selection,sha256:'a'.repeat(64)}})).statusCode,409);
});
test('original uploaded attachment is pinned without reupload; corrupt and binary uploads are refused',async t=>{
 const f=await fixture(t),raw=Buffer.from(content),upload=f.artifacts.initUpload(f.agent.conversation_id,'alice',{file_name:'requirements.md',size_bytes:raw.length,sha256:digest(raw),media_type:'text/markdown'});
 await f.artifacts.writeContent(upload.upload_id,'alice',(async function*(){yield raw;})());const artifact=f.artifacts.complete(upload.upload_id,'alice',{sha256:digest(raw)});
 const source={kind:'upload',artifact_id:artifact.artifact_id,version:1,sha256:artifact.sha256},p=await f.api('POST','/preview',{source});assert.equal(p.statusCode,200,p.body);assert.equal(p.json().content,content);
 const before=f.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,bound=await f.api('POST','/bind',{source,preview_sha256:p.json().preview_sha256});assert.equal(bound.statusCode,200,bound.body);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_uploads').get().n,before);
 const path=f.artifacts.download(artifact.artifact_id,'alice',1).server_path;writeFileSync(path,Buffer.alloc(raw.length,'x'));assert.equal((await f.api('POST','/preview',{source})).statusCode,409);
});
test('failed binding receipt rolls back original task update and retries the same command exactly once',async t=>{
 const f=await fixture(t),p=(await f.api('POST','/preview',{source:f.selection})).json(),input={source:f.selection,preview_sha256:p.preview_sha256};
 const original=f.persistentTasks.get('alice',f.task.task_id);
 f.db.exec("CREATE TRIGGER fixture_prd_failure BEFORE INSERT ON wb_task_prd_bindings BEGIN SELECT RAISE(ABORT,'fixture_storage_unavailable'); END");
 assert.equal((await f.api('POST','/bind',input)).statusCode,500);assert.deepEqual(f.persistentTasks.get('alice',f.task.task_id),original);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,0);
 f.db.exec('DROP TRIGGER fixture_prd_failure');assert.equal((await f.api('POST','/bind',input)).statusCode,200);assert.equal((await f.api('POST','/bind',input)).statusCode,200);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,1);
});
test('replacing a PRD appends a revision without recursive objective growth and refuses external objective edits',async t=>{
 const f=await fixture(t),p=(await f.api('POST','/preview',{source:f.selection})).json();assert.equal((await f.api('POST','/bind',{source:f.selection,preview_sha256:p.preview_sha256})).statusCode,200);
 const file=f.workbench.writeFile('alice','ws',{project_id:f.agent.project_id,path:'requirements.md',content:'New reviewed PRD',expected_version:1}),source={kind:'logical_file',path:file.path,version:file.version,sha256:file.sha256};
 const next=(await f.api('POST','/preview',{source})).json();assert.ok(!next.objective.includes(content));assert.equal(next.objective.split('Original objective').length-1,1);
 assert.equal((await f.api('POST','/bind',{source,preview_sha256:next.preview_sha256},'revision-two')).json().revision,2);
 const task=f.persistentTasks.get('alice',f.task.task_id);f.persistentTasks.update('alice',task.task_id,{expected_version:task.version,objective:'User changed objective elsewhere'});
 assert.equal((await f.api('POST','/preview',{source})).json().error.code,'PRD_OBJECTIVE_CHANGED');
});
test('PRD refuses unsupported binary and oversized text instead of silently truncating input',async t=>{
 const f=await fixture(t),file=f.workbench.writeFile('alice','ws',{project_id:f.agent.project_id,path:'large.md',content:'a'.repeat(12000),expected_version:0});
 const p=await f.api('POST','/preview',{source:{kind:'logical_file',path:file.path,version:1,sha256:file.sha256}});assert.equal(p.statusCode,409);assert.equal(p.json().error.code,'PRD_OBJECTIVE_TOO_LARGE');
 const raw=Buffer.from([0,1,2,3]),upload=f.artifacts.initUpload(f.agent.conversation_id,'alice',{file_name:'requirements.pdf',size_bytes:raw.length,sha256:digest(raw),media_type:'application/pdf'});
 await f.artifacts.writeContent(upload.upload_id,'alice',(async function*(){yield raw;})());const artifact=f.artifacts.complete(upload.upload_id,'alice',{sha256:digest(raw)});
 const unsupported=await f.api('POST','/preview',{source:{kind:'upload',artifact_id:artifact.artifact_id,version:1,sha256:artifact.sha256}});assert.equal(unsupported.statusCode,422);assert.equal(unsupported.json().error.code,'PRD_SOURCE_UNSUPPORTED');
});
test('bound PRD reaches original task occurrence and existing subtask/readiness APIs without a new task budget',async t=>{
 const f=await fixture(t),p=(await f.api('POST','/preview',{source:f.selection})).json();assert.equal((await f.api('POST','/bind',{source:f.selection,preview_sha256:p.preview_sha256})).statusCode,200);
 let task=f.persistentTasks.get('alice',f.task.task_id);task=f.persistentTasks.resume('alice',task.task_id,task.version);const run=f.persistentTasks.runNow('alice',task.task_id,'original-prd-run');
 const messages=f.db.prepare('SELECT content_json FROM ga_messages WHERE conversation_id=?').all(run.conversation_id);assert.ok(JSON.stringify(messages).includes('Deliver source-backed report.'));
 const response=await f.app.inject({method:'POST',url:'/v1/persistent-tasks/'+task.task_id+'/subtasks',headers:{'x-user-id':'alice'},payload:{title:'Inspect requirements',acceptance:'Cite exact source'}});assert.equal(response.statusCode,200,response.body);
 const second=await f.app.inject({method:'POST',url:'/v1/persistent-tasks/'+task.task_id+'/subtasks',headers:{'x-user-id':'alice'},payload:{title:'Deliver report',acceptance:'Owner reviews report',dependencies:[response.json().subtask_id]}});assert.equal(second.statusCode,200,second.body);
 const ready=await f.app.inject({method:'GET',url:'/v1/persistent-tasks/'+task.task_id+'/readiness',headers:{'x-user-id':'alice'}});assert.equal(ready.statusCode,200);assert.equal(ready.json().subtasks.length,2);assert.equal(f.persistentTasks.get('alice',task.task_id).runs_used,1);assert.equal(f.persistentTasks.list('alice').items.length,1);
});
test('terminal original root with unknown provider spend cannot be rebound and its held budget remains unchanged',async t=>{
 const f=await fixture(t);f.persistentTasks.resume('alice',f.task.task_id,2);const run=f.persistentTasks.runNow('alice',f.task.task_id,'accounting-root');f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(run.run_id);
 const route={provider:'fixture',model:'fixture',revision:'fixture-rates',context_window:20,max_output_tokens:10,rates:{input:1,output:1,cache_read:1,cache_write:1}},ledger=new ModelBudgetLedger(f.db,{routes:[route]});
 const scope=ledger.createScope('alice','original-task-fixture',{tokens:1000,nano_usd:1000,model_calls:20});ledger.bindRun('alice',run.run_id,[scope.scope_id]);ledger.reserve('alice',run.run_id,{attempt_id:'original-attempt',provider:'fixture',model:'fixture'});ledger.dispatch('alice',run.run_id,'original-attempt');ledger.markUnknown('alice',run.run_id,'original-attempt','stream_incomplete');
 f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(run.run_id);f.persistentTasks.pause('alice',f.task.task_id,3);const before=ledger.balance('alice',scope.scope_id);
 const response=await f.api('POST','/preview',{source:f.selection});assert.equal(response.statusCode,409);assert.equal(response.json().error.code,'PRD_BUDGET_UNRESOLVED');assert.deepEqual(ledger.balance('alice',scope.scope_id),before);
});
test('a terminal root does not hide an unclosed native child creation reservation',async t=>{
 const f=await fixture(t);f.persistentTasks.resume('alice',f.task.task_id,2);const run=f.persistentTasks.runNow('alice',f.task.task_id,'native-root');f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(run.run_id);f.persistentTasks.pause('alice',f.task.task_id,3);
 // Controlled durable-state fixture: original child creation has no trusted abort or closure yet.
 f.db.prepare('INSERT INTO wb_native_child_reservations VALUES(?,?,?,?,?,?,?,?,?,?)').run('fixture-native-reservation','alice',run.run_id,f.task.task_id,run.occurrence_id,'fixture-child-session','fixture-native-request','a'.repeat(64),'{}',new Date().toISOString());
 const response=await f.api('POST','/preview',{source:f.selection});assert.equal(response.statusCode,409);assert.equal(response.json().error.code,'PRD_EXECUTION_UNRESOLVED');assert.equal(f.persistentTasks.get('alice',f.task.task_id).version,4);
});
test('public registered PRD routes retain CSRF/auth/contracts and bypass generic preview/bind caches',async t=>{
 const root=mkdtempSync(join(base,'public-')),uploadRoot=join(root,'uploads'),config={databasePath:join(root,'db.sqlite'),workspaces:['ws'],workbenchRoot:join(root,'files'),uploadRoot,templateRoot:templates,csrfToken:'test-prd-csrf-token-0123456789',allowedOrigins:['https://fixture.invalid']};
 let f=await buildServer(config);t.after(async()=>{await f.app.close();f.db.close();});
 const agent=f.workbench.createAgent('alice',{name:'PRD scope'}),task=f.persistentTasks.create('alice',{title:'Original public task',agent_id:agent.agent_id,objective:'Original goal',trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'},budget:{max_runs:3}});f.persistentTasks.pause('alice',task.task_id,1);
 const file=f.workbench.writeFile('alice','ws',{project_id:agent.project_id,path:'prd.md',content,expected_version:0}),source={kind:'logical_file',path:file.path,version:file.version,sha256:file.sha256};
 const headers={'x-user-id':'alice',origin:'https://fixture.invalid','x-csrf-token':config.csrfToken},url='/v1/persistent-tasks/'+task.task_id+'/prd',api=(path,payload,extra={})=>f.app.inject({method:'POST',url:url+path,headers:{...headers,...extra},payload});
 const preview=await api('/preview',{source});assert.equal(preview.statusCode,200,preview.body);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_idempotency').get().n,0);
 const errorShape=(response,status)=>{assert.equal(response.statusCode,status,response.body);const value=response.json();assert.equal(typeof value.error.code,'string');assert.equal(typeof value.error.message,'string');assert.equal(typeof value.error.retryable,'boolean');assert.equal(typeof value.request_id,'string');return value;};
 errorShape(await api('/preview',{source},{'x-csrf-token':'wrong'}),403);errorShape(await api('/preview',{source},{origin:'https://foreign.invalid'}),403);errorShape(await api('/preview',{source},{'x-user-id':''}),401);errorShape(await api('/preview',{source},{'x-user-id':'bob'}),404);errorShape(await api('/preview',{source:{...source,owner_id:'bob'}}),422);
 errorShape(await api('/bind',{source,preview_sha256:preview.json().preview_sha256}),422);
 errorShape(await api('/bind',{source,preview_sha256:'a'.repeat(64)},{'idempotency-key':'drift-key'}),409);
 const input={source,preview_sha256:preview.json().preview_sha256},key={'idempotency-key':'public-prd-bind'};
 f.db.exec("CREATE TRIGGER fixture_public_prd_failure BEFORE INSERT ON wb_task_prd_bindings BEGIN SELECT RAISE(ABORT,'fixture_storage_failed'); END");
 assert.equal(errorShape(await api('/bind',input,key),500).error.retryable,true);assert.equal(f.persistentTasks.get('alice',task.task_id).version,2);
 f.db.exec('DROP TRIGGER fixture_public_prd_failure');const bound=await api('/bind',input,key);assert.equal(bound.statusCode,200,bound.body);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_idempotency').get().n,0);
 await f.app.close();f.db.close();f=await buildServer(config);assert.deepEqual((await api('/bind',input,key)).json(),bound.json());assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,1);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,0);
});
test('same-owner foreign-project logical files and original uploads cannot enter the selected task PRD',async t=>{
 const f=await fixture(t),project=f.projects.create('alice',{title:'Other project'}),agent=f.workbench.createAgent('alice',{name:'Other project role',project_id:project.project_id});
 const file=f.workbench.writeFile('alice','ws',{project_id:project.project_id,path:'foreign.md',content,expected_version:0});
 const foreignFile={kind:'logical_file',path:file.path,version:file.version,sha256:file.sha256};assert.equal((await f.api('POST','/preview',{source:foreignFile})).json().error.code,'PRD_SOURCE_UNAVAILABLE');
 const raw=Buffer.from(content),upload=f.artifacts.initUpload(agent.conversation_id,'alice',{file_name:'foreign.md',size_bytes:raw.length,sha256:digest(raw),media_type:'text/markdown'});await f.artifacts.writeContent(upload.upload_id,'alice',(async function*(){yield raw;})());const artifact=f.artifacts.complete(upload.upload_id,'alice',{sha256:digest(raw)});
 assert.equal((await f.api('POST','/preview',{source:{kind:'upload',artifact_id:artifact.artifact_id,version:1,sha256:artifact.sha256}})).json().error.code,'PRD_SOURCE_UNAVAILABLE');
 const listing=(await f.api('GET','/sources')).json();assert.equal(listing.sources.length,1);assert.equal(listing.sources[0].path,'requirements.md');
});
test('binding preserves the original completed-message source identity and its server-calculated hash',async t=>{
 const f=await fixture(t),message=f.runs.enqueue(f.agent.conversation_id,'alice',{client_message_id:'source-message',content:[{type:'text',text:'Original user-approved context'}]});
 const task=f.persistentTasks.create('alice',{title:'From original message',agent_id:f.agent.agent_id,objective:'Keep original source',source:{conversation_id:f.agent.conversation_id,message_id:message.message_id},trigger:{kind:'once',run_at:'2099-01-01T00:00:00Z'},budget:{max_runs:3}});f.persistentTasks.pause('alice',task.task_id,1);
 const preview=f.prd.preview('alice',task.task_id,{source:f.selection});f.prd.bind('alice',task.task_id,{source:f.selection,preview_sha256:preview.preview_sha256},'source-preserve');assert.deepEqual(f.persistentTasks.get('alice',task.task_id).source,task.source);
});
for(const unknown of [false,true])test(`original auxiliary ${unknown?'unknown spend':'live execution'} blocks preview and confirmation after the root ends`,async t=>{
 const f=await fixture(t);f.persistentTasks.resume('alice',f.task.task_id,2);const root=f.persistentTasks.runNow('alice',f.task.task_id,'auxiliary-root');f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(root.run_id);f.persistentTasks.pause('alice',f.task.task_id,3);
 const preview=f.prd.preview('alice',f.task.task_id,{source:f.selection}),aux=f.runs.enqueue(f.agent.conversation_id,'alice',{client_message_id:'original-auxiliary',content:[{type:'text',text:'Original mailbox work'}]}),now=new Date().toISOString();
 f.db.prepare('INSERT INTO wb_mailbox_task_roots VALUES(?,?,?,?,?,?,?,?)').run('fixture-prd-thread','alice',f.task.task_id,root.occurrence_id,root.run_id,root.run_id,3,now);f.db.prepare('INSERT INTO wb_task_auxiliary_runs VALUES(?,?,?,?,?,?,?)').run(aux.run_id,'fixture-prd-thread','alice',f.task.task_id,root.occurrence_id,root.run_id,now);f.db.prepare("UPDATE ga_runs SET status='running' WHERE id=?").run(aux.run_id);
 let ledger,scope,before;
 if(unknown){const route={provider:'fixture',model:'fixture',revision:'fixture-rates',context_window:20,max_output_tokens:10,rates:{input:1,output:1,cache_read:1,cache_write:1}};ledger=new ModelBudgetLedger(f.db,{routes:[route]});scope=ledger.createScope('alice','original-auxiliary-scope',{tokens:1000,nano_usd:1000,model_calls:20});ledger.bindRun('alice',aux.run_id,[scope.scope_id]);ledger.reserve('alice',aux.run_id,{attempt_id:'original-auxiliary-attempt',provider:'fixture',model:'fixture'});ledger.dispatch('alice',aux.run_id,'original-auxiliary-attempt');ledger.markUnknown('alice',aux.run_id,'original-auxiliary-attempt','stream_incomplete');f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(aux.run_id);before=ledger.balance('alice',scope.scope_id);}
 const expected=unknown?'PRD_BUDGET_UNRESOLVED':'PRD_EXECUTION_UNRESOLVED';const p=await f.api('POST','/preview',{source:f.selection});assert.equal(p.statusCode,409,p.body);assert.equal(p.json().error.code,expected);
 const bind=await f.api('POST','/bind',{source:f.selection,preview_sha256:preview.preview_sha256});assert.equal(bind.statusCode,409,bind.body);assert.equal(bind.json().error.code,expected);assert.equal(f.persistentTasks.get('alice',f.task.task_id).version,4);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,0);if(unknown)assert.deepEqual(ledger.balance('alice',scope.scope_id),before);
});
for(const [status,settled] of [[null,0],['running',0],['succeeded',0],['succeeded',1]])test(`original web operation ${status}/${settled} preserves its settlement boundary before PRD binding`,async t=>{
 const f=await fixture(t);f.persistentTasks.resume('alice',f.task.task_id,2);const root=f.persistentTasks.runNow('alice',f.task.task_id,'web-root');f.db.prepare("UPDATE ga_runs SET status='failed' WHERE id=?").run(root.run_id);f.persistentTasks.pause('alice',f.task.task_id,3);const preview=f.prd.preview('alice',f.task.task_id,{source:f.selection}),now=new Date().toISOString();
 f.db.prepare('INSERT INTO ga_web_operation_cursors(run_id,tool_call_id,session_ref,operation_id,last_status,items_settled,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(root.run_id,'original-web-call','fixture-original-session','fixture-original-operation',status,settled,now,now);const before=f.db.prepare('SELECT * FROM ga_web_operation_cursors WHERE run_id=?').get(root.run_id);
 const response=await f.api('POST','/bind',{source:f.selection,preview_sha256:preview.preview_sha256});if(status==='succeeded'&&settled===1){assert.equal(response.statusCode,200,response.body);}else{assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error.code,'PRD_EXECUTION_UNRESOLVED');assert.equal(f.persistentTasks.get('alice',f.task.task_id).version,4);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_prd_bindings').get().n,0);}assert.deepEqual(f.db.prepare('SELECT * FROM ga_web_operation_cursors WHERE run_id=?').get(root.run_id),before);
});
