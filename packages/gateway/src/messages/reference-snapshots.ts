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

export const messageReferenceSnapshotsInstalled=(db:DatabaseSync)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_message_reference_snapshots'").get());

export function assertReferenceSnapshotImages(db:DatabaseSync,ownerId:string,conversationId:string,items:Array<Record<string,unknown>>){
 for(const value of items){
  const reference=validateContentReference(value) as {reference:{selectionMode:string};image_artifact?:{artifact_id:string;version:number;sha256:string;size_bytes:number}};
  if(reference.reference.selectionMode!=='region')continue;
  const image=reference.image_artifact!;
  const row=db.prepare(`SELECT a.current_version,v.sha256,v.size_bytes,v.mime_type,v.metadata_json FROM ga_artifacts a
   JOIN ga_artifact_versions v ON v.artifact_id=a.id AND v.version=?
   WHERE a.id=? AND a.owner_id=? AND a.conversation_id=?`).get(image.version,image.artifact_id,ownerId,conversationId);
  let metadata:Record<string,unknown>|undefined;
  try{metadata=JSON.parse(String(row?.metadata_json??'null'));}catch{throw Error('content_reference_attachment_mismatch');}
  if(!row||row.current_version!==image.version||row.sha256!==image.sha256||row.size_bytes!==image.size_bytes||row.mime_type!=='image/png'
   ||metadata?.status!=='ready'||metadata?.origin!=='upload')throw Error('content_reference_attachment_mismatch');
 }
}

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Original message/event or fork transaction owns capture. Literal user context
 * receives a typed snapshot with the exact stored input digest and original owner. */
export function captureMessageReferenceSnapshots(db:DatabaseSync,conversationId:string,messageId:string,declared?:Array<Record<string,unknown>>){
 if(!db.isTransaction)throw Error('message_reference_transaction_required');
 if(declared!==undefined&&(!Array.isArray(declared)||!declared.length||declared.length>10000))throw Error('content_reference_request_invalid');
 if(!messageReferenceSnapshotsInstalled(db)){if(declared!==undefined)throw Error('content_reference_storage_unavailable');return false;}
 const message=db.prepare(`SELECT m.content_json,c.owner_id,m.created_at FROM ga_messages m
  JOIN ga_conversations c ON c.id=m.conversation_id
  WHERE m.id=? AND c.id=? AND m.role='user' AND m.status='complete'`).get(messageId,conversationId);
 if(!message||typeof message.content_json!=='string'||typeof message.owner_id!=='string'||typeof message.created_at!=='string')return false;
 const contentSha=sha(message.content_json);
 const existing=db.prepare('SELECT * FROM ga_message_reference_snapshots WHERE message_id=?').get(messageId);
 if(existing){
  const items=storedReferenceItems(existing);
  if(existing.conversation_id!==conversationId||existing.owner_id!==message.owner_id||existing.content_sha256!==contentSha||!items
   ||declared!==undefined&&canonicalJson(items)!==canonicalJson(declared))throw Error('message_reference_snapshot_changed');
  return true;
 }
 let references:Array<Record<string,unknown>>;
 try{references=declared===undefined?readLiteralMessageReferences(decodeStoredContent(message.content_json).blocks):declared.map(validateContentReference);}
 catch{if(declared!==undefined)throw Error('content_reference_request_invalid');return false;}
 if(!references.length)return false;
 const referencesJson=canonicalJson(references);
 if(referencesJson.length>3200000){if(declared!==undefined)throw Error('content_reference_request_too_large');return false;}
 const referencesSha=sha(referencesJson);
 db.prepare(`INSERT INTO ga_message_reference_snapshots
  (message_id,conversation_id,owner_id,protocol,content_sha256,references_json,references_sha256,created_at)
  VALUES(?,?,?,1,?,?,?,?)`).run(messageId,conversationId,message.owner_id,contentSha,referencesJson,referencesSha,message.created_at);
 return true;
}

function storedReferenceItems(record:Record<string,unknown>):Array<Record<string,unknown>>|undefined{
 if(record.protocol!==1||typeof record.references_json!=='string'||record.references_json.length>3200000||record.references_sha256!==sha(record.references_json))return;
 try{
  const parsed:unknown=JSON.parse(record.references_json);
  if(!Array.isArray(parsed)||!parsed.length||parsed.length>10000)return;
  const items=parsed.map(validateContentReference);
  return canonicalJson(items)===record.references_json?items:undefined;
 }catch{return;}
}

export type MessageReferenceSnapshots={protocol:1;state:'ready'|'unavailable';items:Array<Record<string,unknown>>};
type Projection={reference_snapshots?:MessageReferenceSnapshots};

/** Only the record bound to this original owned message and content digest is public. */
export function messageReferenceProjection(db:DatabaseSync,row:Record<string,unknown>,ownerId?:string):Projection{
 if(row.role!=='user'||row.status!=='complete'||typeof row.id!=='string'||typeof row.conversation_id!=='string'||typeof row.content_json!=='string')return {};
 if(!messageReferenceSnapshotsInstalled(db))return {};
 const record=db.prepare('SELECT * FROM ga_message_reference_snapshots WHERE message_id=?').get(row.id);
 if(!record)return {};
 const unavailable:Projection={reference_snapshots:{protocol:1,state:'unavailable',items:[]}};
 const conversation=db.prepare('SELECT owner_id FROM ga_conversations WHERE id=?').get(row.conversation_id);
 if(!conversation||record.owner_id!==conversation.owner_id||ownerId!==undefined&&record.owner_id!==ownerId
  ||record.conversation_id!==row.conversation_id||record.content_sha256!==sha(row.content_json))return unavailable;
 const items=storedReferenceItems(record);
 return items?{reference_snapshots:{protocol:1,state:'ready',items}}:unavailable;
}
