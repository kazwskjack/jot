import type {FastifyInstance} from 'fastify';
import type {WorkPublicationExecutions} from '../persistent-tasks/work-publication-executions.ts';
import type {NativeGitClient,NativeGitRequest} from './native-transport-client.ts';

type Options={executions:WorkPublicationExecutions|undefined;client:NativeGitClient|undefined;actor:(request:any)=>string};
/** Explicit IO commands use original native custody and journal, not the
 * synchronous admission transaction. Pending HTTP commands never auto-replay. */
export function registerPublicationDispatchRoutes(app:FastifyInstance,options:Options){
 const route=async(request:any,reply:any,kind:'dispatch'|'settle'|'receipt')=>{
  const abort=new AbortController(),cancel=()=>{if(!reply.raw.writableEnded)abort.abort()};request.raw.once('aborted',cancel);reply.raw.once('close',cancel);
  reply.header('cache-control','private, no-store');
  try{
   const owner=options.actor(request),params=request.params as {projectId:string;executionId:string;requestId?:string};
   if(Object.keys(request.query as object).length)throw Error('work_publication_execution_invalid');
   const executions=options.executions;if(!executions)throw Error('git_repository_unconfigured');
   if(kind==='receipt')return executions.publicationSettlementReceipt(owner,params.projectId,params.executionId,params.requestId);
   const before=executions.publicationStatus(owner,params.projectId,params.executionId);
   if(kind==='dispatch'&&before.state==='applied')return before;
   if(kind==='dispatch'&&before.state!=='not_started')throw Error('work_publication_reconciliation_required');
   const client=options.client;if(!client)throw Error('work_publication_dispatch_unavailable');
   const command=kind==='settle'?Object.freeze(structuredClone(request.body) as Parameters<WorkPublicationExecutions['settlePublication']>[3]):undefined;
   const scope:NativeGitRequest=Object.freeze({owner_id:owner,project_id:params.projectId,execution_id:params.executionId,operation_kind:'work_publication',...(command?{command}:{})});
   // The native acknowledgement is not a new result authority. Read the
   // original database, rather than returning arbitrary peer-supplied JSON.
   await client.execute(scope,abort.signal);abort.signal.throwIfAborted();
   const status=executions.publicationStatus(owner,params.projectId,params.executionId);
   if(!command){if(status.state!=='applied')throw Error('work_publication_dispatch_unconfirmed');return status}
   const receipt=executions.publicationSettlementReceipt(owner,params.projectId,params.executionId,command.request_id);
   if(receipt.action!==command.action||receipt.expected_journal_sha256!==command.expected_journal_sha256||command.acknowledge_unknown!==true)throw Error('work_publication_disposition_conflict');
   if(status.state!==(command.action==='confirm_recorded'?'applied':'abandoned_unknown'))throw Error('work_publication_dispatch_unconfirmed');
   return{receipt,status};
  }catch(error){
   const code=error instanceof Error?error.message:'',known:Record<string,number>={unauthorized:401,project_not_found:404,work_publication_execution_not_found:404,work_publication_settlement_not_found:404,
    work_publication_execution_invalid:400,work_publication_reconciliation_required:409,work_publication_disposition_conflict:409,work_publication_review_changed:409,
    idempotency_conflict:409,idempotency_in_progress:409,git_repository_unconfigured:503,work_publication_dispatch_unavailable:503,work_publication_dispatch_unconfirmed:503};
   return reply.code(Object.hasOwn(known,code)?known[code]!:503).send({error:{code:Object.hasOwn(known,code)?code.toUpperCase():'WORK_PUBLICATION_DISPATCH_UNAVAILABLE'}});
  }finally{request.raw.removeListener('aborted',cancel);reply.raw.removeListener('close',cancel)}
 };
 app.post('/v1/projects/:projectId/work-publication-executions/:executionId/dispatch',(request,reply)=>route(request,reply,'dispatch'));
 app.post('/v1/projects/:projectId/work-publication-executions/:executionId/settle',(request,reply)=>route(request,reply,'settle'));
 app.get('/v1/projects/:projectId/work-publication-executions/:executionId/settlements/:requestId',(request,reply)=>route(request,reply,'receipt'));
 app.get('/v1/projects/:projectId/work-publication-executions/:executionId/settlement',(request,reply)=>route(request,reply,'receipt'));
}
