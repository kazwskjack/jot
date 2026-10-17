import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalJson} from '../../src/db/canonical-json.ts';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {get} from 'node:http';
import {fixture} from './task-wait-fixture.mjs';
import {completionFixture} from './task-completion-fixture.mjs';
import {TaskExecutionEvidence} from '../../src/persistent-tasks/execution-evidence.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';

async function files(t,configureApp){
 return fixture(t,'complete',{configureApp,proposalFiles:[{path:'report.md'}],candidate:{text:'Review the original report'},prepare:f=>{
  const proof=withImmediateTransaction(f.db,()=>{const written=f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'report.md',content:'Original reviewed report',expected_version:0},f.runId);return new TaskExecutionEvidence(f.db).record(f.runId,'review-file','files.write',written);});
  f.persistentTasks.upsertSubtask('alice',f.task.task_id,{title:'Report',acceptance:'The content matches the request',status:'completed',evidence:[proof]},f.runId);
 }});
}
const read=(f,url,owner='alice')=>f.app.inject({url,headers:{'x-user-id':owner}});
const counts=f=>Object.fromEntries(['ga_events','ga_artifacts','ga_artifact_leases','wb_task_business_certificates','wb_task_finalizations','wb_model_budget_attempts'].map(name=>[name,f.db.prepare(`SELECT count(*) n FROM ${name}`).get().n]));

test('an owned pending review lists and downloads its exact frozen workspace version without publication or lease renewal',async t=>{
 const f=await files(t),card=(await f.list())[0],base=`/v1/interactions/${card.interaction_id}/outputs`,before=counts(f);
 f.workbench.writeFile('alice','ws',{project_id:f.workbench.contextForRun(f.runId).project_id,path:'report.md',content:'Later replacement',expected_version:1});
 const list=await read(f,base);assert.equal(list.statusCode,200,list.body);const page=list.json();assert.equal(page.items.length,1);assert.equal(page.items[0].source,'workspace');assert.equal(page.items[0].version,1);assert.equal(page.items[0].file_name,'report.md');assert.equal(page.items[0].output_index,0);
 const content=await read(f,base+'/0');assert.equal(content.statusCode,200,content.body);assert.equal(content.body,'Original reviewed report');assert.equal(content.headers['x-content-type-options'],'nosniff');assert.match(content.headers['content-disposition'],/^attachment;/);assert.match(content.headers['cache-control'],/no-store/);
 assert.deepEqual(counts(f),before);assert.equal(f.runs.get(f.runId,'alice').status,'waiting_approval');assert.equal((await f.list())[0].status,'pending');
});

test('generated multi-part review outputs use the exact verified producer bytes and never register final attachments',async t=>{
 const candidate={text:'Review the generated files',artifact_refs:[]};const f=await completionFixture(t,{candidate,prepare:f=>{
  const root=f.workbench.projectRoot('alice','ws',f.workbench.contextForRun(f.runId).project_id);
  const docs=['First report','Second report'].map((text,index)=>{const path=join(root,`draft-${index}.md`);writeFileSync(path,text);return {path,display_name:`report-${index}.md`};});
  candidate.artifact_refs.push(f.artifacts.registerGenerated(f.runId,'preview-group',docs).artifact_ref);
 }});
 const card=(await f.list())[0],base=`/v1/interactions/${card.interaction_id}/outputs`,before=counts(f);const list=await read(f,base);assert.equal(list.statusCode,200,list.body);assert.equal(list.json().items.length,2);
 for(const [index,text] of ['First report','Second report'].entries()){const result=await read(f,base+'/'+index);assert.equal(result.statusCode,200,result.body);assert.equal(result.body,text);}
 assert.deepEqual(counts(f),before);assert.equal(f.artifacts.listForRun(f.runId,'alice').items.length,0);
});

