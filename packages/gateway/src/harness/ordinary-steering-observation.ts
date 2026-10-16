export type OrdinaryHistoryScope=Readonly<{owner_id:string;conversation_id:string;run_id:string;command_id:string;expected_run_version:number}>;
export type OrdinarySteeringObservation={protocol:1;kind:'ordinary_steer_observation';run_id:string;command_id:string;session_id:string;run_version:number;run_status:string;command_status:string;native_state:'unproven'|'admitted'|'committed';original_native_message_id:string|null;command_native_message_id:string|null;profile_fingerprint:string|null;raw_event_count:number;raw_sha256:string;original_entry:'reserved'|'unreserved'|null;command_entry:'reserved'|'unreserved'|null;answer:{answer_sha256:string;answer_seq:number;turn_end_seq:number}|null;execution_authorized:false};
const valid=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function invalid():never{throw Error('ordinary_history_contract_invalid');}
export function normalizeOrdinaryHistoryScope(sessionId:string,value:unknown):OrdinaryHistoryScope{
 if(!valid(sessionId)||!value||typeof value!=='object'||Array.isArray(value))invalid();const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='command_id,conversation_id,expected_run_version,owner_id,run_id'||!['owner_id','conversation_id','run_id','command_id'].every(k=>valid(row[k]))||row.command_id===row.run_id||!Number.isSafeInteger(row.expected_run_version)||Number(row.expected_run_version)<1)invalid();
 return Object.freeze(structuredClone(value)) as OrdinaryHistoryScope;
}
/** Observation validation only, never a replay/publication/cost authorization. */
export function validateOrdinarySteeringObservation(value:unknown,sessionId:string,input:OrdinaryHistoryScope):OrdinarySteeringObservation{
 const scope=normalizeOrdinaryHistoryScope(sessionId,input);
 if(!value||typeof value!=='object'||Array.isArray(value))invalid();const row=value as Record<string,unknown>;
 if(Object.keys(row).sort().join(',')!=='answer,command_entry,command_id,command_native_message_id,command_status,execution_authorized,kind,native_state,original_entry,original_native_message_id,profile_fingerprint,protocol,raw_event_count,raw_sha256,run_id,run_status,run_version,session_id'
  ||row.protocol!==1||row.kind!=='ordinary_steer_observation'||row.execution_authorized!==false||row.run_id!==scope.run_id||row.command_id!==scope.command_id||row.session_id!==sessionId||row.run_version!==scope.expected_run_version
  ||!['succeeded','failed','cancelled','interrupted','partial'].includes(row.run_status as string)||!['pending','applied','superseded','rejected'].includes(row.command_status as string)||!['unproven','admitted','committed'].includes(row.native_state as string)
  ||!Number.isSafeInteger(row.raw_event_count)||Number(row.raw_event_count)<0||!hash(row.raw_sha256)
  ||!['original_native_message_id','command_native_message_id'].every(k=>row[k]===null||valid(row[k]))||!['original_entry','command_entry'].every(k=>row[k]===null||['reserved','unreserved'].includes(row[k] as string)))invalid();
 if(row.original_native_message_id===null){if(row.command_native_message_id!==null||row.profile_fingerprint!==null||row.original_entry!==null)invalid();}
 else if(!hash(row.profile_fingerprint)||row.original_entry===null||Number(row.raw_event_count)<1)invalid();
 if(row.command_native_message_id===null){if(row.native_state!=='unproven'||row.command_entry!==null||row.answer!==null)invalid();}
 else if(row.original_native_message_id===null||row.command_native_message_id===row.original_native_message_id||row.native_state==='unproven'||row.command_entry===null)invalid();
 if(row.answer!==null){
  if(row.native_state!=='committed'||typeof row.answer!=='object'||Array.isArray(row.answer))invalid();const answer=row.answer as Record<string,unknown>;
  if(Object.keys(answer).sort().join(',')!=='answer_seq,answer_sha256,turn_end_seq'||!hash(answer.answer_sha256)||!Number.isSafeInteger(answer.answer_seq)||Number(answer.answer_seq)<0||!Number.isSafeInteger(answer.turn_end_seq)||!(Number(answer.answer_seq)<Number(answer.turn_end_seq)&&Number(answer.turn_end_seq)<Number(row.raw_event_count)))invalid();
 }
 return structuredClone(value) as OrdinarySteeringObservation;
}
