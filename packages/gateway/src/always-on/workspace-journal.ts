import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {WorkCycles,type WorkCycleScope,type WorkCycleView} from './work-cycles.ts';
import {validateWorkspaceManifest,workspaceManifestHash,workspaceSelection,type SnapshotRecoveryRecord} from './workspace-provider.ts';
type Row=Record<string,any>;
export type WorkspaceSnapshotIntent=Readonly<{cycle_id:string;cycle_version:number;snapshot_id:string;root_binding_sha256:string;selection_sha256:string;execution_authorized:false}>;
export type BeginWorkspaceSnapshot={expected_cycle_version:number;snapshot_id:string;root_binding_sha256:string;selection_sha256:string};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex'),digest=(value:unknown)=>hash(canonicalJson(value));
function fail(code='workspace_journal_corrupt'):never{throw Error(code);}
function exact(value:unknown,keys:string[],code='workspace_journal_invalid'):Row{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail(code);return value as Row;}
function identifier(value:unknown,code='workspace_journal_invalid'):string{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value))fail(code);return value;}
function sha(value:unknown,code='workspace_journal_invalid'):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail(code);return value;}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
/** Host-only private recovery journal, never an API projection or execution
 * grant. Construction does no DDL; the original schema installer owns setup.
 * This store does not copy, probe, delete, repair, or recopy filesystem data. */
