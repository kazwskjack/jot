import type {DatabaseSync} from 'node:sqlite';
import {inspectChatCompactionSource} from '../conversations/chat-compaction-source.ts';
import type {OrdinaryRunHistoryScope} from './ordinary-run-completion.ts';
type Client={notifyChatPostAnswer(sessionId:string,scope:OrdinaryRunHistoryScope,signal?:AbortSignal):Promise<Record<string,unknown>>};
export function chatPostAnswerEnabled(env:Record<string,string|undefined>){
 const enabled=env.GENERAL_AGENT_CHAT_COMPACTION_AUTO_ENABLED;if(enabled===undefined||enabled==='false')return false;
 if(enabled!=='true'||env.GENERAL_AGENT_CHAT_ENABLED!=='true'||env.GENERAL_AGENT_ORDINARY_INPUT_RECOVERY_ENABLED!=='true'||env.GENERAL_AGENT_ORDINARY_STEERING_ENABLED!=='true')throw Error('chat_post_answer_config_invalid');return true;
}
/** Best-effort notification after original canonical publication. No queue,
 * lease, new run, intent write, model request or foreground failure is created. */
export async function notifyCommittedChatAnswer(db:DatabaseSync,runId:string,client:Client,signal?:AbortSignal):Promise<'accepted'|'skipped'|'unconfirmed'>{
 let sessionId:string,history:OrdinaryRunHistoryScope;
 try{
  signal?.throwIfAborted();if(typeof runId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(runId))return'skipped';
  const row=db.prepare('SELECT r.conversation_id,r.native_session_ref,r.version,c.owner_id FROM ga_runs r JOIN ga_conversations c ON c.id=r.conversation_id WHERE r.id=?').get(runId);if(!row)return'skipped';
  sessionId=String(row.native_session_ref);history={owner_id:String(row.owner_id),conversation_id:String(row.conversation_id),run_id:runId,expected_run_version:Number(row.version)};
  const source=inspectChatCompactionSource(db,{...history,session_ref:sessionId});if(source.policy.context_revision!=='checkpoint-text-v2')return'skipped';
 }catch{return'skipped';}
 try{const value=await client.notifyChatPostAnswer(sessionId,history,signal);return value.protocol===1&&value.kind==='chat_post_answer'&&value.status==='accepted'&&value.run_id===runId&&value.session_id===sessionId&&value.run_version===history.expected_run_version&&value.execution_authorized===false?'accepted':'unconfirmed';}catch{return'unconfirmed';}
}
