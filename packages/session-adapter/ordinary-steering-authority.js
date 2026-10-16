import {createHash} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';import {normalizeHostExecutionLease} from './workbench.js';
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const fail=()=>{throw Error('ordinary_input_admission_unconfirmed');};
const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
export function normalizeOrdinarySteeringExecution(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='command_id,execution_lease,run_id'||!valid(value.run_id)||!valid(value.command_id)||value.command_id===value.run_id)fail();
 return freeze({runId:value.run_id,commandId:value.command_id,executionLease:normalizeHostExecutionLease(value.execution_lease)});
}
export function hashNativeSteeringContent(content){
 if(!Array.isArray(content)||content.length!==1||!content[0]||Object.keys(content[0]).sort().join(',')!=='text,type'||content[0].type!=='text'||typeof content[0].text!=='string'||!content[0].text.trim())fail();
 return createHash('sha256').update(JSON.stringify([{type:'text',text:content[0].text}])).digest('hex');
}
/** Existing command/parent identity only, never an execution grant. */
export async function readOrdinarySteeringAuthority({bridge,binding,signal,assertActive=()=>{}}){
 const check=()=>{signal?.throwIfAborted();assertActive();};check();const result=await bridge.request('ordinary-steering-binding',binding,{command_id:binding.commandId},signal);check();const row=result?.binding;
 const keys='command_id,command_sha256,conversation_id,execution_authorized,execution_lease,input_message_id,input_sha256,kind,native_content_sha256,original_input_message_id,original_input_sha256,owner_id,protocol,request_id,run_id,session_id';
 if(!row||Object.keys(row).sort().join(',')!==keys||row.protocol!==1||row.kind!=='ordinary_steer'||row.execution_authorized!==false||row.run_id!==binding.runId||row.command_id!==binding.commandId||row.request_id!==binding.commandId||row.input_message_id!=='message-'+binding.commandId||row.session_id!==binding.sessionRef||!isDeepStrictEqual(row.execution_lease,binding.executionLease)||!['input_message_id','original_input_message_id','conversation_id','owner_id','session_id'].every(k=>valid(row[k]))||!['command_sha256','input_sha256','native_content_sha256','original_input_sha256'].every(k=>/^[a-f0-9]{64}$/.test(row[k]??'')))fail();
 return freeze(structuredClone(row));
}
