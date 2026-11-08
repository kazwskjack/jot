import {request} from './client';
import {assertNativeCommandScope,validateNativeCommandOperationSummary} from './native-command-query-client';
import {validateNativePlanMode,validateNativePlanIdentity} from '../../packages/skills/plan-mode-command.js';
import {validateNativeCommandQueryResult} from '../../packages/skills/command-query.js';
import type {NativePlanModeOperation,NativePlanModeSummary} from '../../packages/gateway/contracts/types';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function summary(value:unknown,runId:string):NativePlanModeSummary{
 if(!object(value)||value.enabled!==null&&typeof value.enabled!=='boolean')throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
 const {enabled,...fields}=value;
 const original=validateNativeCommandOperationSummary(fields,runId,['plan'] as const);
 if(enabled===null&&original.state!=='rejected')throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
 return {...original,enabled};
}
export function createNativePlanModeClient(runId:string,ownerScope:string){
 const path=`/runs/${encodeURIComponent(runId)}/native-plan-mode`;
 const current=(signal:AbortSignal)=>assertNativeCommandScope(ownerScope,runId,signal);
 const identity=(id:string)=>validateNativePlanIdentity({request_id:id,name:'plan'});
 async function read(id:string,signal:AbortSignal):Promise<NativePlanModeOperation>{
  current(signal);identity(id);
  const value=await request<unknown>(path+'/'+encodeURIComponent(id),'GET',undefined,undefined,signal);
  current(signal);
  if(!object(value))throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
  const {result,...fields}=value;
  const original=summary(fields,runId);
  if(original.request_id!==id||original.state!=='settled'&&Object.hasOwn(value,'result'))throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
  return original.state==='settled'?{...original,result:validateNativeCommandQueryResult(result)}:original;
 }
 async function mutate(id:string,action:'close'|'reconcile',signal:AbortSignal){
  current(signal);identity(id);
  let failure:unknown;
  try{await request(path+'/'+encodeURIComponent(id)+'/'+action,'POST',action==='close'?{name:'plan'}:{},id,signal);}
  catch(cause){current(signal);failure=cause;}
  const original=await read(id,signal);
  if(action==='reconcile'&&failure&&!['settled','rejected'].includes(original.state))throw failure;
  return original;
 }
 return {
  async list(signal:AbortSignal,history?:{before?:string}){
   current(signal);
   if(history?.before)identity(history.before);
   const query=history?'?history=1'+(history.before?'&before='+encodeURIComponent(history.before):''):'';
   const value=await request<unknown>(path+query,'GET',undefined,undefined,signal);
   current(signal);
   if(!object(value)||Object.keys(value).join(',')!=='items'||!Array.isArray(value.items)||value.items.length>50)throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
   const seen=new Set<string>();
   return value.items.map(value=>{
    const original=summary(value,runId);
    if(seen.has(original.request_id))throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
    seen.add(original.request_id);
    return original;
   });
  },
  read,
  async submit(input:unknown,signal:AbortSignal){
   current(signal);
   const original=validateNativePlanMode(input);
   try{
    const receipt=await request<unknown>(path,'POST',original,original.request_id,signal);
    current(signal);
    if(!object(receipt)||Object.keys(receipt).sort().join(',')!=='accepted,request_id,run_id'
     ||receipt.accepted!==true||receipt.request_id!==original.request_id||receipt.run_id!==runId)throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
   }catch{current(signal);}
   return read(original.request_id,signal);
  },
  close:(value:unknown,signal:AbortSignal)=>mutate(validateNativePlanIdentity(value).request_id,'close',signal),
  reconcile:(id:string,signal:AbortSignal)=>mutate(id,'reconcile',signal),
 };
}
