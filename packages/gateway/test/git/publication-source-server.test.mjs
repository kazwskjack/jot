import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {buildServer} from '../../src/server.ts';
import {WorkPublicationExecutions,installWorkPublicationExecutions} from '../../src/persistent-tasks/work-publication-executions.ts';
import {upgradeWorkspacePublicationCoordination} from '../../src/workbench/workspace-coordination-upgrade.ts';
import {withImmediateTransaction} from '../../src/db/database.ts';

test('a Gateway without configured repositories still supports its original in-memory service',async()=>{
 const token='test-no-repository-publication-source-token',service=await buildServer({databasePath:':memory:',templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],internalChannelToken:token});
 try{
  assert.equal(service.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wb_work_publication_journal'").get(),undefined);
  const response=await service.app.inject({method:'POST',url:'/internal/v1/workbench/git-workspace-source',headers:{authorization:'Bearer '+token},payload:{owner_id:'owner',project_id:'project',execution_id:'execution',operation_kind:'work_publication'}});
  assert.equal(response.statusCode,409);assert.equal(response.json().error.code,'GIT_WORKSPACE_SOURCE_UNCONFIRMED');
 }finally{await service.app.close();service.db.close()}
});

test('actual Gateway serves only the original admitted publication family without dispatching effects',async t=>{
 const f=await publicationReviewFixture(t),token='test-publication-gateway-source-token';
 const review=await f.service.prepare('owner',f.scope.project_id,f.input),approved=await f.service.control('owner',f.scope.project_id,review.intent_id,{request_id:'approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 upgradeWorkspacePublicationCoordination(f.db);installWorkPublicationExecutions(f.db);
 const executions=new WorkPublicationExecutions(f.db,f.workbench,f.service),accepted=withImmediateTransaction(f.db,()=>executions.admit('owner',f.scope.project_id,review.intent_id,{request_id:'admit',expected_version:approved.version,review_sha256:approved.review_sha256}));
 executions.reserveWorkspace('owner',f.scope.project_id,accepted.execution_id);
 const service=await buildServer({databasePath:join(f.root,'db.sqlite'),templateRoot:fileURLToPath(new URL('../../file-engine/templates/',import.meta.url)),workspaces:['ws'],internalChannelToken:token,gitRepositories:[{owner_id:'owner',project_id:f.scope.project_id,root:f.rootTarget}]});
 try{
  const schema=service.db.prepare('PRAGMA schema_version').get().schema_version,changes=service.db.prepare('SELECT total_changes() n').get().n;
  const payload={owner_id:'owner',project_id:f.scope.project_id,execution_id:accepted.execution_id,operation_kind:'work_publication'},url='/internal/v1/workbench/git-workspace-source';
  const request=(value=payload,authorization='Bearer '+token)=>service.app.inject({method:'POST',url,headers:{authorization},payload:value});
  assert.equal((await request(payload,'')).statusCode,401);
  assert.equal((await request({...payload,owner_id:'foreign'})).statusCode,409);
  assert.equal((await request({...payload,operation_kind:'git_index'})).statusCode,409);
  assert.equal((await request({...payload,root:f.rootTarget})).statusCode,422);
  const response=await request();assert.equal(response.statusCode,200,response.body);
  const source=response.json().source;assert.equal(source.operation_kind,'work_publication');assert.equal(source.execution_id,accepted.execution_id);
  assert.equal(source.family_sha256,executions.workspaceFamily('owner',f.scope.project_id,accepted.execution_id).family_sha256);
  assert.equal(response.body.includes(f.root),false);assert.match(response.headers['cache-control'],/no-store/);
  assert.equal(service.db.prepare('PRAGMA schema_version').get().schema_version,schema);
  assert.equal(service.db.prepare('SELECT total_changes() n').get().n,changes);
  assert.equal(service.db.prepare('SELECT count(*) n FROM wb_work_publication_journal').get().n,0);
  assert.equal(service.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);
 }finally{await service.app.close();service.db.close()}
});
