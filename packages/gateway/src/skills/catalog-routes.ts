import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {SkillCatalogService} from './catalog.ts';
/** Pending root-owned server registration; uses the existing actor resolver. */
export function registerSkillCatalogRoutes(app:FastifyInstance,service:SkillCatalogService,actor:(request:FastifyRequest)=>string){
 app.get('/v1/runs/:runId/skills',async(request,reply)=>{
  reply.header('cache-control','private, no-store').header('x-content-type-options','nosniff');
  const query=request.query as Record<string,unknown>,keys=Object.keys(query);
  const includeCommands=keys.length===1&&query.commands==='1';
  const definitionName=keys.length===1&&typeof query.name==='string'?query.name:undefined;
  const selected=keys.length===0||includeCommands||definitionName!==undefined?undefined:keys.length===2&&keys.includes('name')&&keys.includes('path')
   &&typeof query.name==='string'&&typeof query.path==='string'?{name:query.name,path:query.path}:null;
  if(selected===null)return reply.code(422).send({error:{code:'SKILL_CATALOG_INPUT_INVALID'}});
  const cancel=new AbortController(),abort=()=>cancel.abort(),close=()=>{if(!reply.raw.writableEnded)abort();};
  request.raw.once('aborted',abort);reply.raw.once('close',close);
  try{
   const runId=(request.params as {runId:string}).runId;
   if(definitionName!==undefined)return await service.readDefinition(actor(request),runId,definitionName,cancel.signal);
   return selected?await service.readResource(actor(request),runId,selected.name,selected.path,cancel.signal)
    :await service.read(actor(request),runId,cancel.signal,includeCommands);
  }
  catch(error){
   if(cancel.signal.aborted)throw error;
   const code=error instanceof Error?error.message:'';
   if(code==='skill_catalog_scope_forbidden'||code==='skill_not_found'||code==='skill_not_user_invocable')return reply.code(404).send({error:{code:'SKILL_CATALOG_NOT_FOUND'}});
   if(code==='skill_catalog_scope_changed'||code==='skill_catalog_changed'||code==='skill_resource_changed')return reply.code(409).send({error:{code:'SKILL_CATALOG_CHANGED'}});
   if(code==='skill_catalog_invalid'||code==='skill_resource_path_invalid'||code==='skill_resource_provider_unsupported')return reply.code(422).send({error:{code:'SKILL_CATALOG_INPUT_INVALID'}});
   if(code==='skill_resource_too_large')return reply.code(413).send({error:{code:'SKILL_RESOURCE_TOO_LARGE'}});
   if(code==='skill_resource_path_unsafe')return reply.code(404).send({error:{code:'SKILL_CATALOG_NOT_FOUND'}});
   return reply.code(503).send({error:{code:'SKILL_CATALOG_UNAVAILABLE'}});
  }finally{request.raw.off('aborted',abort);reply.raw.off('close',close);}
 });
}
