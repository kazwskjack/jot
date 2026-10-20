import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {freezeWorkAdmission} from '../always-on/work-admission-records.ts';
import {readHistoricalWorkSnapshot} from '../always-on/work-snapshot-history.ts';
import {normalizeExecutionLease} from '../workbench/execution-lease.ts';
import {readReservedWorkspaceFamily,type WorkspaceOperationSource} from '../workbench/workspace-coordination.ts';

type Row=Record<string,any>;
type History=ReturnType<typeof readHistoricalWorkSnapshot>;
type Placement=Pick<History['record'],'snapshot_id'|'storage_root'|'isolated_root'>&{record_sha256:string};
const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytesHash=(value:string)=>createHash('sha256').update(value).digest('hex');
function valid(value:unknown):asserts value{if(!value)throw Error('work_publication_native_placements_unavailable');}
const exists=(db:DatabaseSync,name:string)=>!!db.prepare("SELECT 1 FROM sqlite_schema WHERE name=? AND type IN('table','view')").get(name);

/** HOST-PRIVATE original family association, not a root allowlist or authority.
 * Exact native references identify original work admissions. In particular, a
 * chat Session does not inherit isolated cwd merely by sharing a conversation.
 * Closed/failed records remain historical; live guards and physical/native
 * custody are checked separately by the original foreground coordinator. */
export function readReservedPublicationPlacements(db:DatabaseSync,scope:WorkspaceOperationSource){
 valid(scope.operation_kind==='work_publication');return readReservedNativePlacements(db,scope);
}

/** The same original sealed family history for index operations. Neither read
 * authorizes source publication, source copying or execution. */
