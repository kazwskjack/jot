import type {DatabaseSync} from 'node:sqlite';
import {TaskReplyDrafts} from './reply-drafts.ts';
import {TaskReplyDispatch} from './reply-dispatch.ts';
import {TaskReplySemanticChecks} from './reply-semantic.ts';
type Row=Record<string,any>;
export class TaskReplyHistory{
 private readonly db:DatabaseSync;private readonly drafts:TaskReplyDrafts;private readonly semantic:TaskReplySemanticChecks;
 constructor(db:DatabaseSync){this.db=db;this.drafts=new TaskReplyDrafts(db);new TaskReplyDispatch(db);this.semantic=new TaskReplySemanticChecks(db);}
 history(owner:string,taskId:string,cursor?:string){
  const read=()=>{
   if(!this.db.prepare('SELECT 1 FROM wb_persistent_tasks WHERE task_id=? AND owner_id=?').get(taskId,owner))throw new Error('task_not_found');
   return this.page(owner,taskId,cursor);
  };
  if(this.db.isTransaction)return read();this.db.exec('BEGIN');try{const page=read();this.db.exec('COMMIT');return page;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 private page(owner:string,taskId:string,cursor?:string){
  const owned=`FROM wb_task_reply_drafts d JOIN wb_task_occurrences occurrence ON occurrence.occurrence_id=d.occurrence_id WHERE d.owner_id=? AND occurrence.task_id=?`;
  const anchor=cursor?this.db.prepare(`SELECT d.created_at,d.draft_id ${owned} AND d.draft_id=?`).get(owner,taskId,cursor) as Row|undefined:undefined;if(cursor&&!anchor)throw new Error('task_not_found');
  const rows=this.db.prepare(`SELECT d.draft_id ${owned} ${anchor?'AND (d.created_at<? OR (d.created_at=? AND d.draft_id<?))':''} ORDER BY d.created_at DESC,d.draft_id DESC LIMIT 51`).all(owner,taskId,...(anchor?[anchor.created_at,anchor.created_at,anchor.draft_id]:[])) as Row[];
  const has_more=rows.length>50,items=rows.slice(0,50).map(row=>this.item(owner,row.draft_id));return {items,has_more,next_cursor:has_more?items.at(-1)!.draft_id:null};
 }
 private item(owner:string,id:string){
  const draft=this.drafts.get(owner,id),card=this.db.prepare('SELECT i.id,i.status,i.expires_at FROM wb_task_reply_review_cards c JOIN ga_interactions i ON i.id=c.interaction_id WHERE c.draft_id=?').get(id) as Row|undefined;
  const outcome=this.db.prepare('SELECT status,reason_code,created_at FROM wb_task_reply_dispatch_outcomes WHERE draft_id=? AND owner_id=?').get(id,owner) as Row|undefined;
  const wait=this.db.prepare('SELECT not_before,reason_code FROM wb_task_reply_dispatch_deferrals WHERE draft_id=?').get(id) as Row|undefined;
  const projection=this.db.prepare('SELECT message_id,created_at FROM wb_task_reply_projection_receipts WHERE draft_id=? AND owner_id=?').get(id,owner) as Row|undefined;
  const effect=this.db.prepare('SELECT e.effect_id,e.status,e.last_reason_code,e.updated_at FROM wb_task_reply_delivery_grants g JOIN ga_channel_deliveries e ON e.effect_id=g.effect_id WHERE g.draft_id=? AND g.owner_id=?').get(id,owner) as Row|undefined;
  const source=this.db.prepare('SELECT r.conversation_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND c.owner_id=?').get(draft.run_id,owner) as Row|undefined;if(!source)throw new Error('reply_draft_corrupt');
  let status=draft.mode==='draft'?'draft':draft.mode==='bounded_auto_reply'?'blocked':'pending_review',reason:string|null=draft.mode==='bounded_auto_reply'?'REPLY_SEMANTIC_CHECK_REQUIRED':null,notBefore:number|null=null;
  if(draft.mode==='bounded_auto_reply'){
   const check=this.semantic.eligibility(owner,id);
   status=check.allowed?'waiting_dispatch':'blocked';reason=check.reason;
   if(reason==='REPLY_SEMANTIC_CHECK_REQUIRED'&&this.db.prepare('SELECT 1 FROM wb_task_reply_semantic_attempts WHERE draft_id=? AND owner_id=?').get(id,owner))reason='REPLY_SEMANTIC_CHECK_PENDING';
  }
  if(draft.review?.decision==='deny')status='review_denied';
  else if(draft.review?.decision==='approve')status='waiting_dispatch';
  else if(card&&(card.status==='expired'||Date.parse(card.expires_at)<=Date.now()))status='review_expired';
  if(wait){status='deferred';reason=wait.reason_code;notBefore=Number(wait.not_before);}
  if(outcome?.status==='cancelled'){status='cancelled';reason=outcome.reason_code;notBefore=null;}
  if(projection){status='delivered';reason=null;notBefore=null;}
  if(effect){
   status=effect.status==='pending'?'queued':String(effect.status);reason=effect.last_reason_code??null;notBefore=null;
   const table=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_notification_deferrals'").get();
   const delay=table?this.db.prepare('SELECT not_before FROM wb_task_notification_deferrals WHERE effect_id=?').get(effect.effect_id) as Row|undefined:undefined;
   if(effect.status==='pending'&&delay){status='deferred';notBefore=Number(delay.not_before);}
  }
  return {draft_id:id,run_id:draft.run_id,conversation_id:String(source.conversation_id),occurrence_id:draft.occurrence_id,mode:draft.mode,text:draft.text,target:draft.target,status,reason,not_before:notBefore===null?null:new Date(notBefore*1000).toISOString(),interaction_id:card?.id??null,message_id:projection?.message_id??null,delivery_id:effect?.effect_id??null,created_at:draft.created_at,updated_at:effect?.updated_at??projection?.created_at??outcome?.created_at??draft.review?.created_at??draft.created_at};
 }
}
