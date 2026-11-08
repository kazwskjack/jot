export interface NativeCommandQuery{request_id:string;name:'permission'|'goal';definition_id:string;expected_catalog_sha256:string}
export interface NativeCommandQueryResult{commandId:string;result:{kind:'success'|'error';text?:string;sourceEventSeq?:number}}
export function isNativeCommandQuery(value:unknown):boolean;
export function validateNativeCommandQueryIdentity(value:unknown):Pick<NativeCommandQuery,'request_id'|'name'>;
export function validateNativeCommandQuery(value:unknown):NativeCommandQuery;
export function validateNativeCommandQueryResult(value:unknown):NativeCommandQueryResult;