export function readReservedNativePlacements(db:DatabaseSync,scope:WorkspaceOperationSource){
 const outer=db.isTransaction;if(!outer)db.exec('BEGIN DEFERRED');
 try{
  valid(scope.operation_kind==='work_publication'||scope.operation_kind==='git_index');const family=readReservedWorkspaceFamily(db,scope),cache=new Map<string,History|null>();
  const history=(runId:string):History|null=>{
   if(cache.has(runId))return cache.get(runId)!;valid(cache.size<10000);
   let value:History|null;try{value=readHistoricalWorkSnapshot(db,scope.owner_id,runId)}catch(error){
    if(!(error instanceof Error)||error.message!=='work_snapshot_history_not_found')throw error;
    valid(!db.prepare("SELECT 1 FROM wb_task_run_occurrences WHERE run_id=? AND trigger_key LIKE 'discovery-work:%'").get(runId));value=null;
   }
   if(value)valid(value.owner_id===scope.owner_id&&value.project_id===scope.project_id);cache.set(runId,value);return value;
  };
  const members=family.members.map(member=>{
   const candidates=new Map<string,Placement>(),evidence=new Set<string>();
   const add=(runId:string,workspace?:string)=>{
    const source=history(runId);if(!source)return;
    if(workspace!==undefined)valid(source.workspace_id===workspace);
    const placement={snapshot_id:source.record.snapshot_id,storage_root:source.record.storage_root,isolated_root:source.record.isolated_root,record_sha256:source.record_sha256};
    candidates.set(canonicalJson(placement),placement);valid(candidates.size===1);
    evidence.add(hash({admission:source.admission,grant:source.grant,record_sha256:source.record_sha256}));
   };
   for(const bound of member.scopes){
    const rows=db.prepare(`SELECT DISTINCT r.id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
     WHERE c.id=? AND c.owner_id=? AND c.project_id=? AND c.workspace_id=? AND (
      r.native_session_ref=? OR EXISTS(SELECT 1 FROM ga_runtime_bindings b WHERE b.run_id=r.id AND b.harness_session_ref=?)
      OR EXISTS(SELECT 1 FROM ga_session_checkpoints b WHERE b.run_id=r.id AND b.conversation_id=c.id AND b.session_ref=?)
      OR EXISTS(SELECT 1 FROM ga_conversation_goal_controls b WHERE b.run_id=r.id AND b.owner_id=c.owner_id AND b.session_id=?)
      OR EXISTS(SELECT 1 FROM ga_harness_session_bindings b WHERE b.conversation_id=c.id AND b.owner_id=c.owner_id AND b.session_id=?)
      OR EXISTS(SELECT 1 FROM ga_conversation_mode_sessions b WHERE b.conversation_id=c.id AND b.owner_id=c.owner_id AND b.mode='work' AND b.session_id=?)) LIMIT 10001`)
     .all(bound.conversation_id,scope.owner_id,scope.project_id,bound.workspace_id,...Array(6).fill(member.session_ref)) as Row[];
    valid(rows.length<=10000);for(const row of rows)add(row.id,bound.workspace_id);
   }
   if(exists(db,'wb_native_child_reservations')){
    const children=db.prepare(`SELECT * FROM wb_native_child_reservations WHERE child_session_ref=? OR CASE WHEN json_valid(snapshot_json) THEN json_extract(snapshot_json,'$.parent_session_ref') END=? LIMIT 10001`).all(member.session_ref,member.session_ref) as Row[];
    valid(children.length<=10000);
    for(const row of children){
     const saved=JSON.parse(row.snapshot_json),lease=normalizeExecutionLease(saved.execution_lease);
     valid(saved&&saved.execution_authorized===false&&saved.owner_id===scope.owner_id&&row.owner_id===scope.owner_id&&saved.project_id===scope.project_id
      &&saved.reservation_id===row.reservation_id&&saved.root_run_id===row.root_run_id&&saved.task_id===row.task_id&&saved.occurrence_id===row.occurrence_id
      &&saved.child_session_ref===row.child_session_ref&&member.scopes.some(bound=>bound.workspace_id===saved.workspace_id));
     valid(bytesHash(JSON.stringify([row.root_run_id,saved.parent_session_ref,row.child_session_ref,saved.role_id,saved.policy_version,lease,...(saved.spawn_request_hash===undefined?[]:[saved.spawn_request_hash])]))===row.input_hash);
     const root=history(row.root_run_id);if(root)valid(root.admission.task_id===row.task_id&&root.admission.occurrence_id===row.occurrence_id&&root.workspace_id===saved.workspace_id);
     add(row.root_run_id,saved.workspace_id);evidence.add(hash({reservation_id:row.reservation_id,input_hash:row.input_hash,snapshot:saved}));
     if(exists(db,'wb_native_child_activations')){
      const activations=db.prepare('SELECT * FROM wb_native_child_activations WHERE reservation_id=? ORDER BY created_at,run_id LIMIT 10001').all(row.reservation_id) as Row[];valid(activations.length<=10000);
      for(const activation of activations){
       const snapshot=JSON.parse(activation.snapshot_json),previous=db.prepare('SELECT * FROM wb_native_execution_runs WHERE run_id=?').get(activation.previous_run_id) as Row|undefined;
       const closure=db.prepare('SELECT * FROM wb_native_execution_closures WHERE run_id=?').get(activation.previous_run_id) as Row|undefined;
       valid(previous&&closure&&previous.reservation_id===row.reservation_id&&previous.owner_id===scope.owner_id&&previous.child_session_ref===row.child_session_ref
        &&bytesHash(closure.receipt_json)===closure.receipt_sha256);
       const proof=JSON.parse(closure.receipt_json),prior=JSON.parse(previous.snapshot_json);
       const {root_run_id,execution_lease,root_budget_scope_ids,previous_run_id,source_log_sha256,source_seq_exclusive,...base}=snapshot;
       const {root_run_id:_root,execution_lease:_lease,root_budget_scope_ids:_budget,previous_run_id:_previous,source_log_sha256:_log,source_seq_exclusive:_seq,...priorBase}=prior;
       valid(canonicalJson(base)===canonicalJson(priorBase)&&activation.owner_id===scope.owner_id&&activation.child_session_ref===row.child_session_ref
        &&activation.task_id===row.task_id&&activation.occurrence_id===row.occurrence_id&&activation.role_id===saved.role_id&&activation.root_run_id===root_run_id
        &&previous_run_id===activation.previous_run_id&&source_log_sha256===proof.log_sha256&&source_seq_exclusive===proof.seq_exclusive
        &&proof.session_ref===row.child_session_ref&&proof.parent_session_ref===saved.parent_session_ref);
       normalizeExecutionLease(execution_lease);const activeRoot=history(root_run_id);
       if(activeRoot)valid(activeRoot.admission.task_id===row.task_id&&activeRoot.admission.occurrence_id===row.occurrence_id);
       add(root_run_id,saved.workspace_id);evidence.add(hash({run_id:activation.run_id,previous_run_id:activation.previous_run_id,snapshot}));
      }
     }
    }
   }
   return{session_ref:member.session_ref,placement:candidates.values().next().value??null,evidence_sha256:hash([...evidence].sort())};
  });
  const result={protocol:1 as const,owner_id:scope.owner_id,project_id:scope.project_id,binding_sha256:family.binding_sha256,family_sha256:family.family_sha256,members,execution_authorized:false as const};
  return freezeWorkAdmission({...result,placements_sha256:hash(result)});
 }finally{if(!outer&&db.isTransaction)db.exec('ROLLBACK');}
}
export type PublicationNativePlacements=ReturnType<typeof readReservedPublicationPlacements>;
