import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalModelJson} from './model-policy.ts';
export const CHAT_CHECKPOINT_REVISION='checkpoint-text-v2';
export const checkpointDigest=(v:unknown)=>createHash('sha256').update(canonicalModelJson(v)).digest('hex');
export const checkpointTextHash=(v:string)=>createHash('sha256').update(v).digest('hex');
export type CoveredMessage={message_id:string;source_content_sha256:string;updated_at:string};
export type CheckpointData={protocol:1;checkpoint_id:string;owner_id:string;conversation_id:string;session_id:string;run_id:string;intent_id:string;attempt_id:string;source_sha256:string;policy:Record<string,unknown>;parent_checkpoint_id:string|null;parent_checkpoint_sha256:string|null;summary_text:string;witness:Record<string,unknown>;coverage:CoveredMessage[]};
export type StoredCheckpoint={data:CheckpointData;sha256:string};
export const checkpointFailure=():never=>{throw Error('chat_checkpoint_unconfirmed');};
export function installChatCheckpoints(db:DatabaseSync){db.exec(`CREATE TABLE IF NOT EXISTS ga_chat_compaction_checkpoints (
 checkpoint_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE REFERENCES ga_chat_compaction_attempts(attempt_id) ON DELETE CASCADE,
 intent_id TEXT NOT NULL UNIQUE,owner_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL UNIQUE,
 parent_checkpoint_id TEXT REFERENCES ga_chat_compaction_checkpoints(checkpoint_id) ON DELETE CASCADE,
 checkpoint_json TEXT NOT NULL,checkpoint_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS ga_chat_checkpoint_immutable BEFORE UPDATE ON ga_chat_compaction_checkpoints
 BEGIN SELECT RAISE(ABORT,'chat_checkpoint_immutable'); END;`);}
export function readStoredChatCheckpoint(db:DatabaseSync,id:string):StoredCheckpoint{
 const row=db.prepare('SELECT * FROM ga_chat_compaction_checkpoints WHERE checkpoint_id=?').get(id);if(!row||typeof row.checkpoint_json!=='string'||checkpointTextHash(row.checkpoint_json)!==row.checkpoint_sha256)return checkpointFailure();
 const data=JSON.parse(row.checkpoint_json) as CheckpointData;
 if(canonicalModelJson(data)!==row.checkpoint_json||data.protocol!==1||data.checkpoint_id!==id||['owner_id','conversation_id','session_id','run_id','intent_id','attempt_id','parent_checkpoint_id'].some(k=>data[k as keyof CheckpointData]!==row[k])||typeof data.summary_text!=='string'||!data.summary_text.trim()||data.summary_text.length>6000||!Array.isArray(data.coverage))return checkpointFailure();
 return{data,sha256:String(row.checkpoint_sha256)};
}
export function latestChatCheckpoint(db:DatabaseSync,owner:string,conversation:string,session:string,policy:Record<string,unknown>):StoredCheckpoint|null{
 const rows=db.prepare('SELECT checkpoint_id FROM ga_chat_compaction_checkpoints WHERE owner_id=? AND conversation_id=? AND session_id=? ORDER BY rowid DESC').all(owner,conversation,session);
 for(const row of rows){const value=readStoredChatCheckpoint(db,String(row.checkpoint_id)),p=value.data.policy;if(['context_revision','preset_id','preset_revision','thinking','mode'].every(k=>p[k]===policy[k])&&canonicalModelJson(p.model)===canonicalModelJson(policy.model))return value;}return null;
}
/** Follow immutable parent links; do not duplicate all historic coverage in each
 * checkpoint or expose those records in the model-facing context. */
export function coveredChatMessages(db:DatabaseSync,checkpoint:StoredCheckpoint):CoveredMessage[]{
 const result:CoveredMessage[]=[],seen=new Set<string>();let current:StoredCheckpoint|null=checkpoint;
 while(current){const d:CheckpointData=current.data;if(seen.has(d.checkpoint_id))return checkpointFailure();seen.add(d.checkpoint_id);if(d.owner_id!==checkpoint.data.owner_id||d.conversation_id!==checkpoint.data.conversation_id||d.session_id!==checkpoint.data.session_id)return checkpointFailure();result.push(...d.coverage);
  if(d.parent_checkpoint_id===null)break;const parent:StoredCheckpoint=readStoredChatCheckpoint(db,d.parent_checkpoint_id);if(parent.sha256!==d.parent_checkpoint_sha256)return checkpointFailure();current=parent;
 }return result;
}
