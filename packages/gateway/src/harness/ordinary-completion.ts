import {isDeepStrictEqual} from 'node:util';
import type {OriginalInputExecution} from './session-controller-client.ts';
export type OrdinaryCompletionProof={protocol:1;status:'complete';run_id:string;session_id:string;execution_lease:OriginalInputExecution['execution_lease'];input_sha256:string;command_ids:string[];native_message_ids:string[];answer_sha256:string;answer_seq:number;turn_end_seq:number;snapshot_seq:number;execution_authorized:false};
export type OrdinaryCompletionView=OrdinaryCompletionProof|{protocol:1;status:'busy';wait_for:'idle'|'events';execution_authorized:false};
const valid=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
export function validateOrdinaryCompletion(value:unknown,sessionId:string,execution:OriginalInputExecution,commands:readonly string[]):OrdinaryCompletionView{
 function fail():never{throw Error('ordinary_completion_proof_invalid');}
 if(!value||typeof value!=='object'||Array.isArray(value))fail();const row=value as Record<string,unknown>,keys=Object.keys(row).sort().join(',');
 if(row.protocol!==1||row.execution_authorized!==false)fail();
 if(row.status==='busy'){if(keys!=='execution_authorized,protocol,status,wait_for'||!['idle','events'].includes(String(row.wait_for)))fail();return structuredClone(value) as OrdinaryCompletionView;}
 if(keys!=='answer_seq,answer_sha256,command_ids,execution_authorized,execution_lease,input_sha256,native_message_ids,protocol,run_id,session_id,snapshot_seq,status,turn_end_seq'||row.status!=='complete'||row.run_id!==execution.run_id||row.session_id!==sessionId||!isDeepStrictEqual(row.execution_lease,execution.execution_lease)||!isDeepStrictEqual(row.command_ids,commands)||!Array.isArray(row.native_message_ids)||row.native_message_ids.length!==commands.length+1||row.native_message_ids.some(id=>!valid(id))||new Set(row.native_message_ids).size!==row.native_message_ids.length||!['input_sha256','answer_sha256'].every(k=>typeof row[k]==='string'&&/^[a-f0-9]{64}$/.test(row[k] as string))||!['answer_seq','turn_end_seq','snapshot_seq'].every(k=>Number.isSafeInteger(row[k])&&Number(row[k])>=0)||!(Number(row.answer_seq)<Number(row.turn_end_seq)&&Number(row.turn_end_seq)<Number(row.snapshot_seq)))fail();
 return structuredClone(value) as OrdinaryCompletionProof;
}
