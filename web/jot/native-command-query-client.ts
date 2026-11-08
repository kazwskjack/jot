import {request,taskDraftScope} from './client';
import {validateNativeCommandQuery,validateNativeCommandQueryIdentity,validateNativeCommandQueryResult} from '../../packages/skills/command-query.js';
import type {NativeCommandQuery,NativeCommandQueryOperation,NativeCommandQuerySummary} from '../../packages/gateway/contracts/types';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const states=['prepared','dispatched','settled','rejected','unknown'];
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function current(ownerScope:string,runId:string,signal?:AbortSignal){
 signal?.throwIfAborted();
 if(!ID.test(runId)||!/^[a-f0-9]{64}$/.test(ownerScope)||taskDraftScope()!==ownerScope)throw Error('NATIVE_QUERY_SCOPE_CHANGED');
}
export function validateNativeCommandOperationSummary<N extends string>(value:unknown,runId:string,names:readonly N[]):Omit<NativeCommandQuerySummary,'name'>&{name:N}{
 if(!object(value)||Object.keys(value).sort().join(',')!=='name,request_id,run_id,state,updated_at'
  ||typeof value.request_id!=='string'||!UUID.test(value.request_id)||value.run_id!==runId
  ||typeof value.name!=='string'||!names.includes(value.name as N)||typeof value.state!=='string'||!states.includes(value.state)
  ||typeof value.updated_at!=='string'||!Number.isFinite(Date.parse(value.updated_at)))throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
 return value as unknown as Omit<NativeCommandQuerySummary,'name'>&{name:N};
}
const summary=(value:unknown,runId:string)=>validateNativeCommandOperationSummary(value,runId,['permission','goal'] as const);
export async function listNativeCommandQueries(runId:string,ownerScope:string,signal:AbortSignal,history?:{before?:string}){
 current(ownerScope,runId,signal);
 if(history?.before!==undefined&&!UUID.test(history.before))throw Error('NATIVE_QUERY_REQUEST_INVALID');
 const query=history?'?history=1'+(history.before?'&before='+encodeURIComponent(history.before):''):'';
 const value=await request<unknown>(`/runs/${encodeURIComponent(runId)}/native-command-queries${query}`,'GET',undefined,undefined,signal);
 current(ownerScope,runId,signal);
 if(!object(value)||Object.keys(value).join(',')!=='items'||!Array.isArray(value.items)||value.items.length>50)throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
 const seen=new Set<string>();
 return value.items.map(value=>{const item=summary(value,runId);if(seen.has(item.request_id))throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');seen.add(item.request_id);return item;});
}
export async function readNativeCommandQuery(runId:string,ownerScope:string,requestId:string,signal:AbortSignal):Promise<NativeCommandQueryOperation>{
 current(ownerScope,runId,signal);if(!UUID.test(requestId))throw Error('NATIVE_QUERY_REQUEST_INVALID');
 const value=await request<unknown>(`/runs/${encodeURIComponent(runId)}/native-command-queries/${encodeURIComponent(requestId)}`,'GET',undefined,undefined,signal);
 current(ownerScope,runId,signal);
 if(!object(value))throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
 const {result,...fields}=value,item=summary(fields,runId);
 if(item.request_id!==requestId||item.state!=='settled'&&Object.hasOwn(value,'result'))throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
 return item.state==='settled'?{...item,result:validateNativeCommandQueryResult(result)}:item;
}
export async function submitNativeCommandQuery(runId:string,ownerScope:string,input:NativeCommandQuery,signal:AbortSignal){
 current(ownerScope,runId,signal);const command=validateNativeCommandQuery(input);
 try{
  const value=await request<unknown>(`/runs/${encodeURIComponent(runId)}/native-command-queries`,'POST',command,command.request_id,signal);
  current(ownerScope,runId,signal);
  if(!object(value)||Object.keys(value).sort().join(',')!=='accepted,request_id,run_id'||value.accepted!==true
   ||value.request_id!==command.request_id||value.run_id!==runId)throw Error('NATIVE_QUERY_RESPONSE_UNKNOWN');
 }catch{current(ownerScope,runId,signal);}
 return readNativeCommandQuery(runId,ownerScope,command.request_id,signal);
}
export type PendingNativeQuery={request_id:string;name:'permission'|'goal'};
export async function closeNativeCommandQuery(runId:string,ownerScope:string,original:PendingNativeQuery,signal:AbortSignal){
 current(ownerScope,runId,signal);pending(original);
 try{await request(`/runs/${encodeURIComponent(runId)}/native-command-queries/${encodeURIComponent(original.request_id)}/close`,'POST',{name:original.name},original.request_id,signal);}
 catch{current(ownerScope,runId,signal);}
 return readNativeCommandQuery(runId,ownerScope,original.request_id,signal);
}
export async function reconcileNativeCommandQuery(runId:string,ownerScope:string,requestId:string,signal:AbortSignal){
 current(ownerScope,runId,signal);if(!UUID.test(requestId))throw Error('NATIVE_QUERY_REQUEST_INVALID');
 let failure:unknown;
 try{await request(`/runs/${encodeURIComponent(runId)}/native-command-queries/${encodeURIComponent(requestId)}/reconcile`,'POST',{},requestId,signal);}
 catch(cause){current(ownerScope,runId,signal);failure=cause;}
 const original=await readNativeCommandQuery(runId,ownerScope,requestId,signal);
 if(failure&&!['settled','rejected'].includes(original.state))throw failure;
 return original;
}
function pending(value:unknown):PendingNativeQuery{
 try{return validateNativeCommandQueryIdentity(value);}catch{throw Error('NATIVE_QUERY_RECOVERY_INVALID');}
}
/** One same-tab original request identity, backed by the server operation list. */
export class NativeCommandQueryStore<T extends {request_id:string;name:string}=PendingNativeQuery>{
 private readonly key:string;
 constructor(private readonly ownerScope:string,private readonly runId:string,private readonly policy?:{kind:'plan';validate:(value:unknown)=>T}){
  this.key=`jot-native-command-${policy?.kind??'query'}/v1/${ownerScope}/${runId}`;
 }
 private validate(value:unknown):T{return this.policy?this.policy.validate(value):pending(value) as unknown as T;}
 private storage(){current(this.ownerScope,this.runId);try{return globalThis.sessionStorage;}catch{throw Error('NATIVE_QUERY_RECOVERY_UNAVAILABLE');}}
 read():T|null{
  let raw:string|null;try{raw=this.storage().getItem(this.key);}catch{throw Error('NATIVE_QUERY_RECOVERY_UNAVAILABLE');}
  if(raw===null)return null;
  if(raw.length>512)throw Error('NATIVE_QUERY_RECOVERY_INVALID');
  try{return this.validate(JSON.parse(raw));}catch{throw Error('NATIVE_QUERY_RECOVERY_INVALID');}
 }
 save(value:T){
  this.validate(value);const old=this.read();
  if(old&&(old.request_id!==value.request_id||old.name!==value.name))throw Error('NATIVE_QUERY_RECOVERY_PENDING');
  try{this.storage().setItem(this.key,JSON.stringify(value));}catch{throw Error('NATIVE_QUERY_RECOVERY_UNAVAILABLE');}
  if(JSON.stringify(this.read())!==JSON.stringify(value))throw Error('NATIVE_QUERY_RECOVERY_UNAVAILABLE');
 }
 complete(requestId:string){
  const old=this.read();if(old?.request_id!==requestId)return;
  try{this.storage().removeItem(this.key);}catch{throw Error('NATIVE_QUERY_RECOVERY_UNAVAILABLE');}
  if(this.read()!==null)throw Error('NATIVE_QUERY_RECOVERY_UNAVAILABLE');
 }
}
export {current as assertNativeCommandScope};
export function createNativeCommandQueryClient(runId:string,ownerScope:string){
 return {
  list:(signal:AbortSignal,history?:{before?:string})=>listNativeCommandQueries(runId,ownerScope,signal,history),
  read:(id:string,signal:AbortSignal)=>readNativeCommandQuery(runId,ownerScope,id,signal),
  submit:(input:unknown,signal:AbortSignal)=>submitNativeCommandQuery(runId,ownerScope,validateNativeCommandQuery(input),signal),
  close:(identity:unknown,signal:AbortSignal)=>closeNativeCommandQuery(runId,ownerScope,pending(identity),signal),
  reconcile:(id:string,signal:AbortSignal)=>reconcileNativeCommandQuery(runId,ownerScope,id,signal),
 };
}
