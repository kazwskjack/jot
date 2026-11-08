import {validateWorkspaceFilePath} from './file-editor-state.mjs';

export const MAX_WORKSPACE_FILE_RANGE_BYTES=65536;
const MAX_FILE_BYTES=1_048_576;
const MAX_HISTORY_PAGE_SIZE=100;
const DEFAULT_HISTORY_PAGE_SIZE=50;
const textEncoder=new TextEncoder();

function fileError(code){const error=new Error(code);error.code=code;return error;}
export function normalizeWorkspaceFileReadError(error){
 const status=Number(error?.status);
 if(status===409||status===412)return fileError('workspace_file_stale');
 if(status===401||status===403||status===404)return fileError('workspace_file_unavailable');
 return error;
}
function validIdentity(value){
 if(typeof value?.workspace_id!=='string'||!value.workspace_id||value.workspace_id.length>128
  ||typeof value?.project_id!=='string'||!value.project_id||value.project_id.length>128)throw fileError('workspace_file_source_mismatch');
 return {workspace_id:value.workspace_id,project_id:value.project_id,path:validateWorkspaceFilePath(value.path)};
}
function validMetadata(value){
 const identity=validIdentity(value);
 if(!Number.isSafeInteger(value.version)||value.version<1||!Number.isSafeInteger(value.size)||value.size<0||value.size>MAX_FILE_BYTES
  ||typeof value.sha256!=='string'||! /^[a-f0-9]{64}$/.test(value.sha256))throw fileError('workspace_file_source_mismatch');
 return {...identity,version:value.version,sha256:value.sha256,size:value.size};
}
function validUnicode(value){
 for(let index=0;index<value.length;index++){
  const unit=value.charCodeAt(index);
  if(unit>=0xd800&&unit<=0xdbff){const next=value.charCodeAt(index+1);if(!(next>=0xdc00&&next<=0xdfff))return false;index++;}
  else if(unit>=0xdc00&&unit<=0xdfff)return false;
 }
 return true;
}
function checkOptionalEcho(response,identity){
 for(const key of ['workspace_id','project_id','path'])if(response[key]!==undefined&&response[key]!==identity[key])throw fileError('workspace_file_source_mismatch');
}
function versionEntry(item,identity){
 if(!item||typeof item!=='object'||!Number.isSafeInteger(item.version)||item.version<1
  ||!Number.isSafeInteger(item.size)||item.size<0||item.size>MAX_FILE_BYTES
  ||typeof item.sha256!=='string'||! /^[a-f0-9]{64}$/.test(item.sha256)
  ||typeof item.created_at!=='string'||!item.created_at)throw fileError('workspace_file_history_invalid');
 checkOptionalEcho(item,identity);
 return {...identity,version:item.version,sha256:item.sha256,size:item.size,created_at:item.created_at};
}
function historyPageOptions({before_version,limit}){
 const pageSize=limit??DEFAULT_HISTORY_PAGE_SIZE;
 if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>MAX_HISTORY_PAGE_SIZE
  ||(before_version!==undefined&&(!Number.isSafeInteger(before_version)||before_version<1)))throw fileError('workspace_file_history_invalid');
 return {before_version,limit:pageSize};
}

export async function readWorkspaceFileVersions({request,enabled,workspace_id,project_id,path,before_version,limit,current},signal){
 if(enabled!==true)throw fileError('workspace_file_history_unavailable');
 if(typeof request!=='function')throw fileError('workspace_file_request_unavailable');
 const identity=validIdentity({workspace_id,project_id,path}),options=historyPageOptions({before_version,limit});
 const currentMetadata=current?validMetadata(current):null;
 if(currentMetadata&&(currentMetadata.workspace_id!==identity.workspace_id||currentMetadata.project_id!==identity.project_id||currentMetadata.path!==identity.path))throw fileError('workspace_file_source_mismatch');
 const query=new URLSearchParams({project_id:identity.project_id,path:identity.path,limit:String(options.limit)});
 if(options.before_version!==undefined)query.set('before_version',String(options.before_version));
 let response;
 try{response=await request(`/workspaces/${encodeURIComponent(identity.workspace_id)}/files/versions?${query.toString()}`,'GET',undefined,undefined,signal);}
 catch(error){throw normalizeWorkspaceFileReadError(error);}
 if(!response||typeof response!=='object'||!Array.isArray(response.items)||response.items.length>options.limit
  ||!Object.hasOwn(response,'next_before_version'))throw fileError('workspace_file_history_invalid');
 checkOptionalEcho(response,identity);
 const items=response.items.map(item=>versionEntry(item,identity));
 for(let index=0;index<items.length;index++){
  const item=items[index];
  if(index&&items[index-1].version<=item.version)throw fileError('workspace_file_history_invalid');
  if(options.before_version!==undefined&&item.version>=options.before_version)throw fileError('workspace_file_history_invalid');
 }
 if(currentMetadata&&options.before_version===undefined&&items.length){
  const latest=items[0];
  if(latest.version!==currentMetadata.version||latest.sha256!==currentMetadata.sha256||latest.size!==currentMetadata.size)throw fileError('workspace_file_stale');
 }
 const next=response.next_before_version??null;
 if(next!==null&&(!Number.isSafeInteger(next)||next<1||!items.length||next>items.at(-1).version))throw fileError('workspace_file_history_invalid');
 return {...identity,items,next_before_version:next};
}

