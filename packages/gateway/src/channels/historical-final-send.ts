import {createHash} from 'node:crypto';import type {DatabaseSync} from 'node:sqlite';
import {historicalDeliveryValueSha256 as hash} from './historical-final-snapshot.ts';
type Row=Record<string,any>;
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
/** Existing publication and frozen original recipient facts only. A later
 * owner binding or a replaced canonical answer cannot renew this authority. */
export function historicalFinalBatchValid(db:DatabaseSync,batch:Row):boolean{
 try{
  const source=JSON.parse(batch.snapshot_json),{sha256,...facts}=source;
  if(hash(facts)!==sha256||sha256!==batch.snapshot_sha256||source.scope.owner_id!==batch.owner_id||source.scope.conversation_id!==batch.conversation_id||source.scope.run_id!==batch.run_id||sha(batch.text)!==batch.answer_sha256)return false;
  const row=db.prepare(`SELECT m.content_json,m.status,c.archived_at,c.owner_id,r.status AS run_status
   FROM ga_messages m JOIN ga_runs r ON r.id=m.run_id JOIN ga_conversations c ON c.id=r.conversation_id
   WHERE m.id=? AND m.run_id=? AND m.conversation_id=? AND m.role='assistant'`).get(batch.message_id,batch.run_id,batch.conversation_id) as Row|undefined;
  const publication=db.prepare('SELECT * FROM ga_ordinary_final_publications WHERE run_id=?').get(batch.run_id) as Row|undefined;
  const session=publication?db.prepare('SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=? AND owner_id=?').get(batch.conversation_id,batch.owner_id) as Row|undefined:undefined;
  return !!row&&row.owner_id===batch.owner_id&&row.archived_at===null&&row.status==='complete'
   &&['succeeded','failed','partial','interrupted'].includes(row.run_status)&&sha(row.content_json)===batch.content_sha256
   &&!db.prepare("SELECT 1 FROM ga_run_commands WHERE run_id=? AND kind<>'steer'").get(batch.run_id)
   &&!!publication&&publication.owner_id===batch.owner_id&&publication.conversation_id===batch.conversation_id&&publication.message_id===batch.message_id
   &&session?.session_id===publication.session_id&&publication.source_sha256===batch.publication_source_sha256&&JSON.parse(publication.proof_json).answer_sha256===batch.answer_sha256;
 }catch{return false;}
}
export function historicalFinalTargetValid(db:DatabaseSync,batch:Row,target:Row):boolean{
 try{
  if(target.recipient_authorized!==true||!target.conversation_binding)return false;
  const binding=db.prepare('SELECT * FROM ga_channel_bindings WHERE channel=? AND principal=? AND conversation_id=?').get(target.destination,target.recipient,batch.conversation_id);
  if(hash(binding??null)!==hash(target.conversation_binding))return false;
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_owner_channel_bindings'").get();
  const owners=exists?db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE channel=? AND principal=? ORDER BY channel_binding_id').all(target.destination,target.recipient):[];
  return hash(owners)===target.owner_bindings_sha256;
 }catch{return false;}
}
/** Additional restriction, never an early authorization that bypasses existing
 * reply/task/digest checks. Independent file/progress effects keep their path. */
export function historicalFinalSendCheck(db:DatabaseSync,effect:Row):{allowed:boolean;uncertain:boolean}|undefined{
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_historical_final_delivery_batches'").get())return;
 // Resolve a granted effect through its immutable original intent first. A
 // mutable effect.run_id/message_id/artifact must not bypass this restriction.
 const grant=db.prepare('SELECT * FROM ga_historical_final_delivery_grants WHERE effect_id=?').get(effect.effect_id) as Row|undefined;
 const grantedIntent=grant?db.prepare('SELECT * FROM ga_historical_final_delivery_intents WHERE intent_id=?').get(grant.intent_id) as Row|undefined:undefined;
 const batch=db.prepare('SELECT * FROM ga_historical_final_delivery_batches WHERE run_id=?').get(grantedIntent?.run_id??effect.run_id) as Row|undefined;
 if(!batch)return grant?{allowed:false,uncertain:true}:undefined;
 if(!grant&&(effect.message_id!==batch.message_id||effect.artifact_ref!==null))return;
 try{
  const intent=grantedIntent??db.prepare('SELECT * FROM ga_historical_final_delivery_intents WHERE run_id=? AND destination=? AND recipient=?').get(effect.run_id,effect.destination,effect.recipient) as Row|undefined;
  const target=intent?JSON.parse(intent.target_json):null,old=target?.effects.find((e:Row)=>e.effect_id===effect.effect_id);
  const uncertain=!!effect.provider_receipt_json||effect.generation>1||!!old&&(old.generation>0||old.provider_receipt_json!==null||['sending','receipt_pending','outcome_unknown'].includes(old.status));
  // Existing task/reply/digest authority must remain with its original gate.
  if(!grant&&target?.protected_effect_ids.includes(effect.effect_id))return;
  if(!intent||!grant||grant.intent_id!==intent.intent_id||effect.run_id!==batch.run_id||effect.message_id!==batch.message_id||effect.artifact_ref!==null||effect.destination!==intent.destination||effect.recipient!==intent.recipient)return{allowed:false,uncertain};
  const state=db.prepare('SELECT * FROM ga_historical_final_delivery_states WHERE intent_id=?').get(intent.intent_id) as Row|undefined;
  return{allowed:!!state&&state.effect_id===effect.effect_id&&['queued','pending_receipt','delivered'].includes(state.status)
   &&effect.generation===1&&effect.provider_receipt_json===null
   &&grant.payload_sha256===sha(effect.payload_json??'')&&historicalFinalBatchValid(db,batch)&&historicalFinalTargetValid(db,batch,target),uncertain};
 }catch{return{allowed:false,uncertain:true};}
}
