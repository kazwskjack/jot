import {createHash} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,isAbsolute,join,relative,sep} from 'node:path';
import {canonicalJson} from '../db/canonical-json.ts';
import type {WorkCycles,WorkCycleScope,WorkCycleView} from './work-cycles.ts';
import {SnapshotCopyWorkspaceProvider} from './snapshot-provider.ts';
import {workspaceSelection,workspaceRelativePath,type SnapshotRecoveryRecord,type WorkspaceProviderLimits,type WorkspaceSnapshot,type WorkspaceInspection,type WorkspaceGuard} from './workspace-provider.ts';

type Intent=Readonly<{cycle_id:string;cycle_version:number;snapshot_id:string;root_binding_sha256:string;selection_sha256:string;execution_authorized:false}>;
/** Trusted host injection. This is the original cycle journal, not a second
 * task lifecycle or public/browser supplied persistence implementation. */
export type WorkCycleWorkspaceJournal={
 intent(owner:string,scope:WorkCycleScope,cycleId:string):Intent|null;
 begin(owner:string,scope:WorkCycleScope,cycleId:string,input:{expected_cycle_version:number;snapshot_id:string;root_binding_sha256:string;selection_sha256:string}):Intent;
 commit(owner:string,scope:WorkCycleScope,cycleId:string,record:SnapshotRecoveryRecord):void;
 record(owner:string,scope:WorkCycleScope,cycleId:string,snapshotId:string):SnapshotRecoveryRecord|undefined;
};
export type WorkCycleWorkspaceInput={sourceRoot:string;storageRoot:string;paths:readonly string[];limits?:WorkspaceProviderLimits;signal:AbortSignal};
export type PreparedWorkCycleWorkspace=Readonly<{cycle:WorkCycleView;snapshot:WorkspaceSnapshot;copy_paths:readonly string[];plan_paths:readonly string[];execution_authorized:false}>;
export type InspectedWorkCycleWorkspace=Readonly<{workspace:PreparedWorkCycleWorkspace;result:WorkspaceInspection;execution_authorized:false}>;
type Options={cycles:Pick<WorkCycles,'guard'>;journal:WorkCycleWorkspaceJournal};
const fail=(code:string)=>Error(code);
function signalOf(signal:AbortSignal){if(!(signal instanceof AbortSignal))throw fail('work_cycle_workspace_controls_required');if(signal.aborted)throw fail('work_cycle_workspace_cancelled');}
async function rootIdentity(value:string){
 if(typeof value!=='string'||!isAbsolute(value))throw fail('work_cycle_workspace_config_invalid');const path=resolve(value);
 for(let current=path;;){const stat=await lstat(current,{bigint:true});if(stat.isSymbolicLink())throw fail('work_cycle_workspace_root_unsafe');const parent=dirname(current);if(parent===current)break;current=parent;}
 const stat=await lstat(path,{bigint:true});if(!stat.isDirectory())throw fail('work_cycle_workspace_config_invalid');return Object.freeze({path,canonical:await realpath(path),dev:String(stat.dev),ino:String(stat.ino)});
}
function contains(root:string,path:string){const part=relative(root,path);return part===''||part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);}
async function unchangedRoots(config:{source:Awaited<ReturnType<typeof rootIdentity>>;storage:Awaited<ReturnType<typeof rootIdentity>>}){
 try{if(canonicalJson(await rootIdentity(config.source.path))!==canonicalJson(config.source)||canonicalJson(await rootIdentity(config.storage.path))!==canonicalJson(config.storage))throw fail('work_cycle_workspace_root_changed');}
 catch{throw fail('work_cycle_workspace_root_changed');}
}
function frozenScope(scope:WorkCycleScope):WorkCycleScope{return Object.freeze({agent_id:scope.agent_id,project_id:scope.project_id,workspace_id:scope.workspace_id});}
/** Prepares/reopens an isolated artifact for an already accepted, owned cycle.
 * Copy context is not writable scope. No task/run/model/admission/apply occurs. */
