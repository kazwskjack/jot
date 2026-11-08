import type {FastifyInstance} from 'fastify';
import {normalizeChannelRuntimeMessage,validateChannelIntakeReceipt,validateChannelMatrixTerminalRefusal,
 type ChannelRuntimeOptions,type ChannelRuntimeHandle,type RegisterChannelRoutes} from './runtime-contracts.ts';
import {registerChannelARoutes,validateChannelAConfiguration,
 type ChannelAVerificationConfig} from './adapters/channel-a-runtime.ts';

/** Actual service adapter. Protocol verification precedes the single original intake port. */
export const registerChannelAConsumer:RegisterChannelRoutes<ChannelAVerificationConfig> = (
 app:FastifyInstance,options:ChannelRuntimeOptions<ChannelAVerificationConfig>,
):ChannelRuntimeHandle=>{
 const runtime=registerChannelARoutes(app,{channels:validateChannelAConfiguration(options.channels),
  forward:async(message,signal)=>{
   const result=await options.forward(normalizeChannelRuntimeMessage(message),signal);
   if(result.statusCode>=200&&result.statusCode<300)validateChannelIntakeReceipt(result.body);
   return result;
  },
  ...(options.attachmentForward?{attachmentForward:async(input,signal)=>{
   const result=await options.attachmentForward!(input,signal);
   if(result.statusCode>=200&&result.statusCode<300)validateChannelIntakeReceipt(result.body);
   return result;
  }}:{ }),
  ...(options.lookupMatrixTerminalRefusal?{lookupMatrixTerminalRefusal:options.lookupMatrixTerminalRefusal}:{})});
 return {
  start:()=>runtime.start(),stop:()=>runtime.stop(),uninstall:()=>runtime.uninstall(),
  async pollMatrix(since){
   const batch=await runtime.pollMatrix(since);
   return {nextBatch:batch.nextBatch,receipts:batch.receipts.map(validateChannelIntakeReceipt),
    ...(batch.terminalRefusals?{terminalRefusals:batch.terminalRefusals.map(validateChannelMatrixTerminalRefusal)}:{})};
  },
 };
};
