import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';

type Row=Record<string,any>;
export type DiscoveryHistoryScope={agent_id:string;project_id:string;workspace_id:string};
type Evidence={kind:string;reference:string;hash:string};
export type DiscoveryHistoryReport={report_id:string;sha256:string;outcome:'proposals'|'no_plan'|'blocked';summary:string;limitations:string[];plan_ids:string[];evidence:Evidence[];coverage:{signal_count:number;fully_read:number}};
export type DiscoveryHistoryItem={admission_id:string;occurrence_id:string;task_id:string;signal_revision:number;created_at:string;run:{run_id:string;status:string;business_state:string};report:Omit<DiscoveryHistoryReport,'plan_ids'|'evidence'>&{plan_count:number}|null;accepted:boolean};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function corrupt():never{throw Error('discovery_history_corrupt');}
function identifier(value:unknown,code='discovery_history_not_found'):string{if(typeof value!=='string'||!value||value.length>256||/[\u0000-\u001f\u007f]/.test(value))throw Error(code);return value;}
function object(value:any){if(!value||typeof value!=='object'||Array.isArray(value))corrupt();return value as Row;}
function text(value:any,max=8000){if(typeof value!=='string'||!value.trim()||value.length>max||/\u0000/.test(value))corrupt();return value as string;}
function strings(value:any,max=32){if(!Array.isArray(value)||value.length>max)corrupt();return value.map((v:any)=>text(v));}
function verified(row:Row){let payload;try{payload=JSON.parse(row.payload_json);}catch{corrupt();}if(sha(row.payload_json)!==row.payload_sha256)corrupt();return object(payload);}
function evidence(value:any):Evidence[]{if(!Array.isArray(value)||value.length>100)corrupt();return value.map((item:any)=>{const e=object(item);if(e.kind!=='tool_receipt'||!/^([a-f0-9]{64})$/.test(e.hash))corrupt();return {kind:e.kind,reference:text(e.reference,256),hash:e.hash};});}
function reportView(row:Row):DiscoveryHistoryReport{
 const p=verified(row),coverage=object(p.coverage);
 if(!['proposals','no_plan','blocked'].includes(p.outcome)||!Number.isSafeInteger(coverage.signal_count)||coverage.signal_count<0||!Number.isSafeInteger(coverage.fully_read)||coverage.fully_read<0||coverage.fully_read>coverage.signal_count)corrupt();
 if(!Array.isArray(p.plan_ids)||p.plan_ids.some((id:any)=>typeof id!=='string'||!id||id.length>256)||new Set(p.plan_ids).size!==p.plan_ids.length)corrupt();
 return {report_id:row.report_id,sha256:row.payload_sha256,outcome:p.outcome,summary:text(p.summary),limitations:strings(p.limitations),plan_ids:[...p.plan_ids],evidence:evidence(p.evidence),coverage:{signal_count:coverage.signal_count,fully_read:coverage.fully_read}};
}
function planView(row:Row){
 const p=verified(row);if(!Array.isArray(p.changes)||!p.changes.length||p.changes.length>32)corrupt();
 const changes=p.changes.map((change:any)=>{const c=object(change),path=text(c.path,400);
  if(path.startsWith('/')||/[\\:\u0000-\u001f\u007f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))corrupt();
  const steps=strings(c.steps),verification=strings(c.verification);if(!steps.length||!verification.length)corrupt();
  return {path,description:text(c.description,4000),steps,verification};});
 return {plan_id:row.plan_id,sha256:row.payload_sha256,summary:text(p.summary,4000),rationale:text(p.rationale),changes,evidence:evidence(p.evidence)};
}
/** Read original immutable records only. Historical role versions are evidence,
 * never current authority; no schema setup, defaults, model or Host calls. */
