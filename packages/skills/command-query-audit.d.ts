import type {NativeCommandQueryResult} from './command-query.js';
export interface NativeCommandAudit{
 command_id:string;
 session_created_at:number;
 run_event_seq:number;
 run_event_sha256:string;
}
export interface NativeCommandRecovery{
 audit:NativeCommandAudit;
 result:NativeCommandQueryResult;
 end_event_seq:number;
 end_event_sha256:string;
}
export function validateNativeCommandAudit(value:unknown):NativeCommandAudit;
export function validateNativeCommandRecovery(value:unknown):NativeCommandRecovery;
