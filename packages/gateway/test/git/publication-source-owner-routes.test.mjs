import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {buildServer} from '../../src/server.ts';
import {ContractValidator} from '../../src/contracts/validator.ts';

test('owner reads the original finalized source digest then prepares an exact publication review',async t=>{
 let server;t.after(async()=>{if(server){await server.app.close();server.db.close()}});
 const f=await publicationReviewFixture(t);
 server=await buildServer({databasePath:join(f.root,'db.sqlite'),templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],gitRepositories:[{owner_id:'owner',project_id:f.scope.project_id,root:f.rootTarget}]});
 const project=f.scope.project_id,url='/v1/projects/'+project+'/work-publication-sources/'+f.admission.run_id,headers={'x-user-id':'owner'},count=()=>server.db.prepare('SELECT total_changes() n').get().n;
 const before=count(),schema=server.db.prepare('PRAGMA schema_version').get().schema_version;
 const response=await server.app.inject({method:'GET',url,headers});assert.equal(response.statusCode,200,response.body);
 const contracts=new ContractValidator(),operation=contracts.operationFor('GET','/v1/projects/:projectId/work-publication-sources/:runId');assert.ok(operation);
 assert.equal(contracts.validateResponse(operation,200,response.json()).valid,true);
 const source=response.json();assert.equal(source.source_sha256,f.source.source_sha256);assert.deepEqual(source.files,f.source.files);assert.deepEqual(source.work_review,f.source.work_review);
 assert.equal(response.body.includes(f.root),false);assert.match(response.headers['cache-control'],/no-store/);assert.equal(count(),before);assert.equal(server.db.prepare('PRAGMA schema_version').get().schema_version,schema);
 const prepared=await server.app.inject({method:'POST',url:'/v1/projects/'+project+'/work-publications',headers,payload:{request_id:'source-read-prepare',source_run_id:source.run_id,source_sha256:source.source_sha256,paths:['source.md']}});
 assert.equal(prepared.statusCode,201,prepared.body);assert.deepEqual(prepared.json().source,source);assert.equal(prepared.json().execution_authorized,false);
 assert.equal((await server.app.inject({method:'GET',url,headers:{'x-user-id':'foreign'}})).statusCode,404);
 assert.equal((await server.app.inject({method:'GET',url:url.replace(project,'other-project'),headers})).statusCode,404);
 assert.equal((await server.app.inject({method:'GET',url:url+'?root=untrusted',headers})).statusCode,400);
 assert.equal((await server.app.inject({method:'GET',url:url.replace(f.admission.run_id,'missing-run'),headers})).statusCode,404);
 server.db.prepare("UPDATE ga_projects SET owner_id='other' WHERE id=?").run(project);
 assert.equal((await server.app.inject({method:'GET',url,headers})).statusCode,404);
});
