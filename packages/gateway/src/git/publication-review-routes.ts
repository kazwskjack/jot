import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {WorkPublicationIntents,WorkPublicationPrepare,WorkPublicationControl} from '../persistent-tasks/work-publication-intents.ts';
import {publicationReviewView,publicationSourceView} from '../persistent-tasks/publication-review-view.ts';
import type {FinalizedWorkSources} from '../persistent-tasks/finalized-work-sources.ts';

type Options={intents:WorkPublicationIntents|undefined;sources:FinalizedWorkSources;actor:(request:any)=>string;atomic:<T>(request:any,status:number,operation:()=>T)=>T};
/** Original owner review only. Approval does not admit or dispatch publication. */
export function registerPublicationReviewRoutes(app:FastifyInstance,options:Options){
 const route=async(request:FastifyRequest,reply:FastifyReply,kind:'get'|'prepare'|'control'|'source')=>{
  const abort=new AbortController(),cancel=()=>{if(!reply.raw.writableEnded)abort.abort()};request.raw.once('aborted',cancel);reply.raw.once('close',cancel);
  reply.header('cache-control','private, no-store');
  try{
   const params=request.params as {projectId:string;intentId?:string;runId?:string},owner=options.actor(request);
   if(Object.keys(request.query as object).length)throw Error('work_publication_invalid');
   if(kind==='source'){
    const source=options.sources.summary(owner,params.runId!);
    if(source.project_id!==params.projectId)throw Error('completed_work_source_not_found');
    return publicationSourceView(source);
   }
   if(!options.intents)throw Error('git_repository_unconfigured');
   if(kind==='get')return publicationReviewView(options.intents.get(owner,params.projectId,params.intentId!));
   const commit=kind==='prepare'?await options.intents.prepareChange(owner,params.projectId,request.body as WorkPublicationPrepare,abort.signal)
    :await options.intents.prepareControl(owner,params.projectId,params.intentId!,request.body as WorkPublicationControl,abort.signal),status=kind==='prepare'?201:200;
   return reply.code(status).send(options.atomic(request,status,()=>publicationReviewView(commit())));
  }catch(error){
   const code=error instanceof Error?error.message:'',known:Record<string,number>={unauthorized:401,project_not_found:404,work_publication_not_found:404,completed_work_source_not_found:404,
    work_publication_invalid:400,workspace_path_unsafe:400,workspace_private_path:400,work_publication_selection_invalid:400,git_path_unavailable:400,
    work_publication_review_changed:409,work_publication_target_base_changed:409,work_publication_database_changed:409,work_publication_closed:409,work_publication_source_scope:409,completed_work_source_conflict:409,
    git_publication_target_changed:409,git_snapshot_changed:409,git_repository_changed:409,git_cancelled:409,version_conflict:409,idempotency_conflict:409,idempotency_in_progress:409,
    work_publication_source_unsupported:422,completed_work_source_unsupported:422,git_output_limit:413,git_entry_limit:413,git_metadata_limit:413,git_read_timeout:504,git_repository_unconfigured:503};
   return reply.code(Object.hasOwn(known,code)?known[code]!:503).send({error:{code:Object.hasOwn(known,code)?code.toUpperCase():'WORK_PUBLICATION_REVIEW_UNAVAILABLE'}});
  }finally{request.raw.removeListener('aborted',cancel);reply.raw.removeListener('close',cancel)}
 };
 app.post('/v1/projects/:projectId/work-publications',(request,reply)=>route(request,reply,'prepare'));
 app.get('/v1/projects/:projectId/work-publication-sources/:runId',(request,reply)=>route(request,reply,'source'));
 app.get('/v1/projects/:projectId/work-publications/:intentId',(request,reply)=>route(request,reply,'get'));
 app.post('/v1/projects/:projectId/work-publications/:intentId/control',(request,reply)=>route(request,reply,'control'));
}
