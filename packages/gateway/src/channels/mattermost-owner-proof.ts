import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
export type MattermostOwnerAccount=Readonly<{instance:string;botUserId:string}>;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fail():never{throw Error('channel_binding_proof_invalid');}
export function mattermostOwnerAccount(input:MattermostOwnerAccount):MattermostOwnerAccount{
 const url=new URL(input.instance);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||input.instance!==url.origin||!ID.test(input.botUserId)||url.origin.length>200)fail();
 return Object.freeze({instance:url.origin,botUserId:input.botUserId});
}
export function mattermostOwnerBindingConfiguration(env:Readonly<Record<string,string|undefined>>){
 const instance=env.GENERAL_AGENT_MATTERMOST_BASE_URL,botUserId=env.GENERAL_AGENT_MATTERMOST_BOT_USER_ID,token=env.GENERAL_AGENT_MATTERMOST_BOT_TOKEN;
 if(instance===undefined&&botUserId===undefined&&token===undefined)return {};
 if(!instance||!botUserId||!token||token.length<16||/[\r\n]/.test(token))throw Error('mattermost_service_config_required');
 return {mattermostOwnerBinding:mattermostOwnerAccount({instance,botUserId})};
}
export function mattermostProofDigest(message:{principal:string;thread_id:string;message_id:string;text:string}){
 return hash(JSON.stringify({channel:'mattermost',principal:message.principal,threadId:message.thread_id,messageId:message.message_id,text:message.text.trim(),attachments:[]}));
}
export function mattermostProofIdentity(account:MattermostOwnerAccount,principal:string,thread:string){
 let p:unknown,t:unknown;try{p=JSON.parse(principal);t=JSON.parse(thread);}catch{fail();}
 if(!Array.isArray(p)||p.length!==3||p[0]!==account.instance||p[1]!==account.botUserId||typeof p[2]!=='string'||!ID.test(p[2])||p[2]===account.botUserId||JSON.stringify(p)!==principal
  ||!Array.isArray(t)||t.length!==2||typeof t[0]!=='string'||!ID.test(t[0])||t[1]!==''||JSON.stringify(t)!==thread)fail();
 return {userId:p[2] as string,channelId:t[0] as string};
}
export function installMattermostOwnerProof(db:DatabaseSync){
 if(Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)!==1)throw Error('mattermost_foreign_keys_required');
 const normalize=(sql:string)=>sql.replace(/IF NOT EXISTS\s*/gi,'').replace(/\s+/g,' ').trim().replace(/;$/,'');
 const definitions=`CREATE TABLE IF NOT EXISTS ga_mattermost_owner_challenges(
 challenge_id TEXT PRIMARY KEY NOT NULL REFERENCES ga_owner_channel_challenges(challenge_id),instance TEXT NOT NULL,bot_user_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ga_mattermost_owner_proofs(
 instance TEXT NOT NULL,bot_user_id TEXT NOT NULL,post_id TEXT NOT NULL,source_sha256 TEXT NOT NULL,
 challenge_id TEXT NOT NULL UNIQUE REFERENCES ga_owner_channel_challenges(challenge_id),channel_binding_id TEXT NOT NULL REFERENCES ga_owner_channel_bindings(channel_binding_id),
 owner_id TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL,binding_version INTEGER NOT NULL CHECK(typeof(binding_version)='integer' AND binding_version>=1),created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),
 PRIMARY KEY(instance,bot_user_id,post_id),CHECK(typeof(source_sha256)='text' AND length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'));
 CREATE TABLE IF NOT EXISTS ga_mattermost_binding_scopes(
 channel_binding_id TEXT PRIMARY KEY NOT NULL REFERENCES ga_owner_channel_bindings(channel_binding_id),owner_id TEXT NOT NULL,
 instance TEXT NOT NULL,bot_user_id TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ga_mattermost_ingress_observations(
 instance TEXT NOT NULL,bot_user_id TEXT NOT NULL,post_id TEXT NOT NULL,principal TEXT NOT NULL,provider_thread_id TEXT NOT NULL,
 source_sha256 TEXT NOT NULL CHECK(typeof(source_sha256)='text' AND length(source_sha256)=64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at>=0),PRIMARY KEY(instance,bot_user_id,post_id));`;
 withImmediateTransaction(db,()=>{
  for(const definition of definitions.split(';').map(value=>value.trim()).filter(Boolean)){
   const table=/CREATE TABLE IF NOT EXISTS (\w+)/.exec(definition)![1]!;
   db.exec(definition);
   const actual=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
   if(typeof actual?.sql!=='string'||normalize(actual.sql)!==normalize(definition))throw Error('mattermost_schema_mismatch');
   for(const operation of ['update','delete']){
    const name=`${table}_no_${operation}`,trigger=`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${operation.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'mattermost_source_immutable'); END`;
    db.exec(trigger);const row=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
    if(typeof row?.sql!=='string'||normalize(row.sql)!==normalize(trigger))throw Error('mattermost_schema_mismatch');
   }
  }
 });
}
const receipt=()=>({accepted:true as const,kind:'channel_binding' as const,status:'verified' as const});
export function lookupMattermostProof(db:DatabaseSync,account:MattermostOwnerAccount,input:unknown){
 const unproven={state:'unproven' as const,automatic_replay:false as const};
 return withImmediateTransaction(db,()=>{
  try{
   if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='message_id,principal,source_sha256,thread_id')return unproven;
   const row=input as Record<string,unknown>;
   if(typeof row.principal!=='string'||typeof row.thread_id!=='string'||typeof row.message_id!=='string'||!ID.test(row.message_id)||typeof row.source_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.source_sha256))return unproven;
   mattermostProofIdentity(account,row.principal,row.thread_id);
   const proof=db.prepare(`SELECT p.* FROM ga_mattermost_owner_proofs p JOIN ga_owner_channel_bindings b ON b.channel_binding_id=p.channel_binding_id
    JOIN ga_owner_channel_challenges c ON c.challenge_id=p.challenge_id AND c.channel='mattermost' AND c.status='consumed' AND c.owner_id=p.owner_id AND c.binding_id=p.channel_binding_id
    WHERE p.instance=? AND p.bot_user_id=? AND p.post_id=? AND p.source_sha256=? AND p.principal=? AND p.provider_thread_id=?
    AND b.channel='mattermost' AND b.owner_id=p.owner_id AND b.principal=p.principal AND b.status='verified' AND b.version=p.binding_version`)
    .get(account.instance,account.botUserId,row.message_id,row.source_sha256,row.principal,row.thread_id);
   if(!proof)return unproven;
   const scope=db.prepare('SELECT 1 FROM ga_mattermost_binding_scopes WHERE channel_binding_id=? AND owner_id=? AND instance=? AND bot_user_id=? AND principal=? AND provider_thread_id=?')
    .get(proof.channel_binding_id!,proof.owner_id!,account.instance,account.botUserId,row.principal,row.thread_id);
   return scope?{state:'observed' as const,receipt:receipt(),automatic_replay:false as const}:unproven;
  }catch{return unproven;}
 });
}
export function acceptMattermostProof(db:DatabaseSync,account:MattermostOwnerAccount,message:{principal:string;thread_id:string;message_id:string;text:string},now:number){
 mattermostProofIdentity(account,message.principal,message.thread_id);
 const match=/^\/jot-bind ([A-Za-z0-9_-]{43})$/.exec(message.text);if(!match||!ID.test(message.message_id))fail();
 const digest=mattermostProofDigest(message);
 return withImmediateTransaction(db,()=>{
  // Exact accepted events recover receipts even after challenge TTL; they never consume again.
  const known=db.prepare('SELECT source_sha256 FROM ga_mattermost_owner_proofs WHERE instance=? AND bot_user_id=? AND post_id=?').get(account.instance,account.botUserId,message.message_id);
  if(known){if(known.source_sha256!==digest)fail();const found=lookupMattermostProof(db,account,{principal:message.principal,thread_id:message.thread_id,message_id:message.message_id,source_sha256:digest});if(found.state!=='observed')fail();return found.receipt;}
  const challenge=db.prepare(`SELECT c.* FROM ga_owner_channel_challenges c JOIN ga_mattermost_owner_challenges s ON s.challenge_id=c.challenge_id
   WHERE c.channel='mattermost' AND c.code_hash=? AND s.instance=? AND s.bot_user_id=?`).get(hash(match[1]!),account.instance,account.botUserId);
  if(!challenge||challenge.status!=='pending'||Number(challenge.expires_at)<=now)fail();
  const existing=db.prepare("SELECT 1 FROM ga_owner_channel_bindings WHERE channel='mattermost' AND principal=? AND status='verified'").get(message.principal);if(existing)fail();
  const id=String(challenge.challenge_id),owner=String(challenge.owner_id);
  db.prepare('INSERT INTO ga_owner_channel_bindings(channel_binding_id,owner_id,channel,principal,status,version,verified_at,revoked_at,created_at) VALUES(?,?,?,?,?,1,?,NULL,?)').run(id,owner,'mattermost',message.principal,'verified',now,now);
  db.prepare('INSERT INTO ga_mattermost_binding_scopes(channel_binding_id,owner_id,instance,bot_user_id,principal,provider_thread_id) VALUES(?,?,?,?,?,?)').run(id,owner,account.instance,account.botUserId,message.principal,message.thread_id);
  db.prepare('INSERT INTO ga_mattermost_owner_proofs(instance,bot_user_id,post_id,source_sha256,challenge_id,channel_binding_id,owner_id,principal,provider_thread_id,binding_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(account.instance,account.botUserId,message.message_id,digest,id,id,owner,message.principal,message.thread_id,1,now);
  if(db.prepare("UPDATE ga_owner_channel_challenges SET status='consumed',binding_id=? WHERE challenge_id=? AND status='pending'").run(id,id).changes!==1)fail();
  return receipt();
 });
}
