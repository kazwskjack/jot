import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {conversationMode,type ConversationMode} from './mode-policy.ts';
export function ensureModeSession(db:DatabaseSync,owner:string,id:string,mode:ConversationMode){
 conversationMode(mode);
 return withImmediateTransaction(db,()=>{
  const c=db.prepare('SELECT owner_id,archived_at FROM ga_conversations WHERE id=? AND owner_id=?').get(id,owner);
  if(!c)throw Error('conversation_not_found');if(mode==='chat'&&c.archived_at!==null)throw Error('conversation_mode_conflict');
  const old=db.prepare('SELECT * FROM ga_conversation_mode_sessions WHERE conversation_id=? AND mode=?').get(id,mode);
  if(old){
   if(old.owner_id!==owner)throw Error('conversation_mode_conflict');
   if(mode==='work'){const alias=db.prepare('SELECT owner_id,session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(id);if(alias&&(alias.owner_id!==owner||alias.session_id!==old.session_id))throw Error('conversation_mode_session_missing');}
   return String(old.session_id);
  }
  let session:string;
  if(mode==='work'){
   const work=db.prepare('SELECT owner_id,session_id FROM ga_harness_session_bindings WHERE conversation_id=?').get(id);
   if(!work)return undefined;
   if(work.owner_id!==owner)throw Error('conversation_mode_conflict');session=String(work.session_id);
  }else{
   if(db.prepare("SELECT 1 FROM ga_runs WHERE conversation_id=? AND json_valid(execution_policy_json) AND json_extract(execution_policy_json,'$.mode')='chat'").get(id))throw Error('conversation_mode_session_missing');
   session=`jot-chat-${randomUUID()}`;
  }
  const now=new Date().toISOString();db.prepare('INSERT INTO ga_conversation_mode_sessions(conversation_id,owner_id,mode,session_id,created_at) VALUES(?,?,?,?,?)').run(id,owner,mode,session,now);
  return session;
 });
}

/** Synchronous checks are repeated in the mutation/acceptance transaction. */
export function assertModeSwitchAllowed(db:DatabaseSync,id:string,owner:string){
 const c=db.prepare('SELECT mode,version,archived_at FROM ga_conversations WHERE id=? AND owner_id=?').get(id,owner);
 if(!c)throw Error('conversation_not_found');if(c.archived_at!==null)throw Error('conversation_mode_conflict');
 const table=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(table('wb_agents')&&db.prepare('SELECT 1 FROM wb_agents WHERE conversation_id=?').get(id)
  ||table('wb_run_bindings')&&db.prepare('SELECT 1 FROM wb_run_bindings b JOIN ga_runs r ON r.id=b.run_id WHERE r.conversation_id=?').get(id))throw Error('conversation_mode_scope_invalid');
 if(db.prepare("SELECT 1 FROM ga_runs WHERE conversation_id=? AND status IN ('queued','starting','running','waiting_user','waiting_approval','cancelling')").get(id))throw Error('active_run_mode_change');
 if(db.prepare("SELECT 1 FROM ga_conversation_goal_controls WHERE conversation_id=? AND state IN ('queued','dispatching')").get(id))throw Error('conversation_mode_goal_unconfirmed');
 if(db.prepare("SELECT 1 FROM ga_runs WHERE conversation_id=? AND native_session_ref IS NULL AND status<>'queued'").get(id))throw Error('conversation_mode_legacy_unconfirmed');
 return JSON.stringify({mode:c.mode,version:c.version,bindings:db.prepare('SELECT * FROM ga_conversation_mode_sessions WHERE conversation_id=? ORDER BY mode').all(id),work:db.prepare('SELECT * FROM ga_harness_session_bindings WHERE conversation_id=?').get(id),runs:db.prepare('SELECT id,status,native_session_ref,native_owner_id,native_conversation_id,execution_policy_json FROM ga_runs WHERE conversation_id=? ORDER BY id').all(id)});
}
