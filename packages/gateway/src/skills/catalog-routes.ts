import type {FastifyInstance,FastifyRequest} from 'fastify';
import {timingSafeEqual} from 'node:crypto';
import type {SkillCatalogService} from './catalog.ts';
/** Pending root-owned server registration; uses the existing actor resolver. */
export function registerSkillCatalogRoutes(app:FastifyInstance,service:SkillCatalogService,actor:(request:FastifyRequest)=>string,token?:string){
 app.post('/internal/v1/workbench/ordinary-skill-scope',{config:{skillReadInternal:true},bodyLimit:32768},async(request,reply)=>{
  const actual=String(request.headers.authorization??''),expected=`Bearer ${token??''}`;
  if(!token||token.length<16||Buffer.byteLength(actual)!==Buffer.byteLength(expected)
   ||!timingSafeEqual(Buffer.from(actual),Buffer.from(expected)))return reply.code(401).send({error:{code:'UNAUTHORIZED'}});
  const input=request.body as Record<string,unknown>;
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).sort().join(',')!=='run_id,scope,session_ref'
   ||!input.scope||typeof input.scope!=='object'||Array.isArray(input.scope))return reply.code(422).send({error:{code:'SKILL_CATALOG_INPUT_INVALID'}});
  const scope=input.scope as Record<string,unknown>;
  if(scope.run_id!==input.run_id||scope.session_ref!==input.session_ref)return reply.code(409).send({error:{code:'SKILL_CATALOG_CHANGED'}});
  try{return service.authorizeOrdinaryScope(scope);}
  catch(error){
   if(error instanceof Error&&['skill_catalog_scope_forbidden','skill_catalog_scope_changed'].includes(error.message))return reply.code(409).send({error:{code:'SKILL_CATALOG_CHANGED'}});
   throw error;
  }
 });
 app.get('/v1/runs/:runId/skills',async(request,reply)=>{
  reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff');
  const query=request.query as Record<string,unknown>,keys=Object.keys(query);
  const directory=(keys.length===2||keys.length===3&&typeof query.after==='string')&&typeof query.name==='string'
   &&typeof query.directory==='string'&&keys.every(key=>['name','directory','after'].includes(key))
   ?{name:query.name,path:query.directory,after:typeof query.after==='string'?query.after:null}:undefined;
  const includeCommands=keys.length===1&&query.commands==='1';
  const includeSourceManifest=keys.length===2&&typeof query.name==='string'&&query.manifest==='source';
  const definitionName=(keys.length===1||includeSourceManifest)&&typeof query.name==='string'?query.name:undefined;
  const selected=keys.length===0||includeCommands||definitionName!==undefined||directory?undefined:keys.length===2&&keys.includes('name')&&keys.includes('path')
   &&typeof query.name==='string'&&typeof query.path==='string'?{name:query.name,path:query.path}:null;
  if(selected===null)return reply.code(422).send({error:{code:'SKILL_CATALOG_INPUT_INVALID'}});
  const cancel=new AbortController(),abort=()=>cancel.abort(),close=()=>{if(!reply.raw.writableEnded)abort();};
  request.raw.once('aborted',abort);reply.raw.once('close',close);
  try{
   const runId=(request.params as {runId:string}).runId;
   if(directory)return await service.readResource(actor(request),runId,directory.name,directory.path,cancel.signal,{after:directory.after});
   if(definitionName!==undefined)return await service.readDefinition(actor(request),runId,definitionName,cancel.signal,includeSourceManifest);
   return selected?await service.readResource(actor(request),runId,selected.name,selected.path,cancel.signal)
    :await service.read(actor(request),runId,cancel.signal,includeCommands);
  }
  catch(error){
   if(cancel.signal.aborted)throw error;
   const code=error instanceof Error?error.message:'';
   if(code==='skill_source_manifest_unavailable')return reply.code(422).send({error:{code:'SKILL_SOURCE_MANIFEST_UNAVAILABLE'}});
   if(code==='skill_catalog_scope_forbidden'||code==='skill_not_found'||code==='skill_not_user_invocable')return reply.code(404).send({error:{code:'SKILL_CATALOG_NOT_FOUND'}});
   if(code==='skill_catalog_scope_changed'||code==='skill_catalog_changed'||code==='skill_resource_changed')return reply.code(409).send({error:{code:'SKILL_CATALOG_CHANGED'}});
   if(code==='skill_catalog_invalid'||code==='skill_resource_path_invalid'||code==='skill_resource_provider_unsupported')return reply.code(422).send({error:{code:'SKILL_CATALOG_INPUT_INVALID'}});
   if(code==='skill_resource_too_large')return reply.code(413).send({error:{code:'SKILL_RESOURCE_TOO_LARGE'}});
   if(code==='skill_resource_path_unsafe')return reply.code(404).send({error:{code:'SKILL_CATALOG_NOT_FOUND'}});
   return reply.code(503).send({error:{code:'SKILL_CATALOG_UNAVAILABLE'}});
  }finally{request.raw.off('aborted',abort);reply.raw.off('close',close);}
 });
}
