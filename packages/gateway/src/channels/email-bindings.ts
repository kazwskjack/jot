import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {OwnerChannelBindings} from './owner-bindings.ts';
import {emailPrincipal} from './email-provider.ts';
type Row=Record<string,any>;
type Sender=(text:string,recipient:string)=>Promise<Record<string,unknown>>;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const ownerValid=(owner:string)=>/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner);
export class EmailChannelBindings{
 private readonly db:DatabaseSync;private readonly send:Sender|undefined;private readonly now:()=>number;
 constructor(db:DatabaseSync,options:{send?:Sender;now?:()=>number}={}){
  this.db=db;this.send=options.send;this.now=options.now??(()=>Math.floor(Date.now()/1000));new OwnerChannelBindings(db);
  db.exec(`CREATE TABLE IF NOT EXISTS ga_email_binding_challenges (
   challenge_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,principal TEXT NOT NULL,request_key_hash TEXT NOT NULL,
   code_hash TEXT NOT NULL,status TEXT NOT NULL,delivery_status TEXT NOT NULL,attempts INTEGER NOT NULL,
   created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,binding_id TEXT,UNIQUE(owner_id,request_key_hash));
   CREATE INDEX IF NOT EXISTS ga_email_binding_principal_time ON ga_email_binding_challenges(principal,created_at);
   CREATE TRIGGER IF NOT EXISTS ga_email_binding_identity BEFORE UPDATE OF challenge_id,owner_id,principal,request_key_hash,code_hash,created_at,expires_at ON ga_email_binding_challenges
   BEGIN SELECT RAISE(ABORT,'email_binding_identity_immutable'); END;`);
 }
 private view(row:Row){return {channel_binding_id:String(row.challenge_id),channel:'email',status:row.status==='consumed'?'verified':String(row.status),delivery_status:String(row.delivery_status),expires_at:new Date(Number(row.expires_at)*1000).toISOString()};}
 async begin(owner:string,address:string,requestKey:string){
  if(!this.send)throw new Error('channel_binding_unavailable');if(!ownerValid(owner))throw new Error('unauthorized');
  const principal=emailPrincipal(address);if(!/^[\x21-\x7E]{8,128}$/.test(requestKey))throw new Error('idempotency_key_invalid');
  const created=withImmediateTransaction(this.db,()=>{
   const requestHash=digest(requestKey),prior=this.db.prepare('SELECT * FROM ga_email_binding_challenges WHERE owner_id=? AND request_key_hash=?').get(owner,requestHash) as Row|undefined;
   if(prior){if(prior.principal!==principal)throw new Error('idempotency_conflict');return {row:prior,code:null};}
   const now=this.now();
   const owned=this.db.prepare('SELECT count(*) n FROM ga_email_binding_challenges WHERE owner_id=? AND created_at>?').get(owner,now-3600) as {n:number};
   const target=this.db.prepare('SELECT count(*) n,max(created_at) latest FROM ga_email_binding_challenges WHERE principal=? AND created_at>?').get(principal,now-86400) as {n:number;latest:number|null};
   if(owned.n>=5||target.n>=20||(target.latest!==null&&now-target.latest<60))throw new Error('email_binding_rate_limited');
   this.db.prepare("UPDATE ga_email_binding_challenges SET status='replaced' WHERE owner_id=? AND status='pending'").run(owner);
   const id='email-binding-'+randomUUID(),code=randomBytes(32).toString('base64url');
   this.db.prepare("INSERT INTO ga_email_binding_challenges VALUES(?,?,?,?,?,'pending','sending',0,?,?,NULL)").run(id,owner,principal,requestHash,digest(code),now,now+600);
   return {row:this.db.prepare('SELECT * FROM ga_email_binding_challenges WHERE challenge_id=?').get(id) as Row,code};
  });
  if(created.code!==null){
   let status='outcome_unknown';
   try{const receipt=await this.send(`Jot email verification\n\n${created.code}\n\nExpires in 10 minutes. If you did not request this, ignore this message.`,principal);if(typeof receipt.provider_message_id==='string'&&receipt.provider_message_id)status='accepted';}catch{/* Do not expose provider errors or retry an ambiguous send. */}
   this.db.prepare("UPDATE ga_email_binding_challenges SET delivery_status=? WHERE challenge_id=? AND delivery_status='sending'").run(status,String(created.row.challenge_id));
  }
  return this.view(this.db.prepare('SELECT * FROM ga_email_binding_challenges WHERE challenge_id=?').get(String(created.row.challenge_id)) as Row);
 }
 confirm(owner:string,id:string,code:string){
  if(!ownerValid(owner))throw new Error('unauthorized');
  const result=withImmediateTransaction(this.db,()=>{
   const row=this.db.prepare('SELECT * FROM ga_email_binding_challenges WHERE owner_id=? AND challenge_id=?').get(owner,id) as Row|undefined;
   if(!row||row.expires_at<=this.now()||row.attempts>=5||!['pending','consumed'].includes(String(row.status)))return {error:'email_binding_proof_invalid'};
   const valid=typeof code==='string'&&/^[A-Za-z0-9_-]{43}$/.test(code)&&timingSafeEqual(Buffer.from(digest(code),'hex'),Buffer.from(String(row.code_hash),'hex'));
   if(!valid){this.db.prepare('UPDATE ga_email_binding_challenges SET attempts=attempts+1 WHERE challenge_id=?').run(id);return {error:'email_binding_proof_invalid'};}
   if(row.status==='consumed'){
    const binding=this.db.prepare("SELECT * FROM ga_owner_channel_bindings WHERE channel_binding_id=? AND owner_id=? AND channel='email' AND principal=? AND status='verified'").get(String(row.binding_id),owner,String(row.principal)) as Row|undefined;
    return binding?{id:String(binding.channel_binding_id),version:Number(binding.version)}:{error:'email_binding_proof_invalid'};
   }
   const existing=this.db.prepare("SELECT * FROM ga_owner_channel_bindings WHERE channel='email' AND principal=? AND status='verified'").get(String(row.principal)) as Row|undefined;
   if(existing&&existing.owner_id!==owner)return {error:'channel_principal_already_bound'};
   const bindingId=String(existing?.channel_binding_id??id),now=this.now();
   if(!existing)this.db.prepare("INSERT INTO ga_owner_channel_bindings VALUES(?,?,'email',?,'verified',1,?,NULL,?)").run(bindingId,owner,String(row.principal),now,now);
   this.db.prepare("UPDATE ga_email_binding_challenges SET status='consumed',binding_id=? WHERE challenge_id=? AND status='pending'").run(bindingId,id);
   return {id:bindingId,version:Number(existing?.version??1)};
  });
  if(result.error)throw new Error(result.error);
  return {channel_binding_id:result.id!,channel:'email',status:'verified',version:result.version!};
 }
}