/**
 * @param {{request:typeof import('../jot/client').request,enabled:boolean,source:import('./types').WorkspaceFileVersion,offset_bytes:number,limit_bytes?:number}} options
 * @param {AbortSignal} [signal]
 */
export async function readWorkspaceFileRange({request,enabled,source,offset_bytes,limit_bytes},signal){
 if(enabled!==true)throw fileError('workspace_file_range_unavailable');
 if(typeof request!=='function')throw fileError('workspace_file_request_unavailable');
 const metadata=validMetadata(source),limit=limit_bytes??MAX_WORKSPACE_FILE_RANGE_BYTES;
 if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_WORKSPACE_FILE_RANGE_BYTES
  ||!Number.isSafeInteger(offset_bytes)||offset_bytes<0||offset_bytes>metadata.size
  ||(metadata.size>0&&offset_bytes===metadata.size)||(metadata.size===0&&offset_bytes!==0))throw fileError('workspace_file_range_invalid');
 const query=new URLSearchParams({project_id:metadata.project_id,path:metadata.path,version:String(metadata.version),sha256:metadata.sha256,offset_bytes:String(offset_bytes),limit_bytes:String(limit)});
 let response;
 try{response=await request(`/workspaces/${encodeURIComponent(metadata.workspace_id)}/files/content?${query.toString()}`,'GET',undefined,undefined,signal);}
 catch(error){throw normalizeWorkspaceFileReadError(error);}
 if(!response||typeof response!=='object')throw fileError('workspace_file_range_invalid');
 checkOptionalEcho(response,metadata);
 if(response.workspace_id!==metadata.workspace_id||response.project_id!==metadata.project_id||response.path!==metadata.path)throw fileError('workspace_file_source_mismatch');
 if(response.version!==metadata.version||response.sha256!==metadata.sha256||response.size!==metadata.size)throw fileError('workspace_file_stale');
 if(response.offset_bytes!==offset_bytes||!Number.isSafeInteger(response.returned_bytes)||response.returned_bytes<0
  ||response.returned_bytes>limit||typeof response.eof!=='boolean'||typeof response.content!=='string'||!validUnicode(response.content))throw fileError('workspace_file_range_invalid');
 const actualBytes=textEncoder.encode(response.content).byteLength,end=offset_bytes+response.returned_bytes;
 if(actualBytes!==response.returned_bytes||end>metadata.size||response.eof!==(end===metadata.size)
  ||(metadata.size>0&&response.returned_bytes===0))throw fileError('workspace_file_range_invalid');
 return {...metadata,offset_bytes,returned_bytes:response.returned_bytes,eof:response.eof,content:response.content};
}

async function sha256(content){
 if(!globalThis.crypto?.subtle)throw fileError('workspace_file_digest_unavailable');
 const digest=await globalThis.crypto.subtle.digest('SHA-256',textEncoder.encode(content));
 return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}

export async function verifyWorkspaceFileRangeContent(source,content){
 const metadata=validMetadata(source);
 if(typeof content!=='string'||!validUnicode(content)||textEncoder.encode(content).byteLength!==metadata.size
  ||await sha256(content)!==metadata.sha256)throw fileError('workspace_file_stale');
 return true;
}

export async function readWorkspaceFileByRanges({request,enabled,source,limit_bytes=MAX_WORKSPACE_FILE_RANGE_BYTES},signal){
 const metadata=validMetadata(source);
 if(!Number.isSafeInteger(limit_bytes)||limit_bytes<1||limit_bytes>MAX_WORKSPACE_FILE_RANGE_BYTES)throw fileError('workspace_file_range_invalid');
 let offset_bytes=0,content='';
 while(true){
  const range=await readWorkspaceFileRange({request,enabled,source:metadata,offset_bytes,limit_bytes},signal);
  content+=range.content;
  offset_bytes+=range.returned_bytes;
  if(range.eof)break;
 }
 if(offset_bytes!==metadata.size)throw fileError('workspace_file_range_invalid');
 await verifyWorkspaceFileRangeContent(metadata,content);
 return {...metadata,content};
}
