import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {retainOriginalGitDatabase} from '../git/database-identity.ts';
import type {GitWorkbench} from '../git/service.ts';
import {ProjectRepository} from '../projects/repository.ts';
import {assertWorkspaceWritable,reserveWorkspaceOperation,readReservedWorkspaceFamily,sealWorkspaceFamily,releaseUnstartedWorkspaceOperation,type WorkspaceOperationSource} from '../workbench/workspace-coordination.ts';
import {workspacePublicationSchema} from '../workbench/workspace-coordination-upgrade.ts';
import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';
import type {WorkPublicationIntents} from './work-publication-intents.ts';
import {FinalizedWorkSources,type FinalizedWorkNativePlacement} from './finalized-work-sources.ts';
import type {GitNativeWorkspaceObservation} from '../git/index-effects.ts';

type Row=Record<string,any>;
export type WorkPublicationAdmissionInput={request_id:string;expected_version:number;review_sha256:string};
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function fail(code:string):never{throw Error('work_publication_'+code);}
type NativeView=Readonly<{source:ReturnType<WorkPublicationExecutions['workspaceFamily']>;workspaces:readonly GitNativeWorkspaceObservation[];signal:AbortSignal;execution_authorized:false}>;
type NativeHost=Readonly<{
 withReservedFamily<T>(scope:Readonly<{owner_id:string;project_id:string;execution_id:string;operation_kind:'work_publication'}>,controls:Readonly<{assertReservation:()=>void;signal?:AbortSignal}>,operation:(context:unknown)=>Promise<T>):Promise<T>;
 inspect(context:unknown):NativeView;assertAdmission(context:unknown):void;
}>;
type HeldSourceView=Readonly<{source:ReturnType<WorkPublicationIntents['executionSource']>;family:ReturnType<WorkPublicationExecutions['workspaceFamily']>;placement:FinalizedWorkNativePlacement;signal:AbortSignal;execution_authorized:false}>;

/** Explicit owning bootstrap only. This installs original acceptance facts,
 * never an executor, task scheduler or native producer. */
export function installWorkPublicationExecutions(db:DatabaseSync){
 const install=()=>{
  db.exec(`CREATE TABLE IF NOT EXISTS wb_work_publication_executions(
   execution_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES ga_projects(id),
   intent_id TEXT NOT NULL UNIQUE REFERENCES wb_work_publication_intents(intent_id),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,
   review_version INTEGER NOT NULL,review_sha256 TEXT NOT NULL,source_sha256 TEXT NOT NULL,target_sha256 TEXT NOT NULL,
   binding_sha256 TEXT NOT NULL,database_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,protocol INTEGER NOT NULL CHECK(protocol=1),
   UNIQUE(owner_id,project_id,request_id));
  CREATE TABLE IF NOT EXISTS wb_work_publication_admissions(execution_id TEXT PRIMARY KEY REFERENCES wb_work_publication_executions(execution_id),record_json TEXT NOT NULL,record_sha256 TEXT NOT NULL);`);
  for(const table of ['wb_work_publication_executions','wb_work_publication_admissions']){
   for(const action of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'work_publication_execution_immutable'); END;`);
   db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE execution_id=NEW.execution_id${table==='wb_work_publication_executions'?' OR intent_id=NEW.intent_id OR owner_id=NEW.owner_id AND project_id=NEW.project_id AND request_id=NEW.request_id':''}) BEGIN SELECT RAISE(ABORT,'work_publication_execution_immutable'); END;`);
  }
 };
 if(db.isTransaction)install();else withImmediateTransaction(db,install);
}

/** Immutable admission and original project-family custody prerequisite only.
 * No method here dispatches files, native work, models or a background Worker. */
