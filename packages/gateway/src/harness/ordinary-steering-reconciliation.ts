import type {DatabaseSync} from 'node:sqlite';
import type {EventStore} from '../events/event-store.ts';
import {withImmediateTransaction} from '../db/database.ts';
import {inspectOrdinarySteeringHistory} from '../conversations/ordinary-steering-history.ts';
import {ordinaryHistorySourceSha256,normalizeOrdinaryHistoryScope,validateBoundOrdinarySteeringObservation,type OrdinaryHistoryScope,type BoundOrdinarySteeringObservation} from './ordinary-steering-observation.ts';
type Client={observeBoundSteeringHistory(session:string,scope:OrdinaryHistoryScope,sourceHash:string,signal?:AbortSignal):Promise<unknown>};
type Receipt={command_id:string;run_id:string;conversation_id:string;owner_id:string;session_id:string;source_sha256:string;observation_sha256:string;source_json:string;observation_json:string};
/** Repair acceptance only. No new run/prompt, lease, Goal, final answer, budget
 * release or provider/tool replay is permitted by this component. */
export class OrdinarySteeringReconciler{
 private db:DatabaseSync;private events:EventStore;private client:Client;
 constructor(db:DatabaseSync,events:EventStore,client:Client){this.db=db;this.events=events;this.client=client;}
 private snapshot(runId:string,session:string,command:string){
  const row=this.db.prepare('SELECT c.owner_id,r.conversation_id,r.version FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?').get(runId) as {owner_id:string;conversation_id:string;version:number}|undefined;
  if(!row||this.db.prepare("SELECT 1 FROM ga_run_commands WHERE run_id=? AND kind='cancel'").get(runId))throw Error('ordinary_steering_repair_unconfirmed');
  const scope=normalizeOrdinaryHistoryScope(session,{owner_id:row.owner_id,conversation_id:row.conversation_id,run_id:runId,command_id:command,expected_run_version:row.version});
  const source=inspectOrdinarySteeringHistory(this.db,{...scope,session_ref:session});if(source.run_status==='cancelled')throw Error('ordinary_steering_repair_unconfirmed');
  return{scope,source,hash:ordinaryHistorySourceSha256(source)};
 }
 private accepted(proof:BoundOrdinarySteeringObservation,source:ReturnType<typeof inspectOrdinarySteeringHistory>){
  return ['admitted','committed'].includes(proof.native_state)&&proof.original_native_message_id!==null&&proof.command_native_message_id!==null&&proof.run_status===source.run_status&&proof.command_status==='pending';
 }
 private already(runId:string,session:string,command:string){
  const receipt=this.db.prepare('SELECT * FROM ga_ordinary_steering_reconciliations WHERE command_id=?').get(command) as Receipt|undefined;if(!receipt)return false;
  const current=this.snapshot(runId,session,command),source=JSON.parse(receipt.source_json),raw=JSON.parse(receipt.observation_json);
  if(receipt.run_id!==runId||receipt.session_id!==session||receipt.conversation_id!==current.scope.conversation_id||receipt.owner_id!==current.scope.owner_id||source.command_status!=='pending'||typeof source.product_message_present!=='boolean'||current.source.command_status!=='applied'||!current.source.product_message_present
   ||ordinaryHistorySourceSha256(source)!==receipt.source_sha256||ordinaryHistorySourceSha256(raw)!==receipt.observation_sha256
   ||ordinaryHistorySourceSha256({...current.source,command_status:'pending',product_message_present:source.product_message_present})!==receipt.source_sha256)return false;
  const proof=validateBoundOrdinarySteeringObservation(raw,session,current.scope,receipt.source_sha256);return this.accepted(proof,source);
 }
 async reconcile(runId:string,session:string,command:string,signal?:AbortSignal):Promise<boolean>{
  try{
   signal?.throwIfAborted();let existing=false;
   const before=withImmediateTransaction(this.db,()=>{existing=!!this.db.prepare('SELECT 1 FROM ga_ordinary_steering_reconciliations WHERE command_id=?').get(command);if(existing)return undefined;return this.snapshot(runId,session,command);});
   if(existing)return withImmediateTransaction(this.db,()=>this.already(runId,session,command));
   if(!before||before.source.command_status!=='pending')return false;
   const proof=validateBoundOrdinarySteeringObservation(await this.client.observeBoundSteeringHistory(session,before.scope,before.hash,signal),session,before.scope,before.hash);signal?.throwIfAborted();
   if(!this.accepted(proof,before.source))return false;
   return withImmediateTransaction(this.db,()=>{
    signal?.throwIfAborted();if(this.db.prepare('SELECT 1 FROM ga_ordinary_steering_reconciliations WHERE command_id=?').get(command))return this.already(runId,session,command);
    const current=this.snapshot(runId,session,command);if(current.hash!==before.hash||current.source.command_status!=='pending')return false;
    const raw=this.db.prepare('SELECT payload_json FROM ga_run_commands WHERE id=? AND run_id=?').get(command,runId) as {payload_json:string};
    const payload=JSON.parse(raw.payload_json) as {text:string;client_message_id:string},now=new Date().toISOString(),messageId=current.source.input_message_id;
    const blocks=[{block_id:messageId+':text',kind:'text',text:payload.text}],content=JSON.stringify({blocks,attachments:[]});
    if(!current.source.product_message_present){this.db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,'user','complete',?,?,?,?)").run(messageId,current.scope.conversation_id,runId,content,payload.client_message_id,now,now);this.events.append(current.scope.conversation_id,runId,'message.created',{message_id:messageId,run_id:runId,role:'user',status:'complete',blocks,created_at:now});}
    if(this.db.prepare("UPDATE ga_run_commands SET status='applied',applied_at=? WHERE id=? AND run_id=? AND status='pending'").run(now,command,runId).changes!==1)throw Error('ordinary_steering_repair_unconfirmed');
    this.db.prepare('INSERT INTO ga_ordinary_steering_reconciliations(command_id,run_id,conversation_id,owner_id,session_id,source_sha256,observation_sha256,source_json,observation_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
     .run(command,runId,current.scope.conversation_id,current.scope.owner_id,session,before.hash,ordinaryHistorySourceSha256(proof),JSON.stringify(before.source),JSON.stringify(proof),now);
    this.events.append(current.scope.conversation_id,runId,'progress.updated',{revision:1,value:{kind:'ordinary_input_reconciliation',command_id:command,phase:'accepted',source_sha256:before.hash,native_message_id:proof.command_native_message_id,execution_authorized:false}});return true;
   });
  }catch{return false;}
 }
}
