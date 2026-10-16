import {createHash} from 'node:crypto';import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {ChannelDeliveryService} from './delivery.ts';
import {assertHistoricalDeliverySnapshot,captureHistoricalDeliverySnapshot,type HistoricalDeliveryScope} from './historical-final-snapshot.ts';
import {decideHistoricalFinalDelivery,type HistoricalFinalDecision} from './historical-final-policy.ts';
import {historicalFinalBatchValid,historicalFinalTargetValid} from './historical-final-send.ts';
type Row=Record<string,any>;
type Final={message_id:string;text:string;content_sha256:string;publication_source_sha256:string;answer_sha256:string};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
function fail():never{throw Error('historical_final_delivery_unconfirmed');}
export class HistoricalFinalDeliveryIntents{
 private db:DatabaseSync;private queue:ChannelDeliveryService;
 usesDatabase(db:DatabaseSync):boolean{return this.db===db;}
 constructor(db:DatabaseSync,queue:ChannelDeliveryService){if(!(queue instanceof ChannelDeliveryService)||!queue.usesDatabase(db))throw Error('historical_delivery_database_mismatch');this.db=db;this.queue=queue;}
 /** Only called within the original publisher transaction, before modifying
  * canonical/source facts. A missing final receipt prevents actual sending. */
 commit(scope:HistoricalDeliveryScope,expectedSnapshot:string,final:Final){
  if(!this.db.isTransaction)throw Error('historical_delivery_transaction_required');
  if(!final||Object.keys(final).sort().join(',')!=='answer_sha256,content_sha256,message_id,publication_source_sha256,text'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(final.message_id)||typeof final.text!=='string'||!final.text.trim()||final.text!==final.text.trim()||final.answer_sha256!==sha(final.text)||![final.content_sha256,final.publication_source_sha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)))fail();
  const snapshot=assertHistoricalDeliverySnapshot(this.db,scope,expectedSnapshot);
  if(this.db.prepare('SELECT 1 FROM ga_historical_final_delivery_batches WHERE run_id=?').get(scope.run_id))fail();
  const now=new Date().toISOString();
  this.db.prepare('INSERT INTO ga_historical_final_delivery_batches VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(scope.run_id,scope.conversation_id,scope.owner_id,final.message_id,final.text,final.content_sha256,final.publication_source_sha256,final.answer_sha256,snapshot.sha256,JSON.stringify(snapshot),now);
  for(const target of snapshot.targets){
   const intentId='historical-delivery-'+sha(JSON.stringify([scope.run_id,target.destination,target.recipient]));
   this.db.prepare('INSERT INTO ga_historical_final_delivery_intents VALUES(?,?,?,?,?)').run(intentId,scope.run_id,target.destination,target.recipient,JSON.stringify(target));
   this.apply(intentId,scope.run_id,final.message_id,final.text,target);
  }
  return{run_id:scope.run_id,targets:snapshot.targets.length,execution_authorized:false};
 }
 private apply(intentId:string,runId:string,messageId:string,text:string,target:Row,authorized=target.recipient_authorized){
  const decision=decideHistoricalFinalDelivery({message_id:messageId,text,recipient_authorized:authorized,effects:target.effects,protected_effect_ids:target.protected_effect_ids});
  let effectId:string|null=null,status:string=decision.kind;
  if(decision.kind==='queue'){
   for(const old of decision.supersede_ids)if(this.db.prepare("UPDATE ga_channel_deliveries SET status='cancelled',last_reason_code='HISTORICAL_FINAL_SUPERSEDED',updated_at=? WHERE effect_id=? AND run_id=? AND message_id=? AND destination=? AND recipient=? AND status='pending' AND generation=0 AND provider_receipt_json IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL").run(new Date().toISOString(),old,runId,messageId,target.destination,target.recipient).changes!==1)fail();
   const effect=this.queue.enqueueExternal({runId,messageId,destination:target.destination,recipient:target.recipient,artifactRef:null,text:decision.text}) as Row|null;if(!effect||effect.run_id!==runId||effect.message_id!==messageId||effect.destination!==target.destination||effect.recipient!==target.recipient||effect.artifact_ref!==null||effect.payload_json!==JSON.stringify({kind:'text',text:decision.text}))fail();
   effectId=effect.effect_id;status='queued';this.bind(effectId!,intentId,effect.payload_json);
  }else if(decision.kind==='reuse'){
   effectId=decision.effect_id;status=decision.state;
   if(!decision.effect_protected){const effect=this.queue.get(effectId);this.bind(effectId,intentId,String(effect.payload_json));}
  }else if(decision.kind==='revoke')status='revoked';
  const previous=this.db.prepare('SELECT * FROM ga_historical_final_delivery_states WHERE intent_id=?').get(intentId) as Row|undefined,encoded=JSON.stringify(decision);
  if(!previous)this.db.prepare('INSERT INTO ga_historical_final_delivery_states VALUES(?,?,?,?,1,?)').run(intentId,status,effectId,encoded,new Date().toISOString());
  else if(previous.status!==status||previous.effect_id!==effectId||previous.decision_json!==encoded){if(this.db.prepare('UPDATE ga_historical_final_delivery_states SET status=?,effect_id=?,decision_json=?,version=version+1,updated_at=? WHERE intent_id=? AND version=?').run(status,effectId,encoded,new Date().toISOString(),intentId,previous.version).changes!==1)fail();}
 }
 private bind(effectId:string,intentId:string,payload:string){
  const old=this.db.prepare('SELECT * FROM ga_historical_final_delivery_grants WHERE effect_id=?').get(effectId) as Row|undefined;
  if(old){if(old.intent_id!==intentId||old.payload_sha256!==sha(payload))fail();return;}
  this.db.prepare('INSERT INTO ga_historical_final_delivery_grants VALUES(?,?,?)').run(effectId,intentId,sha(payload));
 }
 verifyPublished(runId:string,messageId:string,sourceSha256:string):boolean{
  try{
   const batch=this.db.prepare('SELECT * FROM ga_historical_final_delivery_batches WHERE run_id=?').get(runId) as Row|undefined;
   if(!batch||batch.message_id!==messageId||batch.publication_source_sha256!==sourceSha256||!historicalFinalBatchValid(this.db,batch))return false;
   const source=JSON.parse(batch.snapshot_json),targets=this.db.prepare('SELECT * FROM ga_historical_final_delivery_intents WHERE run_id=?').all(runId) as Row[];
   return targets.length===source.targets.length&&targets.every(target=>source.targets.some((original:Row)=>JSON.stringify(original)===target.target_json)&&!!this.db.prepare('SELECT 1 FROM ga_historical_final_delivery_states WHERE intent_id=?').get(target.intent_id));
  }catch{return false;}
 }
 /** Non-executing provider-fact reconciliation of the same frozen targets. No
  * new recipient, native work, final answer, model call or fee settlement. */
 reconcileHeld(runId:string):boolean{
  try{return withImmediateTransaction(this.db,()=>{
   const batch=this.db.prepare('SELECT * FROM ga_historical_final_delivery_batches WHERE run_id=?').get(runId) as Row|undefined;
   if(!batch||!this.verifyPublished(runId,batch.message_id,batch.publication_source_sha256))return false;
   const current=captureHistoricalDeliverySnapshot(this.db,{owner_id:batch.owner_id,conversation_id:batch.conversation_id,run_id:runId});
   for(const intent of this.db.prepare('SELECT * FROM ga_historical_final_delivery_intents WHERE run_id=? ORDER BY intent_id').all(runId) as Row[]){
    const state=this.db.prepare('SELECT * FROM ga_historical_final_delivery_states WHERE intent_id=?').get(intent.intent_id) as Row,target=JSON.parse(intent.target_json);
    if(state.status==='revoked')continue;
    const actual=current.targets.find(t=>t.destination===intent.destination&&t.recipient===intent.recipient);
    const prior:HistoricalFinalDecision=JSON.parse(state.decision_json),required=new Set([...target.effects.map((e:Row)=>e.effect_id),...prior.unresolved_effect_ids,...(state.effect_id?[state.effect_id]:[])]);
    if([...required].some(id=>!actual?.effects.some(e=>e.effect_id===id)))fail();
    this.apply(intent.intent_id,runId,batch.message_id,batch.text,actual??{...target,effects:[],protected_effect_ids:[]},historicalFinalTargetValid(this.db,batch,target));
   }
   return true;
  });}catch{return false;}
 }
}
