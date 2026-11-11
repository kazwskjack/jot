import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {createOrResumeSession} from './session-admission.js';
import {sessionHeaderIdentity} from './session-header-identity.js';
import {projectTerminalInventory} from '../gateway/src/terminal/inventory.js';
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>plain(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const fail=()=>{throw Error('standalone_terminal_source_unconfirmed');};
function directory(path){
 const canonical=realpathSync(path),stat=lstatSync(canonical,{bigint:true});
 if(!stat.isDirectory()||stat.isSymbolicLink())return fail();
 return Object.freeze({path:canonical,dev:String(stat.dev),ino:String(stat.ino)});
}
export function normalizeStandaloneTerminalBindings(bindings,allowedPresets){
 if(!Array.isArray(bindings)||bindings.length>64||!(allowedPresets instanceof Set))throw Error('standalone_terminal_config_invalid');
 const seen=new Set();return Object.freeze(bindings.map(row=>{
  if(!plain(row)||Object.keys(row).sort().join(',')!=='agent_preset,cwd,workspace_id'
   ||typeof row.workspace_id!=='string'||!row.workspace_id.trim()||row.workspace_id.length>4096||row.workspace_id.includes('\0')
   ||typeof row.cwd!=='string'||!isAbsolute(row.cwd)||row.cwd.includes('\0')||!allowedPresets.has(row.agent_preset)
   ||row.agent_preset==='jot-workbench-budgeted'||seen.has(row.workspace_id))throw Error('standalone_terminal_config_invalid');
  seen.add(row.workspace_id);return Object.freeze({...row});
 }));
}
/** Native owner profile and operator-provisioned paths supply all creation authority. */
export function createStandaloneTerminalHost({bindings,allowedPresets,readIdentity,sessionController,agents,sessions,sessionNotFoundError,claimAttempt,terminalController}){
 if(typeof readIdentity!=='function'||typeof sessionController!=='function'||typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof claimAttempt!=='function')throw Error('standalone_terminal_host_unavailable');
 const origin=Object.freeze({...readIdentity()}),controller=sessionController(),lifetime=new AbortController();
 if(!id(origin?.ownerId)||!id(origin?.profileId)||typeof origin.profileDirectory!=='string'||!isAbsolute(origin.profileDirectory)
  ||['inspect','resolveAgent','create'].some(method=>typeof controller?.[method]!=='function'))throw Error('standalone_terminal_host_unavailable');
 const profileDirectory=directory(origin.profileDirectory),rows=new Map(normalizeStandaloneTerminalBindings(bindings,allowedPresets).map(row=>{
  const root=directory(row.cwd);return[row.workspace_id,Object.freeze({...row,cwd:root.path,directory:root})];
 }));
 const current=(owner,workspace,signal)=>{
  signal.throwIfAborted();lifetime.signal.throwIfAborted();
  const identity=readIdentity(),row=rows.get(workspace);
  if(!row||owner!==origin.ownerId||identity.ownerId!==origin.ownerId||identity.profileId!==origin.profileId
   ||identity.profileDirectory!==origin.profileDirectory||sessionController()!==controller
   ||canonical(directory(profileDirectory.path))!==canonical(profileDirectory)||canonical(directory(row.cwd))!==canonical(row.directory))return fail();
  return{row,authority: Object.freeze({protocol:1,owner_id:owner,workspace_id:workspace,profile_id:identity.profileId,
   authority_sha256:digest({protocol:1,purpose:'standalone_terminal_session',owner_id:owner,profile_id:identity.profileId,
    profile_directory:profileDirectory,workspace_id:workspace,directory:row.directory,agent_preset:row.agent_preset}),execution_authorized:false})};
 };
 const check=(admission,signal,allowReady=false)=>{
  if(!plain(admission)||Object.keys(admission).sort().join(',')!=='authority_sha256,created_at,execution_authorized,native_identity_sha256,owner_id,protocol,request_id,session_id,state,state_sha256,updated_at,version,workspace_id'
   ||admission.protocol!==1||admission.execution_authorized!==false||!id(admission.owner_id)||!uuid(admission.request_id)
   ||typeof admission.session_id!=='string'||!admission.session_id.startsWith('jot-standalone-')||!uuid(admission.session_id.slice('jot-standalone-'.length))
   ||(allowReady?admission.state!=='ready'||!hash(admission.native_identity_sha256):!['dispatched','unknown'].includes(admission.state)||admission.native_identity_sha256!==null)
   ||!hash(admission.state_sha256)||!hash(admission.authority_sha256)||!Number.isSafeInteger(admission.version)||admission.version<1
   ||typeof admission.created_at!=='string'||typeof admission.updated_at!=='string')return fail();
  const original=Object.fromEntries(Object.entries(admission).filter(([key])=>!['protocol','state_sha256','execution_authorized'].includes(key)));
  if(digest(original)!==admission.state_sha256)return fail();
  const scope=current(admission.owner_id,admission.workspace_id,signal);
  if(scope.authority.authority_sha256!==admission.authority_sha256)return fail();
  return scope;
 };
 const validHeader=(header,admission,row)=>{
  if(!header||header.id!==admission.session_id||header.cwd!==row.cwd||header.agentPreset!==row.agent_preset
   ||header.parentSession!==undefined||header.origin==='subagent'||header.delegationDepth!==undefined&&header.delegationDepth!==0||header.isSeeded===true)return fail();
 };
 const inspection=async(admission,signal,allowReady=false)=>{
  const scope=check(admission,signal,allowReady);let saved;
  try{saved=await controller.inspect(admission.session_id,signal);}catch(error){
   check(admission,signal,allowReady);
   if(error?.code==='session/not-found'||typeof sessionNotFoundError==='function'&&error instanceof sessionNotFoundError){
    if(agents.get(admission.session_id)||sessions.get(admission.session_id))return fail();
    return null;
   }
   throw error;
  }
  check(admission,signal,allowReady);validHeader(saved?.meta,admission,scope.row);
  const identity=sessionHeaderIdentity(saved.meta),agent=agents.get(admission.session_id),session=sessions.get(admission.session_id);
  if(agent&&(agent.id!==admission.session_id||agent.session!==session||sessionHeaderIdentity(agent.session?.header)!==identity)
   ||session&&(session.id!==admission.session_id||sessionHeaderIdentity(session.header)!==identity))return fail();
  return saved.meta;
 };
 const observe=async(admission,signal)=>{
  const header=await inspection(admission,signal);check(admission,signal);
  return Object.freeze({protocol:1,owner_id:admission.owner_id,workspace_id:admission.workspace_id,session_id:admission.session_id,
   authority_sha256:admission.authority_sha256,status:header?'ready':'unknown',native_identity_sha256:header?digest(sessionHeaderIdentity(header)):null,execution_authorized:false});
 };
 return Object.freeze({
  readAuthority(owner,workspace,signal){return current(owner,workspace,signal).authority;},
  async observeSession(admission,signal){return observe(admission,AbortSignal.any([signal,lifetime.signal]));},
  async createSession(admission,signal){
   const active=AbortSignal.any([signal,lifetime.signal]),scope=check(admission,active);
   if(admission.state!=='dispatched')return fail();
   const packet={owner_id:admission.owner_id,request_id:admission.request_id,session_id:admission.session_id,
    authority_sha256:admission.authority_sha256,expected_version:admission.version,expected_state_sha256:admission.state_sha256};
   const claim=await claimAttempt(packet,active);check(admission,active);
   if(!plain(claim)||Object.keys(claim).sort().join(',')!=='authority_sha256,create_allowed,execution_authorized,owner_id,protocol,request_id,session_id'
    ||claim.protocol!==1||claim.execution_authorized!==false||typeof claim.create_allowed!=='boolean'
    ||['owner_id','request_id','session_id','authority_sha256'].some(key=>claim[key]!==packet[key]))return fail();
   if(!claim.create_allowed)return observe(admission,active);
   // Existing Sessions are observed, never resumed here; no pending inbox is activated.
   if(await inspection(admission,active))return observe(admission,active);
   await createOrResumeSession({controller,request:{sessionId:admission.session_id,cwd:scope.row.cwd,agentPreset:scope.row.agent_preset},agents,sessions,sessionNotFoundError,signal:active,
    beforeAdmission:async()=>{check(admission,active);if(await inspection(admission,active))throw Error('standalone_terminal_session_already_present');check(admission,active);}});
   check(admission,active);return observe(admission,active);
  },
  async readInventory(admission,signal){
   const active=AbortSignal.any([signal,lifetime.signal]);check(admission,active,true);
   const header=await inspection(admission,active,true);
   if(!header||digest(sessionHeaderIdentity(header))!==admission.native_identity_sha256)return fail();
   const terminals=terminalController?.();
   if(typeof terminals?.list!=='function')throw Error('terminal_inventory_unavailable');
   const inventory=projectTerminalInventory(admission.session_id,terminals.list(admission.session_id));
   const after=await inspection(admission,active,true);
   if(terminalController()!==terminals||!after||digest(sessionHeaderIdentity(after))!==admission.native_identity_sha256)return fail();
   check(admission,active,true);return inventory;
  },
  dispose(){lifetime.abort();},
 });
}