test('foreign, resolved, expired and revoked review requests cannot read frozen output bytes',async t=>{
 for(const condition of ['foreign','resolved','expired','revoked']){
  const f=await files(t),card=(await f.list())[0],base=`/v1/interactions/${card.interaction_id}/outputs`;
  if(condition==='resolved'){const result=await f.send(`/v1/interactions/${card.interaction_id}/response`,{expected_version:card.version,answers:card.questions.map(q=>({question_id:q.question_id,selected_option_ids:['reject'],custom_text:''}))});assert.equal(result.statusCode,202,result.body);}
  if(condition==='expired')f.db.prepare('UPDATE ga_interactions SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z',card.interaction_id);
  if(condition==='revoked')f.persistentTasks.pause('alice',f.task.task_id,f.persistentTasks.get('alice',f.task.task_id).version);
  const result=await read(f,base,condition==='foreign'?'bob':'alice');assert.equal(result.statusCode,condition==='foreign'?404:condition==='expired'?410:409,result.body);
  assert.notEqual((await read(f,base+'/0',condition==='foreign'?'bob':'alice')).statusCode,200);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);
 }
});

test('output selectors cannot inject a path, version or mutable scope and malformed indexes never read a file',async t=>{
 const f=await files(t),card=(await f.list())[0],base=`/v1/interactions/${card.interaction_id}/outputs`;
 for(const suffix of ['?path=report.md','/0?version=2','/-1','/00','/1','/1.0','/99999999999999999'])assert.notEqual((await read(f,base+suffix)).statusCode,200,suffix);
 const ordinary=await fixture(t),other=(await ordinary.list())[0];assert.equal((await read(ordinary,`/v1/interactions/${other.interaction_id}/outputs`)).statusCode,404);
});

test('a successful read is never cached across requests after frozen workspace bytes change',async t=>{
 const f=await files(t),card=(await f.list())[0],base=`/v1/interactions/${card.interaction_id}/outputs`;
 assert.equal((await read(f,base+'/0')).statusCode,200);
 const version=f.db.prepare('SELECT project_id,blob_name FROM wb_file_versions WHERE owner_id=? AND path=? AND version=1').get('alice','report.md');
 writeFileSync(join(f.workbench.projectRoot('alice','ws',version.project_id),'blobs',version.blob_name),'Tampered report bytes');
 assert.equal((await read(f,base)).statusCode,409);assert.equal((await read(f,base+'/0')).statusCode,409);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_task_finalizations').get().n,0);
});

test('generated bytes are reverified on each request rather than reused from an earlier preview',async t=>{
 const candidate={text:'Check the generated report',artifact_refs:[]};const f=await completionFixture(t,{candidate,prepare:f=>{
  const path=join(f.workbench.projectRoot('alice','ws',f.workbench.contextForRun(f.runId).project_id),'generated.md');writeFileSync(path,'Original generated report');
  candidate.artifact_refs.push(f.artifacts.registerGenerated(f.runId,'preview-fresh',[{path,display_name:'report.md'}]).artifact_ref);
 }});
 const card=(await f.list())[0],base=`/v1/interactions/${card.interaction_id}/outputs`;
 assert.equal((await read(f,base+'/0')).statusCode,200);
 const part=f.db.prepare('SELECT server_path FROM ga_artifact_parts LIMIT 1').get();writeFileSync(part.server_path,'Changed generated report');
 assert.equal((await read(f,base)).statusCode,409);assert.equal((await read(f,base+'/0')).statusCode,409);
});

test('preview verification keeps a read snapshot without blocking a separate worker writer',async t=>{
 const f=await files(t),card=(await f.list())[0];f.db.exec('CREATE TABLE preview_write_probe(value INTEGER); INSERT INTO preview_write_probe VALUES(0)');
 const writer=new DatabaseSync(f.fixtureConfig.databasePath);writer.exec('PRAGMA busy_timeout=75');
 const original=f.workbench.readFileVersion.bind(f.workbench);let checked=false;
 f.workbench.readFileVersion=(...args)=>{if(!checked){checked=true;writer.exec('UPDATE preview_write_probe SET value=1');assert.equal(f.db.prepare('SELECT value FROM preview_write_probe').get().value,0);}return original(...args);};
 try{const result=await read(f,`/v1/interactions/${card.interaction_id}/outputs/0`);assert.equal(result.statusCode,200,result.body);assert.equal(checked,true);assert.equal(f.db.prepare('SELECT value FROM preview_write_probe').get().value,1);}finally{writer.close();}
});

