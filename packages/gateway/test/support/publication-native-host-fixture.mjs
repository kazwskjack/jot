import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {publicationReviewFixture} from './work-publication-fixture.mjs';
import {withImmediateTransaction} from '../../src/db/database.ts';
import {upgradeWorkspacePublicationCoordination} from '../../src/workbench/workspace-coordination-upgrade.ts';
import {WorkPublicationExecutions,installWorkPublicationExecutions} from '../../src/persistent-tasks/work-publication-executions.ts';
import {FinalizedWorkSources} from '../../src/persistent-tasks/finalized-work-sources.ts';
import {GitIndexExecutions} from '../../src/git/index-executions.ts';import {GitMutationIntents} from '../../src/git/intents.ts';import {ProjectRepository} from '../../src/projects/repository.ts';
import {registerGitWorkspaceSource} from '../../src/git/workspace-source-route.ts';
import {WorkbenchBridge} from '../../../session-adapter/workbench.js';
import * as nativeSource from '../../../session-adapter/native-workspace-source.js';
import {createNativeWorkspaceSourceHost,inspectNativeWorkspaceSource,assertNativeWorkspaceSourceAdmission} from '../../../session-adapter/native-workspace-source.js';
import {nativePublicationRuntime} from './native-publication-runtime.mjs';
import {createNativeWorkspaceFactoryGate} from '../../../session-adapter/native-workspace-factory.js';
import {createNativeInvariantReplay} from '../../../session-adapter/native-invariant-replay.js';
import {addHistoricalWork} from './publication-history-fixture.mjs';
const runtime=process.env.JOT_DSH_RUNTIME_MODULES,token='test-publication-native-token';
export async function publicationNativeHostFixture(t,{badCheckpoint=false,outputPath='source.md',additionalHistory=false}={}){
 const sdk=nativePublicationRuntime(t,runtime),nativeLifecycle=async original=>{
  const lifecycle=await sdk.lifecycle(original);if(!badCheckpoint)return lifecycle;
  return{...lifecycle,async complete(){const proof=await lifecycle.complete();return{...proof,checkpoint:{...proof.checkpoint,log_sha256:'0'.repeat(64)}}}};
 };
 const f=await publicationReviewFixture(t,{nativeLifecycle,outputPath});
 const history=additionalHistory?await addHistoricalWork(f,{duringRun:({session,prepared})=>sdk.historicalSession({session,cwd:prepared.snapshot.isolated_root,cold:additionalHistory==='cold'})}):undefined;
 const review=await f.service.prepare('owner',f.scope.project_id,f.input),approved=await f.service.control('owner',f.scope.project_id,review.intent_id,{request_id:'approve',action:'approve',expected_version:1,review_sha256:review.review_sha256});
 upgradeWorkspacePublicationCoordination(f.db);installWorkPublicationExecutions(f.db);
 const plain=new WorkPublicationExecutions(f.db,f.workbench,f.service),accepted=withImmediateTransaction(f.db,()=>plain.admit('owner',f.scope.project_id,review.intent_id,{request_id:'native-publication',expected_version:approved.version,review_sha256:approved.review_sha256}));
 assert.equal(typeof plain.withReservedNativeSource,'function');
 const app=Fastify(),projects=new ProjectRepository(f.db);registerGitWorkspaceSource(app,new GitIndexExecutions(f.db,projects,f.workbench,new GitMutationIntents(f.db,projects,f.workbench)),token,f.db,plain);
 const {ctx,modules,admissionGate}=sdk;let gate,closed=false;
 const close=async()=>{if(closed)return;closed=true;await gate?.dispose();await admissionGate?.dispose();await sdk.close();await app.close();};t.after(close);
 const bridge=new WorkbenchBridge({origin:await app.listen({host:'127.0.0.1',port:0}),token});
 const placement=new FinalizedWorkSources(f.db).nativePlacement('owner',f.admission.run_id,f.source.source_sha256);
 const persistence=ctx.sessionPersistence,registry=ctx.agents,sessions=ctx.sessions;
 gate=createNativeWorkspaceFactoryGate({ctx,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,notFoundError:modules['dsh-session-persistence'].SessionPersistenceNotFoundError});
 const host=createNativeWorkspaceSourceHost({bridge,registry,sessions,persistence,currentPersistence:()=>ctx.sessionPersistence,backendClass:modules['dsh-session-persistence'].SessionPersistence,
  allowedPresets:new Set(['jot-workbench-budgeted']),validateLog:createNativeInvariantReplay({Session:modules['dsh-session'].Session}),projections:ctx.sessionProjections,factoryGate:gate,admissionGate});
 const observations=new Set(),inspect=context=>{const value=inspectNativeWorkspaceSource(context);observations.add(value);return value;};
 const executions=new WorkPublicationExecutions(f.db,f.workbench,f.service,{nativeWorkspaceHost:{withReservedFamily:host.withReservedFamily,inspect,assertAdmission:assertNativeWorkspaceSourceAdmission,...(nativeSource.verifyNativeWorkspaceSourceCheckpoint?{verifyCheckpoint:nativeSource.verifyNativeWorkspaceSourceCheckpoint}:{})}});
 return{...f,review,accepted,executions,plain,host,placement,history,observations,agent:sdk.agent,close,get calls(){return sdk.calls;}};
}
