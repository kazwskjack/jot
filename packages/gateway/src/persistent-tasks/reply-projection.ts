import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {EventStore} from '../events/event-store.ts';
import {TaskReplyDrafts} from './reply-drafts.ts';
import {TaskReplySendGate} from './reply-send-gate.ts';
type Row=Record<string,any>;
/** A delivered assistant message, not a new planner run or user trigger.
 * Provenance belongs to the receipt; source task runs stay in their own chat. */
export class TaskReplyProjection{
 private readonly db:DatabaseSync;private readonly events:EventStore;private readonly drafts:TaskReplyDrafts;private readonly gate:TaskReplySendGate;private readonly now:()=>number;
 constructor(db:DatabaseSync,events=new EventStore(db),options:{now?:()=>number}={}){
  this.db=db;this.events=events;this.now=options.now??(()=>Math.floor(Date.now()/1000));this.drafts=new TaskReplyDrafts(db,events);this.gate=new TaskReplySendGate(db,{now:this.now});
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_reply_projection_receipts(draft_id TEXT PRIMARY KEY REFERENCES wb_task_reply_drafts(draft_id),owner_id TEXT NOT NULL,source_run_id TEXT NOT NULL REFERENCES ga_runs(id),conversation_id TEXT NOT NULL REFERENCES ga_conversations(id),message_id TEXT NOT NULL UNIQUE REFERENCES ga_messages(id),payload_sha256 TEXT NOT NULL,receipt_json TEXT NOT NULL,created_at TEXT NOT NULL);
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_projection_no_update BEFORE UPDATE ON wb_task_reply_projection_receipts BEGIN SELECT RAISE(ABORT,'reply_projection_receipt_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_projection_no_delete BEFORE DELETE ON wb_task_reply_projection_receipts BEGIN SELECT RAISE(ABORT,'reply_projection_receipt_immutable'); END;`);
 }
 project(owner:string,id:string):Row{return withImmediateTransaction(this.db,()=>{
  const draft=this.drafts.get(owner,id),prior=this.db.prepare('SELECT receipt_json FROM wb_task_reply_projection_receipts WHERE draft_id=? AND owner_id=?').get(id,owner) as Row|undefined;if(prior)return JSON.parse(prior.receipt_json);
  if(draft.target.kind!=='conversation')throw new Error('reply_conversation_target_required');
  const check=this.gate.reserve(owner,id);if(!check.allowed)return check;
  const conversation=draft.target.conversation_id,messageId=`msg-reply-${createHash('sha256').update(id).digest('hex').slice(0,32)}`,now=new Date(this.now()*1000).toISOString();
  const blocks=[{block_id:`${messageId}:0`,kind:'text',text:draft.text,exposure:'public'}];
  this.db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,NULL,'assistant','complete',?,NULL,?,?)").run(messageId,conversation,JSON.stringify({blocks,attachments:[]}),now,now);
  const receipt={draft_id:id,conversation_id:conversation,message_id:messageId,status:'delivered',payload_sha256:draft.payload_sha256,created_at:now};
  this.db.prepare('INSERT INTO wb_task_reply_projection_receipts VALUES(?,?,?,?,?,?,?,?)').run(id,owner,draft.run_id,conversation,messageId,draft.payload_sha256,JSON.stringify(receipt),now);
  this.events.append(conversation,null,'message.created',{message_id:messageId,run_id:null,role:'assistant',status:'complete',blocks,created_at:now});return receipt;
 });}
}
