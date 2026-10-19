import {createHash,randomUUID} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
import {pinnedAttachmentRefs} from '../messages/pinned-attachments.ts';
import type {DatabaseSync} from 'node:sqlite';import type {EventStore} from '../events/event-store.ts';
import {withImmediateTransaction} from '../db/database.ts';import {RunRepository} from '../runs/repository.ts';
import {inspectOrdinaryRunHistory} from '../conversations/ordinary-run-history.ts';
import {ordinaryHistorySourceSha256} from './ordinary-steering-observation.ts';
import {validateOrdinaryRunCompletion,type OrdinaryRunHistoryScope,type OrdinaryRunCompletion} from './ordinary-run-completion.ts';
import {assistantText,assistantBlocks,collectArtifactRefs,presentedFiles} from './session-output.ts';
import {captureHistoricalOutputBytes,type HistoricalOutputWitness} from './historical-output-integrity.ts';
import type {AttachmentResolver,ResolvedAttachment} from '../artifacts/resolver.ts';
import {captureHistoricalDeliverySnapshot} from '../channels/historical-final-snapshot.ts';
import {HistoricalFinalDeliveryIntents} from '../channels/historical-final-intents.ts';
import {ChannelDeliveryService} from '../channels/delivery.ts';
type Client={observeRunCompletion(session:string,scope:OrdinaryRunHistoryScope,source:unknown,signal?:AbortSignal):Promise<unknown>};
type Options={resolver?:AttachmentResolver;artifactRoot?:string;historicalChannels?:ChannelDeliveryService};
type Receipt={run_id:string;conversation_id:string;owner_id:string;session_id:string;message_id:string;source_sha256:string;source_json:string;proof_sha256:string;proof_json:string;post_source_sha256:string;post_source_json:string;outputs_json:string};
const digest=ordinaryHistorySourceSha256;
const outputFacts=(items:readonly ResolvedAttachment[])=>items.map(a=>({artifact_id:a.artifactId,version:a.version,sha256:a.sha256,size_bytes:a.sizeBytes}));
function fail():never{throw Error('ordinary_final_publication_unconfirmed');}
/** Non-executing historical publication. Never borrows a Worker lease, prompts,
 * rewrites native state, changes run outcome, settles money or sends a channel.
 * Historical channel intent/outbox composition is explicitly opt-in. Existing
 * provider workers and permissions perform sending. The owning Worker's
 * separately gated observer may consume this class; its default remains off. */
