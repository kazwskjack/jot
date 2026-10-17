import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,isAbsolute,parse} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {WorkbenchService} from '../workbench/service.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {WorkCycles,type WorkCycleScope,type WorkCycleView} from './work-cycles.ts';
import {WorkspaceJournal} from './workspace-journal.ts';
import {WorkCycleSources} from './work-cycle-sources.ts';
import {WorkbenchProjectSource,type SourceSnapshot,type SourceControls,type SourceManifest} from './workbench-source.ts';
import {SnapshotCopyWorkspaceProvider} from './snapshot-provider.ts';
import {workspaceRelativePath,workspaceSelection,validateWorkspaceManifest,type WorkspaceManifest,type WorkspaceManifestEntry,type WorkspaceSnapshot,type WorkspaceInspection,type WorkspaceProviderLimits,type WorkspaceGuard} from './workspace-provider.ts';

type Journal=Pick<WorkspaceJournal,'intent'|'begin'|'commit'|'record'>;
type Options={db:DatabaseSync;workbench:WorkbenchService;storageRoot:string;limits?:WorkspaceProviderLimits;journal?:Journal};
export type LogicalWorkspaceControls={signal:AbortSignal};
export type LogicalPreparedWorkCycleWorkspace=Readonly<{cycle:WorkCycleView;snapshot:WorkspaceSnapshot;source_manifest:SourceManifest;source_sha256:string;copy_paths:readonly string[];plan_paths:readonly string[];execution_authorized:false}>;
export type LogicalInspectedWorkCycleWorkspace=Readonly<{workspace:LogicalPreparedWorkCycleWorkspace;result:WorkspaceInspection;execution_authorized:false}>;
export type LogicalWorkCycleBaseVerification=Readonly<{source_sha256:string;file_count:number;total_bytes:number;execution_authorized:false}>;
const failure=(code:string)=>Error(code),hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function controls(value:LogicalWorkspaceControls){if(!value||typeof value!=='object'||Object.keys(value).join(',')!=='signal'||!(value.signal instanceof AbortSignal))throw failure('logical_workspace_controls_required');if(value.signal.aborted)throw failure('logical_workspace_cancelled');return value.signal;}
function storageIdentity(value:string){
 if(typeof value!=='string'||!isAbsolute(value))throw failure('logical_workspace_storage_invalid');const path=resolve(value);if(path===parse(path).root)throw failure('logical_workspace_storage_invalid');
 for(let current=path;;){const stat=lstatSync(current,{bigint:true});if(stat.isSymbolicLink())throw failure('logical_workspace_storage_unsafe');const parent=dirname(current);if(parent===current)break;current=parent;}
 const stat=lstatSync(path,{bigint:true});if(!stat.isDirectory())throw failure('logical_workspace_storage_invalid');return Object.freeze({path,canonical:realpathSync(path),dev:String(stat.dev),ino:String(stat.ino)});
}
function layout(source:SourceManifest,cycle:WorkCycleView){
 const plans=Object.freeze([...new Set(cycle.plans.flatMap(plan=>plan.paths.map(workspaceRelativePath)))].sort());if(!plans.length)throw failure('logical_workspace_plan_missing');
 const entries=new Map<string,WorkspaceManifestEntry>();
 for(const file of source.files){workspaceRelativePath(file.path);const existing=entries.get(file.path);if(existing)throw failure('logical_workspace_base_invalid');entries.set(file.path,{path:file.path,kind:'file',sha256:file.sha256,bytes:file.size,executable:false});}
 for(const file of source.files){const parts=file.path.split('/');parts.pop();while(parts.length){const path=parts.join('/'),existing=entries.get(path);if(existing?.kind==='file')throw failure('logical_workspace_base_invalid');entries.set(path,{path,kind:'directory'});parts.pop();}}
 for(const target of plans){const parts=target.split('/');parts.pop();while(parts.length){if(entries.get(parts.join('/'))?.kind==='file')throw failure('logical_workspace_plan_ancestor_file');parts.pop();}}
 const paths=workspaceSelection([...new Set([...source.files.map(file=>file.path),...plans].map(path=>path.split('/')[0]!))]);
 const selection=Object.freeze(paths.map(path=>Object.freeze({path,kind:entries.get(path)?.kind??(plans.some(target=>target.startsWith(path+'/'))?'directory':'file')})));
 const manifest=validateWorkspaceManifest({protocol:1,provider:'snapshot-copy',paths,entries:[...entries.values()]});return {manifest,paths,selection,plans};
}

