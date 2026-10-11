import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {TaskReplyDrafts} from './reply-drafts.ts';
import {TaskReplyPolicies} from './reply-policy.ts';
import {TaskReplySemanticChecks} from './reply-semantic.ts';
import {notificationQuietUntil} from './notification-policy.ts';
type Check={allowed:boolean;reason:string|null;not_before:number|null};
type Reservation=Check&{reservation_id?:string;payload_sha256?:string};
/** Review/authority/attempt-budget fence, not a sending capability. The caller
 * must reserve in the transaction that authorizes an outbox send attempt and
 * recheck immediately before provider I/O. Unknown attempts keep their slots.
 * Bounded autonomous replies require a separate semantic/risk verifier. */
export class TaskReplySendGate{
 private readonly db:DatabaseSync;private readonly drafts:TaskReplyDrafts;private readonly policies:TaskReplyPolicies;private readonly semantic:TaskReplySemanticChecks;private readonly now:()=>number;
 constructor(db:DatabaseSync,options:{now?:()=>number}={}){
  this.db=db;this.now=options.now??(()=>Math.floor(Date.now()/1000));this.drafts=new TaskReplyDrafts(db);this.policies=new TaskReplyPolicies(db,{now:()=>new Date(this.now()*1000)});
  this.semantic=new TaskReplySemanticChecks(db,{now:()=>new Date(this.now()*1000)});
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_reply_send_reservations(reservation_id TEXT PRIMARY KEY,draft_id TEXT NOT NULL UNIQUE REFERENCES wb_task_reply_drafts(draft_id),owner_id TEXT NOT NULL,payload_sha256 TEXT NOT NULL,bucket_sha256 TEXT NOT NULL,reserved_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS wb_task_reply_send_bucket ON wb_task_reply_send_reservations(bucket_sha256,reserved_at);
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_send_no_update BEFORE UPDATE ON wb_task_reply_send_reservations BEGIN SELECT RAISE(ABORT,'reply_send_reservation_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_send_no_delete BEFORE DELETE ON wb_task_reply_send_reservations BEGIN SELECT RAISE(ABORT,'reply_send_reservation_immutable'); END;`);
 }
 private bucket(owner:string,draft:Record<string,any>){return createHash('sha256').update(canonicalJson([owner,draft.target])).digest('hex');}
 check(owner:string,id:string):Check{
  const draft=this.drafts.get(owner,id),denied=(reason:string,notBefore:number|null=null):Check=>({allowed:false,reason,not_before:notBefore});
  const authority=this.policies.authorize(owner,draft.run_id);if(!authority.allowed)return denied(authority.reason!);
  if(draft.mode==='draft')return denied('REPLY_DRAFT_ONLY');
  if(draft.mode==='bounded_auto_reply'){
   const check=this.semantic.eligibility(owner,id);if(!check.allowed)return denied(check.reason!);
  }else{
  if(draft.mode!=='review'||draft.review?.decision!=='approve'||draft.review.payload_sha256!==draft.payload_sha256)return denied('REPLY_REVIEW_REQUIRED');
  // The immutable approval fact must still match the committed interaction.
  const card=this.db.prepare("SELECT 1 FROM ga_interactions WHERE id=? AND run_id=? AND kind='approval' AND status='answered' AND action_digest=?").get(draft.review.interaction_id,draft.run_id,`sha256:${draft.payload_sha256}`);
  if(!card)return denied('REPLY_REVIEW_REQUIRED');
  }
  const current=this.now();if(!Number.isSafeInteger(current)||current<0)throw new Error('reply_send_clock_invalid');
  const quiet=notificationQuietUntil({min_interval_seconds:draft.limits.min_interval_seconds,max_per_24_hours:draft.limits.max_per_24_hours,quiet_hours:draft.quiet_hours},current);
  if(quiet!==null)return denied('REPLY_QUIET_HOURS',quiet);
  const existing=this.db.prepare('SELECT owner_id,payload_sha256,bucket_sha256 FROM wb_task_reply_send_reservations WHERE draft_id=?').get(id) as Record<string,any>|undefined;
  const bucket=this.bucket(owner,draft);
  if(existing){if(existing.owner_id!==owner||existing.payload_sha256!==draft.payload_sha256||existing.bucket_sha256!==bucket)throw new Error('reply_send_reservation_corrupt');return {allowed:true,reason:null,not_before:null};}
  const attempts=this.db.prepare('SELECT reserved_at FROM wb_task_reply_send_reservations WHERE bucket_sha256=? AND reserved_at>? ORDER BY reserved_at').all(bucket,current-86400) as Array<{reserved_at:number}>;
  const last=attempts.at(-1)?.reserved_at,limits=draft.limits;
  const until=Math.max(current,last===undefined?current:last+limits.min_interval_seconds,attempts.length>=limits.max_per_24_hours?attempts[attempts.length-limits.max_per_24_hours]!.reserved_at+86400:current);
  return until>current?denied('REPLY_RATE_LIMIT',until):{allowed:true,reason:null,not_before:null};
 }
 reserve(owner:string,id:string):Reservation{
  if(!this.db.isTransaction)throw new Error('reply_send_transaction_required');
  const check=this.check(owner,id);if(!check.allowed)return check;
  const draft=this.drafts.get(owner,id),reservationId=`reply-attempt-${createHash('sha256').update(id).digest('hex').slice(0,32)}`;
  this.db.prepare('INSERT OR IGNORE INTO wb_task_reply_send_reservations VALUES(?,?,?,?,?,?)').run(reservationId,id,owner,draft.payload_sha256,this.bucket(owner,draft),this.now());
  return {...check,reservation_id:reservationId,payload_sha256:draft.payload_sha256};
 }
}
