import {createHash,randomBytes,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
type Row=Record<string,any>;
const digest=(code:string)=>createHash('sha256').update(code).digest('hex');
export class OwnerChannelBindings{
 private readonly db:DatabaseSync;private readonly now:()=>number;private readonly enabled:ReadonlyArray<string>;
 constructor(db:DatabaseSync,options:{enabled?:ReadonlyArray<string>;now?:()=>number}={}){
  this.db=db;this.enabled=options.enabled??[];this.now=options.now??(()=>Math.floor(Date.now()/1000));
  db.exec(`CREATE TABLE IF NOT EXISTS ga_owner_channel_challenges (
    challenge_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,channel TEXT NOT NULL,code_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,binding_id TEXT);
    CREATE INDEX IF NOT EXISTS ga_owner_channel_challenge_owner ON ga_owner_channel_challenges(owner_id,created_at);
    CREATE TABLE IF NOT EXISTS ga_owner_channel_bindings (
    channel_binding_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,channel TEXT NOT NULL,principal TEXT NOT NULL,
    status TEXT NOT NULL,version INTEGER NOT NULL,verified_at INTEGER NOT NULL,revoked_at INTEGER,created_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS ga_owner_channel_principal ON ga_owner_channel_bindings(channel,principal) WHERE status='verified';
    CREATE TRIGGER IF NOT EXISTS ga_owner_channel_binding_identity BEFORE UPDATE OF channel_binding_id,owner_id,channel,principal ON ga_owner_channel_bindings
    BEGIN SELECT RAISE(ABORT,'channel_binding_identity_immutable'); END;`);
  if(!(db.prepare('PRAGMA table_info(ga_owner_channel_challenges)').all() as Row[]).some(row=>row.name==='request_key_hash'))db.exec('ALTER TABLE ga_owner_channel_challenges ADD COLUMN request_key_hash TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ga_owner_channel_challenge_request ON ga_owner_channel_challenges(owner_id,request_key_hash)');
 }
 create(owner:string,channel:string,requestKey?:string){
  if(!this.enabled.includes(channel)||channel!=='wecom')throw new Error('channel_binding_unavailable');
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner))throw new Error('unauthorized');
  return withImmediateTransaction(this.db,()=>{
   if(requestKey!==undefined&&!/^[\x21-\x7E]{8,128}$/.test(requestKey))throw new Error('idempotency_key_invalid');
   const requestHash=requestKey===undefined?null:digest(requestKey);
   const previous=requestHash===null?undefined:this.db.prepare('SELECT * FROM ga_owner_channel_challenges WHERE owner_id=? AND request_key_hash=?').get(owner,requestHash) as Row|undefined;
   if(previous){if(previous.channel!==channel)throw new Error('idempotency_conflict');return {channel_binding_id:String(previous.challenge_id),channel,status:'pending',expires_at:new Date(Number(previous.expires_at)*1000).toISOString(),version:1,requires_new_code:true};}
   const now=this.now(),count=this.db.prepare('SELECT count(*) n FROM ga_owner_channel_challenges WHERE owner_id=? AND created_at>?').get(owner,now-3600) as {n:number};
   if(count.n>=5)throw new Error('channel_binding_rate_limited');
   this.db.prepare("UPDATE ga_owner_channel_challenges SET status='replaced' WHERE owner_id=? AND channel=? AND status='pending'").run(owner,channel);
   const id='channel-binding-'+randomUUID(),code=randomBytes(32).toString('base64url');
   this.db.prepare('INSERT INTO ga_owner_channel_challenges(challenge_id,owner_id,channel,code_hash,status,expires_at,created_at,binding_id,request_key_hash) VALUES(?,?,?,?,?,?,?,NULL,?)').run(id,owner,channel,digest(code),'pending',now+600,now,requestHash);
   return {channel_binding_id:id,channel,status:'pending',code,expires_at:new Date((now+600)*1000).toISOString(),version:1,requires_new_code:false};
  });
 }
 private public(row:Row){return {channel_binding_id:String(row.channel_binding_id),channel:String(row.channel),status:String(row.status),version:Number(row.version),verified_at:new Date(Number(row.verified_at)*1000).toISOString(),revoked_at:row.revoked_at===null?null:new Date(Number(row.revoked_at)*1000).toISOString(),created_at:new Date(Number(row.created_at)*1000).toISOString()};}
 list(owner:string){
  const bindings=this.db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE owner_id=? ORDER BY created_at DESC LIMIT 50').all(owner) as Row[];
  const pending=this.db.prepare("SELECT * FROM ga_owner_channel_challenges WHERE owner_id=? AND status='pending' ORDER BY created_at DESC LIMIT 10").all(owner) as Row[];
  const hasEmail=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ga_email_binding_challenges'").get();
  const email=hasEmail?this.db.prepare("SELECT challenge_id,owner_id,'email' channel,status,expires_at,created_at FROM ga_email_binding_challenges WHERE owner_id=? AND status='pending' ORDER BY created_at DESC LIMIT 10").all(owner) as Row[]:[];
  pending.push(...email);
  return {items:[...bindings.map(row=>this.public(row)),...pending.map(row=>({channel_binding_id:String(row.challenge_id),channel:String(row.channel),status:Number(row.expires_at)>this.now()?'pending':'expired',version:1,verified_at:null,revoked_at:null,created_at:new Date(Number(row.created_at)*1000).toISOString(),expires_at:new Date(Number(row.expires_at)*1000).toISOString()}))]};
 }
 /** This method is called only after the trusted provider intake authentication.
  * It never accepts a web-supplied principal as proof. */
 acceptProof(channel:string,principal:string,code:string){
  if(channel!=='wecom'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(principal)||!/^[A-Za-z0-9_-]{43}$/.test(code))throw new Error('channel_binding_proof_invalid');
  return withImmediateTransaction(this.db,()=>{
   const challenge=this.db.prepare('SELECT * FROM ga_owner_channel_challenges WHERE code_hash=? AND channel=?').get(digest(code),channel) as Row|undefined;
   if(!challenge||Number(challenge.expires_at)<=this.now()||!['pending','consumed'].includes(String(challenge.status)))throw new Error('channel_binding_proof_invalid');
   if(challenge.status==='consumed'){
    const prior=this.db.prepare("SELECT 1 FROM ga_owner_channel_bindings WHERE channel_binding_id=? AND owner_id=? AND channel=? AND principal=? AND status='verified'").get(String(challenge.binding_id),String(challenge.owner_id),channel,principal);
    if(!prior)throw new Error('channel_binding_proof_invalid');return {accepted:true,kind:'channel_binding',status:'verified'};
   }
   const existing=this.db.prepare("SELECT * FROM ga_owner_channel_bindings WHERE channel=? AND principal=? AND status='verified'").get(channel,principal) as Row|undefined;
   if(existing&&existing.owner_id!==challenge.owner_id)throw new Error('channel_principal_already_bound');
   const id=String(existing?.channel_binding_id??challenge.challenge_id),now=this.now();
   if(!existing)this.db.prepare('INSERT INTO ga_owner_channel_bindings VALUES(?,?,?,?,?,1,?,NULL,?)').run(id,String(challenge.owner_id),channel,principal,'verified',now,now);
   this.db.prepare("UPDATE ga_owner_channel_challenges SET status='consumed',binding_id=? WHERE challenge_id=? AND status='pending'").run(id,String(challenge.challenge_id));
   return {accepted:true,kind:'channel_binding',status:'verified'};
  });
 }
 resolve(owner:string,id:string){const row=this.db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE owner_id=? AND channel_binding_id=?').get(owner,id) as Row|undefined;
  if(!row)throw new Error('channel_binding_not_found');if(row.status!=='verified')throw new Error('channel_binding_not_verified');return {channel_binding_id:id,channel:String(row.channel),principal:String(row.principal),version:Number(row.version)};}
 revoke(owner:string,id:string,version:number){return withImmediateTransaction(this.db,()=>{
  const row=this.db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE owner_id=? AND channel_binding_id=?').get(owner,id) as Row|undefined;
  if(!row)throw new Error('channel_binding_not_found');if(row.version!==version)throw new Error('version_conflict');
  if(row.status==='verified')this.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=version+1,revoked_at=? WHERE channel_binding_id=?").run(this.now(),id);
  return this.public(this.db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE channel_binding_id=?').get(id) as Row);
 });}
}