export class OrdinaryFinalPublisher{
 private db:DatabaseSync;private events:EventStore;private client:Client;private options:Options;private deliveries?:HistoricalFinalDeliveryIntents;
 usesDatabase(db:DatabaseSync):boolean{return this.db===db;}
 constructor(db:DatabaseSync,events:EventStore,client:Client,options:Options={}){this.db=db;this.events=events;this.client=client;this.options=options;if(!!options.resolver!==!!options.artifactRoot)throw Error('ordinary_final_publication_config_invalid');if(options.historicalChannels!==undefined)this.deliveries=new HistoricalFinalDeliveryIntents(db,options.historicalChannels);}
 private snapshot(runId:string,session:string){
  const row=this.db.prepare('SELECT c.owner_id,r.conversation_id,r.version FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?').get(runId) as {owner_id:string;conversation_id:string;version:number}|undefined;if(!row)fail();
  const scope={owner_id:row.owner_id,conversation_id:row.conversation_id,run_id:runId,expected_run_version:row.version},source=inspectOrdinaryRunHistory(this.db,{...scope,session_ref:session});
  // The original default gate stays in place unless transactional channel
  // composition has been explicitly supplied by the trusted application.
  if(!this.deliveries&&(this.db.prepare('SELECT 1 FROM ga_channel_bindings WHERE conversation_id=?').get(row.conversation_id)||this.db.prepare('SELECT 1 FROM ga_channel_deliveries WHERE run_id=?').get(runId)))fail();
  if(source.canonical===null&&this.db.prepare("SELECT 1 FROM ga_events WHERE run_id=? AND type='message.created' AND json_extract(payload_json,'$.role')='assistant'").get(runId))fail();
  const channels=this.deliveries?captureHistoricalDeliverySnapshot(this.db,{owner_id:row.owner_id,conversation_id:row.conversation_id,run_id:runId}):undefined;
  return{scope,source,hash:digest(source),channels};
 }
 private resolve(owner:string,conversation:string,refs:string[],files:Array<{path:string;description?:string}>,lease:string){
  if(!refs.length&&!files.length)return[];if(!this.options.resolver||!this.options.artifactRoot)fail();return this.options.resolver.resolveOutputs(owner,conversation,refs,files,lease);
 }
 private already(runId:string,session:string,lease:string,prepared:readonly ResolvedAttachment[],witness?:HistoricalOutputWitness){
  const receipt=this.db.prepare('SELECT * FROM ga_ordinary_final_publications WHERE run_id=?').get(runId) as Receipt|undefined;if(!receipt)return false;const current=this.snapshot(runId,session),before=JSON.parse(receipt.source_json),post=JSON.parse(receipt.post_source_json),proof=JSON.parse(receipt.proof_json),outputs=JSON.parse(receipt.outputs_json);
  if(receipt.owner_id!==current.scope.owner_id||receipt.conversation_id!==current.scope.conversation_id||receipt.session_id!==session||receipt.run_id!==runId||digest(before)!==receipt.source_sha256||digest(post)!==receipt.post_source_sha256||digest(proof)!==receipt.proof_sha256||current.hash!==receipt.post_source_sha256||current.source.canonical?.message_id!==receipt.message_id
   ||before.owner_id!==receipt.owner_id||before.session_id!==session||before.run_id!==runId||proof.protocol!==1||proof.kind!=='ordinary_run_completion'||proof.source_sha256!==receipt.source_sha256||proof.run_id!==runId||proof.session_id!==session||proof.execution_authorized!==false||!Array.isArray(outputs))return false;
  if(outputs.length){const items=this.resolve(current.scope.owner_id,current.scope.conversation_id,outputs.map(a=>a.artifact_id),[],lease);if(!witness||!isDeepStrictEqual(items,prepared)||!isDeepStrictEqual(outputFacts(items),outputs))return false;witness.assertUnchanged();}else if(prepared.length||witness)return false;
  return !this.deliveries||this.deliveries.verifyPublished(runId,receipt.message_id,receipt.source_sha256);
 }
 private existing(runId:string,session:string,lease:string,signal?:AbortSignal){
  signal?.throwIfAborted();const receipt=this.db.prepare('SELECT owner_id,conversation_id,outputs_json,post_source_sha256 FROM ga_ordinary_final_publications WHERE run_id=?').get(runId);
  if(!receipt)return false;const current=this.snapshot(runId,session);
  if(current.scope.owner_id!==receipt.owner_id||current.scope.conversation_id!==receipt.conversation_id||current.hash!==receipt.post_source_sha256)return false;
  const outputs=JSON.parse(String(receipt.outputs_json));if(!Array.isArray(outputs))return false;
  const prepared=outputs.length?this.resolve(String(receipt.owner_id),String(receipt.conversation_id),outputs.map(a=>a.artifact_id),[],lease):[];
  const witness=prepared.length?captureHistoricalOutputBytes(this.options.artifactRoot!,prepared,signal):undefined;
  try{return withImmediateTransaction(this.db,()=>{signal?.throwIfAborted();return this.already(runId,session,lease,prepared,witness);});}finally{witness?.close();}
 }
 async reconcile(runId:string,session:string,signal?:AbortSignal,expectedScope?:{owner_id:string;conversation_id:string}):Promise<boolean>{
  const lease=`${runId}:historical-output:${randomUUID()}`;
  try{
   if(expectedScope&&Object.keys(expectedScope).sort().join(',')!=='conversation_id,owner_id')return false;
   signal?.throwIfAborted();let found=false;const before=withImmediateTransaction(this.db,()=>{found=!!this.db.prepare('SELECT 1 FROM ga_ordinary_final_publications WHERE run_id=?').get(runId);return found?undefined:this.snapshot(runId,session);});
   if(expectedScope&&(!before||Object.keys(expectedScope).sort().join(',')!=='conversation_id,owner_id'||before.scope.owner_id!==expectedScope.owner_id||before.scope.conversation_id!==expectedScope.conversation_id)){
    if(!found)return false;
    const receipt=this.db.prepare('SELECT owner_id,conversation_id FROM ga_ordinary_final_publications WHERE run_id=?').get(runId) as {owner_id:string;conversation_id:string}|undefined;
    if(!receipt||receipt.owner_id!==expectedScope.owner_id||receipt.conversation_id!==expectedScope.conversation_id)return false;
   }
   if(found)return this.existing(runId,session,lease,signal);if(!before)return false;
   const proof=validateOrdinaryRunCompletion(await this.client.observeRunCompletion(session,before.scope,before.source,signal),session,before.scope,before.source);signal?.throwIfAborted();
   const text=assistantText(proof.answer_event),blocks=assistantBlocks(proof.answer_event),refs=new Set<string>(),files=new Map<string,{path:string;description?:string}>();
   for(const e of proof.output_events){if(e.type==='tool/result')collectArtifactRefs(e.data,refs);for(const file of presentedFiles(e))files.set(file.path,file);}
   const artifacts=this.resolve(before.scope.owner_id,before.scope.conversation_id,[...refs],[...files.values()],lease);
   const second=validateOrdinaryRunCompletion(await this.client.observeRunCompletion(session,before.scope,before.source,signal),session,before.scope,before.source);signal?.throwIfAborted();if(!isDeepStrictEqual(proof,second))return false;
   const witness=artifacts.length?captureHistoricalOutputBytes(this.options.artifactRoot!,artifacts,signal):undefined;
   const existing=Symbol('existing-publication');
   try{const result=withImmediateTransaction(this.db,()=>{
    signal?.throwIfAborted();if(this.db.prepare('SELECT 1 FROM ga_ordinary_final_publications WHERE run_id=?').get(runId))return existing;
    const current=this.snapshot(runId,session);if(current.hash!==before.hash)return false;
    const checked=this.resolve(current.scope.owner_id,current.scope.conversation_id,[...refs],[...files.values()],lease);if(!isDeepStrictEqual(checked,artifacts))fail();
    witness?.assertUnchanged();
    const now=new Date().toISOString();
    const messageId=current.source.canonical?.message_id??`msg-history-${randomUUID()}`,content={blocks:blocks.map((b,i)=>({block_id:`${messageId}:${i}`,kind:b.kind,text:b.text,exposure:b.kind==='reasoning'?'provider':'public'})),attachments:checked.map(a=>a.artifactId)};
    if(this.deliveries){if(!before.channels)fail();this.deliveries.commit({owner_id:current.scope.owner_id,conversation_id:current.scope.conversation_id,run_id:runId},before.channels.sha256,{message_id:messageId,text,content_sha256:createHash('sha256').update(JSON.stringify(content)).digest('hex'),publication_source_sha256:before.hash,answer_sha256:proof.answer_sha256});}
    for(const c of current.source.commands.filter(c=>c.command_status==='pending')){
     const raw=this.db.prepare('SELECT payload_json FROM ga_run_commands WHERE id=? AND run_id=?').get(c.command_id,runId) as {payload_json:string},payload=JSON.parse(raw.payload_json),content={blocks:payload.text.trim()?[{block_id:c.input_message_id+':text',kind:'text',text:payload.text}]:[],attachments:c.protocol===2?c.attachment_manifest.attachments.map(item=>item.artifact_id):[]};
     if(!c.product_message_present){this.db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,'user','complete',?,?,?,?)").run(c.input_message_id,current.scope.conversation_id,runId,JSON.stringify(content),payload.client_message_id,now,now);this.events.append(current.scope.conversation_id,runId,'message.created',{message_id:c.input_message_id,run_id:runId,role:'user',status:'complete',blocks:content.blocks,...(content.attachments.length?{attachments:content.attachments}:{}),...(c.protocol===2?{attachment_refs:pinnedAttachmentRefs(c.attachment_manifest)}:{}),created_at:now});}
     if(this.db.prepare("UPDATE ga_run_commands SET status='applied',applied_at=? WHERE id=? AND run_id=? AND status='pending'").run(now,c.command_id,runId).changes!==1)fail();
    }
    for(const item of checked){if(this.db.prepare('INSERT OR IGNORE INTO ga_run_artifacts(run_id,artifact_id,version,created_at) VALUES(?,?,?,?)').run(runId,item.artifactId,item.version!,now).changes)this.events.append(current.scope.conversation_id,runId,'run.artifact',{run_id:runId,conversation_id:current.scope.conversation_id,artifact_id:item.artifactId,version:item.version,file_name:item.displayName,media_type:item.mediaType,size_bytes:item.sizeBytes,sha256:item.sha256,status:'ready',download_url:`/v1/artifacts/${item.artifactId}/download?version=${item.version}`,created_at:now});}
    if(current.source.canonical){const old=this.db.prepare('SELECT status,content_json FROM ga_messages WHERE id=? AND run_id=? AND conversation_id=?').get(messageId,runId,current.scope.conversation_id) as {status:string;content_json:string};if(this.db.prepare("UPDATE ga_messages SET status='complete',content_json=?,updated_at=? WHERE id=? AND run_id=? AND conversation_id=? AND role='assistant' AND status=? AND content_json=?").run(JSON.stringify(content),now,messageId,runId,current.scope.conversation_id,old.status,old.content_json).changes!==1)fail();}
    else this.db.prepare("INSERT INTO ga_messages(id,conversation_id,run_id,role,status,content_json,client_message_id,created_at,updated_at) VALUES(?,?,?,'assistant','complete',?,NULL,?,?)").run(messageId,current.scope.conversation_id,runId,JSON.stringify(content),now,now);
    const evidence={source_sha256:before.hash,raw_sha256:proof.raw_sha256,answer_sha256:proof.answer_sha256,command_ids:proof.command_ids,answer_seq:proof.answer_seq,turn_end_seq:proof.turn_end_seq};
    this.db.prepare("INSERT INTO ga_candidate_answers(id,run_id,input_message_id,turn_id,attempt,source,source_version,status,text,evidence_refs_json,created_at,updated_at) VALUES(?,?,?,?,1,'dsh-history-final','1','verified',?,?,?,?)").run(`candidate-history-${createHash('sha256').update(runId+proof.raw_sha256).digest('hex')}`,runId,current.source.input_message_id,runId,text,JSON.stringify([`ordinary-source:${before.hash}`,`native-history:${proof.raw_sha256}`,`native-answer:${proof.answer_sha256}`]),now,now);
    this.events.append(current.scope.conversation_id,runId,'message.created',new RunRepository(this.db,this.events).message(messageId));
    this.events.append(current.scope.conversation_id,runId,'response.upsert',{revision:1,value:{kind:'ordinary_final_reconciliation',run_id:runId,message_id:messageId,...evidence,execution_authorized:false}});
    const {answer_event,output_events,...meta}=proof,proofMeta={...meta,answer_event_sha256:digest(answer_event),output_events_sha256:digest(output_events)},post=this.snapshot(runId,session);
    this.db.prepare('INSERT INTO ga_ordinary_final_publications(run_id,conversation_id,owner_id,session_id,message_id,source_sha256,source_json,proof_sha256,proof_json,post_source_sha256,post_source_json,outputs_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(runId,current.scope.conversation_id,current.scope.owner_id,session,messageId,before.hash,JSON.stringify(before.source),digest(proofMeta),JSON.stringify(proofMeta),post.hash,JSON.stringify(post.source),JSON.stringify(outputFacts(checked)),now);
    witness?.assertUnchanged();return true;
   });return result===existing?this.existing(runId,session,lease,signal):result;}finally{witness?.close();}
  }catch{return false;}finally{try{this.options.resolver?.releaseLease(lease);}catch{/* Temporary retention lease expires conservatively; never clear execution or money. */}}
 }
}
