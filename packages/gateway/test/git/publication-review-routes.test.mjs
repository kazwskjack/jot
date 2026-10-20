import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {buildServer} from '../../src/server.ts';
import {publicationReviewView} from '../../src/persistent-tasks/publication-review-view.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';

async function fixture(t){
 let server;t.after(async()=>{if(server){await server.app.close();server.db.close()}});
 const f=await publicationReviewFixture(t),config={databasePath:join(f.root,'db.sqlite'),templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],csrfToken:'test-publication-csrf-token',allowedOrigins:['http://127.0.0.1:3030'],gitRepositories:[{owner_id:'owner',project_id:f.scope.project_id,root:f.rootTarget}]};
 server=await buildServer(config);
 const url='/v1/projects/'+f.scope.project_id+'/work-publications';
 const request=(method,path,payload,key='test-publication-review-request',headers={})=>server.app.inject({method,url:path,...(payload===undefined?{}:{payload}),headers:{'x-user-id':'owner',origin:config.allowedOrigins[0],'x-csrf-token':config.csrfToken,'idempotency-key':key,...headers}});
 return {...f,url,request,get apiDb(){return server.db},async restart(){await server.app.close();server.db.close();server=await buildServer(config)}};
}

test('owner reviews original publication changes through the actual Gateway without file effects',async t=>{
 const f=await fixture(t),before=await readFile(join(f.rootTarget,'source.md')),index=await readFile(join(f.rootTarget,'.git/index'));
 const prepared=await f.request('POST',f.url,f.input);assert.equal(prepared.statusCode,201,prepared.body);
 const review=prepared.json(),internal=f.service.get('owner',f.scope.project_id,review.intent_id);
 assert.equal(review.review_sha256,internal.review_sha256);assert.equal(review.source.source_sha256,f.source.source_sha256);
 assert.deepEqual(review.source.files,f.source.files);
 assert.deepEqual(review.paths,['source.md']);assert.deepEqual(review.changes,internal.changes);
 assert.equal(review.target.target_sha256,internal.target.target_sha256);
 assert.deepEqual(Object.keys(review.target).sort(),['head','index_sha256','repository_sha256','snapshot_id','target_sha256']);
 assert.equal(prepared.body.includes(f.root),false);assert.equal(prepared.body.includes('ancestors'),false);assert.equal(prepared.body.includes('stat_sha256'),false);
 assert.equal(review.execution_authorized,false);assert.equal(review.state,'prepared');assert.match(prepared.headers['cache-control'],/no-store/);
 const operation='POST '+f.url,receipt=f.apiDb.prepare('SELECT response_status,receipt_protocol,response_json FROM ga_idempotency WHERE operation=?').get(operation);
 assert.equal(receipt.response_status,201);assert.equal(receipt.receipt_protocol,'work-publication-review-atomic-v1');assert.deepEqual(JSON.parse(receipt.response_json),review);
 const control=f.url+'/'+review.intent_id+'/control',input={request_id:'approve-publication',expected_version:1,action:'approve',review_sha256:review.review_sha256};
 const approved=await f.request('POST',control,input,'publication-approve-request');assert.equal(approved.statusCode,200,approved.body);assert.equal(approved.json().state,'approved');assert.equal(approved.json().execution_authorized,false);
 await f.restart();assert.deepEqual((await f.request('POST',control,input,'publication-approve-request')).json(),approved.json());
 const cancelled=await f.request('POST',control,{...input,request_id:'cancel-publication',expected_version:2,action:'cancel'},'publication-cancel-request');assert.equal(cancelled.statusCode,200,cancelled.body);
 assert.equal((await f.request('GET',f.url+'/'+review.intent_id)).json().state,'cancelled');
 assert.deepEqual((await f.request('POST',control,input,'publication-approve-request')).json(),approved.json());
 assert.deepEqual(await readFile(join(f.rootTarget,'source.md')),before);assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),index);
 assert.equal(f.apiDb.prepare("SELECT 1 FROM sqlite_schema WHERE name='wb_work_publication_journal'").get(),undefined);
});

