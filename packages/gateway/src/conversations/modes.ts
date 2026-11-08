import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {ConversationRepository} from './repository.ts';
import type {RunRepository} from '../runs/repository.ts';
import {assertModeSwitchAllowed} from './mode-sessions.ts';
import {conversationMode,readChatModePolicy,type ConversationModeClient} from './mode-policy.ts';
import {validateConversationGoalView} from '../harness/conversation-goal-view.ts';
import {validateNativeIdleObservation} from '../harness/native-idle-observation.ts';
import {ChatCompactionAttempts} from './chat-compaction-attempts.ts';
import {CHAT_CHECKPOINT_REVISION,latestChatCheckpoint} from './chat-checkpoint-store.ts';
import {validateChatContext} from './chat-context.ts';
import {canonicalModelJson,modelMetadataRoutes} from './model-policy.ts';
import {readHostTrustedModelMetadata,readHostTrustedModelMetadataEnabled,type TrustedModelMetadataBinding,type TrustedModelMetadataClient} from '../harness/model-metadata.ts';

type RecoveryCandidate={scope:{owner_id:string;conversation_id:string;run_id:string;session_ref:string;expected_run_version:number};intentId:string;sourceSha:string;parentId:string|null};
const CHAT_RECOVERY_MS=1000;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,HASH=/^[a-f0-9]{64}$/;
function recoveryCandidate(db:DatabaseSync,owner:string,conversation:string,policy:Awaited<ReturnType<typeof readChatModePolicy>>):RecoveryCandidate|undefined{
 if(!policy||policy.context_revision!==CHAT_CHECKPOINT_REVISION)return;
 const session=db.prepare("SELECT session_id FROM ga_conversation_mode_sessions WHERE owner_id=? AND conversation_id=? AND mode='chat'").get(owner,conversation);
 const latest=db.prepare("SELECT id,run_id,status FROM ga_messages WHERE conversation_id=? AND role='user' ORDER BY rowid DESC LIMIT 1").get(conversation);
 if(typeof session?.session_id!=='string'||typeof latest?.id!=='string'||typeof latest.run_id!=='string'||latest.status!=='complete')return;
 const selected=db.prepare(`SELECT i.intent_id FROM ga_chat_compaction_intents i
  JOIN ga_chat_compaction_attempts a ON a.intent_id=i.intent_id
  WHERE i.owner_id=? AND i.conversation_id=? AND i.session_id=? AND i.run_id=?
   AND a.owner_id=i.owner_id AND a.conversation_id=i.conversation_id AND a.session_id=i.session_id
   AND a.state IN ('dispatched','usage_unknown','settled')
   AND NOT EXISTS(SELECT 1 FROM ga_chat_compaction_checkpoints p WHERE p.attempt_id=a.attempt_id)
  ORDER BY i.rowid DESC LIMIT 1`).get(owner,conversation,session.session_id,latest.run_id);
 if(typeof selected?.intent_id!=='string'||!ID.test(selected.intent_id))return;
 const row=db.prepare("SELECT r.version,r.chat_context_json,r.native_session_ref,r.native_owner_id,r.native_conversation_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=? AND r.conversation_id=? AND c.owner_id=? AND c.mode='chat'").get(latest.run_id,conversation,owner);
 if(!row||row.native_session_ref!==session.session_id||row.native_owner_id!==owner||row.native_conversation_id!==conversation||typeof row.chat_context_json!=='string'||!Number.isSafeInteger(row.version))return;
 const scope={owner_id:owner,conversation_id:conversation,run_id:String(latest.run_id),session_ref:String(session.session_id),expected_run_version:Number(row.version)};
 try{
  const inspection=new ChatCompactionAttempts(db).inspect(scope,selected.intent_id),receipt=inspection.receipt,source=inspection.source as Record<string,unknown>,prior=source.policy as Record<string,unknown>;
  if(!receipt||!['dispatched','usage_unknown','settled'].includes(String(receipt.state))||source.execution_authorized!==false||source.owner_id!==owner||source.conversation_id!==conversation||source.run_id!==scope.run_id||source.session_id!==scope.session_ref||source.run_version!==scope.expected_run_version
   ||prior?.mode!=='chat'||prior.thinking!=='disabled'||prior.context_revision!==policy.context_revision||prior.preset_id!==policy.preset_id||prior.preset_revision!==policy.preset_revision||canonicalModelJson(prior.model)!==canonicalModelJson(policy.model))return;
  const context=validateChatContext(JSON.parse(row.chat_context_json));if(context.algorithm!==CHAT_CHECKPOINT_REVISION)return;
  const head=latestChatCheckpoint(db,owner,conversation,String(session.session_id),policy),parent=context.checkpoint;
  if(head?(parent?.checkpoint_id!==head.data.checkpoint_id||parent.checkpoint_sha256!==head.sha256):parent!==null)return;
  if(typeof inspection.source_sha256!=='string'||!HASH.test(inspection.source_sha256))return;
  return{scope,intentId:selected.intent_id,sourceSha:inspection.source_sha256,parentId:parent?.checkpoint_id??null};
 }catch{return;}
}
function validRecoveryReceipt(value:unknown,candidate:RecoveryCandidate){
 const row=value as Record<string,unknown>;
 if(!row||typeof row!=='object'||Array.isArray(row)||row.protocol!==1||row.execution_authorized!==false)return;
 if(row.status==='unavailable')return Object.keys(row).sort().join(',')==='checkpoint,execution_authorized,protocol,reason,status'&&row.checkpoint===null&&['NO_ATTEMPT','NO_DISPATCHED_ATTEMPT','UNSUPPORTED_CONTEXT'].includes(String(row.reason))?null:undefined;
 if(!['recovered','already_published'].includes(String(row.status))||Object.keys(row).sort().join(',')!=='checkpoint,execution_authorized,protocol,status')return;
 const cp=row.checkpoint as Record<string,unknown>;
 if(!cp||typeof cp!=='object'||Array.isArray(cp)||Object.keys(cp).sort().join(',')!=='checkpoint_id,checkpoint_sha256,execution_authorized,kind,native_summary_sha256,parent_checkpoint_id,protocol,run_id,session_id,source_sha256,summary_text_sha256'
  ||cp.protocol!==1||cp.kind!=='chat_compaction_checkpoint'||cp.execution_authorized!==false||cp.run_id!==candidate.scope.run_id||cp.session_id!==candidate.scope.session_ref||cp.source_sha256!==candidate.sourceSha||cp.parent_checkpoint_id!==candidate.parentId
  ||typeof cp.checkpoint_id!=='string'||!ID.test(cp.checkpoint_id)||!['checkpoint_sha256','native_summary_sha256','source_sha256','summary_text_sha256'].every(k=>typeof cp[k]==='string'&&HASH.test(cp[k] as string)))return;
 return{checkpoint_id:String(cp.checkpoint_id),checkpoint_sha256:String(cp.checkpoint_sha256)};
}

