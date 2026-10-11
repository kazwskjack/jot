import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {EventStore} from '../events/event-store.ts';
import type {RunCommandService} from '../runs/commands.ts';
import type {WorkbenchService} from '../workbench/service.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {currentTaskCompletionCandidate} from './completion-candidates.ts';
import {recordTaskBusinessReview} from './business-review.ts';

/** Called only inside the Coordinator's confirmed stop/checkpoint transaction. */
export function requestTaskWaitInteraction(db:DatabaseSync,events:EventStore,runId:string):void {
  if(!db.isTransaction)throw new Error('task_wait_state_conflict');
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='wb_task_goal_proposals' AND type='table'").get())return;
  if(db.prepare('SELECT 1 FROM wb_task_wait_interactions WHERE run_id=?').get(runId))return;
  const proposal=db.prepare('SELECT * FROM wb_task_goal_proposals WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runId) as Record<string,unknown>|undefined;
  if(!proposal||!['wait_user','wait_approval','complete'].includes(String(proposal.intent)))return;
  const row=db.prepare(`SELECT r.*,o.occurrence_id FROM ga_runs r JOIN wb_task_current_occurrences o ON o.run_id=r.id
    JOIN ga_session_checkpoints cp ON cp.checkpoint_id=r.checkpoint_id AND cp.run_id=r.id
    JOIN wb_native_goal_bindings g ON g.run_id=o.root_run_id AND g.occurrence_id=o.occurrence_id AND g.goal_id=cp.goal_id AND g.goal_revision=cp.goal_revision
    WHERE r.id=? AND r.status IN ('waiting_user','waiting_approval')`).get(runId) as Record<string,unknown>|undefined;
  if(!row||row.occurrence_id!==proposal.occurrence_id)throw new Error('task_wait_state_conflict');
  const hasCandidate=proposal.intent==='complete'&&!!db.prepare('SELECT 1 FROM wb_task_completion_candidates WHERE run_id=?').get(runId);
  const owner=String((db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(String(row.conversation_id)) as {owner_id:string}).owner_id);
  const frozen=hasCandidate?currentTaskCompletionCandidate(db,owner,runId):undefined;
  const purpose=frozen?'task_acceptance_review':proposal.intent==='wait_user'?'task_input':proposal.intent==='complete'?'task_completion_review':'task_review';
  if((purpose==='task_input')!==(row.status==='waiting_user'))throw new Error('task_wait_state_conflict');
  const now=new Date().toISOString(),expires=new Date(Date.now()+7*86400000).toISOString();
  const id=`int-${randomUUID()}`,kind=purpose==='task_input'||frozen?'question':'approval';
  const digest=kind==='approval'?`sha256:${createHash('sha256').update(JSON.stringify([id,runId,row.checkpoint_id,row.version,proposal.proposal_id,purpose])).digest('hex')}`:null;
  const base={interaction_id:id,run_id:runId,tool_call_id:`task-wait-${randomUUID()}`,version:1,status:'pending',created_at:now,expires_at:expires,kind,purpose};
  const outputLines=frozen?[...(frozen.snapshot.file_outputs??[]).map(file=>file.verified?`${file.path} · v${file.version} · SHA256 ${file.sha256}`:`${file.path} · 未绑定任务文件版本`),
    ...(frozen.snapshot.artifact_outputs??[]).flatMap(group=>group.verified?group.parts!.map(part=>`${part.display_name} · v${group.version} · SHA256 ${part.sha256}`):[`${group.reference} · 未绑定任务产物版本`])]:[];
  const description=frozen?frozen.candidate.text+(outputLines.length?`\n\n文件版本（审核通过并确认任务完成后交付）：\n${outputLines.join('\n')}`:''):undefined;
  const request=kind==='question'?{...base,questions:frozen?frozen.snapshot.steps.map((step,index)=>({question_id:step.subtask_id,prompt:step.acceptance,
    ...(index===0?{description}:{}),options:[{option_id:'accept',label:'符合要求'},{option_id:'reject',label:'不符合要求'}],multiple:false,allow_custom:true})):[{question_id:'task-input',prompt:String(proposal.summary),options:[],multiple:false,allow_custom:true}]}
    :{...base,action_digest:digest,action_summary:`${String(proposal.summary)}\n确认后仅在原任务权限和累计预算内继续核验，不代表业务验收完成。`,risk:'low'};
  db.prepare('INSERT INTO ga_interactions(id,conversation_id,run_id,kind,status,version,action_digest,request_json,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id,String(row.conversation_id),runId,kind,'pending',1,digest,JSON.stringify(request),expires,now);
  db.prepare('INSERT INTO wb_task_wait_interactions VALUES(?,?,?,?,?,?,?)').run(id,runId,String(proposal.proposal_id),String(row.checkpoint_id),Number(row.version),purpose,now);
  events.append(String(row.conversation_id),runId,'interaction.requested',request);
}

/** Does not create another command loop or certify business completion. */
export class TaskWaitResponder {
  private db:DatabaseSync;
  private workbench:WorkbenchService;
  private commands:RunCommandService;
  constructor(db:DatabaseSync,workbench:WorkbenchService,commands:RunCommandService){this.db=db;this.workbench=workbench;this.commands=commands;}

  recordReceipt(row:Record<string,unknown>,input:unknown,key:string,operation:string,receipt:Record<string,unknown>):void {
    if(!this.db.isTransaction)throw new Error('task_wait_receipt_state_conflict');
    if(receipt.interaction_id!==row.id||receipt.run_id!==row.run_id||receipt.accepted!==true
      ||!['answered','denied'].includes(String(receipt.status))||!Number.isSafeInteger(receipt.version)
      ||!['interaction_response','interaction_decision'].includes(operation)||!/^[\x21-\x7E]{8,128}$/.test(key))throw new Error('task_wait_receipt_state_conflict');
    this.db.prepare('INSERT INTO wb_task_wait_receipts VALUES(?,?,?,?,?,?)').run(String(row.id),operation,key,
      createHash('sha256').update(canonicalJson(input)).digest('hex'),JSON.stringify(receipt),new Date().toISOString());
  }

  /** Reads a committed result only; never performs admission, resume or tools. */
  recoverReceipt(owner:string,id:string,operation:string,key:string,requestHash:string):Record<string,unknown>|undefined {
    const proof=this.db.prepare(`SELECT p.receipt_json,i.run_id,i.status,i.version,i.kind,w.checkpoint_id,w.purpose
      FROM wb_task_wait_receipts p JOIN wb_task_wait_interactions w ON w.interaction_id=p.interaction_id
      JOIN ga_interactions i ON i.id=w.interaction_id AND i.run_id=w.run_id
      JOIN ga_conversations c ON c.id=i.conversation_id
      WHERE p.interaction_id=? AND c.owner_id=? AND p.operation=? AND p.idempotency_key=? AND p.request_sha256=?`)
      .get(id,owner,operation,key,requestHash) as Record<string,unknown>|undefined;
    if(!proof)return;
    const receipt=JSON.parse(String(proof.receipt_json)) as Record<string,unknown>;
    if(Object.keys(receipt).sort().join(',')!=='accepted,interaction_id,run_id,status,version'
      ||receipt.accepted!==true||receipt.interaction_id!==id||receipt.run_id!==proof.run_id
      ||receipt.status!==proof.status||receipt.version!==proof.version||!Number.isSafeInteger(receipt.version)
      ||!['answered','denied'].includes(String(receipt.status))
      ||(operation==='interaction_response')!==(proof.kind==='question'))throw new Error('task_wait_receipt_state_conflict');
    if(receipt.status==='answered'&&proof.purpose==='task_acceptance_review'){
      const review=this.db.prepare(`SELECT v.verdict,c.certificate_id FROM wb_task_business_reviews v
        JOIN wb_task_completion_candidates f ON f.candidate_id=v.candidate_id AND f.run_id=?
        LEFT JOIN wb_task_business_certificates c ON c.interaction_id=v.interaction_id WHERE v.interaction_id=?`).get(String(proof.run_id),id) as {verdict:string;certificate_id:string|null}|undefined;
      if(!review||(review.verdict==='accepted'&&!review.certificate_id)||(review.verdict==='rejected'&&review.certificate_id))throw new Error('task_wait_receipt_state_conflict');
    }else if(receipt.status==='answered'&&!this.db.prepare(`SELECT 1 FROM wb_task_wait_responses s JOIN ga_runs r ON r.id=s.new_run_id
      WHERE s.interaction_id=? AND r.continuation_of=? AND r.checkpoint_id=?`).get(id,String(proof.run_id),String(proof.checkpoint_id)))throw new Error('task_wait_receipt_state_conflict');
    if(receipt.status==='denied'&&proof.kind!=='approval')throw new Error('task_wait_receipt_state_conflict');
    return receipt;
  }

  resolve(row:Record<string,unknown>,owner:string,status:string,input:Record<string,unknown>,key:string):boolean {
    const binding=this.db.prepare('SELECT * FROM wb_task_wait_interactions WHERE interaction_id=?').get(String(row.id)) as Record<string,unknown>|undefined;
    if(!binding)return false;
    if(!this.db.isTransaction)throw new Error('task_wait_state_conflict');
    const run=this.db.prepare(`SELECT r.*,c.owner_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id
      JOIN wb_task_current_occurrences o ON o.run_id=r.id WHERE r.id=?`).get(String(binding.run_id)) as Record<string,unknown>|undefined;
    if(!run||run.owner_id!==owner||run.id!==row.run_id||run.checkpoint_id!==binding.checkpoint_id
      ||run.version!==binding.expected_run_version||run.status!==(binding.purpose==='task_input'?'waiting_user':'waiting_approval'))throw new Error('task_wait_state_conflict');
    this.workbench.assertRunActive(String(run.id));
    const context=this.workbench.contextForRun(String(run.id));if(context?.kind!=='task')throw new Error('task_wait_state_conflict');
    if(this.db.prepare(`SELECT 1 FROM wb_model_budget_attempts a JOIN wb_task_run_occurrences o ON o.run_id=a.run_id
      WHERE o.occurrence_id=(SELECT occurrence_id FROM wb_task_current_occurrences WHERE run_id=?) AND (a.state IN ('unknown','in_flight') OR a.bound_exceeded=1) LIMIT 1`).get(String(run.id)))throw new Error('budget_usage_unknown');
    if(binding.purpose==='task_acceptance_review'){
      recordTaskBusinessReview(this.db,owner,String(row.id),String(run.id),input.answers);
      return true;
    }
    let supplement:Record<string,unknown>;
    if(binding.purpose==='task_input'){
      const answers=input.answers as Array<Record<string,unknown>>;
      if(!Array.isArray(answers)||answers.length!==1||answers[0]?.question_id!=='task-input'
        ||!Array.isArray(answers[0].selected_option_ids)||answers[0].selected_option_ids.length
        ||typeof answers[0].custom_text!=='string'||!answers[0].custom_text.trim()||answers[0].custom_text.length>10000)throw new Error('interaction_answer_invalid');
      supplement={kind:'user_input',text:answers[0].custom_text};
    }else{
      if(status==='denied')return true;
      supplement={kind:'review_continuation',text:'用户确认在原目标、原权限与累计预算内继续核验；这不是业务完成证书或新增工具权限。'};
    }
    const next=this.commands.resume(String(run.id),owner,{expected_run_version:run.version,checkpoint_id:run.checkpoint_id},`task-wait:${key}`,String(row.id));
    this.workbench.inheritCheckpointRun(owner,String(run.id),next.run_id);
    this.db.prepare('INSERT INTO wb_task_wait_responses VALUES(?,?,?,?)').run(String(row.id),next.run_id,JSON.stringify(supplement),new Date().toISOString());
    return true;
  }
}

export function taskWaitSupplement(db:DatabaseSync,runId:string):string {
  const row=db.prepare(`SELECT s.response_json FROM wb_task_wait_responses s
    JOIN wb_task_wait_interactions w ON w.interaction_id=s.interaction_id
    JOIN ga_runs r ON r.id=s.new_run_id AND r.continuation_of=w.run_id AND r.checkpoint_id=w.checkpoint_id
    JOIN ga_interactions i ON i.id=w.interaction_id AND i.run_id=w.run_id AND i.status='answered' WHERE r.id=?`).get(runId) as {response_json:string}|undefined;
  return row?`\n用户为本次确认点恢复提供了以下资料。它不改变原任务工具权限或预算；先核对原目标和验收条件：\n${row.response_json}`:'';
}
