import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {buildServer} from '../../src/server.ts';
import {upgradeWorkspacePublicationCoordination} from '../../src/workbench/workspace-coordination-upgrade.ts';
import {installWorkPublicationExecutions} from '../../src/persistent-tasks/work-publication-executions.ts';

async function fixture(t,options={}){
 let server;t.after(async()=>{if(server){await server.app.close();server.db.close()}});
 const f=await publicationReviewFixture(t),review=await f.service.prepare('owner',f.scope.project_id,f.input),approved=await f.service.control('owner',f.scope.project_id,review.intent_id,{request_id:'approve',expected_version:1,action:'approve',review_sha256:review.review_sha256});
 upgradeWorkspacePublicationCoordination(f.db);installWorkPublicationExecutions(f.db);
 const config={databasePath:join(f.root,'db.sqlite'),templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],csrfToken:'test-publication-admit-csrf',allowedOrigins:['http://127.0.0.1:3030'],gitRepositories:[{owner_id:'owner',project_id:f.scope.project_id,root:f.rootTarget}]};
 if(options.nativeGitClient)config.nativeGitClient=options.nativeGitClient;
 server=await buildServer(config);
 const base='/v1/projects/'+f.scope.project_id,url=base+'/work-publications/'+review.intent_id+'/admissions',input={request_id:'test-publication-admit',expected_version:approved.version,review_sha256:approved.review_sha256};
 const request=(method,path,payload,key='test-publication-admit-key',headers={})=>server.app.inject({method,url:path,...(payload===undefined?{}:{payload}),headers:{'x-user-id':'owner',origin:config.allowedOrigins[0],'x-csrf-token':config.csrfToken,'idempotency-key':key,...headers}});
 return {...f,review,approved,base,url,input,request,get apiDb(){return server.db},async restart(){await server.app.close();server.db.close();server=await buildServer(config)}};
}

test('original publication acceptance and current journal are distinct owner reads with no effects',async t=>{
 const f=await fixture(t),before=await readFile(join(f.rootTarget,'source.md')),index=await readFile(join(f.rootTarget,'.git/index'));
 const response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,202,response.body);const accepted=response.json();
 assert.equal(accepted.state,'accepted');assert.equal(accepted.review_sha256,f.approved.review_sha256);assert.equal(accepted.execution_authorized,false);
 assert.equal(accepted.operation_kind,'work_publication');assert.equal(response.body.includes(f.root),false);
 const receipt=f.apiDb.prepare('SELECT response_status,receipt_protocol FROM ga_idempotency WHERE operation=?').get('POST '+f.url);assert.equal(receipt.response_status,202);assert.equal(receipt.receipt_protocol,'work-publication-admission-atomic-v1');
 const acceptanceUrl=f.base+'/work-publication-admissions/'+f.input.request_id,currentUrl=f.base+'/work-publication-executions/'+accepted.execution_id;
 assert.deepEqual((await f.request('GET',acceptanceUrl)).json(),accepted);
 const changes=f.apiDb.prepare('SELECT total_changes() n').get().n,current=await f.request('GET',currentUrl);assert.equal(current.statusCode,200,current.body);assert.equal(current.json().state,'not_started');assert.equal(current.json().journal_sha256,null);assert.equal(current.json().pending_path,null);assert.deepEqual(current.json().files,[]);assert.match(current.headers['cache-control'],/no-store/);assert.equal(f.apiDb.prepare('SELECT total_changes() n').get().n,changes);
 await f.restart();assert.deepEqual((await f.request('POST',f.url,f.input)).json(),accepted);
 assert.equal((await f.request('POST',f.base+'/work-publications/'+f.review.intent_id+'/control',{request_id:'cancel-after-admission',expected_version:2,action:'cancel',review_sha256:f.review.review_sha256},'test-cancel-after-admit')).statusCode,200);
 assert.deepEqual((await f.request('GET',acceptanceUrl)).json(),accepted);assert.equal((await f.request('GET',currentUrl)).json().state,'not_started');
 assert.deepEqual(await readFile(join(f.rootTarget,'source.md')),before);assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),index);
 for(const table of ['wb_work_publication_journal','wb_workspace_reservations','ga_worker_leases'])assert.equal(f.apiDb.prepare('SELECT count(*) n FROM '+table).get().n,0);
 assert.equal((await f.request('GET',currentUrl+'?root=untrusted')).statusCode,400);
 for(const path of [acceptanceUrl,currentUrl])assert.equal((await f.request('GET',path,undefined,undefined,{'x-user-id':'foreign'})).statusCode,404);
 f.apiDb.prepare("UPDATE ga_projects SET owner_id='other' WHERE id=?").run(f.scope.project_id);
 assert.equal((await f.request('POST',f.url,f.input)).statusCode,404);
});

test('lost acceptance acknowledgement rolls back original admission and recovers exactly once',async t=>{
 const f=await fixture(t);f.apiDb.exec("CREATE TRIGGER test_publication_admit_ack_failure BEFORE UPDATE OF response_status ON ga_idempotency WHEN NEW.receipt_protocol='work-publication-admission-atomic-v1' AND NEW.response_status IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic_admit_ack_failure'); END;");
 assert.ok((await f.request('POST',f.url,f.input)).statusCode>=400);
 assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_work_publication_executions').get().n,0);assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_work_publication_admissions').get().n,0);
 f.apiDb.exec('DROP TRIGGER test_publication_admit_ack_failure');await f.restart();const response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,202,response.body);
 assert.deepEqual((await f.request('POST',f.url,f.input)).json(),response.json());assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_work_publication_executions').get().n,1);
});

