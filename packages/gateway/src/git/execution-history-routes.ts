import type {FastifyInstance} from 'fastify';
import type {GitIndexExecutions} from './index-executions.ts';

/** Original acceptance and history only. No handler schedules native effects. */
export function registerGitExecutionHistoryRoutes(app:FastifyInstance,executions:GitIndexExecutions,actor:(request:any)=>string,atomic:<T>(request:any,status:number,operation:()=>T)=>T){
 for(const [path,kind]of [['admissions/:requestId','acceptance'],['executions/:executionId','current']] as const){
  app.get('/v1/projects/:projectId/git/'+path,async(request,reply)=>{
   reply.header('cache-control','private, no-store');
   try{
    const owner=actor(request),params=request.params as {projectId:string;requestId?:string;executionId?:string};
    if(Object.keys(request.query as object).length)throw Error('git_execution_invalid');
    return kind==='acceptance'?executions.getAdmission(owner,params.projectId,params.requestId!):executions.getAdmitted(owner,params.projectId,params.executionId!);
   }catch(error){
    const code=error instanceof Error?error.message:'',known:Record<string,number>={unauthorized:401,project_not_found:404,git_execution_not_found:404,git_admission_not_found:404,git_execution_invalid:400};
    return reply.code(Object.hasOwn(known,code)?known[code]!:503).send({error:{code:Object.hasOwn(known,code)?code.toUpperCase():'GIT_EXECUTION_HISTORY_UNAVAILABLE'}});
   }
  });
 }
 const respond=(request:any,reply:any,kind:'admit'|'control'|'inspection'|'control-acceptance'|'control-receipt')=>{
  reply.header('cache-control','private, no-store');
  try{
   const owner=actor(request),params=request.params as {projectId:string;intentId?:string;executionId?:string;requestId?:string};
   if(Object.keys(request.query as object).length)throw Error('git_execution_invalid');
   if(kind==='admit')return reply.code(202).send(atomic(request,202,()=>executions.admit(owner,params.projectId,params.intentId!,request.body)));
   executions.getAdmitted(owner,params.projectId,params.executionId!);
   if(kind==='control')return reply.code(202).send(atomic(request,202,()=>executions.admitResolution(owner,params.projectId,params.executionId!,request.body)));
   if(kind==='inspection')return executions.inspect(owner,params.projectId,params.executionId!);
   if(kind==='control-acceptance')return executions.getResolutionAdmission(owner,params.projectId,params.executionId!,params.requestId!);
   return executions.getControl(owner,params.projectId,params.executionId!,params.requestId!);
  }catch(error){
   const code=error instanceof Error?error.message:'',known:Record<string,number>={unauthorized:401,project_not_found:404,git_execution_not_found:404,git_admission_not_found:404,git_execution_control_not_found:404,
    git_execution_invalid:400,git_execution_control_invalid:400,git_intent_not_found:404,git_intent_not_approved:409,git_review_changed:409,version_conflict:409,
    git_execution_closed:409,git_execution_control_exists:409,git_execution_control_pending:409,idempotency_conflict:409,idempotency_in_progress:409,git_repository_unconfigured:503};
   return reply.code(Object.hasOwn(known,code)?known[code]!:503).send({error:{code:Object.hasOwn(known,code)?code.toUpperCase():'GIT_EXECUTION_ADMISSION_UNAVAILABLE'}});
  }
 };
 app.post('/v1/projects/:projectId/git/intents/:intentId/admissions',(request,reply)=>respond(request,reply,'admit'));
 app.post('/v1/projects/:projectId/git/executions/:executionId/controls',(request,reply)=>respond(request,reply,'control'));
 app.get('/v1/projects/:projectId/git/executions/:executionId/inspection',(request,reply)=>respond(request,reply,'inspection'));
 app.get('/v1/projects/:projectId/git/executions/:executionId/control-admissions/:requestId',(request,reply)=>respond(request,reply,'control-acceptance'));
 app.get('/v1/projects/:projectId/git/executions/:executionId/controls/:requestId',(request,reply)=>respond(request,reply,'control-receipt'));
}
