import {validateNativeCommandQueryResult} from './command-query.js';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validateNativeCommandAudit(value){
 if(!exact(value,['command_id','session_created_at','run_event_seq','run_event_sha256'])
  ||typeof value.command_id!=='string'||value.command_id.length>192||!/^cmd-[A-Za-z0-9._:-]+$/.test(value.command_id)
  ||!Number.isSafeInteger(value.session_created_at)||value.session_created_at<0
  ||!Number.isSafeInteger(value.run_event_seq)||value.run_event_seq<0||!sha(value.run_event_sha256))throw Error('native_command_query_audit_invalid');
 return {command_id:value.command_id,session_created_at:value.session_created_at,run_event_seq:value.run_event_seq,run_event_sha256:value.run_event_sha256};
}
export function validateNativeCommandRecovery(value){
 if(!exact(value,['audit','result','end_event_seq','end_event_sha256']))throw Error('native_command_query_audit_invalid');
 const audit=validateNativeCommandAudit(value.audit),result=validateNativeCommandQueryResult(value.result);
 if(result.commandId!==audit.command_id||!Number.isSafeInteger(value.end_event_seq)||value.end_event_seq<=audit.run_event_seq
  ||!sha(value.end_event_sha256))throw Error('native_command_query_audit_invalid');
 return {audit,result,end_event_seq:value.end_event_seq,end_event_sha256:value.end_event_sha256};
}