test('original publication and public HTTP receipt roll back together then recover after reopen',async t=>{
 const f=await fixture(t);f.apiDb.exec("CREATE TRIGGER test_publication_ack_failure BEFORE UPDATE OF response_status ON ga_idempotency WHEN NEW.receipt_protocol='work-publication-review-atomic-v1' AND NEW.response_status IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic_ack_failure'); END;");
 const failed=await f.request('POST',f.url,f.input);assert.ok(failed.statusCode>=400,failed.body);
 assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_work_publication_intents').get().n,0);
 assert.equal(f.apiDb.prepare('SELECT response_status FROM ga_idempotency WHERE operation=?').get('POST '+f.url).response_status,null);
 f.apiDb.exec('DROP TRIGGER test_publication_ack_failure');await f.restart();
 const retried=await f.request('POST',f.url,f.input);assert.equal(retried.statusCode,201,retried.body);
 assert.deepEqual((await f.request('POST',f.url,f.input)).json(),retried.json());assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_work_publication_intents').get().n,1);
});

test('cached publication receipts retain ownership, origin and CSRF boundaries',async t=>{
 const f=await fixture(t),prepared=await f.request('POST',f.url,f.input);assert.equal(prepared.statusCode,201,prepared.body);
 for(const headers of [{'x-csrf-token':'invalid'},{origin:'http://untrusted.invalid'}])assert.equal((await f.request('POST',f.url,f.input,undefined,headers)).statusCode,403);
 assert.equal((await f.request('GET',f.url+'/'+prepared.json().intent_id,undefined,undefined,{'x-user-id':''})).statusCode,401);
 f.apiDb.prepare("UPDATE ga_projects SET owner_id='other' WHERE id=?").run(f.scope.project_id);
 assert.equal((await f.request('POST',f.url,f.input)).statusCode,404);
 assert.equal((await f.request('GET',f.url+'/'+prepared.json().intent_id)).statusCode,404);
});

test('publication rejects injected authority and stale targets while keeping original review unchanged',async t=>{
 const f=await fixture(t);
 for(const [n,extra] of [{root:f.rootTarget},{owner_id:'other'},{execution_authorized:true},{paths:['../escape']}].entries())assert.ok((await f.request('POST',f.url,{...f.input,...extra},'publication-invalid-'+n)).statusCode>=400);
 const prepared=await f.request('POST',f.url,f.input);assert.equal(prepared.statusCode,201,prepared.body);const review=prepared.json();
 assert.equal((await f.request('GET',f.url+'/'+review.intent_id+'?root=untrusted')).statusCode,400);
 await writeFile(join(f.rootTarget,'source.md'),'Changed after review\n');
 const approval={request_id:'approve-publication',expected_version:1,action:'approve',review_sha256:review.review_sha256};
 assert.equal((await f.request('POST',f.url+'/'+review.intent_id+'/control',approval,'publication-stale-approve')).statusCode,409);
 assert.equal((await f.request('GET',f.url+'/'+review.intent_id)).json().state,'prepared');
});

test('failed approval acknowledgement cannot leave an unseen approved publication',async t=>{
 const f=await fixture(t),response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,201,response.body);
 const review=response.json(),url=f.url+'/'+review.intent_id+'/control',input={request_id:'approve-publication',expected_version:1,action:'approve',review_sha256:review.review_sha256};
 f.apiDb.exec("CREATE TRIGGER test_publication_control_ack_failure BEFORE UPDATE OF response_status ON ga_idempotency WHEN NEW.receipt_protocol='work-publication-review-atomic-v1' AND NEW.operation LIKE '%/control' AND NEW.response_status IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic_control_ack_failure'); END;");
 assert.ok((await f.request('POST',url,input,'publication-approve-recover')).statusCode>=400);
 assert.equal((await f.request('GET',f.url+'/'+review.intent_id)).json().state,'prepared');
 f.apiDb.exec('DROP TRIGGER test_publication_control_ack_failure');await f.restart();
 const retried=await f.request('POST',url,input,'publication-approve-recover');assert.equal(retried.statusCode,200,retried.body);assert.equal(retried.json().version,2);
 assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_work_publication_events WHERE intent_id=?').get(review.intent_id).n,2);
 assert.deepEqual((await f.request('POST',url,input,'publication-approve-recover')).json(),retried.json());
});

