import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {GitInitializationIntents} from './initialization-intents.ts';
import type {GitInitializationReviewPrepare,GitReviewControl} from '../../contracts/types.ts';
type Options={intents:GitInitializationIntents;actor:(request:any)=>string;atomic:<T>(request:any,status:number,operation:()=>T)=>T};
/** Review commands join the original HTTP transaction, never dispatch Git writes. */
export function registerGitInitializationReviewRoutes(app:FastifyInstance,options:Options){
 const route=async(request:FastifyRequest,reply:FastifyReply,kind:'get'|'prepare'|'control')=>{
  const abort=new AbortController(),cancel=()=>{if(!reply.raw.writableEnded)abort.abort();};request.raw.once('aborted',cancel);reply.raw.once('close',cancel);
  reply.header('cache-control','private, no-store');
  try{
   const params=request.params as {projectId:string;intentId?:string},owner=options.actor(request);
   if(Object.keys(request.query as object).length)throw Error('git_initialization_invalid');
   if(kind==='get')return options.intents.get(owner,params.projectId,params.intentId!);
   const commit=kind==='prepare'?await options.intents.prepareChange(owner,params.projectId,request.body as GitInitializationReviewPrepare,abort.signal):await options.intents.prepareControl(owner,params.projectId,params.intentId!,request.body as GitReviewControl,abort.signal),status=kind==='prepare'?201:200;
   return reply.code(status).send(options.atomic(request,status,commit));
  }catch(error){
   const code=error instanceof Error?error.message:'',known:Record<string,number>={
    unauthorized:401,project_not_found:404,git_intent_not_found:404,git_repository_unconfigured:503,git_initialization_invalid:400,
    git_initialization_branch_invalid:400,git_reinitialization_object_format_changed:409,git_initialization_binding_invalid:409,git_initialization_metadata_present:409,
    git_initialization_review_changed:409,git_initialization_source_changed:409,git_initialization_plan_invalid:503,git_initialization_evidence_invalid:503,git_initialization_ignore_limit:413,git_path_unavailable:409,
    git_snapshot_changed:409,git_repository_changed:409,git_review_changed:409,git_intent_closed:409,
    version_conflict:409,idempotency_conflict:409,idempotency_in_progress:409,git_cancelled:409,
    git_output_limit:413,git_read_timeout:504
   };
   return reply.code(Object.hasOwn(known,code)?known[code]!:503).send({error:{code:Object.hasOwn(known,code)?code.toUpperCase():'GIT_INITIALIZATION_REVIEW_UNAVAILABLE'}});
  }finally{request.raw.removeListener('aborted',cancel);reply.raw.removeListener('close',cancel);}
 };
 app.post('/v1/projects/:projectId/git/initialization-intents',(request,reply)=>route(request,reply,'prepare'));
 app.get('/v1/projects/:projectId/git/initialization-intents/:intentId',(request,reply)=>route(request,reply,'get'));
 app.post('/v1/projects/:projectId/git/initialization-intents/:intentId/control',(request,reply)=>route(request,reply,'control'));
}
