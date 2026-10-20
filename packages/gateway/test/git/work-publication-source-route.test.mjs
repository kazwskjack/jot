import test from 'node:test';import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {upgradeWorkspacePublicationCoordination} from '../../src/workbench/workspace-coordination-upgrade.ts';
import {WorkPublicationExecutions,installWorkPublicationExecutions} from '../../src/persistent-tasks/work-publication-executions.ts';
import {GitIndexExecutions} from '../../src/git/index-executions.ts';
import {GitMutationIntents} from '../../src/git/intents.ts';
import {ProjectRepository} from '../../src/projects/repository.ts';
import {registerGitWorkspaceSource} from '../../src/git/workspace-source-route.ts';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
const token='test-publication-source-token',url='/internal/v1/workbench/git-workspace-source';
async function fixture(t){
 const f=await publicationReviewFixture(t),review=await f.service.prepare('owner',f.scope.project_id,f.input),approved=await f.service.control('owner',f.scope.project_id,review.intent_id,{request_id:'approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 upgradeWorkspacePublicationCoordination(f.db);installWorkPublicationExecutions(f.db);
 const executions=new WorkPublicationExecutions(f.db,f.workbench,f.service),accepted=withImmediateTransaction(f.db,()=>executions.admit('owner',f.scope.project_id,review.intent_id,{request_id:'publication',expected_version:approved.version,review_sha256:approved.review_sha256}));
 const projects=new ProjectRepository(f.db),index=new GitIndexExecutions(f.db,projects,f.workbench,new GitMutationIntents(f.db,projects,f.workbench)),app=Fastify();t.after(()=>app.close());
 registerGitWorkspaceSource(app,index,token,f.db,executions);
 const scope={owner_id:'owner',project_id:f.scope.project_id,execution_id:accepted.execution_id,operation_kind:'work_publication'};
 const request=(payload=scope,authorization='Bearer '+token)=>app.inject({method:'POST',url,headers:{authorization},payload});
 return{...f,review,executions,accepted,scope,request,app};
}
test('original authenticated publication inventory is distinct, source-bound and does not expose private placement',async t=>{
 const f=await fixture(t);assert.equal((await f.request()).statusCode,409);
 const held=f.executions.reserveWorkspace('owner',f.scope.project_id,f.accepted.execution_id),response=await f.request();
 assert.equal(response.statusCode,200,response.body);assert.equal(response.json().source.operation_kind,'work_publication');assert.equal(response.json().source.reservation_id,held.reservation_id);
 assert.equal(response.body.includes(f.root),false);assert.match(response.headers['cache-control'],/no-store/);
 const bridge=new WorkbenchBridge({origin:'http://127.0.0.1:7654',token,fetchImpl:async(_url,init)=>{const r=await f.app.inject({method:init.method,url,headers:init.headers,payload:JSON.parse(init.body)});return new Response(r.body,{status:r.statusCode,headers:r.headers});}});
 const family=await bridge.workspaceFamily(f.scope);assert.equal(family.operation_kind,'work_publication');assert.ok(family.members.some(m=>m.session_ref==='work-test-session'));
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_producers').get().n,0);
});
test('publication inventory cannot be borrowed through an index selector, another owner or caller roots',async t=>{
 const f=await fixture(t);f.executions.reserveWorkspace('owner',f.scope.project_id,f.accepted.execution_id);
 assert.equal((await f.request(f.scope,'')).statusCode,401);
 for(const payload of [{...f.scope,operation_kind:'git_index'},{...f.scope,owner_id:'foreign'},Object.fromEntries(Object.entries(f.scope).filter(([key])=>key!=='operation_kind'))])assert.equal((await f.request(payload)).statusCode,409);
 for(const payload of [{...f.scope,operation_kind:'invented'},{...f.scope,root:f.rootTarget},{...f.scope,members:[]}])assert.equal((await f.request(payload)).statusCode,422);
 await f.service.control('owner',f.scope.project_id,f.review.intent_id,{request_id:'cancel',action:'cancel',expected_version:2,review_sha256:f.review.review_sha256});assert.equal((await f.request()).statusCode,409);
});
