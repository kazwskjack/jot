import type {DatabaseSync} from 'node:sqlite';
import type {WorkbenchService} from '../workbench/service.ts';
import type {WorkbenchBudgetPolicy} from '../workbench/model-budget-policy.ts';
import {DiscoveryPolicies} from './discovery-policy.ts';
import {LogicalWorkCycleWorkspaceManager} from './logical-work-cycle-workspace.ts';
import {TrustedWorkRunWorkspaceResolver} from './work-run-workspace.ts';
import {WorkInspections} from './work-inspections.ts';
import {installIsolatedWorkFiles} from './isolated-work-file-schema.ts';
import {configureTaskCompletionWorkEvidence} from '../persistent-tasks/completion-candidates.ts';

/** Trusted host configuration only. A configured directory is not a work grant:
 * every operation still derives the original admitted task and current role. */
export function createNativeWorkRuntime(options:{db:DatabaseSync;workbench:WorkbenchService;root?:string;executionReady:boolean;budgetPolicy?:WorkbenchBudgetPolicy}){
 if(options.root===undefined)return undefined;
 if(!options.root.trim()||!options.executionReady||!options.budgetPolicy)throw Error('native_work_configuration_unavailable');
 installIsolatedWorkFiles(options.db);
 const policies=new DiscoveryPolicies(options.db);
 const workspace=new LogicalWorkCycleWorkspaceManager({db:options.db,workbench:options.workbench,storageRoot:options.root});
 const resolver=new TrustedWorkRunWorkspaceResolver({db:options.db,workbench:options.workbench,policies,workspace});
 const inspections=new WorkInspections({db:options.db,resolver});
 configureTaskCompletionWorkEvidence(options.db,scope=>inspections.current(scope));
 const operations=new Set(['files.list','files.read','files.write','tasks.get','tasks.subtasks','tasks.next','tasks.reply_drafts',
  'tasks.upsert','tasks.evidence','tasks.assessment','tasks.observe','tasks.assess']);
 return {resolver,inspections,assertOperation(runId:string,operation:string){
  if(!resolver.context(runId))throw Error('work_admission_execution_unavailable');
  if(!operations.has(operation))throw Error('work_operation_denied');
 }};
}
