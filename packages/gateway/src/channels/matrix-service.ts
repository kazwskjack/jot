import Fastify from 'fastify';
import type {DatabaseSync} from 'node:sqlite';
import {createMatrixAdapter} from './adapters/matrix.ts';
import {MatrixSyncState} from './matrix-sync-state.ts';
import type {ChannelAVerificationConfig} from './adapters/channel-a-runtime.ts';
import {registerChannelAConsumer} from './channel-a-consumer.ts';
import {createChannelForward,validateChannelIntakeReceipt,validateChannelMatrixTerminalRefusal,
 type RegisterChannelRoutes,type ChannelMatrixPollResult} from './runtime-contracts.ts';
import {createChannelAttachmentForwardV2} from './attachment-forward-v2.ts';
import {channelAttachmentIntakeConfiguration} from './attachment-config-v2.ts';

type Environment=Readonly<Record<string,string|undefined>>;
type Dependencies=Readonly<{db?:DatabaseSync;matrixFetch?:typeof fetch;gatewayFetch?:typeof fetch;
 register?:RegisterChannelRoutes<ChannelAVerificationConfig>}>;

/** Called by the existing channels worker, never opens a second listener or stores authority. */
export async function startMatrixChannelService(env:Environment,dependencies:Dependencies={}){
 const baseUrl=env.GENERAL_AGENT_MATRIX_BASE_URL,accessToken=env.GENERAL_AGENT_MATRIX_ACCESS_TOKEN;
 if(baseUrl===undefined&&accessToken===undefined)return;
 const url=env.GENERAL_AGENT_GATEWAY_INTERNAL_URL,token=env.GENERAL_AGENT_INTERNAL_CHANNEL_TOKEN;
 if(!baseUrl||!accessToken||!url||!token)throw Error('matrix_service_config_required');
 const db=dependencies.db;
 if(!db)throw Error('matrix_service_database_required');
 // Validate all configuration before allocating a host or starting a runtime.
 const client=createMatrixAdapter({baseUrl,accessToken},dependencies.matrixFetch);
 const forward=createChannelForward({url,token,...(dependencies.gatewayFetch?{fetch:dependencies.gatewayFetch}:{})});
 const attachmentEnabled=channelAttachmentIntakeConfiguration(env).channelAttachmentIntakeV2;
 const attachmentForward=attachmentEnabled
  ?createChannelAttachmentForwardV2({url,token,...(dependencies.gatewayFetch?{fetch:dependencies.gatewayFetch}:{})})
  :undefined;
 const accountId=await client.whoAmI();
 const syncState=new MatrixSyncState(db);
 const initialCursor=syncState.load(accountId);
 const lookupMatrixTerminalRefusal=(providerMessageId:string,sourceSha256:string)=>
  syncState.findTerminalRefusal(accountId,providerMessageId,sourceSha256);
 const app=Fastify({logger:false});
 let runtime;
 try{
  runtime=await (dependencies.register??registerChannelAConsumer)(app,{channels:{matrix:{client}},forward,
   lookupMatrixTerminalRefusal,...(attachmentForward?{attachmentForward}:{})});
  if(typeof runtime.pollMatrix!=='function')throw Error('matrix_service_poll_missing');
  await app.ready();await runtime.start();
 }catch(error){
  const failures:unknown[]=[error];
  try{await runtime?.uninstall();}catch(cleanup){failures.push(cleanup);}
  try{await app.close();}catch(cleanup){failures.push(cleanup);}
  if(failures.length>1)throw new AggregateError(failures,'matrix_service_start_cleanup_failed');
  throw error;
 }
 const activeRuntime=runtime;
 let state:'started'|'stopped'|'closed'='started',polling=false,since=initialCursor.next_batch??undefined,generation=initialCursor.generation;
 let closing:Promise<void>|undefined;
 return {
  cursor:()=>since??null,
  async poll():Promise<ChannelMatrixPollResult>{
   if(state!=='started')throw Error('matrix_service_'+state);
   if(polling)throw Error('matrix_service_poll_in_progress');
   polling=true;
   try{
    const batch=await activeRuntime.pollMatrix!(since);
    if(state!=='started')throw Error('matrix_service_'+state);
    if(!batch||typeof batch.nextBatch!=='string'||!batch.nextBatch||batch.nextBatch.length>1024
     ||!Array.isArray(batch.receipts)||(batch.terminalRefusals!==undefined&&!Array.isArray(batch.terminalRefusals)))throw Error('matrix_service_batch_invalid');
    const receipts=batch.receipts.map(validateChannelIntakeReceipt);
    const terminalRefusals=(batch.terminalRefusals??[]).map(validateChannelMatrixTerminalRefusal);
    const committed=syncState.commitBatch({account_id:accountId,expected_next_batch:since??null,
     expected_generation:generation,next_batch:batch.nextBatch,terminal_refusals:terminalRefusals});
    since=committed.next_batch??undefined;generation=committed.generation;
    return {nextBatch:since!,receipts,...(terminalRefusals.length?{terminalRefusals}:{})};
   }finally{polling=false;}
  },
  async stop(){if(state==='closed')return;state='stopped';await activeRuntime.stop();},
  close(){
   if(closing)return closing;
   const stopRequired=state==='started';state='closed';
   closing=(async()=>{
    const failures:unknown[]=[];
    if(stopRequired)try{await activeRuntime.stop();}catch(error){failures.push(error);}
    try{await activeRuntime.uninstall();}catch(error){failures.push(error);}
    try{await app.close();}catch(error){failures.push(error);}
    if(failures.length===1)throw failures[0];
    if(failures.length>1)throw new AggregateError(failures,'matrix_service_close_failed');
   })();return closing;
  },
 };
}
