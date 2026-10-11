import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {OwnerChannelBindings} from '../channels/owner-bindings.ts';
import {TaskReplyDrafts} from './reply-drafts.ts';
import {TaskReplySendGate} from './reply-send-gate.ts';
type Row=Record<string,any>;
/** Host-only channel enqueue. No model-supplied recipient or body; this uses
 * the immutable reviewed draft and the existing ga_channel_deliveries queue. */
export class TaskReplyDelivery{
 private readonly db:DatabaseSync;private readonly drafts:TaskReplyDrafts;private readonly gate:TaskReplySendGate;private readonly now:()=>number;
 constructor(db:DatabaseSync,options:{now?:()=>number}={}){
  this.db=db;this.now=options.now??(()=>Math.floor(Date.now()/1000));this.drafts=new TaskReplyDrafts(db);this.gate=new TaskReplySendGate(db,{now:this.now});
  db.exec(`CREATE TABLE IF NOT EXISTS wb_task_reply_delivery_grants(effect_id TEXT PRIMARY KEY REFERENCES ga_channel_deliveries(effect_id),draft_id TEXT NOT NULL UNIQUE REFERENCES wb_task_reply_drafts(draft_id),owner_id TEXT NOT NULL,payload_sha256 TEXT NOT NULL,channel TEXT NOT NULL,principal TEXT NOT NULL,binding_id TEXT NOT NULL,binding_version INTEGER NOT NULL);
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_delivery_no_update BEFORE UPDATE ON wb_task_reply_delivery_grants BEGIN SELECT RAISE(ABORT,'reply_delivery_grant_immutable'); END;
   CREATE TRIGGER IF NOT EXISTS wb_task_reply_delivery_no_delete BEFORE DELETE ON wb_task_reply_delivery_grants BEGIN SELECT RAISE(ABORT,'reply_delivery_grant_immutable'); END;`);
 }
 enqueue(owner:string,id:string):Row{return withImmediateTransaction(this.db,()=>{
  const draft=this.drafts.get(owner,id),prior=this.db.prepare('SELECT e.* FROM wb_task_reply_delivery_grants g JOIN ga_channel_deliveries e ON e.effect_id=g.effect_id WHERE g.owner_id=? AND g.draft_id=?').get(owner,id) as Row|undefined;
  if(prior)return prior; // Recover the original effect; never requeue unknown.
  const check=this.gate.check(owner,id);if(!check.allowed&&!['REPLY_QUIET_HOURS','REPLY_RATE_LIMIT'].includes(check.reason!))throw new Error('reply_authority_revoked');
  if(draft.target.kind!=='channel')throw new Error('reply_channel_target_required');
  const binding=new OwnerChannelBindings(this.db).resolve(owner,draft.target.channel_binding_id);if(!['wecom','email'].includes(binding.channel))throw new Error('reply_channel_target_required');
  const effectId=`reply-delivery-${createHash('sha256').update(id).digest('hex').slice(0,32)}`,now=new Date(this.now()*1000).toISOString();
  this.db.prepare("INSERT INTO ga_channel_deliveries(effect_id,run_id,message_id,destination,recipient,artifact_ref,payload_json,status,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,'pending',?,?)").run(effectId,draft.run_id,id,binding.channel,binding.principal,JSON.stringify({kind:'text',text:draft.text}),now,now);
  this.db.prepare('INSERT INTO wb_task_reply_delivery_grants VALUES(?,?,?,?,?,?,?,?)').run(effectId,id,owner,draft.payload_sha256,binding.channel,binding.principal,binding.channel_binding_id,binding.version);
  return this.db.prepare('SELECT * FROM ga_channel_deliveries WHERE effect_id=?').get(effectId) as Row;
 });}
 authorize(effect:Row){
  const grant=this.db.prepare('SELECT * FROM wb_task_reply_delivery_grants WHERE effect_id=?').get(effect.effect_id) as Row|undefined;
  const denied={allowed:false,reason:'REPLY_DELIVERY_REVOKED',not_before:null};if(!grant)return denied;
  const draft=this.drafts.get(grant.owner_id,grant.draft_id);
  if(draft.payload_sha256!==grant.payload_sha256||effect.run_id!==draft.run_id||effect.message_id!==draft.draft_id||effect.destination!==grant.channel||effect.recipient!==grant.principal||effect.artifact_ref!==null||effect.payload_json!==JSON.stringify({kind:'text',text:draft.text})||draft.target.kind!=='channel'||draft.target.channel_binding_id!==grant.binding_id)return denied;
  const check=this.gate.check(grant.owner_id,grant.draft_id);if(!check.allowed)return check;
  const binding=new OwnerChannelBindings(this.db).resolve(grant.owner_id,grant.binding_id);if(binding.version!==grant.binding_version||binding.channel!==grant.channel||binding.principal!==grant.principal)return denied;
  return this.gate.reserve(grant.owner_id,grant.draft_id);
 }
}
/** Undefined belongs to another delivery source. Reserved reply IDs never
 * fall through to ordinary/non-task authorization, even if the grant is lost. */
export function replyDeliveryCheck(db:DatabaseSync,effect:Row,now:()=>number){
 const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_task_reply_delivery_grants'").get();
 const belongs=String(effect.effect_id).startsWith('reply-delivery-')||(table&&db.prepare('SELECT 1 FROM wb_task_reply_delivery_grants WHERE effect_id=?').get(effect.effect_id));
 if(!belongs)return undefined;
 if(!table)return {allowed:false,reason:'REPLY_DELIVERY_REVOKED',not_before:null};
 return new TaskReplyDelivery(db,{now}).authorize(effect);
}
