import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';

// Two independently installed host plugins share this process-local store.
// It is never a mutable "current run": AsyncLocalStorage isolates each call,
// and the unregistered registry token binds the store to one exact execution.
const key=Symbol.for('jot.host.native-budget-context.v1');
if(globalThis[key]===undefined)Object.defineProperty(globalThis,key,{
  value:Object.freeze({protocol:1,storage:new AsyncLocalStorage()}),writable:false,configurable:false,
});
const shared=globalThis[key];
if(shared?.protocol!==1||!(shared.storage instanceof AsyncLocalStorage))throw new Error('native_budget_context_incompatible');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);

function identity(exec){
  if(typeof exec?.token!=='symbol'||Symbol.keyFor(exec.token)!==undefined
    ||!id(exec.callId)||!id(exec.name)||!id(exec.agent?.id))throw new Error('native_budget_execution_invalid');
  return {token:exec.token,call:exec.callId,name:exec.name,session:exec.agent.id,hash:nativeRequestHash(exec)};
}
export function nativeRequestHash(exec){
  let body;try{body=JSON.stringify(exec?.arguments);}catch{throw new Error('native_budget_arguments_invalid');}
  if(typeof body!=='string'||Buffer.byteLength(body)>1048576)throw new Error('native_budget_arguments_invalid');
  return createHash('sha256').update(body).digest('hex');
}
export function nativeExecutionHash(exec){return identity(exec).hash;}
export async function withNativeBudget(exec,grant,next){
  if(typeof grant!=='string'||!/^[a-f0-9]{64}$/.test(grant)||typeof next!=='function')throw new Error('native_budget_ticket_invalid');
  const record={...identity(exec),grant,active:true};
  return shared.storage.run(record,async()=>{try{return await next();}finally{record.active=false;}});
}
export function nativeBudgetForExecution(exec){
  const record=shared.storage.getStore();
  if(record===undefined)return undefined;
  const current=identity(exec);
  if(!record.active||['token','call','name','session','hash'].some(field=>current[field]!==record[field]))
    throw new Error('native_budget_execution_conflict');
  return record.grant;
}
