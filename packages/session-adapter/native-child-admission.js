const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

/** Await from DSH's serial agent/created hook, before the child driver starts.
 * Callers reserve an exact child id and a saved role reference before invoking
 * native Team/Subagent creation. authorize must resolve backend ownership and
 * root budgets; attach must install the original model/tool guard. This class
 * alone does not enable a Team provider or confer product execution authority.
 */
export class NativeChildAdmission {
 constructor({registry,bindingFor,authorize,attach,recover}){
  if(!registry?.get||!registry?.list||!registry?.isOwnedBy||typeof bindingFor!=='function'||typeof authorize!=='function'||typeof attach!=='function')throw new Error('native_child_host_incompatible');
  if(recover!==undefined&&typeof recover!=='function')throw new Error('native_child_host_incompatible');
  Object.assign(this,{registry,bindingFor,authorize,attach,recover});this.pending=new Map();this.entering=new WeakSet();this.accepted=new Map();
 }
 install(ctx){
  if(typeof ctx?.on!=='function')throw new Error('native_child_host_incompatible');
  // Cordis serial dispatch stops on a defined return. Always return undefined
  // after successful admission so the remaining official listeners still run.
  return ctx.on('agent/created',async payload=>{await this.created(payload);},{prepend:true});
 }
 reserve(parent,childId,roleRef){
  const binding=this.bindingFor(parent);
  if(this.registry.get(parent?.id)!==parent||!binding)throw new Error('native_child_parent_unbound');
  if(typeof childId!=='string'||typeof roleRef!=='string'||!ID.test(childId)||!ID.test(roleRef)||childId===parent.id)throw new Error('native_child_reservation_invalid');
  if(this.pending.has(childId)||this.registry.get(childId))throw new Error('native_child_reservation_conflict');
  this.pending.set(childId,Object.freeze({parent,binding,roleRef}));
 }
 abandon(parent,childId){const entry=this.pending.get(childId);if(entry?.parent===parent)this.pending.delete(childId);}
 async created({agent,signal}){
  signal?.throwIfAborted();
  if(this.registry.get(agent?.id)!==agent||agent.session?.id!==agent.id)throw new Error('native_child_identity_invalid');
  const parents=this.registry.list().filter(candidate=>candidate!==agent&&this.bindingFor(candidate)&&this.registry.isOwnedBy(agent.id,candidate));
  const claimed=this.registry.get(agent.session.header?.parentSession);
  if(parents.length===0){
   if(this.pending.has(agent.id)||claimed&&this.bindingFor(claimed))throw new Error('native_child_ownership_invalid');
   return false;
  }
  if(parents.length!==1||claimed!==parents[0])throw new Error('native_child_ownership_invalid');
  const parent=parents[0];let entry=this.pending.get(agent.id),recovered;
  if(entry?.parent!==parent&&!(entry===undefined&&this.recover))throw new Error('native_child_reservation_missing');
  if(!entry)entry=Object.freeze({parent,binding:this.bindingFor(parent),roleRef:undefined});
  if(this.entering.has(agent))throw new Error('native_child_admission_pending');
  this.entering.add(agent);this.pending.delete(agent.id);
  const scope=agent.ctx;
  if(typeof scope?.tools?.guard!=='function'||typeof scope?.on!=='function')throw new Error('native_child_host_incompatible');
  // Remain denied on any failure; official publication rolls back the child.
  const removeTool=scope.tools.guard(()=> 'NATIVE_CHILD_NOT_ADMITTED');
  const removeModel=scope.on('llm/stream',(options,next)=>{
   if(options?.sessionId===agent.id)throw new Error('native_child_not_admitted');return next();
  },{prepend:true});
  const check=()=>{
   signal?.throwIfAborted();
   if(this.registry.get(parent.id)!==parent||this.registry.get(agent.id)!==agent||!this.registry.isOwnedBy(agent.id,parent)||this.bindingFor(parent)!==entry.binding)throw new Error('native_child_parent_changed');
  };
  check();
  if(entry.roleRef===undefined){
   recovered=await this.recover({parent,child:agent,parentBinding:entry.binding,signal});check();
   if(typeof recovered?.roleRef!=='string'||!ID.test(recovered.roleRef))throw new Error('native_child_recovery_invalid');
   entry=Object.freeze({...entry,roleRef:recovered.roleRef});
  }
  const binding=recovered?recovered.binding:await this.authorize({parent,child:agent,roleRef:entry.roleRef,parentBinding:entry.binding,signal});check();
  if(binding?.sessionRef!==agent.id||typeof binding.runId!=='string'||!ID.test(binding.runId))throw new Error('native_child_binding_invalid');
  await this.attach(agent,binding,{signal,parent,roleRef:entry.roleRef});check();
  const installed=this.bindingFor(agent);
  if(installed?.runId!==binding.runId||installed?.sessionRef!==binding.sessionRef
    ||installed?.executionLease?.owner!==binding.executionLease?.owner||installed?.executionLease?.generation!==binding.executionLease?.generation)throw new Error('native_child_binding_not_installed');
  removeModel();removeTool();this.entering.delete(agent);
  this.accepted.set(agent.id,Object.freeze({agent,parent,binding:installed,roleRef:entry.roleRef}));return true;
 }
}