test('publication receipt conflicts and legacy pending records never authorize a second review',async t=>{
 const f=await fixture(t),response=await f.request('POST',f.url,f.input);assert.equal(response.statusCode,201,response.body);
 assert.equal((await f.request('POST',f.url,{...f.input,request_id:'changed-request'})).statusCode,409);
 f.apiDb.prepare('UPDATE ga_idempotency SET response_status=NULL,response_json=NULL,receipt_protocol=NULL WHERE operation=?').run('POST '+f.url);
 assert.equal((await f.request('POST',f.url,f.input)).statusCode,409);
 assert.equal(f.apiDb.prepare('SELECT count(*) n FROM wb_work_publication_intents').get().n,1);
});

test('public publication projection is detached, excludes internal witnesses and passes strict contracts',async t=>{
 const f=await fixture(t),internal=await f.service.prepare('owner',f.scope.project_id,f.input),input=structuredClone(internal);
 input.root='private-root';input.target.root='private-target';input.target.head.root='private-head';input.source.root='private-source';input.changes[0].root='private-change';input.changes[0].after.root='private-entry';
 const view=publicationReviewView(input),body=JSON.stringify(view),contracts=new ContractValidator(),operation=contracts.operationFor('POST',f.url.replace(f.scope.project_id,':projectId'));
 assert.ok(operation);assert.equal(contracts.validateResponse(operation,201,view).valid,true);
 assert.equal(body.includes('private-'),false);assert.equal(view.review_sha256,internal.review_sha256);
 assert.throws(()=>{view.changes[0].after_text='replacement'},TypeError);assert.equal(internal.changes[0].after_text,input.changes[0].after_text);
 for(const patch of [{execution_authorized:true},{state:'applied'},{target:{...view.target,root:'host-root'}},{source:{...view.source,session_ref:{id:'private'}}},{changes:[{...view.changes[0],path:'../escape'}]}])assert.equal(contracts.validateResponse(operation,201,{...view,...patch}).valid,false);
});

test('configured Gateway without publication schema refuses review and installs no publication tables',async t=>{
 const f=await publicationReviewFixture(t),server=await buildServer({databasePath:join(f.root,'unupgraded.sqlite'),templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],gitRepositories:[{owner_id:'owner',project_id:'project',root:f.rootTarget}]});
 try{
  server.db.prepare('INSERT INTO ga_projects(id,owner_id,title,is_default,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('project','owner','Synthetic project',0,1,'now','now');
  const version=server.db.prepare('PRAGMA schema_version').get().schema_version,changes=server.db.prepare('SELECT total_changes() n').get().n;
  const response=await server.app.inject({method:'GET',url:'/v1/projects/project/work-publications/unknown',headers:{'x-user-id':'owner'}});
  assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'WORK_PUBLICATION_REVIEW_UNAVAILABLE');assert.equal(response.body.includes('sqlite'),false);
  assert.equal(server.db.prepare("SELECT 1 FROM sqlite_schema WHERE name='wb_work_publication_intents'").get(),undefined);
  assert.equal(server.db.prepare('PRAGMA schema_version').get().schema_version,version);assert.equal(server.db.prepare('SELECT total_changes() n').get().n,changes);
 }finally{await server.app.close();server.db.close()}
});