/** Host-only bridge from original logical project versions to an isolated cycle
 * artifact. All project files are copy context, never implied writable scope.
 * No model, task, execution, scheduler or apply authority is introduced here. */
export class LogicalWorkCycleWorkspaceManager{
 private readonly cycles:WorkCycles;private readonly journal:Journal;private readonly sources:WorkCycleSources;private readonly source:WorkbenchProjectSource;
 private readonly storage:ReturnType<typeof storageIdentity>;private readonly limits:WorkspaceProviderLimits|undefined;
 constructor(options:Options){
  if(!options||typeof options!=='object'||Object.keys(options).some(key=>!['db','workbench','storageRoot','limits','journal'].includes(key)))throw failure('logical_workspace_config_invalid');
  this.storage=storageIdentity(options.storageRoot);
  if(options.limits!==undefined&&(!options.limits||typeof options.limits!=='object'||Object.keys(options.limits).some(key=>!['max_entries','max_total_bytes','max_file_bytes','max_depth'].includes(key))||Object.values(options.limits).some(value=>!Number.isSafeInteger(value)||Number(value)<1)))throw failure('logical_workspace_config_invalid');
  this.limits=options.limits?Object.freeze({...options.limits}):undefined;this.cycles=new WorkCycles(options.db);this.journal=options.journal??new WorkspaceJournal(options.db);this.sources=new WorkCycleSources(options.db);this.source=new WorkbenchProjectSource(options.db,options.workbench);
 }
 private storageCurrent(){try{if(canonicalJson(storageIdentity(this.storage.path))!==canonicalJson(this.storage))throw failure('logical_workspace_storage_changed');}catch{throw failure('logical_workspace_storage_changed');}}
 private async base(owner:string,scope:WorkCycleScope,cycleId:string,signal:AbortSignal,allowPin:boolean){
  const current=()=>{if(signal.aborted)throw failure('logical_workspace_cancelled');return this.cycles.guard(owner,scope,cycleId);};current();
  const sourceControls:SourceControls={signal,guard:()=>{current();}},pinned=this.sources.get(owner,scope,cycleId);let snapshot:SourceSnapshot;
  if(pinned)snapshot=await this.source.restore(owner,scope,cycleId,pinned,sourceControls);
  else{
   if(!allowPin)throw failure('logical_workspace_source_not_prepared');if(this.journal.intent(owner,scope,cycleId))throw failure('logical_workspace_source_uncertain');
   snapshot=await this.source.capture(owner,scope,cycleId,sourceControls);this.sources.pin(owner,scope,cycleId,this.source.record(snapshot));await this.source.assertCurrent(snapshot,sourceControls);
  }
  return {snapshot,record:this.source.record(snapshot),sourceControls,current};
 }
 private async consumeBase(base:Awaited<ReturnType<LogicalWorkCycleWorkspaceManager['base']>>):Promise<LogicalWorkCycleBaseVerification>{
  let total=0;for(const file of base.snapshot.manifest.files){let bytes=0;for await(const chunk of this.source.read(base.snapshot,file.path,base.sourceControls)){bytes+=chunk.byteLength;total+=chunk.byteLength;if(!Number.isSafeInteger(total))throw failure('logical_workspace_base_invalid');}if(bytes!==file.size)throw failure('logical_workspace_base_invalid');}
  await this.source.assertCurrent(base.snapshot,base.sourceControls);base.current();return Object.freeze({source_sha256:base.record.sha256,file_count:base.snapshot.manifest.files.length,total_bytes:total,execution_authorized:false});
 }
 private async open(owner:string,inputScope:WorkCycleScope,cycleId:string,input:LogicalWorkspaceControls,allowCreate:boolean){
  const signal=controls(input),scope=Object.freeze({...inputScope}),base=await this.base(owner,scope,cycleId,signal,allowCreate),cycle=base.current(),shape=layout(base.snapshot.manifest,cycle);this.storageCurrent();
  const rootBinding=hash({source_record_sha256:base.record.sha256,storage_root:this.storage,paths:shape.paths,selection:shape.selection,plans:cycle.plans,limits:this.limits??null}),selectionHash=hash(shape.paths);let intent=this.journal.intent(owner,scope,cycleId),guardError:unknown;
  if(intent&&(intent.cycle_id!==cycleId||intent.cycle_version!==cycle.version||intent.root_binding_sha256!==rootBinding||intent.selection_sha256!==selectionHash))throw failure('logical_workspace_configuration_changed');
  if(!intent&&!allowCreate)throw failure('logical_workspace_not_prepared');
  const fresh=async()=>{base.current();await this.source.assertCurrent(base.snapshot,base.sourceControls);this.storageCurrent();base.current();};
  const guard:WorkspaceGuard=async()=>{try{await fresh();}catch(error){guardError=error;throw error;}};
  const provider=new SnapshotCopyWorkspaceProvider({recoveryStore:{
   commit:async record=>{await fresh();if(canonicalJson(record.storage_root)!==canonicalJson(this.storage)||canonicalJson(record.selection)!==canonicalJson(shape.selection)||canonicalJson(record.manifest.paths)!==canonicalJson(shape.paths))throw failure('logical_workspace_configuration_changed');this.journal.commit(owner,scope,cycleId,record);},
   read:async snapshotId=>{await fresh();return this.journal.record(owner,scope,cycleId,snapshotId);},
  }});
  let snapshot:WorkspaceSnapshot;const recovering=intent!==null;
  try{
   if(intent){if(!this.journal.record(owner,scope,cycleId,intent.snapshot_id))throw failure('logical_workspace_preparation_uncertain');snapshot=await provider.recover({snapshot_id:intent.snapshot_id,storageRoot:this.storage.path,guard,signal});}
   else snapshot=await provider.materialize({storageRoot:this.storage.path,manifest:shape.manifest,selection:shape.selection,...(this.limits?{limits:this.limits}:{}),
    signal,assertCurrent:()=>fresh(),read:path=>this.source.read(base.snapshot,path,base.sourceControls),guard:async context=>{
     await guard(context);if(!intent){intent=this.journal.begin(owner,scope,cycleId,{expected_cycle_version:cycle.version,snapshot_id:context.snapshot_id,root_binding_sha256:rootBinding,selection_sha256:selectionHash});if(intent.snapshot_id!==context.snapshot_id||intent.root_binding_sha256!==rootBinding||intent.selection_sha256!==selectionHash)throw failure('logical_workspace_preparation_uncertain');await fresh();}else if(intent.snapshot_id!==context.snapshot_id)throw failure('logical_workspace_preparation_uncertain');
    },
   });
   // Initial materialization already consumes every source stream and verifies
   // each digest plus the physical target. Recovery has no source-copy stream,
   // so re-read all original bytes there rather than trusting metadata alone.
   if(recovering)await this.consumeBase(base);await fresh();
  }catch(error){if(guardError)throw guardError;throw error;}
  const workspace:LogicalPreparedWorkCycleWorkspace=Object.freeze({cycle:base.current(),snapshot,source_manifest:base.snapshot.manifest,source_sha256:base.record.sha256,copy_paths:shape.paths,plan_paths:shape.plans,execution_authorized:false});return {workspace,provider,guard,base,fresh};
 }
 prepare(owner:string,scope:WorkCycleScope,cycleId:string,input:LogicalWorkspaceControls):Promise<LogicalPreparedWorkCycleWorkspace>{return this.open(owner,scope,cycleId,input,true).then(value=>value.workspace);}
 async inspect(owner:string,scope:WorkCycleScope,cycleId:string,input:LogicalWorkspaceControls):Promise<LogicalInspectedWorkCycleWorkspace>{const opened=await this.open(owner,scope,cycleId,input,false),result=await opened.provider.inspect({snapshot:opened.workspace.snapshot,guard:opened.guard,signal:opened.base.sourceControls.signal});await opened.fresh();return Object.freeze({workspace:opened.workspace,result,execution_authorized:false});}
 async verifyBase(owner:string,scope:WorkCycleScope,cycleId:string,input:LogicalWorkspaceControls):Promise<LogicalWorkCycleBaseVerification>{const signal=controls(input),base=await this.base(owner,Object.freeze({...scope}),cycleId,signal,false),result=await this.consumeBase(base);this.storageCurrent();return result;}
}
