import {AsyncLocalStorage} from 'node:async_hooks';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
/** Named DSH continuable provider. The native manager retains creation,
 * inbox, driver and teardown ownership; this seam contributes only seed data.
 * Role intent is scoped to one host-authorized spawn, never ambient model text.
 */
export class NativeRoleProvider {
 constructor({name,admission,prepare}){
  if(typeof name!=='string'||!ID.test(name)||typeof admission?.reserve!=='function'||typeof admission?.abandon!=='function'||typeof prepare!=='function')throw new Error('native_role_provider_invalid');
  Object.assign(this,{name,admission,prepare});this.scope=new AsyncLocalStorage();this.inheritsParentContext=false;
  this.capabilities=Object.freeze({agentOptions:true,depthLimit:true,toolFilter:true,persona:true,outputSchema:false});
 }
 start(){throw new Error('native_role_one_shot_unsupported');}
 async withRole(parent,intent,operation,metadata={}){
  if(!parent||typeof operation!=='function'||!intent||Object.keys(intent).some(key=>!['roleRef','policyVersion','requestId'].includes(key))
   ||typeof intent.roleRef!=='string'||!ID.test(intent.roleRef)||typeof intent.requestId!=='string'||!ID.test(intent.requestId)
   ||!Number.isSafeInteger(intent.policyVersion)||intent.policyVersion<1
   ||!metadata||typeof metadata!=='object'||Array.isArray(metadata)||Object.keys(metadata).some(key=>key!=='requestHash')
   ||metadata.requestHash!==undefined&&(typeof metadata.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(metadata.requestHash)))throw new Error('native_role_intent_invalid');
  const frame={parent,intent:Object.freeze({...intent}),requestHash:metadata.requestHash,active:true,consumed:false,childId:undefined};
  return this.scope.run(frame,async()=>{
   try{return await operation();}
   finally{frame.active=false;if(frame.childId)this.admission.abandon(parent,frame.childId);}
  });
 }
 async prepareContinuable({parent,sessionId,signal}){
  signal?.throwIfAborted();const frame=this.scope.getStore();
  if(!frame?.active||frame.parent!==parent)throw new Error('native_role_scope_missing');
  if(frame.consumed)throw new Error('native_role_scope_consumed');
  frame.consumed=true;this.admission.reserve(parent,sessionId,frame.intent.roleRef);frame.childId=sessionId;
  // Await backend reservation/binding before official child construction.
  // Failed backend preparation stays an unresolved durable intent; only local
  // in-memory admission is abandoned, with no model/cost replay or refund.
  const seed=await this.prepare({parent,childId:sessionId,...frame.intent,...(frame.requestHash===undefined?{}:{requestHash:frame.requestHash}),signal});signal?.throwIfAborted();
  if(!frame.active)throw new Error('native_role_scope_missing');
  if(seed!==undefined&&(!seed||typeof seed!=='object'||Array.isArray(seed)||Object.keys(seed).some(key=>key!=='seed')||(seed.seed!==undefined&&!Array.isArray(seed.seed))))throw new Error('native_role_seed_invalid');
  return seed??{};
 }
}
