import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {assertExecutionLease,type ExecutionLease} from '../workbench/execution-lease.ts';
import type {ProjectRepository} from '../projects/repository.ts';
import type {GitWorkbench} from './service.ts';
import type {GitMutationIntents} from './intents.ts';
import type {GitIndexReceipt,GitNativeWorkspaceObservation} from './index-effects.ts';
import type {GitIndexAcceptance,GitIndexExecutionResult} from '../../contracts/types.ts';
import {indexEvidence,indexPreparation,type GitIndexEvidence,type GitIndexPreparation} from './index-evidence.ts';
import {GitIndexProducers} from './index-producers.ts';
import {readReservedNativePlacements} from '../persistent-tasks/publication-native-placements.ts';
import {assertWorkspaceWritable,reserveWorkspaceOperation,releaseUnstartedWorkspaceOperation,settleWorkspaceOperation,readReservedWorkspaceFamily,sealWorkspaceFamily,assertNativeWorkspaceAdmission} from '../workbench/workspace-coordination.ts';

type Input={request_id:string;expected_version:number;review_sha256:string};
type Row={execution_id:string;owner_id:string;project_id:string;intent_id:string;request_id:string;request_sha256:string;review_version:number;review_sha256:string;action:'stage'|'unstage';witness_sha256:string;repository_sha256:string;created_at:string;protocol:number;binding_sha256:string|null};
type Dispatch={evidence_json:string;evidence_sha256:string};
type Outcome={receipt_json:string;receipt_sha256:string};
type Acceptance=GitIndexAcceptance;
type ExecutionResult=GitIndexExecutionResult;
type AppliedResult=Extract<ExecutionResult,{state:'applied'}>;
type ClosedResult=Extract<ExecutionResult,{disposition_id:string}>;
type ControlInput={request_id:string;expected_state_sha256:string;acknowledge_unknown:true};
type Control={control_id:string;execution_id:string;owner_id:string;project_id:string;request_id:string;request_sha256:string;expected_state_sha256:string;created_at:string};
type Disposition={execution_id:string;control_id:string;kind:'not_dispatched'|'abandoned_unknown';snapshot_sha256:string;created_at:string};
type Cleanup='verified'|'unverified'|'not_recorded'|'not_attempted';
type NativeWorkspaceView=Readonly<{source:ReturnType<GitIndexExecutions['workspaceFamily']>;workspaces:readonly GitNativeWorkspaceObservation[];signal:AbortSignal;execution_authorized:false}>;
type NativeWorkspaceHost=Readonly<{
 withReservedFamily<T>(scope:Readonly<{owner_id:string;project_id:string;execution_id:string}>,controls:Readonly<{assertReservation:()=>void;signal?:AbortSignal}>,operation:(context:unknown)=>Promise<T>):Promise<T>;
 inspect(context:unknown):NativeWorkspaceView;
 assertAdmission(context:unknown):void;
}>;
type ControlReceipt={control_id:string;execution_id:string;request_id:string;state:'completed';result:AppliedResult|ClosedResult;cleanup:Cleanup;execution_authorized:false};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
/** Internal original execution journal. No route/tool is mounted by constructing
 * this service. Caller identity comes from original ownership, never the body. */
