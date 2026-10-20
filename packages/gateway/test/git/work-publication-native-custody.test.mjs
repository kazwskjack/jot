import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,readdir,symlink,readFile} from 'node:fs/promises';import {join,dirname} from 'node:path';import {pathToFileURL} from 'node:url';
import Fastify from 'fastify';
import {publicationReviewFixture} from '../support/work-publication-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {upgradeWorkspacePublicationCoordination} from '../../src/workbench/workspace-coordination-upgrade.ts';
import {WorkPublicationExecutions,installWorkPublicationExecutions} from '../../src/persistent-tasks/work-publication-executions.ts';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
import {GitIndexExecutions} from '../../src/git/index-executions.ts';import {GitMutationIntents} from '../../src/git/intents.ts';import {ProjectRepository} from '../../src/projects/repository.ts';
import {registerGitWorkspaceSource} from '../../src/git/workspace-source-route.ts';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
import {prepareDshPreSetupRuntime} from '../../../session-adapter/scripts/prepare-dsh-pre-setup.mjs';
import {createNativeWorkspaceSourceHost,inspectNativeWorkspaceSource,assertNativeWorkspaceSourceAdmission} from '../../../session-adapter/native-workspace-source.js';
import {createNativeWorkspaceFactoryGate,createNativeWorkspaceAdmissionGate} from '../../../session-adapter/native-workspace-factory.js';
import {createNativeInvariantReplay} from '../../../session-adapter/native-invariant-replay.js';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES,token='test-publication-native-token';
async function fixture(t){
 const f=await publicationReviewFixture(t),review=await f.service.prepare('owner',f.scope.project_id,f.input),approved=await f.service.control('owner',f.scope.project_id,review.intent_id,{request_id:'approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 upgradeWorkspacePublicationCoordination(f.db);installWorkPublicationExecutions(f.db);
 const plain=new WorkPublicationExecutions(f.db,f.workbench,f.service),accepted=withImmediateTransaction(f.db,()=>plain.admit('owner',f.scope.project_id,review.intent_id,{request_id:'native-publication',expected_version:approved.version,review_sha256:approved.review_sha256}));
 assert.equal(typeof plain.withReservedNativeSource,'function');
 const app=Fastify(),projects=new ProjectRepository(f.db);registerGitWorkspaceSource(app,new GitIndexExecutions(f.db,projects,f.workbench,new GitMutationIntents(f.db,projects,f.workbench)),token,f.db,plain);
 const base=join(f.root,'original-native-host'),scoped=join(base,'node_modules','@deepseek-ai');await mkdir(scoped,{recursive:true});
 prepareDshPreSetupRuntime(join(runtime,'dsh-agent-loop'),join(scoped,'dsh-agent-loop'),{nativeAdmission:true,pendingInputWake:true});
 for(const entry of await readdir(runtime,{withFileTypes:true}))if(entry.name!=='dsh-agent-loop'&&entry.isDirectory())await symlink(join(runtime,entry.name),join(scoped,entry.name),'junction');
 await symlink(join(dirname(runtime),'zod'),join(base,'node_modules','zod'),'junction');
 const names=['cordis','dsh-session','dsh-session-projection','dsh-session-persistence-jsonl','dsh-session-query','dsh-agent','dsh-llm','dsh-tools','dsh-system-prompt','dsh-agent-loop','dsh-goal'],modules={};
 for(const name of [...names,'dsh-session-persistence'])modules[name]=await import(pathToFileURL(join(name==='dsh-agent-loop'?scoped:runtime,name,'lib/index.js')).href);
 const ctx=new modules.cordis.Context();let gate,admissionGate,handle;let closed=false;
 const close=async()=>{if(closed)return;closed=true;await gate?.dispose();await handle?.dispose();await admissionGate?.dispose();await ctx.fiber.dispose();await app.close();};t.after(close);
 for(const name of names.filter(n=>n!=='cordis'))await ctx.plugin(modules[name].default??modules[name],name==='dsh-session-persistence-jsonl'?{root:join(base,'sessions'),compression:'none'}:{});
 let calls=0;class Local extends modules['dsh-llm'].LlmAdapter{async *stream(){calls++;assert.fail('source custody must not call a model');}}ctx.llm.registerAdapter(['publication-custody'],new Local());
 const bridge=new WorkbenchBridge({origin:await app.listen({host:'127.0.0.1',port:0}),token});admissionGate=createNativeWorkspaceAdmissionGate({ctx,bridge});
 const placement=new FinalizedWorkSources(f.db).nativePlacement('owner',f.admission.run_id,f.source.source_sha256);
 handle=await ctx.agents.create({sessionId:placement.session_ref,meta:{agentPreset:'jot-workbench-budgeted',cwd:placement.isolated_root.path},agentOptions:{provider:'publication-custody',model:'synthetic'}});
 const persistence=ctx.sessionPersistence,registry=ctx.agents,sessions=ctx.sessions;
 gate=createNativeWorkspaceFactoryGate({ctx,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,notFoundError:modules['dsh-session-persistence'].SessionPersistenceNotFoundError});
 const host=createNativeWorkspaceSourceHost({bridge,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,backendClass:modules['dsh-session-persistence'].SessionPersistence,
  allowedPresets:new Set(['jot-workbench-budgeted']),validateLog:createNativeInvariantReplay({Session:modules['dsh-session'].Session}),projections:ctx.sessionProjections,factoryGate:gate,admissionGate});
 const executions=new WorkPublicationExecutions(f.db,f.workbench,f.service,{nativeWorkspaceHost:{withReservedFamily:host.withReservedFamily,inspect:inspectNativeWorkspaceSource,assertAdmission:assertNativeWorkspaceSourceAdmission}});
 return{...f,review,accepted,executions,plain,agent:handle.agent,close,get calls(){return calls;}};
}
test('original installed Host holds the distinct publication family and exact isolated placement through an awaited source callback',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t),before=await readFile(join(f.rootTarget,'source.md'));let retained;
 const result=await f.executions.withReservedNativeSource('owner',f.scope.project_id,f.accepted.execution_id,async context=>{
  retained=context;const view=f.executions.inspectNativeSource(context);assert.equal(view.source.intent_id,f.review.intent_id);assert.equal(view.family.execution_id,f.accepted.execution_id);assert.equal(view.family.operation_kind,'work_publication');assert.equal(view.placement.session_ref,'work-test-session');
  assert.equal(view.placement.isolated_root.path,f.prepared.snapshot.isolated_root);assert.notEqual(view.placement.isolated_root.path,f.rootTarget);assert.equal(view.execution_authorized,false);
  assert.ok(Object.isFrozen(view.family)&&Object.isFrozen(view.family.members)&&view.family.members.every(member=>Object.isFrozen(member.scopes)),'the held original family must remain immutable through the callback');
  assert.throws(()=>view.family.members.push({session_ref:'injected'}),TypeError);
  assert.throws(()=>f.agent.runMaintenance(()=>{}),/already has active work/);assert.throws(()=>f.executions.inspectNativeSource({...context}),/work_publication_native_context_invalid/);
  await new Promise(resolve=>setTimeout(resolve,10));f.executions.assertNativeSource(context);return 'original-source-held';
 });
 assert.equal(result,'original-source-held');assert.throws(()=>f.executions.inspectNativeSource(retained),/work_publication_native_context_invalid/);assert.equal(f.calls,0);assert.deepEqual(await readFile(join(f.rootTarget,'source.md')),before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM ga_worker_leases').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0,'source observation alone cannot settle the reservation');
 f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,f.accepted.execution_id);await f.agent.runMaintenance(async()=>{});await f.close();
});
test('original review revocation during held native source invalidates it and leaves custody unresolved',{skip:!runtime,timeout:45000},async t=>{
 const f=await fixture(t);
 await assert.rejects(f.executions.withReservedNativeSource('owner',f.scope.project_id,f.accepted.execution_id,async context=>{
  await f.service.control('owner',f.scope.project_id,f.review.intent_id,{request_id:'cancel-held',action:'cancel',expected_version:2,review_sha256:f.review.review_sha256});f.executions.assertNativeSource(context);
 }),/work_publication_review_changed/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM wb_workspace_reservation_releases').get().n,0);assert.equal(f.calls,0);f.executions.releaseUnstartedWorkspace('owner',f.scope.project_id,f.accepted.execution_id);await f.close();
});
