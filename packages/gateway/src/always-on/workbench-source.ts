import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,realpath,open} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {WorkbenchService} from '../workbench/service.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {WorkCycles,type WorkCycleScope} from './work-cycles.ts';
import {workspaceRelativePath} from './workspace-provider.ts';
import {readWorkbenchSourceRevision,type WorkbenchSourceRevision} from './workbench-source-revisions.ts';

export type SourceFileFact=Readonly<{path:string;version:number;sha256:string;size:number}>;
export type SourceManifest=Readonly<{protocol:1;provider:'workbench-project';files:readonly SourceFileFact[];sha256:string}>;
/** Opaque, instance-bound capability; contains no host paths or blob names. */
export type SourceSnapshot=Readonly<{manifest:SourceManifest;execution_authorized:false}>;
export type SourceControls={guard:()=>void|Promise<void>;signal:AbortSignal};
type PrivateFile=SourceFileFact&Readonly<{blob_name:string}>;
type RootIdentity=Readonly<{canonical:string;dev:string;ino:string}>;
/** Trusted host persistence only. Never expose this record through an API. */
export type PrivateSourceRecord=Readonly<{protocol:1;provider:'workbench-project';owner:string;scope:Readonly<WorkCycleScope>;cycle_id:string;root:RootIdentity|null;files:readonly PrivateFile[];sha256:string}>;
type Issued={record:PrivateSourceRecord;rootPath:string|null;inventoryFence?:WorkbenchSourceRevision};
const failure=(code:string)=>Error(code);
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function frozen<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))frozen(child);Object.freeze(value);}return value;}
function identity(stat:BigIntStats){return [stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(':');}
async function safe(path:string){let current=resolve(path);for(;;){const stat=await lstat(current,{bigint:true});if(stat.isSymbolicLink())throw failure('source_path_unsafe');const parent=dirname(current);if(parent===current)break;current=parent;}}
async function rootIdentity(path:string|null):Promise<RootIdentity|null>{if(path===null)return null;await safe(path);const stat=await lstat(path,{bigint:true});if(!stat.isDirectory())throw failure('source_path_unsafe');return {canonical:await realpath(path),dev:String(stat.dev),ino:String(stat.ino)};}
function bounded(error:unknown,signal?:AbortSignal){return failure(signal?.aborted?'source_cancelled':error instanceof Error&&/^source_[a-z_]+$/.test(error.message)?error.message:'source_unavailable');}
function facts(rows:Record<string,any>[]):readonly PrivateFile[]{const seen=new Set<string>();return frozen(rows.map(row=>{const path=workspaceRelativePath(row.path),key=path.normalize('NFC').toLowerCase();if(seen.has(key)||!Number.isSafeInteger(row.version)||row.version<1||!Number.isSafeInteger(row.size)||row.size<0||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256)||typeof row.blob_name!=='string'||!/^[-a-zA-Z0-9_]+\.[a-zA-Z0-9]+$/.test(row.blob_name)||row.original_version!==row.version||row.original_sha256!==row.sha256||row.original_size!==row.size||row.original_blob_name!==row.blob_name)throw failure('source_corrupt');seen.add(key);return {path,version:row.version,sha256:row.sha256,size:row.size,blob_name:row.blob_name};}));}

/** Read-only bridge from logical workbench version inventory to immutable blobs.
 * Hash verification succeeds only after the read iterable has been consumed.
 * Current inventory is observed repeatedly; this is not a filesystem freeze. */
