import {randomUUID,createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {withImmediateTransaction} from '../db/database.ts';
import {assertExecutionLease} from '../workbench/execution-lease.ts';
import type {GitPublicationEffects} from '../git/publication-effects.ts';
import {FinalizedWorkSources} from './finalized-work-sources.ts';
import {appendWorkPublicationJournal,readWorkPublicationJournal,publicationWorkerResource} from './work-publication-journal.ts';
import type {WorkPublicationExecutions} from './work-publication-executions.ts';
import {canonicalJson} from '../db/canonical-json.ts';

type Row=Record<string,any>;
const createExecutionHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
/** One original, foreground producer. No queue, planner, model, route, caller
 * executor or replacement lease store. Its Host context is nonserializable. */
export async function produceWorkPublication(options:{db:DatabaseSync;row:Row;source:WorkPublicationExecutions;context:object;kernel:GitPublicationEffects}){
 const {db,row,source,context,kernel}=options;if(db.isTransaction)throw Error('work_publication_async_transaction');
 await source.verifyNativeSource(context);const held=source.inspectNativeSource(context),resource=publicationWorkerResource(row),leaseMs=30000;
 const signal=held.signal,checkSource=()=>source.assertNativeSource(context);
 const lease=withImmediateTransaction(db,()=>{
  checkSource();if(readWorkPublicationJournal(db,row).start)throw Error('work_publication_producer_closed');
  const previous=db.prepare('SELECT owner,generation,expires_at FROM ga_worker_leases WHERE resource_id=?').get(resource) as Row|undefined;
  if(previous&&(!Number.isSafeInteger(Number(previous.generation))||Number(previous.generation)<1||!Number.isSafeInteger(Number(previous.expires_at))||Number(previous.expires_at)>Date.now()))throw Error('work_publication_producer_busy');
  const lease={owner:'work-publisher-'+randomUUID(),generation:previous?Number(previous.generation)+1:1};if(!Number.isSafeInteger(lease.generation))throw Error('work_publication_producer_busy');
  db.prepare('INSERT INTO ga_worker_leases(resource_id,owner,generation,expires_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET owner=excluded.owner,generation=excluded.generation,expires_at=excluded.expires_at,updated_at=excluded.updated_at').run(resource,lease.owner,lease.generation,String(Date.now()+leaseMs),new Date().toISOString());
  assertExecutionLease(db,resource,lease);appendWorkPublicationJournal(db,row,'start',{execution_sha256:createExecutionHash(row),lease,started_at:new Date().toISOString()});return lease;
 });
 const abort=new AbortController(),cancel=()=>abort.abort(signal.reason);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
 const authorize=()=>{abort.signal.throwIfAborted();checkSource();assertExecutionLease(db,resource,lease);};
 const timer=setInterval(()=>{try{withImmediateTransaction(db,()=>{authorize();db.prepare('UPDATE ga_worker_leases SET expires_at=?,updated_at=? WHERE resource_id=? AND owner=? AND generation=?').run(String(Date.now()+leaseMs),new Date().toISOString(),resource,lease.owner,lease.generation);});}catch(error){abort.abort(error)}},Math.floor(leaseMs/3));timer.unref();
 try{
  const input=held.source,materials=new FinalizedWorkSources(db).readSelection(row.owner_id,input.source.run_id,input.paths,input.source.source_sha256).files;
  authorize();const plan=await kernel.preparePublication(input.target,input.changes,materials,abort.signal);authorize();
  await kernel.applyPublication(plan,{
   authorize,
   prepared:value=>withImmediateTransaction(db,()=>{authorize();appendWorkPublicationJournal(db,row,'prepared',value)}),
   intent:value=>withImmediateTransaction(db,()=>{authorize();appendWorkPublicationJournal(db,row,'intent',value)}),
   apply:(_step,operation)=>withImmediateTransaction(db,()=>{authorize();const effect=operation();authorize();appendWorkPublicationJournal(db,row,'effect',effect);return effect}),
   completed:value=>withImmediateTransaction(db,()=>{authorize();appendWorkPublicationJournal(db,row,'applied',value)})
  },abort.signal);
  authorize();return readWorkPublicationJournal(db,row).receipt!;
 }finally{
  clearInterval(timer);signal.removeEventListener('abort',cancel);
  try{withImmediateTransaction(db,()=>{
   assertExecutionLease(db,resource,lease);const current=readWorkPublicationJournal(db,row);
   const state=current.applied?'applied':current.effects.length||current.pending?'unknown':current.plan?'prepared':abort.signal.aborted?'cancelled_before_preparation':'failed_before_preparation';
   appendWorkPublicationJournal(db,row,'finish',{state,finished_at:new Date().toISOString()});
  });}finally{withImmediateTransaction(db,()=>{db.prepare('DELETE FROM ga_worker_leases WHERE resource_id=? AND owner=? AND generation=?').run(resource,lease.owner,lease.generation)});}
 }
}

