import {createHash} from 'node:crypto';
import {withNativeWorkspaceBarrier} from './native-workspace-barrier.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/,SHA=/^[a-f0-9]{64}$/;
const KINDS=new Set(['work_binding','mode_binding','runtime','run_native','checkpoint','goal_control','native_parent','native_child']);
const fields=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const id=value=>typeof value==='string'&&ID.test(value);
const contexts=new WeakMap();
/** Host-only observation while the original native custody is still held.
 * Neither these facts nor a serialized copy grant Git or publication rights. */
export function inspectNativeWorkspaceSource(context){
 const held=context&&contexts.get(context);if(!held)throw Error('native_workspace_source_context_invalid');
 held.check();return held.view;
}
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function verified(value,scope){
 const fail=()=>{throw Error('native_workspace_source_unconfirmed');};
 if(!fields(value,['protocol','reservation_id','execution_id','owner_id','project_id','binding_sha256','family_sha256','members','execution_authorized'])
  ||value.protocol!==1||value.execution_authorized!==false||!id(value.reservation_id)||!SHA.test(value.binding_sha256)||!SHA.test(value.family_sha256)
  ||Object.keys(scope).some(key=>value[key]!==scope[key])||!Array.isArray(value.members)||value.members.length>256)fail();
 const ids=new Set();let count=0,previous;
 const members=value.members.map(member=>{
  if(!fields(member,['session_ref','scopes','source_kinds'])||!id(member.session_ref)||ids.has(member.session_ref)
   ||previous!==undefined&&previous.localeCompare(member.session_ref,'en')>=0||!Array.isArray(member.scopes)||!member.scopes.length||member.scopes.length>30000
   ||!Array.isArray(member.source_kinds)||!member.source_kinds.length||member.source_kinds.length>KINDS.size
   ||member.source_kinds.some(kind=>!KINDS.has(kind))||new Set(member.source_kinds).size!==member.source_kinds.length
   ||JSON.stringify([...member.source_kinds].sort())!==JSON.stringify(member.source_kinds))fail();
  previous=member.session_ref;ids.add(member.session_ref);let prior;
  const scopes=member.scopes.map(item=>{
   if(!fields(item,['conversation_id','workspace_id'])||!id(item.conversation_id)||!id(item.workspace_id)||++count>30000)fail();
   const key=item.conversation_id+'\0'+item.workspace_id;if(prior!==undefined&&prior.localeCompare(key,'en')>=0)fail();prior=key;
   return{conversation_id:item.conversation_id,workspace_id:item.workspace_id};
  });return{session_ref:member.session_ref,scopes,source_kinds:[...member.source_kinds]};
 });
 const base={reservation_id:value.reservation_id,owner_id:scope.owner_id,project_id:scope.project_id,binding_sha256:value.binding_sha256,
  members:members.map(({session_ref,scopes})=>({session_ref,scopes}))};
 if(createHash('sha256').update(JSON.stringify(base)).digest('hex')!==value.family_sha256)fail();
 return freeze({protocol:1,...base,execution_id:scope.execution_id,family_sha256:value.family_sha256,members,execution_authorized:false});
}

/** Original authenticated inventory only. No cache, Agent resolution, namespace
 * claim, cwd derivation, lease or Git execution permission is minted here. */
export async function readNativeWorkspaceFamily(bridge,input,signal){
 if(!fields(input,['owner_id','project_id','execution_id'])||!Object.values(input).every(id))throw Error('native_workspace_source_invalid');
 const scope=Object.freeze({...input}),timed=AbortSignal.timeout(15000),combined=AbortSignal.any([timed,...(signal?[signal]:[])]);combined.throwIfAborted();
 let response;
 try{response=await bridge.fetch(`${bridge.origin}/internal/v1/workbench/git-workspace-source`,{method:'POST',redirect:'error',
  headers:{authorization:`Bearer ${bridge.token}`,'content-type':'application/json'},body:JSON.stringify(scope),signal:combined});}
 catch{combined.throwIfAborted();throw Error('native_workspace_source_unavailable');}
 combined.throwIfAborted();if(!response.ok)throw Error('native_workspace_source_unavailable');
 const reader=response.body?.getReader();if(!reader)throw Error('native_workspace_source_unconfirmed');
 const chunks=[];let bytes=0,done=false;
 try{for(;;){const result=await reader.read();combined.throwIfAborted();if(result.done){done=true;break;}bytes+=result.value.byteLength;if(bytes>16*1024*1024)throw Error('native_workspace_source_unconfirmed');chunks.push(Buffer.from(result.value));}}
 catch{combined.throwIfAborted();throw Error('native_workspace_source_unconfirmed');}
 finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
 let parsed;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('native_workspace_source_unconfirmed');}
 combined.throwIfAborted();if(!fields(parsed,['source']))throw Error('native_workspace_source_unconfirmed');return verified(parsed.source,scope);
}

