import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,rename,mkdir,rmdir} from 'node:fs/promises';import {join} from 'node:path';
import {publicationNativeHostFixture} from '../support/publication-native-host-fixture.mjs';
import {ProjectRepository} from '../../src/projects/repository.ts';import {GitMutationIntents} from '../../src/git/intents.ts';import {GitIndexExecutions} from '../../src/git/index-executions.ts';import {withImmediateTransaction} from '../../src/db/database.ts';
import {inspectNativeWorkspaceSource,assertNativeWorkspaceSourceAdmission} from '../../../session-adapter/native-workspace-source.js';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES;

for(const custody of ['resident','cold'])test('original stage and unstage retain all historical isolated native workspaces: '+custody,{skip:!runtime,timeout:120000},async t=>{
 const f=await publicationNativeHostFixture(t,{additionalHistory:custody==='cold'?'cold':true}),projects=new ProjectRepository(f.db),intents=new GitMutationIntents(f.db,projects,f.workbench);
 const source=new FinalizedWorkSources(f.db),beforeSource=source.summary('owner',f.source.run_id),versions=f.db.prepare('SELECT count(*) n FROM wb_file_versions').get().n,runs=f.db.prepare('SELECT count(*) n FROM ga_runs').get().n;
 const executions=new GitIndexExecutions(f.db,projects,f.workbench,intents,{nativeWorkspaceHost:{withReservedFamily:f.host.withReservedFamily,inspect:inspectNativeWorkspaceSource,assertAdmission:assertNativeWorkspaceSourceAdmission}});
 const edited='Reviewed configured target edit';await writeFile(join(f.rootTarget,'source.md'),edited);
 for(const action of ['stage','unstage']){
  const snapshot=await f.workbench.inspect('owner',f.scope.project_id),review=await intents.prepare('owner',f.scope.project_id,{request_id:action+'-review',action,paths:['source.md'],snapshot_id:snapshot.snapshot_id}),approved=await intents.control('owner',f.scope.project_id,review.intent_id,{request_id:action+'-approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
  const accepted=withImmediateTransaction(f.db,()=>executions.admit('owner',f.scope.project_id,review.intent_id,{request_id:action+'-execute',expected_version:approved.version,review_sha256:approved.review_sha256}));
  const applied=await executions.performReserved('owner',f.scope.project_id,accepted.execution_id);assert.equal(applied.state,'applied');assert.equal(f.git('show',':source.md'),action==='stage'?edited:f.base);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),edited);
  assert.deepEqual(source.summary('owner',f.source.run_id),beforeSource);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_file_versions').get().n,versions);assert.equal(f.db.prepare('SELECT count(*) n FROM ga_runs').get().n,runs);assert.equal(f.calls,0);
 }
 assert.equal(f.db.prepare("SELECT count(*) n FROM wb_workspace_reservation_settlements s JOIN wb_workspace_reservations r USING(reservation_id) WHERE r.operation_kind='git_index'").get().n,2);
});

test('replacing an older isolated native root after index preparation refuses physical publication',{skip:!runtime,timeout:120000},async t=>{
 const f=await publicationNativeHostFixture(t,{additionalHistory:true}),projects=new ProjectRepository(f.db),intents=new GitMutationIntents(f.db,projects,f.workbench),executions=new GitIndexExecutions(f.db,projects,f.workbench,intents,{nativeWorkspaceHost:{withReservedFamily:f.host.withReservedFamily,inspect:inspectNativeWorkspaceSource,assertAdmission:assertNativeWorkspaceSourceAdmission}});
 const edited='Reviewed target must remain unstaged';await writeFile(join(f.rootTarget,'source.md'),edited);const snapshot=await f.workbench.inspect('owner',f.scope.project_id),review=await intents.prepare('owner',f.scope.project_id,{request_id:'replace-review',action:'stage',paths:['source.md'],snapshot_id:snapshot.snapshot_id}),approved=await intents.control('owner',f.scope.project_id,review.intent_id,{request_id:'replace-approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 const accepted=withImmediateTransaction(f.db,()=>executions.admit('owner',f.scope.project_id,review.intent_id,{request_id:'replace-execute',expected_version:approved.version,review_sha256:approved.review_sha256})),before=await readFile(join(f.rootTarget,'.git/index')),kernel=f.workbench.indexEffects('owner',f.scope.project_id),prepare=kernel.prepareIndex.bind(kernel),root=f.history.prepared.snapshot.isolated_root;let replaced=false;
 kernel.prepareIndex=async(...args)=>{const plan=await prepare(...args);await rename(root,root+'-original');await mkdir(root);replaced=true;return plan};
 try{await assert.rejects(executions.performReserved('owner',f.scope.project_id,accepted.execution_id),/git_native_workspace_changed/)}finally{kernel.prepareIndex=prepare;if(replaced){await rmdir(root);await rename(root+'-original',root)}}
 assert.deepEqual(await readFile(join(f.rootTarget,'.git/index')),before);assert.equal(await readFile(join(f.rootTarget,'source.md'),'utf8'),edited);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_git_index_outcomes').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_settlements').get().n,0);assert.equal(f.calls,0);
});