export class WorkspaceJournal{
 private readonly db:DatabaseSync;private readonly cycles:WorkCycles;
 constructor(db:DatabaseSync){this.db=db;this.cycles=new WorkCycles(db);}
 private read<T>(operation:()=>T):T{if(this.db.isTransaction)return operation();this.db.exec('BEGIN DEFERRED');try{return operation();}finally{this.db.exec('ROLLBACK');}}
 private load(owner:string,scope:WorkCycleScope,cycle:WorkCycleView):WorkspaceSnapshotIntent|null{
  const row=this.db.prepare('SELECT * FROM wb_discovery_workspace_intents WHERE cycle_id=?').get(cycle.cycle_id) as Row|undefined;if(!row)return null;
  if(row.owner_id!==owner||row.project_id!==scope.project_id||row.workspace_id!==scope.workspace_id||row.agent_id!==scope.agent_id||row.cycle_version!==cycle.version)fail();
  let value:Row;try{value=JSON.parse(row.intent_json);if(hash(row.intent_json)!==row.intent_sha256||canonicalJson(value)!==row.intent_json)fail();exact(value,['cycle_id','cycle_version','snapshot_id','root_binding_sha256','selection_sha256','execution_authorized'],'workspace_journal_corrupt');}catch{fail();}
  if(value!.cycle_id!==cycle.cycle_id||value!.cycle_version!==cycle.version||value!.snapshot_id!==row.snapshot_id||value!.root_binding_sha256!==row.root_binding_sha256||value!.selection_sha256!==row.selection_sha256||value!.execution_authorized!==false)fail();
  identifier(value!.snapshot_id,'workspace_journal_corrupt');sha(value!.root_binding_sha256,'workspace_journal_corrupt');sha(value!.selection_sha256,'workspace_journal_corrupt');return freeze(value!) as WorkspaceSnapshotIntent;
 }
 intent(owner:string,scope:WorkCycleScope,cycleId:string):WorkspaceSnapshotIntent|null{return this.read(()=>this.load(owner,scope,this.cycles.guard(owner,scope,cycleId)));}
 begin(owner:string,scope:WorkCycleScope,cycleId:string,input:BeginWorkspaceSnapshot):WorkspaceSnapshotIntent{
  exact(input,['expected_cycle_version','snapshot_id','root_binding_sha256','selection_sha256']);identifier(input.snapshot_id);sha(input.root_binding_sha256);sha(input.selection_sha256);if(!Number.isSafeInteger(input.expected_cycle_version)||input.expected_cycle_version<1)fail('workspace_journal_invalid');
  return withImmediateTransaction(this.db,()=>{const cycle=this.cycles.guard(owner,scope,cycleId);if(cycle.version!==input.expected_cycle_version)fail('workspace_journal_version_conflict');
   const value:WorkspaceSnapshotIntent={cycle_id:cycleId,cycle_version:cycle.version,snapshot_id:input.snapshot_id,root_binding_sha256:input.root_binding_sha256,selection_sha256:input.selection_sha256,execution_authorized:false},prior=this.load(owner,scope,cycle);
   if(prior){if(canonicalJson(prior)!==canonicalJson(value))fail('workspace_journal_conflict');return prior;}
   if(this.db.prepare('SELECT 1 FROM wb_discovery_workspace_intents WHERE snapshot_id=?').get(input.snapshot_id))fail('workspace_journal_conflict');
   const json=canonicalJson(value);this.db.prepare('INSERT INTO wb_discovery_workspace_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(cycleId,owner,scope.project_id,scope.workspace_id,scope.agent_id,cycle.version,input.snapshot_id,input.root_binding_sha256,input.selection_sha256,json,hash(json),new Date().toISOString());return freeze(value);
  });
 }
 private validate(value:unknown,intent:WorkspaceSnapshotIntent,code:string):SnapshotRecoveryRecord{
  try{const record=exact(value,['protocol','provider','snapshot_id','storage_root','isolated_root','manifest','receipt','selection','limits'],code);
   if(record.protocol!==1||record.provider!=='snapshot-copy'||record.snapshot_id!==intent.snapshot_id)fail(code);
   const manifest=validateWorkspaceManifest(record.manifest);if(digest(workspaceSelection(manifest.paths))!==intent.selection_sha256)fail(code);
   const receipt=record.receipt;if(!receipt||receipt.protocol!==1||receipt.provider!=='snapshot-copy'||receipt.snapshot_id!==intent.snapshot_id||receipt.status!=='ready'||receipt.execution_authorized!==false||receipt.manifest_sha256!==workspaceManifestHash(manifest))fail(code);
   // Roots, selection kinds, limits and live filesystem identities are verified
   // by the provider's single recovery validator, after its fresh host guard.
   const json=canonicalJson(record),parsed=JSON.parse(json);if(canonicalJson(parsed)!==json)fail(code);return freeze(parsed) as SnapshotRecoveryRecord;
  }catch{fail(code);}
 }
 private stored(cycleId:string,intent:WorkspaceSnapshotIntent):SnapshotRecoveryRecord|undefined{
  const row=this.db.prepare('SELECT * FROM wb_discovery_workspace_records WHERE cycle_id=?').get(cycleId) as Row|undefined;if(!row)return undefined;
  try{if(row.snapshot_id!==intent.snapshot_id||hash(row.record_json)!==row.record_sha256)fail();const value=JSON.parse(row.record_json);if(canonicalJson(value)!==row.record_json)fail();return this.validate(value,intent,'workspace_journal_corrupt');}catch{fail();}
 }
 commit(owner:string,scope:WorkCycleScope,cycleId:string,record:SnapshotRecoveryRecord):void{
  withImmediateTransaction(this.db,()=>{const cycle=this.cycles.guard(owner,scope,cycleId),intent=this.load(owner,scope,cycle);if(!intent)fail('workspace_journal_intent_required');
   const value=this.validate(record,intent,'workspace_journal_conflict'),json=canonicalJson(value),prior=this.stored(cycleId,intent);if(prior){if(canonicalJson(prior)!==json)fail('workspace_journal_conflict');return;}
   this.db.prepare('INSERT INTO wb_discovery_workspace_records VALUES(?,?,?,?,?)').run(cycleId,intent.snapshot_id,json,hash(json),new Date().toISOString());
  });
 }
 record(owner:string,scope:WorkCycleScope,cycleId:string,snapshotId:string):SnapshotRecoveryRecord|undefined{return this.read(()=>{
  const cycle=this.cycles.guard(owner,scope,cycleId),intent=this.load(owner,scope,cycle);if(!intent)return undefined;if(snapshotId!==intent.snapshot_id)fail('workspace_journal_conflict');return this.stored(cycleId,intent);
 });}
}
