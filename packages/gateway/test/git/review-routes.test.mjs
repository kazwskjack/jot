import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,sep} from 'node:path';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {buildServer} from '../../src/server.ts';
const templateRoot=fileURLToPath(new URL('../../file-engine/templates/',import.meta.url));
async function fixture(t){
 const parent=await mkdtemp(join(tmpdir(),'jot-git-review-api-')),root=join(parent,'repo');await mkdir(root);
 const git=(...args)=>execFileSync('git',['-c','user.name=Test Contributor','-c','user.email=test@example.invalid',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','--initial-branch=main');git('config','core.autocrlf','false');await writeFile(join(root,'note.txt'),'before\n');git('add','.');git('commit','-m','Synthetic fixture');await writeFile(join(root,'note.txt'),'after\n');
 const config={databasePath:join(parent,'product.sqlite'),templateRoot,workspaces:['ws'],csrfToken:'test-csrf-review-token',allowedOrigins:['http://127.0.0.1:3030'],gitRepositories:[{owner_id:'owner',project_id:'project',root}]};
 let service=await buildServer(config);service.db.prepare('INSERT INTO ga_projects VALUES(?,?,?,?,?,?,?)').run('project','owner','Review project',0,1,new Date().toISOString(),new Date().toISOString());
 const request=(method,url,payload,key='test-review-request-key',extra={})=>service.app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{'x-user-id':'owner',origin:'http://127.0.0.1:3030','x-csrf-token':'test-csrf-review-token','idempotency-key':key,...extra}});
 t.after(async()=>{await service.app.close();service.db.close();assert.ok(resolve(parent).startsWith(resolve(tmpdir())+sep));await rm(parent,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
 return{root,git,request,get db(){return service.db},async prepare(){const snapshot=(await request('GET','/v1/projects/project/git')).json();return{request_id:'prepare-1',action:'stage',paths:['note.txt'],snapshot_id:snapshot.snapshot_id}},async restart(){await service.app.close();service.db.close();service=await buildServer(config)}};
}
test('original authenticated Git review request and control receipts survive HTTP replay and database reopen',async t=>{
 const f=await fixture(t),input=await f.prepare(),index=await readFile(join(f.root,'.git/index'));
 const response=await f.request('POST','/v1/projects/project/git/intents',input);assert.equal(response.statusCode,201,response.body);const p=response.json();assert.equal(p.state,'prepared');assert.equal(p.execution_authorized,false);assert.equal(response.body.includes(f.root),false);
 const operation='POST /v1/projects/project/git/intents',receipt=f.db.prepare('SELECT response_status,receipt_protocol FROM ga_idempotency WHERE operation=?').get(operation);assert.equal(receipt.response_status,201);assert.equal(receipt.receipt_protocol,'git-review-atomic-v1');
 const url='/v1/projects/project/git/intents/'+p.intent_id+'/control',approval={request_id:'approve-1',expected_version:1,action:'approve',review_sha256:p.review_sha256};
 const approved=await f.request('POST',url,approval,'test-approve-request-key');assert.equal(approved.statusCode,200,approved.body);assert.equal(approved.json().state,'approved');assert.equal(approved.json().execution_authorized,false);
 await f.restart();const replayed=await f.request('POST',url,approval,'test-approve-request-key');assert.deepEqual(replayed.json(),approved.json());assert.match(replayed.headers['cache-control']??'',/no-store/);
 const cancel=await f.request('POST',url,{...approval,request_id:'cancel-1',expected_version:2,action:'cancel'},'test-cancel-request-key');assert.equal(cancel.statusCode,200,cancel.body);
 assert.equal((await f.request('GET',url.replace('/control',''))).json().state,'cancelled');assert.equal((await f.request('POST',url,approval,'test-approve-request-key')).json().state,'approved');assert.deepEqual(await readFile(join(f.root,'.git/index')),index);
});
test('failure to publish the original HTTP acknowledgement rolls back the intent and recovers the same reservation',async t=>{
 const f=await fixture(t),input=await f.prepare();
 f.db.exec("CREATE TRIGGER test_git_review_ack_failure BEFORE UPDATE OF response_status ON ga_idempotency WHEN NEW.receipt_protocol='git-review-atomic-v1' AND NEW.response_status IS NOT NULL BEGIN SELECT RAISE(ABORT,'test_ack_failure'); END;");
 const first=await f.request('POST','/v1/projects/project/git/intents',input);assert.ok(first.statusCode>=400,first.body);
 assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_intents').get().count,0);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_events').get().count,0);
 const pending=f.db.prepare('SELECT response_status,receipt_protocol FROM ga_idempotency').get();assert.equal(pending.response_status,null);assert.equal(pending.receipt_protocol,'git-review-atomic-v1');f.db.exec('DROP TRIGGER test_git_review_ack_failure');
 await f.restart();const retried=await f.request('POST','/v1/projects/project/git/intents',input);assert.equal(retried.statusCode,201,retried.body);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_intents').get().count,1);
 assert.deepEqual((await f.request('POST','/v1/projects/project/git/intents',input)).json(),retried.json());
});
test('cached HTTP acknowledgements cannot bypass revoked project ownership or CSRF',async t=>{
 const f=await fixture(t),input=await f.prepare(),response=await f.request('POST','/v1/projects/project/git/intents',input);assert.equal(response.statusCode,201,response.body);
 assert.equal((await f.request('POST','/v1/projects/project/git/intents',input,'test-review-request-key',{'x-csrf-token':'bad'})).statusCode,403);
 f.db.prepare("UPDATE ga_projects SET owner_id='other' WHERE id='project'").run();const rejected=await f.request('POST','/v1/projects/project/git/intents',input);assert.equal(rejected.statusCode,404,rejected.body);assert.equal(rejected.body.includes('note.txt'),false);
 assert.equal((await f.request('GET','/v1/projects/project/git/intents/'+response.json().intent_id)).statusCode,404);
});
test('review API denies unreviewed selectors, changed bytes and nonlocal operations without mutation',async t=>{
 const f=await fixture(t),input=await f.prepare();
 for(const extra of [{root:resolve('elsewhere')},{action:'push'},{command:'reset --hard'},{paths:['../escape']}])assert.ok((await f.request('POST','/v1/projects/project/git/intents',{...input,...extra},'test-invalid-request-'+JSON.stringify(extra).length)).statusCode>=400);
 const prepared=await f.request('POST','/v1/projects/project/git/intents',input);assert.equal(prepared.statusCode,201,prepared.body);const p=prepared.json();await writeFile(join(f.root,'note.txt'),'changed after review\n');
 const response=await f.request('POST','/v1/projects/project/git/intents/'+p.intent_id+'/control',{request_id:'approve-1',expected_version:1,action:'approve',review_sha256:p.review_sha256},'test-stale-review-key');assert.equal(response.statusCode,409,response.body);
 assert.equal((await f.request('GET','/v1/projects/project/git/intents/'+p.intent_id)).json().state,'prepared');
});
test('failed approval acknowledgement cannot persist a hidden approval and recovers the original control',async t=>{
 const f=await fixture(t),input=await f.prepare(),prepared=await f.request('POST','/v1/projects/project/git/intents',input);assert.equal(prepared.statusCode,201,prepared.body);const p=prepared.json(),url='/v1/projects/project/git/intents/'+p.intent_id+'/control',approval={request_id:'approve-1',expected_version:1,action:'approve',review_sha256:p.review_sha256};
 f.db.exec("CREATE TRIGGER test_git_control_ack_failure BEFORE UPDATE OF response_status ON ga_idempotency WHEN NEW.operation LIKE '%/control' AND NEW.receipt_protocol='git-review-atomic-v1' AND NEW.response_status IS NOT NULL BEGIN SELECT RAISE(ABORT,'test_ack_failure'); END;");
 const failed=await f.request('POST',url,approval,'test-approval-failure-key');assert.ok(failed.statusCode>=400,failed.body);assert.equal((await f.request('GET',url.replace('/control',''))).json().state,'prepared');assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_events').get().count,1);
 f.db.exec('DROP TRIGGER test_git_control_ack_failure');await f.restart();const success=await f.request('POST',url,approval,'test-approval-failure-key');assert.equal(success.statusCode,200,success.body);assert.equal(success.json().state,'approved');assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_events').get().count,2);
});
test('pending old protocol and changed body never resume as a fresh review command',async t=>{
 const f=await fixture(t),input=await f.prepare(),prepared=await f.request('POST','/v1/projects/project/git/intents',input);assert.equal(prepared.statusCode,201,prepared.body);
 const changed=await f.request('POST','/v1/projects/project/git/intents',{...input,action:'discard'});assert.equal(changed.statusCode,409,changed.body);
 f.db.exec("UPDATE ga_idempotency SET response_status=NULL,response_json=NULL,receipt_protocol=NULL WHERE operation='POST /v1/projects/project/git/intents'");
 const pending=await f.request('POST','/v1/projects/project/git/intents',input);assert.equal(pending.statusCode,409,pending.body);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_intents').get().count,1);assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM wb_git_mutation_events').get().count,1);
});