export class DiscoveryHistory{
 private readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;}
 private read<T>(operation:()=>T):T{if(this.db.isTransaction)return operation();this.db.exec('BEGIN DEFERRED');try{return operation();}finally{this.db.exec('ROLLBACK');}}
 private scope(owner:string,scope:DiscoveryHistoryScope){
  identifier(owner);for(const key of ['agent_id','project_id','workspace_id'] as const)identifier(scope?.[key]);
  if(!this.db.prepare(`SELECT 1 FROM wb_agents a JOIN ga_projects p ON p.id=a.project_id AND p.owner_id=a.owner_id
   JOIN ga_conversations c ON c.id=a.conversation_id AND c.owner_id=a.owner_id AND c.project_id=a.project_id AND c.workspace_id=a.workspace_id
   WHERE a.owner_id=? AND a.agent_id=? AND a.project_id=? AND a.workspace_id=?`).get(owner,scope.agent_id,scope.project_id,scope.workspace_id))throw Error('discovery_history_not_found');
 }
 private rows(owner:string,scope:DiscoveryHistoryScope,suffix='',args:(string|number)[]=[]){return this.db.prepare(`SELECT a.*,a.rowid AS sequence,o.run_id,o.root_run_id,o.business_state,b.agent_id,r.status AS run_status
  FROM wb_discovery_admissions a JOIN wb_discovery_policies p ON p.policy_id=a.policy_id AND p.owner_id=a.owner_id
  JOIN wb_discovery_task_bindings b ON b.policy_id=a.policy_id AND b.task_id=a.task_id AND b.owner_id=a.owner_id
   AND b.agent_id=p.agent_id AND b.project_id=p.project_id AND b.workspace_id=p.workspace_id
  JOIN wb_persistent_tasks t ON t.task_id=a.task_id AND t.owner_id=a.owner_id
  JOIN wb_task_current_occurrences o ON o.occurrence_id=a.occurrence_id AND o.task_id=a.task_id
  JOIN ga_runs r ON r.id=o.run_id AND r.conversation_id=o.conversation_id
  JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=a.owner_id AND c.project_id=b.project_id AND c.workspace_id=b.workspace_id
  WHERE a.owner_id=? AND b.agent_id=? AND b.project_id=? AND b.workspace_id=? ${suffix}`).all(owner,scope.agent_id,scope.project_id,scope.workspace_id,...args) as Row[];}
 private recordScope(row:Row,record:Row){
  if(!this.db.prepare(`SELECT 1 FROM wb_task_run_occurrences o JOIN ga_runs r ON r.id=o.run_id AND r.conversation_id=o.conversation_id
   JOIN ga_conversations c ON c.id=r.conversation_id AND c.owner_id=?
   WHERE o.run_id=? AND o.occurrence_id=? AND o.task_id=?`).get(row.owner_id,record.run_id,row.occurrence_id,row.task_id))corrupt();
 }
 private report(row:Row){const stored=this.db.prepare('SELECT * FROM wb_discovery_reports WHERE admission_id=? AND occurrence_id=? ORDER BY rowid DESC LIMIT 1').get(row.admission_id,row.occurrence_id) as Row|undefined;if(!stored)return null;this.recordScope(row,stored);return {stored,view:reportView(stored)};}
 private accepted(owner:string,row:Row,report:ReturnType<DiscoveryHistory['report']>):boolean{
  if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_finalizations'").get())return false;
  const f=this.db.prepare('SELECT * FROM wb_task_finalizations WHERE occurrence_id=? AND owner_id=?').get(row.occurrence_id,owner) as Row|undefined;
  if(!f||f.run_id!==row.run_id)return false;
  if(!report||report.stored.run_id!==row.run_id)corrupt();
  const proof=this.db.prepare(`SELECT c.snapshot_json,c.candidate_json,c.candidate_hash,cert.snapshot_hash,cert.candidate_hash AS certified_candidate_hash,
   n.proof_json,n.proof_hash,i.session_ref,i.before_json,i.checkpoint_json,i.snapshot_hash AS intent_snapshot_hash,i.candidate_hash AS intent_candidate_hash,v.evaluations_json
   FROM wb_task_business_certificates cert JOIN wb_task_business_reviews v ON v.interaction_id=cert.interaction_id AND v.candidate_id=cert.candidate_id AND v.owner_id=? AND v.verdict='accepted'
   JOIN wb_task_completion_candidates c ON c.candidate_id=cert.candidate_id AND c.run_id=cert.run_id AND c.occurrence_id=cert.occurrence_id
   JOIN ga_interactions review ON review.id=v.interaction_id AND review.run_id=cert.run_id AND review.status='answered'
   JOIN wb_task_wait_interactions wait ON wait.interaction_id=review.id AND wait.run_id=cert.run_id AND wait.purpose='task_acceptance_review'
   JOIN wb_task_completion_intents i ON i.intent_id=? AND i.certificate_id=cert.certificate_id AND i.run_id=cert.run_id AND i.occurrence_id=cert.occurrence_id AND i.owner_id=?
   JOIN wb_task_native_completions n ON n.intent_id=i.intent_id
   JOIN ga_messages m ON m.id=? AND m.run_id=cert.run_id AND m.role='assistant' AND m.status='complete'
   JOIN ga_conversations conversation ON conversation.id=m.conversation_id AND conversation.owner_id=?
   WHERE cert.certificate_id=? AND cert.occurrence_id=? AND cert.run_id=?`).get(owner,f.intent_id,owner,f.message_id,owner,f.certificate_id,row.occurrence_id,row.run_id) as Row|undefined;
  if(!proof)corrupt();
  try{
   const snapshot=object(JSON.parse(proof.snapshot_json)),native=object(JSON.parse(proof.proof_json)),before=object(JSON.parse(proof.before_json)),checkpoint=object(JSON.parse(proof.checkpoint_json)),evaluations=JSON.parse(proof.evaluations_json);
   if(sha(proof.snapshot_json)!==proof.snapshot_hash||proof.snapshot_hash!==proof.intent_snapshot_hash||sha(proof.candidate_json)!==proof.candidate_hash
    ||proof.candidate_hash!==proof.certified_candidate_hash||proof.candidate_hash!==proof.intent_candidate_hash||sha(proof.proof_json)!==proof.proof_hash
    ||snapshot.owner_id!==owner||snapshot.occurrence_id!==row.occurrence_id||snapshot.task_id!==row.task_id||snapshot.root_run_id!==row.root_run_id||snapshot.agent_id!==row.agent_id||snapshot.epoch!==row.role_epoch
    ||native.host_status!=='idle'||native.goal?.phase!=='complete'||native.goal?.activation!=='disarmed'
    ||native.goal?.goal_id!==snapshot.goal_id||native.goal?.goal_id!==before.goal?.goal_id||native.goal?.goal_revision!==before.goal?.goal_revision+1
    ||before.host_status!=='idle'||before.goal?.activation!=='disarmed'||!['paused','blocked'].includes(before.goal?.phase)
    ||before.goal?.goal_revision!==snapshot.goal_revision||checkpoint.goal_id!==snapshot.goal_id||checkpoint.goal_revision!==snapshot.goal_revision
    ||!Number.isSafeInteger(native.goal?.goal_revision)||!Number.isSafeInteger(native.goal?.rounds_started)||native.goal.rounds_started<0
    ||!Number.isSafeInteger(native.goal?.max_goal_rounds)||native.goal.max_goal_rounds<1||native.goal.rounds_started>native.goal.max_goal_rounds
    ||native.goal.rounds_started!==before.goal?.rounds_started||native.goal.max_goal_rounds!==before.goal?.max_goal_rounds
    ||native.checkpoint?.session_ref!==proof.session_ref||checkpoint.session_ref!==proof.session_ref||native.checkpoint?.goal_id!==native.goal?.goal_id
    ||!Number.isSafeInteger(native.checkpoint?.seq_exclusive)||!Number.isSafeInteger(native.checkpoint?.turn_end_seq)||native.checkpoint.turn_end_seq<0||native.checkpoint.turn_end_seq>=native.checkpoint.seq_exclusive
    ||typeof native.checkpoint?.log_sha256!=='string'||!/^[a-f0-9]{64}$/.test(native.checkpoint.log_sha256)
    ||native.checkpoint?.goal_revision!==native.goal?.goal_revision||native.checkpoint?.turn_end_seq!==checkpoint.turn_end_seq||native.checkpoint?.seq_exclusive<=checkpoint.seq_exclusive
    ||canonicalJson(snapshot.discovery_report)!==canonicalJson(report!.view))corrupt();
   if(!Array.isArray(snapshot.steps)||!Array.isArray(evaluations)||evaluations.length!==snapshot.steps.length)corrupt();
   for(const [index,step] of snapshot.steps.entries()){const judgment=object(evaluations[index]);if(judgment.subtask_id!==step.subtask_id||judgment.subtask_version!==step.version||judgment.acceptance!==step.acceptance||canonicalJson(judgment.evidence)!==canonicalJson(step.evidence)||judgment.method!=='owner_confirmation'||judgment.verdict!=='accepted')corrupt();}
  }catch{corrupt();}
  return true;
 }
 private item(owner:string,row:Row){const report=this.report(row);const summary=report?{report_id:report.view.report_id,sha256:report.view.sha256,outcome:report.view.outcome,summary:report.view.summary,limitations:report.view.limitations,coverage:report.view.coverage,plan_count:report.view.plan_ids.length}:null;
  return {admission_id:row.admission_id,occurrence_id:row.occurrence_id,task_id:row.task_id,signal_revision:row.signal_revision,created_at:row.created_at,run:{run_id:row.run_id,status:row.run_status,business_state:row.business_state},report:summary,accepted:this.accepted(owner,row,report)} satisfies DiscoveryHistoryItem;}
 list(owner:string,scope:DiscoveryHistoryScope,beforeId?:string){return this.read(()=>{
  this.scope(owner,scope);let sequence=Number.MAX_SAFE_INTEGER;
  if(beforeId!==undefined){identifier(beforeId,'invalid_discovery_history_cursor');const boundary=this.rows(owner,scope,'AND a.admission_id=?',[beforeId])[0];if(!boundary)throw Error('invalid_discovery_history_cursor');sequence=boundary.sequence;}
  const rows=this.rows(owner,scope,'AND a.rowid<? ORDER BY a.rowid DESC LIMIT 21',[sequence]);
  const page=rows.slice(0,20);return {items:page.map(row=>this.item(owner,row)),next_before_id:rows.length>20?page.at(-1)!.admission_id:null,execution_authorized:false as const};
 });}
 detail(owner:string,scope:DiscoveryHistoryScope,admissionId:string,afterPlanId?:string){return this.read(()=>{
  this.scope(owner,scope);identifier(admissionId);const row=this.rows(owner,scope,'AND a.admission_id=?',[admissionId])[0];if(!row)throw Error('discovery_history_not_found');
  if(afterPlanId!==undefined){identifier(afterPlanId,'invalid_discovery_history_cursor');const boundary=this.db.prepare('SELECT run_id FROM wb_discovery_plans WHERE admission_id=? AND occurrence_id=? AND plan_id=?').get(row.admission_id,row.occurrence_id,afterPlanId) as Row|undefined;if(!boundary)throw Error('invalid_discovery_history_cursor');this.recordScope(row,boundary);}
  const plans=this.db.prepare('SELECT * FROM wb_discovery_plans WHERE admission_id=? AND occurrence_id=? AND plan_id>? ORDER BY plan_id LIMIT 21').all(row.admission_id,row.occurrence_id,afterPlanId??'') as Row[];
  const page=plans.slice(0,20);return {cycle:this.item(owner,row),plans:page.map(plan=>{this.recordScope(row,plan);return planView(plan);}),report:this.report(row)?.view??null,next_after_plan_id:plans.length>20?page.at(-1)!.plan_id:null,execution_authorized:false as const};
 });}
}
