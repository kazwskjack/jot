import {createHash,randomUUID,createECDH} from 'node:crypto';
import {isIP} from 'node:net';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {OwnerChannelBindings} from './owner-bindings.ts';

type Row=Record<string,any>;
type Input={endpoint:string;keys:{p256dh:string;auth:string}};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function decodeBase64Url(value:string):Buffer {
 if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('push_subscription_invalid');
 const bytes=Buffer.from(value,'base64url');
 if(bytes.toString('base64url')!==value)throw new Error('push_subscription_invalid');
 return bytes;
}
function validateEndpoint(value:unknown):string {
 if(typeof value!=='string'||value.length<16||value.length>2048)throw new Error('push_subscription_invalid');
 let url:URL;
 try{url=new URL(value);}catch{throw new Error('push_subscription_invalid');}
 const hostname=url.hostname.toLowerCase();
 if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')
  ||!hostname.includes('.')||hostname.endsWith('.')||isIP(hostname)!==0
  ||hostname==='localhost'||hostname.endsWith('.localhost')||hostname.endsWith('.local')
  ||hostname.endsWith('.internal')||hostname.endsWith('.test'))throw new Error('push_subscription_invalid');
 return url.href;
}
function validateKeys(value:unknown):{p256dh:string;auth:string} {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('push_subscription_invalid');
 const keys=value as Record<string,unknown>;
 if(Object.keys(keys).length!==2||typeof keys.p256dh!=='string'||typeof keys.auth!=='string')throw new Error('push_subscription_invalid');
 const point=decodeBase64Url(keys.p256dh),auth=decodeBase64Url(keys.auth);
 if(point.length!==65||point[0]!==4||auth.length!==16)throw new Error('push_subscription_invalid');
 try{const verifier=createECDH('prime256v1');verifier.generateKeys();verifier.computeSecret(point);}catch{throw new Error('push_subscription_invalid');}
 return {p256dh:keys.p256dh,auth:keys.auth};
}
function validateOwner(owner:string):void {if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(owner))throw new Error('unauthorized');}
function validateRequestKey(key:string):void {if(!/^[\x21-\x7E]{8,128}$/.test(key))throw new Error('idempotency_key_invalid');}
function view(row:Row){return {channel_binding_id:String(row.channel_binding_id),channel:'webpush',status:String(row.status),version:Number(row.version),verified_at:new Date(Number(row.verified_at)*1000).toISOString(),revoked_at:row.revoked_at===null?null:new Date(Number(row.revoked_at)*1000).toISOString(),created_at:new Date(Number(row.created_at)*1000).toISOString()};}

/** Owner-scoped browser subscriptions. Endpoint and encryption keys are kept
 * server-side and returned only to the delivery provider. */
