export interface NativeFileRangeRequest {
  readonly path:string;
  readonly offset_bytes:number;
  readonly length_bytes:number;
  readonly version?:string;
  readonly absolute_path?:string;
  readonly session_sha256?:string;
  readonly file_size_bytes?:number|null;
}
export interface NativeFileStat {readonly absolutePath:string;readonly version:string;readonly bytes?:number}
export interface NativeFileRange {
  readonly protocol:1;
  readonly session_id:string;
  readonly profile_id:string;
  readonly session_sha256:string;
  readonly absolute_path:string;
  readonly version:string;
  readonly file_size_bytes:number|null;
  readonly offset_bytes:number;
  readonly data_base64:string;
  readonly chunk_sha256:string;
  readonly eof:boolean;
  readonly execution_authorized:false;
}
export function validateNativeFileRangeRequest(value:unknown):NativeFileRangeRequest;
export function validateNativeFileStat(value:unknown):NativeFileStat;
export function validateNativeFileRange(value:unknown,sessionId:string,input:NativeFileRangeRequest):NativeFileRange;
