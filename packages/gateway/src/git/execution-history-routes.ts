import type {FastifyInstance} from 'fastify';
import type {GitIndexExecutions} from './index-executions.ts';

/** Historical reads only. Neither route admits, schedules or retries effects. */
export function registerGitExecutionHistoryRoutes(app:FastifyInstance,executions:GitIndexExecutions,actor:(request:any)=>string){
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
}
