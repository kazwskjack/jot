import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {WorkAdmissionRecords,freezeWorkAdmission} from './work-admission-records.ts';
import {WorkGrants} from './work-grants.ts';
import {validateWorkspaceRecoveryRecord} from './snapshot-provider.ts';

type Row=Record<string,any>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
function requireFact(value:unknown):asserts value{if(!value)throw Error('work_snapshot_history_unavailable');}
function original(value:string):Row{const parsed=JSON.parse(value);requireFact(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&canonicalJson(parsed)===value);return parsed;}

/** HOST-PRIVATE original immutable snapshot facts. This historical read neither
 * renews work authority nor certifies a current physical root, completed output,
 * native Session association, quiescence or permission to apply files. It does
 * no filesystem IO, schema installation, lease acquisition or snapshot repair.
 * Live WorkspaceJournal guards deliberately remain separate and unchanged. */
export function readHistoricalWorkSnapshot(db:DatabaseSync,owner:string,runId:string){
 if(typeof owner!=='string'||!ID.test(owner)||typeof runId!=='string'||!ID.test(runId))throw Error('work_snapshot_history_not_found');
 const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
 try{
  const admission=new WorkAdmissionRecords(db).byRun(owner,runId);if(!admission)throw Error('work_snapshot_history_not_found');
  const grant=new WorkGrants(db).get(owner,admission.scope,admission.grant_id);
  const saved=db.prepare('SELECT * FROM wb_discovery_workspace_records WHERE cycle_id=? AND snapshot_id=?').get(admission.cycle_id,admission.snapshot_id) as Row|undefined;
  const intent=db.prepare('SELECT * FROM wb_discovery_workspace_intents WHERE cycle_id=? AND snapshot_id=?').get(admission.cycle_id,admission.snapshot_id) as Row|undefined;
  requireFact(saved&&intent&&intent.owner_id===owner&&intent.project_id===admission.scope.project_id&&intent.workspace_id===admission.scope.workspace_id&&intent.agent_id===admission.scope.agent_id
   &&intent.cycle_version===grant.cycle_version&&intent.root_binding_sha256===grant.root_binding_sha256&&intent.selection_sha256===grant.selection_sha256);
  const originalIntent=original(intent.intent_json),originalRecord=original(saved.record_json);
  requireFact(hash(originalIntent)===intent.intent_sha256&&hash(originalRecord)===saved.record_sha256&&saved.record_sha256===grant.snapshot_record_sha256
   &&canonicalJson(originalIntent)===canonicalJson({cycle_id:admission.cycle_id,cycle_version:grant.cycle_version,snapshot_id:admission.snapshot_id,root_binding_sha256:grant.root_binding_sha256,selection_sha256:grant.selection_sha256,execution_authorized:false}));
  const record=validateWorkspaceRecoveryRecord(originalRecord,admission.snapshot_id);requireFact(canonicalJson(record)===saved.record_json);
  return freezeWorkAdmission({protocol:1 as const,owner_id:owner,project_id:admission.scope.project_id,workspace_id:admission.scope.workspace_id,run_id:runId,
   admission,grant,intent:originalIntent,record,record_sha256:saved.record_sha256 as string,execution_authorized:false as const});
 }catch(error){
  if(error instanceof Error&&error.message==='work_snapshot_history_not_found')throw error;
  throw Error('work_snapshot_history_unavailable',{cause:error});
 }finally{if(!outer&&db.isTransaction)db.exec('ROLLBACK');}
}
