import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
type Row=Record<string,any>;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const tables=['wb_task_finalizations','wb_task_business_certificates','wb_task_business_reviews','wb_task_completion_candidates','wb_task_completion_intents','wb_task_native_completions'];
const has=(db:DatabaseSync,table:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);

/** Existing canonical publication is required, not a runtime/status projection.
 * No mutation, reconciliation, new task state or execution grant is introduced. */
export function discoveryPredecessorsAccepted(db:DatabaseSync,owner:string,taskId:string):boolean{
 const read=()=>{
  if(!db.prepare('SELECT 1 FROM wb_persistent_tasks WHERE task_id=? AND owner_id=?').get(taskId,owner))return false;
  if(!db.prepare('SELECT 1 FROM wb_task_occurrences WHERE task_id=? LIMIT 1').get(taskId))return true;
  if(!has(db,'wb_task_finalizations'))return false;
  return !db.prepare(`SELECT 1 FROM wb_task_current_occurrences o LEFT JOIN wb_task_finalizations f
   ON f.occurrence_id=o.occurrence_id AND f.run_id=o.run_id AND f.owner_id=?
   WHERE o.task_id=? AND (o.business_state<>'completed' OR f.occurrence_id IS NULL) LIMIT 1`).get(owner,taskId);
 };
 if(db.isTransaction)return read();db.exec('BEGIN DEFERRED');try{return read();}finally{db.exec('ROLLBACK');}
}

/** Dormancy is derived from the original owner certificate, native completion,
 * frozen report and committed assistant message. A report or review alone is
 * never accepted dormancy. Reads do not load an Agent or renew authority. */
export function observeDiscoveryDormancy(db:DatabaseSync,owner:string,policyId:string){
 const answer=(state:'none'|'accepted'|'unknown',revision:number|null=null)=>Object.freeze({protocol:1 as const,state,revision,execution_authorized:false as const});
 const read=()=>{
  if(tables.some(table=>!has(db,table)))return answer('none');
  const row=db.prepare(`SELECT a.signal_revision,r.report_id,r.payload_json,r.payload_sha256,
   c.snapshot_json,c.candidate_json,c.candidate_hash,cert.snapshot_hash,cert.candidate_hash AS certified_candidate_hash,
   n.proof_json,n.proof_hash,i.session_ref
   FROM wb_discovery_admissions a JOIN wb_discovery_policies p ON p.policy_id=a.policy_id AND p.owner_id=a.owner_id
   JOIN wb_agents role ON role.agent_id=p.agent_id AND role.owner_id=p.owner_id
    AND role.version=a.role_version AND role.capability_epoch=a.role_epoch AND role.status='active'
   JOIN wb_task_finalizations f ON f.occurrence_id=a.occurrence_id AND f.owner_id=a.owner_id
   JOIN wb_discovery_reports r ON r.occurrence_id=a.occurrence_id AND r.run_id=f.run_id
   JOIN wb_task_business_certificates cert ON cert.certificate_id=f.certificate_id AND cert.occurrence_id=a.occurrence_id AND cert.run_id=f.run_id
   JOIN wb_task_business_reviews v ON v.interaction_id=cert.interaction_id AND v.candidate_id=cert.candidate_id AND v.owner_id=a.owner_id AND v.verdict='accepted'
   JOIN wb_task_completion_candidates c ON c.candidate_id=cert.candidate_id AND c.run_id=f.run_id AND c.occurrence_id=a.occurrence_id
   JOIN wb_task_completion_intents i ON i.intent_id=f.intent_id AND i.certificate_id=cert.certificate_id AND i.run_id=f.run_id AND i.owner_id=a.owner_id
   JOIN wb_task_native_completions n ON n.intent_id=i.intent_id
   JOIN ga_messages m ON m.id=f.message_id AND m.run_id=f.run_id AND m.role='assistant' AND m.status='complete'
   JOIN ga_conversations conversation ON conversation.id=m.conversation_id AND conversation.owner_id=a.owner_id
   WHERE a.owner_id=? AND a.policy_id=? AND json_extract(r.payload_json,'$.outcome')='no_plan'
   ORDER BY a.rowid DESC,r.rowid DESC LIMIT 1`).get(owner,policyId) as Row|undefined;
  if(!row)return answer('none');
  const report=JSON.parse(row.payload_json),snapshot=JSON.parse(row.snapshot_json),native=JSON.parse(row.proof_json),coverage=report.coverage;
  if(!Number.isSafeInteger(row.signal_revision)||row.signal_revision<0
    ||sha(row.payload_json)!==row.payload_sha256||sha(row.snapshot_json)!==row.snapshot_hash
    ||sha(row.candidate_json)!==row.candidate_hash||row.candidate_hash!==row.certified_candidate_hash
    ||sha(row.proof_json)!==row.proof_hash||native.host_status!=='idle'||native.goal?.phase!=='complete'||native.goal?.activation!=='disarmed'
    ||native.goal?.goal_id!==snapshot.goal_id||native.checkpoint?.session_ref!==row.session_ref
    ||!coverage||!Number.isSafeInteger(coverage.signal_count)||coverage.signal_count<0||coverage.fully_read!==coverage.signal_count
    ||canonicalJson(snapshot.discovery_report)!==canonicalJson({report_id:row.report_id,sha256:row.payload_sha256,...report}))return answer('unknown');
  return answer('accepted',Number(row.signal_revision));
 };
 const guarded=()=>{try{return read();}catch{return answer('unknown');}};
 if(db.isTransaction)return guarded();db.exec('BEGIN DEFERRED');try{return guarded();}finally{db.exec('ROLLBACK');}
}
