import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {decodeStoredContent} from './content.ts';
import {readLiteralMessageReferences,validateContentReference} from './content-reference.js';

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
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_message_reference_snapshots'").get())return false;
 const message=db.prepare(`SELECT m.content_json,c.owner_id,m.created_at FROM ga_messages m
  JOIN ga_conversations c ON c.id=m.conversation_id
  WHERE m.id=? AND c.id=? AND m.role='user' AND m.status='complete'`).get(messageId,conversationId);
 if(!message||typeof message.content_json!=='string'||typeof message.owner_id!=='string'||typeof message.created_at!=='string')return false;
 let references:Array<Record<string,unknown>>;
 try{references=readLiteralMessageReferences(decodeStoredContent(message.content_json).blocks);}catch{return false;}
 if(!references.length)return false;
 const referencesJson=canonicalJson(references);
 if(referencesJson.length>3200000)return false;
 const contentSha=sha(message.content_json),referencesSha=sha(referencesJson);
 const existing=db.prepare('SELECT * FROM ga_message_reference_snapshots WHERE message_id=?').get(messageId);
 if(existing){
  if(existing.conversation_id!==conversationId||existing.owner_id!==message.owner_id||existing.protocol!==1
   ||existing.content_sha256!==contentSha||existing.references_json!==referencesJson||existing.references_sha256!==referencesSha)throw Error('message_reference_snapshot_changed');
  return true;
 }
 db.prepare(`INSERT INTO ga_message_reference_snapshots
  (message_id,conversation_id,owner_id,protocol,content_sha256,references_json,references_sha256,created_at)
  VALUES(?,?,?,1,?,?,?,?)`).run(messageId,conversationId,message.owner_id,contentSha,referencesJson,referencesSha,message.created_at);
 return true;
}

export type MessageReferenceSnapshots={protocol:1;state:'ready'|'unavailable';items:Array<Record<string,unknown>>};
type Projection={reference_snapshots?:MessageReferenceSnapshots};

/** Only the record bound to this original owned message and content digest is public. */
export function messageReferenceProjection(db:DatabaseSync,row:Record<string,unknown>,ownerId?:string):Projection{
 if(row.role!=='user'||row.status!=='complete'||typeof row.id!=='string'||typeof row.conversation_id!=='string'||typeof row.content_json!=='string')return {};
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_message_reference_snapshots'").get())return {};
 const record=db.prepare('SELECT * FROM ga_message_reference_snapshots WHERE message_id=?').get(row.id);
 if(!record)return {};
 const unavailable:Projection={reference_snapshots:{protocol:1,state:'unavailable',items:[]}};
 const conversation=db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(row.conversation_id);
 if(!conversation||record.owner_id!==conversation.owner_id||ownerId!==undefined&&record.owner_id!==ownerId
  ||record.conversation_id!==row.conversation_id||record.protocol!==1||record.content_sha256!==sha(row.content_json)
  ||typeof record.references_json!=='string'||record.references_json.length>3200000||record.references_sha256!==sha(record.references_json))return unavailable;
 try{
  const parsed:unknown=JSON.parse(record.references_json);
  if(!Array.isArray(parsed)||!parsed.length||parsed.length>10000)return unavailable;
  const items=parsed.map(validateContentReference);
  if(canonicalJson(items)!==record.references_json)return unavailable;
  return {reference_snapshots:{protocol:1,state:'ready',items}};
 }catch{return unavailable;}
}
