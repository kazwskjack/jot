import {requireMattermostSourceKind} from './mattermost-source-kind.ts';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {canonicalJson} from '../db/canonical-json.ts';
import {readVerifiedChannelBinding} from './authority-proofs.ts';
import {mattermostProofDigest,type MattermostOwnerAccount} from './mattermost-owner-proof.ts';
import {requireMattermostConfiguredAccount,requireMattermostBindingThread,mattermostTextIdentity} from './mattermost-thread-scope.ts';
import type {ProviderAttachmentDescriptor} from './runtime-contracts.ts';
export type MattermostTextWire={channel:'mattermost';principal:string;thread_id:string;message_id:string;text:string;attachments:readonly ProviderAttachmentDescriptor[]};
function requireNoMattermostProofPost(db:DatabaseSync,account:MattermostOwnerAccount,postId:string){
 withImmediateTransaction(db,()=>requireMattermostSourceKind(db,account,postId,'text'));
}
export function requireNoMattermostTextPost(db:DatabaseSync,account:MattermostOwnerAccount,postId:string){
 requireMattermostSourceKind(db,account,postId,'proof');
}
export function installMattermostTextControl(db:DatabaseSync){
 if(Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)!==1)throw Error('mattermost_foreign_keys_required');
 const definition=`CREATE TABLE IF NOT EXISTS ga_mattermost_text_observations(
 instance TEXT NOT NULL,bot_user_id TEXT NOT NULL,post_id TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL CHECK(typeof(source_sha256)='text' AND length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),source_json TEXT NOT NULL CHECK(typeof(source_json)='text' AND length(CAST(source_json AS BLOB))<=32768 AND json_valid(source_json)),
 owner_id TEXT NOT NULL,channel_binding_id TEXT NOT NULL REFERENCES ga_owner_channel_bindings(channel_binding_id),
 binding_version INTEGER NOT NULL CHECK(typeof(binding_version)='integer' AND binding_version>=1),created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 PRIMARY KEY(instance,bot_user_id,post_id))`;
 const normalize=(s:string)=>s.replace(/IF NOT EXISTS\s*/gi,'').replace(/\s+/g,' ').trim();
 withImmediateTransaction(db,()=>{
  db.exec(definition);const actual=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ga_mattermost_text_observations'").get();
  if(typeof actual?.sql!=='string'||normalize(actual.sql)!==normalize(definition))throw Error('mattermost_text_schema_mismatch');
  for(const op of ['update','delete']){const name='ga_mattermost_text_observations_no_'+op,sql=`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${op.toUpperCase()} ON ga_mattermost_text_observations BEGIN SELECT RAISE(ABORT,'mattermost_source_immutable'); END`;
   db.exec(sql);const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);if(typeof row?.sql!=='string'||normalize(row.sql)!==normalize(sql))throw Error('mattermost_text_schema_mismatch');}
 });
}
export function normalizeMattermostTextWire(input:unknown):MattermostTextWire{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='attachments,channel,message_id,principal,text,thread_id')throw Error('mattermost_text_source_invalid');
 const source=input as Record<string,unknown>;
 if(source.channel!=='mattermost'||typeof source.principal!=='string'||typeof source.thread_id!=='string'||typeof source.message_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(source.message_id)||typeof source.text!=='string'||!source.text.trim()||source.text.length>4000||source.text!==source.text.trim()||source.text.startsWith('/jot-bind')||!Array.isArray(source.attachments)||source.attachments.length)throw Error('mattermost_text_source_invalid');
 mattermostTextIdentity(source.principal,source.thread_id);
 if(Buffer.byteLength(canonicalJson(source))>32768)throw Error('mattermost_text_source_invalid');
 return source as MattermostTextWire;
}
export function proveMattermostTextObservation(db:DatabaseSync,account:MattermostOwnerAccount,row:Record<string,unknown>){
 requireNoMattermostProofPost(db,account,String(row.post_id));
 if(typeof row.source_json!=='string'||Buffer.byteLength(row.source_json)>32768)throw Error('mattermost_text_source_invalid');
 const source=normalizeMattermostTextWire(JSON.parse(row.source_json));
 if(canonicalJson(source)!==row.source_json||mattermostProofDigest(source)!==row.source_sha256||row.instance!==account.instance||row.bot_user_id!==account.botUserId||row.post_id!==source.message_id||row.principal!==source.principal||row.provider_thread_id!==source.thread_id)throw Error('mattermost_text_source_conflict');
 requireMattermostConfiguredAccount(account,source.principal,source.thread_id);
 return withImmediateTransaction(db,()=>{
  requireNoMattermostProofPost(db,account,source.message_id);
  const binding=readVerifiedChannelBinding(db,'mattermost',source.principal);requireMattermostBindingThread(db,binding,source.thread_id);
  if(binding.owner_id!==row.owner_id||binding.channel_binding_id!==row.channel_binding_id||binding.version!==Number(row.binding_version))throw Error('mattermost_text_binding_changed');
  return source;
 });
}
export function currentMattermostTextSource(db:DatabaseSync,account:MattermostOwnerAccount,postId:string){
 const row=db.prepare('SELECT * FROM ga_mattermost_text_observations WHERE instance=? AND bot_user_id=? AND post_id=?').get(account.instance,account.botUserId,postId);
 if(!row)throw Error('mattermost_text_source_invalid');return proveMattermostTextObservation(db,account,row);
}
export function freezeMattermostText(db:DatabaseSync,account:MattermostOwnerAccount,message:MattermostTextWire){
 const source=normalizeMattermostTextWire(message),identity=requireMattermostConfiguredAccount(account,message.principal,message.thread_id),digest=mattermostProofDigest(source);
 return withImmediateTransaction(db,()=>{
  requireNoMattermostProofPost(db,account,source.message_id);
  const binding=readVerifiedChannelBinding(db,'mattermost',source.principal);requireMattermostBindingThread(db,binding,source.thread_id);
  const existing=db.prepare('SELECT * FROM ga_mattermost_text_observations WHERE instance=? AND bot_user_id=? AND post_id=?').get(account.instance,account.botUserId,source.message_id);
  if(existing){if(existing.source_sha256!==digest||existing.source_json!==canonicalJson(source)||existing.owner_id!==binding.owner_id||existing.channel_binding_id!==binding.channel_binding_id||Number(existing.binding_version)!==binding.version)throw Error('mattermost_text_source_conflict');return {previous:true,source};}
  db.prepare(`INSERT INTO ga_mattermost_text_observations(instance,bot_user_id,post_id,principal,provider_thread_id,source_sha256,source_json,owner_id,channel_binding_id,binding_version,created_at)
   VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(identity.instance,identity.botUserId,source.message_id,source.principal,source.thread_id,digest,canonicalJson(source),binding.owner_id,binding.channel_binding_id,binding.version,Math.floor(Date.now()/1000));
  return {previous:false,source};
 });
}
/** Original account+post cannot move into another principal/root after admission. */
export function requireMattermostOriginalPost(db:DatabaseSync,principal:string,thread:string,post:string){
 if(!db.isTransaction)throw Error('channel_authority_transaction_required');
 const identity=mattermostTextIdentity(principal,thread);
 requireNoMattermostProofPost(db,identity,post);
 for(const row of db.prepare("SELECT principal,provider_thread_id FROM ga_channel_message_events WHERE channel='mattermost' AND provider_message_id=?").all(post)){
  const prior=mattermostTextIdentity(String(row.principal),String(row.provider_thread_id));
  if(prior.instance===identity.instance&&prior.botUserId===identity.botUserId&&(row.principal!==principal||row.provider_thread_id!==thread))throw Error('channel_cached_event_source_mismatch');
 }
}
