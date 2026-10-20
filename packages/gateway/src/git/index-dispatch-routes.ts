import type {FastifyInstance} from 'fastify';
import type {GitIndexExecutions} from './index-executions.ts';
import type {NativeGitClient,NativeGitRequest} from './native-transport-client.ts';
import type {GitIndexControlInput} from '../../contracts/types.ts';

type Options={executions:GitIndexExecutions;client:NativeGitClient|undefined;actor:(request:any)=>string};
/** Explicit original I/O, outside atomic admission. Neither peer JSON nor a
 * physical control receipt substitutes for the original native drain proof. */
export function registerIndexDispatchRoutes(app:FastifyInstance,options:Options){
 const route=async(request:any,reply:any,recovery:boolean)=>{
  const abort=new AbortController(),cancel=()=>{if(!reply.raw.writableEnded)abort.abort()};request.raw.once('aborted',cancel);reply.raw.once('close',cancel);
  reply.header('cache-control','private, no-store');
  try{
   const owner=options.actor(request),{projectId:project,executionId:id}=request.params as {projectId:string;executionId:string},executions=options.executions;
   if(Object.keys(request.query as object).length)throw Error('git_execution_invalid');
   abort.signal.throwIfAborted();const before=executions.status(owner,project,id);
   if(!recovery){
    if(before.execution.state==='applied'&&before.workspace_state==='released_settled')return before;
    if(before.execution.state!=='pending'||before.producer.state!=='not_started'||before.control!==null)throw Error('git_index_reconciliation_required');
    if(!options.client)throw Error('git_index_dispatch_unavailable');
    const scope:NativeGitRequest=Object.freeze({owner_id:owner,project_id:project,execution_id:id,operation_kind:'git_index'});
    await options.client.execute(scope,abort.signal);abort.signal.throwIfAborted();
    const status=executions.status(owner,project,id);
    if(status.execution.state!=='applied'||status.workspace_state!=='released_settled')throw Error('git_index_dispatch_unconfirmed');
    return status;
   }
   const raw=request.body as GitIndexControlInput,command=Object.freeze({request_id:raw.request_id,expected_state_sha256:raw.expected_state_sha256,acknowledge_unknown:raw.acknowledge_unknown});
   const accepted=executions.getResolutionAdmission(owner,project,id,command.request_id);
   if(accepted.expected_state_sha256!==command.expected_state_sha256||command.acknowledge_unknown!==true)throw Error('idempotency_conflict');
   // Only the owning execution service can prove and close never-started work.
   // It repeats its original checks in the disposition transaction. Started
   // work always goes through the original authenticated native custody path.
   if(before.workspace_state==='released_settled'||before.workspace_state==='not_reserved'&&before.producer.state==='not_started'){
    await executions.resolveReserved(owner,project,id,command,abort.signal);
   }else{
    if(!options.client)throw Error('git_index_dispatch_unavailable');
    const scope:NativeGitRequest=Object.freeze({owner_id:owner,project_id:project,execution_id:id,operation_kind:'git_index',command});
    await options.client.execute(scope,abort.signal);
   }
   abort.signal.throwIfAborted();const status=executions.status(owner,project,id),receipt=executions.getControl(owner,project,id,command.request_id);
   const noNativeWork=status.workspace_state==='not_reserved'&&status.producer.state==='not_started'&&status.execution.state==='not_dispatched';
   if(receipt.state!=='completed'||JSON.stringify(status.control_receipt)!==JSON.stringify(receipt)||status.workspace_state!=='released_settled'&&!noNativeWork)throw Error('git_index_dispatch_unconfirmed');
   return{receipt,status};
  }catch(error){
   const code=error instanceof Error?error.message:'',known:Record<string,number>={unauthorized:401,project_not_found:404,git_execution_not_found:404,git_admission_not_found:404,git_execution_control_not_found:404,
    git_execution_invalid:400,git_execution_control_invalid:400,idempotency_conflict:409,idempotency_in_progress:409,git_index_reconciliation_required:409,
    git_repository_unconfigured:503,git_index_dispatch_unavailable:503,git_index_dispatch_unconfirmed:503};
   return reply.code(Object.hasOwn(known,code)?known[code]!:503).send({error:{code:Object.hasOwn(known,code)?code.toUpperCase():'GIT_INDEX_DISPATCH_UNAVAILABLE'}});
  }finally{request.raw.removeListener('aborted',cancel);reply.raw.removeListener('close',cancel)}
 };
 app.post('/v1/projects/:projectId/git/executions/:executionId/dispatch',(request,reply)=>route(request,reply,false));
 app.post('/v1/projects/:projectId/git/executions/:executionId/resolve',(request,reply)=>route(request,reply,true));
}
