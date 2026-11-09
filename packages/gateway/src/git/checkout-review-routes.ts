import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import type {GitCheckoutIntents} from './checkout-intents.ts';

type Options={intents:GitCheckoutIntents;actor:(request:any)=>string;atomic:<T>(request:any,status:number,operation:()=>T)=>T};
export function registerGitCheckoutReviewRoutes(app:FastifyInstance,options:Options){
 const route=async(request:FastifyRequest,reply:FastifyReply,kind:'get'|'prepare'|'control')=>{
  const abort=new AbortController(),cancel=()=>{if(!reply.raw.writableEnded)abort.abort();};request.raw.once('aborted',cancel);reply.raw.once('close',cancel);
  reply.header('cache-control','private, no-store');
  try{
   const params=request.params as {projectId:string;intentId?:string},owner=options.actor(request);
   if(Object.keys(request.query as object).length)throw Error('git_checkout_invalid');
   if(kind==='get')return options.intents.get(owner,params.projectId,params.intentId!);
   const commit=kind==='prepare'?await options.intents.prepareChange(owner,params.projectId,request.body,abort.signal):options.intents.prepareControl(owner,params.projectId,params.intentId!,request.body,abort.signal);
   const status=kind==='prepare'?201:200;return reply.code(status).send(options.atomic(request,status,commit));
  }catch(error){
   const code=error instanceof Error?error.message:'',known:Record<string,number>={project_not_found:404,git_intent_not_found:404,git_repository_unconfigured:503,
    git_checkout_invalid:400,git_checkout_evidence_invalid:503,git_checkout_target_unavailable:409,git_checkout_unavailable:503,git_branch_log_policy_invalid:503,git_branches_invalid:400,
    git_snapshot_changed:409,git_repository_changed:409,git_path_unavailable:400,workspace_path_unsafe:400,workspace_private_path:400,
    git_review_changed:409,git_intent_closed:409,version_conflict:409,idempotency_conflict:409,idempotency_in_progress:409,
    git_reference_backend_unsupported:503,git_output_limit:413,git_entry_limit:413,git_metadata_limit:413,git_read_timeout:504,git_cancelled:409};
   return reply.code(Object.hasOwn(known,code)?known[code]!:503).send({error:{code:Object.hasOwn(known,code)?code.toUpperCase():'GIT_CHECKOUT_REVIEW_UNAVAILABLE'}});
  }finally{request.raw.removeListener('aborted',cancel);reply.raw.removeListener('close',cancel);}
 };
 app.post('/v1/projects/:projectId/git/checkout-intents',(request,reply)=>route(request,reply,'prepare'));
 app.get('/v1/projects/:projectId/git/checkout-intents/:intentId',(request,reply)=>route(request,reply,'get'));
 app.post('/v1/projects/:projectId/git/checkout-intents/:intentId/control',(request,reply)=>route(request,reply,'control'));
}
