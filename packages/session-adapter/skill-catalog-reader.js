import {isDeepStrictEqual} from 'node:util';
import {normalizeSkillReadScope as scopeOf,createSkillReadBinding} from './skill-read-scope.js';
import {readSkillCatalogView,readSkillResourceView} from '../skills/catalog-view.js';
import {validateSkillCatalogView,validateSkillResourceView} from '../skills/catalog-contract.js';
const originalReaders=new WeakSet();
const originalResourceReaders=new WeakSet();
const exact=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
/** Borrow the resident Agent and its original authenticated Workbench guard.
 * This reader neither restores Sessions nor mints tickets/reservations. */
export function createSkillCatalogReader({agents,sessions,bridge,ordinaryPresets}={}){
 if(typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof bridge?.guard!=='function'
  ||typeof bridge?.bindingFor!=='function'||typeof bridge?.request!=='function')throw Error('skill_catalog_host_unavailable');
 const reader=async({scope:input,signal,include_commands=false}={})=>{
  const scope=scopeOf(input),bounded=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);
  const {agent,cwd,authorize}=createSkillReadBinding({scope,signal:bounded,agents,sessions,bridge,ordinaryPresets});
  await authorize();const skills=agent.ctx?.get('skills');
  const commands=include_commands?agent.ctx?.get('commands',false):undefined;
  const catalog=await readSkillCatalogView({skills,cwd,scope:agent,signal:bounded,includeCommands:include_commands,commands});
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
  if(!(exact(request,['protocol','scope'])||exact(request,['protocol','scope','include_commands'])&&request.include_commands===true)
   ||request.protocol!==1)throw Error('skill_catalog_command_invalid');
  const scope=scopeOf(request.scope);signal?.throwIfAborted();
  const result=await readCatalog({scope,...(signal?{signal}:{}),...(request.include_commands?{include_commands:true}:{})});signal?.throwIfAborted();
  if(!exact(result,['catalog','scope']))throw Error('skill_catalog_scope_changed');
  const observed=scopeOf(result.scope);
  if(!isDeepStrictEqual(observed,scope))throw Error('skill_catalog_scope_changed');
  return {scope:{...scope},catalog:validateSkillCatalogView(result.catalog)};
 };
}

/** Borrow the same resident Agent and original guard for one explicitly selected resource. */
export function createSkillResourceReader({agents,sessions,bridge,ordinaryPresets}={}){
 if(typeof agents?.get!=='function'||typeof sessions?.get!=='function'||typeof bridge?.guard!=='function'
  ||typeof bridge?.bindingFor!=='function'||typeof bridge?.request!=='function')throw Error('skill_catalog_host_unavailable');
 const reader=async({scope:input,skill_name,relative_path,signal}={})=>{
  const scope=scopeOf(input),bounded=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);
  const {agent,cwd,authorize}=createSkillReadBinding({scope,signal:bounded,agents,sessions,bridge,ordinaryPresets});
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
  const observed=scopeOf(result.scope);if(!isDeepStrictEqual(observed,scope))throw Error('skill_catalog_scope_changed');
  const resource=await validateSkillResourceView(result.resource);
  if(resource.name!==request.skill_name||resource.relativePath!==request.relative_path)throw Error('skill_catalog_scope_changed');
  return {scope:{...scope},resource};
 };
}
