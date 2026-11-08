import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {readVerifiedChannelBinding} from './authority-proofs.ts';
import {requireMattermostConfiguredAccount,requireMattermostBindingThread,mattermostTextIdentity} from './mattermost-thread-scope.ts';
import {requireMattermostSourceKind,mattermostStageSources,mattermostTableExists} from './mattermost-source-kind.ts';
import {normalizeChannelAttachmentRequestDeclarationV2} from './attachment-forward-v2.ts';
import {normalizeChannelStageRequestV2,channelStageRequestDigestV2} from './attachment-stage-v2.ts';
import {normalizeChannelAttachmentManifestV2,type ChannelAttachmentSourceV2} from './attachment-manifest-v2.ts';
import type {MattermostOwnerAccount} from './mattermost-owner-proof.ts';
import type {ChannelAttachmentRequestDeclarationV2} from './runtime-contracts.ts';
export function installMattermostAttachmentControl(db:DatabaseSync){
 if(Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)!==1)throw Error('mattermost_foreign_keys_required');
 const definition=`CREATE TABLE IF NOT EXISTS ga_mattermost_attachment_observations(
 instance TEXT NOT NULL,bot_user_id TEXT NOT NULL,post_id TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL CHECK(typeof(source_sha256)='text' AND length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),source_json TEXT NOT NULL CHECK(typeof(source_json)='text' AND length(CAST(source_json AS BLOB))<=65536 AND json_valid(source_json)),
 owner_id TEXT NOT NULL,channel_binding_id TEXT NOT NULL REFERENCES ga_owner_channel_bindings(channel_binding_id),
 binding_version INTEGER NOT NULL CHECK(typeof(binding_version)='integer' AND binding_version>=1),created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 PRIMARY KEY(instance,bot_user_id,post_id))`;
 const normalize=(s:string)=>s.replace(/IF NOT EXISTS\s*/gi,'').replace(/\s+/g,' ').trim();
 withImmediateTransaction(db,()=>{
  db.exec(definition);const actual=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ga_mattermost_attachment_observations'").get();
  if(typeof actual?.sql!=='string'||normalize(actual.sql)!==normalize(definition))throw Error('mattermost_attachment_schema_mismatch');
  for(const op of ['update','delete']){const name='ga_mattermost_attachment_observations_no_'+op,sql=`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${op.toUpperCase()} ON ga_mattermost_attachment_observations BEGIN SELECT RAISE(ABORT,'mattermost_source_immutable'); END`;
   db.exec(sql);const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);if(typeof row?.sql!=='string'||normalize(row.sql)!==normalize(sql))throw Error('mattermost_attachment_schema_mismatch');}
 });
}
function declaration(input:unknown){
 const source=normalizeChannelAttachmentRequestDeclarationV2(input);
 if(source.event.channel!=='mattermost'||Buffer.byteLength(canonicalJson(source))>65536)throw Error('mattermost_attachment_source_invalid');
 return source;
}
function originalScope(db:DatabaseSync,account:MattermostOwnerAccount,event:{principal:string;thread_id:string;message_id:string}){
 requireMattermostConfiguredAccount(account,event.principal,event.thread_id);
 const binding=readVerifiedChannelBinding(db,'mattermost',event.principal);requireMattermostBindingThread(db,binding,event.thread_id);requireMattermostSourceKind(db,account,event.message_id,'attachment');return binding;
}
export function readMattermostAttachmentBinding(db:DatabaseSync,account:MattermostOwnerAccount,event:{principal:string;thread_id:string;message_id:string}){
 return withImmediateTransaction(db,()=>originalScope(db,account,event));
}
function scoped(source:ChannelAttachmentRequestDeclarationV2,scope:{owner_id:string;channel_binding_id:string;version:number}){
 return normalizeChannelStageRequestV2(source,{owner_id:scope.owner_id,channel_binding_id:scope.channel_binding_id,binding_version:scope.version,conversation_id:'observation-only'});
}
export function proveMattermostAttachmentObservation(db:DatabaseSync,account:MattermostOwnerAccount,row:Record<string,unknown>){
 if(typeof row.source_json!=='string'||Buffer.byteLength(row.source_json)>65536)throw Error('mattermost_attachment_source_invalid');
 const source=declaration(JSON.parse(row.source_json));
 if(canonicalJson(source)!==row.source_json||row.instance!==account.instance||row.bot_user_id!==account.botUserId||row.post_id!==source.event.message_id||row.principal!==source.event.principal||row.provider_thread_id!==source.event.thread_id)throw Error('mattermost_attachment_source_conflict');
 return withImmediateTransaction(db,()=>{
  const binding=originalScope(db,account,source.event);
  if(binding.owner_id!==row.owner_id||binding.channel_binding_id!==row.channel_binding_id||binding.version!==Number(row.binding_version)||channelStageRequestDigestV2(scoped(source,binding))!==row.source_sha256)throw Error('mattermost_attachment_source_conflict');
  return source;
 });
}
export function currentMattermostAttachmentObservation(db:DatabaseSync,account:MattermostOwnerAccount,postId:string){
 if(!mattermostTableExists(db,'ga_mattermost_attachment_observations'))return undefined;
 const row=db.prepare('SELECT * FROM ga_mattermost_attachment_observations WHERE instance=? AND bot_user_id=? AND post_id=?').get(account.instance,account.botUserId,postId);
 return row?proveMattermostAttachmentObservation(db,account,row):undefined;
}
/** Source-kind, scope and original account/post remain fixed even for bare pending stages. */
export function requireStableMattermostAttachmentSource(db:DatabaseSync,source:ChannelAttachmentSourceV2){
 if(source.event.channel!=='mattermost')return;
 if(!db.isTransaction)throw Error('channel_authority_transaction_required');
 declaration({protocol:2,event:source.event,text:source.text,attachments:source.attachments.map(({index,provider_file_id,file_name,media_type,size_bytes,sha256})=>({index,provider_file_id,file_name,media_type,size_bytes,sha256}))});
 const account=mattermostTextIdentity(source.event.principal,source.event.thread_id);
 requireMattermostSourceKind(db,account,source.event.message_id,'attachment');
 const hash=channelStageRequestDigestV2(source),observed=currentMattermostAttachmentObservation(db,account,source.event.message_id);
 if(observed){
  const row=db.prepare('SELECT source_sha256 FROM ga_mattermost_attachment_observations WHERE instance=? AND bot_user_id=? AND post_id=?').get(account.instance,account.botUserId,source.event.message_id)!;
  if(row.source_sha256!==hash)throw Error('channel_attachment_event_conflict');
 }
 const originals=mattermostStageSources(db,account,source.event.message_id);
 for(const event of db.prepare("SELECT * FROM ga_channel_message_events WHERE channel='mattermost' AND provider_message_id=?").all(source.event.message_id)){
  const identity=mattermostTextIdentity(String(event.principal),String(event.provider_thread_id));if(identity.instance===account.instance&&identity.botUserId===account.botUserId)originals.push(JSON.parse(String(event.attachments_json)).source);
 }
 for(const original of originals)if(channelStageRequestDigestV2(normalizeChannelAttachmentManifestV2(original).source)!==hash)throw Error('channel_attachment_event_conflict');
}
export function freezeMattermostAttachments(db:DatabaseSync,account:MattermostOwnerAccount,input:unknown,expected:ReturnType<typeof readVerifiedChannelBinding>){
 const source=declaration(input);
 return withImmediateTransaction(db,()=>{
  const binding=originalScope(db,account,source.event);
  if(binding.owner_id!==expected.owner_id||binding.channel_binding_id!==expected.channel_binding_id||binding.version!==expected.version)throw Error('mattermost_attachment_binding_changed');
  const normalized=scoped(source,binding);requireStableMattermostAttachmentSource(db,normalized);const hash=channelStageRequestDigestV2(normalized);
  const previous=db.prepare('SELECT * FROM ga_mattermost_attachment_observations WHERE instance=? AND bot_user_id=? AND post_id=?').get(account.instance,account.botUserId,source.event.message_id);
  if(previous){if(previous.source_sha256!==hash||previous.source_json!==canonicalJson(source))throw Error('mattermost_attachment_source_conflict');proveMattermostAttachmentObservation(db,account,previous);return{source,previous:true};}
  db.prepare(`INSERT INTO ga_mattermost_attachment_observations(instance,bot_user_id,post_id,principal,provider_thread_id,source_sha256,source_json,owner_id,channel_binding_id,binding_version,created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(account.instance,account.botUserId,source.event.message_id,source.event.principal,source.event.thread_id,hash,canonicalJson(source),binding.owner_id,binding.channel_binding_id,binding.version,Math.floor(Date.now()/1000));
  return{source,previous:false};
 });
}
