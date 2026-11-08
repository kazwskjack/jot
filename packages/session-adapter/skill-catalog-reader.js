import {isAbsolute} from 'node:path';
import {readSkillCatalogView,readSkillResourceView} from '../skills/catalog-view.js';
import {validateSkillCatalogView,validateSkillResourceView} from '../skills/catalog-contract.js';
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const KEYS=['owner_id','project_id','workspace_id','agent_id','run_id','session_ref','capability_epoch'];
const originalReaders=new WeakSet();
const originalResourceReaders=new WeakSet();
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function scopeOf(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==[...KEYS].sort().join(',')
  ||KEYS.slice(0,-1).some(k=>typeof value[k]!=='string'||!ID.test(value[k]))||!Number.isSafeInteger(value.capability_epoch)||value.capability_epoch<1)throw Error('skill_catalog_scope_forbidden');
 return Object.freeze({...value});
}
/** Borrow the resident Agent and its original authenticated Workbench guard.
 * This reader neither restores Sessions nor mints tickets/reservations. */
export function createSkillCatalogReader({agents,sessions,bridge}={}){
 if(typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof bridge?.guard!=='function'
  ||typeof bridge?.bindingFor!=='function'||typeof bridge?.request!=='function')throw Error('skill_catalog_host_unavailable');
 const reader=async({scope:input,signal}={})=>{
  const scope=scopeOf(input),bounded=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);
  const agent=agents.get(scope.session_ref),session=sessions.get(scope.session_ref),binding=agent&&bridge.bindingFor(agent),cwd=session?.header?.cwd;
  const check=()=>{
   bounded.throwIfAborted();
   if(!agent||agent.id!==scope.session_ref||agent.session!==session||session?.id!==scope.session_ref||typeof cwd!=='string'||!isAbsolute(cwd)
    ||session.header.cwd!==cwd||agents.get(scope.session_ref)!==agent||sessions.get(scope.session_ref)!==session
    ||bridge.bindingFor(agent)!==binding||binding?.runId!==scope.run_id||binding?.sessionRef!==scope.session_ref)throw Error('skill_catalog_scope_changed');
  };
  const authorize=async()=>{
   check();await bridge.guard(agent,bounded);check();
   const {context}=await bridge.request('guard',binding,{},bounded);check();
   if(!context||KEYS.filter(k=>k!=='session_ref').some(k=>context[k]!==scope[k]))throw Error('skill_catalog_scope_forbidden');
  };
  await authorize();const skills=agent.ctx?.get('skills');
  const catalog=await readSkillCatalogView({skills,cwd,scope:agent,signal:bounded});
  await authorize();return {scope:{...scope},catalog};
 };
 originalReaders.add(reader);
 return reader;
}

/** Strict read-only command envelope for the existing authenticated adapter.
 * The adapter must call this only after its existing bearer check. This does
 * not mint authority or retry a request whose response was lost. */
export function createSkillCatalogCommand(readCatalog){
 if(typeof readCatalog!=='function'||!originalReaders.has(readCatalog))throw Error('skill_catalog_host_unavailable');
 return async(request,{signal}={})=>{
  if(!exact(request,['protocol','scope'])||request.protocol!==1)throw Error('skill_catalog_command_invalid');
  const scope=scopeOf(request.scope);signal?.throwIfAborted();
  const result=await readCatalog({scope,...(signal?{signal}:{})});signal?.throwIfAborted();
  if(!exact(result,['catalog','scope']))throw Error('skill_catalog_scope_changed');
  const observed=scopeOf(result.scope);
  if(KEYS.some(key=>observed[key]!==scope[key]))throw Error('skill_catalog_scope_changed');
  return {scope:{...scope},catalog:validateSkillCatalogView(result.catalog)};
 };
}

/** Borrow the same resident Agent and original guard for one explicitly selected resource. */
export function createSkillResourceReader({agents,sessions,bridge}={}){
 if(typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof bridge?.guard!=='function'
  ||typeof bridge?.bindingFor!=='function'||typeof bridge?.request!=='function')throw Error('skill_catalog_host_unavailable');
 const reader=async({scope:input,skill_name,relative_path,signal}={})=>{
  const scope=scopeOf(input),bounded=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);
  const agent=agents.get(scope.session_ref),session=sessions.get(scope.session_ref),binding=agent&&bridge.bindingFor(agent),cwd=session?.header?.cwd;
  const check=()=>{
   bounded.throwIfAborted();
   if(!agent||agent.id!==scope.session_ref||agent.session!==session||session?.id!==scope.session_ref||typeof cwd!=='string'||!isAbsolute(cwd)
    ||session.header.cwd!==cwd||agents.get(scope.session_ref)!==agent||sessions.get(scope.session_ref)!==session
    ||bridge.bindingFor(agent)!==binding||binding?.runId!==scope.run_id||binding?.sessionRef!==scope.session_ref)throw Error('skill_catalog_scope_changed');
  };
  const authorize=async()=>{
   check();await bridge.guard(agent,bounded);check();
   const {context}=await bridge.request('guard',binding,{},bounded);check();
   if(!context||KEYS.filter(k=>k!=='session_ref').some(k=>context[k]!==scope[k]))throw Error('skill_catalog_scope_forbidden');
  };
  await authorize();
  const resource=await readSkillResourceView({skills:agent.ctx?.get('skills'),fs:agent.ctx?.get('fs'),name:skill_name,
   relativePath:relative_path,cwd,scope:agent,signal:bounded});
  await authorize();return {scope:{...scope},resource};
 };
 originalResourceReaders.add(reader);return reader;
}

/** Strict read-only Host command; it cannot select an install or execution operation. */
export function createSkillResourceCommand(readResource){
 if(typeof readResource!=='function'||!originalResourceReaders.has(readResource))throw Error('skill_catalog_host_unavailable');
 return async(request,{signal}={})=>{
  if(!exact(request,['protocol','scope','skill_name','relative_path'])||request.protocol!==1
   ||typeof request.skill_name!=='string'||typeof request.relative_path!=='string')throw Error('skill_catalog_command_invalid');
  const scope=scopeOf(request.scope);signal?.throwIfAborted();
  const result=await readResource({scope,skill_name:request.skill_name,relative_path:request.relative_path,...(signal?{signal}:{})});signal?.throwIfAborted();
  if(!exact(result,['resource','scope']))throw Error('skill_catalog_scope_changed');
  const observed=scopeOf(result.scope);if(KEYS.some(key=>observed[key]!==scope[key]))throw Error('skill_catalog_scope_changed');
  const resource=await validateSkillResourceView(result.resource);
  if(resource.name!==request.skill_name||resource.relativePath!==request.relative_path)throw Error('skill_catalog_scope_changed');
  return {scope:{...scope},resource};
 };
}
