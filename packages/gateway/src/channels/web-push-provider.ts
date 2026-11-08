import {createCipheriv,createECDH,createHash,createHmac,createPrivateKey,randomBytes,sign,type KeyObject} from 'node:crypto';
import {promises as dns} from 'node:dns';
import {isIP} from 'node:net';
import https from 'node:https';
import {readFileSync} from 'node:fs';
import type {PushSubscriptions} from './push-subscriptions.ts';

const MAX_PLAINTEXT_BYTES=3993;
const SAFE_SUBJECT=/^(?:mailto:[^\s]{1,240}|https:\/\/[^\s]{1,240})$/;
type Environment=Record<string,string|undefined>;
export interface WebPushVapidConfiguration {privateKey:KeyObject;publicKey:string;generation:string;subject:string;}
function decodeBase64Url(value:string):Buffer{
 if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('push_subscription_invalid');
 const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw new Error('push_subscription_invalid');return bytes;
}
function publicKeyFromPrivate(privateKey:KeyObject):Buffer{
 if(privateKey.type!=='private'||privateKey.asymmetricKeyType!=='ec')throw new Error('push_vapid_configuration_invalid');
 let jwk:{crv?:string;x?:string;y?:string};
 try{jwk=privateKey.export({format:'jwk'}) as {crv?:string;x?:string;y?:string};}catch{throw new Error('push_vapid_configuration_invalid');}
 if(jwk.crv!=='P-256'||typeof jwk.x!=='string'||typeof jwk.y!=='string')throw new Error('push_vapid_configuration_invalid');
 const raw=Buffer.concat([Buffer.from([4]),decodeBase64Url(jwk.x),decodeBase64Url(jwk.y)]);
 if(raw.length!==65)throw new Error('push_vapid_configuration_invalid');
 try{const check=createECDH('prime256v1');check.generateKeys();check.computeSecret(raw);}catch{throw new Error('push_vapid_configuration_invalid');}
 return raw;
}
export function loadWebPushVapidConfiguration(env:Environment,read:(path:string)=>string=path=>readFileSync(path,'utf8')):WebPushVapidConfiguration|undefined{
 const keyFile=env.GENERAL_AGENT_WEBPUSH_VAPID_PRIVATE_KEY_FILE?.trim()??'';
 const subject=env.GENERAL_AGENT_WEBPUSH_SUBJECT?.trim()??'';
 if(!keyFile&&!subject)return;
 if(!keyFile||!SAFE_SUBJECT.test(subject))throw new Error('push_vapid_configuration_invalid');
 let privateKey:KeyObject;
 try{privateKey=createPrivateKey(read(keyFile));}catch{throw new Error('push_vapid_configuration_invalid');}
 const raw=publicKeyFromPrivate(privateKey),publicKey=raw.toString('base64url');
 return {privateKey,publicKey,generation:createHash('sha256').update(raw).digest('hex').slice(0,32),subject};
}
function hmac(key:Buffer,value:Buffer):Buffer{return createHmac('sha256',key).update(value).digest();}
function hkdfExpand(prk:Buffer,info:Buffer,length:number):Buffer{
 if(length<0||length>255*32)throw new Error('push_payload_invalid');
 const blocks:Buffer[]=[];let prior:Buffer=Buffer.alloc(0),size=0;
 for(let counter=1;size<length;counter++){
  prior=hmac(prk,Buffer.concat([prior,info,Buffer.from([counter])]));blocks.push(prior);size+=prior.length;
 }
 return Buffer.concat(blocks).subarray(0,length);
}
function validatedPoint(value:string):Buffer{
 const point=decodeBase64Url(value);if(point.length!==65||point[0]!==4)throw new Error('push_subscription_invalid');
 try{const check=createECDH('prime256v1');check.generateKeys();check.computeSecret(point);}catch{throw new Error('push_subscription_invalid');}
 return point;
}
export function encryptWebPushPayload(payload:string|Buffer,subscription:{p256dh:string;auth:string},options:{ephemeralPrivateKey?:Buffer;salt?:Buffer}={}):Buffer{
 const plaintext=typeof payload==='string'?Buffer.from(payload,'utf8'):Buffer.from(payload);
 if(plaintext.length>MAX_PLAINTEXT_BYTES)throw new Error('push_payload_too_large');
 const userAgentPublic=validatedPoint(subscription.p256dh),auth=decodeBase64Url(subscription.auth);
 if(auth.length!==16)throw new Error('push_subscription_invalid');
 const sender=createECDH('prime256v1');
 if(options.ephemeralPrivateKey){if(options.ephemeralPrivateKey.length!==32)throw new Error('push_payload_invalid');sender.setPrivateKey(options.ephemeralPrivateKey);}else sender.generateKeys();
 const senderPublic=sender.getPublicKey(undefined,'uncompressed'),shared=sender.computeSecret(userAgentPublic);
 const salt=options.salt??randomBytes(16);if(salt.length!==16)throw new Error('push_payload_invalid');
 const authPrk=hmac(auth,shared);
 const keyInfo=Buffer.concat([Buffer.from('WebPush: info\0','ascii'),userAgentPublic,senderPublic]);
 const ikm=hkdfExpand(authPrk,keyInfo,32),prk=hmac(salt,ikm);
 const contentKey=hkdfExpand(prk,Buffer.from('Content-Encoding: aes128gcm\0','ascii'),16);
 const nonce=hkdfExpand(prk,Buffer.from('Content-Encoding: nonce\0','ascii'),12);
 const cipher=createCipheriv('aes-128-gcm',contentKey,nonce);
 const encrypted=Buffer.concat([cipher.update(Buffer.concat([plaintext,Buffer.from([2])])),cipher.final(),cipher.getAuthTag()]);
 const header=Buffer.alloc(21);salt.copy(header,0);header.writeUInt32BE(4096,16);header[20]=senderPublic.length;
 return Buffer.concat([header,senderPublic,encrypted]);
}
export function createVapidAuthorization(privateKey:KeyObject,publicKey:string,endpoint:URL|string,subject:string,nowSeconds=Math.floor(Date.now()/1000)):string{
 if(!SAFE_SUBJECT.test(subject)||!Number.isSafeInteger(nowSeconds)||nowSeconds<0)throw new Error('push_vapid_configuration_invalid');
 const raw=publicKeyFromPrivate(privateKey);
 if(raw.toString('base64url')!==publicKey)throw new Error('push_vapid_configuration_invalid');
 let audience:string;try{const url=new URL(endpoint);if(url.protocol!=='https:'||url.port&&url.port!=='443')throw new Error();audience=url.origin;}catch{throw new Error('push_vapid_configuration_invalid');}
 const header=Buffer.from(JSON.stringify({typ:'JWT',alg:'ES256'})).toString('base64url');
 const claims=Buffer.from(JSON.stringify({aud:audience,exp:nowSeconds+12*60*60,sub:subject})).toString('base64url');
 const signed=`${header}.${claims}`;
 const signature=sign('sha256',Buffer.from(signed),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
 return `vapid t=${signed}.${signature}, k=${publicKey}`;
}

function ipv6Words(address:string):number[]|undefined{
 let value=address.toLowerCase();
 if(value.includes('.')){
  const split=value.lastIndexOf(':');if(split<0)return;
  const octets=value.slice(split+1).split('.').map(Number);if(octets.length!==4||octets.some(n=>!Number.isInteger(n)||n<0||n>255))return;
  value=`${value.slice(0,split)}:${((octets[0]!<<8)|octets[1]!).toString(16)}:${((octets[2]!<<8)|octets[3]!).toString(16)}`;
 }
 const pieces=value.split('::');if(pieces.length>2)return;
 const left=pieces[0]?pieces[0]!.split(':'):[],right=pieces.length===2&&pieces[1]?pieces[1]!.split(':'):[];
 if([...left,...right].some(part=>! /^[0-9a-f]{1,4}$/.test(part)))return;
 const missing=8-left.length-right.length;if((pieces.length===1&&missing!==0)||(pieces.length===2&&missing<1))return;
 return [...left.map(part=>parseInt(part,16)),...Array(missing).fill(0),...right.map(part=>parseInt(part,16))];
}
export function isPublicPushAddress(address:string):boolean{
 const family=isIP(address);
 if(family===4){
  const octets=address.split('.').map(Number);
  if(octets.length!==4||octets.some(n=>!Number.isInteger(n)||n<0||n>255))return false;
  const a=octets[0]!,b=octets[1]!,c=octets[2]!;
  return !(a===0||a===10||a===127||a>223||(a===100&&b>=64&&b<=127)||(a===169&&b===254)
   ||(a===172&&b>=16&&b<=31)||(a===192&&(b===0||b===168||b===88&&c===99))
   ||(a===198&&(b===18||b===19||b===51&&c===100))||(a===203&&b===0&&c===113));
 }
 if(family!==6)return false;
 const words=ipv6Words(address);if(!words)return false;
 const first=words[0]!,second=words[1]!;
 return first>=0x2000&&first<=0x3fff&&!(first===0x2001&&(second<0x0200||second===0x0db8))&&first!==0x2002;
}
async function resolvePublicAddresses(hostname:string):Promise<Array<{address:string;family:4|6}>>{
 const addresses=await dns.lookup(hostname,{all:true,verbatim:true});
 if(!addresses.length||addresses.some(item=>!isPublicPushAddress(item.address)))throw new Error('push_endpoint_unavailable');
 return addresses.map(item=>({address:item.address,family:item.family as 4|6}));
}
async function requestPinned(endpoint:URL,headers:Record<string,string>,body:Buffer,addresses:Array<{address:string;family:4|6}>,timeoutMs:number):Promise<number>{
 return new Promise((resolve,reject)=>{
  let settled=false;
  const done=(error?:Error,status?:number)=>{if(settled)return;settled=true;if(error)reject(error);else resolve(status??0);};
  const req=https.request({protocol:'https:',hostname:endpoint.hostname,port:443,path:`${endpoint.pathname}${endpoint.search}`,method:'POST',headers,
   servername:endpoint.hostname,agent:false,timeout:timeoutMs,lookup:(_hostname,options,callback)=>{
    if(options&&typeof options==='object'&&'all'in options&&(options as {all?:boolean}).all)callback(null,addresses);
    else callback(null,addresses[0]!.address,addresses[0]!.family);
   }},response=>{const status=response.statusCode??0;response.resume();response.once('end',()=>done(undefined,status));response.once('error',()=>done(new Error('push_provider_network_error')));});
  req.once('timeout',()=>req.destroy(new Error('push_provider_timeout')));
  req.once('error',()=>done(new Error('push_provider_network_error')));
  req.end(body);
 });
}
type PushTransportOptions={resolveAddresses?:(hostname:string)=>Promise<Array<{address:string;family:4|6}>>;request?:(endpoint:URL,headers:Record<string,string>,body:Buffer,addresses:Array<{address:string;family:4|6}>,timeoutMs:number)=>Promise<number>;now?:()=>number;timeoutMs?:number};
export function safeWebPushNotificationPayload():Buffer{
 return Buffer.from(JSON.stringify({title:'Jot task update',body:'You have a task update. Open Jot to review it.',url:'/'}),'utf8');
}
export function createWebPushProvider(subscriptions:PushSubscriptions,config:WebPushVapidConfiguration,options:PushTransportOptions={}){
 const resolve=options.resolveAddresses??resolvePublicAddresses,send=options.request??requestPinned,now=options.now??(()=>Math.floor(Date.now()/1000)),timeout=options.timeoutMs??10_000;
 return {
  async sendFile():Promise<Record<string,unknown>>{return {accepted:false,permanent:true,code:'PUSH_FILE_DELIVERY_UNSUPPORTED'};},
  async send(_text:string,recipient:string):Promise<Record<string,unknown>>{
   let target:{endpoint:string;p256dh:string;auth:string;generation:string};
   try{target=subscriptions.resolveRecipient(recipient,config.generation);}catch(error){
    const reason=error instanceof Error?error.message:'';
    if(reason==='push_subscription_stale')return {accepted:false,permanent:true,code:'PUSH_VAPID_GENERATION_STALE'};
    if(reason==='push_subscription_not_found')return {accepted:false,permanent:true,code:'PUSH_SUBSCRIPTION_EXPIRED'};
    throw error;
   }
   let endpoint:URL;
   try{endpoint=new URL(target.endpoint);if(endpoint.protocol!=='https:'||endpoint.port&&endpoint.port!=='443'||isIP(endpoint.hostname))throw new Error();}catch{return {accepted:false,permanent:true,code:'PUSH_ENDPOINT_UNAVAILABLE'};}
   let addresses:Array<{address:string;family:4|6}>;
   try{addresses=await resolve(endpoint.hostname);}catch{return {accepted:false,permanent:true,code:'PUSH_ENDPOINT_UNAVAILABLE'};}
   if(!addresses.length||addresses.some(item=>!isPublicPushAddress(item.address)))return {accepted:false,permanent:true,code:'PUSH_ENDPOINT_UNAVAILABLE'};
   const payload=safeWebPushNotificationPayload();
   let body:Buffer,authorization:string;
   try{body=encryptWebPushPayload(payload,{p256dh:target.p256dh,auth:target.auth});authorization=createVapidAuthorization(config.privateKey,config.publicKey,endpoint,config.subject,now());}
   catch{return {accepted:false,permanent:true,code:'PUSH_PAYLOAD_INVALID'};}
   let status:number;
   try{status=await send(endpoint,{Authorization:authorization,'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:'60',Urgency:'normal'},body,addresses,timeout);}
   catch{throw new Error('push_provider_network_error');}
   if(status===201||status===202)return {ok:true,accepted:true,status};
   if(status===404||status===410){subscriptions.expireRecipient(recipient,config.generation);return {accepted:false,permanent:true,expired:true,code:'PUSH_SUBSCRIPTION_EXPIRED'};}
   if(status===429)return {accepted:false,retryable:true,status,code:'PUSH_PROVIDER_RATE_LIMITED'};
   if(status>=500&&status<=599)return {accepted:false,outcome_unknown:true,status,code:'PUSH_PROVIDER_OUTCOME_UNKNOWN'};
   return {accepted:false,permanent:true,code:'PUSH_PROVIDER_REJECTED'};
  },
 };
}
