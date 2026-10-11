import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {EventStore} from '../events/event-store.ts';
import {publicInteractionValue} from '../interactions/service.ts';
import {TaskReplyPolicies} from './reply-policy.ts';
import {TaskExecutionEvidence,type ExecutionEvidence} from './execution-evidence.ts';
type Row=Record<string,any>;
const digest=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const exact=(value:unknown,keys:string[]):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(key=>keys.includes(key));
/** Independent candidate and human-review facts. Nothing in this class posts
 * a message, issues a planner command, or certifies semantic correctness. */
export class TaskReplyDrafts{
 private readonly db:DatabaseSync;private readonly events:EventStore;private readonly policies:TaskReplyPolicies;private readonly evidence:TaskExecutionEvidence;
 constructor(db:DatabaseSync,events=new EventStore(db)){
  this.db=db;this.events=events;this.policies=new TaskReplyPolicies(db);this.evidence=new TaskExecutionEvidence(db);
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_reply_drafts(draft_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES ga_runs(id),occurrence_id TEXT NOT NULL REFERENCES wb_task_occurrences(occurrence_id),call_id TEXT NOT NULL,input_sha256 TEXT NOT NULL,draft_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,call_id));
   CREATE TABLE IF NOT EXISTS wb_task_reply_review_cards(draft_id TEXT PRIMARY KEY REFERENCES wb_task_reply_drafts(draft_id),interaction_id TEXT NOT NULL UNIQUE REFERENCES ga_interactions(id));
   CREATE TABLE IF NOT EXISTS wb_task_reply_reviews(draft_id TEXT PRIMARY KEY REFERENCES wb_task_reply_drafts(draft_id),interaction_id TEXT NOT NULL UNIQUE REFERENCES ga_interactions(id),decision TEXT NOT NULL,payload_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS wb_task_reply_review_receipts(interaction_id TEXT PRIMARY KEY REFERENCES ga_interactions(id),operation TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
  for(const [table,name] of [['wb_task_reply_drafts','reply_draft'],['wb_task_reply_review_cards','reply_review_card'],['wb_task_reply_reviews','reply_review'],['wb_task_reply_review_receipts','reply_review_receipt']])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${name}_immutable'); END;CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${name}_immutable'); END;`);
 }
 private row(owner:string,id:string):Row{const row=this.db.prepare('SELECT * FROM wb_task_reply_drafts WHERE draft_id=? AND owner_id=?').get(id,owner) as Row|undefined;if(!row)throw new Error('reply_draft_not_found');if(digest(JSON.parse(row.draft_json))!==row.payload_sha256)throw new Error('reply_draft_corrupt');return row;}
 get(owner:string,id:string):Row{const row=this.row(owner,id),review=this.db.prepare('SELECT decision,interaction_id,payload_sha256,created_at FROM wb_task_reply_reviews WHERE draft_id=?').get(id) as Row|undefined;return {...JSON.parse(row.draft_json),payload_sha256:row.payload_sha256,review:review??null};}
 list(owner:string,runId:string){const scope=this.policies.scope(owner,runId);return {items:(this.db.prepare('SELECT draft_id FROM wb_task_reply_drafts WHERE owner_id=? AND occurrence_id=? ORDER BY created_at,draft_id').all(owner,scope.occurrence_id) as Row[]).map(row=>this.get(owner,row.draft_id))};}
 propose(owner:string,runId:string,callId:string,input:unknown){return withImmediateTransaction(this.db,()=>{
  if(typeof callId!=='string'||!callId||callId.length>200||!exact(input,['text','evidence'])||typeof input.text!=='string'||!input.text.trim()||input.text.length>12000||!Array.isArray(input.evidence)||input.evidence.length<1||input.evidence.length>20)throw new Error('invalid_reply_draft');
  const refs=input.evidence as ExecutionEvidence[];
  if(refs.some(ref=>!exact(ref,['kind','reference','hash'])||ref.kind!=='tool_receipt'||typeof ref.reference!=='string'||!ref.reference||ref.reference.length>200||typeof ref.hash!=='string'||! /^[a-f0-9]{64}$/.test(ref.hash))||new Set(refs.map(ref=>ref.reference)).size!==refs.length)throw new Error('invalid_reply_draft');
  const scope=this.policies.scope(owner,runId),inputHash=digest(input),prior=this.db.prepare('SELECT draft_id,input_sha256 FROM wb_task_reply_drafts WHERE run_id=? AND call_id=? AND owner_id=?').get(runId,callId,owner) as Row|undefined;
  if(prior){if(prior.input_sha256!==inputHash)throw new Error('idempotency_conflict');return this.get(owner,prior.draft_id);}
  if(!this.policies.authorize(owner,runId).allowed||scope.policy.mode==='report')throw new Error('reply_authority_revoked');
  if(refs.some(ref=>!this.evidence.verified(owner,scope.task_id,ref,scope.occurrence_id)))throw new Error('reply_evidence_unverified');
  const id=`reply-draft-${randomUUID()}`,now=new Date().toISOString();
  const value={draft_id:id,task_id:scope.task_id,occurrence_id:scope.occurrence_id,run_id:runId,version:1,mode:scope.policy.mode,text:input.text,target:scope.policy.target,direction:scope.policy.direction,limits:scope.policy.limits,quiet_hours:scope.policy.quiet_hours,evidence:refs,policy_version:scope.policy_version,policy_sha256:scope.policy_sha256,task_version:scope.task_version,generation:scope.generation,created_at:now};
  this.db.prepare('INSERT INTO wb_task_reply_drafts VALUES(?,?,?,?,?,?,?,?,?)').run(id,owner,runId,scope.occurrence_id,callId,inputHash,canonicalJson(value),digest(value),now);return this.get(owner,id);
 });}
 requestReview(owner:string,id:string){return withImmediateTransaction(this.db,()=>{
  const draft=this.get(owner,id);if(draft.mode!=='review')throw new Error('reply_review_mode_conflict');
  const prior=this.db.prepare('SELECT i.* FROM wb_task_reply_review_cards c JOIN ga_interactions i ON i.id=c.interaction_id WHERE c.draft_id=?').get(id) as Row|undefined;if(prior)return publicInteractionValue(prior);
  if(!this.policies.authorize(owner,draft.run_id).allowed)throw new Error('reply_authority_revoked');
  const run=this.db.prepare('SELECT conversation_id FROM ga_runs WHERE id=?').get(draft.run_id) as Row;
  const interactionId=`int-${randomUUID()}`,now=new Date().toISOString(),expires=new Date(Math.min(Date.parse(draft.limits.expires_at),Date.now()+7*86400000)).toISOString();
  const request={interaction_id:interactionId,run_id:draft.run_id,tool_call_id:`reply-review-${id}`,version:1,status:'pending',created_at:now,expires_at:expires,kind:'approval',purpose:'task_reply_review',action_digest:`sha256:${draft.payload_sha256}`,action_summary:`确认这份回复草稿\n目标：${draft.target.conversation_id??draft.target.channel_binding_id}\n主题：${draft.direction.topic}\n${draft.text}\n\n依据：${draft.evidence.map((ref:ExecutionEvidence)=>ref.reference).join('、')}\n确认只批准这份内容；发送仍须复核授权、证据、限额和回执，不改变任务权限。`,risk:'medium'};
  this.db.prepare("INSERT INTO ga_interactions(id,conversation_id,run_id,kind,status,version,action_digest,request_json,expires_at,created_at) VALUES(?,?,?,'approval','pending',1,?,?,?,?)").run(interactionId,run.conversation_id,draft.run_id,request.action_digest,JSON.stringify(request),expires,now);
  this.db.prepare('INSERT INTO wb_task_reply_review_cards VALUES(?,?)').run(id,interactionId);this.events.append(run.conversation_id,draft.run_id,'interaction.requested',request);return request;
 });}
 owns(interactionId:string){return !!this.db.prepare('SELECT 1 FROM wb_task_reply_review_cards WHERE interaction_id=?').get(interactionId);}
 resolve(row:Row,owner:string,status:string,input:Row,_key:string):boolean{
  if(!this.owns(String(row.id)))return false;if(!this.db.isTransaction)throw new Error('reply_review_transaction_required');
  const bound=this.db.prepare('SELECT draft_id FROM wb_task_reply_review_cards WHERE interaction_id=?').get(row.id) as Row,draft=this.get(owner,bound.draft_id);
  const actual=this.db.prepare('SELECT * FROM ga_interactions WHERE id=?').get(row.id) as Row;
  if(row.kind!=='approval'||row.run_id!==draft.run_id||actual.status!==status||actual.version!==Number(row.version)+1||actual.action_digest!==`sha256:${draft.payload_sha256}`||input.action_digest!==actual.action_digest||!['answered','denied'].includes(status))throw new Error('reply_review_state_conflict');
  if(status==='answered'&&!this.policies.authorize(owner,draft.run_id).allowed)throw new Error('reply_authority_revoked');
  this.db.prepare('INSERT INTO wb_task_reply_reviews VALUES(?,?,?,?,?)').run(draft.draft_id,row.id,status==='answered'?'approve':'deny',draft.payload_sha256,new Date().toISOString());return true;
 }
 recordReceipt(row:Row,input:unknown,key:string,operation:string,receipt:Row){
  if(!this.db.isTransaction||operation!=='interaction_decision'||!this.owns(String(row.id))||!/^[\x21-\x7E]{8,128}$/.test(key)||receipt.interaction_id!==row.id||receipt.run_id!==row.run_id||receipt.accepted!==true)throw new Error('reply_review_state_conflict');
  this.db.prepare('INSERT INTO wb_task_reply_review_receipts VALUES(?,?,?,?,?,?)').run(row.id,operation,key,digest(input),JSON.stringify(receipt),new Date().toISOString());
 }
 recoverReceipt(owner:string,id:string,operation:string,key:string,requestHash:string):Row|undefined{
  const row=this.db.prepare('SELECT p.receipt_json,i.status,i.version,i.run_id,v.decision,v.payload_sha256,d.payload_sha256 AS draft_hash FROM wb_task_reply_review_receipts p JOIN ga_interactions i ON i.id=p.interaction_id JOIN wb_task_reply_reviews v ON v.interaction_id=i.id JOIN wb_task_reply_drafts d ON d.draft_id=v.draft_id JOIN ga_conversations c ON c.id=i.conversation_id WHERE p.interaction_id=? AND d.owner_id=? AND c.owner_id=? AND p.operation=? AND p.idempotency_key=? AND p.request_sha256=?').get(id,owner,owner,operation,key,requestHash) as Row|undefined;if(!row)return;
  const receipt=JSON.parse(row.receipt_json);if(!exact(receipt,['accepted','interaction_id','run_id','status','version'])||receipt.accepted!==true||receipt.interaction_id!==id||receipt.run_id!==row.run_id||receipt.status!==row.status||receipt.version!==row.version||row.payload_sha256!==row.draft_hash||(row.decision==='approve'?'answered':'denied')!==row.status)throw new Error('reply_review_state_conflict');return receipt;
 }
}
