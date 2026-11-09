import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {decodeStoredContent} from './content.ts';
import {readLiteralMessageReferences} from './content-reference.js';

export function installMessageReferenceSnapshots(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS ga_message_reference_snapshots (
  message_id TEXT PRIMARY KEY REFERENCES ga_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,protocol INTEGER NOT NULL CHECK(protocol=1),
  content_sha256 TEXT NOT NULL,references_json TEXT NOT NULL CHECK(length(references_json)<=3200000),
  references_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS ga_message_reference_snapshot_immutable BEFORE UPDATE ON ga_message_reference_snapshots
 BEGIN SELECT RAISE(ABORT,'message_reference_snapshot_immutable'); END;`);
}

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Original message/event or fork transaction owns capture. Literal user context
 * receives a typed snapshot with the exact stored input digest and original owner. */
export function captureMessageReferenceSnapshots(db:DatabaseSync,conversationId:string,messageId:string){
 if(!db.isTransaction)throw Error('message_reference_transaction_required');
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_message_reference_snapshots'").get())return;
 const message=db.prepare(`SELECT m.content_json,c.owner_id,m.created_at FROM ga_messages m
  JOIN ga_conversations c ON c.id=m.conversation_id
  WHERE m.id=? AND c.id=? AND m.role='user' AND m.status='complete'`).get(messageId,conversationId);
 if(!message||typeof message.content_json!=='string'||typeof message.owner_id!=='string'||typeof message.created_at!=='string')return;
 let references:Array<Record<string,unknown>>;
 try{references=readLiteralMessageReferences(decodeStoredContent(message.content_json).blocks);}catch{return;}
 if(!references.length)return;
 const referencesJson=canonicalJson(references);
 if(referencesJson.length>3200000)return;
 const contentSha=sha(message.content_json),referencesSha=sha(referencesJson);
 const existing=db.prepare('SELECT * FROM ga_message_reference_snapshots WHERE message_id=?').get(messageId);
 if(existing){
  if(existing.conversation_id!==conversationId||existing.owner_id!==message.owner_id||existing.protocol!==1
   ||existing.content_sha256!==contentSha||existing.references_json!==referencesJson||existing.references_sha256!==referencesSha)throw Error('message_reference_snapshot_changed');
  return;
 }
 db.prepare(`INSERT INTO ga_message_reference_snapshots
  (message_id,conversation_id,owner_id,protocol,content_sha256,references_json,references_sha256,created_at)
  VALUES(?,?,?,1,?,?,?,?)`).run(messageId,conversationId,message.owner_id,contentSha,referencesJson,referencesSha,message.created_at);
}