export class WorkPublicationExecutions{
 private readonly db:DatabaseSync;private readonly git:GitWorkbench;private readonly intents:WorkPublicationIntents;
 private readonly projects:ProjectRepository;private readonly originalDb:ReturnType<typeof retainOriginalGitDatabase>;
 private readonly nativeHost:NativeHost|undefined;private readonly nativeSources=new WeakMap<object,{view:HeldSourceView;check:()=>void}>();
 constructor(db:DatabaseSync,git:GitWorkbench,intents:WorkPublicationIntents,options:{nativeWorkspaceHost?:NativeHost}={}){
  this.db=db;this.git=git;this.intents=intents;this.projects=new ProjectRepository(db);this.originalDb=retainOriginalGitDatabase(db);
  if(!options||typeof options!=='object'||Object.keys(options).some(key=>key!=='nativeWorkspaceHost'))fail('native_host_invalid');
  const host=options.nativeWorkspaceHost;if(host!==undefined){if(!host||typeof host.withReservedFamily!=='function'||typeof host.inspect!=='function'||typeof host.assertAdmission!=='function')fail('native_host_invalid');
   this.nativeHost=Object.freeze({withReservedFamily:host.withReservedFamily.bind(host),inspect:host.inspect.bind(host),assertAdmission:host.assertAdmission.bind(host)});}
 }
 private read<T>(fn:()=>T):T{const outer=this.db.isTransaction;if(!outer)this.db.exec('BEGIN DEFERRED');try{this.originalDb.assertCurrent();return fn();}finally{if(!outer&&this.db.isTransaction)this.db.exec('ROLLBACK');}}
 private row(owner:string,project:string,id:string){this.originalDb.assertCurrent();this.projects.assertOwned(project,owner);const row=this.db.prepare('SELECT * FROM wb_work_publication_executions WHERE execution_id=? AND owner_id=? AND project_id=?').get(id,owner,project) as Row|undefined;if(!row)fail('execution_not_found');if(row.protocol!==1||row.database_sha256!==this.originalDb.sha256)fail('execution_source_changed');return row;}
 private acceptance(row:Row){return{protocol:1 as const,execution_id:row.execution_id,operation_kind:'work_publication' as const,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,
  review_version:row.review_version,review_sha256:row.review_sha256,source_sha256:row.source_sha256,target_sha256:row.target_sha256,state:'accepted' as const,accepted_at:row.created_at,execution_authorized:false as const};}
 private receipt(row:Row){
  const saved=this.db.prepare('SELECT * FROM wb_work_publication_admissions WHERE execution_id=?').get(row.execution_id) as Row|undefined;if(!saved)fail('admission_unconfirmed');let record;try{record=JSON.parse(saved.record_json);}catch{fail('admission_corrupt');}
  if(canonicalJson(record)!==saved.record_json||hash(record)!==saved.record_sha256||record?.protocol!==1||canonicalJson(record.execution)!==canonicalJson(row)||canonicalJson(record.acceptance)!==canonicalJson(this.acceptance(row)))fail('admission_corrupt');
  return freezeWorkAdmission(record.acceptance as ReturnType<WorkPublicationExecutions['acceptance']>);
 }
 private current(row:Row){
  this.receipt(row);const source=this.intents.executionSource(row.owner_id,row.project_id,row.intent_id,row.review_version,row.review_sha256);
  if(source.database_sha256!==this.originalDb.sha256||source.source.source_sha256!==row.source_sha256||source.target.target_sha256!==row.target_sha256||source.binding_sha256!==row.binding_sha256||this.git.executionBinding(row.owner_id,row.project_id)!==row.binding_sha256)fail('execution_source_changed');
  return source;
 }
 private scope(row:Row):WorkspaceOperationSource{return{owner_id:row.owner_id,project_id:row.project_id,operation_kind:'work_publication',operation_id:row.execution_id,binding_sha256:row.binding_sha256};}
 admit(owner:string,project:string,intentId:string,value:WorkPublicationAdmissionInput){
  if(!this.db.isTransaction)fail('transaction_required');this.originalDb.assertCurrent();this.projects.assertOwned(project,owner);
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='expected_version,request_id,review_sha256'||typeof value.request_id!=='string'||!ID.test(value.request_id)||!Number.isSafeInteger(value.expected_version)||value.expected_version<1||typeof value.review_sha256!=='string'||!SHA.test(value.review_sha256)||typeof intentId!=='string'||!ID.test(intentId))fail('execution_invalid');
  const input={request_id:value.request_id,expected_version:value.expected_version,review_sha256:value.review_sha256},requestHash=hash({intent_id:intentId,...input});
  const prior=this.db.prepare('SELECT execution_id,request_sha256 FROM wb_work_publication_executions WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
  if(prior){if(prior.request_sha256!==requestHash)throw Error('idempotency_conflict');return this.receipt(this.row(owner,project,prior.execution_id));}
  if(workspacePublicationSchema(this.db)!=='publication')throw Error('workspace_publication_upgrade_required');
  assertWorkspaceWritable(this.db,owner,project);const source=this.intents.executionSource(owner,project,intentId,input.expected_version,input.review_sha256);
  if(source.database_sha256!==this.originalDb.sha256||source.binding_sha256!==this.git.executionBinding(owner,project))fail('execution_source_changed');
  if(this.db.prepare('SELECT 1 FROM wb_work_publication_executions WHERE intent_id=?').get(intentId))fail('execution_exists');
  const row={execution_id:'work-publication-execution-'+randomUUID(),owner_id:owner,project_id:project,intent_id:intentId,request_id:input.request_id,request_sha256:requestHash,
   review_version:input.expected_version,review_sha256:input.review_sha256,source_sha256:source.source.source_sha256,target_sha256:source.target.target_sha256,binding_sha256:source.binding_sha256,database_sha256:this.originalDb.sha256,created_at:new Date().toISOString(),protocol:1};
  this.db.prepare('INSERT INTO wb_work_publication_executions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.execution_id,owner,project,intentId,row.request_id,row.request_sha256,row.review_version,row.review_sha256,row.source_sha256,row.target_sha256,row.binding_sha256,row.database_sha256,row.created_at,row.protocol);
  const record={protocol:1,execution:row,acceptance:this.acceptance(row)};this.db.prepare('INSERT INTO wb_work_publication_admissions VALUES(?,?,?)').run(row.execution_id,canonicalJson(record),hash(record));return this.receipt(this.row(owner,project,row.execution_id));
 }
 getAdmission(owner:string,project:string,requestId:string){return this.read(()=>{if(typeof requestId!=='string'||!ID.test(requestId))fail('execution_invalid');this.projects.assertOwned(project,owner);const row=this.db.prepare('SELECT execution_id FROM wb_work_publication_executions WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,requestId) as Row|undefined;if(!row)fail('execution_not_found');return this.receipt(this.row(owner,project,row.execution_id));});}
 reserveWorkspace(owner:string,project:string,id:string){return withImmediateTransaction(this.db,()=>{const row=this.row(owner,project,id);this.current(row);const scope=this.scope(row),result=reserveWorkspaceOperation(this.db,scope);sealWorkspaceFamily(this.db,scope);return result;});}
 workspaceFamily(owner:string,project:string,id:string){return withImmediateTransaction(this.db,()=>{const row=this.row(owner,project,id);this.current(row);return{...readReservedWorkspaceFamily(this.db,this.scope(row)),operation_kind:'work_publication' as const};});}
 /** Original-host composition prerequisite, not physical dispatch or a public
  * callback API. The operation receives an ephemeral private token, never a
  * root selector or serializable execution grant. An actual producer must also
  * retain its exact original Worker lease and effect journal before writing. */
 async withReservedNativeSource<T>(owner:string,project:string,id:string,operation:(context:object)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(this.db.isTransaction)fail('async_transaction');if(typeof operation!=='function')fail('native_host_invalid');signal?.throwIfAborted();
  const host=this.nativeHost;if(!host)fail('native_host_unavailable');
  const row=this.row(owner,project,id),source=this.current(row);this.reserveWorkspace(owner,project,id);const family=freezeWorkAdmission(this.workspaceFamily(owner,project,id));
  const sources=new FinalizedWorkSources(this.db),placement=sources.nativePlacement(owner,source.source.run_id,source.source.source_sha256);
  const original=canonicalJson(placement);
  const checkReservation=()=>{signal?.throwIfAborted();const current=this.workspaceFamily(owner,project,id);if(current.reservation_id!==family.reservation_id||current.family_sha256!==family.family_sha256)fail('native_source_changed');};
  const checkPlacement=()=>{checkReservation();if(canonicalJson(sources.nativePlacement(owner,source.source.run_id,source.source.source_sha256))!==original)fail('native_source_changed');};
  let finalCheck:(()=>void)|undefined;
  const result=await host.withReservedFamily({owner_id:owner,project_id:project,execution_id:id,operation_kind:'work_publication'},{assertReservation:checkPlacement,...(signal?{signal}:{})},async nativeContext=>{
   const admission=()=>{const value=host.assertAdmission(nativeContext) as unknown;if(value!==undefined){if(value&&typeof(value as {then?:unknown}).then==='function')Promise.resolve(value).catch(()=>{});fail('native_host_invalid');}};
   checkPlacement();admission();const observed=host.inspect(nativeContext),nativeSource=observed?.source;
   if(!observed||observed.execution_authorized!==false||!nativeSource||nativeSource.execution_authorized!==false||nativeSource.operation_kind!=='work_publication'
    ||nativeSource.reservation_id!==family.reservation_id||nativeSource.family_sha256!==family.family_sha256||nativeSource.binding_sha256!==family.binding_sha256
    ||nativeSource.execution_id!==id||nativeSource.owner_id!==owner||nativeSource.project_id!==project||!(observed.signal instanceof AbortSignal)||!Array.isArray(observed.workspaces)
    ||canonicalJson(observed.workspaces.map(member=>member.session_ref))!==canonicalJson(family.members.map(member=>member.session_ref)))fail('native_source_changed');
   const roots=this.git.indexEffects(owner,project).retainPublicationNativeWorkspaceRoots(placement,observed.workspaces);
   const check=()=>{observed.signal.throwIfAborted();checkPlacement();admission();if(host.inspect(nativeContext)!==observed)fail('native_context_invalid');roots();};
   finalCheck=()=>{checkPlacement();roots();};check();const context=Object.freeze({});
   this.nativeSources.set(context,{view:Object.freeze({source,family,placement,signal:observed.signal,execution_authorized:false}),check});
   try{const value=await operation(context);check();return value;}finally{this.nativeSources.delete(context);}
  });
  if(!finalCheck)fail('native_context_invalid');finalCheck();return result;
 }
 /** Private, nonserializable source custody observation; no effect permission. */
 assertNativeSource(context:object){const held=this.nativeSources.get(context);if(!held)fail('native_context_invalid');held.check();}
 inspectNativeSource(context:object){this.assertNativeSource(context);return this.nativeSources.get(context)!.view;}
 releaseUnstartedWorkspace(owner:string,project:string,id:string){return withImmediateTransaction(this.db,()=>{
  const row=this.row(owner,project,id);this.receipt(row);
  // This admission-only version cannot start a producer. A future/unrecognized
  // lifecycle schema is never interpreted as proof of no producer or no effect.
  const known=new Set(['wb_work_publication_intents','wb_work_publication_events','wb_work_publication_executions','wb_work_publication_admissions']);
  const tables=this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'wb_work_publication_*'").all() as {name:string}[];
  if(tables.some(table=>!known.has(table.name)))fail('producer_unconfirmed');
  if(this.git.executionBinding(owner,project)!==row.binding_sha256)fail('execution_source_changed');return releaseUnstartedWorkspaceOperation(this.db,this.scope(row));
 });}
}
