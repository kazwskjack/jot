// Host-only namespace exclusion around the reviewed optional protocol-2 setup
// hooks. This is not an upstream API, a persistence lock or an execution grant.
const holds=new WeakMap(),gates=new WeakMap(),trustedGates=new WeakSet();
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
export function claimNativeWorkspaceFactory(gate,ids){
 if(!gate||!trustedGates.has(gate))throw Error('native_workspace_factory_unavailable');
 return gate.claim(ids);
}
export function assertNativeWorkspaceFactoryHold(token,{sessionRef,registry,sessions,persistence}){
 const record=token&&holds.get(token);
 if(!record||record.released||!record.ids.has(sessionRef)||record.registry!==registry||record.sessions!==sessions||record.persistence!==persistence
  ||record.currentPersistence()?.identity!==record.persistenceIdentity)throw Error('native_workspace_factory_hold_invalid');
 record.signal.throwIfAborted();return Object.freeze({notFoundError:record.notFoundError});
}

export function createNativeWorkspaceFactoryGate({ctx,registry,sessions,persistence,currentPersistence,notFoundError}={}){
 const loop=typeof ctx?.get==='function'?ctx.get('agentLoop'):undefined;
 if(loop?.jotPreSetupHookProtocol!==2||typeof ctx?.on!=='function'||typeof registry?.get!=='function'||typeof sessions?.get!=='function'
  ||typeof persistence?.identity!=='symbol'||typeof currentPersistence!=='function'||currentPersistence()?.identity!==persistence.identity
  ||typeof notFoundError!=='function'||!(notFoundError.prototype instanceof Error))throw Error('native_workspace_factory_unavailable');
 if(gates.has(ctx))throw Error('native_workspace_factory_busy');
 const owners=new Map(),active=new Set(),removers=[],shutdown=new AbortController();let stopped=false,disposal,drained;
 const fence=({agent}={})=>{if(owners.has(agent?.id))throw Error('native_workspace_factory_fenced');};
 try{for(const event of ['agent/before-setup','agent/after-setup','agent/created'])removers.push(ctx.on(event,fence,{prepend:true}));}
 catch(error){for(const remove of removers.reverse())remove();throw error;}
 const gate={
  claim(ids){
   if(stopped)throw Error('native_workspace_factory_inactive');
   if(currentPersistence()?.identity!==persistence.identity)throw Error('native_workspace_factory_unavailable');
   if(!Array.isArray(ids)||ids.length>256||ids.some(id=>typeof id!=='string'||!ID.test(id))||new Set(ids).size!==ids.length)throw Error('native_workspace_members_invalid');
   if(ids.some(id=>owners.has(id)))throw Error('native_workspace_factory_busy');
   const token=Object.freeze({}),record={ids:new Set(ids),registry,sessions,persistence,persistenceIdentity:persistence.identity,currentPersistence,notFoundError,signal:shutdown.signal,released:false};
   holds.set(token,record);active.add(record);for(const id of ids)owners.set(id,token);
   return Object.freeze({token,signal:record.signal,release(){
    if(record.released)return;record.released=true;holds.delete(token);for(const id of ids)if(owners.get(id)===token)owners.delete(id);active.delete(record);
    if(!active.size)drained?.();
   }});
  },
  dispose(){
   if(disposal)return disposal;stopped=true;shutdown.abort(Error('native_workspace_factory_shutdown'));
   disposal=(async()=>{if(active.size)await new Promise(resolve=>{drained=resolve;});for(const remove of removers.reverse())remove();gates.delete(ctx);})();return disposal;
  }
 };
 gates.set(ctx,gate);trustedGates.add(gate);return Object.freeze(gate);
}

/** Deny unsafe original create/resume after host restart using a fresh
 * original-Gateway observation. Not native maintenance or Git permission. */
export function createNativeWorkspaceAdmissionGate({ctx,bridge}={}){
 const loop=ctx?.get?.('agentLoop');
 if(loop?.jotPreSetupHookProtocol!==2||loop.jotStorageAdmissionHookProtocol!==1||!Array.isArray(loop.config?.agents)||loop.config.agents.length
  ||typeof ctx?.agents?.list!=='function'||ctx.agents.list().length||typeof ctx?.on!=='function'||typeof bridge?.nativeAdmission!=='function')throw Error('native_workspace_admission_unavailable');
 const observe=bridge.nativeAdmission.bind(bridge),pending=new Set(),controllers=new Set(),removers=[];let stopped=false,disposal;
 const fence=(payload={})=>{
  const {agent,signal}=payload,sessionRef=agent?.id??payload.sessionId;
  if(stopped||typeof sessionRef!=='string'||!ID.test(sessionRef))return Promise.reject(Error('native_workspace_admission_unavailable'));
  const abort=new AbortController(),combined=AbortSignal.any([abort.signal,...(signal?[signal]:[])]);controllers.add(abort);
  const check=()=>{combined.throwIfAborted();if(stopped||(agent?agent.id:payload.sessionId)!==sessionRef)throw Error('native_workspace_admission_unavailable');};
  const work=Promise.resolve().then(async()=>{check();const value=await observe(sessionRef,combined);check();
   if(!value||value.protocol!==1||value.session_ref!==sessionRef||value.execution_authorized!==false)throw Error('native_workspace_admission_unconfirmed');
  }).finally(()=>{pending.delete(work);controllers.delete(abort);});pending.add(work);return work;
 };
 try{for(const event of ['agent-loop/before-storage','agent/before-setup','agent/after-setup'])removers.push(ctx.on(event,fence,{prepend:true}));}
 catch(error){for(const remove of removers.reverse())remove();throw error;}
 return Object.freeze({dispose(){
  if(disposal)return disposal;stopped=true;for(const abort of controllers)abort.abort(Error('native_workspace_admission_shutdown'));
  disposal=Promise.allSettled([...pending]).then(()=>{for(const remove of removers.reverse())remove();});return disposal;
 }});
}