/** Trusted original-host composition. The inventory is never its synchronous
 * reservation authority: the original owning coordinator must supply that
 * check and retain its Worker/producer custody. No route, runtime loader, Git
 * effect grant, root association or cross-process admission lock is added.
 */
export function createNativeWorkspaceSourceHost(options={}){
 const {registry,sessions,persistence,currentPersistence,backendClass,validateLog,projections,factoryGate,reconcileOperations}=options;
 if(typeof registry?.get!=='function'||typeof sessions?.get!=='function'||typeof persistence?.open!=='function'||typeof persistence?.stat!=='function'
  ||typeof currentPersistence!=='function'||typeof backendClass!=='function'||!(persistence instanceof backendClass)
  ||!(options.allowedPresets instanceof Set)||!options.allowedPresets.size||typeof validateLog!=='function'||!projections||!factoryGate
  ||typeof options.bridge?.fetch!=='function'||typeof options.bridge?.origin!=='string'||typeof options.bridge?.token!=='string')throw Error('native_workspace_source_host_unavailable');
 // Snapshot dependency selectors and transport, never retain a mutable caller
 // descriptor that could substitute another registry/store/identity mid-await.
 const bridge=Object.freeze({origin:options.bridge.origin,token:options.bridge.token,fetch:options.bridge.fetch.bind(options.bridge)});
 const allowedPresets=new Set(options.allowedPresets);
 const dependencies={registry,sessions,persistence,currentPersistence,backendClass,allowedPresets,validateLog,projections,reconcileOperations};
 return Object.freeze({async withReservedFamily(input,controls,operation){
  if(!fields(input,['owner_id','project_id','execution_id'])||!Object.values(input).every(id))throw Error('native_workspace_source_invalid');
  if(!controls||typeof controls!=='object'||Array.isArray(controls)||Object.keys(controls).some(key=>!['assertReservation','signal'].includes(key))
   ||typeof controls.assertReservation!=='function'||controls.signal!==undefined&&!(controls.signal instanceof AbortSignal)
   ||typeof operation!=='function')throw Error('native_workspace_host_controls_invalid');
  const scope=Object.freeze({...input}),reservation=controls.assertReservation,signal=controls.signal;let residents=[];
  const check=()=>{
   signal?.throwIfAborted();const value=reservation();
   if(value!==undefined){if(value&&typeof value.then==='function')Promise.resolve(value).catch(()=>{});throw Error('native_workspace_reservation_invalid');}
   for(const {agent,session,preset} of residents)if(registry.get(agent.id)!==agent||sessions.get(agent.id)!==session||agent.session!==session
    ||session.header?.agentPreset!==preset)throw Error('native_workspace_source_member_changed');
  };
  const read=async(nativeCheck=check,nativeSignal=signal)=>{
   check();nativeCheck();const result=await readNativeWorkspaceFamily(bridge,scope,nativeSignal);check();nativeCheck();return result;
  };
  const source=await read();
  const members=source.members.map(member=>{
   const sessionRef=member.session_ref,agent=registry.get(sessionRef),session=sessions.get(sessionRef);
   if(agent!==undefined&&(agent?.id!==sessionRef||agent.session?.id!==sessionRef||agent.session!==session||!allowedPresets.has(session?.header?.agentPreset))
    ||agent===undefined&&session!==undefined)throw Error('native_workspace_source_member_changed');
   if(agent!==undefined)residents.push({agent,session,preset:session.header.agentPreset});
   return{...dependencies,sessionRef,...(agent===undefined?{}:{agent})};
  });
  check();
  return withNativeWorkspaceBarrier({members,assertReservation:check,signal,factoryGate},async(proofs,nativeCheck,nativeSignal,nativeRecheck,workspaces)=>{
   const observe=async()=>{
    await nativeRecheck();check();const current=await read(nativeCheck,nativeSignal);
    if(current.reservation_id!==source.reservation_id||current.binding_sha256!==source.binding_sha256||current.family_sha256!==source.family_sha256)throw Error('native_workspace_source_changed');
    await nativeRecheck();check();
   };
   await observe();let context;
   const current=()=>{if(!contexts.has(context))throw Error('native_workspace_source_context_invalid');check();nativeCheck();};
   const recheck=async()=>{current();await observe();current();};
   context=Object.freeze({source,proofs,workspaces,check:current,recheck,signal:nativeSignal});
   const view=Object.freeze({source,proofs,workspaces,execution_authorized:false});contexts.set(context,{check:current,view});
   let result;try{result=await operation(context);}finally{contexts.delete(context);}
   await observe();return result;
  });
 }});
}