function boundedRead<T>(operation:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener('abort',abort);
  signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(value=>{cleanup();signal.aborted?reject(signal.reason):resolve(value);},error=>{cleanup();reject(error);});
 });
}

/** The async native observation stays outside SQL. The original snapshot is
 * rechecked inside the owned CAS transaction before any mode mapping is made. */
export class ConversationModes{
 private db:DatabaseSync;private conversations:ConversationRepository;private runs:RunRepository;private client:ConversationModeClient|undefined;private chatEnabled:boolean;private modelMetadataClient:TrustedModelMetadataClient|undefined;
 constructor(db:DatabaseSync,conversations:ConversationRepository,runs:RunRepository,client?:ConversationModeClient,chatEnabled=true,modelMetadataClient?:TrustedModelMetadataClient){this.modelMetadataClient=modelMetadataClient;this.db=db;this.conversations=conversations;this.runs=runs;this.client=client;this.chatEnabled=chatEnabled;}
 private chatPolicy(signal?:AbortSignal){return readChatModePolicy(this.chatEnabled?this.client:undefined,signal);}
 async capability(signal?:AbortSignal){const chat=!!await this.chatPolicy(signal);return{default:chat?'chat':'work',work:{supported:true},chat:{ready:chat}};}
 async prepareCreate(owner:string,input:Record<string,unknown>){
  const mode=conversationMode(input.mode??'work'),policy=mode==='chat'?await this.chatPolicy():undefined;
  if(mode==='chat'&&!policy)throw Error('chat_mode_unavailable');
  return()=>this.conversations.create(owner,input,policy?{chatPolicy:policy}:{});
 }
 async prepareUpdate(id:string,owner:string,input:Record<string,unknown>){
  const prior=this.conversations.get(id,owner);
  if(prior.version!==Number(input.expected_version))throw Error('version_conflict');
  const mode=conversationMode(input.mode??prior.mode);
  if(mode===prior.mode)return()=>this.conversations.update(id,owner,input);
  const source=withImmediateTransaction(this.db,()=>assertModeSwitchAllowed(this.db,id,owner));
  if(mode==='chat'&&!await this.chatPolicy())throw Error('chat_mode_unavailable');
  const refs=this.db.prepare(`SELECT session_id FROM ga_conversation_mode_sessions WHERE conversation_id=? AND owner_id=? AND mode='work'
   UNION SELECT session_id FROM ga_harness_session_bindings WHERE conversation_id=? AND owner_id=?
   UNION SELECT native_session_ref AS session_id FROM ga_runs WHERE conversation_id=? AND native_owner_id=? AND native_conversation_id=? AND native_session_ref IS NOT NULL
    AND (execution_policy_json IS NULL OR (json_valid(execution_policy_json) AND json_extract(execution_policy_json,'$.mode')='work'))`)
   .all(id,owner,id,owner,id,owner,id);
  const workRefs=new Set(refs.map(row=>String(row.session_id)));
  const chatRefs=this.db.prepare("SELECT session_id FROM ga_conversation_mode_sessions WHERE conversation_id=? AND owner_id=? AND mode='chat'").all(id,owner);
  const allRefs=[...new Set([...workRefs,...chatRefs.map(row=>String(row.session_id))])];
  if(allRefs.length>32)throw Error('conversation_mode_goal_unconfirmed');
  if(allRefs.length&&!this.client?.observeNativeIdle||workRefs.size&&!this.client?.conversationGoal)throw Error('conversation_mode_goal_unconfirmed');
  const bounded=AbortSignal.timeout(5000);
  try{await boundedRead(()=>Promise.all(allRefs.map(async session=>{
   const idle=validateNativeIdleObservation(await this.client!.observeNativeIdle!(session,bounded),session);
   bounded.throwIfAborted();
   if(idle.native_idle!=='idle'){
    const used=this.db.prepare('SELECT 1 FROM ga_runs WHERE conversation_id=? AND native_session_ref=?').get(id,session);
    if(idle.basis==='absent'&&!used)return;
    throw Error('conversation_mode_goal_unconfirmed');
   }
   if(workRefs.has(session)){
    const {goal}=validateConversationGoalView(await this.client!.conversationGoal!(session,{},bounded));
    bounded.throwIfAborted();
    if(goal&&(goal.phase==='active'||goal.activation==='armed'))throw Error('conversation_mode_goal_active');
   }
  })),bounded);}catch(error){if((error as Error)?.message==='conversation_mode_goal_active')throw error;throw Error('conversation_mode_goal_unconfirmed');}
  return()=>this.conversations.update(id,owner,input,()=>{if(assertModeSwitchAllowed(this.db,id,owner)!==source)throw Error('conversation_mode_conflict');});
 }
 async prepareEnqueue(id:string,owner:string,input:Record<string,unknown>,signal?:AbortSignal){
  const current=this.conversations.get(id,owner);
  const duplicate=this.db.prepare('SELECT id,run_id FROM ga_messages WHERE conversation_id=? AND client_message_id=?').get(id,String(input.client_message_id));
  if(duplicate)return()=>{
   const original=this.db.prepare('SELECT id,run_id FROM ga_messages WHERE conversation_id=? AND client_message_id=?').get(id,String(input.client_message_id));
   if(!original||original.id!==duplicate.id||original.run_id!==duplicate.run_id)throw Error('version_conflict');
   return this.runs.enqueue(id,owner,input);
  };
  if(current.archived)throw Error('conversation_mode_conflict');
  const policy=current.mode==='chat'?await this.chatPolicy():undefined;
  if(current.mode==='chat'&&!policy)throw Error('chat_mode_unavailable');
  let modelMetadataBindings:TrustedModelMetadataBinding[]|undefined;
  const metadataEnabled=await readHostTrustedModelMetadataEnabled(this.modelMetadataClient,signal);
  if(metadataEnabled===true&&typeof this.modelMetadataClient?.trustedModelMetadata!=='function')throw Error('model_metadata_unavailable');
  if(typeof this.modelMetadataClient?.trustedModelMetadata==='function'&&metadataEnabled!==false){
   const routes=modelMetadataRoutes(policy?.model??current.model),signalBound=signal?AbortSignal.any([signal,AbortSignal.timeout(4500)]):AbortSignal.timeout(4500);
   const read=()=>Promise.all(routes.map(route=>readHostTrustedModelMetadata(this.modelMetadataClient,route,signalBound)));
   const first=await read(),second=await read();signalBound.throwIfAborted();
   if(canonicalModelJson(first)!==canonicalModelJson(second))throw Error('model_metadata_changed');
   if(metadataEnabled===true&&first.some(binding=>binding===undefined))throw Error('model_metadata_changed');
   if(first.some(binding=>binding===undefined)&&first.some(binding=>binding!==undefined))throw Error('model_metadata_unavailable');
   if(first.every((binding):binding is TrustedModelMetadataBinding=>binding!==undefined))modelMetadataBindings=first;
  }
  const candidate=current.mode==='chat'?recoveryCandidate(this.db,owner,id,policy):undefined;
  if(candidate&&typeof this.client?.recoverChatCheckpoint==='function'&&!signal?.aborted){
   const deadline=AbortSignal.timeout(CHAT_RECOVERY_MS),bounded=signal?AbortSignal.any([signal,deadline]):deadline;
   try{
    const history={owner_id:candidate.scope.owner_id,conversation_id:candidate.scope.conversation_id,run_id:candidate.scope.run_id,expected_run_version:candidate.scope.expected_run_version};
    const value=await boundedRead(()=>this.client!.recoverChatCheckpoint!(candidate.scope.session_ref,history,candidate.intentId,bounded),bounded);
    if(validRecoveryReceipt(value,candidate)===undefined)throw Error('chat_checkpoint_recovery_receipt_invalid');
   }catch{/* Recovery is optional; normal Chat retains the original bounded snapshot fallback. */}
  }
  return()=>this.runs.enqueue(id,owner,input,{...(policy?{modePolicy:policy}:{}),expectedConversationVersion:current.version,...(modelMetadataBindings?{modelMetadataBindings}:{})});
 }
}
