import {createHash} from 'node:crypto';
import {ordinaryHistorySourceSha256} from './ordinary-steering-observation.ts';
import {assistantText} from './session-output.ts';
export type OrdinaryRunHistoryScope=Readonly<{owner_id:string;conversation_id:string;run_id:string;expected_run_version:number}>;
export type OrdinaryRunCompletion={protocol:1;kind:'ordinary_run_completion';run_id:string;session_id:string;run_version:number;source_sha256:string;raw_sha256:string;raw_event_count:number;profile_fingerprint:string;command_ids:string[];native_message_ids:string[];answer_sha256:string;answer_seq:number;turn_end_seq:number;answer_event:Record<string,unknown>;output_events:Record<string,unknown>[];execution_authorized:false};
const valid=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const row=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function invalid():never{throw Error('ordinary_run_completion_contract_invalid');}
export function normalizeOrdinaryRunHistoryScope(sessionId:string,value:unknown):OrdinaryRunHistoryScope{
 if(!valid(sessionId)||!row(value)||Object.keys(value).sort().join(',')!=='conversation_id,expected_run_version,owner_id,run_id'||!['owner_id','conversation_id','run_id'].every(k=>valid(value[k]))||!Number.isSafeInteger(value.expected_run_version)||Number(value.expected_run_version)<1)invalid();
 return Object.freeze(structuredClone(value)) as OrdinaryRunHistoryScope;
}
/** The Host verifies the entire source digest against its internal product read.
 * This local check binds returned coverage to that same caller-held snapshot. */
export function ordinaryRunCompletionSource(sessionId:string,input:OrdinaryRunHistoryScope,value:unknown){
 const scope=normalizeOrdinaryRunHistoryScope(sessionId,input);
 if(!row(value)||value.protocol!==1||value.kind!=='ordinary_run_history'||value.execution_authorized!==false||value.owner_id!==scope.owner_id||value.conversation_id!==scope.conversation_id||value.run_id!==scope.run_id||value.session_id!==sessionId||value.run_version!==scope.expected_run_version||!Array.isArray(value.commands))invalid();
 const seen=new Set<string>(),commands:string[]=[];for(const c of value.commands){if(!row(c)||!valid(c.command_id)||c.command_id===scope.run_id||seen.has(c.command_id)||!['pending','applied','superseded','rejected'].includes(String(c.command_status)))invalid();seen.add(c.command_id);if(['pending','applied'].includes(String(c.command_status)))commands.push(c.command_id);}
 return{scope,source_sha256:ordinaryHistorySourceSha256(value),command_ids:commands};
}
/** Observation only. Does not grant file access, publication, replay or settlement. */
export function validateOrdinaryRunCompletion(value:unknown,sessionId:string,input:OrdinaryRunHistoryScope,source:unknown):OrdinaryRunCompletion{
 const expected=ordinaryRunCompletionSource(sessionId,input,source);
 if(!row(value)||Object.keys(value).sort().join(',')!=='answer_event,answer_seq,answer_sha256,command_ids,execution_authorized,kind,native_message_ids,output_events,profile_fingerprint,protocol,raw_event_count,raw_sha256,run_id,run_version,session_id,source_sha256,turn_end_seq'
  ||value.protocol!==1||value.kind!=='ordinary_run_completion'||value.execution_authorized!==false||value.run_id!==expected.scope.run_id||value.session_id!==sessionId||value.run_version!==expected.scope.expected_run_version||value.source_sha256!==expected.source_sha256
  ||!['raw_sha256','profile_fingerprint','answer_sha256'].every(k=>hash(value[k]))||!Number.isSafeInteger(value.raw_event_count)||Number(value.raw_event_count)<1||!Number.isSafeInteger(value.answer_seq)||Number(value.answer_seq)<0||!Number.isSafeInteger(value.turn_end_seq)||!(Number(value.answer_seq)<Number(value.turn_end_seq)&&Number(value.turn_end_seq)<Number(value.raw_event_count))
  ||!Array.isArray(value.command_ids)||JSON.stringify(value.command_ids)!==JSON.stringify(expected.command_ids)||!Array.isArray(value.native_message_ids)||value.native_message_ids.length!==expected.command_ids.length+1||value.native_message_ids.some(id=>!valid(id))||new Set(value.native_message_ids).size!==value.native_message_ids.length
  ||!row(value.answer_event)||value.answer_event.type!=='assistant/message'||value.answer_event.seq!==value.answer_seq||!row(value.answer_event.data)||!Number.isSafeInteger(value.answer_event.data.turn)||Number(value.answer_event.data.turn)<0||!Number.isSafeInteger(value.answer_event.data.step)||Number(value.answer_event.data.step)<0||!Array.isArray(value.output_events))invalid();
 const text=assistantText(value.answer_event);if(!text||createHash('sha256').update(text).digest('hex')!==value.answer_sha256)invalid();
 let previous=-1;for(const event of value.output_events){if(!row(event)||!['tool/result','deliverables/presented'].includes(String(event.type))||!Number.isSafeInteger(event.seq)||Number(event.seq)<=previous||event.seq===value.answer_seq||Number(event.seq)>=Number(value.turn_end_seq)||!row(event.data))invalid();previous=Number(event.seq);}
 return structuredClone(value) as OrdinaryRunCompletion;
}