test('publication admission refuses unapproved review, authority fields and stale protocol',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('POST',f.url,{...f.input,expected_version:1},'test-wrong-review-version')).statusCode,409);
 for(const [n,extra] of [{root:f.rootTarget},{executor:'caller'},{owner_id:'foreign'},{execution_authorized:true}].entries())assert.equal((await f.request('POST',f.url,{...f.input,...extra},'test-injected-admit-'+n)).statusCode,400);
 assert.equal((await f.request('POST',f.url,f.input,undefined,{'x-csrf-token':'invalid'})).statusCode,403);
 const response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,202,response.body);
 f.apiDb.prepare('UPDATE ga_idempotency SET response_status=NULL,response_json=NULL,receipt_protocol=NULL WHERE operation=?').run('POST '+f.url);
 assert.equal((await f.request('POST',f.url,f.input)).statusCode,409);
 assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_work_publication_executions').get().n,1);
});

test('a peer acknowledgement cannot replace original journal evidence or replay an uncertain HTTP command',async t=>{
 const seen=[],client={execute:async(scope,signal)=>{seen.push(scope);assert.ok(Object.isFrozen(scope));assert.ok(signal instanceof AbortSignal);return{state:'applied',files:[{path:'unverified'}]}}},f=await fixture(t,{nativeGitClient:client});
 const originalFile=await readFile(join(f.rootTarget,'source.md'));
 const admitted=await f.request('POST',f.url,f.input);assert.equal(admitted.statusCode,202,admitted.body);const accepted=admitted.json(),url=f.base+'/work-publication-executions/'+accepted.execution_id+'/dispatch';
 for(const [n,payload] of [{root:f.rootTarget},{owner_id:'foreign'},{module:'caller'}].entries())assert.equal((await f.request('POST',url,payload,'test-dispatch-injection-'+n)).statusCode,400);
 assert.equal((await f.request('POST',url,{},'test-dispatch-no-csrf',{'x-csrf-token':'invalid'})).statusCode,403);
 assert.equal((await f.request('POST',url,{},'test-dispatch-foreign',{'x-user-id':'foreign'})).statusCode,404);assert.equal(seen.length,0);
 const response=await f.request('POST',url,{},'test-peer-claim');assert.equal(response.statusCode,503,response.body);assert.equal(response.json().error.code,'WORK_PUBLICATION_DISPATCH_UNCONFIRMED');
 assert.deepEqual(seen,[{owner_id:'owner',project_id:f.scope.project_id,execution_id:accepted.execution_id,operation_kind:'work_publication'}]);
 await f.restart();assert.deepEqual((await f.request('POST',url,{},'test-peer-claim')).json(),response.json());assert.equal(seen.length,1);
 f.apiDb.prepare('UPDATE ga_idempotency SET response_status=NULL,response_json=NULL WHERE operation=?').run('POST '+url);
 assert.equal((await f.request('POST',url,{},'test-peer-claim')).statusCode,409);assert.equal(seen.length,1);
 for(const table of ['wb_work_publication_journal','wb_workspace_reservations','ga_worker_leases'])assert.equal(f.apiDb.prepare('SELECT count(*) n FROM '+table).get().n,0);
 assert.deepEqual(await readFile(join(f.rootTarget,'source.md')),originalFile);
});

test('unconfigured native dispatch and malformed recovery never manufacture a file effect or command receipt',async t=>{
 const f=await fixture(t),admitted=await f.request('POST',f.url,f.input);assert.equal(admitted.statusCode,202,admitted.body);
 const url=f.base+'/work-publication-executions/'+admitted.json().execution_id;
 const result=await f.request('POST',url+'/dispatch',{},'test-unconfigured-dispatch');assert.equal(result.statusCode,503,result.body);assert.equal(result.json().error.code,'WORK_PUBLICATION_DISPATCH_UNAVAILABLE');
 const command={request_id:'owner-command',action:'abandon_unknown',expected_journal_sha256:'a'.repeat(64),acknowledge_unknown:true};
 for(const [n,extra] of [{acknowledge_unknown:false},{expected_journal_sha256:'unknown'},{root:f.rootTarget},{action:'delete-files'}].entries())assert.equal((await f.request('POST',url+'/settle',{...command,...extra},'test-invalid-settlement-'+n)).statusCode,400);
 assert.equal((await f.request('GET',url+'/settlements/'+command.request_id)).statusCode,404);
 assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,0);
});

test('owned source history discovers original reviews and executions after reopen without browser metadata',async t=>{
 const f=await fixture(t),path=f.base+'/work-publication-sources/'+f.source.run_id+'/history';
 let response=await f.request('GET',path);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().items.length,1);
 assert.equal(response.json().items[0].intent_id,f.review.intent_id);assert.equal(response.json().items[0].acceptance,null);assert.equal(response.json().items[0].status,null);
 const admitted=await f.request('POST',f.url,f.input);assert.equal(admitted.statusCode,202,admitted.body);await f.restart();
 const changes=f.apiDb.prepare('SELECT total_changes() n').get().n;response=await f.request('GET',path);assert.equal(response.statusCode,200,response.body);
 const item=response.json().items[0];assert.deepEqual(item.acceptance,admitted.json());assert.equal(item.status.execution_id,admitted.json().execution_id);assert.equal(item.status.state,'not_started');assert.equal(item.source_sha256,f.source.source_sha256);
 assert.equal(response.json().source_run_id,f.source.run_id);assert.equal(response.body.includes(f.root),false);assert.match(response.headers['cache-control'],/no-store/);assert.equal(f.apiDb.prepare('SELECT total_changes() n').get().n,changes);
 assert.equal((await f.request('GET',path+'?root=caller')).statusCode,400);assert.equal((await f.request('GET',path+'?before=foreign-cursor')).statusCode,404);
 assert.equal((await f.request('GET',path,undefined,undefined,{'x-user-id':'foreign'})).statusCode,404);
});