export class GitIndexExecutions{
 private readonly db:DatabaseSync;private readonly projects:ProjectRepository;private readonly git:GitWorkbench;private readonly intents:GitMutationIntents;private readonly now:()=>number;private readonly leaseMs:number;
 private readonly producers:GitIndexProducers;
 private readonly nativeWorkspaceHost:NativeWorkspaceHost|undefined;
 private readonly nativeCustodies=new WeakMap<object,{execution_id:string;assertCurrent:()=>void}>();
 constructor(db:DatabaseSync,projects:ProjectRepository,git:GitWorkbench,intents:GitMutationIntents,options:{now?:()=>number;leaseMs?:number;nativeWorkspaceHost?:NativeWorkspaceHost}={}){
  this.db=db;this.projects=projects;this.git=git;this.intents=intents;this.now=options.now??Date.now;this.leaseMs=options.leaseMs??30000;
  if(!Number.isSafeInteger(this.leaseMs)||this.leaseMs<300||this.leaseMs>300000)throw Error('git_execution_configuration_invalid');
  const native=options.nativeWorkspaceHost;
  if(native!==undefined){if(!native||typeof native.withReservedFamily!=='function'||typeof native.inspect!=='function'||typeof native.assertAdmission!=='function')throw Error('git_native_workspace_host_unavailable');this.nativeWorkspaceHost=Object.freeze({withReservedFamily:native.withReservedFamily.bind(native),inspect:native.inspect.bind(native),assertAdmission:native.assertAdmission.bind(native)});}
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_worker_leases'").get())throw Error('git_execution_storage_unavailable');
  db.exec(`CREATE TABLE IF NOT EXISTS wb_git_index_executions(
   execution_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,
   intent_id TEXT NOT NULL UNIQUE REFERENCES wb_git_mutation_intents(intent_id),request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,
   review_version INTEGER NOT NULL,review_sha256 TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN('stage','unstage')),
   witness_sha256 TEXT NOT NULL,repository_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(owner_id,project_id,request_id));
   CREATE TABLE IF NOT EXISTS wb_git_index_dispatches(execution_id TEXT PRIMARY KEY REFERENCES wb_git_index_executions(execution_id),evidence_json TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,lease_owner TEXT NOT NULL,lease_generation INTEGER NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_git_index_preparations(execution_id TEXT PRIMARY KEY REFERENCES wb_git_index_executions(execution_id),evidence_json TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,lease_owner TEXT NOT NULL,lease_generation INTEGER NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_git_index_admissions(execution_id TEXT PRIMARY KEY REFERENCES wb_git_index_executions(execution_id),receipt_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_git_index_controls(control_id TEXT PRIMARY KEY,execution_id TEXT NOT NULL REFERENCES wb_git_index_executions(execution_id),owner_id TEXT NOT NULL,project_id TEXT NOT NULL,request_id TEXT NOT NULL,request_sha256 TEXT NOT NULL,expected_state_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(owner_id,project_id,request_id));
   CREATE TABLE IF NOT EXISTS wb_git_index_dispositions(execution_id TEXT PRIMARY KEY REFERENCES wb_git_index_executions(execution_id),control_id TEXT NOT NULL UNIQUE REFERENCES wb_git_index_controls(control_id),kind TEXT NOT NULL CHECK(kind IN('not_dispatched','abandoned_unknown')),snapshot_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_git_index_control_receipts(control_id TEXT PRIMARY KEY REFERENCES wb_git_index_controls(control_id),receipt_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_git_index_outcomes(execution_id TEXT PRIMARY KEY REFERENCES wb_git_index_executions(execution_id),receipt_json TEXT NOT NULL,receipt_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);`);
  // Existing rows used the earlier unjournaled lock-acquisition algorithm. Do
  // not reinterpret a pending legacy execution as safe just because it has no
  // dispatch. The extra column also makes an old positional INSERT fail shut.
  if(!db.prepare('PRAGMA table_info(wb_git_index_executions)').all().some(column=>column.name==='protocol'))db.exec('ALTER TABLE wb_git_index_executions ADD COLUMN protocol INTEGER NOT NULL DEFAULT 1');
  if(!db.prepare('PRAGMA table_info(wb_git_index_executions)').all().some(column=>column.name==='binding_sha256'))db.exec('ALTER TABLE wb_git_index_executions ADD COLUMN binding_sha256 TEXT');
  for(const table of ['wb_git_index_executions','wb_git_index_preparations','wb_git_index_dispatches','wb_git_index_outcomes','wb_git_index_admissions','wb_git_index_controls','wb_git_index_dispositions','wb_git_index_control_receipts'])for(const kind of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${kind.toLowerCase()} BEFORE ${kind} ON ${table} BEGIN SELECT RAISE(ABORT,'git_execution_immutable'); END;`);
  for(const table of ['wb_git_index_preparations','wb_git_index_dispatches','wb_git_index_outcomes'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_disposed BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM wb_git_index_dispositions WHERE execution_id=NEW.execution_id) BEGIN SELECT RAISE(ABORT,'git_execution_closed'); END;`);
  for(const table of ['wb_git_index_preparations','wb_git_index_dispatches','wb_git_index_dispositions'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_applied BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM wb_git_index_outcomes WHERE execution_id=NEW.execution_id) BEGIN SELECT RAISE(ABORT,'git_execution_closed'); END;`);
  this.producers=new GitIndexProducers(db,this.now);
 }
 private input(value:Input):Input{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='expected_version,request_id,review_sha256'||typeof value.request_id!=='string'||!ID.test(value.request_id)||!Number.isSafeInteger(value.expected_version)||value.expected_version<1||typeof value.review_sha256!=='string'||!SHA.test(value.review_sha256))throw Error('git_execution_invalid');
  return{request_id:value.request_id,expected_version:value.expected_version,review_sha256:value.review_sha256};
 }
 private row(owner:string,project:string,id:string):Row{this.projects.assertOwned(project,owner);const row=this.db.prepare('SELECT * FROM wb_git_index_executions WHERE execution_id=? AND owner_id=? AND project_id=?').get(id,owner,project) as Row|undefined;if(!row)throw Error('git_execution_not_found');if(![1,2,3,4].includes(row.protocol)||row.protocol>=3&&(typeof row.binding_sha256!=='string'||!SHA.test(row.binding_sha256))||row.protocol<3&&row.binding_sha256!==null)throw Error('git_execution_evidence_corrupt');return row;}
 producer(owner:string,project:string,id:string){const row=this.row(owner,project,id);this.get(owner,project,id);return this.producers.view(row,this.resource(row));}
 private resource(row:Row){return row.binding_sha256?'git-index-binding:'+row.binding_sha256:'git-index:'+row.repository_sha256;}
 private preparation(row:Row):GitIndexPreparation|undefined{
  const record=this.db.prepare('SELECT * FROM wb_git_index_preparations WHERE execution_id=?').get(row.execution_id) as Dispatch|undefined;if(!record)return;
  const value=JSON.parse(record.evidence_json);if(digest(value)!==record.evidence_sha256)throw Error('git_execution_evidence_corrupt');const preparation=indexPreparation(value);this.validateEvidence(row,preparation.evidence);return preparation;
 }
 private validateEvidence(row:Row,evidence:GitIndexEvidence){
  const review=this.intents.get(row.owner_id,row.project_id,row.intent_id);
  if(evidence.source_sha256!==row.witness_sha256||evidence.plan.repository_sha256!==row.repository_sha256||evidence.plan.action!==row.action||JSON.stringify(evidence.plan.paths)!==JSON.stringify(review.paths))throw Error('git_execution_evidence_corrupt');
 }
 private evidence(row:Row):GitIndexEvidence|undefined{
  const record=this.db.prepare('SELECT * FROM wb_git_index_dispatches WHERE execution_id=?').get(row.execution_id) as Dispatch|undefined;if(!record)return;
  const value=JSON.parse(record.evidence_json);if(digest(value)!==record.evidence_sha256)throw Error('git_execution_evidence_corrupt');const evidence=indexEvidence(value);this.validateEvidence(row,evidence);if(row.protocol>=2&&JSON.stringify(this.preparation(row)?.evidence)!==JSON.stringify(evidence))throw Error('git_execution_evidence_corrupt');return evidence;
 }
 private result(row:Row,evidence:GitIndexEvidence){return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,action:row.action,paths:[...evidence.plan.paths],state:'applied' as const,before_index_sha256:evidence.plan.before_index_sha256,index_sha256:evidence.plan.index_sha256,execution_authorized:false as const};}
 private disposition(row:Row):Disposition|undefined{
  const d=this.db.prepare('SELECT * FROM wb_git_index_dispositions WHERE execution_id=?').get(row.execution_id) as Disposition|undefined;if(!d)return;
  const control=this.db.prepare('SELECT * FROM wb_git_index_controls WHERE control_id=?').get(d.control_id) as Control|undefined;
  if(!control||control.execution_id!==row.execution_id||control.owner_id!==row.owner_id||control.project_id!==row.project_id||control.expected_state_sha256!==d.snapshot_sha256||control.request_sha256!==digest({execution_id:row.execution_id,request_id:control.request_id,expected_state_sha256:control.expected_state_sha256,acknowledge_unknown:true})||!['not_dispatched','abandoned_unknown'].includes(d.kind)||d.kind==='not_dispatched'&&(row.protocol===1||this.db.prepare('SELECT 1 FROM wb_git_index_dispatches WHERE execution_id=?').get(row.execution_id)))throw Error('git_execution_evidence_corrupt');
  const saved=this.db.prepare('SELECT * FROM wb_git_index_control_receipts WHERE control_id=?').get(d.control_id) as Outcome|undefined;if(!saved)throw Error('git_execution_outcome_corrupt');const receipt=JSON.parse(saved.receipt_json);
  if(digest(receipt)!==saved.receipt_sha256||!['verified','unverified','not_recorded','not_attempted'].includes(receipt.cleanup)||JSON.stringify(receipt)!==JSON.stringify(this.makeControlReceipt(control,this.closedResult(row,d),receipt.cleanup)))throw Error('git_execution_outcome_corrupt');return d;
 }
 private closedResult(row:Row,d:Disposition):ClosedResult{const review=this.intents.get(row.owner_id,row.project_id,row.intent_id);return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,action:row.action,paths:review.paths,state:d.kind,disposition_id:d.control_id,execution_authorized:false};}
 get(owner:string,project:string,id:string):ExecutionResult{
  const row=this.row(owner,project,id),evidence=this.evidence(row),outcome=this.db.prepare('SELECT * FROM wb_git_index_outcomes WHERE execution_id=?').get(id) as Outcome|undefined,disposition=this.disposition(row);
  if(outcome&&disposition)throw Error('git_execution_outcome_corrupt');
  if(outcome){const result=JSON.parse(outcome.receipt_json);if(!evidence||digest(result)!==outcome.receipt_sha256||JSON.stringify(result)!==JSON.stringify(this.result(row,evidence)))throw Error('git_execution_outcome_corrupt');return result as ReturnType<GitIndexExecutions['result']>;}
  if(disposition)return this.closedResult(row,disposition);
  const review=this.intents.get(owner,project,row.intent_id);return{execution_id:id,project_id:project,intent_id:row.intent_id,request_id:row.request_id,action:row.action,paths:review.paths,state:evidence||this.preparation(row)||row.protocol===1?'unknown' as const:'pending' as const,execution_authorized:false as const};
 }
 private workspaceAuthority(row:Row,custody?:object){
  if(custody===undefined){assertWorkspaceWritable(this.db,row.owner_id,row.project_id);return;}
  const held=this.nativeCustodies.get(custody);if(!held||held.execution_id!==row.execution_id)throw Error('git_native_workspace_custody_invalid');held.assertCurrent();
 }
 private authority(row:Row,lease:ExecutionLease,custody?:object){
  this.row(row.owner_id,row.project_id,row.execution_id);assertExecutionLease(this.db,this.resource(row),lease,this.now);
  this.workspaceAuthority(row,custody);
  if(this.db.prepare('SELECT 1 FROM wb_git_index_dispositions WHERE execution_id=?').get(row.execution_id))throw Error('git_execution_closed');
  if(row.binding_sha256&&this.git.executionBinding(row.owner_id,row.project_id)!==row.binding_sha256)throw Error('git_repository_changed');
  const original=this.intents.executionSource(row.owner_id,row.project_id,row.intent_id,row.review_version,row.review_sha256);
  if(original.action!==row.action||digest(original.witness)!==row.witness_sha256||original.witness.repository_sha256!==row.repository_sha256)throw Error('git_execution_source_invalid');
 }
 private claim(row:Row,custody?:object):ExecutionLease{
  this.workspaceAuthority(row,custody);
  const resource=this.resource(row),old=this.db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(resource),expiry=old?Number(old.expires_at):0;
  if(old&&(!Number.isSafeInteger(expiry)||!Number.isSafeInteger(Number(old.generation))||Number(old.generation)<1||expiry>this.now()))throw Error('git_execution_busy');
  const lease={owner:'git-executor-'+randomUUID(),generation:old?Number(old.generation)+1:1};if(!Number.isSafeInteger(lease.generation))throw Error('git_execution_busy');
  this.db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at,updated_at=excluded.updated_at').run(resource,lease.owner,lease.generation,String(this.now()+this.leaseMs),new Date(this.now()).toISOString());return lease;
 }
 private release(row:Row,lease:ExecutionLease){this.db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?').run(this.resource(row),lease.owner,lease.generation);}
 private cleanupTransaction(row:Row,lease:ExecutionLease,remove:()=>void){withImmediateTransaction(this.db,()=>{this.row(row.owner_id,row.project_id,row.execution_id);assertExecutionLease(this.db,this.resource(row),lease,this.now);remove();});}
 private outcome(row:Row,evidence:GitIndexEvidence){const receipt=this.result(row,evidence);this.db.prepare('INSERT INTO wb_git_index_outcomes VALUES(?,?,?,?)').run(row.execution_id,JSON.stringify(receipt),digest(receipt),new Date(this.now()).toISOString());return receipt;}
 private registerExecution(owner:string,project:string,intent:string,input:Input,requestHash:string,source:ReturnType<GitMutationIntents['executionSource']>):Row{
  const binding=this.git.executionBinding(owner,project),existing=this.db.prepare('SELECT * FROM wb_git_index_executions WHERE intent_id=?').get(intent) as Row|undefined;
  if(existing&&(existing.owner_id!==owner||existing.project_id!==project||existing.request_sha256!==requestHash))throw Error('git_intent_execution_exists');
  if(this.db.prepare('SELECT 1 FROM wb_git_index_executions e LEFT JOIN wb_git_index_outcomes o ON o.execution_id=e.execution_id LEFT JOIN wb_git_index_dispositions d ON d.execution_id=e.execution_id WHERE e.execution_id<>? AND o.execution_id IS NULL AND d.execution_id IS NULL AND (e.binding_sha256 IS NULL OR e.binding_sha256=? OR (e.owner_id=? AND e.project_id=?))').get(existing?.execution_id??'',binding,owner,project))throw Error('git_execution_reconciliation_required');
  const row:Row=existing??{execution_id:'git-execution-'+randomUUID(),owner_id:owner,project_id:project,intent_id:intent,request_id:input.request_id,request_sha256:requestHash,review_version:input.expected_version,review_sha256:input.review_sha256,action:source.action,witness_sha256:digest(source.witness),repository_sha256:source.witness.repository_sha256,created_at:new Date(this.now()).toISOString(),protocol:4,binding_sha256:binding};
  if(!existing)this.db.prepare('INSERT INTO wb_git_index_executions(execution_id,owner_id,project_id,intent_id,request_id,request_sha256,review_version,review_sha256,action,witness_sha256,repository_sha256,created_at,protocol,binding_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(row.execution_id,owner,project,intent,input.request_id,requestHash,row.review_version,row.review_sha256,row.action,row.witness_sha256,row.repository_sha256,row.created_at,row.protocol,row.binding_sha256);return row;
 }
 private acceptance(row:Row):Acceptance{return{execution_id:row.execution_id,project_id:row.project_id,intent_id:row.intent_id,request_id:row.request_id,action:row.action,accepted:true,execution_authorized:false};}
 private admission(row:Row):Acceptance{
  const saved=this.db.prepare('SELECT * FROM wb_git_index_admissions WHERE execution_id=?').get(row.execution_id) as Outcome|undefined;if(!saved)throw Error('git_admission_not_found');const value=JSON.parse(saved.receipt_json);
  if(row.request_sha256!==digest({intent_id:row.intent_id,request_id:row.request_id,expected_version:row.review_version,review_sha256:row.review_sha256})||digest(value)!==saved.receipt_sha256||JSON.stringify(value)!==JSON.stringify(this.acceptance(row)))throw Error('git_admission_receipt_corrupt');return value as Acceptance;
 }
 /** Synchronous business half of original HTTP admission. No physical effects,
  * lease acquisition or asynchronous dispatch occurs inside the caller txn. */
 admit(owner:string,project:string,intent:string,value:Input,signal?:AbortSignal):Acceptance{
  if(!this.db.isTransaction)throw Error('git_admission_transaction_required');signal?.throwIfAborted();this.projects.assertOwned(project,owner);if(typeof intent!=='string'||!ID.test(intent))throw Error('git_execution_invalid');const input=this.input(value),requestHash=digest({intent_id:intent,...input});
  const prior=this.db.prepare('SELECT * FROM wb_git_index_executions WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
  if(prior){if(prior.intent_id!==intent||prior.request_sha256!==requestHash)throw Error('idempotency_conflict');const row=this.row(owner,project,prior.execution_id);if(!this.db.prepare('SELECT 1 FROM wb_git_index_admissions WHERE execution_id=?').get(row.execution_id))throw Error('git_execution_origin_conflict');return this.admission(row);}
  const source=this.intents.executionSource(owner,project,intent,input.expected_version,input.review_sha256),row=this.registerExecution(owner,project,intent,input,requestHash,source),receipt=this.acceptance(row);
  this.db.prepare('INSERT INTO wb_git_index_admissions VALUES(?,?,?,?)').run(row.execution_id,JSON.stringify(receipt),digest(receipt),new Date(this.now()).toISOString());return receipt;
 }
 getAdmission(owner:string,project:string,request:string):Acceptance{
  this.projects.assertOwned(project,owner);if(typeof request!=='string'||!ID.test(request))throw Error('git_execution_invalid');const row=this.db.prepare('SELECT execution_id FROM wb_git_index_executions WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,request) as {execution_id:string}|undefined;if(!row)throw Error('git_admission_not_found');return this.admission(this.row(owner,project,row.execution_id));
 }
 /** UI history must not silently adopt a trusted internal/native execution. */
 getAdmitted(owner:string,project:string,id:string):ExecutionResult{
  if(typeof id!=='string'||!ID.test(id))throw Error('git_execution_invalid');this.admission(this.row(owner,project,id));return this.get(owner,project,id);
 }
 /** Reserve project coordination only, never native quiescence or Git effects. */
 reserveWorkspace(owner:string,project:string,id:string){
  return withImmediateTransaction(this.db,()=>{
   const row=this.row(owner,project,id);this.admission(row);
   if(this.get(owner,project,id).state!=='pending')throw Error('workspace_reservation_source_closed');
   this.producers.assertStartable(row,this.resource(row));
   this.intents.executionSource(owner,project,row.intent_id,row.review_version,row.review_sha256);
   if(row.protocol!==4||row.binding_sha256!==this.git.executionBinding(owner,project))throw Error('workspace_reservation_source_changed');
   const source={owner_id:owner,project_id:project,operation_kind:'git_index' as const,operation_id:id,binding_sha256:row.binding_sha256};
   const reserved=reserveWorkspaceOperation(this.db,source);sealWorkspaceFamily(this.db,source);return reserved;
  });
 }
 releaseUnstartedWorkspace(owner:string,project:string,id:string){
  return withImmediateTransaction(this.db,()=>{
   const row=this.row(owner,project,id);this.admission(row);
   for(const table of ['wb_git_index_producers','wb_git_index_preparations','wb_git_index_dispatches','wb_git_index_outcomes'])
    if(this.db.prepare('SELECT 1 FROM '+table+' WHERE execution_id=?').get(id))throw Error('workspace_reservation_producer_unsettled');
   if(row.protocol!==4||row.binding_sha256!==this.git.executionBinding(owner,project))throw Error('workspace_reservation_source_changed');
   return releaseUnstartedWorkspaceOperation(this.db,{owner_id:owner,project_id:project,operation_kind:'git_index',operation_id:id,binding_sha256:row.binding_sha256});
  });
 }
 /** Trusted inventory only; the caller cannot supply members, roots or grants. */
 observeNativeAdmission(sessionRef:string){
  return withImmediateTransaction(this.db,()=>{assertNativeWorkspaceAdmission(this.db,sessionRef);return{protocol:1 as const,session_ref:sessionRef,execution_authorized:false as const};});
 }
 /** Trusted inventory only; the caller cannot supply members, roots or grants. */
 workspaceFamily(owner:string,project:string,id:string){
  return withImmediateTransaction(this.db,()=>{
   const row=this.row(owner,project,id);this.admission(row);
   this.intents.executionSource(owner,project,row.intent_id,row.review_version,row.review_sha256);
   if(row.protocol!==4||row.binding_sha256!==this.git.executionBinding(owner,project))throw Error('workspace_reservation_source_changed');
   return readReservedWorkspaceFamily(this.db,{owner_id:owner,project_id:project,operation_kind:'git_index',operation_id:id,binding_sha256:row.binding_sha256});
  });
 }
 /** Dispatch the admitted original only. This is not a public route/Worker and
  * must not be automatically scheduled until workspace coordination is ready. */
 async perform(owner:string,project:string,id:string,signal?:AbortSignal){
  if(this.db.isTransaction)throw Error('git_execution_transaction_invalid');signal?.throwIfAborted();const row=this.row(owner,project,id);this.admission(row);
  return this.execute(owner,project,row.intent_id,{request_id:row.request_id,expected_version:row.review_version,review_sha256:row.review_sha256},signal);
 }
 /** Original-host composition only. No browser/native body may supply a host,
  * member list, directory, lease or serializable workspace-custody substitute. */
 async performReserved(owner:string,project:string,id:string,signal?:AbortSignal){
  if(this.db.isTransaction)throw Error('git_execution_transaction_invalid');signal?.throwIfAborted();const row=this.row(owner,project,id);this.admission(row);
  const prior=this.get(owner,project,id);if(prior.state!=='pending')return prior;
  const host=this.nativeWorkspaceHost;if(!host)throw Error('git_native_workspace_host_unavailable');
  this.reserveWorkspace(owner,project,id);const family=this.workspaceFamily(owner,project,id);
  const placementScope={owner_id:owner,project_id:project,operation_kind:'git_index' as const,operation_id:id,binding_sha256:family.binding_sha256},placements=readReservedNativePlacements(this.db,placementScope);
  const checkReservation=()=>{signal?.throwIfAborted();const current=this.workspaceFamily(owner,project,id);if(current.reservation_id!==family.reservation_id||current.family_sha256!==family.family_sha256||readReservedNativePlacements(this.db,placementScope).placements_sha256!==placements.placements_sha256)throw Error('git_native_workspace_source_changed');};
  const result=await host.withReservedFamily({owner_id:owner,project_id:project,execution_id:id},{assertReservation:checkReservation,...(signal?{signal}:{})},async context=>{
   const requireAdmission=()=>{const checked=host.assertAdmission(context) as unknown;if(checked!==undefined){if(checked&&typeof(checked as {then?:unknown}).then==='function')Promise.resolve(checked).catch(()=>{});throw Error('git_native_workspace_host_unavailable');}};
   checkReservation();requireAdmission();const view=host.inspect(context),source=view?.source;
   if(!view||view.execution_authorized!==false||!source||source.execution_authorized!==false
    ||source.reservation_id!==family.reservation_id||source.family_sha256!==family.family_sha256||source.binding_sha256!==family.binding_sha256
    ||source.execution_id!==id||source.owner_id!==owner||source.project_id!==project||!(view.signal instanceof AbortSignal)||!Array.isArray(view.workspaces)
    ||JSON.stringify(view.workspaces.map(member=>member.session_ref))!==JSON.stringify(family.members.map(member=>member.session_ref)))throw Error('git_native_workspace_source_changed');
   const roots=this.git.indexEffects(owner,project).retainReservedNativeWorkspaceRoots(view.workspaces,placements),custody=Object.freeze({});
   const assertCurrent=()=>{checkReservation();requireAdmission();if(host.inspect(context)!==view)throw Error('git_native_workspace_custody_invalid');roots();};
   assertCurrent();this.nativeCustodies.set(custody,{execution_id:id,assertCurrent});
   const ownedSignal=AbortSignal.any([view.signal,...(signal?[signal]:[])]);
   try{return await this.executeOriginal(owner,project,row.intent_id,{request_id:row.request_id,expected_version:row.review_version,review_sha256:row.review_sha256},ownedSignal,custody);}
   finally{this.nativeCustodies.delete(custody);}
  });
  // This path is reached only after original kernel cleanup, producer finish,
  // lease release and the native host's final source check and handle drain.
  // An applied row with a lost/failed callback is deliberately not sufficient.
  if(result.state==='applied')withImmediateTransaction(this.db,()=>{
   checkReservation();const current=this.row(owner,project,id);if(this.get(owner,project,id).state!=='applied'||this.producers.view(current,this.resource(current)).state!=='applied')throw Error('workspace_reservation_producer_unsettled');
   settleWorkspaceOperation(this.db,{owner_id:owner,project_id:project,operation_kind:'git_index',operation_id:id,binding_sha256:family.binding_sha256});
  });
  return result;
 }
 async execute(owner:string,project:string,intent:string,value:Input,signal?:AbortSignal){
  return this.executeOriginal(owner,project,intent,value,signal);
 }
 private async executeOriginal(owner:string,project:string,intent:string,value:Input,signal?:AbortSignal,custody?:object){
  if(this.db.isTransaction)throw Error('git_execution_transaction_invalid');this.projects.assertOwned(project,owner);if(typeof intent!=='string'||!ID.test(intent))throw Error('git_execution_invalid');const input=this.input(value),requestHash=digest({intent_id:intent,...input});
  const prior=this.db.prepare('SELECT * FROM wb_git_index_executions WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Row|undefined;
  if(prior){if(prior.intent_id!==intent||prior.request_sha256!==requestHash)throw Error('idempotency_conflict');const current=this.get(owner,project,prior.execution_id);if(current.state!=='pending')return current;this.producers.assertStartable(this.row(owner,project,prior.execution_id),this.resource(prior));}
  signal?.throwIfAborted();const source=this.intents.executionSource(owner,project,intent,input.expected_version,input.review_sha256);
  const admitted=withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.intents.executionSource(owner,project,intent,input.expected_version,input.review_sha256);
   const row=this.registerExecution(owner,project,intent,input,requestHash,source);this.producers.assertStartable(row,this.resource(row));const lease=this.claim(row,custody);this.authority(row,lease,custody);this.producers.start(row,this.resource(row),lease);return{row,lease};
  });
  const {row,lease}=admitted,abort=new AbortController(),cancel=()=>abort.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const authorize=()=>this.authority(row,lease,custody);
  const timer=setInterval(()=>{try{withImmediateTransaction(this.db,()=>{authorize();this.db.prepare('UPDATE ga_worker_leases SET expires_at=?,updated_at=? WHERE resource_id=? AND owner=? AND generation=?').run(String(this.now()+this.leaseMs),new Date(this.now()).toISOString(),this.resource(row),lease.owner,lease.generation);});}catch(error){abort.abort(error);}},Math.floor(this.leaseMs/3));timer.unref();
  try{
   const kernel=this.git.indexEffects(owner,project),plan=await kernel.prepareIndex(source.witness,source.action,abort.signal);authorize();
   await kernel.applyIndex(plan,{
    authorize,
    prepared:raw=>withImmediateTransaction(this.db,()=>{authorize();const preparation=indexPreparation(raw);this.validateEvidence(row,preparation.evidence);this.db.prepare('INSERT INTO wb_git_index_preparations VALUES(?,?,?,?,?,?)').run(row.execution_id,JSON.stringify(preparation),digest(preparation),lease.owner,lease.generation,new Date(this.now()).toISOString());}),
    acquire:(raw,install)=>withImmediateTransaction(this.db,()=>{authorize();const preparation=this.preparation(row);if(!preparation||JSON.stringify(preparation)!==JSON.stringify(indexPreparation(raw)))throw Error('git_execution_evidence_corrupt');install();}),
    cleanup:remove=>this.cleanupTransaction(row,lease,remove),
    dispatch:raw=>withImmediateTransaction(this.db,()=>{authorize();const evidence=indexEvidence(raw);if(JSON.stringify(this.preparation(row)?.evidence)!==JSON.stringify(evidence))throw Error('git_execution_evidence_corrupt');if(evidence.source_sha256!==row.witness_sha256||evidence.plan.action!==row.action||evidence.plan.repository_sha256!==row.repository_sha256||JSON.stringify(evidence.plan.paths)!==JSON.stringify(source.paths))throw Error('git_execution_evidence_corrupt');this.db.prepare('INSERT INTO wb_git_index_dispatches VALUES(?,?,?,?,?,?)').run(row.execution_id,JSON.stringify(evidence),digest(evidence),lease.owner,lease.generation,new Date(this.now()).toISOString());}),
    commit:(publish,proof)=>withImmediateTransaction(this.db,()=>{authorize();const evidence=this.evidence(row);if(!evidence||evidence.plan.plan_id!==proof.plan_id||evidence.index_lock_identity!==proof.index_lock_identity)throw Error('git_execution_evidence_corrupt');const receipt:GitIndexReceipt=publish();this.outcome(row,evidence);return receipt;})
   },abort.signal);return this.get(owner,project,row.execution_id);
  }finally{
   clearInterval(timer);signal?.removeEventListener('abort',cancel);
   try{withImmediateTransaction(this.db,()=>{this.row(owner,project,row.execution_id);const applied=this.get(owner,project,row.execution_id).state==='applied',state=applied?'applied':this.evidence(row)?'unknown':this.preparation(row)?'prepared':abort.signal.aborted?'cancelled_before_preparation':'failed_before_preparation';this.producers.finish(row,this.resource(row),lease,state);});}
   finally{withImmediateTransaction(this.db,()=>this.release(row,lease));}
  }
 }
 private controlInput(value:ControlInput):ControlInput{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='acknowledge_unknown,expected_state_sha256,request_id'||typeof value.request_id!=='string'||!ID.test(value.request_id)||typeof value.expected_state_sha256!=='string'||!SHA.test(value.expected_state_sha256)||value.acknowledge_unknown!==true)throw Error('git_execution_control_invalid');
  return{request_id:value.request_id,expected_state_sha256:value.expected_state_sha256,acknowledge_unknown:true};
 }
 private stateHash(row:Row){
  this.get(row.owner_id,row.project_id,row.execution_id);
  const record=(table:string)=>this.db.prepare('SELECT * FROM '+table+' WHERE execution_id=?').get(row.execution_id)??null;
  this.producers.record(row);return digest({protocol:1,execution:row,preparation:record('wb_git_index_preparations'),dispatch:record('wb_git_index_dispatches'),outcome:record('wb_git_index_outcomes'),producer:record('wb_git_index_producers'),producer_finish:record('wb_git_index_producer_finishes'),disposition:record('wb_git_index_dispositions')});
 }
 inspect(owner:string,project:string,id:string){const row=this.row(owner,project,id),execution=this.get(owner,project,id);return{execution,state_sha256:this.stateHash(row),requires_unknown_acknowledgement:execution.state==='pending'||execution.state==='unknown',execution_authorized:false as const};}
 private makeControlReceipt(control:Control,result:AppliedResult|ClosedResult,cleanup:Cleanup):ControlReceipt{return{control_id:control.control_id,execution_id:control.execution_id,request_id:control.request_id,state:'completed',result,cleanup,execution_authorized:false};}
 private storeControlReceipt(control:Control,result:AppliedResult|ClosedResult,cleanup:Cleanup){const receipt=this.makeControlReceipt(control,result,cleanup);this.db.prepare('INSERT INTO wb_git_index_control_receipts VALUES(?,?,?,?)').run(control.control_id,JSON.stringify(receipt),digest(receipt),new Date(this.now()).toISOString());return receipt;}
 private savedControlReceipt(row:Row,control:Control):ControlReceipt|undefined{
  if(control.execution_id!==row.execution_id||control.owner_id!==row.owner_id||control.project_id!==row.project_id||control.request_sha256!==digest({execution_id:row.execution_id,request_id:control.request_id,expected_state_sha256:control.expected_state_sha256,acknowledge_unknown:true}))throw Error('git_execution_evidence_corrupt');
  const saved=this.db.prepare('SELECT * FROM wb_git_index_control_receipts WHERE control_id=?').get(control.control_id) as Outcome|undefined;if(!saved)return;
  const value=JSON.parse(saved.receipt_json),result=this.get(row.owner_id,row.project_id,row.execution_id);
  if(result.state==='pending'||result.state==='unknown'||!['verified','unverified','not_recorded','not_attempted'].includes(value.cleanup)||digest(value)!==saved.receipt_sha256||JSON.stringify(value)!==JSON.stringify(this.makeControlReceipt(control,result as AppliedResult|ClosedResult,value.cleanup)))throw Error('git_execution_outcome_corrupt');return value as ControlReceipt;
 }
 getControl(owner:string,project:string,id:string,request:string){
  const row=this.row(owner,project,id);if(typeof request!=='string'||!ID.test(request))throw Error('git_execution_control_invalid');
  const control=this.db.prepare('SELECT * FROM wb_git_index_controls WHERE execution_id=? AND owner_id=? AND project_id=? AND request_id=?').get(id,owner,project,request) as Control|undefined;if(!control)throw Error('git_execution_control_not_found');
  return this.savedControlReceipt(row,control)??{control_id:control.control_id,execution_id:id,request_id:request,state:'pending' as const,execution_authorized:false as const};
 }
 /** Explicit owner disposition only. No public route/tool is mounted. A closed
  * unknown execution is not rolled back or authorized to execute again. */
 async abandon(owner:string,project:string,id:string,value:ControlInput,signal?:AbortSignal):Promise<ControlReceipt>{
  if(this.db.isTransaction)throw Error('git_execution_transaction_invalid');const row=this.row(owner,project,id),input=this.controlInput(value),requestHash=digest({execution_id:id,...input});
  const admitted=withImmediateTransaction(this.db,()=>{
   signal?.throwIfAborted();this.row(owner,project,id);
   let control=this.db.prepare('SELECT * FROM wb_git_index_controls WHERE owner_id=? AND project_id=? AND request_id=?').get(owner,project,input.request_id) as Control|undefined;
   if(control&&(control.execution_id!==id||control.request_sha256!==requestHash))throw Error('idempotency_conflict');
   if(control){const cached=this.savedControlReceipt(row,control);if(cached)return{receipt:cached};}
   const current=this.get(owner,project,id);
   if(control&&current.state!=='pending'&&current.state!=='unknown')return{receipt:this.storeControlReceipt(control,current as AppliedResult|ClosedResult,'not_attempted')};
   if(this.stateHash(row)!==input.expected_state_sha256)throw Error('version_conflict');
   if(current.state!=='pending'&&current.state!=='unknown')throw Error('git_execution_closed');
   if(!control){control={control_id:'git-control-'+randomUUID(),execution_id:id,owner_id:owner,project_id:project,request_id:input.request_id,request_sha256:requestHash,expected_state_sha256:input.expected_state_sha256,created_at:new Date(this.now()).toISOString()};this.db.prepare('INSERT INTO wb_git_index_controls VALUES(?,?,?,?,?,?,?,?)').run(control.control_id,id,owner,project,control.request_id,requestHash,control.expected_state_sha256,control.created_at);}
   return{control,lease:this.claim(row)};
  });
  if(admitted.receipt)return admitted.receipt;
  const {control,lease}=admitted,guard=()=>{signal?.throwIfAborted();this.row(owner,project,id);assertExecutionLease(this.db,this.resource(row),lease,this.now);};
  const abort=new AbortController(),cancel=()=>abort.abort(signal?.reason);signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  const timer=setInterval(()=>{try{withImmediateTransaction(this.db,()=>{guard();this.db.prepare('UPDATE ga_worker_leases SET expires_at=?,updated_at=? WHERE resource_id=? AND owner=? AND generation=?').run(String(this.now()+this.leaseMs),new Date(this.now()).toISOString(),this.resource(row),lease.owner,lease.generation);});}catch(error){abort.abort(error);}},Math.floor(this.leaseMs/3));timer.unref();
  try{
   guard();const evidence=this.evidence(row),preparation=this.preparation(row);let applied=false,cleanup:Cleanup='not_recorded';
   if(evidence||preparation){
    cleanup='unverified';
    try{
     const kernel=this.git.indexEffects(owner,project);
     if(evidence){const observation=await kernel.observeEvidence(evidence,abort.signal);guard();if(observation.state==='applied'){applied=true;withImmediateTransaction(this.db,()=>{guard();if(!this.db.prepare('SELECT 1 FROM wb_git_index_outcomes WHERE execution_id=?').get(id))this.outcome(row,evidence);});}
      await kernel.cleanupEvidence(evidence,guard,abort.signal,remove=>this.cleanupTransaction(row,lease,remove));
     }else await kernel.cleanupPreparation(preparation,guard,abort.signal,remove=>this.cleanupTransaction(row,lease,remove));
     guard();cleanup='verified';
    }catch(error){abort.signal.throwIfAborted();guard();if(applied&&!this.db.prepare('SELECT 1 FROM wb_git_index_outcomes WHERE execution_id=?').get(id))throw error;/* Unknown roots/locks stay untouched. Explicit acknowledgement does not make them owned. */}
   }
   return withImmediateTransaction(this.db,()=>{
    guard();const cached=this.savedControlReceipt(row,control);if(cached)return cached;
    const current=this.get(owner,project,id);
    if(applied||current.state==='applied')return this.storeControlReceipt(control,current as AppliedResult,cleanup);
    if(current.state!=='pending'&&current.state!=='unknown')return this.storeControlReceipt(control,current as ClosedResult,cleanup);
    if(this.stateHash(row)!==input.expected_state_sha256)throw Error('version_conflict');
    const disposition:Disposition={execution_id:id,control_id:control.control_id,kind:row.protocol>=2&&!evidence?'not_dispatched':'abandoned_unknown',snapshot_sha256:input.expected_state_sha256,created_at:new Date(this.now()).toISOString()};
    this.db.prepare('INSERT INTO wb_git_index_dispositions VALUES(?,?,?,?,?)').run(id,control.control_id,disposition.kind,disposition.snapshot_sha256,disposition.created_at);
    return this.storeControlReceipt(control,this.closedResult(row,disposition),cleanup);
   });
  }finally{clearInterval(timer);signal?.removeEventListener('abort',cancel);withImmediateTransaction(this.db,()=>this.release(row,lease));}
 }
 async reconcile(owner:string,project:string,id:string,signal?:AbortSignal){
  if(this.db.isTransaction)throw Error('git_execution_transaction_invalid');const row=this.row(owner,project,id),current=this.get(owner,project,id);if(current.state==='not_dispatched'||current.state==='abandoned_unknown')return current;const evidence=this.evidence(row),preparation=this.preparation(row);if(!evidence&&!preparation)throw Error(row.protocol>=2?'git_execution_not_dispatched':'git_execution_legacy_unknown');
  signal?.throwIfAborted();const lease=withImmediateTransaction(this.db,()=>{this.row(owner,project,id);return this.claim(row);});
  try{
   if(!evidence){await this.git.indexEffects(owner,project).cleanupPreparation(preparation,()=>{this.row(owner,project,id);assertExecutionLease(this.db,this.resource(row),lease,this.now);},signal,remove=>this.cleanupTransaction(row,lease,remove));return{...this.get(owner,project,id),observation:'not_dispatched' as const};}
   const kernel=this.git.indexEffects(owner,project),observed=current.state==='applied'?null:await kernel.observeEvidence(evidence,signal),result=withImmediateTransaction(this.db,()=>{signal?.throwIfAborted();this.row(owner,project,id);assertExecutionLease(this.db,this.resource(row),lease,this.now);if(!observed)return this.get(owner,project,id);if(observed.state!=='applied')return{...this.get(owner,project,id),observation:observed.state,observed_index_sha256:observed.index_sha256};if(this.db.prepare('SELECT 1 FROM wb_git_index_outcomes WHERE execution_id=?').get(id))return this.get(owner,project,id);return this.outcome(row,evidence);});
   if(result.state==='applied')await kernel.cleanupEvidence(evidence,()=>{this.row(owner,project,id);assertExecutionLease(this.db,this.resource(row),lease,this.now);},signal,remove=>this.cleanupTransaction(row,lease,remove));return result;
  }finally{withImmediateTransaction(this.db,()=>this.release(row,lease));}
 }
}