export class PushSubscriptions {
 private readonly db:DatabaseSync;private readonly now:()=>number;private readonly key:string;private readonly generation:string;
 constructor(db:DatabaseSync,options:{publicKey:string;generation:string;now?:()=>number}){
  this.db=db;this.now=options.now??(()=>Math.floor(Date.now()/1000));this.key=options.publicKey;this.generation=options.generation;
  const publicKey=decodeBase64Url(this.key);
  if(publicKey.length!==65||publicKey[0]!==4||!this.generation||this.generation.length>128)throw new Error('push_vapid_configuration_invalid');
  try{const verifier=createECDH('prime256v1');verifier.generateKeys();verifier.computeSecret(publicKey);}catch{throw new Error('push_vapid_configuration_invalid');}
  new OwnerChannelBindings(db);
 }
 publicKey(){return {public_key:this.key,generation:this.generation};}
 register(owner:string,input:Input,requestKey:string){
  validateOwner(owner);validateRequestKey(requestKey);
  if(!input||typeof input!=='object'||Object.keys(input).some(key=>key!=='endpoint'&&key!=='keys')||Object.keys(input).length!==2)throw new Error('push_subscription_invalid');
  const endpoint=validateEndpoint(input.endpoint),keys=validateKeys(input.keys),endpointHash=hash(endpoint),requestKeyHash=hash(requestKey);
  const requestHash=hash(JSON.stringify([endpoint,keys.p256dh,keys.auth,this.generation]));
  return withImmediateTransaction(this.db,()=>{
   const now=this.now();
   this.db.prepare(`DELETE FROM wb_push_subscriptions WHERE owner_id=? AND channel_binding_id IN(
    SELECT channel_binding_id FROM ga_owner_channel_bindings WHERE owner_id=? AND channel='webpush' AND status='revoked')`).run(owner,owner);
   const prior=this.db.prepare('SELECT r.*,b.* FROM wb_push_subscription_requests r JOIN ga_owner_channel_bindings b ON b.channel_binding_id=r.channel_binding_id WHERE r.owner_id=? AND r.request_key_hash=?').get(owner,requestKeyHash) as Row|undefined;
   if(prior){if(prior.request_hash!==requestHash)throw new Error('idempotency_conflict');return view(prior);}
   let binding=this.db.prepare("SELECT b.* FROM wb_push_subscriptions s JOIN ga_owner_channel_bindings b ON b.channel_binding_id=s.channel_binding_id WHERE s.owner_id=? AND s.endpoint_hash=? AND b.status='verified' AND b.channel='webpush'").get(owner,endpointHash) as Row|undefined;
   if(binding){
    const version=Number(binding.version)+1;
    this.db.prepare('UPDATE ga_owner_channel_bindings SET version=?,verified_at=? WHERE channel_binding_id=? AND owner_id=? AND version=?').run(version,now,String(binding.channel_binding_id),owner,Number(binding.version));
    this.db.prepare('UPDATE wb_push_subscriptions SET endpoint=?,p256dh=?,auth_secret=?,vapid_generation=?,updated_at=? WHERE channel_binding_id=? AND owner_id=?').run(endpoint,keys.p256dh,keys.auth,this.generation,now,String(binding.channel_binding_id),owner);
    binding=this.db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE channel_binding_id=? AND owner_id=?').get(String(binding.channel_binding_id),owner) as Row;
   }else{
    const id=`push-binding-${randomUUID()}`;
    this.db.prepare("INSERT INTO ga_owner_channel_bindings VALUES(?,?,'webpush',?,'verified',1,?,NULL,?)").run(id,owner,id,now,now);
    this.db.prepare('INSERT INTO wb_push_subscriptions VALUES(?,?,?,?,?,?,?,?,?)').run(id,owner,endpoint,endpointHash,keys.p256dh,keys.auth,this.generation,now,now);
    binding=this.db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE channel_binding_id=?').get(id) as Row;
   }
   this.db.prepare('INSERT INTO wb_push_subscription_requests VALUES(?,?,?,?,?)').run(owner,requestKeyHash,requestHash,String(binding.channel_binding_id),now);
   return view(binding);
  });
 }
 resolveRecipient(bindingId:string,generation:string){
  const row=this.db.prepare(`SELECT s.endpoint,s.p256dh,s.auth_secret,s.vapid_generation,s.owner_id
   FROM wb_push_subscriptions s JOIN ga_owner_channel_bindings b ON b.channel_binding_id=s.channel_binding_id AND b.owner_id=s.owner_id
   WHERE s.channel_binding_id=? AND b.channel='webpush' AND b.status='verified'`).get(bindingId) as Row|undefined;
  if(!row)throw new Error('push_subscription_not_found');
  if(row.vapid_generation!==generation)throw new Error('push_subscription_stale');
  return {endpoint:String(row.endpoint),p256dh:String(row.p256dh),auth:String(row.auth_secret),owner_id:String(row.owner_id),generation:String(row.vapid_generation)};
 }
 revoke(owner:string,bindingId:string,expectedVersion:number,localEndpoint?:string){
  validateOwner(owner);
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)throw new Error('version_conflict');
  const localEndpointHash=localEndpoint===undefined?null:hash(validateEndpoint(localEndpoint));
  return withImmediateTransaction(this.db,()=>this.revokeInTransaction(owner,bindingId,expectedVersion,localEndpointHash));
 }
 private revokeInTransaction(owner:string,bindingId:string,expectedVersion:number,localEndpointHash:string|null=null){
  const row=this.db.prepare("SELECT * FROM ga_owner_channel_bindings WHERE owner_id=? AND channel_binding_id=? AND channel='webpush'").get(owner,bindingId) as Row|undefined;
  if(!row)throw new Error('push_subscription_not_found');
  if(Number(row.version)!==expectedVersion)throw new Error('version_conflict');
  const subscription=localEndpointHash===null?undefined:this.db.prepare('SELECT endpoint_hash FROM wb_push_subscriptions WHERE owner_id=? AND channel_binding_id=?').get(owner,bindingId) as Row|undefined;
  const localSubscriptionMatches=!!subscription&&subscription.endpoint_hash===localEndpointHash;
  if(row.status==='verified'){
   const now=this.now();
   this.db.prepare("UPDATE ga_owner_channel_bindings SET status='revoked',version=version+1,revoked_at=? WHERE owner_id=? AND channel_binding_id=? AND version=?").run(now,owner,bindingId,expectedVersion);
   this.db.prepare('DELETE FROM wb_push_subscriptions WHERE owner_id=? AND channel_binding_id=?').run(owner,bindingId);
  }
  return {binding:view(this.db.prepare('SELECT * FROM ga_owner_channel_bindings WHERE owner_id=? AND channel_binding_id=?').get(owner,bindingId) as Row),local_subscription_matches:localSubscriptionMatches};
 }
 expireRecipient(bindingId:string,generation:string):boolean{
  return withImmediateTransaction(this.db,()=>{
   const row=this.db.prepare(`SELECT b.owner_id,b.version FROM ga_owner_channel_bindings b JOIN wb_push_subscriptions s ON s.channel_binding_id=b.channel_binding_id AND s.owner_id=b.owner_id
    WHERE b.channel_binding_id=? AND b.channel='webpush' AND b.status='verified' AND s.vapid_generation=?`).get(bindingId,generation) as Row|undefined;
   if(!row)return false;
   this.revokeInTransaction(String(row.owner_id),bindingId,Number(row.version));return true;
  });
 }
}
