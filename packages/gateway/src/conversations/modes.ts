import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import type {ConversationRepository} from './repository.ts';
import type {RunRepository} from '../runs/repository.ts';
import {assertModeSwitchAllowed} from './mode-sessions.ts';
import {conversationMode,readChatModePolicy,type ConversationModeClient} from './mode-policy.ts';
import {validateConversationGoalView} from '../harness/conversation-goal-view.ts';
import {validateNativeIdleObservation} from '../harness/native-idle-observation.ts';

function boundedRead<T>(operation:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();return new Promise((resolve,reject)=>{
  const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener('abort',abort);
  signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}).then(value=>{cleanup();signal.aborted?reject(signal.reason):resolve(value);},error=>{cleanup();reject(error);});
 });
}

/** The async native observation stays outside SQL. The original snapshot is
 * rechecked inside the owned CAS transaction before any mode mapping is made. */
export class ConversationModes{
 private db:DatabaseSync;private conversations:ConversationRepository;private runs:RunRepository;private client:ConversationModeClient|undefined;private chatEnabled:boolean;
 constructor(db:DatabaseSync,conversations:ConversationRepository,runs:RunRepository,client?:ConversationModeClient,chatEnabled=true){this.db=db;this.conversations=conversations;this.runs=runs;this.client=client;this.chatEnabled=chatEnabled;}
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
 async prepareEnqueue(id:string,owner:string,input:Record<string,unknown>){
  const current=this.conversations.get(id,owner);
  if(this.db.prepare('SELECT 1 FROM ga_messages WHERE conversation_id=? AND client_message_id=?').get(id,String(input.client_message_id)))return()=>this.runs.enqueue(id,owner,input);
  if(current.archived)throw Error('conversation_mode_conflict');
  const policy=current.mode==='chat'?await this.chatPolicy():undefined;
  if(current.mode==='chat'&&!policy)throw Error('chat_mode_unavailable');
  return()=>this.runs.enqueue(id,owner,input,{...(policy?{modePolicy:policy}:{}),expectedConversationVersion:current.version});
 }
}
