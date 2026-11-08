import https from 'node:https';
import {awaitWithSignal} from './mcp-agent-provider.js';
import {lookup} from 'node:dns/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {isDeepStrictEqual} from 'node:util';
import {isPublicNetworkAddress} from '../gateway/src/network/public-address.js';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const REF=/^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER=/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const RESERVED=new Set(['host','connection','content-length','transfer-encoding','accept','accept-encoding','content-type','mcp-session-id','mcp-protocol-version','mcp-method','mcp-name','last-event-id']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const fail=()=>{throw Error('mcp_host_http_unavailable');};

export function normalizeMcpHttpPolicy(value){
 if(!exact(value,['owner_id','connections'])||typeof value.owner_id!=='string'||value.owner_id.length>128||!ID.test(value.owner_id)
  ||!Array.isArray(value.connections)||value.connections.length>64)fail();
 const keys=new Set();
 const connections=value.connections.map(row=>{
  if(!exact(row,['agent_id','connection_id','url','headers'])||![row.agent_id,row.connection_id].every(id=>typeof id==='string'&&ID.test(id))
   ||typeof row.url!=='string'||row.url.length>2048||!object(row.headers)||Object.keys(row.headers).length>64)fail();
  let url;try{url=new URL(row.url);}catch{fail();}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.href!==row.url)fail();
  const key=JSON.stringify([row.agent_id,row.connection_id]);if(keys.has(key))fail();keys.add(key);
  const headers=Object.create(null);
  for(const [name,mapping] of Object.entries(row.headers)){
   const lower=name.toLowerCase();
   if(!HEADER.test(name)||RESERVED.has(lower)||Object.hasOwn(headers,lower)||!exact(mapping,['reference','native_ref','prefix'])
    ||typeof mapping.reference!=='string'||mapping.reference.length>264||!mapping.reference.startsWith('secret://'+value.owner_id+'/')
    ||!/^secret:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,253}$/.test(mapping.reference)
    ||typeof mapping.native_ref!=='string'||!REF.test(mapping.native_ref)||!['','Bearer '].includes(mapping.prefix))fail();
   headers[lower]=Object.freeze({...mapping});
  }
  return Object.freeze({...row,headers:Object.freeze(headers)});
 });
 return Object.freeze({owner_id:value.owner_id,connections:Object.freeze(connections)});
}

function pinnedRequest(url,init,addresses,signal){
 return new Promise((resolve,reject)=>{
  let incoming;
  const request=https.request(url,{method:init.method,headers:Object.fromEntries(init.headers),signal,agent:false,
   lookup:(_host,options,callback)=>{
    if(options?.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family);
   }},response=>{
    incoming=response;
    try{
     const status=response.statusCode??0;
     if(status<200||status>599||status>=300&&status<400||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){
      response.destroy();reject(Error('mcp_host_http_unavailable'));return;
     }
     const headers=new Headers();
     for(const [key,value] of Object.entries(response.headers)){
      if(Array.isArray(value))for(const item of value)headers.append(key,item);else if(value!==undefined)headers.set(key,value);
     }
     resolve(new Response([204,205,304].includes(status)?null:Readable.toWeb(response),{status,headers}));
     if([204,205,304].includes(status))response.resume();
    }catch{response.destroy();reject(Error('mcp_host_http_unavailable'));}
   });
  request.on('error',()=>{incoming?.destroy();reject(Error('mcp_host_http_unavailable'));});
  if(init.body===undefined)request.end();
  else pipeline(Readable.fromWeb(init.body),request).catch(()=>request.destroy(Error('mcp_host_http_unavailable')));
 });
}

/** Trusted owner/Agent/connection policy, with fresh native resolution on every request. */
export function createMcpHostHttpFetch({policy,readIdentity,readCredentials}={}){
 const configured=normalizeMcpHttpPolicy(policy);
 if(typeof readIdentity!=='function'||typeof readCredentials!=='function')fail();
 return async({ownerId,agentId,connection,signal,assertCurrent})=>{
  const approved=configured.connections.find(row=>row.agent_id===agentId&&row.connection_id===connection.connection_id);
  const valid=()=>{
   signal.throwIfAborted();
   const profile=readIdentity();
   if(profile.ownerId!==ownerId||ownerId!==configured.owner_id||!approved||connection.transport!=='streamable-http'
    ||connection.config.url!==approved.url)fail();
   const requested=Object.create(null);
   for(const [name,reference] of Object.entries(connection.config.header_refs??{})){
    const lower=name.toLowerCase();if(Object.hasOwn(requested,lower))fail();requested[lower]=reference;
   }
   const expected=Object.fromEntries(Object.entries(approved.headers).map(([name,row])=>[name,row.reference]));
   if(!isDeepStrictEqual({...requested},expected))fail();
   return profile.profileId;
  };
  const profileId=valid();
  await awaitWithSignal(Promise.resolve(assertCurrent()),signal);
  if(valid()!==profileId)fail();
  return async(target,init)=>{
   try{
    if(target!==approved.url||!['GET','POST','DELETE'].includes(init.method)||init.redirect!=='manual')fail();
    const current=AbortSignal.any([signal,init.signal,AbortSignal.timeout(60000)]);
    const credentials=readCredentials();
    const check=async()=>{
     if(valid()!==profileId||readCredentials()!==credentials)fail();
     await awaitWithSignal(Promise.resolve(assertCurrent()),current);
     current.throwIfAborted();
    };
    await check();
    const headers=new Headers(init.headers);headers.set('accept-encoding','identity');
    for(const [name,row] of Object.entries(approved.headers)){
     if(typeof credentials?.resolve!=='function')fail();
     const resolved=await awaitWithSignal(Promise.resolve(credentials.resolve(row.native_ref)),current);
     current.throwIfAborted();
     if(typeof resolved?.value!=='string'||!resolved.value||resolved.value.length>16384||/[\r\n\0]/.test(resolved.value))fail();
     headers.set(name,row.prefix+resolved.value);
    }
    const url=new URL(target),hostname=url.hostname.replace(/^\[|\]$/g,'');
    const addresses=await awaitWithSignal(lookup(hostname,{all:true,verbatim:true}),current);
    if(!addresses.length||addresses.length>64||addresses.some(row=>!isPublicNetworkAddress(row.address)))fail();
    await check();
    const response=await pinnedRequest(url,{...init,headers},addresses,current);
    try{await check();}catch{await response.body?.cancel();fail();}
    return response;
   }catch{fail();}
  };
 };
}
