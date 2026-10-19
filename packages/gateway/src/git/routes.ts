import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {GitWorkbench} from './service.ts';

export function registerGitRoutes(app:FastifyInstance,service:GitWorkbench,actor:(request:any)=>string){
 const read=async(request:FastifyRequest,reply:FastifyReply,diff:boolean)=>{
  const abort=new AbortController(),cancel=()=>{if(!reply.raw.writableEnded)abort.abort();};request.raw.once('aborted',cancel);reply.raw.once('close',cancel);
  reply.header('cache-control','private, no-store');
  try{
   const project=(request.params as {projectId:string}).projectId,query=request.query as Record<string,unknown>;
   if(!diff){if(Object.keys(query).length)throw Error('git_diff_invalid');return await service.inspect(actor(request),project,abort.signal);}
   if(Object.keys(query).some(key=>!['snapshot_id','path','stage'].includes(key))||typeof query.snapshot_id!=='string'||typeof query.path!=='string'||query.path.length>4096||query.stage!==undefined&&!['working','staged'].includes(String(query.stage)))throw Error('git_diff_invalid');
   return await service.diff(actor(request),project,{snapshot_id:query.snapshot_id,path:query.path,stage:(query.stage??'working') as 'working'|'staged'},abort.signal);
  }catch(error){
   const value=error instanceof Error?error.message:'',known:Record<string,number>={project_not_found:404,git_repository_unconfigured:503,git_repository_changed:409,git_snapshot_changed:409,git_path_unavailable:400,workspace_path_unsafe:400,workspace_private_path:400,git_diff_invalid:400,git_output_limit:413,git_entry_limit:413,git_metadata_limit:413,git_read_timeout:504,git_cancelled:409};
   return reply.code(Object.hasOwn(known,value)?known[value]!:503).send({error:{code:Object.hasOwn(known,value)?value.toUpperCase():'GIT_READ_UNAVAILABLE'}});
  }finally{request.raw.removeListener('aborted',cancel);reply.raw.removeListener('close',cancel);}
 };
 app.get('/v1/projects/:projectId/git',(request,reply)=>read(request,reply,false));
 app.get('/v1/projects/:projectId/git/diff',(request,reply)=>read(request,reply,true));
}