export class WorkCycleWorkspaceManager{
 private readonly cycles:Options['cycles'];private readonly journal:WorkCycleWorkspaceJournal;
 constructor(options:Options){this.cycles=options.cycles;this.journal=options.journal;}
 private async configuration(owner:string,scope:WorkCycleScope,cycleId:string,input:WorkCycleWorkspaceInput){
  signalOf(input?.signal);if(!input||Object.keys(input).some(k=>!['sourceRoot','storageRoot','paths','limits','signal'].includes(k)))throw fail('work_cycle_workspace_config_invalid');
  const cycle=this.cycles.guard(owner,scope,cycleId),paths=workspaceSelection(input.paths),source=await rootIdentity(input.sourceRoot),storage=await rootIdentity(input.storageRoot);
  if(contains(source.canonical,storage.canonical)||contains(storage.canonical,source.canonical))throw fail('work_cycle_workspace_roots_overlap');
  const selection:Readonly<{path:string;kind:'file'|'directory'}>[]=[];
  for(const path of paths){signalOf(input.signal);let current=source.path;const parts=path.split('/');for(const part of parts){current=join(current,part);if((await lstat(current,{bigint:true})).isSymbolicLink())throw fail('work_cycle_workspace_root_unsafe');}
   const stat=await lstat(current,{bigint:true});if(!stat.isDirectory()&&!stat.isFile())throw fail('work_cycle_workspace_config_invalid');selection.push(Object.freeze({path,kind:stat.isDirectory()?'directory':'file'}));
  }
  const plans=[...new Set(cycle.plans.flatMap(plan=>plan.paths.map(workspaceRelativePath)))].sort(),folded=new Set<string>();
  for(const path of plans){const key=path.normalize('NFC').toLowerCase();if(folded.has(key))throw fail('work_cycle_workspace_plan_collision');folded.add(key);if(!selection.some(s=>path===s.path||s.kind==='directory'&&path.startsWith(s.path+'/')))throw fail('work_cycle_workspace_plan_uncovered');}
  if(!plans.length)throw fail('work_cycle_workspace_plan_uncovered');
  let limits:WorkspaceProviderLimits|undefined;if(input.limits!==undefined){if(!input.limits||typeof input.limits!=='object'||Object.keys(input.limits).some(k=>!['max_entries','max_total_bytes','max_file_bytes','max_depth'].includes(k))||Object.values(input.limits).some(n=>!Number.isSafeInteger(n)||Number(n)<1))throw fail('work_cycle_workspace_config_invalid');limits=Object.freeze({...input.limits});}
  this.cycles.guard(owner,scope,cycleId);signalOf(input.signal);
  const configuration_sha256=createHash('sha256').update(canonicalJson({source_root:source,storage_root:storage,paths,selection,limits:limits??null,plan_paths:plans})).digest('hex');
  return {cycle,paths,selection:Object.freeze(selection),plan_paths:Object.freeze(plans),source,storage,sourceRoot:source.path,storageRoot:storage.path,limits,signal:input.signal,configuration_sha256,selection_sha256:createHash('sha256').update(canonicalJson(paths)).digest('hex')};
 }
 private async open(owner:string,inputScope:WorkCycleScope,cycleId:string,input:WorkCycleWorkspaceInput,allowCreate:boolean){
  const scope=frozenScope(inputScope),config=await this.configuration(owner,scope,cycleId,input);let saved=this.journal.intent(owner,scope,cycleId),guardFailure:unknown;
  if(saved&&(saved.cycle_id!==cycleId||saved.cycle_version!==config.cycle.version||saved.root_binding_sha256!==config.configuration_sha256||saved.selection_sha256!==config.selection_sha256))throw fail('work_cycle_workspace_config_changed');
  if(!saved&&!allowCreate)throw fail('work_cycle_workspace_not_prepared');
  const guard:WorkspaceGuard=async context=>{
   try{signalOf(config.signal);this.cycles.guard(owner,scope,cycleId);
    if(context.relative_path===null&&(context.phase==='prepare'||context.phase==='publish')){await unchangedRoots(config);signalOf(config.signal);this.cycles.guard(owner,scope,cycleId);}
   }catch(error){guardFailure=error;throw error;}
  };
  const provider=new SnapshotCopyWorkspaceProvider({recoveryStore:{
   commit:async record=>{await guard({phase:'publish',snapshot_id:record.snapshot_id,relative_path:null,execution_authorized:false});
    if(canonicalJson(record.storage_root)!==canonicalJson(config.storage))throw fail('work_cycle_workspace_root_changed');
    if(canonicalJson(record.selection)!==canonicalJson(config.selection)||canonicalJson(record.manifest.paths)!==canonicalJson(config.paths))throw fail('work_cycle_workspace_selection_changed');
    this.journal.commit(owner,scope,cycleId,record);},
   read:async snapshotId=>{await guard({phase:'verify',snapshot_id:snapshotId,relative_path:null,execution_authorized:false});return this.journal.record(owner,scope,cycleId,snapshotId);},
  }});
  let snapshot:WorkspaceSnapshot;
  try{
   if(saved){
    if(!this.journal.record(owner,scope,cycleId,saved.snapshot_id))throw fail('work_cycle_workspace_preparation_uncertain');
    snapshot=await provider.recover({snapshot_id:saved.snapshot_id,storageRoot:config.storageRoot,guard,signal:config.signal});
   }else{
    snapshot=await provider.create({sourceRoot:config.sourceRoot,storageRoot:config.storageRoot,paths:config.paths,...(config.limits?{limits:config.limits}:{}),signal:config.signal,
     guard:async context=>{await guard(context);if(!saved){saved=this.journal.begin(owner,scope,cycleId,{expected_cycle_version:config.cycle.version,snapshot_id:context.snapshot_id,root_binding_sha256:config.configuration_sha256,selection_sha256:config.selection_sha256});if(saved.snapshot_id!==context.snapshot_id||saved.root_binding_sha256!==config.configuration_sha256||saved.selection_sha256!==config.selection_sha256)throw fail('work_cycle_workspace_preparation_uncertain');await unchangedRoots(config);}else if(saved.snapshot_id!==context.snapshot_id)throw fail('work_cycle_workspace_preparation_uncertain');},
    });
   }
   await unchangedRoots(config);this.cycles.guard(owner,scope,cycleId);signalOf(config.signal);
  }catch(error){if(guardFailure)throw guardFailure;throw error;}
  const workspace:PreparedWorkCycleWorkspace=Object.freeze({cycle:this.cycles.guard(owner,scope,cycleId),snapshot,copy_paths:config.paths,plan_paths:config.plan_paths,execution_authorized:false});
  return {workspace,provider,guard,config};
 }
 prepare(owner:string,scope:WorkCycleScope,cycleId:string,input:WorkCycleWorkspaceInput):Promise<PreparedWorkCycleWorkspace>{return this.open(owner,scope,cycleId,input,true).then(value=>value.workspace);}
 async inspect(owner:string,scope:WorkCycleScope,cycleId:string,input:WorkCycleWorkspaceInput):Promise<InspectedWorkCycleWorkspace>{
  const opened=await this.open(owner,scope,cycleId,input,false),result=await opened.provider.inspect({snapshot:opened.workspace.snapshot,guard:opened.guard,signal:opened.config.signal});await unchangedRoots(opened.config);this.cycles.guard(owner,scope,cycleId);signalOf(opened.config.signal);return Object.freeze({workspace:opened.workspace,result,execution_authorized:false});
 }
}
