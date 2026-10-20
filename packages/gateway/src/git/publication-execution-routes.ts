import type {FastifyInstance} from 'fastify';
import type {WorkPublicationExecutions,WorkPublicationAdmissionInput} from '../persistent-tasks/work-publication-executions.ts';

type Options={executions:WorkPublicationExecutions|undefined;actor:(request:any)=>string;atomic:<T>(request:any,status:number,operation:()=>T)=>T};
/** Original immutable admission and current journal only. Neither acceptance
 * nor a status read dispatches the native Host or acquires workspace custody. */
export function registerPublicationExecutionRoutes(app:FastifyInstance,options:Options){
 const route=(request:any,reply:any,kind:'admit'|'acceptance'|'current'|'history')=>{
  reply.header('cache-control','private, no-store');
  try{
   const owner=options.actor(request),params=request.params as {projectId:string;intentId?:string;requestId?:string;executionId?:string;runId?:string},query=request.query as Record<string,unknown>;
   if(Object.keys(query).some(key=>kind!=='history'||key!=='before')||query.before!==undefined&&typeof query.before!=='string')throw Error('work_publication_execution_invalid');
   const executions=options.executions;if(!executions)throw Error('git_repository_unconfigured');
   if(kind==='history')return executions.publicationHistory(owner,params.projectId,params.runId!,query.before as string|undefined);
   if(kind==='admit')return reply.code(202).send(options.atomic(request,202,()=>executions.admit(owner,params.projectId,params.intentId!,request.body as WorkPublicationAdmissionInput)));
   return kind==='acceptance'?executions.getAdmission(owner,params.projectId,params.requestId!):executions.publicationStatus(owner,params.projectId,params.executionId!);
  }catch(error){
   const code=error instanceof Error?error.message:'',known:Record<string,number>={unauthorized:401,project_not_found:404,work_publication_not_found:404,work_publication_execution_not_found:404,
    work_publication_execution_invalid:400,work_publication_invalid:400,work_publication_review_changed:409,work_publication_execution_source_changed:409,work_publication_execution_exists:409,
    idempotency_conflict:409,idempotency_in_progress:409,workspace_operation_conflict:409,workspace_publication_upgrade_required:503,git_repository_unconfigured:503};
   return reply.code(Object.hasOwn(known,code)?known[code]!:503).send({error:{code:Object.hasOwn(known,code)?code.toUpperCase():'WORK_PUBLICATION_EXECUTION_UNAVAILABLE'}});
  }
 };
 app.post('/v1/projects/:projectId/work-publications/:intentId/admissions',(request,reply)=>route(request,reply,'admit'));
 app.get('/v1/projects/:projectId/work-publication-admissions/:requestId',(request,reply)=>route(request,reply,'acceptance'));
 app.get('/v1/projects/:projectId/work-publication-executions/:executionId',(request,reply)=>route(request,reply,'current'));
 app.get('/v1/projects/:projectId/work-publication-sources/:runId/history',(request,reply)=>route(request,reply,'history'));
}
