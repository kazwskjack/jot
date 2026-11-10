import {assertOfficePrintProof} from './office-print-proof.ts';
import {validateAttachmentManifest} from '../artifacts/pinned-manifest.ts';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalJson} from '../db/canonical-json.ts';
import {decodeStoredContent} from './content.ts';
import {readLiteralMessageReferences,validateContentReference,validateReferenceSnapshotInput} from './content-reference.js';

export function installMessageReferenceSnapshots(db:DatabaseSync){
 db.exec(`CREATE TABLE IF NOT EXISTS ga_message_reference_snapshots (
  message_id TEXT PRIMARY KEY REFERENCES ga_messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,protocol INTEGER NOT NULL CHECK(protocol=1),
  content_sha256 TEXT NOT NULL,references_json TEXT NOT NULL CHECK(length(references_json)<=3200000),
  references_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS ga_message_reference_snapshot_immutable BEFORE UPDATE ON ga_message_reference_snapshots
 BEGIN SELECT RAISE(ABORT,'message_reference_snapshot_immutable'); END;
 CREATE TABLE IF NOT EXISTS ga_run_command_reference_snapshots (
  command_id TEXT PRIMARY KEY REFERENCES ga_run_commands(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ga_conversations(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,protocol INTEGER NOT NULL CHECK(protocol=1),command_payload_sha256 TEXT NOT NULL,
  references_json TEXT NOT NULL CHECK(length(references_json)<=3200000),references_sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS ga_command_reference_snapshot_immutable BEFORE UPDATE ON ga_run_command_reference_snapshots
 BEGIN SELECT RAISE(ABORT,'command_reference_snapshot_immutable'); END;`);
}

export const messageReferenceSnapshotsInstalled=(db:DatabaseSync)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_message_reference_snapshots'").get());

export const commandReferenceSnapshotsInstalled=(db:DatabaseSync)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_run_command_reference_snapshots'").get());

export function assertReferenceSnapshotImages(db:DatabaseSync,ownerId:string,conversationId:string,items:Array<Record<string,unknown>>,officePrintProofKey?:string){
 for(const value of items){
  const reference=validateContentReference(value) as {reference:{selectionMode:string};image_artifact?:{artifact_id:string;version:number;sha256:string;size_bytes:number}};
  assertOfficePrintProof(officePrintProofKey,ownerId,value);
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
 const message=db.prepare(`SELECT m.id,m.run_id,m.client_message_id,m.content_json,c.owner_id,m.created_at FROM ga_messages m
  JOIN ga_conversations c ON c.id=m.conversation_id
  WHERE m.id=? AND c.id=? AND m.role='user' AND m.status='complete'`).get(messageId,conversationId);
 if(!message||typeof message.content_json!=='string'||typeof message.owner_id!=='string'||typeof message.created_at!=='string')return false;
 if(declared===undefined)declared=readCommandReferenceSnapshots(db,conversationId,message);
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


/** The caller's original command transaction owns metadata and payload binding. */
export function captureRunCommandReferenceSnapshots(db:DatabaseSync,runId:string,ownerId:string,commandId:string,items:Array<Record<string,unknown>>){
 if(!db.isTransaction)throw Error('message_reference_transaction_required');
 if(!commandReferenceSnapshotsInstalled(db))throw Error('content_reference_storage_unavailable');
 const references=validateReferenceSnapshotInput({protocol:1,items}).items;
 const command=db.prepare(`SELECT cmd.*,r.conversation_id,c.owner_id FROM ga_run_commands cmd
  JOIN ga_runs r ON r.id=cmd.run_id JOIN ga_conversations c ON c.id=r.conversation_id
  WHERE cmd.id=? AND cmd.run_id=? AND c.owner_id=?`).get(commandId,runId,ownerId);
 if(!command||command.kind!=='steer'||!['pending','applied'].includes(String(command.status))||typeof command.payload_json!=='string'){
  throw Error('content_reference_request_conflict');
 }
 let payload:Record<string,unknown>;
 try{payload=JSON.parse(command.payload_json);}catch{throw Error('content_reference_request_conflict');}
 const referencesJson=canonicalJson(references);
 if(!payload||typeof payload.text!=='string'
  ||canonicalJson(readLiteralMessageReferences([{kind:'text',text:payload.text}]))!==referencesJson){
  throw Error('content_reference_request_conflict');
 }
 const existing=db.prepare('SELECT * FROM ga_run_command_reference_snapshots WHERE command_id=?').get(commandId);
 if(existing){
  const stored=storedReferenceItems(existing);
  if(existing.run_id!==runId||existing.conversation_id!==command.conversation_id||existing.owner_id!==ownerId
   ||existing.command_payload_sha256!==sha(command.payload_json)||!stored||canonicalJson(stored)!==referencesJson){
   throw Error('content_reference_request_conflict');
  }
  return;
 }
 db.prepare(`INSERT INTO ga_run_command_reference_snapshots
  (command_id,run_id,conversation_id,owner_id,protocol,command_payload_sha256,references_json,references_sha256,created_at)
  VALUES(?,?,?,?,1,?,?,?,?)`).run(commandId,runId,command.conversation_id!,ownerId,sha(command.payload_json),referencesJson,sha(referencesJson),command.created_at!);
}

function readCommandReferenceSnapshots(db:DatabaseSync,conversationId:string,message:Record<string,unknown>){
 if(typeof message.id!=='string'||!message.id.startsWith('message-')||!commandReferenceSnapshotsInstalled(db))return undefined;
 const commandId=message.id.slice(8);
 const record=db.prepare('SELECT * FROM ga_run_command_reference_snapshots WHERE command_id=?').get(commandId);
 if(!record)return undefined;
 const command=db.prepare(`SELECT cmd.*,r.conversation_id,c.owner_id FROM ga_run_commands cmd
  JOIN ga_runs r ON r.id=cmd.run_id JOIN ga_conversations c ON c.id=r.conversation_id
  WHERE cmd.id=? AND cmd.run_id=? AND c.id=?`).get(commandId,message.run_id!,conversationId);
 const items=storedReferenceItems(record);
 if(!command||command.kind!=='steer'||!['pending','applied'].includes(String(command.status))||typeof command.payload_json!=='string'
  ||command.owner_id!==message.owner_id||record.owner_id!==message.owner_id||record.run_id!==message.run_id
  ||record.conversation_id!==conversationId||record.command_payload_sha256!==sha(command.payload_json)||!items){
  throw Error('command_reference_snapshot_changed');
 }
 let payload:Record<string,unknown>,attachments:readonly {artifact_id:string}[]=[];
 try{
  payload=JSON.parse(command.payload_json);
  if(payload.content_protocol===1){
   attachments=validateAttachmentManifest(payload.attachment_manifest,{maxCount:10,maxAggregateBytes:200*1024*1024}).attachments;
  }
 }catch{throw Error('command_reference_snapshot_changed');}
 const expected=JSON.stringify({blocks:[{block_id:message.id+':text',kind:'text',text:payload.text}],attachments:attachments.map(item=>item.artifact_id)});
 if(typeof payload.text!=='string'||!payload.text.trim()||payload.client_message_id!==message.client_message_id||message.content_json!==expected){
  throw Error('command_reference_snapshot_changed');
 }
 return items;
}
