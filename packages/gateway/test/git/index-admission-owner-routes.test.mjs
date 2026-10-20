import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
import {indexResolutionFixture} from '../support/index-resolution-fixture.mjs';import {buildServer} from '../../src/server.ts';
async function fixture(t){
 let api;t.after(async()=>{if(api){await api.app.close();api.db.close()}});const f=await indexResolutionFixture(t),review=await f.review();
 const config={databasePath:f.database,templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],csrfToken:'test-index-admission-csrf',allowedOrigins:['http://127.0.0.1:3030'],gitRepositories:[{owner_id:'owner',project_id:'project',root:f.repository}],nativeGitClient:{async execute(){throw Error('test_unexpected_native_call')}}};
 api=await buildServer(config);const base='/v1/projects/project/git',url=base+'/intents/'+review.approved.intent_id+'/admissions';
 const request=(method,url,payload,key='test-index-admission-key',headers={})=>api.app.inject({method,url,...(payload===undefined?{}:{payload}),headers:{'x-user-id':'owner',origin:config.allowedOrigins[0],'x-csrf-token':config.csrfToken,'idempotency-key':key,...headers}});
 return{...f,...review,base,url,request,get apiDb(){return api.db},async restart(overrides={}){await api.app.close();api.db.close();Object.assign(config,overrides);api=await buildServer(config)}};
}
const noEffects=f=>{for(const table of ['wb_git_index_producers','ga_worker_leases','wb_workspace_reservations'])assert.equal(f.apiDb.prepare('SELECT count(*) n FROM '+table).get().n,0)};
test('HTTP original index admission is atomic and stays distinct from current result after cancellation and restart',async t=>{
 const f=await fixture(t),before=await readFile(join(f.repository,'.git/index')),response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,202,response.body);const receipt=response.json();assert.equal(receipt.accepted,true);assert.equal(receipt.execution_authorized,false);assert.match(response.headers['cache-control'],/no-store/);
 assert.equal(f.apiDb.prepare('SELECT receipt_protocol FROM ga_idempotency WHERE operation=?').get('POST '+f.url).receipt_protocol,'git-index-admission-atomic-v1');
 assert.deepEqual((await f.request('GET',f.base+'/admissions/'+f.input.request_id)).json(),receipt);
 assert.equal((await f.request('GET',f.base+'/executions/'+receipt.execution_id)).json().state,'pending');
 await f.current.intents.control('owner','project',f.approved.intent_id,{request_id:'cancel-review',expected_version:f.approved.version,review_sha256:f.approved.review_sha256,action:'cancel'});await f.restart();
 assert.deepEqual((await f.request('POST',f.url,f.input)).json(),receipt);noEffects(f);assert.deepEqual(await readFile(join(f.repository,'.git/index')),before);
});
test('failed index HTTP acknowledgement rolls back acceptance and reuses its original pending request after restart',async t=>{
 const f=await fixture(t);f.apiDb.exec("CREATE TRIGGER test_index_admission_ack_failure BEFORE UPDATE OF response_status ON ga_idempotency WHEN NEW.receipt_protocol='git-index-admission-atomic-v1' AND NEW.response_status IS NOT NULL BEGIN SELECT RAISE(ABORT,'test_ack_failure'); END;");
 const failed=await f.request('POST',f.url,f.input);assert.ok(failed.statusCode>=400,failed.body);assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_git_index_executions').get().n,0);assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_git_index_admissions').get().n,0);noEffects(f);
 f.apiDb.exec('DROP TRIGGER test_index_admission_ack_failure');await f.restart();const retry=await f.request('POST',f.url,f.input);assert.equal(retry.statusCode,202,retry.body);assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_git_index_executions').get().n,1);noEffects(f);
});
test('index admission refuses caller roots, bad CSRF, foreign owners, changed bodies and cached requests after transfer',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('POST',f.url,{...f.input,root:'caller'},'test-root-injection')).statusCode,400);
 assert.equal((await f.request('POST',f.url,f.input,'test-bad-csrf',{'x-csrf-token':'wrong'})).statusCode,403);
 assert.equal((await f.request('POST',f.url,f.input,'test-foreign-owner',{'x-user-id':'other'})).statusCode,404);
 const accepted=await f.request('POST',f.url,f.input);assert.equal(accepted.statusCode,202,accepted.body);
 assert.equal((await f.request('POST',f.url,{...f.input,request_id:'replacement'})).statusCode,409);
 f.apiDb.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('other','project');
 assert.equal((await f.request('POST',f.url,f.input)).statusCode,404);noEffects(f);
});
test('a legacy pending HTTP request cannot be adopted by the new atomic index admission protocol',async t=>{
 const f=await fixture(t),response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,202,response.body);
 f.apiDb.prepare('UPDATE ga_idempotency SET response_status=NULL,response_json=NULL,receipt_protocol=NULL WHERE operation=?').run('POST '+f.url);await f.restart();
 assert.equal((await f.request('POST',f.url,f.input)).statusCode,409);assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_git_index_executions').get().n,1);noEffects(f);
});
test('HTTP control admission commits the original exact command without native work or permission renewal',async t=>{
 const f=await fixture(t),response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,202,response.body);const id=response.json().execution_id,path=f.base+'/executions/'+id,command={request_id:'original-control',expected_state_sha256:f.current.executions.inspect('owner','project',id).state_sha256,acknowledge_unknown:true};
 const accepted=await f.request('POST',path+'/controls',command,'test-control-original');assert.equal(accepted.statusCode,202,accepted.body);assert.equal(accepted.json().execution_authorized,false);assert.equal(accepted.json().expected_state_sha256,command.expected_state_sha256);
 assert.equal(f.apiDb.prepare('SELECT receipt_protocol FROM ga_idempotency WHERE operation=?').get('POST '+path+'/controls').receipt_protocol,'git-index-control-admission-atomic-v1');
 noEffects(f);assert.equal(f.current.executions.getControl('owner','project',id,command.request_id).state,'pending');
 const changes=f.apiDb.prepare('SELECT total_changes() n').get().n;const inspection=await f.request('GET',path+'/inspection');assert.equal(inspection.statusCode,200,inspection.body);assert.equal(inspection.json().state_sha256,command.expected_state_sha256);assert.match(inspection.headers['cache-control'],/no-store/);assert.equal(f.apiDb.prepare('SELECT total_changes() n').get().n,changes);
 await f.current.intents.control('owner','project',f.approved.intent_id,{request_id:'cancel-after-control',expected_version:f.approved.version,review_sha256:f.approved.review_sha256,action:'cancel'});await f.restart();
 assert.deepEqual((await f.request('POST',path+'/controls',command,'test-control-original')).json(),accepted.json());
 assert.deepEqual((await f.request('GET',path+'/control-admissions/'+command.request_id)).json(),accepted.json());
 assert.equal((await f.request('GET',path+'/controls/'+command.request_id)).json().state,'pending');
 await assert.rejects(f.current.executions.perform('owner','project',id),/git_execution_control_pending|git_intent_not_approved/);noEffects(f);
});
test('cached original admission still requires current configured repository service readiness',async t=>{
 const f=await fixture(t),response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,202,response.body);
 await f.restart({gitRepositories:[]});const unavailable=await f.request('POST',f.url,f.input);assert.equal(unavailable.statusCode,503,unavailable.body);assert.equal(unavailable.json().error.code,'GIT_REPOSITORY_UNCONFIGURED');noEffects(f);
});
test('failed control acknowledgement rolls back the control and preserves its exact request for recovery',async t=>{
 const f=await fixture(t),response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,202,response.body);const id=response.json().execution_id,path=f.base+'/executions/'+id+'/controls',command={request_id:'ack-control',expected_state_sha256:f.current.executions.inspect('owner','project',id).state_sha256,acknowledge_unknown:true};
 f.apiDb.exec("CREATE TRIGGER test_index_control_ack_failure BEFORE UPDATE OF response_status ON ga_idempotency WHEN NEW.receipt_protocol='git-index-control-admission-atomic-v1' AND NEW.response_status IS NOT NULL BEGIN SELECT RAISE(ABORT,'test_ack_failure'); END;");
 const failed=await f.request('POST',path,command,'test-control-ack');assert.ok(failed.statusCode>=400,failed.body);assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_git_index_controls').get().n,0);noEffects(f);
 f.apiDb.exec('DROP TRIGGER test_index_control_ack_failure');await f.restart();const retry=await f.request('POST',path,command,'test-control-ack');assert.equal(retry.statusCode,202,retry.body);assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_git_index_controls').get().n,1);
 f.apiDb.prepare('UPDATE ga_projects SET owner_id=? WHERE id=?').run('other','project');assert.equal((await f.request('POST',path,command,'test-control-ack')).statusCode,404);noEffects(f);
});