export class WorkbenchProjectSource{
 private readonly issued=new WeakMap<SourceSnapshot,Issued>();
 private readonly cycles:WorkCycles;
 private readonly db:DatabaseSync;
 private readonly workbench:WorkbenchService;
 constructor(db:DatabaseSync,workbench:WorkbenchService){this.db=db;this.workbench=workbench;this.cycles=new WorkCycles(db);}
 private async check(owner:string,scope:WorkCycleScope,cycleId:string,controls:SourceControls){
  if(this.db.isTransaction)throw failure('source_transaction_active');
  if(!controls||typeof controls.guard!=='function'||!(controls.signal instanceof AbortSignal))throw failure('source_controls_required');
  if(controls.signal.aborted)throw failure('source_cancelled');
  try{this.cycles.guard(owner,scope,cycleId);}catch{throw failure('source_authority_rejected');}
  try{await controls.guard();}catch{throw failure(controls.signal.aborted?'source_cancelled':'source_guard_rejected');}
  if(controls.signal.aborted)throw failure('source_cancelled');
  try{this.cycles.guard(owner,scope,cycleId);}catch{throw failure('source_authority_rejected');}
 }
 private fence(record:PrivateSourceRecord){return readWorkbenchSourceRevision(this.db,record.owner,record.scope.workspace_id,record.scope.project_id);}
 private inventory(owner:string,scope:WorkCycleScope,cycleId:string){
  if(this.db.isTransaction)throw failure('source_transaction_active');
  this.db.exec('BEGIN DEFERRED');
  try{try{this.cycles.guard(owner,scope,cycleId);}catch{throw failure('source_authority_rejected');}
   return facts(this.db.prepare(`SELECT f.*,v.version original_version,v.sha256 original_sha256,v.size original_size,v.blob_name original_blob_name FROM wb_files f LEFT JOIN wb_file_versions v ON v.owner_id=f.owner_id AND v.workspace_id=f.workspace_id AND v.project_id=f.project_id AND v.path=f.path AND v.version=f.version WHERE f.owner_id=? AND f.workspace_id=? AND f.project_id=? ORDER BY f.path COLLATE BINARY`).all(owner,scope.workspace_id,scope.project_id) as Record<string,any>[]);
  }finally{this.db.exec('ROLLBACK');}
 }
 private projectRoot(owner:string,scope:WorkCycleScope){try{return this.workbench.projectSourceRoot(owner,scope.workspace_id,scope.project_id);}catch{throw failure('source_path_unsafe');}}
 private issue(record:PrivateSourceRecord,rootPath:string|null){const files=frozen(record.files.map(({path,version,sha256,size})=>({path,version,sha256,size}))),manifest=frozen({protocol:1 as const,provider:'workbench-project' as const,files,sha256:hash(files)}),snapshot=frozen({manifest,execution_authorized:false as const});this.issued.set(snapshot,{record,rootPath});return snapshot;}
 private capability(snapshot:SourceSnapshot){const issued=this.issued.get(snapshot);if(!issued)throw failure('source_untrusted');return issued;}
 async capture(owner:string,scope:WorkCycleScope,cycleId:string,controls:SourceControls):Promise<SourceSnapshot>{
  try{await this.check(owner,scope,cycleId,controls);const files=this.inventory(owner,scope,cycleId),rootPath=this.projectRoot(owner,scope),root=await rootIdentity(rootPath);if(files.length&&!root)throw failure('source_root_changed');
   const body={protocol:1 as const,provider:'workbench-project' as const,owner,scope:{...scope},cycle_id:cycleId,root,files},record=frozen({...body,sha256:hash(body)}),snapshot=this.issue(record,rootPath);
   try{await this.assertCurrent(snapshot,controls);return snapshot;}catch(error){this.issued.delete(snapshot);throw error;}
  }catch(error){throw bounded(error,controls?.signal);}
 }
 record(snapshot:SourceSnapshot):PrivateSourceRecord{return this.capability(snapshot).record;}
 async restore(owner:string,scope:WorkCycleScope,cycleId:string,privateRecord:PrivateSourceRecord,controls:SourceControls):Promise<SourceSnapshot>{
  try{await this.check(owner,scope,cycleId,controls);const snapshot=await this.capture(owner,scope,cycleId,controls);
   // Compare with fresh authoritative rows and derived root, never trust record paths.
   if(canonicalJson(privateRecord)!==canonicalJson(this.record(snapshot))){this.issued.delete(snapshot);throw failure('source_record_changed');}return snapshot;
  }catch(error){throw bounded(error,controls?.signal);}
 }
 async assertCurrent(snapshot:SourceSnapshot,controls:SourceControls):Promise<void>{
  try{const issued=this.capability(snapshot),{record,rootPath}=issued;await this.check(record.owner,record.scope,record.cycle_id,controls);const before=this.fence(record);
   if((issued.inventoryFence?.revision!==before.revision||issued.inventoryFence?.schema_version!==before.schema_version)&&canonicalJson(this.inventory(record.owner,record.scope,record.cycle_id))!==canonicalJson(record.files))throw failure('source_changed');
   const observed=this.projectRoot(record.owner,record.scope);if(observed!==rootPath||canonicalJson(await rootIdentity(observed))!==canonicalJson(record.root))throw failure('source_root_changed');
   if(controls.signal.aborted)throw failure('source_cancelled');
   try{this.cycles.guard(record.owner,record.scope,record.cycle_id);}catch{throw failure('source_authority_rejected');}
   // Only this project's current-file writes invalidate the async observation.
   // Other gateway work must not starve a stable source snapshot.
   const after=this.fence(record);if(after.revision!==before.revision)throw failure('source_changed');
   if(after.schema_version!==before.schema_version){
    if(canonicalJson(this.inventory(record.owner,record.scope,record.cycle_id))!==canonicalJson(record.files))throw failure('source_changed');
    const final=this.fence(record);if(final.revision!==after.revision||final.schema_version!==after.schema_version)throw failure('source_changed');
   }
   issued.inventoryFence=after;
  }catch(error){throw bounded(error,controls?.signal);}
 }
 async *read(snapshot:SourceSnapshot,path:string,controls:SourceControls):AsyncIterable<Uint8Array>{
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try{const {record,rootPath}=this.capability(snapshot);workspaceRelativePath(path);const file=record.files.find(file=>file.path===path);if(!file||rootPath===null)throw failure('source_file_not_found');
   await this.assertCurrent(snapshot,controls);const absolute=join(rootPath,'blobs',file.blob_name);await safe(absolute);const before=await lstat(absolute,{bigint:true}),canonical=await realpath(absolute);
   if(!before.isFile()||before.nlink!==1n||before.size!==BigInt(file.size)||canonical!==absolute)throw failure('source_path_unsafe');
   handle=await open(absolute,constants.O_RDONLY|(constants.O_NOFOLLOW??0));if(identity(await handle.stat({bigint:true}))!==identity(before))throw failure('source_changed');
   const digest=createHash('sha256');let bytes=0;
   // Explicit positional reads ensure descriptor closure on break, cancellation and error.
   for(;;){await this.assertCurrent(snapshot,controls);const buffer=Buffer.allocUnsafe(65536),read=await handle.read(buffer,0,buffer.length,bytes);if(!read.bytesRead)break;bytes+=read.bytesRead;if(bytes>file.size)throw failure('source_changed');const chunk=buffer.subarray(0,read.bytesRead);digest.update(chunk);yield chunk;}
   if(bytes!==file.size||digest.digest('hex')!==file.sha256||identity(await handle.stat({bigint:true}))!==identity(before))throw failure('source_content_changed');
   await safe(absolute);if(identity(await lstat(absolute,{bigint:true}))!==identity(before)||await realpath(absolute)!==canonical)throw failure('source_changed');await this.assertCurrent(snapshot,controls);
  }catch(error){throw bounded(error,controls?.signal);}finally{await handle?.close();}
 }
}
