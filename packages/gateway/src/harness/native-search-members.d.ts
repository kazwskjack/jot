import type {NativeFileRangeRequest,NativeFileRange} from './native-file-range.js';
export interface NativeSearchMembersRequest {
  readonly call_seq:number;
  readonly tool_name:'glob'|'grep';
  readonly offset_members:number;
  readonly members_sha256?:string;
}
export interface NativeSearchMembers {
  readonly protocol:1;
  readonly session_id:string;
  readonly call_seq:number;
  readonly tool_call_id:string;
  readonly tool_name:'glob'|'grep';
  readonly call_sha256:string;
  readonly result_seq:number;
  readonly result_sha256:string;
  readonly members_sha256:string;
  readonly workdir:string;
  readonly original_total:number;
  readonly offset_members:number;
  readonly total_members:number;
  readonly items:readonly Readonly<{index:number;path:string}>[];
  readonly next_offset_members?:number;
  readonly execution_authorized:false;
}
export function validateNativeSearchMembersRequest(value:unknown):NativeSearchMembersRequest;
export function validateNativeSearchMembers(value:unknown,sessionId:string,input:NativeSearchMembersRequest):NativeSearchMembers;

export interface NativeSearchMemberRangeRequest {
  readonly member:Readonly<{call_seq:number;tool_name:'glob'|'grep';index:number;members_sha256:string;call_sha256:string;result_sha256:string}>;
  readonly range:Omit<NativeFileRangeRequest,'path'>;
}
export interface NativeSearchMemberRange {
  readonly member_index:number;
  readonly members_sha256:string;
  readonly call_sha256:string;
  readonly result_sha256:string;
  readonly range:NativeFileRange;
}
export function validateNativeSearchMemberRangeRequest(value:unknown):NativeSearchMemberRangeRequest;
export function validateNativeSearchMemberRange(value:unknown,sessionId:string,input:NativeSearchMemberRangeRequest):NativeSearchMemberRange;