test('a pending download bounds concurrent reads and disconnect releases the preview slot',{timeout:15000},async t=>{
 let entered,release;const started=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
 const f=await files(t,f=>f.app.addHook('onSend',async(request,reply,payload)=>{if(request.url.endsWith('/outputs/0')){entered();await hold;}return payload;}));
 const card=(await f.list())[0],base=`/v1/interactions/${card.interaction_id}/outputs`,address=await f.app.listen({host:'127.0.0.1',port:0});let pending;
 try{
  pending=get(address+base+'/0',{headers:{'x-user-id':'alice'}},response=>response.resume());pending.on('error',()=>{});await Promise.race([started,new Promise((resolve,reject)=>pending.once('error',reject))]);
  const blocked=await read(f,base);assert.equal(blocked.statusCode,429,blocked.body);assert.match(blocked.headers['cache-control'],/no-store/);
 }finally{pending?.destroy();release();}
 let recovered;for(let attempt=0;attempt<20;attempt++){await new Promise(resolve=>setTimeout(resolve,20));recovered=await read(f,base);if(recovered.statusCode!==429)break;}
 assert.equal(recovered.statusCode,200,recovered.body);
});

test('workspace completion pins its receipt namespace and artifact rejects an isolated location for shared proof',async t=>{
 const f=await files(t),saved=f.db.prepare('SELECT snapshot_json FROM wb_task_completion_candidates WHERE run_id=?').get(f.runId);
 const output=JSON.parse(saved.snapshot_json).workspace_file_outputs[0];
 assert.equal(output.source,'workspace');
 withImmediateTransaction(f.db,()=>assert.throws(()=>f.artifacts.registerTaskFileVersion({runId:f.runId,receiptId:output.receipt_id,content:'Original reviewed report',location:{source:'isolated',cycle_id:'foreign-cycle',snapshot_id:'foreign-snapshot',isolated_receipt_id:'foreign-local'}}),/task_output_source_unverified/));
});


test('legacy shared pins remain readable only through their original workspace receipt',async t=>{
 const f=await files(t),row=f.db.prepare('SELECT candidate_id,proposal_id,snapshot_json FROM wb_task_completion_candidates WHERE run_id=?').get(f.runId);
 const snapshot=JSON.parse(row.snapshot_json),proposal=JSON.parse(f.db.prepare('SELECT snapshot_json FROM wb_task_goal_proposals WHERE proposal_id=?').get(row.proposal_id).snapshot_json);
 for(const output of [...snapshot.workspace_file_outputs,...proposal.workspace_file_outputs])delete output.source;
 // Simulate bytes created by the previous release, keeping its real original shared proof.
 f.db.exec('DROP TRIGGER wb_task_completion_candidates_no_update');
 for(const trigger of f.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='wb_task_goal_proposals' AND sql LIKE '%BEFORE UPDATE%'").all())f.db.exec('DROP TRIGGER '+trigger.name);
 f.db.prepare('UPDATE wb_task_completion_candidates SET snapshot_json=? WHERE candidate_id=?').run(canonicalJson(snapshot),row.candidate_id);
 f.db.prepare('UPDATE wb_task_goal_proposals SET snapshot_json=? WHERE proposal_id=?').run(canonicalJson(proposal),row.proposal_id);
 const card=(await f.list())[0],base=`/v1/interactions/${card.interaction_id}/outputs`;
 const result=await read(f,base+'/0');assert.equal(result.statusCode,200,result.body);assert.equal(result.body,'Original reviewed report');
});
